import { network } from "hardhat";

async function main() {
  const connection = await network.connect();
  const { viem } = connection;

  const [walletClient] = await viem.getWalletClients();
  if (!walletClient) {
    throw new Error("No wallet client available. Configure accounts for this network.");
  }

  const deployer = walletClient.account.address;
  console.log("Deploying with:", deployer);

  const registry = await viem.deployContract(
    "AddressRegistry",
    [deployer, deployer, [], []],
    { client: { wallet: walletClient } },
  );

  console.log("AddressRegistry deployed to:", registry.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
