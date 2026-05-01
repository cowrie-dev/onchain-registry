import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import type { ContractReturnType, WalletClient } from "@nomicfoundation/hardhat-viem/types";
import {
  ZERO_ADDRESS,
  deployEAS,
  expectRevert,
  registerSchema,
  attest,
  revoke,
  type EASStack,
} from "./helpers/eas.js";

let viem: Awaited<ReturnType<typeof network.connect>>["viem"];
let owner: WalletClient;
let attester: WalletClient;
let secondAttester: WalletClient;
let recipient: WalletClient;
let secondRecipient: WalletClient;
let stranger: WalletClient;
let newOwner: WalletClient;

type Resolver = ContractReturnType<"SanctionsResolver">;

type Stack = EASStack & {
  resolver: Resolver;
  schemaUID: `0x${string}`;
};

async function deployResolver(initialAttester: `0x${string}`): Promise<Stack> {
  const eas = await deployEAS(viem, owner);
  const resolver = await viem.deployContract(
    "SanctionsResolver",
    [eas.eas.address, initialAttester],
    { client: { wallet: owner } },
  );
  const schemaUID = await registerSchema(eas.schemaRegistry, resolver.address, true);
  return { ...eas, resolver, schemaUID };
}

function expectAddressEqual(actual: string, expected: string) {
  assert.equal(actual.toLowerCase(), expected.toLowerCase());
}

before(async () => {
  const connection = await network.connect();
  viem = connection.viem;
  const wallets = await viem.getWalletClients();
  [owner, attester, secondAttester, recipient, secondRecipient, stranger, newOwner] = wallets;
});

describe("SanctionsResolver: constructor", () => {
  it("records EAS, owner, and initial trusted attester", async () => {
    const { resolver, eas } = await deployResolver(attester.account.address);

    expectAddressEqual(await resolver.read.owner(), owner.account.address);
    // SchemaResolver stores _eas as internal; our contract exposes it via getEAS().
    expectAddressEqual(await resolver.read.getEAS(), eas.address);
    assert.equal(await resolver.read.trustedAttesters([attester.account.address]), true);
    assert.equal(await resolver.read.trustedAttesters([stranger.account.address]), false);
  });

  it("skips the allowlist entry when initial attester is zero", async () => {
    const eas = await deployEAS(viem, owner);
    const resolver = await viem.deployContract(
      "SanctionsResolver",
      [eas.eas.address, ZERO_ADDRESS],
      { client: { wallet: owner } },
    );
    assert.equal(await resolver.read.trustedAttesters([ZERO_ADDRESS]), false);
  });
});

describe("SanctionsResolver: trustedAttesters", () => {
  it("owner can grant and revoke trust", async () => {
    const { resolver } = await deployResolver(attester.account.address);

    await resolver.write.setAttesterTrust([secondAttester.account.address, true]);
    assert.equal(await resolver.read.trustedAttesters([secondAttester.account.address]), true);

    await resolver.write.setAttesterTrust([secondAttester.account.address, false]);
    assert.equal(await resolver.read.trustedAttesters([secondAttester.account.address]), false);
  });

  it("non-owner cannot setAttesterTrust", async () => {
    const { resolver } = await deployResolver(attester.account.address);
    const strangerResolver = await viem.getContractAt(
      "SanctionsResolver",
      resolver.address,
      { client: { wallet: stranger } },
    );
    await expectRevert(
      strangerResolver.write.setAttesterTrust([secondAttester.account.address, true]),
      "OwnableUnauthorizedAccount",
    );
  });

  it("emits AttesterTrusted on every change", async () => {
    const { resolver } = await deployResolver(ZERO_ADDRESS);
    const tx = await resolver.write.setAttesterTrust([attester.account.address, true]);
    const publicClient = await viem.getPublicClient();
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    const events = await resolver.getEvents.AttesterTrusted({}, {
      blockHash: receipt.blockHash,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].args.trusted, true);
    expectAddressEqual(events[0].args.attester!, attester.account.address);
  });
});

