# Publication-based sanctions updates

The deployed V2 UUPS proxy stays at its existing address. The new implementation
inherits the deployed storage layout and appends publication state. Activation is
owner-only and refuses a nonempty registry; this deployment has never been populated.
Ownership and attester trust survive activation. Ordinary Ownable transfer and trust
rotation permit another operator, including Treasury, to take over the same proxy.

The publisher compares the latest verified Treasury list with current onchain
membership. It submits only that difference and keeps no source archive or saved
plan. EAS records are non-revocable observations of updates actually submitted.
Removal is explicit and never erases earlier evidence. Kind 0 is the first
bootstrap batch; kind 2 is each subsequent reconciliation. Kind 1 remains supported
by the schema but is not used by this publisher. Counts describe onchain batches,
not a complete history or count of Treasury editions. `comparisonSourceSha256` is
zero because comparison uses live chain state, not an older source file.

All accounts, including Ethereum accounts and malformed literals, are ordinary
strings in parallel ABI arrays. No packed address codec is needed. Entity metadata
is shared through a per-chunk table of source IDs, categories and designation dates.
Source metadata is shared by all entries in the chunk. EAS explorer decoding uses
standard schema types. The resolver can return an account's original string by
reading its active EAS attestation, avoiding another persistent copy of that string.
The original isSanctioned(address) selector and 32-byte boolean result do not change.

Each logical publication has a deterministic ID derived from its header, including
the preceding completed publication and the number of chunks. Chunks are ordered;
only the final chunk advances the completed-publication pointer and emits the
completion event. The publisher closes every selected chunk in a single atomic
multiAttest transaction. It never leaves a pending publication between transactions.
Large differences are several independent batches, each freshly computed from the
then-current Treasury list and mined set. An externally submitted partial
publication remains observable through `pendingPublication` and requires its
operator to finish it. Replays and out-of-order chunks are rejected.

One invocation proposes at most one transaction. Matching membership produces no
transaction. Existing Vault approvals remain pending until terminal; after a
confirmation, the publisher computes a new difference. It can restart without any
publisher-maintained storage. The chain's active EAS record supplies the original
account/network strings when a key is absent from the current Treasury list.

The resolver stores one UID per key, with attester/time stored once per chunk.
Existing enumeration remains. Per-key getters reconstruct the historical Designation
return shape from shared chunk metadata. Explicit removals can be submitted by any
currently trusted attester; they do not require an outgoing operator's signing key.


## Activation and verification

Use the README upgrade procedure. `initializePublications()` is a version-2
initializer, called atomically during UUPS upgrade. It rejects a nonempty registry;
this is an empty-deployment upgrade, not a migration of old per-key sanctions.
The original `SCHEMA` constant remains for historical compatibility; the active
`schemaUID()` changes to the non-revocable `PUBLICATION_SCHEMA` UID.

The publication ID identifies an ordered header, not a cryptographic commitment
to each change array. Authorized attesters supply the contents; the public source
digest identifies the input used by the publisher. The source URL points to
Treasury's current feed; historical XML availability is not promised. Vault retains
submitted calldata while it awaits approval; the publisher retains no plan.

## Readable schema

```
string source,string sourceUrl,bytes32 sourceSha256,bytes32 comparisonSourceSha256,uint64 sourcePublishedAt,bytes32 previousPublication,uint8 kind,uint32 chunkIndex,uint32 chunkCount,string[] sourceUIDs,string[] categories,uint64[] designatedAt,string[] entityNetworks,string[] addedAccounts,uint32[] entityIndices,string[] removedNetworks,string[] removedAccounts
```

`entityIndices[i]` selects the source UID, category, designation date and network
for `addedAccounts[i]`. Removal networks and accounts are parallel arrays. No
binary account decoding is needed, including for EVM addresses. An active key
points to its publication chunk; EAS holds the readable values and provenance.
