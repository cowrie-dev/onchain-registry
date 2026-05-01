# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack

Hardhat 3 + TypeScript (ESM, `node16` module resolution) + Viem.  Solidity 0.8.28.  OpenZeppelin Contracts v5.

Hardhat 3 is meaningfully different from Hardhat 2: network access goes through `network.connect()` (not the legacy `hre`), and the `viem` helper is exposed off the connection (`(await network.connect()).viem`).  When in doubt, mirror existing scripts under `scripts/` rather than referencing Hardhat 2 patterns from training data.

## Common commands

```shell
npm test                       # runs node:test via `npx hardhat test`
npm run deploy                 # deploys AddressRegistry to the `shape` network
npm run registry:<action>      # see README for the full action list
```

Run a single test by name:

```shell
npx hardhat test --test-name-pattern "permits updaters"
```

All `npm run` scripts that hit a live network are wrapped in `op run --env-file=.env.ref --` (1Password CLI), which injects `PRIVATE_KEY` and `RPC_URL`.  `npm test` does not need `op run`.  When invoking a script manually outside of `npm run`, prepend `op run --env-file=.env.ref --` yourself if it touches a live network.

## Module resolution gotcha

The project uses ESM with `"moduleResolution": "node16"`, so TypeScript files import sibling modules with the compiled `.js` extension (e.g. `from "../utils/registry.js"`) even though the source is `.ts`.  Preserve that style when adding new scripts.  Action scripts use top-level `await` and assume execution under Hardhat's TypeScript runner.

## Argument resolution convention

`scripts/utils/registry.ts` defines `resolveOption` / `requireOption`, which read from CLI flags first (`--registry`, `--accounts=...`) and then fall back to env vars (in order: caller-provided keys, then the flag's own uppercased form).  README documents the env-var path; both are valid and any new action script should use these helpers rather than reading `process.argv` or `process.env` directly.

## Contract architecture

Single contract: `contracts/SanctionsResolver.sol`.  It extends EAS `SchemaResolver`
(from `@ethereum-attestation-service/eas-contracts`) and OpenZeppelin `Ownable`.
`Ownable` governs only the `trustedAttesters` allowlist; the resolver has no direct
setters for sanctions state.  Mutations flow exclusively through EAS:

- `onAttest` is called by EAS on every new attestation.  If the attester is in the
  allowlist, the resolver records the latest `Designation { uid, attester, time }`
  for the recipient and emits `Sanctioned`.  If the attester is not allowlisted,
  `onAttest` returns `false` and EAS reverts the attestation.
- `onRevoke` is called by EAS on revocation.  The resolver only clears its mirror
  if the revoked UID matches the currently active one; revocations of stale
  (superseded) attestations are silent no-ops.  This is the "last-attestation-wins
  per recipient" invariant.

Read interface:

- `isSanctioned(address) returns (bool)` (Chainalysis-compatible).
- `isSanctionedBatch(address[]) returns (bool[])` (named explicitly rather than
  overloaded so viem-style clients can call each variant unambiguously).
- `getDesignation(address) returns (Designation)`: the active UID + attester +
  attestedAt; consumers fetch rich metadata (source, evidenceURI, etc.) from EAS
  using the UID.

Invariants worth preserving on any change:

- `onRevoke` must remain a no-op when the revoked UID is not the active one.
  Tests in `test/sanctions-resolver.test.ts` rely on this for the
  re-attestation-then-stale-revoke flow.
- `onAttest` must reject untrusted attesters with `return false` (which causes
  EAS to revert the whole attestation).  Do not silently accept and skip the
  state update.
- Ownership transfers do **not** need `_transferOwnership` overrides.  The
  legacy `AddressRegistry` overrode it to keep `UPDATER_ROLE` in sync; the new
  contract has no analogous role state, so plain OZ `Ownable` semantics apply.

The schema string (registered against EAS SchemaRegistry on mainnet) is:
`string source,string sourceUID,string category,string evidenceURI,uint64 designatedAt`,
revocable, with the resolver as the schema's resolver.

## Networks and deployments

`hardhat.config.ts` defines a live `mainnet` network (Ethereum, `chainType: "l1"`),
the legacy `shape` network (Shape L2, chainId 360, kept so legacy AddressRegistry
deployments remain reachable), plus simulated `hardhatMainnet` and `hardhatOp`.
`npm run deploy` and every `registry:*` script target `mainnet` by default; pass
`--network <other>` to `npx hardhat run` to target another configured network.

Deployments are recorded to `deployments.json`, keyed by chain ID then contract
name.  The new resolver deployment record carries `address`, `deployer`, `owner`,
`initialAttester`, `easAddress`, `deployedAt`, and (after running
`scripts/register-schema.ts`) `schemaUID`.  EAS contract addresses per chain
live in `scripts/utils/eas.ts`; add an entry to `EAS_ADDRESSES` to support a
new chain.

## Testing

Tests use the Node built-in test runner (`node:test`) with `assert/strict`.  Each
test deploys a fresh EAS + SchemaRegistry pair (via the helpers in
`test/helpers/eas.ts`), then deploys `SanctionsResolver` and registers the schema
with it.  Wallet clients are pulled once in a top-level `before` hook.  When
asserting reverts, use the `expectRevert` helper from `test/helpers/eas.ts`:
viem nests revert reasons through several `cause` layers, and the helper
flattens them before matching.

`contracts/test-helpers/EASImports.sol` exists solely to drag the EAS and
SchemaRegistry source into Hardhat's compilation set; it is never deployed in
production.

## Writing style

No em-dashes anywhere (prose, comments, commit messages).  Use parentheses, commas, semicolons, colons, or periods instead.
