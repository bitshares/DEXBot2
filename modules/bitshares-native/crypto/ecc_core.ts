'use strict';

/**
 * modules/bitshares-native/crypto/ecc_core.ts
 *
 * Pure, platform-neutral ECC core shared by the Node implementation
 * (ecc.ts — sync, Buffer) and the browser implementation
 * (ecc.browser.ts — async, Uint8Array).
 *
 * Everything here operates only on Uint8Array and the pure-JS secp256k1 math
 * in pure_secp256k1.ts, so it is safe for both targets. The platform files
 * keep ownership of the two things that genuinely differ: sync-vs-async
 * hashing/HMAC orchestration, and Buffer-vs-Uint8Array at the API boundary.
 *
 * Verified byte-for-byte against both implementations by
 * tests/test_native_ecc_equivalence.ts.
 */

import {
    secp256k1,
    SECP256K1_BASE_POINT,
    bigIntFromBuffer,
    bufferFromBigInt,
    mod,
    modPow,
    modInverse,
    ecPointMul,
    ecPointAdd,
    publicKeyFromPoint,
    pointFromPublicKey,
    bytesFromHex,
    concatBytes,
} from '../../crypto/pure_secp256k1.js';
import type { EcPoint } from '../../crypto/provider.js';

function equalsBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function isValidPrivateKeyBytes(rawKey: Uint8Array): boolean {
    if (!rawKey || rawKey.length !== 32) return false;
    const keyInt = bigIntFromBuffer(rawKey);
    return keyInt > 0n && keyInt < secp256k1.n;
}

/**
 * Recover the compressed public key for a signature component (r, s) and a
 * recovery id. Throws when the recovery parameters are not resolvable to a
 * point on the curve.
 */
function recoverPublicKeyBytes(digest: Uint8Array, r: Uint8Array, s: Uint8Array, recoveryId: number): Uint8Array {
    const n = secp256k1.n;
    const rBig = bigIntFromBuffer(r);
    const sBig = bigIntFromBuffer(s);
    const e = bigIntFromBuffer(digest) % n;

    if (rBig < 1n || rBig >= n || sBig < 1n || sBig >= n) {
        throw new Error('Invalid signature parameters');
    }

    const isYOdd = recoveryId & 1;
    const recoveryGroup = recoveryId >> 1;
    const x = rBig + BigInt(recoveryGroup) * n;
    if (x >= secp256k1.p) {
        throw new Error('Invalid recovery point');
    }

    const alpha = (x * x * x + secp256k1.a * x + secp256k1.b) % secp256k1.p;
    let y = modPow(alpha, (secp256k1.p + 1n) / 4n, secp256k1.p);
    if ((y & 1n) !== BigInt(isYOdd)) {
        y = secp256k1.p - y;
    }

    const R: EcPoint = { x, y };

    const rInv = modInverse(rBig, n);
    const eNeg = (n - (e % n)) % n;
    const sr = ecPointMul(R, sBig);
    const eGNeg = ecPointMul(SECP256K1_BASE_POINT, eNeg);
    if (!sr || !eGNeg) {
        throw new Error('Failed to compute recovery terms');
    }
    const sum = ecPointAdd(sr, eGNeg);
    if (!sum) {
        throw new Error('Failed to recover public key point');
    }
    const Q = ecPointMul(sum, rInv);
    if (!Q) {
        throw new Error('Failed to recover public key');
    }
    return publicKeyFromPoint(Q);
}

/**
 * ECDSA verify over raw bytes. `publicKey` may be a compressed/uncompressed
 * public key or a hex string. Returns false (rather than throwing) for
 * out-of-range signature components or an unresolvable point.
 */
function verifyBytes(digest: Uint8Array, signature: Uint8Array, publicKey: Uint8Array | string): boolean {
    let r: Uint8Array;
    let s: Uint8Array;
    if (signature.length === 65) {
        r = signature.slice(1, 33);
        s = signature.slice(33, 65);
    } else if (signature.length === 64) {
        r = signature.slice(0, 32);
        s = signature.slice(32, 64);
    } else {
        throw new Error('Invalid signature length: ' + signature.length);
    }

    const rBig = bigIntFromBuffer(r);
    const sBig = bigIntFromBuffer(s);
    if (rBig <= 0n || rBig >= secp256k1.n || sBig <= 0n || sBig >= secp256k1.n) {
        return false;
    }

    const pubBuf = typeof publicKey === 'string' ? bytesFromHex(publicKey) : publicKey;
    const Q = pointFromPublicKey(pubBuf);
    const e = bigIntFromBuffer(digest) % secp256k1.n;
    const w = modInverse(sBig, secp256k1.n);
    const u1 = mod(e * w, secp256k1.n);
    const u2 = mod(rBig * w, secp256k1.n);
    const point = ecPointAdd(
        ecPointMul(SECP256K1_BASE_POINT, u1),
        ecPointMul(Q, u2)
    );

    if (!point) return false;
    return mod(point.x, secp256k1.n) === rBig;
}

