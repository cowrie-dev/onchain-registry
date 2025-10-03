import {
  connectViem,
  getRegistryContract,
  parseAddressList,
  requireOption,
  resolveOption,
  resolveWallet,
  logSuccess,
} from "../utils/registry.js";

const registryAddress = requireOption("--registry", ["REGISTRY", "REGISTRY_ADDRESS"]);
const accountsArg = requireOption("--accounts", ["ACCOUNTS", "REGISTRY_ACCOUNTS"]);
const from = resolveOption("--from", ["FROM", "REGISTRY_FROM"]);

const accounts = parseAddressList(accountsArg, "--accounts");

const { viem } = await connectViem();
const wallet = await resolveWallet(viem, from);
const registry = await getRegistryContract(viem, registryAddress, wallet);

await registry.write.removeUpdaters([accounts]);
logSuccess("Removed updater accounts", { registry: registryAddress, removed: accounts.length });
