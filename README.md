# SanctionsResolverV2

EAS-backed OFAC oracle for EVM and non-EVM accounts, preserving the exact
Chainalysis `isSanctioned(address) returns (bool)` ABI. V2 is deployed on Ethereum mainnet. Initial sanctions loading is still pending;
do not use it for screening until population and the source comparison are complete.
V1 remains in the repository and deployment history.

Mainnet CREATE3 proxy address: `0x0facD8549aB0666c3c79597f75cd8c75A5520Fac`.
The proxy, owner, trusted attester and schema have been verified onchain.
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

## Publication records and state

The next implementation, `SanctionsPublicationResolver`, upgrades the existing
empty V2 proxy in place. It retains the Chainalysis query ABI and adds readable
publication records. The active deployment record still describes
the original proxy implementation; publication support is not yet activated on mainnet.
The candidate implementation and non-revocable schema are deployed and verified;
[the deployment receipt record](docs/deployments/sanctions-publication-mainnet.json)
contains their addresses, transactions and pending owner-upgrade calldata.

Each submitted reconciliation batch is a non-revocable EAS observation containing
`string[]` account additions and removals. All networks, including EVM, use the
same readable encoding. A shared entity table avoids repeating source IDs,
categories, network names and designation dates for each account. The schema is
exported as `PUBLICATION_SCHEMA` by the client; see
[the publication design](docs/publication-design.md) for its fields and semantics.

Removal is an explicit change in a later publication. Any currently trusted
attester can submit it, including a successor operator. Historical EAS records
remain intact. Removing attester trust prevents future writes without erasing
prior entries. `getAccountByKey` returns the active account and network as strings.
`getPublicationChunk` returns the decoded arrays from EAS.

`latestPublication` identifies the last completed onchain batch. The publisher
closes all chunks of a batch in one atomic `multiAttest` transaction, leaving
`pendingPublication` empty. Large differences require several independent batches;
only `--check-sync` establishes that the mined set matches the latest Treasury list.
`PublicationCompleted` counts submitted batches, not Treasury releases. The first
batch uses kind 0 and later reconciliations use kind 2. Kind 1 remains a supported
schema value but is not emitted by the publisher.

Each run compares the latest verified Treasury list with the current onchain set.
Matching sets need no transaction or approval. No source archive, public bucket,
or saved transaction plan is required. After a restart, read current membership
and recover removed accounts through `getAccountByKey`; compute the difference
again. `comparisonSourceSha256` is zero because the baseline is chain state.
`sourceUrl` points to Treasury's current feed and the digest identifies the bytes
used; historical source availability and intermediate Treasury changes are not
promised. Paginate enumeration at one fixed block because removal changes order.

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

## Build and prepare the publication upgrade

```sh
PUPPETEER_SKIP_DOWNLOAD=1 npm ci
npm test
npx hardhat compile --build-profile production
npx hardhat run scripts/prepare-publication-upgrade.ts --build-profile production
```

The preparation script reads mainnet, verifies the current implementation, EAS,
owner, attester and empty registry, and writes `calldata/publication-upgrade-1.json`.
It signs nothing. It predicts the new implementation from the deployment EOA's
pending nonce: deploy the implementation first, then register the new schema.
Recheck the nonce if that EOA sends another transaction.

The Vault owner then calls `upgradeToAndCall(newImplementation,
initializePublications())` atomically. Activation refuses a populated registry and
preserves owner and attester trust. Record the new implementation and schema UID
only after a successful receipt and post-upgrade checks. Copy those confirmed
records into the publisher repository before cutover.

Only V1 and the existing V2 proxy need adding to the Vault whitelist, in one
amendment retaining EAS and ENS. Implementation deployment and schema registration
use the deployment EOA; no new whitelist destination is needed for them.

The publisher in cowrie-dev/scraper owns source reconciliation,
hardware proposals and bootstrap recovery; its `docs/sanctions-resolver-v2.md`
is the cutover runbook. The old `registry:sanction` and `registry:unsanction`
commands apply only to the original per-key schema and refuse an activated
publication resolver. Use the publication publisher for additions and removals.

Measured against the September 8 source (998 lookup keys), the readable publication
benchmark of a multi-transaction publication used 265,481,864 gas in 34 EAS chunks grouped into 29 transactions with
20% gas headroom. That is about 63% less than the previous 725,605,331-gas estimate.
The current publisher completes a separate publication per transaction, so that
benchmark is not an exact estimate for its bootstrap. Dollar cost depends on gas
price and ETH price. Later small changes generally
require one transaction; the initial load is the exceptional large operation.

The [public communication draft](docs/ofacts.md) explains the motivation for EAS.
The client package is prepared for npm publication after activation and population.
