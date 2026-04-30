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
