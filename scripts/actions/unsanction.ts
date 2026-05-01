import { type Hex } from "viem";

import {
  connectViem,
  getEASContract,
  getResolverContract,
  loadResolverDeployment,
  parseAddressList,
  requireOption,
  resolveOption,
  resolveWallet,
} from "../utils/resolver.js";
import { ZERO_BYTES32 } from "../utils/eas.js";

const accountsArg = requireOption("--accounts", ["ACCOUNTS", "RESOLVER_ACCOUNTS"]);
const fromArg = resolveOption("--from", ["FROM"]);

const accounts = parseAddressList(accountsArg, "--accounts");

const { viem, chainId } = await connectViem();
const wallet = await resolveWallet(viem, fromArg);
const deployment = await loadResolverDeployment(chainId);
if (!deployment.schemaUID) {
  throw new Error(
    `No schemaUID recorded for chainId ${chainId}.  Run scripts/register-schema.ts first.`,
  );
}
const resolver = await getResolverContract(viem, deployment.address, wallet);
const eas = await getEASContract(viem, deployment.easAddress, wallet);

const revocations: Array<{ uid: Hex; value: bigint }> = [];
const skipped: string[] = [];
for (const account of accounts) {
  const designation = await resolver.read.getDesignation([account]);
  if (designation.attestationUID.toLowerCase() === ZERO_BYTES32) {
    skipped.push(account);
    continue;
  }
  revocations.push({ uid: designation.attestationUID as Hex, value: 0n });
}

if (revocations.length === 0) {
  console.log(JSON.stringify({ resolver: deployment.address, revoked: [], skipped }, null, 2));
  process.exit(0);
}

const txHash = await eas.write.multiRevoke([
  [
    {
      schema: deployment.schemaUID as Hex,
      data: revocations,
    },
  ],
]);

console.log(
  JSON.stringify(
    {
      resolver: deployment.address,
      txHash,
      revoked: revocations.map((r) => r.uid),
      skipped,
    },
    null,
    2,
  ),
);
