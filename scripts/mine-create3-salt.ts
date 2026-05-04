import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import {
  CREATEX_ADDRESS,
  addressMatchesMatching,
  buildPermissionedSalt,
  computeCreate3Address,
} from "./utils/createx.js";
import { resolveOption, requireOption } from "./utils/resolver.js";

/// Brute-forces the 11 free bytes of a permissioned CreateX salt until the
/// resulting CREATE3 address matches the supplied --matching pattern.  Pure
/// CPU work in this process; CREATE3 addresses depend on CreateX + sender +
/// salt only, so no network calls.  Pass --gpu to delegate to createxcrunch.

const matching = requireOption("--matching", ["MATCHING"]);
const senderArg = requireOption("--account", ["ACCOUNT"]);
const maxItersArg = resolveOption("--max-iters", ["MAX_ITERS"]);
const createxArg = resolveOption("--createx", ["CREATEX"]);
const useGpu = process.argv.includes("--gpu") || process.env.GPU === "1";

const sender: Address = getAddress(senderArg);
const createx: Address = createxArg ? getAddress(createxArg) : CREATEX_ADDRESS;

// Validate the pattern up-front (same rules whether we mine in-process or via
// createxcrunch) so we surface bad input before doing anything expensive.
addressMatchesMatching(
  "0x0000000000000000000000000000000000000000" as Address,
  matching,
);

if (useGpu) {
  runOnGpu();
} else {
  runOnCpu();
}

function runOnGpu(): never {
  const binary = process.env.CREATEXCRUNCH_BIN ?? "createxcrunch";
  // We want byte 20 of the salt to be 0x00 (Sender variant) so the address is
  // identical on every chain.  In createxcrunch, --crosschain is Option<u64>:
  // its VALUE is the chain_id to bind into the salt's guard, and ANY value
  // (including 0) flips the salt to the CrosschainSender variant with byte
  // 20 = 0x01.  Omit the flag entirely to get the Sender variant we need.
  const args = [
    "create3",
    "--caller",
    sender,
    "--matching",
    matching,
  ];

  if (createxArg) {
    console.error(
      `note: --createx override is ignored on the GPU path (createxcrunch uses its own canonical address).`,
    );
  }

  console.log(`Delegating to ${binary} (GPU)`);
  console.log(`  ${binary} ${args.map(quote).join(" ")}`);
  console.log("");

  const result = spawnSync(binary, args, { stdio: "inherit" });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    console.error(
      `\nCould not find '${binary}' on PATH.\n` +
        `Install createxcrunch from https://github.com/HrikB/createXcrunch ` +
        `(Rust + OpenCL/CUDA), or set CREATEXCRUNCH_BIN to the binary path.`,
    );
    process.exit(127);
  }
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

function runOnCpu(): never {
  const maxIters = maxItersArg ? Number(maxItersArg) : 50_000_000;
  if (!Number.isFinite(maxIters) || maxIters <= 0) {
    throw new Error(`--max-iters must be a positive number`);
  }

  console.log("CREATE3 salt miner (CPU)");
  console.log(`  CreateX  : ${createx}`);
  console.log(`  sender   : ${sender}`);
  console.log(`  matching : ${matching}`);
  console.log(`  budget   : ${maxIters.toLocaleString()} iterations`);
  console.log("");

  const startedAt = Date.now();
  let lastReport = startedAt;
  const reportEvery = 100_000;

  for (let i = 1; i <= maxIters; i++) {
    const tail = `0x${randomBytes(11).toString("hex")}` as Hex;
    const salt = buildPermissionedSalt(sender, tail);
    const address = computeCreate3Address({ createx, sender, salt });

    if (addressMatchesMatching(address, matching)) {
      const elapsed = (Date.now() - startedAt) / 1000;
      console.log(`MATCH after ${i.toLocaleString()} iterations (${elapsed.toFixed(1)}s)`);
      console.log(`  address : ${address}`);
      console.log(`  salt    : ${salt}`);
      process.exit(0);
    }

    if (i % reportEvery === 0) {
      const now = Date.now();
      const rate = (reportEvery * 1000) / (now - lastReport);
      lastReport = now;
      process.stdout.write(
        `  ${i.toLocaleString()} iters, ${rate.toFixed(0)} hash/s\r`,
      );
    }
  }

  console.error(`No match in ${maxIters.toLocaleString()} iterations.`);
  console.error(`For longer combined patterns, retry with --gpu.`);
  process.exit(1);
}

function quote(s: string): string {
  return /[^\w\-./:=]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}
