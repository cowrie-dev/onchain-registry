import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  concat,
  encodeAbiParameters,
  getAddress,
  getCreate2Address,
  keccak256,
  pad,
  type Address,
  type Hex,
} from "viem";

/// CreateX is deployed at the same address on every major EVM chain.  See
/// https://github.com/pcaversaccio/createx-deployments for the per-chain
/// records.  When a chain doesn't have CreateX, deployment is the user's
/// responsibility upstream of running scripts/deploy-create3.ts.
export const CREATEX_ADDRESS: Address = getAddress(
  "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed",
);

/// Init code of the tiny CREATE3 proxy CreateX deploys via CREATE2 before
/// CALLing it with the user's init code.  Identical across chains; depends on
/// neither chain id nor the user's contract.  Hash is precomputed below.
const CREATE3_PROXY_INIT_CODE: Hex = "0x67363d3d37363d34f03d5260086018f3";
export const CREATE3_PROXY_INIT_CODE_HASH: Hex = keccak256(CREATE3_PROXY_INIT_CODE);

export const CREATEX_DEPLOY_CREATE3_ABI = [
  {
    type: "function",
    name: "deployCreate3",
    stateMutability: "payable",
    inputs: [
      { name: "salt", type: "bytes32" },
      { name: "initCode", type: "bytes" },
    ],
    outputs: [{ name: "newContract", type: "address" }],
  },
  // The 2-arg `pure` overload of computeCreate3Address.  Takes an ALREADY-
  // guarded salt and a CREATE2 deployer; does the CREATE2 + nonce-1 RLP
  // math only.  We use this for the deploy script's cross-check: feed it
  // our TS-computed guardedSalt and CreateX's address, and the result
  // should match `computeCreate3Address(...)` from this file.
  //
  // Do NOT use the 1-arg overload `computeCreate3Address(bytes32)` for
  // cross-checking: contrary to what its name suggests, it does NOT apply
  // `_guard` (it's the Solady-style raw-salt prediction).  Comparing it to
  // a TS prediction that DOES apply _guard will always disagree for
  // permissioned salts.  See CreateX.sol around line 865.
  {
    type: "function",
    name: "computeCreate3Address",
    stateMutability: "pure",
    inputs: [
      { name: "salt", type: "bytes32" },
      { name: "deployer", type: "address" },
    ],
    outputs: [{ name: "computedAddress", type: "address" }],
  },
] as const;

/// Builds a 32-byte salt in CreateX's permissioned + no-cross-chain-protection
/// mode (the only mode our scripts use):
///   bytes[0..20)  = sender (the EOA that will call CreateX)
///   bytes[20]     = 0x00   (cross-chain protection flag OFF; required so the
///                          guardedSalt does not include block.chainid)
///   bytes[21..32) = caller-supplied tail (11 bytes; what the salt miner varies)
export function buildPermissionedSalt(sender: Address, tail: Hex): Hex {
  const tailBytes = tail.startsWith("0x") ? tail.slice(2) : tail;
  if (tailBytes.length !== 22) {
    throw new Error(
      `buildPermissionedSalt: tail must be 11 bytes (22 hex chars), got ${tailBytes.length} chars`,
    );
  }
  const senderBytes = sender.slice(2).toLowerCase();
  return `0x${senderBytes}00${tailBytes}` as Hex;
}

/// Mirrors CreateX's `_guard` for the permissioned + no-cross-chain-protection
/// mode: keccak256(abi.encodePacked(bytes32(uint256(uint160(sender))), salt)).
/// Other modes are not implemented; they would change the resulting address
/// and break the multi-chain identical-address invariant.
export function computeGuardedSalt(sender: Address, salt: Hex): Hex {
  return keccak256(concat([pad(sender, { size: 32 }), salt]));
}

/// Predicts the CREATE3 proxy address.  The proxy is deployed via CREATE2 from
/// CreateX with the guarded salt and the (constant) proxy init code, so:
///   keccak256(0xff ++ createx ++ guardedSalt ++ keccak256(proxyInitCode))[12:]
export function computeCreate3ProxyAddress(args: {
  createx: Address;
  sender: Address;
  salt: Hex;
}): Address {
  const guardedSalt = computeGuardedSalt(args.sender, args.salt);
  return getCreate2Address({
    from: args.createx,
    salt: guardedSalt,
    bytecodeHash: CREATE3_PROXY_INIT_CODE_HASH,
  });
}

/// Predicts the final contract address.  The proxy CREATEs the contract from
/// inside its runtime, with proxy.nonce == 1, so:
///   keccak256(rlp([proxy, 0x01]))[12:]
/// RLP encoding for [20-byte address, 0x01] = 0xd6 0x94 ++ proxy ++ 0x01.
export function computeCreate3Address(args: {
  createx: Address;
  sender: Address;
  salt: Hex;
}): Address {
  const proxy = computeCreate3ProxyAddress(args);
  const rlp = concat(["0xd694", proxy, "0x01"]);
  const hash = keccak256(rlp);
  return getAddress(`0x${hash.slice(-40)}`);
}

/// Tests whether a 20-byte hex address matches a 40-char `--matching`-style
/// pattern.  The pattern uses hex chars (case-insensitive) for required nibbles
/// and `X` (or `x`) as a single-nibble wildcard.  Mirrors createxcrunch's
/// `--matching` flag: e.g., `c0c0XXXX...XXXXcafe` matches addresses starting
/// with c0c0 and ending with cafe.  Throws on any other character.
export function addressMatchesMatching(address: Address, matching: string): boolean {
  if (matching.length !== 40) {
    throw new Error(
      `--matching must be exactly 40 hex/X chars (the length of an address body), got ${matching.length}`,
    );
  }
  const lower = matching.toLowerCase();
  if (!/^[0-9a-fx]+$/.test(lower)) {
    throw new Error(`--matching must contain only hex chars and X wildcards, got '${matching}'`);
  }
  const body = address.slice(2).toLowerCase();
  for (let i = 0; i < 40; i++) {
    const p = lower.charCodeAt(i);
    if (p === 120 /* 'x' */) continue;
    if (p !== body.charCodeAt(i)) return false;
  }
  return true;
}

/// Reads SanctionsResolver creation bytecode from Hardhat's compiled artifact
/// and concatenates the ABI-encoded constructor args.  This is the byte string
/// CreateX's CREATE3 proxy will execute as a contract-creation initcode.
export async function buildResolverInitCode(args: {
  eas: Address;
  initialOwner: Address;
  initialAttester: Address;
  artifactPath?: string;
}): Promise<Hex> {
  const path =
    args.artifactPath ??
    resolve(
      process.cwd(),
      "artifacts/contracts/SanctionsResolver.sol/SanctionsResolver.json",
    );
  const artifact = JSON.parse(await readFile(path, "utf8")) as { bytecode: Hex };
  const encodedArgs = encodeAbiParameters(
    [
      { name: "eas", type: "address" },
      { name: "initialOwner", type: "address" },
      { name: "initialAttester", type: "address" },
    ],
    [args.eas, args.initialOwner, args.initialAttester],
  );
  return concat([artifact.bytecode, encodedArgs]);
}
