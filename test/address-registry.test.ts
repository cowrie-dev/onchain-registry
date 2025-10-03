import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import type { ContractReturnType, WalletClient } from "@nomicfoundation/hardhat-viem/types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

let ownerWallet: WalletClient;
let updaterWallet: WalletClient;
let userWallet: WalletClient;
let newOwnerWallet: WalletClient;
let extraWallet: WalletClient;
let viem: Awaited<ReturnType<typeof network.connect>>["viem"];

type AddressRegistryContract = ContractReturnType<"AddressRegistry">;

type DeployOptions = {
  owner?: WalletClient;
  updater?: WalletClient;
  initialAccounts?: readonly string[];
  initialValues?: readonly number[];
};

type Deployment = {
  registry: AddressRegistryContract;
  ownerRegistry: AddressRegistryContract;
  updaterRegistry: AddressRegistryContract;
  strangerRegistry: AddressRegistryContract;
};

function normalize(addresses: readonly string[]): string[] {
  return addresses.map((addr) => addr.toLowerCase()).sort();
}

function expectMembers(actual: readonly string[], expected: readonly string[]) {
  assert.equal(actual.length, expected.length);
  assert.deepEqual(normalize(actual), normalize(expected));
}

function expectAddressEqual(actual: string, expected: string) {
  assert.equal(actual.toLowerCase(), expected.toLowerCase());
}

function toBigInt(value: bigint | number | string): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

async function expectRevert(promise: Promise<unknown>, expectedMessage: string) {
  await assert.rejects(promise, (error: unknown) => {
    const err = error as {
      shortMessage?: string;
      message?: string;
      details?: string;
      cause?: {
        shortMessage?: string;
        message?: string;
        details?: string;
        errorName?: string;
        cause?: { shortMessage?: string; message?: string; details?: string };
      };
    };
    const parts = [
      err.shortMessage,
      err.message,
      err.details,
      err.cause?.shortMessage,
      err.cause?.message,
      err.cause?.details,
      err.cause?.errorName,
      err.cause?.cause?.shortMessage,
      err.cause?.cause?.message,
      err.cause?.cause?.details,
    ].filter((part): part is string => Boolean(part));
    const message = parts.join(" | ");
    assert.ok(
      message.includes(expectedMessage),
      `Expected revert to include "${expectedMessage}", got "${message}"`,
    );
    return true;
  });
}

async function deployRegistry(options: DeployOptions = {}): Promise<Deployment> {
  const {
    owner = ownerWallet,
    updater = ownerWallet,
    initialAccounts = [],
    initialValues = [],
  } = options;

  const registry = await viem.deployContract(
    "AddressRegistry",
    [owner.account.address, updater.account.address, initialAccounts, initialValues],
    { client: { wallet: owner } },
  );

  const ownerRegistry = registry;
  const updaterRegistry = await viem.getContractAt("AddressRegistry", registry.address, {
    client: { wallet: updater },
  });
  const strangerRegistry = await viem.getContractAt("AddressRegistry", registry.address, {
    client: { wallet: userWallet },
  });

  return { registry, ownerRegistry, updaterRegistry, strangerRegistry };
}

before(async () => {
  const connection = await network.connect();
  viem = connection.viem;
  const wallets = await viem.getWalletClients();
  [ownerWallet, updaterWallet, userWallet, newOwnerWallet, extraWallet] = wallets;
});

