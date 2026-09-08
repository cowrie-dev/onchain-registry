import { type Hex } from 'viem';
import { connectViem, getResolverContract, loadResolverDeployment } from '../utils/resolver.js';
const { viem, chainId } = await connectViem();
const deployment = await loadResolverDeployment(chainId);
const resolver = await getResolverContract(viem, deployment.address);
const blockNumber = await (await viem.getPublicClient()).getBlockNumber();
const keys: Hex[] = [];
for (let offset = 0n; ; offset += 250n) {
    const page = await resolver.read.sanctionedKeyRange([offset, 250n], { blockNumber });
    keys.push(...page);
    if (page.length < 250) break;
}
console.log(JSON.stringify({ resolver: deployment.address, chainId, blockNumber: blockNumber.toString(), count: keys.length, keys }, null, 2));
