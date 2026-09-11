import { readFileSync, writeFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, stringToHex, testActions, toHex, zeroAddress, zeroHash, type Hex } from 'viem';
import { encodeDesignation } from '../scripts/utils/eas.js';
import { deployEAS } from './helpers/eas.js';
import { buildPublicationChunks, decodePublication, encodePublication, publicationId, publicationRequest, publicationSchemaUID, PUBLICATION_SCHEMA, type PublicationHeader } from '../client/src/publications.js';
import { sanctionsAccountKey } from '../client/src/accounts.js';
import { lookupSanctionsBatch, sanctionsResolverV2Abi } from '../client/src/index.js';

let viem: Awaited<ReturnType<typeof network.connect>>['viem'];
before(async () => { viem = (await network.connect()).viem; });
const btc = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const hash = (text: string) => keccak256(stringToHex(text));
const header = (overrides: Partial<PublicationHeader> = {}): PublicationHeader => ({source:'OFAC_SDN',
    sourceUrl:'https://example.org/sdn.xml',sourceSha256:hash('bootstrap'),comparisonSourceSha256:zeroHash,
    sourcePublishedAt:100n,previousPublication:zeroHash,kind:0,...overrides});
const row = (account=btc,network='BTC') => ({network,account,sourceUID:'123',category:'Entity',designatedAt:10n});
async function setup() {
    const [owner,stranger] = await viem.getWalletClients();
    const {eas,schemaRegistry} = await deployEAS(viem,owner);
    const legacy = await viem.deployContract('SanctionsResolverV2',[eas.address]);
    const proxy = await viem.deployContract('ERC1967Proxy',[legacy.address,encodeFunctionData({abi:legacy.abi,functionName:'initialize',args:[owner.account.address,owner.account.address]})]);
    const old = await viem.getContractAt('SanctionsResolverV2',proxy.address);
    const implementation = await viem.deployContract('SanctionsPublicationResolver',[eas.address]);
    const initialization = encodeFunctionData({abi:implementation.abi,functionName:'initializePublications',args:[]});
    await old.write.upgradeToAndCall([implementation.address,initialization]);
    const resolver = await viem.getContractAt('SanctionsPublicationResolver',proxy.address);
    const schema = publicationSchemaUID(proxy.address);
    await schemaRegistry.write.register([PUBLICATION_SCHEMA,proxy.address,false]);
    const client = await viem.getPublicClient();
    const submit = async (p: ReturnType<typeof buildPublicationChunks>[number]) => {
        const tx = await eas.write.attest([{schema,data:publicationRequest(p)}]);
        const receipt = await client.waitForTransactionReceipt({hash:tx});
        assert.equal(receipt.status,'success');return receipt;
    };
    return {owner,stranger,client,eas,resolver,schema,submit,implementation};
}