/**
 * Build a compact (65-byte, header = recoveryId + 31) signature from a
 * deterministic nonce k. Returns null when the candidate is not a valid,
 * low-S, recoverable signature (the caller then tries the next nonce).
 * `pubKeyKnown` is used to select the recovery id.
 */
function buildSignatureFromK(
    digest: Uint8Array,
    privateKey: Uint8Array,
    pubKeyKnown: Uint8Array,
    k: bigint
): Uint8Array | null {
    const d = bigIntFromBuffer(privateKey);
    const e = bigIntFromBuffer(digest) % secp256k1.n;
    const nHalf = secp256k1.n >> 1n;

    const R = ecPointMul(SECP256K1_BASE_POINT, k);
    const rBig = R ? R.x % secp256k1.n : 0n;
    if (!R || rBig === 0n) return null;

    let sBig = mod(modInverse(k, secp256k1.n) * (e + rBig * d), secp256k1.n);
    if (sBig === 0n) return null;

    let recoveryId = (R.y & 1n) === 1n ? 1 : 0;
    if (R.x >= secp256k1.n) recoveryId |= 2;
    if (sBig > nHalf) {
        sBig = secp256k1.n - sBig;
        recoveryId ^= 1;
    }

    const rBuf = bufferFromBigInt(rBig, 32);
    const sBuf = bufferFromBigInt(sBig, 32);

    if (!(rBuf[0] < 0x80 && (rBuf[0] !== 0 || rBuf[1] >= 0x80))) return null;
    if (!(sBuf[0] < 0x80 && (sBuf[0] !== 0 || sBuf[1] >= 0x80))) return null;

    for (let i = 0; i < 4; i++) {
        try {
            const recovered = recoverPublicKeyBytes(digest, rBuf, sBuf, i);
            if (equalsBytes(recovered, pubKeyKnown)) {
                recoveryId = i;
                break;
            }
        } catch (_) {
            // Try the next recovery id.
        }
    }
    if (recoveryId < 0 || recoveryId > 3) return null;

    const compactHeader = recoveryId + 27 + 4;
    return concatBytes(new Uint8Array([compactHeader]), rBuf, sBuf);
}

function buildPublicKeyDer(compressedPub: Uint8Array): Uint8Array {
    let point: Uint8Array;
    if (compressedPub.length === 64) {
        point = concatBytes(new Uint8Array([0x04]), compressedPub);
    } else if (compressedPub.length === 33) {
        const prefix = compressedPub[0];
        const x = bigIntFromBuffer(compressedPub.slice(1, 33));
        const x3 = x * x * x;
        const ySq = (x3 + secp256k1.b) % secp256k1.p;
        let y = modPow(ySq, (secp256k1.p + 1n) / 4n, secp256k1.p);
        if ((y & 1n) !== BigInt(prefix === 0x03)) {
            y = secp256k1.p - y;
        }
        point = concatBytes(new Uint8Array([0x04]), bufferFromBigInt(x, 32), bufferFromBigInt(y, 32));
    } else if (compressedPub.length === 65) {
        point = compressedPub;
    } else {
        throw new Error('Unsupported public key length: ' + compressedPub.length);
    }

    const seqHeader = bytesFromHex('3056301006072a8648ce3d020106052b8104000a034200');
    return concatBytes(seqHeader, point);
}

function buildSignatureDer(r: Uint8Array, s: Uint8Array): Uint8Array {
    const encodeInt = (buf: Uint8Array): Uint8Array => {
        let data = buf;
        if (data[0] & 0x80) {
            data = concatBytes(new Uint8Array([0x00]), data);
        }
        return concatBytes(new Uint8Array([0x02, data.length]), data);
    };

    const rEnc = encodeInt(r);
    const sEnc = encodeInt(s);
    return concatBytes(new Uint8Array([0x30, rEnc.length + sEnc.length]), rEnc, sEnc);
}

/**
 * Validate a decoded WIF payload and extract the private key bytes.
 * Throws on malformed payloads so both wrappers report identical errors.
 */
function wifDecodePayload(payload: Uint8Array): { privateKey: Uint8Array; compressed: boolean } {
    if (!payload || payload.length < 33) {
        throw new Error('Invalid WIF: too short');
    }
    if (payload[0] !== 0x80) {
        throw new Error('Invalid WIF: wrong version byte');
    }
    const compressed = payload.length === 34 && payload[33] === 0x01;
    const privateKey = payload.slice(1, 33);
    if (!isValidPrivateKeyBytes(privateKey)) {
        throw new Error('Invalid WIF: invalid private key');
    }
    return { privateKey, compressed };
}

export {
    equalsBytes,
    isValidPrivateKeyBytes,
    recoverPublicKeyBytes,
    verifyBytes,
    buildSignatureFromK,
    buildPublicKeyDer,
    buildSignatureDer,
    wifDecodePayload,
};
