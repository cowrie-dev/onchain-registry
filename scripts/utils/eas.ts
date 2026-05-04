import {
  encodeAbiParameters,
  encodePacked,
  keccak256,
  type Address,
  type Hex,
} from "viem";

export const SCHEMA_STRING =
  "string source,string sourceUID,string category,string sourceUrl,bytes32 sourceSha256,uint64 sourcePublishedAt,uint64 designatedAt";

/// EAS canonical contract addresses per chain.  Mainnet only at launch; extend when
/// new deployments are added.
const EAS_ADDRESSES: Record<number, { eas: Address; schemaRegistry: Address }> =
  {
    1: {
      eas: "0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587",
      schemaRegistry: "0xA7b39296258348C78294F95B872b282326A97BDF",
    },
    11155111: {
      eas: "0xC2679fBD37d54388Ce493F1DB75320D236e1815e",
      schemaRegistry: "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0",
    },
  };

export function getEASAddresses(chainId: number): {
  eas: Address;
  schemaRegistry: Address;
} {
  const entry = EAS_ADDRESSES[chainId];
  if (!entry) {
    throw new Error(
      `EAS addresses not configured for chainId ${chainId}.  Add an entry to scripts/utils/eas.ts.`,
    );
  }
  return entry;
}

export function predictSchemaUID(resolver: Address, revocable: boolean): Hex {
  return keccak256(
    encodePacked(
      ["string", "address", "bool"],
      [SCHEMA_STRING, resolver, revocable],
    ),
  );
}

export type DesignationFields = {
  source: string;
  sourceUID: string;
  category: string;
  sourceUrl: string;
  sourceSha256: Hex;
  sourcePublishedAt: bigint;
  designatedAt: bigint;
};

export function encodeDesignation(fields: DesignationFields): Hex {
  return encodeAbiParameters(
    [
      { name: "source", type: "string" },
      { name: "sourceUID", type: "string" },
      { name: "category", type: "string" },
      { name: "sourceUrl", type: "string" },
      { name: "sourceSha256", type: "bytes32" },
      { name: "sourcePublishedAt", type: "uint64" },
      { name: "designatedAt", type: "uint64" },
    ],
    [
      fields.source,
      fields.sourceUID,
      fields.category,
      fields.sourceUrl,
      fields.sourceSha256,
      fields.sourcePublishedAt,
      fields.designatedAt,
    ],
  );
}

export const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
