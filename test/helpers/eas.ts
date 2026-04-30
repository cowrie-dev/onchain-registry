import assert from "node:assert/strict";
import { encodeAbiParameters, encodePacked, keccak256, type Hex } from "viem";
import type { ContractReturnType, WalletClient } from "@nomicfoundation/hardhat-viem/types";
import type { network } from "hardhat";

type ViemHelpers = Awaited<ReturnType<typeof network.connect>>["viem"];

export const SCHEMA_STRING =
  "string source,string sourceUID,string category,string evidenceURI,uint64 designatedAt";

export type DesignationFields = {
  source: string;
  sourceUID: string;
  category: string;
  evidenceURI: string;
  designatedAt: bigint;
};

export function encodeDesignation(fields: DesignationFields): Hex {
  return encodeAbiParameters(
    [
      { name: "source", type: "string" },
      { name: "sourceUID", type: "string" },
      { name: "category", type: "string" },
      { name: "evidenceURI", type: "string" },
      { name: "designatedAt", type: "uint64" },
    ],
    [fields.source, fields.sourceUID, fields.category, fields.evidenceURI, fields.designatedAt],
  );
}

export function predictSchemaUID(resolver: `0x${string}`, revocable: boolean): Hex {
  return keccak256(
    encodePacked(["string", "address", "bool"], [SCHEMA_STRING, resolver, revocable]),
  );
}

// ContractReturnType<"EAS"> and ContractReturnType<"SchemaRegistry"> resolve to the
// unparameterized fallback (GetContractReturnType<ViemAbi>) because Hardhat 3 does not
// emit standalone artifact files for npm-package-imported contracts.  The runtime
// behavior is correct; only the per-method type inference is lost.
export type EASStack = {
  schemaRegistry: ContractReturnType<"SchemaRegistry">;
  eas: ContractReturnType<"EAS">;
};

export async function deployEAS(viem: ViemHelpers, deployer: WalletClient): Promise<EASStack> {
  const schemaRegistry = await viem.deployContract("SchemaRegistry", [], {
    client: { wallet: deployer },
  });
  const eas = await viem.deployContract("EAS", [schemaRegistry.address], {
    client: { wallet: deployer },
  });
  return { schemaRegistry, eas };
}

export async function registerSchema(
  schemaRegistry: ContractReturnType<"SchemaRegistry">,
  resolverAddress: `0x${string}`,
  revocable: boolean = true,
): Promise<Hex> {
  const expected = predictSchemaUID(resolverAddress, revocable);
  await schemaRegistry.write.register([SCHEMA_STRING, resolverAddress, revocable]);
  const stored = await schemaRegistry.read.getSchema([expected]) as { uid: `0x${string}` };
  assert.equal(stored.uid.toLowerCase(), expected.toLowerCase(), "schema UID mismatch after register");
  return expected;
}

type AttestArgs = {
  eas: ContractReturnType<"EAS">;
  schemaUID: Hex;
  recipient: `0x${string}`;
  data: DesignationFields;
  revocable?: boolean;
};

export async function attest({ eas, schemaUID, recipient, data, revocable = true }: AttestArgs): Promise<Hex> {
  // simulate to read the returned UID, then send for real
  const { result: uid } = await eas.simulate.attest([
    {
      schema: schemaUID,
      data: {
        recipient,
        expirationTime: 0n,
        revocable,
        refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
        data: encodeDesignation(data),
        value: 0n,
      },
    },
  ]);
  await eas.write.attest([
    {
      schema: schemaUID,
      data: {
        recipient,
        expirationTime: 0n,
        revocable,
        refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
        data: encodeDesignation(data),
        value: 0n,
      },
    },
  ]);
  return uid as Hex;
}

export async function revoke(
  eas: ContractReturnType<"EAS">,
  schemaUID: Hex,
  uid: Hex,
): Promise<void> {
  await eas.write.revoke([
    {
      schema: schemaUID,
      data: { uid, value: 0n },
    },
  ]);
}

export async function expectRevert(promise: Promise<unknown>, expectedMessage: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    const err = error as {
      shortMessage?: string;
      message?: string;
      details?: string;
      cause?: {
        shortMessage?: string;
        message?: string;
        details?: string;
        errorName?: string;
        cause?: { shortMessage?: string; message?: string; details?: string };
      };
    };
    const parts = [
      err.shortMessage,
      err.message,
      err.details,
      err.cause?.shortMessage,
      err.cause?.message,
      err.cause?.details,
      err.cause?.errorName,
      err.cause?.cause?.shortMessage,
      err.cause?.cause?.message,
      err.cause?.cause?.details,
    ].filter((part): part is string => Boolean(part));
    const message = parts.join(" | ");
    assert.ok(
      message.includes(expectedMessage),
      `Expected revert to include "${expectedMessage}", got "${message}"`,
    );
    return true;
  });
}

export const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
