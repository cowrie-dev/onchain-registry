# Sanctions Resolver

EAS-backed sanctions resolver.  This contract extends EAS `SchemaResolver` to mirror
the active sanctioning attestation per address, and exposes a Chainalysis-compatible
`isSanctioned(address)` interface.

EAS is the canonical data layer.  Every sanction is an attestation against a
registered schema; every revocation flows through EAS.  The on-chain mirror stores
just enough (`attestationUID`, `attester`, `attestedAt`) to answer the binary check
in one SLOAD.  Rich metadata (source, evidenceURI, designatedAt) lives in EAS and
is reachable via the UID returned from `getDesignation`.

Built with Hardhat 3, Solidity 0.8.28, OpenZeppelin Contracts v5, and Viem.

## Setup

This project uses [1Password CLI](https://developer.1password.com/docs/cli) for
secure credential management.  The `.env.ref` file contains references to 1Password
secrets.

Required environment variables:

- `RPC_URL`: Ethereum mainnet RPC endpoint
- `PRIVATE_KEY`: Deployer / owner / attester key

Use `op run --env-file=.env.ref --` to inject referenced credentials at runtime.
The package scripts are wired up to do this for you.

## Initial deployment flow

```shell
# 1. Deploy the resolver (writes deployments.json)
INITIAL_ATTESTER=0x... npm run deploy

# 2. Register the schema against EAS, persists schemaUID alongside the deployment
npm run register-schema
```

After `register-schema`, `deployments.json` carries `address`, `easAddress`, and
`schemaUID` for the deployed network.  Action scripts read these automatically.

## Resolver management

Action scripts accept arguments via CLI flags or environment variables.

```shell
# Allowlist management (owner only)
RESOLVER_ACCOUNTS=0xAttester1,0xAttester2 npm run registry:trust-attester
RESOLVER_ACCOUNTS=0xAttester1            npm run registry:untrust-attester

# Inspect allowlist (event-derived)
npm run registry:list-trusted-attesters

# Sanction (bulk EAS attest from JSON file)
INPUT=./sanctions-batch.json npm run registry:sanction

# Unsanction (revokes active EAS attestation per recipient)
RESOLVER_ACCOUNTS=0xAddr1,0xAddr2 npm run registry:unsanction

# Read sanctioned status + active designation
RESOLVER_ACCOUNTS=0xAddr1,0xAddr2 npm run registry:check

# Transfer resolver ownership
RESOLVER_NEW_OWNER=0xNewOwner npm run registry:transfer-owner
```

### Sanction batch input format

`registry:sanction` accepts a JSON array.  Each entry maps to one EAS attestation:

```json
[
  {
    "address": "0xRecipient",
    "source": "OFAC_SDN",
    "sourceUID": "12345",
    "category": "INDIVIDUAL",
    "evidenceURI": "ipfs://Qm...",
    "designatedAt": 1700000000
  }
]
```

All entries are submitted in a single `EAS.multiAttest` call.  The script prints
the resulting `(recipient, uid)` pairs.

### Environment variables

| Variable               | Description                                        | Used by                |
| ---------------------- | -------------------------------------------------- | ---------------------- |
| `INITIAL_ATTESTER`     | Initial trusted attester address                   | `deploy`               |
| `EAS`                  | Override the EAS contract address (testnets only)  | `deploy`               |
| `RESOLVER_ACCOUNTS`    | Comma-separated addresses                          | most action scripts    |
| `RESOLVER_NEW_OWNER`   | New resolver owner                                 | `registry:transfer-owner` |
| `RESOLVER_INPUT`       | Path to a sanctions JSON batch                     | `registry:sanction`    |
| `FROM`                 | Signer address (defaults to first account)         | optional               |

## Read interface

The resolver exposes:

| Function                                    | Purpose                              |
| ------------------------------------------- | ------------------------------------ |
| `isSanctioned(address) returns (bool)`      | Chainalysis-compatible single check  |
| `isSanctionedBatch(address[]) returns (bool[])` | Batch check (one bool per input) |
| `getDesignation(address) returns (Designation)` | Active UID, attester, timestamp |
| `trustedAttesters(address) returns (bool)`  | Allowlist membership                 |
| `owner() returns (address)`                 | OZ Ownable                           |

`isSanctionedBatch` is exposed under a distinct Solidity name (rather than as an
overload of `isSanctioned(address[])`) so client tooling that maps overload sets
to a single function name (e.g. viem) can invoke each variant unambiguously.

## Testing

```shell
npm test
```

Tests deploy a fresh EAS + SchemaRegistry pair, register the sanctions schema with
the resolver, and exercise `onAttest` / `onRevoke` end-to-end.
