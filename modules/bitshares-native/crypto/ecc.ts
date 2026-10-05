'use strict';

import { createHash, createHmac, randomBytes as cryptoRandomBytes, createECDH } from '../../crypto/sync.js';
import { base58Encode as _base58Encode, base58Decode as _base58Decode, encode as base58CheckEncode, decode as _base58CheckDecode } from '../../utils/base58check.js';
import {
    secp256k1,
    bigIntFromBuffer,
    bufferFromBigInt,
} from '../../crypto/pure_secp256k1.js';
import {
    isValidPrivateKeyBytes,
    recoverPublicKeyBytes,
    verifyBytes,
    buildSignatureFromK,
    buildPublicKeyDer as buildPublicKeyDerCore,
    buildSignatureDer as buildSignatureDerCore,
    wifDecodePayload,
} from './ecc_core.js';

interface WifDecodeResult {
    privateKey: Buffer;
    compressed: boolean;
}

function sha256(data: Buffer): Buffer {
    return createHash('sha256').update(data).digest();
}

function hmacSha256(key: Buffer, data: Buffer): Buffer {
    return createHmac('sha256', key).update(data).digest();
}

function sha512(data: Buffer | string): Buffer {
    return createHash('sha512').update(data).digest();
}

function ripemd160(data: Buffer): Buffer {
    return createHash('ripemd160').update(data).digest();
}

function hash160(data: Buffer): Buffer {
    return ripemd160(sha256(data));
}

function hash256(data: Buffer): Buffer {
    return sha256(sha256(data));
}

function randomBytes(length: number): Buffer {
    return cryptoRandomBytes(length);
}

function generatePrivateKey(): Buffer {
    let key: Buffer;
    do {
        key = randomBytes(32);
    } while (!isValidPrivateKey(key));
    return key;
}

function isValidPrivateKey(rawKey: Buffer): boolean {
    if (!Buffer.isBuffer(rawKey) || rawKey.length !== 32) return false;
    return isValidPrivateKeyBytes(rawKey);
}

function privateKeyToPublicKey(rawKey: Buffer, compressed = true): Buffer {
    if (!Buffer.isBuffer(rawKey) || rawKey.length !== 32) {
        throw new Error('Invalid private key: must be 32 bytes');
    }
    const ecdh = createECDH('secp256k1');
    ecdh.setPrivateKey(rawKey);
    return ecdh.getPublicKey(null, compressed ? 'compressed' : 'uncompressed');
}

function publicKeyFromBuffer(pubKeyBuffer: Buffer): Buffer {
    if (!Buffer.isBuffer(pubKeyBuffer)) {
        throw new Error('public key must be a Buffer');
    }
    return pubKeyBuffer;
}

function deterministicK(digest: Buffer, privateKey: Buffer, counter = 0): bigint {
    const x = bufferFromBigInt(bigIntFromBuffer(privateKey), 32);
    const h1 = bufferFromBigInt(bigIntFromBuffer(digest) % secp256k1.n, 32);

    let K: Buffer<ArrayBufferLike> = Buffer.alloc(32, 0x00);
    let V: Buffer<ArrayBufferLike> = Buffer.alloc(32, 0x01);

    K = hmacSha256(K, Buffer.concat([V, Buffer.from([0x00]), x, h1]));
    V = hmacSha256(K, V);
    K = hmacSha256(K, Buffer.concat([V, Buffer.from([0x01]), x, h1]));
    V = hmacSha256(K, V);

    let retry = false;

    function rfc6979Generate(): Buffer<ArrayBufferLike> {
        if (retry) {
            K = hmacSha256(K, Buffer.concat([V, Buffer.from([0x00])]));
            V = hmacSha256(K, V);
        }
        V = hmacSha256(K, V);
        const output = Buffer.from(V);
        retry = true;
        return output;
    }

    const total = counter + 2;
    let lastOutput: Buffer<ArrayBufferLike>;
    for (let i = 0; i < total; i++) {
        lastOutput = rfc6979Generate();
    }

    const candidate = bigIntFromBuffer(lastOutput!);
    if (candidate > 0n && candidate < secp256k1.n) {
        return candidate;
    }
    return 0n;
}

