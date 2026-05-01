import {
  connectViem,
  getResolverContract,
  loadResolverDeployment,
  logSuccess,
  parseAddressList,
  requireOption,
  resolveOption,
  resolveWallet,
} from "../utils/resolver.js";

const accountsArg = requireOption("--accounts", ["ACCOUNTS", "RESOLVER_ACCOUNTS"]);
const fromArg = resolveOption("--from", ["FROM"]);

const accounts = parseAddressList(accountsArg, "--accounts");

const { viem, chainId } = await connectViem();
const wallet = await resolveWallet(viem, fromArg);
const deployment = await loadResolverDeployment(chainId);
const resolver = await getResolverContract(viem, deployment.address, wallet);

for (const account of accounts) {
  await resolver.write.setAttesterTrust([account, true]);
  logSuccess("Attester trusted", { resolver: deployment.address, attester: account });
}
