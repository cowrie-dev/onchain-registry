import {
    decodeAbiParameters,
    encodeAbiParameters,
    encodePacked,
    keccak256,
    parseAbiParameters,
    zeroAddress,
    zeroHash,
    type Address,
    type Hex,
} from 'viem';

/** Ordinary EAS/ABI types: accounts and network names are readable strings. */
export const PUBLICATION_SCHEMA =
    'string source,string sourceUrl,bytes32 sourceSha256,bytes32 comparisonSourceSha256,uint64 sourcePublishedAt,bytes32 previousPublication,uint8 kind,uint32 chunkIndex,uint32 chunkCount,string[] sourceUIDs,string[] categories,uint64[] designatedAt,string[] entityNetworks,string[] addedAccounts,uint32[] entityIndices,string[] removedNetworks,string[] removedAccounts';
export const publicationParameters = parseAbiParameters(PUBLICATION_SCHEMA);
/** entityIndices maps each addedAccounts entry to the shared entityNetworks/sourceUIDs/categories/designatedAt table. */
export type Publication = {
    source: string;
    sourceUrl: string;
    sourceSha256: Hex;
    comparisonSourceSha256: Hex;
    sourcePublishedAt: bigint;
    previousPublication: Hex;
    kind: 0 | 1 | 2;
    chunkIndex: number;
    chunkCount: number;
    sourceUIDs: string[];
    categories: string[];
    designatedAt: bigint[];
    entityNetworks: string[];
    addedAccounts: string[];
    entityIndices: number[];
    removedNetworks: string[];
    removedAccounts: string[];
};
export function encodePublication(p: Publication): Hex {
    return encodeAbiParameters(publicationParameters, [
        p.source,
        p.sourceUrl,
        p.sourceSha256,
        p.comparisonSourceSha256,
        p.sourcePublishedAt,
        p.previousPublication,
        p.kind,
        p.chunkIndex,
        p.chunkCount,
        p.sourceUIDs,
        p.categories,
        p.designatedAt,
        p.entityNetworks,
        p.addedAccounts,
        p.entityIndices,
        p.removedNetworks,
        p.removedAccounts,
    ]);
}
export function decodePublication(data: Hex): Publication {
    const [
        source,
        sourceUrl,
        sourceSha256,
        comparisonSourceSha256,
        sourcePublishedAt,
        previousPublication,
        kind,
        chunkIndex,
        chunkCount,
        sourceUIDs,
        categories,
        designatedAt,
        entityNetworks,
        addedAccounts,
        entityIndices,
        removedNetworks,
        removedAccounts,
    ] = decodeAbiParameters(publicationParameters, data);
    if (kind > 2) throw new Error(`Unknown publication kind: ${kind}`);
    return {
        source,
        sourceUrl,
        sourceSha256,
        comparisonSourceSha256,
        sourcePublishedAt,
        previousPublication,
        kind: kind as 0 | 1 | 2,
        chunkIndex,
        chunkCount,
        sourceUIDs: [...sourceUIDs],
        categories: [...categories],
        designatedAt: [...designatedAt],
        entityNetworks: [...entityNetworks],
        addedAccounts: [...addedAccounts],
        entityIndices: [...entityIndices],
        removedNetworks: [...removedNetworks],
        removedAccounts: [...removedAccounts],
    };
}
export function publicationId(p: Publication): Hex {
    return keccak256(
        encodeAbiParameters(parseAbiParameters('string,string,bytes32,bytes32,uint64,bytes32,uint8,uint32'), [
            p.source,
            p.sourceUrl,
            p.sourceSha256,
            p.comparisonSourceSha256,
            p.sourcePublishedAt,
            p.previousPublication,
            p.kind,
            p.chunkCount,
        ]),
    );
}
export function publicationSchemaUID(resolver: Address): Hex {
    return keccak256(encodePacked(['string', 'address', 'bool'], [PUBLICATION_SCHEMA, resolver, false]));
}
export function publicationRequest(p: Publication) {
    return {
        recipient: zeroAddress,
        expirationTime: 0n,
        revocable: false,
        refUID: zeroHash,
        data: encodePublication(p),
        value: 0n,
    };
}

export type PublicationAccount = {
    network: string;
    account: string;
    sourceUID: string;
    category: string;
    designatedAt: bigint;
};
export type PublicationHeader = Pick<
    Publication,
    | 'source'
    | 'sourceUrl'
    | 'sourceSha256'
    | 'comparisonSourceSha256'
    | 'sourcePublishedAt'
    | 'previousPublication'
    | 'kind'
>;
/** Partition only when necessary for the transaction limit. Shared entity metadata is deduplicated per chunk. */
export function buildPublicationChunks(
    header: PublicationHeader,
    additions: PublicationAccount[],
    removals: Array<{ network: string; account: string }>,
    maxChanges = 30,
): Publication[] {
    if (!Number.isSafeInteger(maxChanges) || maxChanges < 1)
        throw new Error('Invalid publication chunk size');
    const changes = [
        ...removals.map((row) => ({ op: 'remove' as const, row })),
        ...additions.map((row) => ({ op: 'add' as const, row })),
    ];
    const chunks: Publication[] = [];
    for (let offset = 0; offset < changes.length; offset += maxChanges) {
        const p: Publication = {
            ...header,
            chunkIndex: chunks.length,
            chunkCount: Math.ceil(changes.length / maxChanges),
            sourceUIDs: [],
            categories: [],
            designatedAt: [],
            entityNetworks: [],
            addedAccounts: [],
            entityIndices: [],
            removedNetworks: [],
            removedAccounts: [],
        };
        const entities = new Map<string, number>();
        for (const change of changes.slice(offset, offset + maxChanges)) {
            if (change.op === 'remove') {
                p.removedNetworks.push(change.row.network);
                p.removedAccounts.push(change.row.account);
            } else {
                const row = change.row;
                const entity = JSON.stringify([
                    row.network,
                    row.sourceUID,
                    row.category,
                    row.designatedAt.toString(),
                ]);
                let index = entities.get(entity);
                if (index === undefined) {
                    index = p.sourceUIDs.length;
                    entities.set(entity, index);
                    p.sourceUIDs.push(row.sourceUID);
                    p.categories.push(row.category);
                    p.designatedAt.push(row.designatedAt);
                    p.entityNetworks.push(row.network);
                }
                p.addedAccounts.push(row.account);
                p.entityIndices.push(index);
            }
        }
        chunks.push(p);
    }
    return chunks;
}
