import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { encodeAbiParameters, encodePacked, getAddress, keccak256, parseAbi, zeroAddress, zeroHash, type Hex } from 'viem';
import { deployEAS, expectRevert } from './helpers/eas.js';
import { lookupSanctions, lookupSanctionsBatch } from '../client/src/index.js';
import { SCHEMA_STRING, encodeDesignation } from '../scripts/utils/eas.js';
import { networkId, normalizeSanctionsAccount, sanctionsAccountKey, type SanctionsNetwork } from '../scripts/utils/accounts.js';

let viem: Awaited<ReturnType<typeof network.connect>>['viem'];
before(async () => { viem = (await network.connect()).viem; });
const originalAbi = parseAbi(['function isSanctioned(address) view returns (bool)']);
const btc = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
async function setup() {
    const [owner, stranger] = await viem.getWalletClients();
    const { eas, schemaRegistry } = await deployEAS(viem, owner);
    const resolver = await viem.deployContract('SanctionsResolverV2', [eas.address, owner.account.address, owner.account.address]);
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
    return { owner, stranger, eas, schemaRegistry, resolver, request, attest, revoke, schemaUID };
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
