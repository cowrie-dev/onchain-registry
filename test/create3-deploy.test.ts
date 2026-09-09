import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { getAddress, type Address, type Hex } from 'viem';
import { deployEAS } from './helpers/eas.js';
import { buildPermissionedSalt, buildProxyDeployment, computeCreate3Address } from '../scripts/utils/createx.js';
import { predictSchemaUID } from '../scripts/utils/eas.js';

let viem: Awaited<ReturnType<typeof network.connect>>['viem'];
before(async () => { viem = (await network.connect()).viem; });

async function setup() {
  const [deployer, owner] = await viem.getWalletClients();
  const harness = await viem.deployContract('CreateXHarness');
  const { eas } = await deployEAS(viem, deployer);
  const salt = buildPermissionedSalt(deployer.account.address, '0x000102030405060708090a');
  const args = { createx: harness.address, sender: deployer.account.address, salt, eas: eas.address,
    initialOwner: owner.account.address, initialAttester: owner.account.address };
  return { deployer, owner, harness, eas, args };
}

describe('CREATE3 UUPS proxy deployment', () => {
  it('deploys implementation and proxy at predicted addresses with a separate owner', async () => {
    const { deployer, owner, harness, eas, args } = await setup();
    const deployment = await buildProxyDeployment(args);
    const predicted = computeCreate3Address(args);
    assert.equal(getAddress(await harness.read.computeCreate3Address([args.salt, args.sender]) as Address), predicted);
    await harness.write.deployCreate3([deployment.implementationSalt, deployment.implementationInitCode]);
    await harness.write.deployCreate3([args.salt, deployment.proxyInitCode]);
    const resolver = await viem.getContractAt('SanctionsResolverV2', predicted);
    assert.equal(getAddress(await resolver.read.owner()), getAddress(owner.account.address));
    assert.equal(await resolver.read.trustedAttesters([owner.account.address]), true);
    assert.equal(await resolver.read.trustedAttesters([deployer.account.address]), false);
    assert.equal(getAddress(await resolver.read.getEAS()), getAddress(eas.address));
    assert.equal(await resolver.read.schemaUID(), predictSchemaUID(predicted, true));
    const implementation = await viem.getContractAt('SanctionsResolverV2', deployment.implementation);
    assert.equal(await implementation.read.owner(), '0x0000000000000000000000000000000000000000');
  });

  it('deploys the same addresses with different chain-specific EAS implementations', async () => {
    const { deployer, harness, args } = await setup();
    const { eas: secondEas } = await deployEAS(viem, deployer);
    const a = await buildProxyDeployment(args);
    const b = await buildProxyDeployment({ ...args, eas: secondEas.address });
    assert.notEqual(a.implementationInitCode, b.implementationInitCode);
    assert.equal(a.proxyInitCode, b.proxyInitCode);
    assert.equal(a.implementation, b.implementation);
    const testClient = await viem.getTestClient();
    const snapshot = await testClient.snapshot();
    await harness.write.deployCreate3([a.implementationSalt, a.implementationInitCode]);
    await harness.write.deployCreate3([args.salt, a.proxyInitCode]);
    const resolver = await viem.getContractAt('SanctionsResolverV2', computeCreate3Address(args));
    assert.equal(getAddress(await resolver.read.getEAS()), getAddress(args.eas));
    await testClient.revert({ id: snapshot });
    await harness.write.deployCreate3([b.implementationSalt, b.implementationInitCode]);
    await harness.write.deployCreate3([args.salt, b.proxyInitCode]);
    assert.equal(getAddress(await resolver.read.getEAS()), getAddress(secondEas.address));
    assert.equal(await resolver.read.schemaUID(), predictSchemaUID(resolver.address, true));
  });

  it('rejects permissioned salts for another sender or with cross-chain protection enabled', async () => {
    const { owner, harness, args } = await setup();
    const deployment = await buildProxyDeployment(args);
    const wrongSender = buildPermissionedSalt(owner.account.address, '0x000000000000000000000a');
    const wrongFlag = `0x${args.sender.slice(2).toLowerCase()}01${'00'.repeat(11)}` as Hex;
    for (const salt of [wrongSender, wrongFlag]) {
      await assert.rejects(harness.write.deployCreate3([salt, deployment.proxyInitCode]), /InvalidSalt/);
    }
  });

  it('preserves the prepared vanity address and schema UID', () => {
    const plan = JSON.parse(readFileSync('deployment-plans/sanctions-v2.json', 'utf8'));
    const address = computeCreate3Address({ createx: plan.createx, sender: plan.deployer, salt: plan.salt });
    assert.equal(address, '0x0facD8549aB0666c3c79597f75cd8c75A5520Fac');
    assert.equal(predictSchemaUID(address, true), '0x5df8c5aff4ab385ec737bd2203688c1c073459d936db9abfe253ef149ec9f0bb');
  });
});
