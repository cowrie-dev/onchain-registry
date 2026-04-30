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
