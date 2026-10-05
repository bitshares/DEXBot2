// @ts-nocheck — TypeScript Uint8Array generic parameter quirks are
// not relevant for this browser-targeted file.
'use strict';
/**
 * Browser-portable ECC — pure-JS secp256k1 operations.
 * Drop-in replacement for ecc.ts in browser contexts.
 *
 * Uses:
 *   - CryptoProvider for hashing, HMAC, randomBytes
 *   - pure_secp256k1 for EC point math
 *   - pure_ripemd160 for RIPEMD-160
 *   - Uint8Array everywhere (no Buffer)
 *
 * Exports the same API shape as ecc.ts (async where hashing/crypto is needed).
 */

import { getCrypto } from '../../crypto/index.js';
import * as pureSecp from '../../crypto/pure_secp256k1.js';

import { base58Encode as _base58Encode, base58Decode as _base58Decode, encodeAsync as base58CheckEncode, decodeAsync as base58CheckDecode } from '../../utils/base58check.js';
import * as core from './ecc_core.js';
const secp256k1 = pureSecp.secp256k1;
const concatBytes = pureSecp.concatBytes;

// ── Hashing (async, via CryptoProvider) ─────────────────────────────

async function sha256(data: Uint8Array): Promise<Uint8Array> {
    return getCrypto().sha256(data);
}

async function sha512(data: Uint8Array): Promise<Uint8Array> {
    return getCrypto().sha512(data);
}

async function ripemd160(data: Uint8Array): Promise<Uint8Array> {
    return getCrypto().ripemd160(data);
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    return getCrypto().hmacSha256(key, data);
}

async function hash160(data: Uint8Array): Promise<Uint8Array> {
    return ripemd160(await sha256(data));
}

async function hash256(data: Uint8Array): Promise<Uint8Array> {
    return sha256(await sha256(data));
}

async function randomBytes(length: number): Promise<Uint8Array> {
    return getCrypto().randomBytes(length);
}

// ── Key generation / validation ─────────────────────────────────────

function bigIntFromBuffer(buf: Uint8Array): bigint {
    return pureSecp.bigIntFromBuffer(buf);
}

function bufferFromBigInt(bn: bigint, length = 32): Uint8Array {
    return pureSecp.bufferFromBigInt(bn, length);
}

function isValidPrivateKey(rawKey: Uint8Array): boolean {
    return core.isValidPrivateKeyBytes(rawKey);
}

async function generatePrivateKey(): Promise<Uint8Array> {
    let key: Uint8Array;
    do {
        key = await randomBytes(32);
    } while (!isValidPrivateKey(key));
    return key;
}

async function privateKeyToPublicKey(rawKey: Uint8Array, compressed = true): Promise<Uint8Array> {
    if (rawKey.length !== 32) throw new Error('Invalid private key: must be 32 bytes');
    return pureSecp.privateKeyToPublicKey(rawKey, compressed);
}

// ── Deterministic K (RFC 6979) ─────────────────────────────────────

async function deterministicK(digest: Uint8Array, privateKey: Uint8Array, counter = 0): Promise<bigint> {
    const x = bufferFromBigInt(bigIntFromBuffer(privateKey), 32);
    const h1 = bufferFromBigInt(bigIntFromBuffer(digest) % secp256k1.n, 32);
    const zero = new Uint8Array(1);
    const one = new Uint8Array([0x01]);
    const empty = new Uint8Array(0);

    let K = new Uint8Array(32);
    let V = new Uint8Array(32).fill(0x01);

    K = new Uint8Array(await hmacSha256(K, concatBytes(V, zero, x, h1)));
    V = new Uint8Array(await hmacSha256(K, V));
    K = new Uint8Array(await hmacSha256(K, concatBytes(V, one, x, h1)));
    V = new Uint8Array(await hmacSha256(K, V));

    let retry = false;
    const rfc6979Generate = async (): Promise<Uint8Array> => {
        if (retry) {
            K = new Uint8Array(await hmacSha256(K, concatBytes(V, zero)));
            V = new Uint8Array(await hmacSha256(K, V));
        }
        V = new Uint8Array(await hmacSha256(K, V));
        const output = new Uint8Array(V);
        retry = true;
        return output;
    };

    const total = counter + 2;
    let lastOutput: Uint8Array;
    for (let i = 0; i < total; i++) {
        lastOutput = await rfc6979Generate();
    }

    const candidate = bigIntFromBuffer(lastOutput!);
    if (candidate > 0n && candidate < secp256k1.n) return candidate;
    return 0n;
}

// ── Recovery ────────────────────────────────────────────────────────

