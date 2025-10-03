import {
  connectViem,
  getRegistryContract,
  requireOption,
  resolveOption,
  resolveWallet,
  logSuccess,
} from "../utils/registry.js";

const registryAddress = requireOption("--registry", ["REGISTRY", "REGISTRY_ADDRESS"]);
const newOwner = requireOption("--new-owner", ["NEW_OWNER", "REGISTRY_NEW_OWNER"]);
const from = resolveOption("--from", ["FROM", "REGISTRY_FROM"]);

const { viem } = await connectViem();
const wallet = await resolveWallet(viem, from);
const registry = await getRegistryContract(viem, registryAddress, wallet);

await registry.write.transferOwnership([newOwner]);
logSuccess("Transferred ownership", {
  registry: registryAddress,
  newOwner,
});
