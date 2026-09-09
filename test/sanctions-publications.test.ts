import { readFileSync, writeFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, stringToHex, zeroAddress, zeroHash, type Hex } from 'viem';
import { encodeDesignation } from '../scripts/utils/eas.js';
import { deployEAS } from './helpers/eas.js';
import { buildPublicationChunks, decodePublication, encodePublication, publicationId, publicationRequest, publicationSchemaUID, PUBLICATION_SCHEMA, type PublicationHeader } from '../client/src/publications.js';
import { sanctionsAccountKey } from '../client/src/accounts.js';

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