describe("SanctionsResolver: onAttest", () => {
  it("trusted attester populates the designation", async () => {
    const { resolver, eas, schemaUID } = await deployResolver(attester.account.address);

    const attesterEAS = await viem.getContractAt("EAS", eas.address, {
      client: { wallet: attester },
    });
    const uid = await attest({
      eas: attesterEAS,
      schemaUID,
      recipient: recipient.account.address,
      data: {
        source: "OFAC_SDN",
        sourceUID: "1234",
        category: "INDIVIDUAL",
        evidenceURI: "ipfs://evidence",
        designatedAt: 1700000000n,
      },
    });

    const designation = await resolver.read.getDesignation([recipient.account.address]);
    assert.equal(designation.attestationUID.toLowerCase(), uid.toLowerCase());
    expectAddressEqual(designation.attester, attester.account.address);
    assert.ok(designation.attestedAt > 0n);
  });

  it("untrusted attester is rejected (EAS reverts)", async () => {
    const { eas, schemaUID } = await deployResolver(attester.account.address);
    // secondAttester is NOT in the allowlist.
    const strangerEAS = await viem.getContractAt("EAS", eas.address, {
      client: { wallet: secondAttester },
    });
    await expectRevert(
      attest({
        eas: strangerEAS,
        schemaUID,
        recipient: recipient.account.address,
        data: {
          source: "X",
          sourceUID: "Y",
          category: "Z",
          evidenceURI: "",
          designatedAt: 0n,
        },
      }),
      "InvalidAttestation",
    );
  });

  it("emits Sanctioned for trusted attestations", async () => {
    const { resolver, eas, schemaUID } = await deployResolver(attester.account.address);
    const attesterEAS = await viem.getContractAt("EAS", eas.address, {
      client: { wallet: attester },
    });

    const publicClient = await viem.getPublicClient();
    const startBlock = await publicClient.getBlockNumber();

    await attest({
      eas: attesterEAS,
      schemaUID,
      recipient: recipient.account.address,
      data: {
        source: "OFAC_SDN",
        sourceUID: "9",
        category: "INDIVIDUAL",
        evidenceURI: "",
        designatedAt: 1n,
      },
    });

    const events = await resolver.getEvents.Sanctioned({}, { fromBlock: startBlock });
    assert.equal(events.length, 1);
    expectAddressEqual(events[0].args.account!, recipient.account.address);
    expectAddressEqual(events[0].args.attester!, attester.account.address);
  });
});

