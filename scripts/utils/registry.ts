import { network } from "hardhat";
import type { WalletClient, ContractReturnType } from "@nomicfoundation/hardhat-viem/types";
import { Address, getAddress } from "viem";

type NetworkConnection = Awaited<ReturnType<typeof network.connect>>;
type ViemHelpers = NetworkConnection["viem"];

type WalletClients = Awaited<ReturnType<ViemHelpers["getWalletClients"]>>;

export async function connectViem(): Promise<{ viem: ViemHelpers }> {
  const connection = await network.connect();
  return { viem: connection.viem };
}

export async function resolveWallet(
  viem: ViemHelpers,
  requester?: string,
): Promise<WalletClient> {
  const wallets: WalletClients = await viem.getWalletClients();
  if (wallets.length === 0) {
    throw new Error("No wallet clients available. Configure accounts for this network.");
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

export async function getRegistryContract(
  viem: ViemHelpers,
  registryAddress: string,
  wallet: WalletClient,
): Promise<ContractReturnType<"AddressRegistry">> {
  if (!registryAddress) {
    throw new Error("Registry address is required.");
  }
  return viem.getContractAt("AddressRegistry", getAddress(registryAddress), {
    client: { wallet },
  });
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

export function parseUint8List(value: string | undefined, field: string): number[] {
  if (!value) {
    throw new Error(`${field} is required`);
  }
  const items = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parsed = Number(entry);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
        throw new Error(`${field} must contain integers between 0 and 100 inclusive`);
      }
      return parsed;
    });
  if (items.length === 0) {
    throw new Error(`${field} must include at least one value`);
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
    if (value) {
      return value;
    }
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
  if (entries) {
    console.log(`${message} (${entries})`);
  } else {
    console.log(message);
  }
}
