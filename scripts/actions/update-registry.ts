import {
  connectViem,
  getRegistryContract,
  parseAddressList,
  parseUint8List,
  requireOption,
  resolveOption,
  resolveWallet,
  logSuccess,
} from "../utils/registry.js";

const registryAddress = requireOption("--registry", ["REGISTRY", "REGISTRY_ADDRESS"]);
const setAccountsArg = resolveOption("--set-accounts", ["SET_ACCOUNTS", "REGISTRY_SET_ACCOUNTS"]);
const setValuesArg = resolveOption("--set-values", ["SET_VALUES", "REGISTRY_SET_VALUES"]);
const clearAccountsArg = resolveOption("--clear-accounts", ["CLEAR_ACCOUNTS", "REGISTRY_CLEAR_ACCOUNTS"]);
const from = resolveOption("--from", ["FROM", "REGISTRY_FROM"]);

const accountsToSet = setAccountsArg ? parseAddressList(setAccountsArg, "--set-accounts") : [];
const valuesToSet = setValuesArg ? parseUint8List(setValuesArg, "--set-values") : [];

if (accountsToSet.length !== valuesToSet.length) {
  throw new Error("--set-accounts and --set-values must have the same length");
}

const accountsToClear = clearAccountsArg ? parseAddressList(clearAccountsArg, "--clear-accounts") : [];

const { viem } = await connectViem();
const wallet = await resolveWallet(viem, from);
const registry = await getRegistryContract(viem, registryAddress, wallet);

await registry.write.updateRegistry([accountsToSet, valuesToSet, accountsToClear]);
logSuccess("Updated registry", {
  registry: registryAddress,
  setCount: accountsToSet.length,
  clearedCount: accountsToClear.length,
});
