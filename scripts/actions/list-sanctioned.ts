import {
  connectViem,
  getResolverContract,
  loadResolverDeployment,
  resolveOption,
  resolveWallet,
} from "../utils/resolver.js";

const fromArg = resolveOption("--from", ["FROM"]);

const { viem, chainId } = await connectViem();
const wallet = await resolveWallet(viem, fromArg);
const deployment = await loadResolverDeployment(chainId);
const resolver = await getResolverContract(viem, deployment.address, wallet);

const count = await resolver.read.sanctionedCount();
const addresses = await resolver.read.sanctionedAddresses();

console.log(
  JSON.stringify(
    {
      resolver: deployment.address,
      chainId,
      count: count.toString(),
      sanctioned: addresses,
    },
    null,
    2,
  ),
);