describe("AddressRegistry", () => {
  it("initializes owner, roles, and seeded entries", async () => {
    const seededAccount = userWallet.account.address;
    const { registry } = await deployRegistry({
      updater: updaterWallet,
      initialAccounts: [seededAccount],
      initialValues: [42],
    });

    expectAddressEqual(await registry.read.owner(), ownerWallet.account.address);

    const defaultAdminRole = await registry.read.DEFAULT_ADMIN_ROLE();
    const updaterRole = await registry.read.UPDATER_ROLE();

    assert.equal(await registry.read.hasRole([defaultAdminRole, ownerWallet.account.address]), true);
    assert.equal(await registry.read.hasRole([updaterRole, ownerWallet.account.address]), true);
    assert.equal(await registry.read.hasRole([updaterRole, updaterWallet.account.address]), true);

    const entries = await registry.read.registry();
    expectMembers(entries, [seededAccount]);
    assert.equal(toBigInt(await registry.read.registryLength()), 1n);
    assert.equal(toBigInt(await registry.read.registryValues([seededAccount])), 42n);

    const updaterMembers = await registry.read.updaters();
    expectMembers(updaterMembers, [ownerWallet.account.address, updaterWallet.account.address]);
  });

  it("permits updaters to manage registry entries", async () => {
    const targetA = userWallet.account.address;
    const targetB = extraWallet.account.address;
    const { registry, updaterRegistry } = await deployRegistry({ updater: updaterWallet });

    await updaterRegistry.write.setRegistryValues([[targetA], [100]]);
    assert.equal(toBigInt(await registry.read.registryValues([targetA])), 100n);

    await updaterRegistry.write.updateRegistry([[targetB], [15], [targetA]]);
    assert.equal(toBigInt(await registry.read.registryValues([targetB])), 15n);
    const postUpdateEntries = await registry.read.registry();
    expectMembers(postUpdateEntries, [targetB]);
    assert.equal(toBigInt(await registry.read.registryLength()), 1n);

    await updaterRegistry.write.clearRegistryValues([[targetB]]);
    const postClearEntries = await registry.read.registry();
    assert.equal(postClearEntries.length, 0);
    assert.equal(toBigInt(await registry.read.registryLength()), 0n);
  });

  it("prevents non-updaters from mutating the registry", async () => {
    const { strangerRegistry } = await deployRegistry({ updater: updaterWallet });
    const target = userWallet.account.address;

    await expectRevert(
      strangerRegistry.write.setRegistryValues([[target], [50]]),
      "Must be updater",
    );

    await expectRevert(
      strangerRegistry.write.clearRegistryValues([[target]]),
      "Must be updater",
    );

    await expectRevert(
      strangerRegistry.write.updateRegistry([[target], [10], []]),
      "Must be updater",
    );
  });

  it("validates input lengths and value ranges", async () => {
    const { updaterRegistry } = await deployRegistry({ updater: updaterWallet });
    const target = userWallet.account.address;

    await expectRevert(
      updaterRegistry.write.setRegistryValues([[target], [1, 2]]),
      "Registry: length mismatch",
    );

    await expectRevert(
      updaterRegistry.write.updateRegistry(
        [[target, extraWallet.account.address], [1], []],
      ),
      "Registry: length mismatch",
    );

    await expectRevert(
      updaterRegistry.write.setRegistryValues([[target], [101]]),
      "Registry: value out of range",
    );

    await updaterRegistry.write.setRegistryValues([[target], [0]]);
    assert.equal(toBigInt(await updaterRegistry.read.registryValues([target])), 0n);
  });

  it("reverts when clearing addresses that are not set", async () => {
    const { updaterRegistry } = await deployRegistry({ updater: updaterWallet });
    const unsetAccount = userWallet.account.address;

    await expectRevert(
      updaterRegistry.write.clearRegistryValues([[unsetAccount]]),
      "Registry: address not set",
    );
  });

  it("restricts updater management to the owner", async () => {
    const { registry, ownerRegistry, updaterRegistry, strangerRegistry } = await deployRegistry({
      updater: updaterWallet,
    });

    const newUpdater = extraWallet.account.address;

    await ownerRegistry.write.addUpdaters([[newUpdater]]);
    assert.equal(await registry.read.isUpdater([newUpdater]), true);

    await expectRevert(
      ownerRegistry.write.addUpdaters([[newUpdater]]),
      "Updater: already added",
    );

    await expectRevert(
      updaterRegistry.write.addUpdaters([[userWallet.account.address]]),
      "OwnableUnauthorizedAccount",
    );
    await expectRevert(
      strangerRegistry.write.removeUpdaters([[newUpdater]]),
      "OwnableUnauthorizedAccount",
    );

    await expectRevert(
      ownerRegistry.write.addUpdaters([[ZERO_ADDRESS]]),
      "Updater: zero address",
    );

    await ownerRegistry.write.removeUpdaters([[newUpdater]]);
    assert.equal(await registry.read.isUpdater([newUpdater]), false);

    await expectRevert(
      ownerRegistry.write.removeUpdaters([[newUpdater]]),
      "Updater: not present",
    );
  });

  it("updates roles when ownership changes", async () => {
    const { registry, ownerRegistry } = await deployRegistry({ updater: updaterWallet });

    await ownerRegistry.write.transferOwnership([newOwnerWallet.account.address]);

    expectAddressEqual(await registry.read.owner(), newOwnerWallet.account.address);

    const defaultAdminRole = await registry.read.DEFAULT_ADMIN_ROLE();
    const updaterRole = await registry.read.UPDATER_ROLE();

    assert.equal(
      await registry.read.hasRole([defaultAdminRole, ownerWallet.account.address]),
      false,
    );
    assert.equal(await registry.read.isUpdater([ownerWallet.account.address]), false);

    assert.equal(
      await registry.read.hasRole([defaultAdminRole, newOwnerWallet.account.address]),
      true,
    );
    assert.equal(await registry.read.isUpdater([newOwnerWallet.account.address]), true);

    const newOwnerRegistry = await viem.getContractAt("AddressRegistry", registry.address, {
      client: { wallet: newOwnerWallet },
    });
    await newOwnerRegistry.write.addUpdaters([[ownerWallet.account.address]]);
    assert.equal(await registry.read.isUpdater([ownerWallet.account.address]), true);
  });
});
