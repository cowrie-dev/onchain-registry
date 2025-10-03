import {
  connectViem,
  getRegistryContract,
  parseAddressList,
  requireOption,
  resolveOption,
  resolveWallet,
} from "../utils/registry.js";

const registryAddress = requireOption("--registry", ["REGISTRY", "REGISTRY_ADDRESS"]);
const accountsArg = requireOption("--accounts", ["ACCOUNTS", "REGISTRY_ACCOUNTS"]);
const from = resolveOption("--from", ["FROM", "REGISTRY_FROM"]);

const accounts = parseAddressList(accountsArg, "--accounts");

const { viem } = await connectViem();
const wallet = await resolveWallet(viem, from);
const registry = await getRegistryContract(viem, registryAddress, wallet);

const values = await Promise.all(accounts.map((account) => registry.read.registryValues([account])));
const result = accounts.map((account, index) => ({ account, value: Number(values[index]) }));

console.log(JSON.stringify({ registry: registryAddress, entries: result }, null, 2));
