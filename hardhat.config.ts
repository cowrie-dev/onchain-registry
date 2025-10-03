import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import { HardhatUserConfig, configVariable } from "hardhat/config";

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin, hardhatVerify],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    shape: {
      type: "http",
      chainType: "op",
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
