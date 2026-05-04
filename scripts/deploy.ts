import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { network } from "hardhat";
import { type Address, getAddress } from "viem";
import { getEASAddresses } from "./utils/eas.js";
import { requireOption, resolveOption } from "./utils/resolver.js";

async function main() {
  const connection = await network.connect();
  const { viem, networkName } = connection;
  const chainId = connection.networkConfig.chainId;
  if (chainId === undefined) {
    throw new Error(`Network ${networkName} does not define chainId in hardhat.config.ts.`);
  }

  const initialAttesterArg = requireOption("--initial-attester", [
    "INITIAL_ATTESTER",
    "RESOLVER_INITIAL_ATTESTER",
  ]);

  // Allow callers to override the EAS address (e.g. for testnets); otherwise look it up.
  const easOverride = resolveOption("--eas", ["EAS", "EAS_ADDRESS"]);
  const easAddress: Address = easOverride
    ? getAddress(easOverride)
    : getEASAddresses(chainId).eas;

  const [walletClient] = await viem.getWalletClients();
  if (!walletClient) {
    throw new Error("No wallet client available.  Configure accounts for this network.");
  }
  const deployer = walletClient.account.address;

  // initialOwner is optional: defaults to deployer for the common single-EOA case.
  // For Safe-as-owner deploys, pass --initial-owner=<safe>.
  const initialOwnerArg = resolveOption("--initial-owner", [
    "INITIAL_OWNER",
    "RESOLVER_INITIAL_OWNER",
  ]);
  const initialOwner: Address = initialOwnerArg ? getAddress(initialOwnerArg) : deployer;

  console.log(`Deploying SanctionsResolver`);
  console.log(`  network        : ${networkName} (chainId ${chainId})`);
  console.log(`  deployer       : ${deployer}`);
  console.log(`  EAS            : ${easAddress}`);
  console.log(`  initial owner  : ${initialOwner}`);
  console.log(`  initial attester: ${initialAttesterArg}`);

  const resolver = await viem.deployContract(
    "SanctionsResolver",
    [easAddress, initialOwner, getAddress(initialAttesterArg)],
    { client: { wallet: walletClient } },
  );

  console.log(`SanctionsResolver deployed to: ${resolver.address}`);

  await recordDeployment({
    networkName,
    chainId,
    address: resolver.address,
    deployer,
    owner: initialOwner,
    initialAttester: initialAttesterArg,
    easAddress,
  });
}

type DeploymentMetadata = {
  networkName: string;
  chainId: number;
  address: string;
  deployer: string;
  owner: string;
  initialAttester: string;
  easAddress: string;
};

type DeploymentRecord = {
  chainName: string;
  address: string;
  deployer: string;
  owner: string;
  initialAttester: string;
  easAddress: string;
  schemaUID?: string;
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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const chainKey = String(metadata.chainId);
  const chainManifest = manifest[chainKey] ?? {};
  chainManifest.SanctionsResolver = {
    chainName: metadata.networkName,
    address: metadata.address,
    deployer: metadata.deployer,
    owner: metadata.owner,
    initialAttester: metadata.initialAttester,
    easAddress: metadata.easAddress,
    deployedAt: new Date().toISOString(),
  };
  manifest[chainKey] = chainManifest;

  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Recorded deployment metadata at ${filePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
