# Cowrie sanctions client

TypeScript client for the Cowrie sanctions oracle's V2 proxy, including the
`SanctionsPublicationResolver` upgrade activated on Ethereum mainnet on September
10, 2026. Version `0.1.0` is prepared for its first npm publication.

The mainnet proxy is `0x0facD8549aB0666c3c79597f75cd8c75A5520Fac` (chain ID 1).
Use the proxy for state reads. Its current implementation is recorded in the
repository's `deployments.json`; upgrades keep the proxy address stable.

## Installation and lookup

After publication:

```sh
npm install @cowrie/sanctions-client viem
```

The package is ESM and requires viem 2.37.12 or later in the 2.x series.

```ts
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { lookupSanctions } from '@cowrie/sanctions-client';

const client = createPublicClient({ chain: mainnet, transport: http('https://YOUR_ETHEREUM_RPC') });
const resolver = '0x0facD8549aB0666c3c79597f75cd8c75A5520Fac';

const result = await lookupSanctions({
  client,
  resolver,
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

## Publication records

In the current implementation, `getAccountByKey` returns readable network,
account and source UID strings. `latestPublication`, `pendingPublication` and
`PublicationCompleted` expose update progress without changing membership queries.

The package also exports `PUBLICATION_SCHEMA`, `encodePublication`,
`decodePublication`, `publicationId`, `publicationSchemaUID`,
`publicationRequest`, and `buildPublicationChunks`. These use ordinary EAS ABI
arrays, including strings for every address family. The chunk builder defaults
to 30 changes; publishers must simulate the resulting transaction and bound its
gas before submission. `publicationRequest` builds a non-revocable EAS request;
removals belong in later publication records, not EAS revocations.

For the current publisher lifecycle, submit all chunks of one publication in a
single EAS `multiAttest` transaction. `buildPublicationChunks` partitions changes;
it does not submit transactions or decide which chunks fit the gas limit. If a
complete publication does not fit, build smaller complete publications, each
linked to the previous publication ID. Kind `0` bootstraps an empty registry;
subsequent reconciliations use kind `2`. Kind `1` remains supported for explicit
source publications. An unchanged set produces no chunks and needs no transaction.

## Enumerating current accounts

`sanctionsResolverV2Abi` includes the current publication reads as well as the
original V2 membership methods. The counts describe different sets:

- `sanctionedAddresses()` returns every valid EVM address and its length matches
  `sanctionedCount()`.
- `sanctionedKeyRange(offset, limit)` returns account keys across all supported
  networks and its complete length matches `sanctionedAccountCount()`.
- `getAccountByKey(key)` returns `[network, account, sourceUID]` for an active key.
  `sourceUID` is the Treasury entity ID. Canonical and source spellings can have
  separate keys, so this is a list of lookup records, not distinct wallets or people.

Read every page and its details at one block because removals reorder the set:

```ts
import { sanctionsResolverV2Abi } from '@cowrie/sanctions-client';

const blockNumber = await client.getBlockNumber();
const contract = { address: resolver, abi: sanctionsResolverV2Abi, blockNumber } as const;
const count = await client.readContract({ ...contract, functionName: 'sanctionedAccountCount' });
const accounts = [];
for (let offset = 0n; offset < count; offset += 100n) {
  const keys = await client.readContract({
    ...contract, functionName: 'sanctionedKeyRange', args: [offset, 100n],
  });
  for (const key of keys) {
    const [network, account, sourceUID] = await client.readContract({
      ...contract, functionName: 'getAccountByKey', args: [key],
    });
    accounts.push({ key, network, account, sourceUID });
  }
}
```

The sequential example bounds RPC concurrency. Larger consumers can batch those
reads through their provider or Multicall while preserving `blockNumber` and
propagating read failures.

## Preparing a release

From the repository root:

```sh
npm ci
npm test
npm run client:check
```

`client:check` packs the SDK, installs that tarball in a temporary consumer, checks
TypeScript imports, and exercises its runtime exports. It requires npm registry
access on a cold cache. The package contains compiled JavaScript, declarations,
this README and the MIT license.

After the release commit has merged, an authorized maintainer with publish access
to the `@cowrie` npm scope can publish from `client/`:

```sh
cd client
npm publish --dry-run
npm publish --access public
npm view @cowrie/sanctions-client version
```

Review the version and tarball contents before the real publish. The dry run does
not prove that the npm account has publishing permission or satisfies its 2FA
requirements. This SDK needs only an RPC connection for reads, with no wallet or
signing key.
