import { type Address, type Hex, type PublicClient } from 'viem';
import { prepareSanctionsQuery, type SanctionsNetwork } from './accounts.js';
import { sanctionsResolverV2Abi } from './abi.js';
export * from './accounts.js';
export { sanctionsResolverV2Abi } from './abi.js';
export type SanctionsQuery = { network: SanctionsNetwork; account: string };
export type SanctionsResult = {
    status: 'listed' | 'not-listed' | 'invalid-input';
    blockNumber: bigint;
    canonicalAccount: string | null;
    sourceLiteral: boolean;
    matches: Array<{ key: Hex; attestationUID: Hex; attester: Address; attestedAt: bigint }>;
};
/** Uses one block for membership and evidence. RPC failures throw; they never become negative results. */
export async function lookupSanctionsBatch(options: {
    client: PublicClient; resolver: Address; accounts: SanctionsQuery[]; blockNumber?: bigint;
}): Promise<SanctionsResult[]> {
    if (options.accounts.length === 0) return [];
    const prepared = options.accounts.map(({network,account}) => prepareSanctionsQuery(network,account));
    const keys = [...new Set(prepared.flatMap(p => p.keys))];
    const blockNumber = options.blockNumber ?? await options.client.getBlockNumber();
    const listed = await options.client.readContract({ address: options.resolver, abi: sanctionsResolverV2Abi,
        functionName: 'isSanctionedKeyBatch', args: [keys], blockNumber });
    const matches = new Map<Hex, SanctionsResult['matches'][number]>();
    await Promise.all(keys.map(async (key,i) => {
        if (!listed[i]) return;
        const designation = await options.client.readContract({ address: options.resolver, abi: sanctionsResolverV2Abi,
            functionName: 'getDesignationByKey', args: [key], blockNumber });
        matches.set(key, { key, ...designation });
    }));
    return prepared.map(p => {
        const found = p.keys.flatMap(key => matches.has(key) ? [matches.get(key)!] : []);
        return { status: found.length ? 'listed' : p.valid ? 'not-listed' : 'invalid-input', blockNumber,
            canonicalAccount: p.canonical, sourceLiteral: found.length > 0 && !p.valid, matches: found };
    });
}
export async function lookupSanctions(options: {
    client: PublicClient; resolver: Address; network: SanctionsNetwork; account: string; blockNumber?: bigint;
}): Promise<SanctionsResult> {
    return (await lookupSanctionsBatch({ ...options, accounts: [{ network: options.network, account: options.account }] }))[0];
}

export * from './publications.js';
