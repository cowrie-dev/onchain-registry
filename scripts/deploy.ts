import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { network } from "hardhat";
import { type Address, getAddress, getContractAddress } from "viem";
import { encodeResolverInitialization } from "./utils/createx.js";
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
  const proxyAdminOwner = getAddress(requireOption('--proxy-admin-owner', ['PROXY_ADMIN_OWNER']));

  console.log(`Upgrade authority: ${proxyAdminOwner}`);
  console.log(`Deploying SanctionsResolverV2`);
  console.log(`  network        : ${networkName} (chainId ${chainId})`);
  console.log(`  deployer       : ${deployer}`);
  console.log(`  EAS            : ${easAddress}`);
  console.log(`  initial owner  : ${initialOwner}`);
  console.log(`  initial attester: ${initialAttesterArg}`);

  const implementation = await viem.deployContract(
    "SanctionsResolverV2",
    [easAddress],
    { client: { wallet: walletClient } },
  );

  const resolver = await viem.deployContract('TransparentUpgradeableProxy',
    [implementation.address, proxyAdminOwner, encodeResolverInitialization(initialOwner, getAddress(initialAttesterArg))],
    { client: { wallet: walletClient } });
  console.log(`Implementation deployed to: ${implementation.address}`);
  console.log(`SanctionsResolverV2 deployed to: ${resolver.address}`);

  await recordDeployment({
    networkName,
    chainId,
    address: resolver.address,
    implementation: implementation.address,
    proxyAdmin: getContractAddress({ from: resolver.address, nonce: 1n }),
    deployer,
    owner: initialOwner,
    proxyAdminOwner,
    initialAttester: initialAttesterArg,
    easAddress,
  });
}

type DeploymentMetadata = {
  networkName: string;
  chainId: number;
  address: string;
  implementation: string;
  proxyAdmin: string;
  deployer: string;
  owner: string;
  proxyAdminOwner: string;
  initialAttester: string;
  easAddress: string;
};

type DeploymentRecord = {
  chainName: string;
  address: string;
  implementation: string;
  proxyAdmin: string;
  deployer: string;
  owner: string;
  proxyAdminOwner: string;
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
  chainManifest.SanctionsResolverV2 = {
    chainName: metadata.networkName,
    address: metadata.address,
    implementation: metadata.implementation,
    proxyAdmin: metadata.proxyAdmin,
    deployer: metadata.deployer,
    owner: metadata.owner,
    proxyAdminOwner: metadata.proxyAdminOwner,
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