function recoverPublicKey(digest: Buffer, r: Buffer, s: Buffer, recoveryId: number): Buffer {
    return Buffer.from(recoverPublicKeyBytes(digest, r, s, recoveryId));
}

function sign(digest: Buffer, privateKey: Buffer): Buffer {
    if (!Buffer.isBuffer(digest) || digest.length !== 32) {
        throw new Error('Digest must be 32 bytes');
    }
    if (!Buffer.isBuffer(privateKey) || privateKey.length !== 32) {
        throw new Error('Private key must be 32 bytes');
    }

    const pubKeyKnown = privateKeyToPublicKey(privateKey, true);

    const MAX_SIGN_RETRIES = 256;
    let nonce = 0;
    while (nonce < MAX_SIGN_RETRIES) {
        const k = deterministicK(digest, privateKey, nonce);
        const signature = buildSignatureFromK(digest, privateKey, pubKeyKnown, k);
        if (signature) return Buffer.from(signature);
        nonce++;
    }
    throw new Error(`Failed to produce valid signature after ${MAX_SIGN_RETRIES} retries`);
}

function verify(digest: Buffer, signature: Buffer, publicKey: Buffer | string): boolean {
    if (!Buffer.isBuffer(digest) || digest.length !== 32) {
        throw new Error('Digest must be 32 bytes');
    }
    return verifyBytes(digest, signature, publicKey);
}

function buildPublicKeyDer(compressedPub: Buffer): Buffer {
    return Buffer.from(buildPublicKeyDerCore(compressedPub));
}

function buildSignatureDer(r: Buffer, s: Buffer): Buffer {
    return Buffer.from(buildSignatureDerCore(r, s));
}

function wifEncode(privateKey: Buffer, compressed = true): string {
    if (!Buffer.isBuffer(privateKey) || privateKey.length !== 32) {
        throw new Error('Private key must be 32 bytes');
    }
    const prefix = Buffer.from([0x80]);
    let payload = Buffer.concat([prefix, privateKey]);
    if (compressed) {
        payload = Buffer.concat([payload, Buffer.from([0x01])]);
    }
    return base58CheckEncode(payload);
}

function wifDecode(wif: string): WifDecodeResult {
    const { privateKey, compressed } = wifDecodePayload(base58CheckDecode(wif));
    return { privateKey: Buffer.from(privateKey), compressed };
}

function base58Encode(buf: Buffer): string {
    return _base58Encode(buf);
}

function base58Decode(str: string): Buffer {
    return Buffer.from(_base58Decode(str));
}

function base58CheckDecode(str: string): Buffer {
    return Buffer.from(_base58CheckDecode(str));
}

function normalizeBrainKey(name: string, role: string, password: string): Buffer {
    const combined = `${name} ${role} ${password}`.replace(/\s+/g, ' ').trim();
    return sha256(sha512(combined));
}

function brainKeyToPrivateKey(brainKey: Buffer | string, sequence = 0): Buffer {
    const seq = ` ${sequence}`;
    return sha256(sha512(brainKey + seq));
}

function publicKeyToString(pubKeyBuf: Buffer, addressPrefix = 'BTS'): string {
    const checksum = sha256(pubKeyBuf).slice(0, 4);
    return addressPrefix + base58Encode(Buffer.concat([pubKeyBuf, checksum]));
}

function addressFromPublicKey(pubKeyBuf: Buffer, addressPrefix = 'BTS'): string {
    const hash = ripemd160(sha512(pubKeyBuf));
    const checksum = ripemd160(hash).slice(0, 4);
    return addressPrefix + base58Encode(Buffer.concat([hash, checksum]));
}

export { sha256, sha512, ripemd160, hash160, hash256, randomBytes, generatePrivateKey, isValidPrivateKey, privateKeyToPublicKey, sign, verify, recoverPublicKey, wifEncode, wifDecode, normalizeBrainKey, brainKeyToPrivateKey, publicKeyToString, addressFromPublicKey, publicKeyFromBuffer, base58Encode, base58Decode, base58CheckEncode, base58CheckDecode, buildSignatureDer, buildPublicKeyDer, secp256k1 }

