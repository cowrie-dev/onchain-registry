import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { encodeFunctionData, type Address } from "viem";

import { getEASAddresses, predictSchemaUID, SCHEMA_STRING } from "./utils/eas.js";
import {
  connectViem,
  getSchemaRegistryContract,
  loadResolverDeployment,
  resolveOption,
  resolveWallet,
} from "./utils/resolver.js";

const REVOCABLE = true;

const SCHEMA_REGISTRY_REGISTER_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [
      { name: "schema", type: "string" },
      { name: "resolver", type: "address" },
      { name: "revocable", type: "bool" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const printCalldata =
  process.argv.includes("--print-calldata") ||
  Boolean(process.env.PRINT_CALLDATA);

const fromArg = resolveOption("--from", ["FROM"]);
const registryOverride = resolveOption("--schema-registry", ["SCHEMA_REGISTRY"]);

const { viem, chainId, networkName } = await connectViem();

const deployment = await loadResolverDeployment(chainId);
const schemaRegistryAddress = registryOverride ?? getEASAddresses(chainId).schemaRegistry;
const registry = await getSchemaRegistryContract(viem, schemaRegistryAddress);

const expectedUID = predictSchemaUID(deployment.address as `0x${string}`, REVOCABLE);

const header = printCalldata
  ? "Schema registration calldata (no broadcast)"
  : "Registering schema";
console.log(header);
console.log(`  network     : ${networkName} (chainId ${chainId})`);
console.log(`  schema      : ${SCHEMA_STRING}`);
console.log(`  registry    : ${schemaRegistryAddress}`);
console.log(`  resolver    : ${deployment.address}`);
console.log(`  revocable   : ${REVOCABLE}`);
console.log(`  expected UID: ${expectedUID}`);

const existing = (await registry.read.getSchema([expectedUID])) as { uid: `0x${string}` };
const alreadyRegistered = existing.uid.toLowerCase() === expectedUID.toLowerCase();

if (alreadyRegistered) {
  console.log(`Schema already registered.  Skipping submit, recording UID.`);
  await persistSchemaUID(chainId, expectedUID);
  console.log(`Recorded schemaUID in deployments.json.`);
} else if (printCalldata) {
  const data = encodeFunctionData({
    abi: SCHEMA_REGISTRY_REGISTER_ABI,
    functionName: "register",
    args: [SCHEMA_STRING, deployment.address as Address, REVOCABLE],
  });
  const outDir = resolve(process.cwd(), "calldata");
  await mkdir(outDir, { recursive: true });
  const outPath = resolve(outDir, `${networkName}-${chainId}-schema.hex`);
  await writeFile(outPath, `${data}\n`, "utf8");
  console.log("");
  console.log(`to              : ${schemaRegistryAddress}`);
  console.log(`value           : 0`);
  console.log(`calldata bytes  : ${(data.length - 2) / 2}`);
  console.log(`calldata file   : ${outPath}`);
  console.log("");
  console.log(`After broadcast, re-run register-schema (with or without PRINT_CALLDATA)`);
  console.log(`to detect the on-chain schema and record schemaUID in deployments.json.`);
} else {
  const wallet = await resolveWallet(viem, fromArg);
  const writableRegistry = await getSchemaRegistryContract(viem, schemaRegistryAddress, wallet);
  const txHash = await writableRegistry.write.register([
    SCHEMA_STRING,
    deployment.address as `0x${string}`,
    REVOCABLE,
  ]);
  console.log(`  register tx: ${txHash}`);
  const publicClient = await viem.getPublicClient();
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`Register tx ${txHash} reverted (status=${receipt.status}).`);
  }
  const stored = (await registry.read.getSchema([expectedUID])) as { uid: `0x${string}` };
  if (stored.uid.toLowerCase() !== expectedUID.toLowerCase()) {
    throw new Error(`Schema UID mismatch: expected ${expectedUID}, got ${stored.uid}`);
  }
  console.log(`Schema registered.`);
  await persistSchemaUID(chainId, expectedUID);
  console.log(`Recorded schemaUID in deployments.json.`);
}

async function persistSchemaUID(chain: number, uid: `0x${string}`): Promise<void> {
  const filePath = resolve(process.cwd(), "deployments.json");
  const text = await readFile(filePath, "utf8");
  const manifest = JSON.parse(text) as Record<string, Record<string, Record<string, unknown>>>;
  const chainKey = String(chain);
  if (!manifest[chainKey] || !manifest[chainKey].SanctionsResolver) {
    throw new Error(`No SanctionsResolver deployment for chainId ${chain}; deploy first.`);
  }
  manifest[chainKey].SanctionsResolver.schemaUID = uid;
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
