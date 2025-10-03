# Address Registry Contract

This contract serves as the basis for an on-chain registry that maps Ethereum addresses to uint8 values (0-100 inclusive). This extends Ownable for boilerplate ownership methods and AccessControlEnumerable for role-based access control. Built with Hardhat 3, TypeScript, and Viem.

## Setup

This project uses [1Password CLI](https://developer.1password.com/docs/cli) for secure credential management. The `.env.ref` file contains references to 1Password secrets.

Required environment variables:

- `RPC_URL`: RPC endpoint URL
- `PRIVATE_KEY`: Deployer/admin private key

Use `op run --env-file=.env.ref --` to inject referenced credentials at runtime. The package scripts are set up to do this for you.

## Deployment

Deploy the AddressRegistry contract:

```shell
npm run deploy
```

The deployment script writes contract addresses to `deployments.json`, keyed by chain ID.

## Registry Management

Management scripts accept configuration via environment variables.

```shell
HARDHAT_NETWORK=shape \
REGISTRY_ADDRESS=0x... \
REGISTRY_ACCOUNTS=0xAddr1,0xAddr2 \
npm run registry:add-updaters
```

### Available Commands

**Access Control:**

- `registry:add-updaters` - Grant updater role to addresses
- `registry:remove-updaters` - Revoke updater role from addresses
- `registry:list-updaters` - List all updater addresses
- `registry:transfer-owner` - Transfer contract ownership

**Registry Operations:**

- `registry:set-values` - Set values for addresses (requires `REGISTRY_VALUES` as comma-separated uint8)
- `registry:clear-values` - Clear values for addresses
- `registry:update` - Set and clear values in a single transaction
- `registry:get-values` - Query values for addresses

### Environment Variables

| Variable                  | Description                                | Required               |
| ------------------------- | ------------------------------------------ | ---------------------- |
| `REGISTRY_ADDRESS`        | Contract address                           | All commands           |
| `REGISTRY_ACCOUNTS`       | Comma-separated addresses                  | Most commands          |
| `REGISTRY_VALUES`         | Comma-separated uint8 values (0-100)       | `set-values`, `update` |
| `REGISTRY_FROM`           | Signer address (defaults to first account) | Optional               |
| `REGISTRY_NEW_OWNER`      | New owner address                          | `transfer-owner`       |
| `REGISTRY_SET_ACCOUNTS`   | Addresses to set                           | `update`               |
| `REGISTRY_SET_VALUES`     | Values to set                              | `update`               |
| `REGISTRY_CLEAR_ACCOUNTS` | Addresses to clear                         | `update`               |

## Testing

Run the test suite:

```shell
npm test
```
