/** SanctionsResolverV2 account encoding. Keep in sync with onchain-registry/client/src/accounts.ts. */
import { getCoderByCoinName } from '@ensdomains/address-encoder';
import { bytesToHex, encodeAbiParameters, getAddress, hexToBytes, keccak256, stringToHex, type Hex } from 'viem';

export const SANCTIONS_NETWORKS = ['EVM', 'BTC', 'BCH', 'BTG', 'BSV', 'LTC', 'DASH', 'ZEC', 'XVG', 'XMR', 'XRP', 'TRX', 'SOL', 'DOGE', 'BNB'] as const;
export type SanctionsNetwork = typeof SANCTIONS_NETWORKS[number];
export function networkId(network: SanctionsNetwork): Hex {
    if (!(SANCTIONS_NETWORKS as readonly string[]).includes(network)) throw new Error(`Unsupported sanctions network: ${network}`);
    return stringToHex(network, { size: 32 });
}
export function sanctionsNetworkForChain(chain: number): SanctionsNetwork {
    if (Number.isSafeInteger(chain) && chain > 0) return 'EVM';
    const networks: Record<number, SanctionsNetwork> = {
        [-1]: 'BTC', [-2]: 'BCH', [-3]: 'BTG', [-4]: 'BSV', [-5]: 'LTC', [-6]: 'DASH',
        [-7]: 'ZEC', [-8]: 'XVG', [-9]: 'XMR', [-10]: 'XRP', [-11]: 'TRX', [-900]: 'SOL', [-12]: 'DOGE', [-13]: 'BNB',
    };
    const result = networks[chain];
    if (!result) throw new Error(`Unsupported sanctions chain: ${chain}`);
    return result;
}
/** Normalize valid input. Throws for invalid input; does not guess a network. */
export function normalizeSanctionsAccount(network: SanctionsNetwork, input: string): string {
    networkId(network);
    const account = input.trim();
    if (!account) throw new Error('Empty sanctions account');
    if (network === 'EVM') return getAddress(account.toLowerCase()).toLowerCase();
    const coder = getCoderByCoinName(network.toLowerCase());
    let decoded = coder.decode(account);
    if (network === 'SOL' && decoded.length !== 32) throw new Error('Invalid Solana account length');
    if (network === 'TRX' && (decoded.length !== 21 || decoded[0] !== 0x41)) throw new Error('Invalid Tron account');
    if (network === 'XRP') {
        // X-addresses carry an account plus a destination tag. Sanctions apply to the account.
        if (decoded.length === 31 && decoded[0] === 0x05 && decoded[1] === 0x44) {
            if (decoded[22] > 1 || decoded.slice(27).some(b => b !== 0)
                || (decoded[22] === 0 && decoded.slice(23, 27).some(b => b !== 0))) throw new Error('Invalid XRP X-address tag');
            decoded = new Uint8Array([0, ...decoded.slice(2, 22)]);
        }
        if (decoded.length !== 21 || decoded[0] !== 0) throw new Error('Expected XRP mainnet account');
    }
    if (network === 'XMR') {
        const integrated = decoded.length === 77 && decoded[0] === 19;
        if (!integrated && !(decoded.length === 69 && [18, 42].includes(decoded[0]))) throw new Error('Invalid Monero mainnet account');
        const body = decoded.slice(0, -4);
        if (bytesToHex(decoded.slice(-4)) !== keccak256(body).slice(0, 10)) throw new Error('Invalid Monero checksum');
        if (integrated) {
            const standard = new Uint8Array([18, ...decoded.slice(1, 65)]);
            decoded = new Uint8Array([...standard, ...hexToBytes(keccak256(standard)).slice(0, 4)]);
        }
    }
    return coder.encode(decoded);
}
/** OFAC sometimes publishes undecodable values. Preserve them for exact lookup. */
export function normalizeSourceAccount(network: SanctionsNetwork, input: string): { account: string; literal: boolean } {
    try { return { account: normalizeSanctionsAccount(network, input), literal: false }; }
    catch (error) {
        if (!input.trim()) throw error;
        networkId(network);
        return { account: input.trim(), literal: true };
    }
}
/** Input is canonical, or an exact OFAC source literal. No implicit non-EVM conversion. */
export function sanctionsAccountKey(network: SanctionsNetwork, account: string): Hex {
    if (!account) throw new Error('Empty sanctions account');
    const canonical = network === 'EVM' && /^0x[0-9a-fA-F]{40}$/.test(account) ? normalizeSanctionsAccount(network, account) : account;
    if (network === 'EVM' && /^0x[0-9a-fA-F]{40}$/.test(account)) {
        return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }], [networkId(network), getAddress(canonical)]));
    }
    return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'string' }], [networkId(network), canonical]));
}

/** Check both source spelling and canonical form. An unmatched invalid input is not a clean screening result. */
export function prepareSanctionsQuery(network: SanctionsNetwork, input: string): { keys: Hex[]; valid: boolean; canonical: string | null } {
    const raw = input.trim();
    networkId(network);
    if (!raw) return { keys: [], valid: false, canonical: null };
    const exact = sanctionsAccountKey(network, raw);
    try {
        const canonical = normalizeSanctionsAccount(network, raw);
        return { keys: [...new Set([exact, sanctionsAccountKey(network, canonical)])], valid: true, canonical };
    } catch {
        return { keys: [exact], valid: false, canonical: null };
    }
}
