import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { encodeAbiParameters, encodeFunctionData, encodePacked, getAddress, keccak256, parseAbi, zeroAddress, zeroHash, type Hex } from 'viem';
import { deployEAS, expectRevert } from './helpers/eas.js';
import { lookupSanctions, lookupSanctionsBatch } from '../client/src/index.js';
import { encodeResolverInitialization } from '../scripts/utils/createx.js';
import { SCHEMA_STRING, encodeDesignation } from '../scripts/utils/eas.js';
import { networkId, normalizeSanctionsAccount, sanctionsAccountKey, type SanctionsNetwork } from '../scripts/utils/accounts.js';

let viem: Awaited<ReturnType<typeof network.connect>>['viem'];
before(async () => { viem = (await network.connect()).viem; });
const originalAbi = parseAbi(['function isSanctioned(address) view returns (bool)']);
const btc = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
async function setup() {
    const [owner, stranger, deployer] = await viem.getWalletClients();
    const { eas, schemaRegistry } = await deployEAS(viem, owner);
    const implementation = await viem.deployContract('SanctionsResolverV2', [eas.address], { client: { wallet: deployer } });
    const proxy = await viem.deployContract('ERC1967Proxy', [implementation.address,
        encodeResolverInitialization(owner.account.address, owner.account.address)], { client: { wallet: deployer } });
    const resolver = await viem.getContractAt('SanctionsResolverV2', proxy.address);
    const schemaUID = keccak256(encodePacked(['string','address','bool'], [SCHEMA_STRING, resolver.address, true]));
    await schemaRegistry.write.register([SCHEMA_STRING, resolver.address, true]);
    assert.equal(await resolver.read.schemaUID(), schemaUID);
    const data = (name: SanctionsNetwork, account: string) => encodeDesignation({
        network: networkId(name), account, source: 'OFAC_SDN', sourceUID: '123', category: 'ENTITY',
        sourceUrl: 'https://example.com/sdn.xml', sourceSha256: zeroHash, sourcePublishedAt: 10n, designatedAt: 1n,
    });
    const request = (name: SanctionsNetwork, account: string) => ({schema: schemaUID, data: {
        recipient: name === 'EVM' && /^0x[0-9a-fA-F]{40}$/.test(account) ? getAddress(account) : zeroAddress,
        expirationTime: 0n, revocable: true, refUID: zeroHash, value: 0n, data: data(name, account),
    }});
    async function attest(name: SanctionsNetwork, account: string) {
        await eas.write.attest([request(name, account)]);
        return (await resolver.read.getDesignationByKey([sanctionsAccountKey(name, account)])).attestationUID;
    }
    async function revoke(uid: Hex) { await eas.write.revoke([{schema: schemaUID, data: {uid, value: 0n}}]); }
    return { deployer, implementation, owner, stranger, eas, schemaRegistry, resolver, request, attest, revoke, schemaUID };
}

