/**
 * tests/test_native_ecc_equivalence.ts
 *
 * Differential conformance test: the Node ECC implementation (ecc.ts —
 * sync/Buffer) and the browser implementation (ecc.browser.ts —
 * async/Uint8Array) must produce byte-identical results.
 *
 * ecc.browser.ts is @ts-nocheck and has no other test coverage, so this is
 * the guard that keeps the two platform implementations from drifting. It is
 * the safety net for any shared-core refactor of the crypto layer.
 */

const assert = require('assert');
const { randomBytes } = require('crypto');
const nodeEcc = require('../modules/bitshares-native/crypto/ecc');
const browserEcc = require('../modules/bitshares-native/crypto/ecc.browser');

const hex = (b) => Buffer.from(b).toString('hex');
const u8 = (b) => new Uint8Array(b);

async function main() {
    let checks = 0;
    const assertEqualBytes = (label, nodeVal, browserVal) => {
        checks++;
        assert.strictEqual(
            hex(nodeVal),
            hex(browserVal),
            `ECC divergence: ${label}\n  node=${hex(nodeVal)}\n  brow=${hex(browserVal)}`
        );
    };

    // ── Hash functions ──────────────────────────────────────────────
    for (const method of ['sha256', 'sha512', 'ripemd160', 'hash160', 'hash256']) {
        const data = randomBytes(48);
        assertEqualBytes(method, nodeEcc[method](data), await browserEcc[method](u8(data)));
    }

    // ── Keys / sign / verify / recover / DER / WIF ──────────────────
    for (let i = 0; i < 32; i++) {
        const priv = randomBytes(32);
        const digest = randomBytes(32);

        const nPubC = nodeEcc.privateKeyToPublicKey(priv, true);
        assertEqualBytes(`pubkeyC${i}`, nPubC, await browserEcc.privateKeyToPublicKey(u8(priv), true));
        assertEqualBytes(
            `pubkeyU${i}`,
            nodeEcc.privateKeyToPublicKey(priv, false),
            await browserEcc.privateKeyToPublicKey(u8(priv), false)
        );

        const nSig = nodeEcc.sign(digest, priv);
        assertEqualBytes(`signature${i}`, nSig, await browserEcc.sign(u8(digest), u8(priv)));

        const r = nSig.slice(1, 33);
        const s = nSig.slice(33, 65);
        const recoveryId = nSig[0] - 27 - 4;
        assertEqualBytes(
            `recover${i}`,
            nodeEcc.recoverPublicKey(digest, r, s, recoveryId),
            browserEcc.recoverPublicKey(u8(digest), u8(r), u8(s), recoveryId)
        );

        checks++;
        assert.strictEqual(
            nodeEcc.verify(digest, nSig, nPubC),
            await browserEcc.verify(u8(digest), u8(nSig), u8(nPubC)),
            'verify mismatch'
        );

        assertEqualBytes(`derSignature${i}`, nodeEcc.buildSignatureDer(r, s), browserEcc.buildSignatureDer(u8(r), u8(s)));
        assertEqualBytes(`derPublicKey${i}`, nodeEcc.buildPublicKeyDer(nPubC), browserEcc.buildPublicKeyDer(u8(nPubC)));

        const nWif = nodeEcc.wifEncode(priv);
        const bWif = await browserEcc.wifEncode(u8(priv));
        checks++;
        assert.strictEqual(nWif, bWif, 'wifEncode mismatch');
        const nDecoded = nodeEcc.wifDecode(nWif);
        const bDecoded = await browserEcc.wifDecode(bWif);
        assertEqualBytes(`wifPrivateKey${i}`, nDecoded.privateKey, bDecoded.privateKey);
        checks++;
        assert.strictEqual(nDecoded.compressed, bDecoded.compressed, 'wif compressed mismatch');

        assertEqualBytes(
            `publicKeyString${i}`,
            Buffer.from(nodeEcc.publicKeyToString(nPubC)),
            Buffer.from(await browserEcc.publicKeyToString(u8(nPubC)))
        );
        assertEqualBytes(
            `address${i}`,
            Buffer.from(nodeEcc.addressFromPublicKey(nPubC)),
            Buffer.from(await browserEcc.addressFromPublicKey(u8(nPubC)))
        );
    }

    // ── Brain keys ──────────────────────────────────────────────────
    for (let i = 0; i < 8; i++) {
        assertEqualBytes(
            `normalizeBrainKey${i}`,
            nodeEcc.normalizeBrainKey(`account ${i}`, 'owner', `password ${i}`),
            await browserEcc.normalizeBrainKey(`account ${i}`, 'owner', `password ${i}`)
        );
        assertEqualBytes(
            `brainKeyToPrivateKey${i}`,
            nodeEcc.brainKeyToPrivateKey(`brain key ${i}`, i),
            await browserEcc.brainKeyToPrivateKey(`brain key ${i}`, i)
        );
    }

    console.log(`native ECC equivalence tests passed (${checks} checks)`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
