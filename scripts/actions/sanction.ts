import { publicationSchemaUID } from '../../client/src/publications.js';
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { decodeEventLog, getAddress, isAddress, zeroAddress, parseAbiItem, type Hex } from "viem";

import { networkId, normalizeSourceAccount, type SanctionsNetwork } from "../utils/accounts.js";
import { encodeDesignation } from "../utils/eas.js";
import {
  connectViem,
  getEASContract,
  loadResolverDeployment,
  requireOption,
  resolveOption,
  resolveWallet,
} from "../utils/resolver.js";

type SanctionEntry = {
  address: string;
  network: SanctionsNetwork;
  source: string;
  sourceUID: string;
  category: string;
  sourceUrl: string;
  sourceSha256: Hex;
  sourcePublishedAt: number | string;
  designatedAt: number | string;
};

const inputPath = requireOption("--input", ["INPUT", "RESOLVER_INPUT"]);
const fromArg = resolveOption("--from", ["FROM"]);

const text = await readFile(resolve(process.cwd(), inputPath), "utf8");
const entries = JSON.parse(text) as SanctionEntry[];
if (!Array.isArray(entries) || entries.length === 0) {
  throw new Error(`--input must be a non-empty JSON array of sanction entries`);
}

const { viem, chainId } = await connectViem();
const deployment = await loadResolverDeployment(chainId);
const currentResolver = await viem.getContractAt('SanctionsResolverV2', deployment.address as `0x${string}`);
if (await currentResolver.read.schemaUID() === publicationSchemaUID(deployment.address as `0x${string}`)) {
  throw new Error('This legacy action cannot change publication records. Submit additions/removals through the publication publisher; see docs/publication-design.md.');
}
const wallet = await resolveWallet(viem, fromArg);
if (!deployment.schemaUID) {
  throw new Error(
    `No schemaUID recorded for chainId ${chainId}.  Run scripts/register-schema.ts first.`,
  );
}
const eas = await getEASContract(viem, deployment.easAddress, wallet);

const normalizedEntries = entries.flatMap(entry => {
  const canonical = normalizeSourceAccount(entry.network, entry.address).account;
  return [...new Set([entry.address.trim(), canonical])].map(address => ({ ...entry, address }));
});
const requestData = normalizedEntries.map((entry) => ({
  recipient: entry.network === "EVM" && isAddress(entry.address, { strict: false }) ? getAddress(entry.address) : zeroAddress,
  expirationTime: 0n,
  revocable: true,
  refUID: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
  data: encodeDesignation({
    network: networkId(entry.network),
    account: entry.address,
    source: entry.source,
    sourceUID: entry.sourceUID,
    category: entry.category,
    sourceUrl: entry.sourceUrl,
    sourceSha256: entry.sourceSha256,
    sourcePublishedAt: BigInt(entry.sourcePublishedAt),
    designatedAt: BigInt(entry.designatedAt),
  }),
  value: 0n,
}));

const txHash = await eas.write.multiAttest([
  [
    {
      schema: deployment.schemaUID as Hex,
      data: requestData,
    },
  ],
]);
const publicClient = await viem.getPublicClient();
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

const attestedEventAbi = parseAbiItem(
  "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
);
const uids: Array<{ recipient: string; uid: string }> = [];
for (const log of receipt.logs) {
  if (log.address.toLowerCase() !== deployment.easAddress.toLowerCase()) continue;
  try {
    const decoded = decodeEventLog({ abi: [attestedEventAbi], data: log.data, topics: log.topics });
    if (decoded.eventName === "Attested") {
      uids.push({ recipient: decoded.args.recipient, uid: decoded.args.uid });
    }
  } catch {
    // not an Attested event, ignore
  }
}

console.log(
  JSON.stringify(
    { resolver: deployment.address, txHash, sanctioned: uids },
    null,
    2,
  ),
);
