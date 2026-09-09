import { readFileSync, writeFileSync } from 'node:fs';
import {
    createPublicClient,
    encodeDeployData,
    encodeFunctionData,
    getAddress,
    getContractAddress,
    http,
    keccak256,
    parseAbi,
    type Address,
    type Hex,
} from 'viem';
import { publicationSchemaUID, PUBLICATION_SCHEMA } from '../client/src/publications.js';

// Preparation only: no signing credentials, Vault calls or broadcasts.
const rpc = process.env.RPC_URL ?? 'https://eth.drpc.org';
const chainId = Number(process.env.CHAIN_ID ?? '1');
if (chainId !== 1) throw new Error('This upgrade plan is for the confirmed mainnet deployment');
const client = createPublicClient({ transport: http(rpc) });
if ((await client.getChainId()) !== chainId) throw new Error('RPC chain mismatch');
const deployments = JSON.parse(readFileSync('deployments.json', 'utf8'));
const current = deployments[chainId]?.SanctionsResolverV2;
if (!current) throw new Error('No confirmed V2 deployment');
const proxy = getAddress(current.address);
const deployer = getAddress(process.env.DEPLOYER ?? '0xcC5DcD1aBDf65366DdEd3B9a59513CaB822F1c3E');
const artifact = JSON.parse(
    readFileSync(
        'artifacts/contracts/SanctionsPublicationResolver.sol/SanctionsPublicationResolver.json',
        'utf8',
    ),
);
const abi = parseAbi([
    'function owner() view returns (address)',
    'function getEAS() view returns (address)',
    'function sanctionedAccountCount() view returns (uint256)',
    'function trustedAttesters(address) view returns (bool)',
    'function upgradeToAndCall(address newImplementation,bytes data) payable',
]);
const blockNumber = await client.getBlockNumber();
const [owner, eas, count, nonce, balance, implementationSlot] = await Promise.all([
    client.readContract({ address: proxy, abi, functionName: 'owner', blockNumber }),
    client.readContract({ address: proxy, abi, functionName: 'getEAS', blockNumber }),
    client.readContract({ address: proxy, abi, functionName: 'sanctionedAccountCount', blockNumber }),
    client.getTransactionCount({ address: deployer, blockTag: 'pending' }),
    client.getBalance({ address: deployer, blockNumber }),
    client.getStorageAt({
        address: proxy,
        slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
        blockNumber,
    }),
]);
if (count !== 0n) throw new Error('Refusing empty-registry activation: V2 is populated');
if (getAddress(eas) !== getAddress(current.easAddress)) throw new Error('EAS mismatch');
if (
    !implementationSlot ||
    getAddress(`0x${implementationSlot.slice(-40)}`) !== getAddress(current.implementation)
)
    throw new Error('Implementation differs from the confirmed deployment');
const expectedOwner = getAddress('0x8035B1a1cC4257B96e85E3924221bbCBb2Ed2a69');
if (getAddress(owner) !== expectedOwner) throw new Error('Owner changed; review the new upgrade authority');
if (
    !(await client.readContract({
        address: proxy,
        abi,
        functionName: 'trustedAttesters',
        args: [owner],
        blockNumber,
    }))
)
    throw new Error('Expected attester is not trusted');
const implementation = getContractAddress({ from: deployer, nonce: BigInt(nonce) });
const deploymentData = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [eas] });
const deploymentGas = await client.estimateGas({ account: deployer, data: deploymentData });
const activation = encodeFunctionData({
    abi: artifact.abi,
    functionName: 'initializePublications',
    args: [],
});
const upgradeData = encodeFunctionData({
    abi,
    functionName: 'upgradeToAndCall',
    args: [implementation, activation],
});
const registry = getAddress('0xA7b39296258348C78294F95B872b282326A97BDF');
const registration = encodeFunctionData({
    abi: parseAbi(['function register(string schema,address resolver,bool revocable) returns (bytes32)']),
    functionName: 'register',
    args: [PUBLICATION_SCHEMA, proxy, false],
});
const schema = publicationSchemaUID(proxy);
const registrationGas = await client.estimateGas({ account: deployer, to: registry, data: registration });
const plan = {
    status: 'prepared-not-broadcast',
    chainId,
    checkedAt: new Date().toISOString(),
    blockNumber,
    proxy,
    owner,
    eas,
    currentImplementation: implementationSlot,
    implementation,
    deployer,
    expectedDeployerNonce: nonce,
    deployerBalanceWei: balance,
    newSchemaUID: schema,
    schema: PUBLICATION_SCHEMA,
    implementationCreationCodeHash: keccak256(deploymentData),
    deployment: {
        data: deploymentData,
        estimatedGas: deploymentGas,
        gasLimit: (deploymentGas * 120n) / 100n,
    },
    registration: {
        to: registry,
        data: registration,
        estimatedGas: registrationGas,
        gasLimit: (registrationGas * 120n) / 100n,
    },
    upgrade: { to: proxy, data: upgradeData },
    notes: [
        'Deploy the implementation FIRST at the expected nonce, then register the non-revocable schema using the deployment key.',
        'The owner signs upgradeToAndCall through Vault after the single whitelist amendment.',
        'Recheck nonce, bytecode, implementation slot, owner, trust, EAS and empty registry before execution.',
        'Update confirmed deployment records and publisher schema only after the upgrade receipt succeeds.',
    ],
};
const output = process.env.OUTPUT ?? 'calldata/publication-upgrade-1.json';
writeFileSync(output, JSON.stringify(plan, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
console.log(
    JSON.stringify({
        output,
        proxy,
        implementation,
        schema,
        nonce,
        estimatedDeploymentGas: deploymentGas.toString(),
        deployerBalanceWei: balance.toString(),
    }),
);
