import {
  connectViem,
  getResolverContract,
  loadResolverDeployment,
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

const sanctioned = await resolver.read.isSanctionedBatch([accounts]);
const designations = await Promise.all(
  accounts.map((account) => resolver.read.getDesignation([account])),
);

const result = accounts.map((account, i) => ({
  account,
  sanctioned: sanctioned[i],
  attestationUID: designations[i].attestationUID,
  attester: designations[i].attester,
  attestedAt: designations[i].attestedAt.toString(),
}));

console.log(JSON.stringify({ resolver: deployment.address, entries: result }, null, 2));
