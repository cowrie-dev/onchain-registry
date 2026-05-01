import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { network } from "hardhat";
import type { ContractReturnType, WalletClient } from "@nomicfoundation/hardhat-viem/types";
import { type Address, getAddress } from "viem";

type NetworkConnection = Awaited<ReturnType<typeof network.connect>>;
type ViemHelpers = NetworkConnection["viem"];

type WalletClients = Awaited<ReturnType<ViemHelpers["getWalletClients"]>>;

export type DeploymentRecord = {
  chainName: string;
  address: string;
  deployer: string;
  owner: string;
  initialAttester: string;
  easAddress: string;
  schemaUID?: string;
  deployedAt: string;
};

export type DeploymentManifest = Record<string, Record<string, DeploymentRecord>>;

export async function connectViem(): Promise<{
  viem: ViemHelpers;
  chainId: number;
  networkName: string;
}> {
  const connection = await network.connect();
  const chainId = connection.networkConfig.chainId;
  if (chainId === undefined) {
    throw new Error(`Network ${connection.networkName} does not define chainId in hardhat.config.ts.`);
  }
  return { viem: connection.viem, chainId, networkName: connection.networkName };
}

export async function resolveWallet(
  viem: ViemHelpers,
  requester?: string,
): Promise<WalletClient> {
  const wallets: WalletClients = await viem.getWalletClients();
  if (wallets.length === 0) {
    throw new Error("No wallet clients available.  Configure accounts for this network.");
  }
  if (!requester) {
    return wallets[0];
  }
  const normalized = requester.toLowerCase();
  const found = wallets.find((wallet) => wallet.account.address.toLowerCase() === normalized);
  if (!found) {
    throw new Error(`Wallet for address ${requester} not configured on this network.`);
  }
  return found;
}

export async function getResolverContract(
  viem: ViemHelpers,
  address: string,
  wallet: WalletClient,
): Promise<ContractReturnType<"SanctionsResolver">> {
  if (!address) {
    throw new Error("Resolver address is required.");
  }
  return viem.getContractAt("SanctionsResolver", getAddress(address), { client: { wallet } });
}

export async function getEASContract(
  viem: ViemHelpers,
  address: string,
  wallet: WalletClient,
): Promise<ContractReturnType<"EAS">> {
  return viem.getContractAt("EAS", getAddress(address), { client: { wallet } });
}

export async function getSchemaRegistryContract(
  viem: ViemHelpers,
  address: string,
  wallet: WalletClient,
): Promise<ContractReturnType<"SchemaRegistry">> {
  return viem.getContractAt("SchemaRegistry", getAddress(address), { client: { wallet } });
}

export async function loadDeployments(): Promise<DeploymentManifest> {
  const filePath = resolve(process.cwd(), "deployments.json");
  try {
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text) as DeploymentManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function loadResolverDeployment(chainId: number): Promise<DeploymentRecord> {
  const manifest = await loadDeployments();
  const record = manifest[String(chainId)]?.SanctionsResolver;
  if (!record) {
    throw new Error(
      `No SanctionsResolver deployment recorded for chainId ${chainId} in deployments.json.`,
    );
  }
  return record;
}

export function parseAddressList(value: string | undefined, field: string): Address[] {
  if (!value) {
    throw new Error(`${field} is required`);
  }
  const items = value
    .split(",")
    .map((entry) => getAddress(entry.trim()))
    .filter(Boolean);
  if (items.length === 0) {
    throw new Error(`${field} must include at least one address`);
  }
  return items;
}

export function resolveOption(flag: string, envKeys: string[] = []): string | undefined {
  const separateIndex = process.argv.indexOf(flag);
  if (separateIndex !== -1 && separateIndex + 1 < process.argv.length) {
    const value = process.argv[separateIndex + 1];
    if (!value.startsWith("--")) {
      return value;
    }
  }
  const withEquals = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (withEquals) {
    const [, value = ""] = withEquals.split(/=(.+)/, 2);
    if (value) {
      return value;
    }
  }
  const normalized = flag.replace(/^--/, "").replace(/-/g, "_");
  const defaultCandidates = [normalized.toUpperCase(), normalized];
  const candidates = [...envKeys, ...defaultCandidates];
  for (const key of candidates) {
    const value = process.env[key];
    if (value) return value;
  }
  return undefined;
}

export function requireOption(flag: string, envKeys: string[] = []): string {
  const value = resolveOption(flag, envKeys);
  if (!value) {
    const envHint = envKeys.length > 0 ? ` or environment variable(s) ${envKeys.join(", ")}` : "";
    throw new Error(`Missing required option ${flag}${envHint}`);
  }
  return value;
}

export function logSuccess(message: string, metadata: Record<string, unknown> = {}): void {
  const entries = Object.entries(metadata)
    .map(([key, val]) => `${key}=${String(val)}`)
    .join(" ");
  console.log(entries ? `${message} (${entries})` : message);
}
