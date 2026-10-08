/**
 * Pure-JS secp256k1 elliptic curve math.
 * No Node.js crypto dependency — uses native bigint arithmetic.
 * No Buffer dependency — uses plain Uint8Array for cross-platform use.
 * Extracted from modules/bitshares-native/crypto/ecc.ts.
 */

import type { EcPoint } from './provider.js';

// ── Cross-platform byte helpers (no Buffer dependency) ──────────────────────

function bytesFromHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}

function hexFromBytes(bytes: Uint8Array): string {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
    const totalLen = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}

// ── secp256k1 curve constants ──────────────────────────────────────────────

const secp256k1 = {
    p: BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F'),
    n: BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141'),
    Gx: BigInt('0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798'),
    Gy: BigInt('0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8'),
    a: BigInt(0),
    b: BigInt(7),
};

const SECP256K1_BASE_POINT: EcPoint = {
    x: secp256k1.Gx,
    y: secp256k1.Gy,
};

// ── BigInt / byte conversion helpers ────────────────────────────────────────

function bigIntFromBuffer(buf: Uint8Array): bigint {
    return BigInt('0x' + hexFromBytes(buf));
}

function bufferFromBigInt(bn: bigint, length = 32): Uint8Array {
    let hex = bn.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    if (hex.length > length * 2) {
        throw new Error(`BigInt 0x${bn.toString(16)} exceeds requested byte length ${length}`);
    }
    if (hex.length < length * 2) hex = hex.padStart(length * 2, '0');
    return bytesFromHex(hex);
}

// ── Modular arithmetic ─────────────────────────────────────────────────────

function mod(value: bigint, modulus: bigint): bigint {
    return ((value % modulus) + modulus) % modulus;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
    let result = 1n;
    base = base % mod;
    while (exp > 0n) {
        if (exp & 1n) result = (result * base) % mod;
        exp >>= 1n;
        base = (base * base) % mod;
    }
    return result;
}

function modInverse(a: bigint, n: bigint): bigint {
    let [t, newT] = [0n, 1n];
    let [r, newR] = [n, a];
    while (newR !== 0n) {
        const quotient = r / newR;
        [t, newT] = [newT, t - quotient * newT];
        [r, newR] = [newR, r - quotient * newR];
    }
    if (r > 1n) throw new Error('modular inverse does not exist');
    if (t < 0n) t += n;
    return t;
}

// ── Elliptic curve point operations ────────────────────────────────────────
//
// Points are held in Jacobian projective coordinates internally so that a
// scalar multiplication performs exactly ONE field inversion (at the very
// end) instead of one per point addition/doubling. The previous affine
// implementation called `modInverse` on every step, which made signing and
// public-key derivation an order of magnitude slower on the pure-JS path.
//
// A Jacobian point (X, Y, Z) represents the affine point (X/Z^2, Y/Z^3);
// Z === 0n is the point at infinity.

interface JacobianPoint {
    x: bigint;
    y: bigint;
    z: bigint;
}

function toJacobian(point: EcPoint | null): JacobianPoint {
    if (!point) return { x: 0n, y: 1n, z: 0n };
    return { x: point.x, y: point.y, z: 1n };
}

function fromJacobian(point: JacobianPoint): EcPoint | null {
    const p = secp256k1.p;
    if (point.z === 0n) return null;
    const zInv = modInverse(point.z, p);
    const zInv2 = mod(zInv * zInv, p);
    return {
        x: mod(point.x * zInv2, p),
        y: mod(point.y * zInv2 * zInv, p),
    };
}

function jacobianDouble(point: JacobianPoint): JacobianPoint {
    const p = secp256k1.p;
    if (point.z === 0n || point.y === 0n) return { x: 0n, y: 1n, z: 0n };
    const xx = mod(point.x * point.x, p);
    const yy = mod(point.y * point.y, p);
    const yyyy = mod(yy * yy, p);
    // a = 0, so M = 3*X^2
    const m = mod(3n * xx, p);
    const s = mod(4n * point.x * yy, p);
    const x3 = mod(m * m - 2n * s, p);
    const y3 = mod(m * (s - x3) - 8n * yyyy, p);
    const z3 = mod(2n * point.y * point.z, p);
    return { x: x3, y: y3, z: z3 };
}

