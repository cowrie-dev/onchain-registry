import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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

  await recordDeployment({
    networkName: connection.networkName,
    chainId: connection.id,
    contractName: "AddressRegistry",
    address: registry.address,
    deployer,
    owner: deployer,
    updater: deployer,
  });
}

type DeploymentMetadata = {
  networkName: string;
  chainId: number;
  contractName: string;
  address: string;
  deployer: string;
  owner: string;
  updater: string;
};

type DeploymentRecord = {
  chainName: string;
  address: string;
  deployer: string;
  owner: string;
  updater: string;
  deployedAt: string;
};

type DeploymentManifest = Record<string, Record<string, DeploymentRecord>>;

async function recordDeployment(metadata: DeploymentMetadata): Promise<void> {
  const filePath = resolve(process.cwd(), "deployments.json");

  let manifest: DeploymentManifest = {};
  try {
    const current = await readFile(filePath, "utf8");
    manifest = JSON.parse(current) as DeploymentManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const chainKey = String(metadata.chainId);
  const existingEntry = manifest[chainKey] as Record<string, unknown> | undefined;
  let chainManifest: Record<string, DeploymentRecord> = {};
  if (existingEntry) {
    const values = Object.values(existingEntry);
    const looksStructured =
      values.length > 0 &&
      values.every((value) =>
        typeof value === "object" && value !== null && "address" in (value as Record<string, unknown>),
      );

    if (looksStructured) {
      chainManifest = existingEntry as Record<string, DeploymentRecord>;
    } else if ("address" in existingEntry) {
      chainManifest = {
        [metadata.contractName]: existingEntry as unknown as DeploymentRecord,
      };
    }
  }

  chainManifest[metadata.contractName] = {
    chainName: metadata.networkName,
    address: metadata.address,
    deployer: metadata.deployer,
    owner: metadata.owner,
    updater: metadata.updater,
    deployedAt: new Date().toISOString(),
  } satisfies DeploymentRecord;

  manifest[chainKey] = chainManifest;

  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Recorded deployment metadata at ${filePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