describe('SanctionsResolverV2 compatibility and account state', () => {
    it('preserves raw Chainalysis calldata and boolean bytes through attest and revoke', async () => {
        const {owner, resolver, attest, revoke} = await setup();
        const client = await viem.getPublicClient();
        const address = owner.account.address;
        // Original Chainalysis selector, followed by the original ABI address word.
        const calldata = `0xdf592f7d${address.slice(2).padStart(64, '0')}` as Hex;
        const consumer = await viem.deployContract('ChainalysisConsumer');
        async function check(expected: boolean) {
            const response = await client.call({to: resolver.address, data: calldata});
            assert.equal(response.data, encodeAbiParameters([{type:'bool'}],[expected]));
            assert.equal(await client.readContract({address:resolver.address,abi:originalAbi,functionName:'isSanctioned',args:[address]}), expected);
            assert.equal(await consumer.read.check([resolver.address,address]), expected);
            assert.equal(await resolver.read.isSanctionedAccount([networkId('EVM'),getAddress(address)]), expected);
        }
        await check(false);
        const uid = await attest('EVM',address);
        await check(true);
        await revoke(uid);
        await check(false);
    });
    it('separates networks and keeps EVM enumeration EVM-only', async () => {
        const {owner,resolver,attest} = await setup();
        await attest('BTC', btc);
        assert.equal(await resolver.read.isSanctionedAccount([networkId('BTC'),btc]),true);
        assert.equal(await resolver.read.isSanctionedAccount([networkId('BCH'),btc]),false);
        assert.equal(await resolver.read.isSanctioned([owner.account.address]),false);
        assert.equal(await resolver.read.isSanctioned([zeroAddress]),false);
        assert.deepEqual(await resolver.read.sanctionedAddresses(),[]);
        await attest('EVM', owner.account.address);
        assert.equal(await resolver.read.sanctionedCount(),1n);
        assert.equal(await resolver.read.sanctionedAccountCount(),2n);
        const keys = await resolver.read.sanctionedKeyRange([0n,2n**256n-1n]);
        assert.deepEqual(await resolver.read.isSanctionedKeyBatch([keys]),[true,true]);
        assert.deepEqual(await resolver.read.sanctionedKeyRange([2n**256n-1n,1n]),[]);
        assert.deepEqual(await resolver.read.sanctionedKeyRange([0n,0n]),[]);
        assert.deepEqual(await resolver.read.isSanctionedBatch([[owner.account.address,zeroAddress]]),[true,false]);
    });
    it('ignores superseded revocations and removes the active key from enumeration', async () => {
        const {resolver,attest,revoke} = await setup();
        const first = await attest('BTC',btc);
        const second = await attest('BTC',btc);
        assert.notEqual(first,second);
        await revoke(first);
        assert.equal(await resolver.read.isSanctionedAccount([networkId('BTC'),btc]),true);
        assert.equal(await resolver.read.sanctionedAccountCount(),1n);
        await revoke(second);
        assert.equal(await resolver.read.isSanctionedAccount([networkId('BTC'),btc]),false);
        assert.equal(await resolver.read.sanctionedAccountCount(),0n);
    });
    it('rejects untrusted attestations, wrong recipients, other schemas and expiration', async () => {
        const {stranger,eas,resolver,schemaRegistry,request} = await setup();
        const foreignEas = await viem.getContractAt('EAS',eas.address,{client:{wallet:stranger}});
        await expectRevert(foreignEas.write.attest([request('BTC',btc)]),'InvalidAttestation');
        const wrongRecipient=request('BTC',btc); wrongRecipient.data.recipient=stranger.account.address;
        await expectRevert(eas.write.attest([wrongRecipient]),'InvalidAttestation');
        const expiring=request('BTC',btc); expiring.data.expirationTime=2n**63n;
        await expectRevert(eas.write.attest([expiring]),'InvalidAttestation');
        const permanent=request('BTC',btc); permanent.data.revocable=false;
        await expectRevert(eas.write.attest([permanent]),'InvalidAttestation');
        const otherSchema=SCHEMA_STRING+',bool extra';
        await schemaRegistry.write.register([otherSchema,resolver.address,true]);
        const other=request('BTC',btc); other.schema=keccak256(encodePacked(['string','address','bool'],[otherSchema,resolver.address,true]));
        await expectRevert(eas.write.attest([other]),'InvalidAttestation');
        assert.equal(await resolver.read.sanctionedAccountCount(),0n);
    });
    it('rejects unknown networks and empty input while preserving source literals', async () => {
        const {resolver,attest} = await setup();
        await expectRevert(resolver.read.isSanctionedAccount([zeroHash,btc]),'UnsupportedNetwork');
        assert.equal(await resolver.read.isSanctionedAccount([networkId('EVM'),'not an address']),false);
        await expectRevert(resolver.read.isSanctionedAccount([networkId('BTC'),'']),'InvalidAccount');
        await attest('EVM','0xmalformed');
        assert.equal(await resolver.read.isSanctionedAccount([networkId('EVM'),'0xmalformed']),true);
        assert.equal(await resolver.read.isSanctioned([zeroAddress]),false);
        assert.deepEqual(await resolver.read.sanctionedAddresses(),[]);
        await attest('BTC','OFAC source literal');
        assert.equal(await resolver.read.isSanctionedAccount([networkId('BTC'),'OFAC source literal']),true);
        assert.equal(await resolver.read.accountKey([networkId('BTC'),btc]),sanctionsAccountKey('BTC',btc));
    });
    it('maps BCH legacy and CashAddr to one canonical key', async () => {
        const {resolver,attest} = await setup();
        const cash=normalizeSanctionsAccount('BCH',btc);
        assert.equal(normalizeSanctionsAccount('BCH',cash),cash);
        await attest('BCH',cash);
        assert.equal(await resolver.read.isSanctionedKey([sanctionsAccountKey('BCH',normalizeSanctionsAccount('BCH',btc))]),true);
    });
    it('client distinguishes listed source literals, invalid input and valid unlisted accounts', async () => {
        const {resolver,attest} = await setup();
        const client = await viem.getPublicClient();
        await attest('EVM','0xmalformed');
        await attest('BCH',normalizeSanctionsAccount('BCH',btc));
        const results = await lookupSanctionsBatch({ client, resolver:resolver.address, accounts: [
            {network:'EVM',account:'0xmalformed'}, {network:'EVM',account:'0xother-invalid'},
            {network:'EVM',account:zeroAddress}, {network:'BCH',account:btc}, {network:'EVM',account:''},
        ]});
        assert.deepEqual(results.map(r=>r.status),['listed','invalid-input','not-listed','listed','invalid-input']);
        assert.equal(results[0].sourceLiteral,true);
        assert.equal(results[3].sourceLiteral,false);
        assert.equal(new Set(results.map(r=>r.blockNumber)).size,1);
        assert.ok(results[3].matches.length > 0);
        const failingClient = { ...client, getBlockNumber: async () => { throw new Error('RPC unavailable'); } } as typeof client;
        await assert.rejects(lookupSanctions({client:failingClient,resolver:resolver.address,network:'BTC',account:btc}),/RPC unavailable/);
    });

    it('screens a malformed BTC source literal without sanctioning the truncated address', async () => {
        const { resolver, attest } = await setup();
        const malformed = '1QRus492mJL2Cum4E2TSqUmjdCBE5m33yG';
        const truncated = '16Jswqk47s9PUcyCc88MMVwzgvHPvtEpf';
        await attest('BTC', malformed);
        const client = await viem.getPublicClient();
        const results = await lookupSanctionsBatch({ client, resolver: resolver.address, accounts: [
            { network: 'BTC', account: malformed }, { network: 'BTC', account: truncated },
        ] });
        assert.equal(results[0].status, 'listed');
        assert.equal(results[0].sourceLiteral, true);
        assert.equal(results[0].canonicalAccount, null);
        assert.equal(results[1].status, 'not-listed');
    });

    it('matches the publisher vectors for all 15 source address families', async () => {
        const {resolver,attest} = await setup();
        const vectors = JSON.parse(readFileSync(new URL('./sanctions-v2-vectors.json', import.meta.url), 'utf8')) as Array<{network:SanctionsNetwork;source:string;account:string;key:Hex}>;
        for (const vector of vectors) {
            assert.equal(normalizeSanctionsAccount(vector.network,vector.source), vector.account);
            assert.equal(await resolver.read.accountKey([networkId(vector.network),vector.account]),vector.key);
            await attest(vector.network,vector.account);
            assert.equal(await resolver.read.isSanctionedKey([vector.key]),true);
        }
        assert.equal(await resolver.read.sanctionedAccountCount(),15n);
    });

});

