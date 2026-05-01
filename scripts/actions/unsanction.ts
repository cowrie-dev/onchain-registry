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

const signer = wallet.account.address.toLowerCase();
const revocations: Array<{ uid: Hex; value: bigint }> = [];
const skipped: Array<{ account: string; reason: string }> = [];
const otherAttester: Array<{ account: string; uid: Hex; attester: string }> = [];
for (const account of accounts) {
  const designation = await resolver.read.getDesignation([account]);
  if (designation.attestationUID.toLowerCase() === ZERO_BYTES32) {
    skipped.push({ account, reason: "no active designation" });
    continue;
  }
  // EAS only allows the original attester to revoke their own attestations.
  // Including someone else's UID would revert the whole multiRevoke batch
  // (`AccessDenied`), so split them out and have the operator handle them
  // separately (typically: re-run with --from <that attester>).
  if (designation.attester.toLowerCase() !== signer) {
    otherAttester.push({
      account,
      uid: designation.attestationUID as Hex,
      attester: designation.attester,
    });
    continue;
  }
  revocations.push({ uid: designation.attestationUID as Hex, value: 0n });
}

if (otherAttester.length > 0 && revocations.length === 0) {
  console.error(
    `All matching UIDs were attested by addresses other than the signer (${signer}).  ` +
      `Re-run --from each owning attester.  Affected:\n` +
      JSON.stringify(otherAttester, null, 2),
  );
  process.exit(1);
}

if (revocations.length === 0) {
  console.log(JSON.stringify({ resolver: deployment.address, revoked: [], skipped, otherAttester }, null, 2));
  process.exit(0);
}

if (otherAttester.length > 0) {
  console.warn(
    `Skipping ${otherAttester.length} entr${otherAttester.length === 1 ? "y" : "ies"} ` +
      `attested by other addresses (re-run --from each owning attester to revoke):\n` +
      JSON.stringify(otherAttester, null, 2),
  );
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
      otherAttester,
    },
    null,
    2,
  ),
);