function jacobianAdd(p1: JacobianPoint, p2: JacobianPoint): JacobianPoint {
    const p = secp256k1.p;
    if (p1.z === 0n) return p2;
    if (p2.z === 0n) return p1;
    const z1z1 = mod(p1.z * p1.z, p);
    const z2z2 = mod(p2.z * p2.z, p);
    const u1 = mod(p1.x * z2z2, p);
    const u2 = mod(p2.x * z1z1, p);
    const s1 = mod(p1.y * p2.z * z2z2, p);
    const s2 = mod(p2.y * p1.z * z1z1, p);
    const h = mod(u2 - u1, p);
    const r = mod(s2 - s1, p);
    if (h === 0n) {
        if (r === 0n) return jacobianDouble(p1);
        return { x: 0n, y: 1n, z: 0n };
    }
    const hh = mod(h * h, p);
    const hhh = mod(h * hh, p);
    const v = mod(u1 * hh, p);
    const x3 = mod(r * r - hhh - 2n * v, p);
    const y3 = mod(r * (v - x3) - s1 * hhh, p);
    const z3 = mod(p1.z * p2.z * h, p);
    return { x: x3, y: y3, z: z3 };
}

function jacobianMul(point: JacobianPoint, scalar: bigint): JacobianPoint {
    let result: JacobianPoint = { x: 0n, y: 1n, z: 0n };
    let addend = point;
    let s = scalar;
    while (s > 0n) {
        if (s & 1n) result = jacobianAdd(result, addend);
        addend = jacobianDouble(addend);
        s >>= 1n;
    }
    return result;
}

function ecPointMul(point: EcPoint, scalar: bigint): EcPoint | null {
    if (scalar === 0n) return null;
    if (scalar < 0n) {
        return ecPointMul({ x: point.x, y: secp256k1.p - point.y }, -scalar);
    }
    return fromJacobian(jacobianMul(toJacobian(point), scalar));
}

function ecPointAdd(a: EcPoint | null, b: EcPoint | null): EcPoint | null {
    if (!a) return b;
    if (!b) return a;
    return fromJacobian(jacobianAdd(toJacobian(a), toJacobian(b)));
}

function ecPointDouble(point: EcPoint): EcPoint {
    return fromJacobian(jacobianDouble(toJacobian(point)))!;
}

// ── Public key encoding/decoding ───────────────────────────────────────────

function publicKeyFromPoint(point: EcPoint): Uint8Array {
    const prefix = (point.y & 1n) === 1n ? 0x03 : 0x02;
    const xBuf = bufferFromBigInt(point.x, 32);
    return concatBytes(new Uint8Array([prefix]), xBuf);
}

function pointFromPublicKey(pubKeyBuffer: Uint8Array): EcPoint {
    const buf = pubKeyBuffer;
    if (buf.length === 33) {
        const prefix = buf[0];
        if (prefix !== 0x02 && prefix !== 0x03) {
            throw new Error('Unsupported compressed public key prefix');
        }
        const x = bigIntFromBuffer(buf.slice(1));
        const alpha = mod(x * x * x + secp256k1.a * x + secp256k1.b, secp256k1.p);
        let y = modPow(alpha, (secp256k1.p + 1n) / 4n, secp256k1.p);
        if ((y & 1n) !== BigInt(prefix & 1)) {
            y = secp256k1.p - y;
        }
        return { x, y };
    }
    if (buf.length === 65 && buf[0] === 0x04) {
        return {
            x: bigIntFromBuffer(buf.slice(1, 33)),
            y: bigIntFromBuffer(buf.slice(33, 65)),
        };
    }
    if (buf.length === 64) {
        return {
            x: bigIntFromBuffer(buf.slice(0, 32)),
            y: bigIntFromBuffer(buf.slice(32, 64)),
        };
    }
    throw new Error('Unsupported public key length: ' + buf.length);
}

// ── Public key derivation (pure-JS, no Node ECDH) ──────────────────────────

function privateKeyToPublicKey(rawKey: Uint8Array, compressed = true): Uint8Array {
    if (rawKey.length !== 32) {
        throw new Error('Invalid private key: must be 32 bytes');
    }
    const keyInt = bigIntFromBuffer(rawKey);
    const point = ecPointMul(SECP256K1_BASE_POINT, keyInt);
    if (!point) throw new Error('Failed to derive public key');
    if (compressed) return publicKeyFromPoint(point);
    return concatBytes(
        new Uint8Array([0x04]),
        bufferFromBigInt(point.x, 32),
        bufferFromBigInt(point.y, 32),
    );
}

export {
    bytesFromHex,
    concatBytes,
    secp256k1,
    SECP256K1_BASE_POINT,
    bigIntFromBuffer,
    bufferFromBigInt,
    mod,
    modPow,
    modInverse,
    ecPointMul,
    ecPointAdd,
    ecPointDouble,
    publicKeyFromPoint,
    pointFromPublicKey,
    privateKeyToPublicKey,
};