describe('SanctionsResolverV2 UUPS proxy lifecycle', () => {
    it('locks the implementation and initializes the proxy once with an owner distinct from the deployer', async () => {
        const { implementation, owner, stranger, deployer, resolver, eas } = await setup();
        await expectRevert(implementation.write.initialize([stranger.account.address, stranger.account.address]), 'InvalidInitialization');
        await expectRevert(resolver.write.initialize([stranger.account.address, stranger.account.address]), 'InvalidInitialization');
        assert.equal(getAddress(await resolver.read.owner()), getAddress(owner.account.address));
        assert.notEqual(getAddress(await resolver.read.owner()), getAddress(deployer.account.address));
        assert.equal(getAddress(await resolver.read.getEAS()), getAddress(eas.address));
        assert.equal(await implementation.read.owner(), zeroAddress);
        const client = await viem.getPublicClient();
        assert.equal(await client.getStorageAt({ address: resolver.address,
            slot: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103' }), zeroHash);
        await expectRevert(viem.deployContract('ERC1967Proxy', [implementation.address,
            encodeResolverInitialization(zeroAddress, owner.account.address)]), 'OwnableInvalidOwner');
    });

    it('preserves records, schema, ownership, enumeration and exact ABI bytes across an upgrade', async () => {
        const { owner, stranger, eas, resolver, schemaUID, attest, revoke } = await setup();
        const evm = owner.account.address;
        await attest('EVM', evm);
        const oldBtcUid = await attest('BTC', btc);
        const btcUid = await attest('BTC', btc);
        await attest('EVM', '0xmalformed');
        await resolver.write.setAttesterTrust([stranger.account.address, true]);
        const keys = await resolver.read.sanctionedKeyRange([0n, 100n]);
        const designations = await Promise.all(keys.map(key => resolver.read.getDesignationByKey([key])));
        const client = await viem.getPublicClient();
        const calldata = `0xdf592f7d${evm.slice(2).padStart(64, '0')}` as Hex;
        const before = await client.call({ to: resolver.address, data: calldata });
        const next = await viem.deployContract('SanctionsResolverV2UpgradeMock', [eas.address]);
        const migration = encodeFunctionData({ abi: next.abi, functionName: 'initializeRevision', args: [42n] });
        await resolver.write.upgradeToAndCall([next.address, migration]);
        const upgraded = await viem.getContractAt('SanctionsResolverV2UpgradeMock', resolver.address);
        assert.equal(await upgraded.read.revisionValue(), 42n);
        const slot = await client.getStorageAt({ address: resolver.address,
            slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' });
        assert.equal(getAddress(`0x${slot!.slice(-40)}`), getAddress(next.address));
        assert.equal(await resolver.read.schemaUID(), schemaUID);
        assert.equal(getAddress(await resolver.read.getEAS()), getAddress(eas.address));
        assert.equal(getAddress(await resolver.read.owner()), getAddress(owner.account.address));
        assert.equal(await resolver.read.trustedAttesters([stranger.account.address]), true);
        assert.deepEqual(await resolver.read.sanctionedKeyRange([0n, 100n]), keys);
        assert.deepEqual(await Promise.all(keys.map(key => resolver.read.getDesignationByKey([key]))), designations);
        assert.equal(await resolver.read.sanctionedAccountCount(), 3n);
        assert.equal(await resolver.read.sanctionedCount(), 1n);
        assert.deepEqual((await resolver.read.sanctionedAddresses()).map(address => getAddress(address)), [getAddress(evm)]);
        assert.equal((await client.call({ to: resolver.address, data: calldata })).data, before.data);
        assert.equal(before.data, `0x${'0'.repeat(63)}1`);
        const consumer = await viem.deployContract('ChainalysisConsumer');
        assert.equal(await consumer.read.check([resolver.address, evm]), true);
        await revoke(oldBtcUid);
        assert.equal(await resolver.read.isSanctionedAccount([networkId('BTC'), btc]), true);
        await revoke(btcUid);
        assert.equal(await resolver.read.isSanctionedAccount([networkId('BTC'), btc]), false);
        const newUid = await attest('EVM', evm);
        await revoke(newUid);
        assert.equal((await client.call({ to: resolver.address, data: calldata })).data, `0x${'0'.repeat(64)}`);
        assert.equal(await consumer.read.check([resolver.address, evm]), false);
    });

    it('allows only the current owner to upgrade and rejects direct or incompatible upgrade calls', async () => {
        const { owner, stranger, deployer, implementation, resolver, eas } = await setup();
        const next = await viem.deployContract('SanctionsResolverV2UpgradeMock', [eas.address]);
        for (const wallet of [stranger, deployer]) {
            const connected = await viem.getContractAt('SanctionsResolverV2', resolver.address, { client: { wallet } });
            await expectRevert(connected.write.upgradeToAndCall([next.address, '0x']), 'OwnableUnauthorizedAccount');
            await expectRevert(connected.write.setAttesterTrust([wallet.account.address, true]), 'OwnableUnauthorizedAccount');
        }
        await expectRevert(implementation.write.upgradeToAndCall([next.address, '0x']), 'UUPSUnauthorizedCallContext');
        await expectRevert(resolver.read.proxiableUUID(), 'UUPSUnauthorizedCallContext');
        const incompatible = await viem.deployContract('ChainalysisConsumer');
        await expectRevert(resolver.write.upgradeToAndCall([incompatible.address, '0x']), 'ERC1967InvalidImplementation');
        await resolver.write.transferOwnership([stranger.account.address]);
        await expectRevert(resolver.write.upgradeToAndCall([next.address, '0x']), 'OwnableUnauthorizedAccount');
        const newOwner = await viem.getContractAt('SanctionsResolverV2', resolver.address, { client: { wallet: stranger } });
        await newOwner.write.upgradeToAndCall([next.address, '0x']);
        assert.equal(getAddress(await newOwner.read.owner()), getAddress(stranger.account.address));
        await newOwner.write.setAttesterTrust([owner.account.address, false]);
    });

    it('freezes upgrades permanently while a governance owner can still rotate attesters and transfer ownership', async () => {
        const { owner, stranger, deployer, resolver, eas, request, attest, revoke } = await setup();
        const frozen = await viem.deployContract('SanctionsResolverV2FrozenMock', [eas.address]);
        const next = await viem.deployContract('SanctionsResolverV2UpgradeMock', [eas.address]);
        const governance = await viem.deployContract('ResolverOwnerMock', [owner.account.address]);
        await resolver.write.transferOwnership([governance.address]);
        const uid = await attest('BTC', btc);
        await governance.write.upgradeResolver([resolver.address, frozen.address]);
        assert.equal(getAddress(await resolver.read.owner()), getAddress(governance.address));
        assert.equal(await resolver.read.isSanctionedAccount([networkId('BTC'), btc]), true);
        await expectRevert(governance.write.upgradeResolver([resolver.address, next.address]), 'UpgradesDisabled');
        for (const wallet of [owner, stranger, deployer]) {
            const connected = await viem.getContractAt('SanctionsResolverV2FrozenMock', resolver.address, { client: { wallet } });
            await expectRevert(connected.write.upgradeToAndCall([next.address, '0x']), 'UpgradesDisabled');
        }
        await governance.write.setAttesterTrust([resolver.address, owner.account.address, false]);
        await governance.write.setAttesterTrust([resolver.address, stranger.account.address, true]);
        await expectRevert(eas.write.attest([request('BTC', btc)]), 'InvalidAttestation');
        await revoke(uid);
        const publisher = await viem.getContractAt('EAS', eas.address, { client: { wallet: stranger } });
        await publisher.write.attest([request('BTC', btc)]);
        assert.equal(await resolver.read.isSanctionedAccount([networkId('BTC'), btc]), true);
        await governance.write.transferResolverOwnership([resolver.address, stranger.account.address]);
        const newOwner = await viem.getContractAt('SanctionsResolverV2FrozenMock', resolver.address, { client: { wallet: stranger } });
        assert.equal(getAddress(await newOwner.read.owner()), getAddress(stranger.account.address));
        await newOwner.write.setAttesterTrust([owner.account.address, true]);
        await expectRevert(newOwner.write.upgradeToAndCall([next.address, '0x']), 'UpgradesDisabled');
        await expectRevert(newOwner.write.initialize([stranger.account.address, stranger.account.address]), 'InvalidInitialization');
    });

    it('renouncing ownership disables both upgrades and attester administration in the initial implementation', async () => {
        const { resolver, eas, stranger } = await setup();
        const next = await viem.deployContract('SanctionsResolverV2UpgradeMock', [eas.address]);
        await resolver.write.renounceOwnership();
        await expectRevert(resolver.write.upgradeToAndCall([next.address, '0x']), 'OwnableUnauthorizedAccount');
        await expectRevert(resolver.write.setAttesterTrust([stranger.account.address, true]), 'OwnableUnauthorizedAccount');
    });

    it('retains the EAS-only callback boundary through the proxy', async () => {
        const { resolver, eas, attest } = await setup();
        const uid = await attest('BTC', btc);
        const attestation = await eas.read.getAttestation([uid]);
        await expectRevert(resolver.write.attest([attestation]), 'AccessDenied');
        await expectRevert(resolver.write.revoke([attestation]), 'AccessDenied');
    });
});
