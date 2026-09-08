# Cowrie sanctions client

TypeScript client for SanctionsResolverV2. The package is prepared for npm publication
at the V2 launch; it is not published yet. Supply the verified V2 deployment address.

```ts
import { lookupSanctions } from '@cowrie/sanctions-client';

const result = await lookupSanctions({
  client, // your viem PublicClient on the oracle's deployment chain
  resolver, // the verified SanctionsResolverV2 address
  network: 'BTC',
  account: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
});
```

Results have `status: 'listed' | 'not-listed' | 'invalid-input'`, the queried block,
and matching attestation UIDs. A match to an undecodable Treasury string returns
`listed` with `sourceLiteral: true`. An unmatched malformed input returns
`invalid-input`, never `not-listed`. RPC errors throw. This reports membership in
the oracle at a block; it does not infer other addresses owned by a listed entity.

`lookupSanctionsBatch` accepts an `accounts` array of `{ network, account }` and
pins all reads to one block. You may supply `blockNumber` explicitly. Bound batches
to your RPC provider's eth_call limits.

Supported namespaces: EVM, BTC, BCH, BTG, BSV, LTC, DASH, ZEC, XVG, XMR, XRP, TRX,
SOL, DOGE, BNB (Beacon Chain). All EVM chains share the EVM address-wide namespace.
`networkId('BTC')` returns the zero-padded ASCII bytes32 value the contract expects.

Valid alternate representations normalize through the pinned ENS address codecs.
BCH legacy/CashAddr and Bitcoin Bech32 case variants converge. XRP X-addresses
converge to their classic account independently of destination tags; Monero
integrated addresses converge to their standard account independently of payment IDs.
Base58 remains case-sensitive. Unknown networks throw instead of producing a miss.

`prepareSanctionsQuery` returns source and canonical keys plus input validity for
custom integrations. `sanctionsAccountKey` hashes an already canonical string or
an exact source literal; it does not normalize non-EVM input implicitly.

The oracle also publishes each source spelling when it differs from the canonical
key. Direct RPC users can query either stored spelling. Other alternate forms need
normalization through this package before calling the contract. Onchain callers can
use `isSanctioned(address)`, `isSanctionedAccount`, or `isSanctionedKey` without npm.
