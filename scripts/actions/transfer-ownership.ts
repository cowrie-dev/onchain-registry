import {
  connectViem,
  getResolverContract,
  loadResolverDeployment,
  logSuccess,
  requireOption,
  resolveOption,
  resolveWallet,
} from "../utils/resolver.js";

const newOwner = requireOption("--new-owner", ["NEW_OWNER", "RESOLVER_NEW_OWNER"]);
const fromArg = resolveOption("--from", ["FROM"]);

const { viem, chainId } = await connectViem();
const wallet = await resolveWallet(viem, fromArg);
const deployment = await loadResolverDeployment(chainId);
const resolver = await getResolverContract(viem, deployment.address, wallet);

await resolver.write.transferOwnership([newOwner as `0x${string}`]);
logSuccess("Transferred ownership", { resolver: deployment.address, newOwner });
