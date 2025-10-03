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
const accountsArg = requireOption("--accounts", ["ACCOUNTS", "REGISTRY_ACCOUNTS"]);
const valuesArg = requireOption("--values", ["VALUES", "REGISTRY_VALUES"]);
const from = resolveOption("--from", ["FROM", "REGISTRY_FROM"]);

const accounts = parseAddressList(accountsArg, "--accounts");
const values = parseUint8List(valuesArg, "--values");

if (accounts.length !== values.length) {
  throw new Error("--accounts and --values must have the same length");
}

const { viem } = await connectViem();
const wallet = await resolveWallet(viem, from);
const registry = await getRegistryContract(viem, registryAddress, wallet);

await registry.write.setRegistryValues([accounts, values]);
logSuccess("Set registry values", { registry: registryAddress, count: accounts.length });
