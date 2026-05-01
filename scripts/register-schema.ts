import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { getEASAddresses, predictSchemaUID, SCHEMA_STRING } from "./utils/eas.js";
import {
  connectViem,
  getSchemaRegistryContract,
  loadResolverDeployment,
  resolveOption,
  resolveWallet,
} from "./utils/resolver.js";

const REVOCABLE = true;

const fromArg = resolveOption("--from", ["FROM"]);
const registryOverride = resolveOption("--schema-registry", ["SCHEMA_REGISTRY"]);

const { viem, chainId } = await connectViem();
const wallet = await resolveWallet(viem, fromArg);

const deployment = await loadResolverDeployment(chainId);
const schemaRegistryAddress = registryOverride ?? getEASAddresses(chainId).schemaRegistry;
const registry = await getSchemaRegistryContract(viem, schemaRegistryAddress, wallet);

const expectedUID = predictSchemaUID(deployment.address as `0x${string}`, REVOCABLE);
console.log(`Registering schema`);
console.log(`  schema    : ${SCHEMA_STRING}`);
console.log(`  resolver  : ${deployment.address}`);
console.log(`  revocable : ${REVOCABLE}`);
console.log(`  expected UID: ${expectedUID}`);

const existing = (await registry.read.getSchema([expectedUID])) as { uid: `0x${string}` };
if (existing.uid.toLowerCase() === expectedUID.toLowerCase()) {
  console.log(`Schema already registered.  Skipping submit, recording UID.`);
} else {
  await registry.write.register([SCHEMA_STRING, deployment.address as `0x${string}`, REVOCABLE]);
  const stored = (await registry.read.getSchema([expectedUID])) as { uid: `0x${string}` };
  if (stored.uid.toLowerCase() !== expectedUID.toLowerCase()) {
    throw new Error(`Schema UID mismatch: expected ${expectedUID}, got ${stored.uid}`);
  }
  console.log(`Schema registered.`);
}

await persistSchemaUID(chainId, expectedUID);
console.log(`Recorded schemaUID in deployments.json.`);

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
