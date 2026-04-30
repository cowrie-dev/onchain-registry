# EAS Resolver Migration Spec

Convert `cowrie-dev/onchain-registry` from a self-contained `AddressRegistry` to an EAS-backed sanctions resolver.  EAS becomes the canonical data layer.  The contract becomes a `SchemaResolver` that exposes a sanctions-specific read interface (`isSanctioned`, `getDesignation`) backed by EAS attestation state.

## Goal

Replace the generic `address → uint8` interface with a sanctions-specific one.  Sanctioned status is binary and determined by the presence of a non-revoked attestation from a trusted attester.  Rich metadata (source, evidence, designation date) lives in EAS and is reachable via attestation UID.  All mutations flow through EAS attestations against a registered schema.

## Why

- EAS gives a public, indexed audit trail for every change.  EAS Scan becomes the registry explorer for free.
- Revocation is first-class.  No custom delisting logic.
- Composable: the same schema can later accept multiple trusted attesters without changing the contract.  Single-attester today, DAO-governed attester set later.
- Multi-chain deploy story is unchanged.  EAS is already on every target chain.

## Current state

`AddressRegistry`:
- `mapping(address => uint8)` storing scores 0-100.  Generic risk-score interface, never specialized.
- `Ownable` plus `AccessControlEnumerable` with an `UPDATER_ROLE`.
- `setValues`, `clearValues`, `update`, `getValues` as the write/read interface.
- TS scripts manage updaters and submit batched updates.

The 0-100 score is unused in practice.  Consumers want a binary sanctioned check.  This migration drops the score concept entirely.

## Target state

`SanctionsResolver` extends `SchemaResolver`:
- `mapping(address => Designation)` where `Designation` is a compact struct: active EAS UID, attester, timestamp.
- Sanctioned status derived from `activeUID != 0`.
- `Ownable` retained for managing the trusted attester set.
- `mapping(address => bool) trustedAttesters` replaces `UPDATER_ROLE`.
- `onAttest` and `onRevoke` are the only mutation paths.  No direct setters.
- Public read: `isSanctioned(address)` (Chainalysis-compatible signature), `isSanctioned(address[])`, `getDesignation(address)`.

Deployed to Ethereum mainnet.  Single chain.  No multi-chain story for now; revisit if consumers on other chains surface.

The `trustedAttesters` mapping accepts any address.  Initial deploy uses a Cowrie-controlled EOA.  Migrating to a contract attester later (multisig, DAO module, custom logic) is just a matter of adding the contract address to the allowlist and having it call `EAS.attest()`.  No resolver code change needed.  EAS supports contract attesters natively; `msg.sender` is recorded as the attester regardless of whether it's an EOA or contract.

## Schema

Registered once on Ethereum mainnet.  Schema string:

```
string source,
string sourceUID,
string category,
string evidenceURI,
uint64 designatedAt
```

| Field | Purpose |
|---|---|
| `source` | Free-form source label.  E.g. `"OFAC_SDN"`, `"UN_CONS"`, `"COWRIE_INTERNAL"`. |
| `sourceUID` | Source-side identifier.  E.g. OFAC's SDN entry UID.  Enables auditability back to the original designation. |
| `category` | Designation type.  E.g. `"INDIVIDUAL"`, `"ENTITY"`, `"MIXER"`, `"CLUSTER"`.  Lets downstream consumers filter by classification. |
| `evidenceURI` | IPFS / Arweave pointer to an evidence bundle.  Optional but recommended. |
| `designatedAt` | Unix timestamp of original designation by the source.  Distinct from on-chain `att.time`. |

The EAS attestation `recipient` field is the sanctioned address.  Schema is `revocable: true`.

There is no boolean field in the schema.  Sanctioned status is encoded by attestation presence: an active (non-revoked) attestation from a trusted attester means the recipient is sanctioned.  Revocation is the unsanctioned path.

The schema is generic, not scoped to Cowrie's resolver.  Other parties could attest against it; the resolver's allowlist filters out attestations from untrusted attesters.

## Resolver sketch

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