describe("SanctionsResolver: onRevoke", () => {
  it("revoking the active UID clears the designation and emits Unsanctioned", async () => {
    const { resolver, eas, schemaUID } = await deployResolver(attester.account.address);
    const attesterEAS = await viem.getContractAt("EAS", eas.address, {
      client: { wallet: attester },
    });

    const uid = await attest({
      eas: attesterEAS,
      schemaUID,
      recipient: recipient.account.address,
      data: {
        source: "S",
        sourceUID: "U",
        category: "C",
        evidenceURI: "",
        designatedAt: 0n,
      },
    });

    const publicClient = await viem.getPublicClient();
    const startBlock = await publicClient.getBlockNumber();

    await revoke(attesterEAS, schemaUID, uid);

    const designation = await resolver.read.getDesignation([recipient.account.address]);
    assert.equal(
      designation.attestationUID.toLowerCase(),
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
    assert.equal(designation.attester.toLowerCase(), ZERO_ADDRESS);
    assert.equal(designation.attestedAt, 0n);

    const events = await resolver.getEvents.Unsanctioned({}, { fromBlock: startBlock });
    assert.equal(events.length, 1);
    expectAddressEqual(events[0].args.account!, recipient.account.address);
    assert.equal(events[0].args.uid!.toLowerCase(), uid.toLowerCase());
  });
});

describe("SanctionsResolver: re-attestation", () => {
  it("a second attestation supersedes the first; old UID becomes stale", async () => {
    const { resolver, eas, schemaUID } = await deployResolver(attester.account.address);
    const attesterEAS = await viem.getContractAt("EAS", eas.address, {
      client: { wallet: attester },
    });

    const uidA = await attest({
      eas: attesterEAS,
      schemaUID,
      recipient: recipient.account.address,
      data: { source: "A", sourceUID: "1", category: "I", evidenceURI: "", designatedAt: 1n },
    });
    const uidB = await attest({
      eas: attesterEAS,
      schemaUID,
      recipient: recipient.account.address,
      data: { source: "B", sourceUID: "2", category: "I", evidenceURI: "", designatedAt: 2n },
    });

    assert.notEqual(uidA.toLowerCase(), uidB.toLowerCase());
    const designation = await resolver.read.getDesignation([recipient.account.address]);
    assert.equal(designation.attestationUID.toLowerCase(), uidB.toLowerCase());
  });

  it("revoking the stale (superseded) UID is a no-op on resolver state", async () => {
    const { resolver, eas, schemaUID } = await deployResolver(attester.account.address);
    const attesterEAS = await viem.getContractAt("EAS", eas.address, {
      client: { wallet: attester },
    });

    const uidA = await attest({
      eas: attesterEAS,
      schemaUID,
      recipient: recipient.account.address,
      data: { source: "A", sourceUID: "1", category: "I", evidenceURI: "", designatedAt: 1n },
    });
    const uidB = await attest({
      eas: attesterEAS,
      schemaUID,
      recipient: recipient.account.address,
      data: { source: "B", sourceUID: "2", category: "I", evidenceURI: "", designatedAt: 2n },
    });

    // revoke the stale one
    await revoke(attesterEAS, schemaUID, uidA);

    const designation = await resolver.read.getDesignation([recipient.account.address]);
    assert.equal(designation.attestationUID.toLowerCase(), uidB.toLowerCase());
  });

  it("multi-trusted-attester: latest write from any trusted attester wins", async () => {
    const { resolver, eas, schemaUID } = await deployResolver(attester.account.address);
    await resolver.write.setAttesterTrust([secondAttester.account.address, true]);

    const easA = await viem.getContractAt("EAS", eas.address, { client: { wallet: attester } });
    const easB = await viem.getContractAt("EAS", eas.address, {
      client: { wallet: secondAttester },
    });

    await attest({
      eas: easA,
      schemaUID,
      recipient: recipient.account.address,
      data: { source: "A", sourceUID: "1", category: "I", evidenceURI: "", designatedAt: 1n },
    });
    const uidB = await attest({
      eas: easB,
      schemaUID,
      recipient: recipient.account.address,
      data: { source: "B", sourceUID: "2", category: "I", evidenceURI: "", designatedAt: 2n },
    });

    const designation = await resolver.read.getDesignation([recipient.account.address]);
    assert.equal(designation.attestationUID.toLowerCase(), uidB.toLowerCase());
    expectAddressEqual(designation.attester, secondAttester.account.address);
  });
});

describe("SanctionsResolver: isSanctioned", () => {
  it("returns false for unknown addresses", async () => {
    const { resolver } = await deployResolver(attester.account.address);
    assert.equal(await resolver.read.isSanctioned([recipient.account.address]), false);
  });

  it("returns true after a trusted attestation lands", async () => {
    const { resolver, eas, schemaUID } = await deployResolver(attester.account.address);
    const easA = await viem.getContractAt("EAS", eas.address, { client: { wallet: attester } });
    await attest({
      eas: easA,
      schemaUID,
      recipient: recipient.account.address,
      data: { source: "S", sourceUID: "U", category: "C", evidenceURI: "", designatedAt: 0n },
    });
    assert.equal(await resolver.read.isSanctioned([recipient.account.address]), true);
  });

  it("batch overload returns one bool per input in order", async () => {
    const { resolver, eas, schemaUID } = await deployResolver(attester.account.address);
    const easA = await viem.getContractAt("EAS", eas.address, { client: { wallet: attester } });
    await attest({
      eas: easA,
      schemaUID,
      recipient: recipient.account.address,
      data: { source: "S", sourceUID: "U", category: "C", evidenceURI: "", designatedAt: 0n },
    });

    const out = await resolver.read.isSanctionedBatch([
      [recipient.account.address, secondRecipient.account.address, recipient.account.address],
    ]);
    assert.deepEqual(out, [true, false, true]);
  });

  it("returns false again after revocation", async () => {
    const { resolver, eas, schemaUID } = await deployResolver(attester.account.address);
    const easA = await viem.getContractAt("EAS", eas.address, { client: { wallet: attester } });
    const uid = await attest({
      eas: easA,
      schemaUID,
      recipient: recipient.account.address,
      data: { source: "S", sourceUID: "U", category: "C", evidenceURI: "", designatedAt: 0n },
    });
    await revoke(easA, schemaUID, uid);
    assert.equal(await resolver.read.isSanctioned([recipient.account.address]), false);
  });
});

describe("SanctionsResolver: ownership", () => {
  it("transferOwnership moves allowlist control", async () => {
    const { resolver } = await deployResolver(attester.account.address);

    await resolver.write.transferOwnership([newOwner.account.address]);
    expectAddressEqual(await resolver.read.owner(), newOwner.account.address);

    const oldOwnerResolver = await viem.getContractAt(
      "SanctionsResolver",
      resolver.address,
      { client: { wallet: owner } },
    );
    await expectRevert(
      oldOwnerResolver.write.setAttesterTrust([secondAttester.account.address, true]),
      "OwnableUnauthorizedAccount",
    );

    const newOwnerResolver = await viem.getContractAt(
      "SanctionsResolver",
      resolver.address,
      { client: { wallet: newOwner } },
    );
    await newOwnerResolver.write.setAttesterTrust([secondAttester.account.address, true]);
    assert.equal(await resolver.read.trustedAttesters([secondAttester.account.address]), true);
  });

  it("existing trusted attesters are preserved across ownership transfer", async () => {
    const { resolver } = await deployResolver(attester.account.address);
    await resolver.write.transferOwnership([newOwner.account.address]);
    assert.equal(await resolver.read.trustedAttesters([attester.account.address]), true);
  });
});

describe("SanctionsResolver: enumerable sanctioned set", () => {
  function normalize(addrs: readonly string[]): string[] {
    return [...addrs].map((a) => a.toLowerCase()).sort();
  }

  it("starts empty", async () => {
    const { resolver } = await deployResolver(attester.account.address);
    assert.equal(await resolver.read.sanctionedCount(), 0n);
    const list = await resolver.read.sanctionedAddresses();
    assert.equal(list.length, 0);
  });

  it("attestations append, revocations remove, count tracks both", async () => {
    const { resolver, eas, schemaUID } = await deployResolver(attester.account.address);
    const easA = await viem.getContractAt("EAS", eas.address, { client: { wallet: attester } });

    const uidA = await attest({
      eas: easA,
      schemaUID,
      recipient: recipient.account.address,
      data: { source: "S", sourceUID: "1", category: "I", evidenceURI: "", designatedAt: 1n },
    });
    await attest({
      eas: easA,
      schemaUID,
      recipient: secondRecipient.account.address,
      data: { source: "S", sourceUID: "2", category: "I", evidenceURI: "", designatedAt: 2n },
    });

    assert.equal(await resolver.read.sanctionedCount(), 2n);
    assert.deepEqual(
      normalize(await resolver.read.sanctionedAddresses()),
      normalize([recipient.account.address, secondRecipient.account.address]),
    );

    await revoke(easA, schemaUID, uidA);

    assert.equal(await resolver.read.sanctionedCount(), 1n);
    assert.deepEqual(
      normalize(await resolver.read.sanctionedAddresses()),
      normalize([secondRecipient.account.address]),
    );
  });

  it("re-attesting an already-sanctioned recipient does not double-count", async () => {
    const { resolver, eas, schemaUID } = await deployResolver(attester.account.address);
    const easA = await viem.getContractAt("EAS", eas.address, { client: { wallet: attester } });

    await attest({
      eas: easA,
      schemaUID,
      recipient: recipient.account.address,
      data: { source: "A", sourceUID: "1", category: "I", evidenceURI: "", designatedAt: 1n },
    });
    await attest({
      eas: easA,
      schemaUID,
      recipient: recipient.account.address,
      data: { source: "B", sourceUID: "2", category: "I", evidenceURI: "", designatedAt: 2n },
    });

    assert.equal(await resolver.read.sanctionedCount(), 1n);
    assert.deepEqual(
      normalize(await resolver.read.sanctionedAddresses()),
      normalize([recipient.account.address]),
    );
  });

  it("revoking a stale (superseded) UID does not remove the recipient from the set", async () => {
    const { resolver, eas, schemaUID } = await deployResolver(attester.account.address);
    const easA = await viem.getContractAt("EAS", eas.address, { client: { wallet: attester } });

    const uidA = await attest({
      eas: easA,
      schemaUID,
      recipient: recipient.account.address,
      data: { source: "A", sourceUID: "1", category: "I", evidenceURI: "", designatedAt: 1n },
    });
    await attest({
      eas: easA,
      schemaUID,
      recipient: recipient.account.address,
      data: { source: "B", sourceUID: "2", category: "I", evidenceURI: "", designatedAt: 2n },
    });

    // Revoke the stale UID; resolver should keep the recipient in the set
    // because the active UID is still B, and onRevoke is a no-op for stale UIDs.
    await revoke(easA, schemaUID, uidA);

    assert.equal(await resolver.read.sanctionedCount(), 1n);
    assert.equal(await resolver.read.isSanctioned([recipient.account.address]), true);
  });

  it("sanctionedRange paginates and clamps at the boundaries", async () => {
    const { resolver, eas, schemaUID } = await deployResolver(attester.account.address);
    const easA = await viem.getContractAt("EAS", eas.address, { client: { wallet: attester } });

    const targets = [recipient, secondRecipient, stranger, newOwner];
    for (let i = 0; i < targets.length; i++) {
      await attest({
        eas: easA,
        schemaUID,
        recipient: targets[i].account.address,
        data: {
          source: "S",
          sourceUID: String(i),
          category: "I",
          evidenceURI: "",
          designatedAt: BigInt(i + 1),
        },
      });
    }
    assert.equal(await resolver.read.sanctionedCount(), 4n);

    // First page
    const page0 = await resolver.read.sanctionedRange([0n, 2n]);
    assert.equal(page0.length, 2);
    // Second page
    const page1 = await resolver.read.sanctionedRange([2n, 2n]);
    assert.equal(page1.length, 2);
    // Concatenated == full set
    assert.deepEqual(
      normalize([...page0, ...page1]),
      normalize(targets.map((t) => t.account.address)),
    );

    // limit overruns total → clamps
    const tail = await resolver.read.sanctionedRange([3n, 100n]);
    assert.equal(tail.length, 1);

    // offset >= total → empty
    const off = await resolver.read.sanctionedRange([10n, 5n]);
    assert.equal(off.length, 0);

    // offset == total → empty
    const edge = await resolver.read.sanctionedRange([4n, 5n]);
    assert.equal(edge.length, 0);
  });

  it("untrusted attestations do not enter the set", async () => {
    const { resolver, eas, schemaUID } = await deployResolver(attester.account.address);
    const strangerEAS = await viem.getContractAt("EAS", eas.address, {
      client: { wallet: secondAttester },
    });
    await expectRevert(
      attest({
        eas: strangerEAS,
        schemaUID,
        recipient: recipient.account.address,
        data: { source: "X", sourceUID: "Y", category: "Z", evidenceURI: "", designatedAt: 0n },
      }),
      "InvalidAttestation",
    );
    assert.equal(await resolver.read.sanctionedCount(), 0n);
  });
});
