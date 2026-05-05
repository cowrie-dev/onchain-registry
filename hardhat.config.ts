import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import { HardhatUserConfig, configVariable } from "hardhat/config";

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin, hardhatVerify],
  solidity: {
    profiles: {
      default: {
        compilers: [{ version: "0.8.28" }, { version: "0.8.27" }],
      },
      production: {
        compilers: [
          {
            version: "0.8.28",
            settings: { optimizer: { enabled: true, runs: 200 } },
          },
          {
            version: "0.8.27",
            settings: { optimizer: { enabled: true, runs: 200 } },
          },
        ],
      },
    },
  },
  networks: {
    // The built-in "default" edr-simulated network used by `npm test`.
    // EAS exceeds the Spurious Dragon 24 KB contract size limit; allow it for tests.
    default: {
      type: "edr-simulated",
      allowUnlimitedContractSize: true,
    },
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
      allowUnlimitedContractSize: true,
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
      allowUnlimitedContractSize: true,
    },
    shape: {
      type: "http",
      chainType: "op",
      url: `https://shape-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY ?? ""}`,
      chainId: 360,
      accounts: [configVariable("PRIVATE_KEY")],
    },
    mainnet: {
      type: "http",
      chainType: "l1",
      url: `https://blockchain.googleapis.com/v1/projects/evm-queries/locations/us-central1/endpoints/ethereum-mainnet/rpc?key=${process.env.GCP_API_KEY ?? ""}`,
      chainId: 1,
      accounts: [configVariable("PRIVATE_KEY")],
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: `https://blockchain.googleapis.com/v1/projects/evm-queries/locations/us-central1/endpoints/ethereum-sepolia/rpc?key=${process.env.GCP_API_KEY ?? ""}`,
      chainId: 11155111,
      accounts: [configVariable("PRIVATE_KEY")],
    },
  },
  chainDescriptors: {
    // Example chain
    360: {
      name: "Shape",
      blockExplorers: {
        blockscout: {
          name: "ShapeScan",
          url: "https://shapescan.xyz",
          apiUrl: "https://shapescan.xyz/api",
        },
        // other explorers...
      },
    },
  },
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
      enabled: true,
    },
    blockscout: {
      enabled: true,
    },
    // No `sourcify` entry: hardhat-verify@3.0.2 ships a stub Sourcify task
    // (action body is just a "not supported yet" warning), so toggling it
    // here does nothing.  Sourcify itself works fine; submit via
    // sourcify.dev/#/verifier or its `/server/verify` API directly until the
    // plugin lands a real implementation.
  },
};

export default config;