contract SanctionsResolver is SchemaResolver, Ownable {
    struct Designation {
        bytes32 attestationUID;  // 0 means not sanctioned
        address attester;
        uint64 attestedAt;
    }

    mapping(address => Designation) private _designations;
    mapping(address => bool) public trustedAttesters;

    event AttesterTrusted(address indexed attester, bool trusted);
    event Sanctioned(address indexed account, address indexed attester, bytes32 uid);
    event Unsanctioned(address indexed account, bytes32 uid);

    constructor(IEAS eas, address initialAttester)
        SchemaResolver(eas)
        Ownable(msg.sender)
    {
        if (initialAttester != address(0)) {
            trustedAttesters[initialAttester] = true;
            emit AttesterTrusted(initialAttester, true);
        }
    }

    function setAttesterTrust(address attester, bool trusted) external onlyOwner {
        trustedAttesters[attester] = trusted;
        emit AttesterTrusted(attester, trusted);
    }

    function isSanctioned(address account) external view returns (bool) {
        return _designations[account].attestationUID != bytes32(0);
    }

    function isSanctioned(address[] calldata accounts) external view returns (bool[] memory out) {
        out = new bool[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            out[i] = _designations[accounts[i]].attestationUID != bytes32(0);
        }
    }

    function getDesignation(address account) external view returns (Designation memory) {
        return _designations[account];
    }

    function onAttest(Attestation calldata att, uint256) internal override returns (bool) {
        if (!trustedAttesters[att.attester]) return false;

        _designations[att.recipient] = Designation({
            attestationUID: att.uid,
            attester: att.attester,
            attestedAt: uint64(block.timestamp)
        });
        emit Sanctioned(att.recipient, att.attester, att.uid);
        return true;
    }

    function onRevoke(Attestation calldata att, uint256) internal override returns (bool) {
        // only clear if this is the currently active attestation for the recipient
        if (_designations[att.recipient].attestationUID == att.uid) {
            delete _designations[att.recipient];
            emit Unsanctioned(att.recipient, att.uid);
        }
        return true;
    }
}
```

Consumers needing rich metadata (source, evidenceURI, designatedAt) read it from EAS directly using the `attestationUID` returned by `getDesignation`.  EAS is canonical for the metadata; the resolver mirror only stores what's needed for cheap binary checks.

## Key design decisions

### Sanctioned status by attestation presence

No boolean field in the schema.  An address is sanctioned iff there's an active (non-revoked) attestation against the schema from a trusted attester.  Revocation is the unsanctioned path.  This is the simplest possible encoding and matches how EAS is meant to be used.

### Compact mirror, EAS for rich data

The resolver stores `Designation { attestationUID, attester, attestedAt }` per address.  Just enough for `isSanctioned()` to answer in one SLOAD and for consumers to look up rich metadata in EAS via the UID.  Source, sourceUID, evidenceURI, and designatedAt live only in EAS.  No data duplication.  EAS is canonical.

### Last-attestation-wins per recipient

Multiple attestations against the same recipient are allowed by EAS.  The resolver tracks the most recent active UID per recipient.  Revocation only clears state if the revoked UID matches the active one.  Stale revocations of superseded attestations are no-ops.  This handles "address re-attested with updated metadata" cleanly.

### Single trusted attester at launch, allowlist-ready

Constructor takes one initial attester for simplicity.  Owner can add or remove attesters later.  No code change required to support a DAO-governed multi-attester case.  When that happens, the resolver still uses last-write semantics, which means whoever attests most recently wins.  If multi-attester is adopted with disagreement-prone sources, switch to a per-attester mapping with a read-time aggregator.  Out of scope here.

### No direct setters

`setValues`, `clearValues`, `update`, and `getValues` are removed.  All mutation flows through EAS.  This is the whole point.  Keeping a backdoor would defeat the audit-trail benefit.

### Owner retains control of attester set, not data

`Ownable` exists only to manage `trustedAttesters`.  Owner cannot directly write to `_designations`.  Compromising the owner key lets you add a malicious attester, but every attestation that attester makes is publicly visible on EAS Scan.  Compromise is detectable.

## Migration plan

1.  Register schema on Ethereum mainnet.  Record schema UID in `deployments.json`.
2.  Deploy `SanctionsResolver` with Cowrie attester EOA as `initialAttester`.
3.  Bulk attestation script submits one EAS attestation per address from the prepared sanctions list.  The resolver mirror populates as attestations land.  Verify mirror matches expected sanctioned set.
4.  Update consumer integrations to point at the new resolver address.  `isSanctioned(address)` matches the Chainalysis interface, so swap is one address change per consumer.
5.  Old `AddressRegistry` deployments left in place but frozen (revoke `UPDATER_ROLE` from all updaters).  Deprecation note in the repo.

## Script changes

Existing scripts mostly delete or convert:

| Current | Replacement |
|---|---|
| `registry:add-updaters` | `registry:trust-attester` (calls `setAttesterTrust(addr, true)`) |
| `registry:remove-updaters` | `registry:untrust-attester` |
| `registry:list-updaters` | EAS Scan + an off-chain helper that enumerates `AttesterTrusted` events |
| `registry:set-values` | `registry:sanction` (submits EAS attestations for new sanctioned addresses) |
| `registry:clear-values` | `registry:unsanction` (revokes EAS attestations by UID) |
| `registry:update` | Combined attest + revoke in a single tx batch via EAS multicall |
| `registry:get-values` | `registry:check` (calls `isSanctioned`) |
| `registry:transfer-owner` | Unchanged |

The sanction and unsanction scripts need to track UIDs.  Either query EAS for the active UID per recipient at runtime, or maintain a local UID index in `deployments.json` or a small SQLite cache.

## Resolved decisions

- **Chain**: Ethereum mainnet only.  No multi-chain deploy.
- **Attester**: single Cowrie-controlled EOA at launch.  Allowlist mapping accepts contract addresses transparently, so future migration to a multisig, DAO module, or custom contract attester needs no resolver changes.
- **Schema fields**: `source`, `sourceUID`, `category`, `evidenceURI`, `designatedAt`.  Five fields.
- **Read interface**: `isSanctioned(address) returns (bool)` matches Chainalysis exactly.  `isSanctioned(address[])` overload added for batch reads.  `getDesignation(address)` returns the compact struct for consumers needing the EAS UID.
- **Schema scope**: generic, not Cowrie-scoped.  Other parties can attest against it; resolver allowlist filters out untrusted attesters.
- **Upgradeability**: non-upgradeable.  If new logic is needed, deploy a v2 with a new schema and migrate consumers.
- **Initial corpus**: prepared sanctions list provided at attestation time.  No migration from existing `AddressRegistry` state.

## Out of scope for this iteration

- DAO-governed attester set.  Allowlist hooks are present; governance on top is a separate effort.
- Multi-attester disagreement resolution.
- Multi-chain deployment.  Mainnet only for now.
- OFAC ingestion pipeline.  That is the separate concrete ticket.  This spec is the contract layer only.
- Tax withholding resolver.  Same operational infrastructure, separate contract and spec.