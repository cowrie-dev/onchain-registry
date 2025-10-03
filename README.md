# Sample Hardhat 3 Beta Project (`node:test` and `viem`)

This project showcases a Hardhat 3 Beta project using the native Node.js test runner (`node:test`) and the `viem` library for Ethereum interactions.

To learn more about the Hardhat 3 Beta, please visit the [Getting Started guide](https://hardhat.org/docs/getting-started#getting-started-with-hardhat-3). To share your feedback, join our [Hardhat 3 Beta](https://hardhat.org/hardhat3-beta-telegram-group) Telegram group or [open an issue](https://github.com/NomicFoundation/hardhat/issues/new) in our GitHub issue tracker.

## Project Overview

This example project includes:

- A simple Hardhat configuration file.
- Foundry-compatible Solidity unit tests.
- TypeScript integration tests using [`node:test`](nodejs.org/api/test.html), the new Node.js native test runner, and [`viem`](https://viem.sh/).
- Examples demonstrating how to connect to different types of networks, including locally simulating OP mainnet.

## Usage

### Running Tests

To run all the tests in the project, execute the following command:

```shell
npx hardhat test
```

You can also selectively run the Solidity or `node:test` tests:

```shell
npx hardhat test solidity
npx hardhat test nodejs
```

### Deploying AddressRegistry

Use the provided TypeScript deployment script to deploy the registry contract. The script expects Hardhat network credentials to be configured (see `.env.ref` for examples).

Deploy to the default Hardhat network:

```shell
npx hardhat run scripts/deploy.ts
```

Or target a configured network:

```shell
npx hardhat run --network <networkName> scripts/deploy.ts
```

Each deployment updates `deployments.json`, keyed by chain ID, which front ends and scripts can import to discover the latest contract addresses.

### Managing the registry on a network

Helper scripts under `scripts/actions/` wrap common admin flows. Invoke them via npm while providing parameters as environment variables (Hardhat 3 doesn't forward custom CLI flags to scripts).

For example, to add updater accounts:

```shell
HARDHAT_NETWORK=shape \
REGISTRY_ADDRESS=0xc776CD2071F558Abb2B328DF8251a6AA080264E2 \
REGISTRY_ACCOUNTS=0xF4884cE82eE55ECe5DB07044c374ecC86e7562D7 \
npm run registry:add-updaters
```

Available environment variables:

| Script | Required variables | Optional |
| --- | --- | --- |
| `registry:add-updaters` | `REGISTRY_ADDRESS`, `REGISTRY_ACCOUNTS` (comma-separated) | `REGISTRY_FROM` |
| `registry:remove-updaters` | `REGISTRY_ADDRESS`, `REGISTRY_ACCOUNTS` | `REGISTRY_FROM` |
| `registry:set-values` | `REGISTRY_ADDRESS`, `REGISTRY_ACCOUNTS`, `REGISTRY_VALUES` | `REGISTRY_FROM` |
| `registry:clear-values` | `REGISTRY_ADDRESS`, `REGISTRY_ACCOUNTS` | `REGISTRY_FROM` |
| `registry:update` | `REGISTRY_ADDRESS` | `REGISTRY_SET_ACCOUNTS`, `REGISTRY_SET_VALUES`, `REGISTRY_CLEAR_ACCOUNTS`, `REGISTRY_FROM` |
| `registry:transfer-owner` | `REGISTRY_ADDRESS`, `REGISTRY_NEW_OWNER` | `REGISTRY_FROM` |
| `registry:list-updaters` | `REGISTRY_ADDRESS` | `REGISTRY_FROM` |
| `registry:get-values` | `REGISTRY_ADDRESS`, `REGISTRY_ACCOUNTS` | `REGISTRY_FROM` |

`REGISTRY_FROM` lets you select a specific configured account; otherwise the first wallet client is used.
