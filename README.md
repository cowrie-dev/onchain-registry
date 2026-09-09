# SanctionsResolverV2

EAS-backed OFAC oracle for EVM and non-EVM accounts, preserving the exact
Chainalysis `isSanctioned(address) returns (bool)` ABI. V2 is the replacement
implementation; its deployment is prepared, not live yet. V1 remains in the
repository and deployment history but is deprecated for the planned launch.

Planned CREATE3 proxy address: `0x0facD8549aB0666c3c79597f75cd8c75A5520Fac`.
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

## Proxy and ownership

V2 uses the unmodified OpenZeppelin 5.4 `ERC1967Proxy`. The implementation inherits
`UUPSUpgradeable` and `OwnableUpgradeable`. There is no ProxyAdmin contract.
Consumers and EAS use the proxy address. Its constructor calls
`initialize(owner, initialAttester)` atomically; the implementation disables
initialization on itself. The schema UID is computed in proxy context and stored
in proxy storage.

The resolver owner controls both trusted attesters and implementation upgrades.
The owner calls `upgradeToAndCall(implementation, data)` on the resolver proxy;
`_authorizeUpgrade` requires `onlyOwner`. A replacement implementation must retain
UUPS compatibility. Before any upgrade, verify storage compatibility, the EAS
address embedded in the new implementation, schema identity, and byte-identical
legacy query behavior. Preserve existing storage fields and their types. An atomic
upgrade callback runs with the original caller as `msg.sender`.

To permanently disable upgrades while retaining attester administration, deploy a
storage-compatible final implementation whose `_authorizeUpgrade` always reverts,
then upgrade to it. Verify that it has no other implementation-changing mechanism.
The tests demonstrate that freezing this way preserves sanctions and lets a
governance owner rotate attesters and transfer ownership. This is a future option;
the initial deployment remains upgradeable. Renouncing ownership on the initial
implementation would disable both upgrades and attester management, so it is not
the procedure for freezing upgrades while retaining an administrator.

The deployment key and resolver owner are separate. The launch uses the 1Password
key for `0xcC5DcD1aBDf65366DdEd3B9a59513CaB822F1c3E` to deploy and register the schema.
The Vault account `0x8035B1a1cC4257B96e85E3924221bbCBb2Ed2a69` is the initial resolver
owner and trusted attester. The deployer receives no resolver authority.

## Build and prepare deployment

```
PUPPETEER_SKIP_DOWNLOAD=1 npm ci
npm test
npx hardhat compile --build-profile production
npx hardhat run scripts/prepare-v2.ts --build-profile production
```

Run the preparation script with a TypeScript runner that resolves `.js` source
imports (the Hardhat runner also works: `npx hardhat run scripts/prepare-v2.ts
--build-profile production`). It produces `calldata/sanctions-v2-1.json` and
`calldata/sanctions-v2-11155111.json`, each containing three ordered transactions:
implementation deployment, UUPS proxy deployment with atomic initialization,
and schema registration. Preparation makes no RPC calls, signs nothing, and does
not write deployment records. Deployer, resolver owner and initial attester are
explicit in the plan.

Before signing, check that both deployment targets and their CREATE3 intermediaries
are unused on the chosen chain, check CreateX's prediction and EAS/SchemaRegistry addresses, and review the
compiled transaction bytes. Deploy and register, record only confirmed V2 entries
in deployments.json (including the implementation address), then
populate sanctions from the verified source through Ledger Vault.
Copy confirmed V2 records into the scraper's curated deployment snapshot before
switching its scheduled publisher. Keep V1's historical entries; stop updating V1
only after V2 is populated and verified. Do not empty the old contract.

The existing `deploy`, `deploy:create3`, `register-schema` and `verify:sourcify`
commands now target V2. Live signing commands use the repository's 1Password
wrapper. `.env.ref` resolves `PRIVATE_KEY` from
`op://ofac onchain/ETH Keys/PK-0xcc5dcd1abdf65366dded3b9a59513cab822f1c3e`.
Supply `INITIAL_OWNER` and `INITIAL_ATTESTER` as the Vault address and `SALT` from
the deployment plan. For CREATE3 broadcasting, explicitly pass `--network mainnet`
or `--network sepolia` and `--build-profile production` to `npm run deploy:create3 --`.
Default live network is Sepolia. CREATE3 uses a sender-permissioned salt
without chain-specific protection so both chains get the same address.
The implementation uses a separate permissioned salt derived from the proxy salt.
If deployment stops after the implementation transaction, inspect the confirmed
state and use the remaining prepared transactions; the live script refuses to
reuse occupied targets.

Verify both contracts with `VERIFY_TARGET=proxy` and `VERIFY_TARGET=implementation`
using `npm run verify:sourcify`. Each has its own creation transaction. `deploy:create3` records
both transaction hashes. For a direct deployment or custody broadcast, record the
confirmed hashes or pass the appropriate `CREATION_TX` to verification.


The single mainnet Vault whitelist amendment retains the existing EAS entry and
adds the historical V1 resolver and the final V2 proxy address together. Preserve
the separate ENS whitelist. Deployment and schema registration use the 1Password
key, so CreateX and SchemaRegistry need no Vault whitelist entries. UUPS upgrades
and attester management both target the V2 proxy; implementations do not need
separate entries. Confirm the final vanity address before submitting the amendment.

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
