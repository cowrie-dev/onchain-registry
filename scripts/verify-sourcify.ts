import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  connectViem,
  loadResolverDeployment,
  resolveOption,
} from "./utils/resolver.js";

type BuildInfoBase = {
  id: string;
  solcLongVersion: string;
  input: unknown;
};
type BuildInfoOutput = {
  id: string;
  output?: { contracts?: Record<string, Record<string, unknown>> };
};

const SOURCIFY_API = "https://sourcify.dev/server";
const CONTRACT_NAME = "SanctionsResolver";

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 180_000;

const { chainId } = await connectViem();
const deployment = await loadResolverDeployment(chainId);

const creationTxFromArg = resolveOption("--creation-tx", ["CREATION_TX", "CREATION_TX_HASH"]);
const creationTxHash = creationTxFromArg ?? deployment.creationTxHash;
if (!creationTxHash) {
  throw new Error(
    `Creation tx hash required.  Pass --creation-tx <hash>, set CREATION_TX, ` +
      `or add "creationTxHash" to deployments.json[${chainId}].SanctionsResolver.`,
  );
}

const buildInfo = await findBuildInfo();
if (!buildInfo) {
  throw new Error(
    `No build-info contains a contract named '${CONTRACT_NAME}'.  ` +
      `Run \`npx hardhat compile\` first.`,
  );
}
const contractIdentifier = `${buildInfo.sourcePath}:${CONTRACT_NAME}`;

console.log(`Submitting ${contractIdentifier} to Sourcify`);
console.log(`  chain      : ${chainId}`);
console.log(`  address    : ${deployment.address}`);
console.log(`  compiler   : ${buildInfo.data.solcLongVersion}`);
console.log(`  build-info : ${buildInfo.basePath}`);
console.log(`  creationTx : ${creationTxHash}`);

const submitRes = await fetch(
  `${SOURCIFY_API}/v2/verify/${chainId}/${deployment.address}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stdJsonInput: buildInfo.data.input,
      compilerVersion: buildInfo.data.solcLongVersion,
      contractIdentifier,
      creationTransactionHash: creationTxHash,
    }),
  },
);

const submitBody = await submitRes.text();
if (!submitRes.ok) {
  throw new Error(`Sourcify submit failed (HTTP ${submitRes.status}): ${submitBody}`);
}

const submitJson = JSON.parse(submitBody) as { verificationId?: string };
const verificationId = submitJson.verificationId;
if (!verificationId) {
  throw new Error(`No verificationId in submit response: ${submitBody}`);
}

console.log(`  verificationId: ${verificationId}`);
console.log(`Polling for completion...`);

const startedAt = Date.now();
let lastResult: Record<string, unknown> = {};
while (true) {
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  const pollRes = await fetch(`${SOURCIFY_API}/v2/verify/${verificationId}`);
  const pollBody = await pollRes.text();
  if (!pollRes.ok) {
    throw new Error(`Sourcify poll failed (HTTP ${pollRes.status}): ${pollBody}`);
  }
  lastResult = JSON.parse(pollBody) as Record<string, unknown>;
  const status = lastResult["status"];
  if (lastResult["isJobCompleted"] === true || (typeof status === "string" && status !== "pending")) {
    break;
  }
  if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
    throw new Error(
      `Sourcify verification timed out after ${POLL_TIMEOUT_MS}ms; last response: ${JSON.stringify(lastResult)}`,
    );
  }
}

console.log(JSON.stringify(lastResult, null, 2));

async function findBuildInfo(): Promise<
  { basePath: string; data: BuildInfoBase; sourcePath: string } | null
> {
  const dir = resolve(process.cwd(), "artifacts/build-info");
  const files = await readdir(dir);
  const bases = files.filter((f) => f.endsWith(".json") && !f.endsWith(".output.json"));

  const ranked = await Promise.all(
    bases.map(async (f) => {
      const basePath = resolve(dir, f);
      const outputPath = basePath.replace(/\.json$/, ".output.json");
      const { mtimeMs } = await stat(basePath);
      return { basePath, outputPath, mtimeMs };
    }),
  );
  ranked.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of ranked) {
    const output = JSON.parse(await readFile(candidate.outputPath, "utf8")) as BuildInfoOutput;
    const sources = output.output?.contracts ?? {};
    for (const [sourcePath, contracts] of Object.entries(sources)) {
      if (contracts && CONTRACT_NAME in contracts) {
        const data = JSON.parse(await readFile(candidate.basePath, "utf8")) as BuildInfoBase;
        return { basePath: candidate.basePath, data, sourcePath };
      }
    }
  }
  return null;
}
