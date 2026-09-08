import { lookupSanctionsBatch } from '../../client/src/index.js';
import type { SanctionsNetwork } from '../utils/accounts.js';
import { connectViem, loadResolverDeployment, requireOption, resolveOption } from '../utils/resolver.js';
const accounts = requireOption('--accounts', ['ACCOUNTS', 'RESOLVER_ACCOUNTS']).split(',');
const accountNetwork = (resolveOption('--network-id', ['RESOLVER_NETWORK']) ?? 'EVM') as SanctionsNetwork;
const { viem, chainId } = await connectViem();
const deployment = await loadResolverDeployment(chainId);
const client = await viem.getPublicClient();
const entries = await lookupSanctionsBatch({ client, resolver: deployment.address as `0x${string}`,
    accounts: accounts.map(account => ({ network: accountNetwork, account })) });
console.log(JSON.stringify({ resolver: deployment.address, entries }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
