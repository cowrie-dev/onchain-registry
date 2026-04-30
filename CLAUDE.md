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

Single contract: `contracts/AddressRegistry.sol`.  It composes `Ownable` (single owner) with `AccessControlEnumerable` (UPDATER_ROLE), and tracks the active address set via `EnumerableSet.AddressSet` so callers can enumerate the registry on-chain.

Two non-obvious invariants enforced by the contract, worth preserving on any change:

- `_transferOwnership` is overridden to keep `DEFAULT_ADMIN_ROLE` and `UPDATER_ROLE` in sync with `owner()`: the previous owner loses both roles, the new owner gains both.  Any new role added to the contract should follow this same pattern or be explicitly excluded.
- `_clearRegistryValues` reverts on addresses that were never set (`Registry: address not set`).  This is intentional (callers must know what they are clearing) and tests rely on it.

Values are constrained to `uint8` in `[0, 100]`; `_setRegistryValue` enforces the upper bound.  The `parseUint8List` helper in `scripts/utils/registry.ts` mirrors that range on the client side.

## Networks and deployments

`hardhat.config.ts` defines a live `shape` network (Shape L2, chainId 360, `chainType: "op"`) plus two simulated networks (`hardhatMainnet`, `hardhatOp`).  `npm run deploy` is hardcoded to `--network shape`; for other targets, invoke `npx hardhat run scripts/deploy.ts --network <name>` directly.

Deployments are recorded to `deployments.json`, keyed by chain ID then contract name.  The deploy script preserves any existing entries and migrates legacy single-contract entries (where the chain ID mapped directly to a deployment record) into the nested shape on the next write.

## Testing

Tests use the Node built-in test runner (`node:test`) with `assert/strict`, not Mocha/Chai, despite Hardhat's defaults.  Wallet clients are pulled once in a top-level `before` hook and reused across `describe` blocks.  When asserting reverts, use the `expectRevert` helper in `test/address-registry.test.ts`: viem nests revert reasons through several `cause` layers, and the helper flattens them before matching.

## Writing style

No em-dashes anywhere (prose, comments, commit messages).  Use parentheses, commas, semicolons, colons, or periods instead.
