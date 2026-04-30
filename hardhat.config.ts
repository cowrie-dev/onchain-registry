import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import { HardhatUserConfig, configVariable } from "hardhat/config";

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin, hardhatVerify],
  solidity: {
    profiles: {
      default: {
        compilers: [
          { version: "0.8.28" },
          { version: "0.8.27" },
        ],
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
      url: configVariable("RPC_URL"),
      accounts: [configVariable("PRIVATE_KEY")],
    },
    mainnet: {
      type: "http",
      chainType: "l1",
      url: configVariable("RPC_URL"),
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
      apiKey: "n/a",
      enabled: false,
    },
    blockscout: {
      enabled: true,
    },
  },
};

export default config;