function recoverPublicKey(digest: Uint8Array, r: Uint8Array, s: Uint8Array, recoveryId: number): Uint8Array {
    return core.recoverPublicKeyBytes(digest, r, s, recoveryId);
}

// ── Sign / Verify ───────────────────────────────────────────────────

async function sign(digest: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array> {
    if (digest.length !== 32) throw new Error('Digest must be 32 bytes');
    if (privateKey.length !== 32) throw new Error('Private key must be 32 bytes');

    const pubKeyKnown = await privateKeyToPublicKey(privateKey, true);

    const MAX_SIGN_RETRIES = 256;
    let nonce = 0;
    while (nonce < MAX_SIGN_RETRIES) {
        const k = await deterministicK(digest, privateKey, nonce);
        const signature = core.buildSignatureFromK(digest, privateKey, pubKeyKnown, k);
        if (signature) return signature;
        nonce++;
    }
    throw new Error(`Failed to produce valid signature after ${MAX_SIGN_RETRIES} retries`);
}

async function verify(digest: Uint8Array, signature: Uint8Array, publicKey: Uint8Array | string): Promise<boolean> {
    if (digest.length !== 32) throw new Error('Digest must be 32 bytes');
    return core.verifyBytes(digest, signature, publicKey);
}

// ── Base58 (wrappers around shared utils) ───────────────────────────

function base58Encode(buf: Uint8Array): string {
    return _base58Encode(buf);
}

function base58Decode(str: string): Uint8Array {
    return _base58Decode(str);
}

// ── WIF ─────────────────────────────────────────────────────────────

interface WifDecodeResult {
    privateKey: Uint8Array;
    compressed: boolean;
}

async function wifEncode(privateKey: Uint8Array, compressed = true): Promise<string> {
    if (privateKey.length !== 32) throw new Error('Private key must be 32 bytes');
    let payload = concatBytes(new Uint8Array([0x80]), privateKey);
    if (compressed) payload = concatBytes(payload, new Uint8Array([0x01]));
    return base58CheckEncode(payload);
}

async function wifDecode(wif: string): Promise<WifDecodeResult> {
    return core.wifDecodePayload(await base58CheckDecode(wif));
}

// ── DER encoding ────────────────────────────────────────────────────

function buildPublicKeyDer(compressedPub: Uint8Array): Uint8Array {
    return core.buildPublicKeyDer(compressedPub);
}

function buildSignatureDer(r: Uint8Array, s: Uint8Array): Uint8Array {
    return core.buildSignatureDer(r, s);
}

// ── Brain key ───────────────────────────────────────────────────────

async function normalizeBrainKey(name: string, role: string, password: string): Promise<Uint8Array> {
    const combined = `${name} ${role} ${password}`.replace(/\s+/g, ' ').trim();
    return sha256(await sha512(new TextEncoder().encode(combined)));
}

async function brainKeyToPrivateKey(brainKey: Uint8Array | string, sequence = 0): Promise<Uint8Array> {
    const seq = ` ${sequence}`;
    const combined = typeof brainKey === 'string'
        ? brainKey + seq
        : new TextDecoder().decode(brainKey) + seq;
    return sha256(await sha512(new TextEncoder().encode(combined)));
}

// ── Address formatting ──────────────────────────────────────────────

async function publicKeyToString(pubKeyBuf: Uint8Array, addressPrefix = 'BTS'): Promise<string> {
    const csum = (await sha256(pubKeyBuf)).slice(0, 4);
    return addressPrefix + base58Encode(concatBytes(pubKeyBuf, csum));
}

async function addressFromPublicKey(pubKeyBuf: Uint8Array, addressPrefix = 'BTS'): Promise<string> {
    const hash = await ripemd160(await sha512(pubKeyBuf));
    const csum = (await ripemd160(hash)).slice(0, 4);
    return addressPrefix + base58Encode(concatBytes(hash, csum));
}

function publicKeyFromBuffer(pubKeyBuffer: Uint8Array): Uint8Array {
    return pubKeyBuffer;
}

// ── Exports ─────────────────────────────────────────────────────────

export { sha256, sha512, ripemd160, hash160, hash256, randomBytes, generatePrivateKey, isValidPrivateKey, privateKeyToPublicKey, sign, verify, recoverPublicKey, wifEncode, wifDecode, normalizeBrainKey, brainKeyToPrivateKey, publicKeyToString, addressFromPublicKey, publicKeyFromBuffer, base58Encode, base58Decode, base58CheckEncode, base58CheckDecode, buildSignatureDer, buildPublicKeyDer, secp256k1 }

