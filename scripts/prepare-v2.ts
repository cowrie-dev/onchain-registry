/** Build reviewable custody transactions without credentials, RPC calls or deployment-record writes. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { encodeFunctionData, getAddress, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { buildProxyDeployment, computeCreate3Address, computeCreate3ProxyAddress, computeGuardedSalt, CREATEX_DEPLOY_CREATE3_ABI } from './utils/createx.js';
import { getEASAddresses, predictSchemaUID, SCHEMA_STRING } from './utils/eas.js';
const plan = JSON.parse(await readFile('deployment-plans/sanctions-v2.json', 'utf8')) as {
    address: Address; salt: Hex; deployer: Address; owner: Address; initialAttester: Address; proxyAdminOwner: Address; createx: Address; chains: number[];
};
if (plan.salt.slice(2,42).toLowerCase() !== plan.deployer.slice(2).toLowerCase() || plan.salt.slice(42,44) !== '00') {
    throw new Error('Salt must be permissioned for the deployer without cross-chain protection');
}
const args = { createx: plan.createx, sender: plan.deployer, salt: plan.salt };
const address = computeCreate3Address(args);
if (address !== getAddress(plan.address) || !/^0x0fac[0-9a-f]{32}0fac$/i.test(address)) throw new Error('Vanity prediction mismatch');
const schemaUID = predictSchemaUID(address,true);
await mkdir('calldata',{recursive:true});
for (const chainId of plan.chains) {
    const {eas,schemaRegistry} = getEASAddresses(chainId);
    const deployment = await buildProxyDeployment({...args,eas,initialOwner:plan.owner,initialAttester:plan.initialAttester,proxyAdminOwner:plan.proxyAdminOwner});
    const initCode = deployment.proxyInitCode;
    const implementationData = encodeFunctionData({abi:CREATEX_DEPLOY_CREATE3_ABI,functionName:'deployCreate3',args:[deployment.implementationSalt,deployment.implementationInitCode]});
    const deployData = encodeFunctionData({abi:CREATEX_DEPLOY_CREATE3_ABI,functionName:'deployCreate3',args:[plan.salt,initCode]});
    const schemaData = encodeFunctionData({abi:parseAbi(['function register(string schema,address resolver,bool revocable) returns (bytes32)']),
        functionName:'register',args:[SCHEMA_STRING,address,true]});
    const output = { chainId, contract:'SanctionsResolverV2', status:'prepared-not-deployed', address, schemaUID,
        proxyType:'transparent', proxyAdmin:deployment.proxyAdmin, proxyAdminOwner:plan.proxyAdminOwner, implementation:deployment.implementation, implementationSalt:deployment.implementationSalt,
        implementationInitCodeHash:keccak256(deployment.implementationInitCode),
        owner:plan.owner,initialAttester:plan.initialAttester,eas, salt:plan.salt,initCodeHash:keccak256(initCode),
        transactions:[{purpose:'Deploy SanctionsResolverV2 implementation',from:plan.deployer,to:plan.createx,value:'0',data:implementationData},
            {purpose:'Deploy and initialize TransparentUpgradeableProxy',from:plan.deployer,to:plan.createx,value:'0',data:deployData},
            {purpose:'Register revocable V2 schema',from:plan.deployer,to:schemaRegistry,value:'0',data:schemaData}] };
    await writeFile(`calldata/sanctions-v2-${chainId}.json`,JSON.stringify(output,null,2)+'\n');
}
console.log(JSON.stringify({ address, schemaUID, create3Intermediary:computeCreate3ProxyAddress(args), guardedSalt:computeGuardedSalt(plan.deployer,plan.salt),chains:plan.chains },null,2));
