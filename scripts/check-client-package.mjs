import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'client/package.json'), 'utf8'));
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const directory = mkdtempSync(join(tmpdir(), 'sanctions-client-package-'));
const run = (command, args, cwd = directory) => execFileSync(command, args, {
    cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8',
});

try {
    const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', directory], join(root, 'client')));
    const paths = packed.files.map(file => file.path);
    for (const path of ['dist/index.js', 'dist/index.d.ts', 'README.md', 'LICENSE.txt', 'package.json']) {
        assert.ok(paths.includes(path), `Missing package file: ${path}`);
    }
    assert.ok(paths.every(path => path.startsWith('dist/') || ['README.md', 'LICENSE.txt', 'package.json'].includes(path)));
    assert.equal(manifest.license, 'MIT');
    assert.equal(readFileSync(join(root, 'client/LICENSE.txt'), 'utf8'), readFileSync(join(root, 'LICENSE.txt'), 'utf8'));
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    // Use the lowest supported viem version to check the advertised peer range.
    const viemVersion = manifest.peerDependencies.viem.replace(/^\^/, '');
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, packed.filename),
        `viem@${viemVersion}`, `typescript@${rootManifest.devDependencies.typescript}`, '@types/node@22']);
    writeFileSync(join(directory, 'consumer.ts'), `
import assert from 'node:assert/strict';
import { createPublicClient, http, zeroHash, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import {
  lookupSanctions, lookupSanctionsBatch, sanctionsResolverV2Abi, normalizeSanctionsAccount,
  buildPublicationChunks, encodePublication, decodePublication, publicationRequest,
  publicationSchemaUID, PUBLICATION_SCHEMA, type SanctionsResult,
} from '@cowrie/sanctions-client';
const client = createPublicClient({ chain: mainnet, transport: http('http://127.0.0.1:1') });
const resolver = '0x0facD8549aB0666c3c79597f75cd8c75A5520Fac';
async function typedReads() {
  const result: SanctionsResult = await lookupSanctions({ client, resolver, network: 'BTC', account: 'invalid' });
  const records = await lookupSanctionsBatch({ client, resolver, accounts: [] });
  const account = await client.readContract({ address: resolver, abi: sanctionsResolverV2Abi,
    functionName: 'getAccountByKey', args: [zeroHash], blockNumber: 1n });
  const network: string = account[0];
  return { result, records, network };
}
void typedReads;
assert.equal(normalizeSanctionsAccount('EVM', resolver), resolver.toLowerCase());
const [publication] = buildPublicationChunks({ source: 'OFAC_SDN', sourceUrl: 'https://example.org/sdn.xml',
  sourceSha256: '0x' + '11'.repeat(32) as Hex, comparisonSourceSha256: zeroHash,
  sourcePublishedAt: 100n, previousPublication: zeroHash, kind: 0 },
  [{ network: 'BTC', account: 'source-literal', sourceUID: '123', category: 'Entity', designatedAt: 1n }], []);
assert.deepEqual(decodePublication(encodePublication(publication)), publication);
assert.equal(publicationRequest(publication).revocable, false);
assert.equal(publicationSchemaUID(resolver), '0x690321cff187dd1a500afc761b4a1af7364d593bfe99b31fdd38bd4ab10d2b5a');
assert.ok(PUBLICATION_SCHEMA.includes('string[] addedAccounts'));
assert.deepEqual(await lookupSanctionsBatch({ client, resolver, accounts: [] }), []);
console.log('Packed SDK imports, consumer types, and runtime checks passed.');
`);
    run(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--module', 'NodeNext',
        '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--skipLibCheck', 'consumer.ts']);
    process.stdout.write(run(process.execPath, ['consumer.js']));
    console.log(`Verified ${manifest.name}@${manifest.version}: ${paths.length} packaged files, viem ${viemVersion}.`);
} finally {
    rmSync(directory, { recursive: true, force: true });
}