describe('Publication schema and UUPS upgrade', () => {
    it('matches every SDK ABI entry to the current publication contract', async () => {
        const { resolver } = await setup();
        const parameter = (p: any): any => ({ type: p.type,
            ...(p.components ? { components: p.components.map((c: any) => ({ name: c.name, ...parameter(c) })) } : {}),
            ...(p.indexed ? { indexed: true } : {}),
        });
        for (const entry of sanctionsResolverV2Abi) {
            const actual = resolver.abi.find(item => item.type === entry.type && 'name' in item && item.name === entry.name);
            assert.ok(actual && 'inputs' in actual, `Missing ABI entry: ${entry.name}`);
            assert.deepEqual(entry.inputs.map(parameter), actual.inputs.map(parameter), entry.name);
            if (entry.type === 'function' && actual.type === 'function') {
                assert.equal(entry.stateMutability, actual.stateMutability, entry.name);
                assert.deepEqual(entry.outputs.map(parameter), actual.outputs.map(parameter), entry.name);
            }
        }
    });
    it('screens the upgraded proxy and preserves an explicitly pinned historical snapshot', async () => {
        const { client, resolver, submit } = await setup();
        const accounts = [
            { network: 'BTC' as const, account: btc },
            { network: 'EVM' as const, account: '0xmalformed' },
            { network: 'EVM' as const, account: zeroAddress },
        ];
        const p = buildPublicationChunks(header(), [row(), row('0xmalformed', 'EVM')], [])[0];
        const receipt = await submit(p);
        const read = (blockNumber: bigint) => lookupSanctionsBatch({ client, resolver: resolver.address, accounts, blockNumber });
        const before = await read(receipt.blockNumber);
        assert.deepEqual(before.map(result => result.status), ['listed', 'listed', 'not-listed']);
        assert.equal(before[1].sourceLiteral, true);
        const designation = await resolver.read.getDesignationByKey([sanctionsAccountKey('BTC', btc)]);
        assert.deepEqual(before[0].matches, [{ key: sanctionsAccountKey('BTC', btc), ...designation }]);
        const removal = buildPublicationChunks(header({ kind: 2, previousPublication: publicationId(p) }), [], [row()])[0];
        const removed = await submit(removal);
        assert.equal((await read(removed.blockNumber))[0].status, 'not-listed');
        assert.deepEqual(await read(receipt.blockNumber), before);
        const count = await client.readContract({ address: resolver.address, abi: sanctionsResolverV2Abi,
            functionName: 'sanctionedAccountCount', blockNumber: receipt.blockNumber });
        const keys = await client.readContract({ address: resolver.address, abi: sanctionsResolverV2Abi,
            functionName: 'sanctionedKeyRange', args: [0n, count], blockNumber: receipt.blockNumber });
        assert.equal(BigInt(keys.length), count);
        const account = await client.readContract({ address: resolver.address, abi: sanctionsResolverV2Abi,
            functionName: 'getAccountByKey', args: [sanctionsAccountKey('BTC', btc)], blockNumber: receipt.blockNumber });
        assert.deepEqual(account, ['BTC', btc, '123']);
    });
    it('preserves ownership and trust, rejects repeated activation and implementation initialization',async()=>{
        const {owner,resolver,implementation,schema}=await setup();
        assert.equal(getAddress(await resolver.read.owner()),getAddress(owner.account.address));
        assert.equal(await resolver.read.trustedAttesters([owner.account.address]),true);
        assert.equal(await resolver.read.schemaUID(),schema);
        await assert.rejects(resolver.write.initializePublications());
        await assert.rejects(implementation.write.initializePublications());
    });
    it('refuses activation over existing entries and atomically rolls the upgrade back',async()=>{
        const [owner]=await viem.getWalletClients();
        const {eas,schemaRegistry}=await deployEAS(viem,owner);
        const oldImplementation=await viem.deployContract('SanctionsResolverV2',[eas.address]);
        const proxy=await viem.deployContract('ERC1967Proxy',[oldImplementation.address,encodeFunctionData({abi:oldImplementation.abi,functionName:'initialize',args:[owner.account.address,owner.account.address]})]);
        const old=await viem.getContractAt('SanctionsResolverV2',proxy.address);
        const schema=await old.read.schemaUID();
        await schemaRegistry.write.register([await old.read.SCHEMA(),proxy.address,true]);
        await eas.write.attest([{schema,data:{recipient:owner.account.address,expirationTime:0n,revocable:true,refUID:zeroHash,value:0n,
            data:encodeDesignation({network:stringToHex('EVM',{size:32}),account:owner.account.address,source:'OFAC_SDN',sourceUID:'1',category:'Entity',sourceUrl:'https://example.org',sourceSha256:hash('source'),sourcePublishedAt:1n,designatedAt:1n})}}]);
        const replacement=await viem.deployContract('SanctionsPublicationResolver',[eas.address]);
        await assert.rejects(old.write.upgradeToAndCall([replacement.address,encodeFunctionData({abi:replacement.abi,functionName:'initializePublications',args:[]})]));
        assert.equal(await old.read.isSanctioned([owner.account.address]),true);
        assert.equal(await old.read.schemaUID(),schema);
        const client=await viem.getPublicClient();
        const slot=await client.getStorageAt({address:proxy.address,slot:'0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'});
        assert.equal(slot?.slice(-40).toLowerCase(),oldImplementation.address.slice(2).toLowerCase());
    });
    it('preserves exact Chainalysis calldata/results and returns original strings',async()=>{
        const {owner,client,resolver,submit}=await setup();
        const address=getAddress(owner.account.address);
        const data=`0xdf592f7d${address.slice(2).padStart(64,'0')}` as Hex;
        assert.equal((await client.call({to:resolver.address,data})).data,encodeAbiParameters([{type:'bool'}],[false]));
        const p=buildPublicationChunks(header(),[row(address,'EVM'),row(),row('0xmalformed','EVM')],[])[0];
        assert.deepEqual(decodePublication(encodePublication(p)),p);
        assert.equal(await resolver.read.publicationId([p]),publicationId(p));
        await submit(p);
        assert.equal((await client.call({to:resolver.address,data})).data,encodeAbiParameters([{type:'bool'}],[true]));
        assert.equal(await resolver.read.sanctionedCount(),1n);
        assert.equal(await resolver.read.sanctionedAccountCount(),3n);
        assert.deepEqual(await resolver.read.getAccountByKey([sanctionsAccountKey('EVM',address)]),['EVM',address,'123']);
        const d=await resolver.read.getDesignation([address]);
        assert.equal(getAddress(d.attester),address);
        assert.deepEqual(await resolver.read.getPublicationChunk([d.attestationUID]),p);
        assert.equal(await resolver.read.isSanctionedAccount([stringToHex('EVM',{size:32}),'0xmalformed']),true);
        assert.equal(await resolver.read.isSanctioned([zeroAddress]),false);
    });
    it('preflights ordered batches with a head override and keeps padded gas sufficient after predecessor writes', async () => {
        // Exercise empty bootstrap, swap-and-pop removals, emptying both sets, and adding again.
        for (const initiallyPopulated of [false, true]) {
            const {owner, stranger, client, eas, schema, resolver, submit} = await setup();
            const oldRows = [row(owner.account.address,'EVM'), row(), row('old-sol','SOL')];
            if (initiallyPopulated) await submit(buildPublicationChunks(header(),oldRows,[])[0]);
            const originalHead = await resolver.read.latestPublication();
            const testClient = client.extend(testActions({mode:'hardhat'}));
            const slot = toHex(8n,{size:32});
            assert.equal(await client.getStorageAt({address:resolver.address,slot}),originalHead);
            const newRows = [row(stranger.account.address,'EVM'), row('new-btc','BTC'), row('new-sol','SOL')];
            const chunks = buildPublicationChunks(header({previousPublication:originalHead,kind:initiallyPopulated?2:0}),newRows,initiallyPopulated?oldRows:[],1);
            let previousPublication: Hex = originalHead;
            const plans = [];
            for (const [index,chunk] of chunks.entries()) {
                const p = {...chunk, previousPublication, kind:index===0?chunk.kind:2, chunkIndex:0, chunkCount:1};
                const data = encodeFunctionData({abi:eas.abi,functionName:'multiAttest',args:[[{schema,data:[publicationRequest(p)]}]]});
                // EDR does not accept estimateGas state overrides. Apply the same slot edit
                // locally, estimate without a transaction, then restore the original head.
                await testClient.setStorageAt({address:resolver.address,index:slot,value:previousPublication});
                const estimate = await client.estimateGas({account:owner.account.address,to:eas.address,data});
                await testClient.setStorageAt({address:resolver.address,index:slot,value:originalHead});
                plans.push({p,data,gas:estimate*120n/100n});
                previousPublication = publicationId(p);
            }
            // Future calldata is rejected against the real head until its predecessor executes.
            await assert.rejects(client.call({account:owner.account.address,to:eas.address,data:plans[1].data}));
            const keys = new Set(initiallyPopulated?oldRows.map(r=>sanctionsAccountKey(r.network as 'EVM'|'BTC'|'SOL',r.account)):[]);
            for (const {p,data,gas} of plans) {
                const tx = await owner.sendTransaction({to:eas.address,data,gas});
                const receipt = await client.waitForTransactionReceipt({hash:tx});
                assert.equal(receipt.status,'success');
                assert.ok(receipt.gasUsed <= gas);
                p.removedAccounts.forEach((account,index)=>keys.delete(sanctionsAccountKey(p.removedNetworks[index] as 'EVM'|'BTC'|'SOL',account)));
                p.addedAccounts.forEach((account,index)=>keys.add(sanctionsAccountKey(p.entityNetworks[p.entityIndices[index]] as 'EVM'|'BTC'|'SOL',account)));
                assert.deepEqual(new Set(await resolver.read.sanctionedKeyRange([0n,100n])),keys);
                assert.equal(await resolver.read.latestPublication(),publicationId(p));
                assert.equal(await resolver.read.pendingPublication(),zeroHash);
            }
            assert.equal(await resolver.read.sanctionedAccountCount(),3n);
            assert.equal(await resolver.read.sanctionedCount(),1n);
            assert.equal(await resolver.read.isSanctioned([stranger.account.address]),true);
        }
    });
    it('removes explicitly under a successor attester and leaves historical EAS records intact',async()=>{
        const {owner,stranger,eas,resolver,schema,submit}=await setup();
        const p=buildPublicationChunks(header(),[row()],[])[0];await submit(p);
        const key=sanctionsAccountKey('BTC',btc);
        const original=await resolver.read.getDesignationByKey([key]);
        await resolver.write.setAttesterTrust([stranger.account.address,true]);
        await resolver.write.setAttesterTrust([owner.account.address,false]);
        const successor=await viem.getContractAt('EAS',eas.address,{client:{wallet:stranger}});
        const next=buildPublicationChunks(header({kind:1,previousPublication:publicationId(p),sourceSha256:hash('next'),comparisonSourceSha256:p.sourceSha256,sourcePublishedAt:101n}),[],[{network:'BTC',account:btc}])[0];
        await successor.write.attest([{schema,data:publicationRequest(next)}]);
        assert.equal(await resolver.read.isSanctionedKey([key]),false);
        const historical=await eas.read.getAttestation([original.attestationUID]) as {revocable:boolean;revocationTime:bigint};
        assert.equal(historical.revocable,false);assert.equal(historical.revocationTime,0n);
        await assert.rejects(eas.write.revoke([{schema,data:{uid:original.attestationUID,value:0n}}]));
        await resolver.write.transferOwnership([stranger.account.address]);
        assert.equal(getAddress(await resolver.read.owner()),getAddress(stranger.account.address));
    });
    it('tracks partial publications, enforces ordering and rejects replay',async()=>{
        const {resolver,submit}=await setup();
        const chunks=buildPublicationChunks(header(),[row(),row('malformed-but-retained','BTC')],[],1);
        await assert.rejects(submit(chunks[1]));
        await submit(chunks[0]);
        assert.equal(await resolver.read.latestPublication(),zeroHash);
        assert.equal(await resolver.read.pendingPublication(),publicationId(chunks[0]));
        await assert.rejects(submit(chunks[0]));
        await assert.rejects(submit({...chunks[1],sourceSha256:hash('changed header')}));
        await submit(chunks[1]);
        assert.equal(await resolver.read.latestPublication(),publicationId(chunks[0]));
        assert.equal(await resolver.read.pendingPublication(),zeroHash);
        const state=await resolver.read.publications([publicationId(chunks[0])]);
        assert.equal(state[4],2);assert.equal(state[7],2);
        await assert.rejects(submit(chunks[1]));
    });
    it('rejects malformed arrays, unknown networks, duplicates and empty updates atomically',async()=>{
        const {resolver,submit}=await setup();
        const p=buildPublicationChunks(header(),[row()],[])[0];
        for(const bad of [
            {...p,entityIndices:[]}, {...p,entityIndices:[99]}, {...p,categories:[]},
            {...p,entityNetworks:['UNKNOWN']}, {...p,entityNetworks:['BTC\0']}, {...p,addedAccounts:['']},
            {...p,addedAccounts:[btc,btc],entityIndices:[0,0]},
            {...p,entityNetworks:[],addedAccounts:[],entityIndices:[]},
        ]) await assert.rejects(submit(bad));
        assert.equal(await resolver.read.sanctionedAccountCount(),0n);
        assert.equal(await resolver.read.pendingPublication(),zeroHash);
    });
    it('rejects untrusted publishers and unsuitable EAS envelopes',async()=>{
        const {stranger,eas,resolver,schema}=await setup();
        const p=buildPublicationChunks(header(),[row()],[])[0];
        const foreign=await viem.getContractAt('EAS',eas.address,{client:{wallet:stranger}});
        await assert.rejects(foreign.write.attest([{schema,data:publicationRequest(p)}]));
        for(const overrides of [{recipient:stranger.account.address},{expirationTime:2n**63n},{refUID:hash('unknown')}]) {
            await assert.rejects(eas.write.attest([{schema,data:{...publicationRequest(p),...overrides}}]));
        }
        assert.equal(await resolver.read.latestPublication(),zeroHash);
    });
    it('groups publication history in one multiAttest transaction',async()=>{
        const {eas,schema,resolver}=await setup();
        const first=buildPublicationChunks(header(),[row()],[])[0];
        const next=buildPublicationChunks(header({kind:1,sourcePublishedAt:101n,sourceSha256:hash('second'),comparisonSourceSha256:first.sourceSha256,previousPublication:publicationId(first)}),[],[{network:'BTC',account:btc}])[0];
        await eas.write.multiAttest([[{schema,data:[publicationRequest(first),publicationRequest(next)]}]]);
        assert.equal(await resolver.read.latestPublication(),publicationId(next));
        assert.equal(await resolver.read.sanctionedAccountCount(),0n);
    });
    it('closes each reconciliation transaction and accepts a fresh diff with the same Treasury digest',async()=>{
        const {eas,schema,resolver}=await setup();
        const additions=[row(),row('retained-source-literal','SOL'),row('later-account','DOGE')];
        const all=buildPublicationChunks(header(),additions,[],1);
        const first=all.slice(0,2).map((p,chunkIndex)=>({...p,chunkIndex,chunkCount:2}));
        await eas.write.multiAttest([[{schema,data:first.map(publicationRequest)}]]);
        assert.equal(await resolver.read.pendingPublication(),zeroHash);
        const previous=await resolver.read.latestPublication();
        assert.equal(previous,publicationId(first[0]));
        const live=await resolver.read.sanctionedKeyRange([0n,250n]);
        const missing=additions.filter(r=>!live.includes(sanctionsAccountKey(r.network as 'BTC'|'SOL'|'DOGE',r.account)));
        const next=buildPublicationChunks(header({kind:2,previousPublication:previous}),missing,[]);
        await eas.write.multiAttest([[{schema,data:next.map(publicationRequest)}]]);
        assert.equal(await resolver.read.pendingPublication(),zeroHash);
        assert.equal(await resolver.read.sanctionedAccountCount(),3n);
        assert.equal(await resolver.read.latestPublication(),publicationId(next[0]));
        const [network,account]=await resolver.read.getAccountByKey([sanctionsAccountKey('SOL','retained-source-literal')]);
        const removal=buildPublicationChunks(header({kind:2,previousPublication:publicationId(next[0]),sourceSha256:hash('latest source'),sourcePublishedAt:101n}),[],[{network,account}]);
        await eas.write.multiAttest([[{schema,data:removal.map(publicationRequest)}]]);
        assert.equal(await resolver.read.isSanctionedKey([sanctionsAccountKey('SOL',account)]),false);
        assert.equal(await resolver.read.pendingPublication(),zeroHash);
    });
    it('creates no attestations for unchanged membership',()=>{
        assert.deepEqual(buildPublicationChunks(header(),[],[]),[]);
    });
    it('keeps UUPS upgrade authorization after activation',async()=>{
        const {stranger,resolver,implementation}=await setup();
        const foreign=await viem.getContractAt('SanctionsPublicationResolver',resolver.address,{client:{wallet:stranger}});
        await assert.rejects(foreign.write.upgradeToAndCall([implementation.address,'0x']));
        await resolver.write.upgradeToAndCall([implementation.address,'0x']);
        assert.equal(await resolver.read.publicationsEnabled(),true);
    });
    it('benchmarks the complete retained Treasury bootstrap when supplied',async(t)=>{
        const fixture=process.env.SANCTIONS_BOOTSTRAP_FIXTURE;
        if(!fixture){t.skip('Set SANCTIONS_BOOTSTRAP_FIXTURE to the retained source fixture');return;}
        const input=JSON.parse(readFileSync(fixture,'utf8')) as {accounts:Array<{network:string;address:string;sdnEntityId:string;entityType:string;designatedAt:string}>};
        const additions=input.accounts.map(r=>({network:r.network,account:r.address,sourceUID:r.sdnEntityId,category:r.entityType??'',designatedAt:BigInt(r.designatedAt)}));
        const chunks=buildPublicationChunks(header(),additions,[],30);
        const {resolver,eas,schema,owner,client}=await setup();
        const measurements=[];
        for(let offset=0;offset<chunks.length;){
            const calldata=(n:number)=>encodeFunctionData({abi:eas.abi,functionName:'multiAttest',args:[[{schema,data:chunks.slice(offset,offset+n).map(publicationRequest)}]]});
            let count=1;
            let estimate=await client.estimateGas({account:owner.account.address,to:eas.address,data:calldata(count),gas:16_777_216n});
            assert.ok(estimate*120n/100n<=16_777_216n,'A chunk must fit with signing headroom');
            while(offset+count<chunks.length){
                try { const next=await client.estimateGas({account:owner.account.address,to:eas.address,data:calldata(count+1),gas:16_777_216n});
                    if(next*120n/100n>16_777_216n)break;
                    ++count;estimate=next;
                } catch {break;}
            }
            const tx=await owner.sendTransaction({to:eas.address,data:calldata(count),gas:estimate*120n/100n});
            const receipt=await client.waitForTransactionReceipt({hash:tx});assert.equal(receipt.status,'success');
            const selected=chunks.slice(offset,offset+count);
            measurements.push({chunks:count,keys:selected.reduce((n,p)=>n+p.addedAccounts.length,0),bytes:selected.reduce((n,p)=>n+(encodePublication(p).length-2)/2,0),gas:Number(receipt.gasUsed)});
            offset+=count;
        }
        assert.equal(await resolver.read.sanctionedAccountCount(),BigInt(additions.length));
        const summary={keys:additions.length,transactions:measurements.length,chunks:chunks.length,totalGas:measurements.reduce((sum,r)=>sum+r.gas,0),payloadBytes:measurements.reduce((sum,r)=>sum+r.bytes,0),measurements};
        console.log('PUBLICATION_BENCHMARK',JSON.stringify(summary));
        if(process.env.SANCTIONS_BENCHMARK_OUTPUT)writeFileSync(process.env.SANCTIONS_BENCHMARK_OUTPUT,JSON.stringify(summary,null,2)+'\n');
    });
});
