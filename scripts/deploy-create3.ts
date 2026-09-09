import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { network } from "hardhat";
import { type Address, type Hex, encodeFunctionData, getAddress, isHex } from "viem";

import { getEASAddresses } from "./utils/eas.js";
import {
  CREATEX_ADDRESS,
  CREATEX_DEPLOY_CREATE3_ABI,
  buildProxyDeployment,
  computeCreate3Address,
  computeGuardedSalt,
} from "./utils/createx.js";
import { requireOption, resolveOption } from "./utils/resolver.js";

async function main() {
  const connection = await network.connect();
  const { viem, networkName } = connection;
  const chainId = connection.networkConfig.chainId;
  if (chainId === undefined) {
    throw new Error(`Network ${networkName} does not define chainId in hardhat.config.ts.`);
  }

  // Print-calldata mode: produce the bytes for a custody wallet to broadcast,
  // without signing or broadcasting locally.  No wallet/key required; the
  // deployer is derived from the salt's permissioned-sender prefix.  Accept
  // both the bare CLI flag (--print-calldata with no value) and the env var
  // (handy for shell loops over networks).
  const printCalldata =
    process.argv.includes("--print-calldata") ||
    Boolean(process.env.PRINT_CALLDATA);

  const saltArg = requireOption("--salt", ["SALT"]);
  if (!isHex(saltArg) || saltArg.length !== 66) {
    throw new Error(`--salt must be 0x-prefixed 32-byte hex (66 chars), got '${saltArg}'`);
  }
  const salt = saltArg as Hex;

  const initialAttesterArg = requireOption("--initial-attester", [
    "INITIAL_ATTESTER",
    "RESOLVER_INITIAL_ATTESTER",
  ]);

  const easOverride = resolveOption("--eas", ["EAS", "EAS_ADDRESS"]);
  const easAddress: Address = easOverride
    ? getAddress(easOverride)
    : getEASAddresses(chainId).eas;

  // In print-calldata mode the deployer comes from the salt itself (CreateX
  // requires bytes[0..20) of a permissioned salt to equal msg.sender).  In
  // broadcast mode it comes from the configured wallet.
  let deployer: Address;
  let walletClient: Awaited<ReturnType<typeof viem.getWalletClients>>[number] | undefined;
  if (printCalldata) {
    deployer = getAddress(`0x${salt.slice(2, 42)}`);
  } else {
    [walletClient] = await viem.getWalletClients();
    if (!walletClient) {
      throw new Error("No wallet client available.  Configure accounts for this network.");
    }
    deployer = walletClient.account.address;
  }

  const initialOwnerArg = resolveOption("--initial-owner", [
    "INITIAL_OWNER",
    "RESOLVER_INITIAL_OWNER",
  ]);
  const initialOwner: Address = initialOwnerArg ? getAddress(initialOwnerArg) : deployer;
  const proxyAdminOwner = getAddress(requireOption('--proxy-admin-owner', ['PROXY_ADMIN_OWNER']));
  const initialAttester: Address = getAddress(initialAttesterArg);

  const createxOverride = resolveOption("--createx", ["CREATEX"]);
  const createx: Address = createxOverride ? getAddress(createxOverride) : CREATEX_ADDRESS;

  // Validate the salt's permissioned format: bytes[0..20) must equal deployer,
  // bytes[20] must be 0x00 (no cross-chain protection; otherwise the address
  // would differ per chain).  Mirrors createxcrunch's permissioned-sender
  // (no-crosschain) salt layout.
  const saltSenderHex = salt.slice(2, 42).toLowerCase();
  const expectedSenderHex = deployer.slice(2).toLowerCase();
  if (saltSenderHex !== expectedSenderHex) {
    throw new Error(
      `--salt is permissioned for 0x${saltSenderHex} but the wallet is ${deployer}. ` +
        `Re-mine with --account=${deployer}.`,
    );
  }
  if (salt.slice(42, 44).toLowerCase() !== "00") {
    throw new Error(
      `--salt byte 20 must be 0x00 (no cross-chain protection). ` +
        `Re-mine with the production miner so the resulting address is identical on every chain.`,
    );
  }

  const publicClient = await viem.getPublicClient();
  const createxCode = await publicClient.getCode({ address: createx });
  if (!createxCode || createxCode === "0x") {
    throw new Error(
      `No code at CreateX (${createx}) on this chain. ` +
        `Deploy CreateX first or pick a chain that already has it.`,
    );
  }

  const deployment = await buildProxyDeployment({
    createx, sender: deployer, salt, proxyAdminOwner,
    eas: easAddress,
    initialOwner,
    initialAttester,
  });

  const predicted = computeCreate3Address({ createx, sender: deployer, salt });

  const transactions = [
    { purpose: 'Deploy SanctionsResolverV2 implementation', salt: deployment.implementationSalt,
      address: deployment.implementation, initCode: deployment.implementationInitCode },
    { purpose: 'Deploy and initialize TransparentUpgradeableProxy', salt, address: predicted, initCode: deployment.proxyInitCode },
  ];
  for (const transaction of transactions) {
    const onChainPrediction = await publicClient.readContract({ address: createx,
      abi: CREATEX_DEPLOY_CREATE3_ABI, functionName: 'computeCreate3Address',
      args: [computeGuardedSalt(deployer, transaction.salt), createx] });
    if (getAddress(onChainPrediction) !== transaction.address) throw new Error('CreateX prediction mismatch');
    const existingCode = await publicClient.getCode({ address: transaction.address });
    if (existingCode && existingCode !== '0x') {
      throw new Error(`Address ${transaction.address} already has code; inspect any partial deployment before continuing.`);
    }
  }

  const header = printCalldata
    ? "CREATE3 calldata for SanctionsResolverV2 (no broadcast)"
    : "Deploying SanctionsResolverV2 via CREATE3";
  console.log(header);
  console.log(`  network         : ${networkName} (chainId ${chainId})`);
  console.log(`  deployer (from) : ${deployer}`);
  console.log(`  CreateX (to)    : ${createx}`);
  console.log(`  EAS             : ${easAddress}`);
  console.log(`  initial owner   : ${initialOwner}`);
  console.log(`  initial attester: ${initialAttester}`);
  console.log(`  salt            : ${salt}`);
  console.log(`  predicted addr  : ${predicted}`);
  console.log("");

  console.log(`  upgrade authority: ${proxyAdminOwner}`);
  console.log(`  implementation : ${deployment.implementation}`);
  if (printCalldata) {
    const outDir = resolve(process.cwd(), 'calldata');
    await mkdir(outDir, { recursive: true });
    const outPath = resolve(outDir, `${networkName}-${chainId}.json`);
    const prepared = transactions.map(tx => ({ purpose: tx.purpose, from: deployer, to: createx, value: '0',
      data: encodeFunctionData({ abi: CREATEX_DEPLOY_CREATE3_ABI, functionName: 'deployCreate3', args: [tx.salt, tx.initCode] }) }));
    await writeFile(outPath, JSON.stringify({ address: predicted, implementation: deployment.implementation, proxyAdmin: deployment.proxyAdmin, proxyAdminOwner, transactions: prepared }, null, 2) + '\n');
    console.log(`Ordered deployment transactions: ${outPath}`);
    return;
  }

  if (!walletClient) throw new Error('Wallet client missing in broadcast mode');
  const hashes: Hex[] = [];
  for (const transaction of transactions) {
    const hash = await walletClient.writeContract({ address: createx, abi: CREATEX_DEPLOY_CREATE3_ABI,
      functionName: 'deployCreate3', args: [transaction.salt, transaction.initCode] });
    console.log(`${transaction.purpose}: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`Deployment reverted: ${hash}`);
    const code = await publicClient.getCode({ address: transaction.address });
    if (!code || code === '0x') throw new Error(`No code at ${transaction.address} after ${hash}`);
    hashes.push(hash);
  }
  console.log(`SanctionsResolverV2 proxy deployed to: ${predicted}`);

  await recordDeployment({
    networkName,
    chainId,
    address: predicted,
    implementation: deployment.implementation,
    proxyAdmin: deployment.proxyAdmin,
    implementationCreationTxHash: hashes[0],
    creationTxHash: hashes[1],
    deployer,
    owner: initialOwner,
    proxyAdminOwner,
    initialAttester,
    easAddress,
    salt,
    createxAddress: createx,
  });
}

type DeploymentMetadata = {
  networkName: string;
  chainId: number;
  address: Address;
  implementation: Address;
  proxyAdmin: Address;
  implementationCreationTxHash: Hex;
  creationTxHash: Hex;
  deployer: Address;
  owner: Address;
  proxyAdminOwner: Address;
  initialAttester: Address;
  easAddress: Address;
  salt: Hex;
  createxAddress: Address;
};

type DeploymentRecord = {
  chainName: string;
  address: string;
  implementation: string;
  proxyAdmin: string;
  implementationCreationTxHash: string;
  creationTxHash: string;
  deployer: string;
  owner: string;
  proxyAdminOwner: string;
  initialAttester: string;
  easAddress: string;
  salt?: string;
  createxAddress?: string;
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
    implementationCreationTxHash: metadata.implementationCreationTxHash,
    creationTxHash: metadata.creationTxHash,
    deployer: metadata.deployer,
    owner: metadata.owner,
    proxyAdminOwner: metadata.proxyAdminOwner,
    initialAttester: metadata.initialAttester,
    easAddress: metadata.easAddress,
    salt: metadata.salt,
    createxAddress: metadata.createxAddress,
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
