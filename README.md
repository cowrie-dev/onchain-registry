# SanctionsResolverV2

EAS-backed OFAC oracle for EVM and non-EVM accounts, preserving the exact
Chainalysis `isSanctioned(address) returns (bool)` ABI. V2 is the replacement
implementation; its deployment is prepared, not live yet. V1 remains in the
repository and deployment history but is deprecated for the planned launch.

Planned CREATE3 address: `0x0FaC8987bc6E6a688082BFD0440DF5d6Ee670FAc`.
Do not send queries there until deployment and initialization are confirmed.
See [the deployment plan](deployment-plans/sanctions-v2.json).

## Queries

Existing Chainalysis integrations change only the oracle contract address.
Their ABI, selector (`0xdf592f7d`), argument encoding and boolean response remain
unchanged. `isSanctioned` is not overloaded. It remains address-wide across EVM
chains, including through the generalized EVM namespace.

| Method | Result |
| --- | --- |
| `isSanctioned(address)` | Chainalysis-compatible EVM membership |
| `isSanctionedBatch(address[])` | EVM membership in input order |
| `getDesignation(address)` | EVM active UID, attester and attestation time |
| `isSanctionedAccount(bytes32,string)` | Canonical or published literal account membership |
| `accountKey(bytes32,string)` | Key for an account string; normalizes valid EVM hex case |
| `isSanctionedKey(bytes32)` / `isSanctionedKeyBatch(bytes32[])` | Precomputed-key membership |
| `getDesignationByKey(bytes32)` | Active UID and attester for any key |
| `sanctionedCount()` / `sanctionedAddresses()` / `sanctionedRange(offset,limit)` | EVM-only enumeration, preserving V1 meanings |
| `sanctionedAccountCount()` / `sanctionedKeyRange(offset,limit)` | Complete lookup-key enumeration |
| `supportsNetwork(bytes32)` | Whether the namespace is recognized |

Network IDs are zero-padded ASCII bytes32: EVM, BTC, BCH, BTG, BSV, LTC, DASH,
ZEC, XVG, XMR, XRP, TRX, SOL, DOGE and BNB (Beacon Chain). OFAC XBT means BTC.
USDT/USDC describe assets, not address namespaces. Unknown namespaces revert.

Valid EVM keys hash `abi.encode(bytes32("EVM"), address)`. Other keys hash
`abi.encode(network, accountString)`. This keeps EVM reads inexpensive and makes
non-EVM identity network-specific and case-sensitive.

The publisher preserves the source spelling and also publishes a canonical
spelling when its key differs. Undecodable Treasury strings remain exact-match
entries, including malformed EVM strings. They cannot affect the ABI address
lookup or EVM enumeration. Keys therefore count queryable spellings, not unique
accounts. Other alternate encodings require client normalization before RPC or
onchain lookup. The [npm-ready TypeScript client](client/README.md) handles this,
returning listed / not-listed / invalid-input and preserving source evidence.

## EAS schema and state

```
bytes32 network,string account,string source,string sourceUID,string category,string sourceUrl,bytes32 sourceSha256,uint64 sourcePublishedAt,uint64 designatedAt
```

One new revocable schema covers every namespace. For a valid EVM account,
`recipient` must equal that account; otherwise it must be zero. The resolver
accepts only this schema, trusted attesters, no expiration, and revocable entries.
Rich source metadata lives in EAS; the resolver stores the active designation.
Re-attestation replaces the active UID. Revoking a superseded UID is a no-op;
revoking the active UID removes that key, without resurrecting older attestations.
Removing attester trust prevents future additions; it does not erase prior entries.

Paginate enumeration at one fixed block because removal changes element order.
The source publisher lives in cowrie-dev/scraper and uses the verified complete
OFAC snapshot for additions and removals.

## Build and prepare deployment

```
npm ci
npm test
npx hardhat compile --build-profile production
npx hardhat run scripts/prepare-v2.ts --build-profile production
```

Run the preparation script with a TypeScript runner that resolves `.js` source
imports (the Hardhat runner also works: `npx hardhat run scripts/prepare-v2.ts
--build-profile production`). It produces `calldata/sanctions-v2-1.json` and
`calldata/sanctions-v2-11155111.json`, each containing the CREATE3 deployment and
schema registration transactions. It makes no RPC calls, signs nothing, and does
not write deployment records. Owner and initial attester are explicit in the plan.

Before signing, check that the target and CREATE3 proxy are unused on the chosen
chain, check CreateX's prediction and EAS/SchemaRegistry addresses, and review the
compiled transaction bytes. Deploy and register, record only confirmed V2 entries
in deployments.json, then initialize from the verified source through Ledger Vault.
Copy confirmed V2 records into the scraper's curated deployment snapshot before
switching its scheduled publisher. Keep V1's historical entries; stop updating V1
only after V2 is populated and verified. Do not empty the old contract.

The existing `deploy`, `deploy:create3`, `register-schema` and `verify:sourcify`
commands now target V2. Live signing commands retain the repository's 1Password
wrapper. Default live network is Sepolia. CREATE3 uses a sender-permissioned salt
without chain-specific protection so both chains get the same address.

## Operator commands

- `RESOLVER_NETWORK=BTC RESOLVER_ACCOUNTS=... npm run registry:check`
- `INPUT=accounts.json npm run registry:sanction` (each entry includes `network` and `address`, plus source evidence)
- `RESOLVER_NETWORK=BTC RESOLVER_ACCOUNTS=... npm run registry:unsanction` (source and canonical keys)
- `RESOLVER_KEYS=0x... npm run registry:unsanction` (explicit keys)
- `npm run registry:list-sanctioned` (all keys at a pinned block)

EVM is the default namespace. Trust-attester, untrust-attester and transfer-owner
commands retain their existing arguments and now discover V2 deployments.

## Client package

`npm run client:build` compiles `@cowrie/sanctions-client`. Run `npm pack --dry-run`
from client/ to inspect its publishable files. The repository root is private so
it cannot accidentally be published as the client. Publication is a separate
launch step; no npm version has been published by this change.
