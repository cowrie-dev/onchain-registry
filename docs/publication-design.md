# Publication-based sanctions updates

The deployed V2 UUPS proxy stays at its existing address. The new implementation
inherits the deployed storage layout and appends publication state. Activation is
owner-only and refuses a nonempty registry; this deployment has never been populated.
Ownership and attester trust survive activation. Ordinary Ownable transfer and trust
rotation permit another operator, including Treasury, to take over the same proxy.

Only publications that change crypto membership require transactions. EAS records
are non-revocable historical observations. Removal is an explicit change; a later
correction never erases earlier evidence. Kind 0 is bootstrap, 1 publication, and
2 correction. Bootstrap and corrections are excluded from publication-change counts.
Each record includes the comparison source digest. Counts cover observed
publication differences; a release never downloaded cannot be reconstructed
from its successor. Kind 2 is available for explicit operator corrections.

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
publication-completed event. State changes become visible after each chunk, so a
partially applied publication is explicitly observable. There is no claim of atomic
activation across multiple transactions. The sender of each chunk is retained by EAS.
Replays, wrong predecessors, header changes and out-of-order chunks are rejected.

One ordinary publication generally needs one EAS attestation and one transaction.
Several publication attestations may share a multiAttest transaction. Large bootstrap
loads use measured bounded chunks. No unchanged-publication transactions or approvals
are created. The publisher retains original source bytes and prepared proposals and
must resume pending work rather than replacing it on each poll.

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
digest supports independent verification. Immutable prepared plans preserve the
publisher's exact chunks across retries and operator approvals.

## Readable schema

```
string source,string sourceUrl,bytes32 sourceSha256,bytes32 comparisonSourceSha256,uint64 sourcePublishedAt,bytes32 previousPublication,uint8 kind,uint32 chunkIndex,uint32 chunkCount,string[] sourceUIDs,string[] categories,uint64[] designatedAt,string[] entityNetworks,string[] addedAccounts,uint32[] entityIndices,string[] removedNetworks,string[] removedAccounts
```

`entityIndices[i]` selects the source UID, category, designation date and network
for `addedAccounts[i]`. Removal networks and accounts are parallel arrays. No
binary account decoding is needed, including for EVM addresses. An active key
points to its publication chunk; EAS holds the readable values and provenance.
