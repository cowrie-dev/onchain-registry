import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { network } from "hardhat";
import { type Address, type Hex, encodeFunctionData, getAddress, isHex } from "viem";

import { getEASAddresses } from "./utils/eas.js";
import {
  CREATEX_ADDRESS,
  CREATEX_DEPLOY_CREATE3_ABI,
  buildResolverInitCode,
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

  const initCode = await buildResolverInitCode({
    eas: easAddress,
    initialOwner,
    initialAttester,
  });

  const predicted = computeCreate3Address({ createx, sender: deployer, salt });

  // Cross-check the CREATE2 + nonce-1 half of our prediction against CreateX's
  // on-chain `pure` overload.  We compute the guardedSalt in TS (CreateX does
  // NOT expose `_guard` directly), then ask CreateX for the address it would
  // produce for that guardedSalt with itself as the CREATE2 deployer.  The
  // result must match our prediction; if it doesn't, the chain has a non-
  // canonical CreateX and we should not deploy.
  //
  // We deliberately use the 2-arg `pure` overload, NOT the 1-arg overload.
  // The 1-arg overload `computeCreate3Address(bytes32)` does NOT apply _guard
  // (it's the raw Solady-style prediction), so it would always disagree with
  // our TS helper for permissioned salts.
  const guardedSalt = computeGuardedSalt(deployer, salt);
  const onChainPrediction = (await publicClient.readContract({
    address: createx,
    abi: CREATEX_DEPLOY_CREATE3_ABI,
    functionName: "computeCreate3Address",
    args: [guardedSalt, createx],
  })) as Address;
  if (getAddress(onChainPrediction) !== predicted) {
    throw new Error(
      `Prediction mismatch: TS=${predicted} on-chain=${onChainPrediction}. ` +
        `Refusing to deploy.`,
    );
  }

  const existingCode = await publicClient.getCode({ address: predicted });
  if (existingCode && existingCode !== "0x") {
    throw new Error(
      `Address ${predicted} already has code on this chain. ` +
        `Either CREATE3 already happened with this salt or the address collides; refusing to redeploy.`,
    );
  }

  const header = printCalldata
    ? "CREATE3 calldata for SanctionsResolver (no broadcast)"
    : "Deploying SanctionsResolver via CREATE3";
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

  if (printCalldata) {
    const data = encodeFunctionData({
      abi: CREATEX_DEPLOY_CREATE3_ABI,
      functionName: "deployCreate3",
      args: [salt, initCode],
    });
    const outDir = resolve(process.cwd(), "calldata");
    await mkdir(outDir, { recursive: true });
    const outPath = resolve(outDir, `${networkName}-${chainId}.hex`);
    await writeFile(outPath, `${data}\n`, "utf8");
    console.log(`to              : ${createx}`);
    console.log(`value           : 0`);
    console.log(`calldata bytes  : ${(data.length - 2) / 2}`);
    console.log(`calldata file   : ${outPath}`);
    return;
  }

  if (!walletClient) {
    throw new Error("internal: walletClient missing in broadcast mode");
  }
  const txHash = await walletClient.writeContract({
    address: createx,
    abi: CREATEX_DEPLOY_CREATE3_ABI,
    functionName: "deployCreate3",
    args: [salt, initCode],
  });
  console.log(`tx: ${txHash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`Deploy tx reverted: ${txHash}`);
  }

  const codeAfter = await publicClient.getCode({ address: predicted });
  if (!codeAfter || codeAfter === "0x") {
    throw new Error(
      `Tx succeeded but no code at predicted address ${predicted}. ` +
        `Inspect tx ${txHash} on a block explorer.`,
    );
  }

  console.log(`SanctionsResolver deployed to: ${predicted}`);

  await recordDeployment({
    networkName,
    chainId,
    address: predicted,
    deployer,
    owner: initialOwner,
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
  deployer: Address;
  owner: Address;
  initialAttester: Address;
  easAddress: Address;
  salt: Hex;
  createxAddress: Address;
};

type DeploymentRecord = {
  chainName: string;
  address: string;
  deployer: string;
  owner: string;
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
  chainManifest.SanctionsResolver = {
    chainName: metadata.networkName,
    address: metadata.address,
    deployer: metadata.deployer,
    owner: metadata.owner,
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
