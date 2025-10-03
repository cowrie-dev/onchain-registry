import {
  connectViem,
  getRegistryContract,
  requireOption,
  resolveOption,
  resolveWallet,
} from "../utils/registry.js";

const registryAddress = requireOption("--registry", ["REGISTRY", "REGISTRY_ADDRESS"]);
const from = resolveOption("--from", ["FROM", "REGISTRY_FROM"]);

const { viem } = await connectViem();
const wallet = await resolveWallet(viem, from);
const registry = await getRegistryContract(viem, registryAddress, wallet);

const updaters = await registry.read.updaters();
console.log(JSON.stringify({ registry: registryAddress, updaters }, null, 2));
