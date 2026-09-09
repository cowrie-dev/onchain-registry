import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getCoderByCoinName } from '@ensdomains/address-encoder';
import { base58CheckEncode, createBech32Encoder, encodeBchAddressWithVersion } from '@ensdomains/address-encoder/utils';
import { normalizeSanctionsAccount, normalizeSourceAccount, prepareSanctionsQuery, sanctionsAccountKey, type SanctionsNetwork } from '../client/src/accounts.js';

const malformedBtc = '1QRus492mJL2Cum4E2TSqUmjdCBE5m33yG';
const truncatedBtc = '16Jswqk47s9PUcyCc88MMVwzgvHPvtEpf';
const versions: Array<[SanctionsNetwork, number[][]]> = [
    ['BTC', [[0], [5]]], ['BCH', [[0], [5]]], ['BTG', [[0x26], [0x17]]],
    ['LTC', [[0x30], [0x32], [5]]], ['DASH', [[0x4c], [0x10]]],
    ['DOGE', [[0x1e], [0x16]]], ['XVG', [[0x1e], [0x21]]],
    ['ZEC', [[0x1c, 0xb8], [0x1c, 0xbd]]], ['BSV', [[0]]],
];

describe('sanctions address payload validation', () => {
    it('preserves the reported oversized Bitcoin address without inventing a second key', () => {
        assert.deepEqual(normalizeSourceAccount('BTC', malformedBtc), { account: malformedBtc, literal: true });
        assert.deepEqual(prepareSanctionsQuery('BTC', malformedBtc), {
            keys: [sanctionsAccountKey('BTC', malformedBtc)], valid: false, canonical: null,
        });
        assert.equal(normalizeSanctionsAccount('BTC', truncatedBtc), truncatedBtc);
    });
    for (const [network, prefixes] of versions) {
        it(`validates both payload length and checksum for ${network} Base58 addresses`, () => {
            for (const prefix of prefixes) {
                const valid = base58CheckEncode(new Uint8Array([...prefix, ...Array(20).fill(1)]));
                assert.equal(normalizeSourceAccount(network, valid).literal, false);
                for (const length of [19, 21, 32]) {
                    const malformed = base58CheckEncode(new Uint8Array([...prefix, ...Array(length).fill(1)]));
                    assert.deepEqual(normalizeSourceAccount(network, malformed), { account: malformed, literal: true });
                }
            }
        });
    }
    it('preserves witness case normalization while rejecting invalid program lengths and checksum variants', () => {
        const coder = getCoderByCoinName('btc');
        for (const [version, length] of [[0,20], [0,32], [0x51,32], [0x60,40]]) {
            const valid = coder.encode(new Uint8Array([version, length, ...Array(length).fill(1)]));
            assert.equal(normalizeSanctionsAccount('BTC', valid.toUpperCase()), valid);
        }
        for (const [version, length] of [[0,19], [0,21], [0x51,1], [0x51,41]]) {
            const malformed = coder.encode(new Uint8Array([version, length, ...Array(length).fill(1)]));
            assert.equal(normalizeSourceAccount('BTC', malformed).literal, true);
        }
        // Bech32 v1 is invalid (v1 requires Bech32m), despite containing a valid program.
        const wrongChecksumVariant = createBech32Encoder('bc')(new Uint8Array([8, ...Array(32).fill(0)]));
        assert.equal(normalizeSourceAccount('BTC', wrongChecksumVariant).literal, true);
    });
    it('does not truncate larger CashAddr hashes or repair a reserved version bit', () => {
        for (const account of [encodeBchAddressWithVersion(0, new Uint8Array(32)), encodeBchAddressWithVersion(128, new Uint8Array(20))]) {
            assert.deepEqual(normalizeSourceAccount('BCH', account), { account, literal: true });
        }
    });
    it('requires 20 bytes for BNB and 43 bytes for Zcash Sapling', () => {
        for (const [network, hrp, length] of [['BNB', 'bnb', 20], ['ZEC', 'zs', 43]] as const) {
            const encode = createBech32Encoder(hrp);
            const valid = encode(new Uint8Array(length));
            assert.equal(normalizeSanctionsAccount(network, valid), valid);
            for (const size of [length - 1, length + 1]) {
                const malformed = encode(new Uint8Array(size));
                assert.equal(normalizeSourceAccount(network, malformed).literal, true);
            }
        }
    });
});
