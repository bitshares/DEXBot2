/**
 * Pure-JS scrypt implementation.
 * No Node.js dependency — uses only Uint8Array and bigint arithmetic.
 * Implements RFC 7914 using Web Crypto PBKDF2 for the outer HMAC-SHA256 steps.
 */

function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function salsa208Core(output: Uint32Array, input: Uint32Array): void {
  const x = new Uint32Array(16);
  for (let i = 0; i < 16; i++) x[i] = input[i];

  for (let i = 0; i < 8; i += 2) {
    x[4]  ^= rotl32(x[0]  + x[12] | 0, 7);
    x[8]  ^= rotl32(x[4]  + x[0]  | 0, 9);
    x[12] ^= rotl32(x[8]  + x[4]  | 0, 13);
    x[0]  ^= rotl32(x[12] + x[8]  | 0, 18);
    x[9]  ^= rotl32(x[5]  + x[1]  | 0, 7);
    x[13] ^= rotl32(x[9]  + x[5]  | 0, 9);
    x[1]  ^= rotl32(x[13] + x[9]  | 0, 13);
    x[5]  ^= rotl32(x[1]  + x[13] | 0, 18);
    x[14] ^= rotl32(x[10] + x[6]  | 0, 7);
    x[2]  ^= rotl32(x[14] + x[10] | 0, 9);
    x[6]  ^= rotl32(x[2]  + x[14] | 0, 13);
    x[10] ^= rotl32(x[6]  + x[2]  | 0, 18);
    x[3]  ^= rotl32(x[15] + x[11] | 0, 7);
    x[7]  ^= rotl32(x[3]  + x[15] | 0, 9);
    x[11] ^= rotl32(x[7]  + x[3]  | 0, 13);
    x[15] ^= rotl32(x[11] + x[7]  | 0, 18);

    x[1]  ^= rotl32(x[0]  + x[3]  | 0, 7);
    x[2]  ^= rotl32(x[1]  + x[0]  | 0, 9);
    x[3]  ^= rotl32(x[2]  + x[1]  | 0, 13);
    x[0]  ^= rotl32(x[3]  + x[2]  | 0, 18);
    x[6]  ^= rotl32(x[5]  + x[4]  | 0, 7);
    x[7]  ^= rotl32(x[6]  + x[5]  | 0, 9);
    x[4]  ^= rotl32(x[7]  + x[6]  | 0, 13);
    x[5]  ^= rotl32(x[4]  + x[7]  | 0, 18);
    x[11] ^= rotl32(x[10] + x[9]  | 0, 7);
    x[8]  ^= rotl32(x[11] + x[10] | 0, 9);
    x[9]  ^= rotl32(x[8]  + x[11] | 0, 13);
    x[10] ^= rotl32(x[9]  + x[8]  | 0, 18);
    x[12] ^= rotl32(x[15] + x[14] | 0, 7);
    x[13] ^= rotl32(x[12] + x[15] | 0, 9);
    x[14] ^= rotl32(x[13] + x[12] | 0, 13);
    x[15] ^= rotl32(x[14] + x[13] | 0, 18);
  }

  for (let i = 0; i < 16; i++) output[i] = (x[i] + input[i]) | 0;
}

function blockMix(output: Uint8Array, input: Uint8Array, r: number): void {
  const blockSize = 64;
  const x = new Uint32Array(16);
  const xView = new DataView(new ArrayBuffer(64));
  const xBytes = new Uint8Array(xView.buffer);
  const y = new Uint8Array(2 * r * blockSize);

  // X = B_{2r-1}
  const lastStart = (2 * r - 1) * blockSize;
  for (let i = 0; i < blockSize; i++) xBytes[i] = input[lastStart + i];

  for (let i = 0; i < 2 * r; i++) {
    // X = Salsa20/8(X XOR B_i)
    const biStart = i * blockSize;
    for (let j = 0; j < blockSize; j++) {
      xBytes[j] ^= input[biStart + j];
    }
    for (let j = 0; j < 16; j++) {
      x[j] = xView.getUint32(j * 4, true);
    }
    salsa208Core(x, x);
    for (let j = 0; j < 16; j++) {
      xView.setUint32(j * 4, x[j], true);
    }
    // Y_i = X
    const yiStart = i * blockSize;
    for (let j = 0; j < blockSize; j++) y[yiStart + j] = xBytes[j];
  }

  // output = Y_0, Y_2, ..., Y_{2r-2}, Y_1, Y_3, ..., Y_{2r-1}
  for (let i = 0; i < r; i++) {
    const srcIdx = i * 2 * blockSize;
    const dstIdx = i * blockSize;
    for (let j = 0; j < blockSize; j++) output[dstIdx + j] = y[srcIdx + j];
  }
  for (let i = 0; i < r; i++) {
    const srcIdx = (i * 2 + 1) * blockSize;
    const dstIdx = (r + i) * blockSize;
    for (let j = 0; j < blockSize; j++) output[dstIdx + j] = y[srcIdx + j];
  }
}

function integerify(b: Uint8Array, r: number): number {
  const offset = (2 * r - 1) * 64;
  return (b[offset] | (b[offset + 1] << 8) | (b[offset + 2] << 16) | (b[offset + 3] << 24)) >>> 0;
}

function xorBlock(dst: Uint8Array, a: Uint8Array, b: Uint8Array): void {
  for (let i = 0; i < dst.length; i++) dst[i] = a[i] ^ b[i];
}

function romixBlock(block: Uint8Array, N: number, r: number): void {
  const blockSize = 128 * r;
  const V = new Array(N);

  // Phase 1: fill V array
  V[0] = new Uint8Array(block);
  for (let i = 1; i < N; i++) {
    const prev = V[i - 1];
    const cur = new Uint8Array(blockSize);
    blockMix(cur, prev, r);
    V[i] = cur;
  }

  // Phase 2: start from X_N = BlockMix(X_{N-1}), the state at the end of
  // phase 1 per RFC 7914 section 5. V[N - 1] holds X_{N-1}; the block produced
  // by mixing it is X_N. (Starting from `block` here resets to X_0 and yields
  // a different key than native scrypt.)
  let X = new Uint8Array(blockSize);
  blockMix(X, V[N - 1], r);
  for (let i = 0; i < N; i++) {
    const j = integerify(X, r) % N;
    const vBlock = V[j];
    const tmp = new Uint8Array(blockSize);
    xorBlock(tmp, X, vBlock);
    blockMix(X, tmp, r);
  }

  for (let i = 0; i < blockSize; i++) block[i] = X[i];
}

interface SubtleLike {
  importKey(...args: unknown[]): Promise<unknown>;
  sign(...args: unknown[]): Promise<ArrayBuffer>;
}

async function pbkdf2HmacSha256(password: Uint8Array, salt: Uint8Array, iterations: number, keyLength: number): Promise<Uint8Array> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleLike } })?.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto API not available');

  // RFC 8018 block-wise PBKDF2-HMAC-SHA256. Deriving one HMAC block at a time
  // avoids Web Crypto deriveBits output-length limits (Firefox caps deriveBits,
  // which breaks scrypt's first call: p * 128 * r is 1024 bytes at r=8, p=1).
  const hLen = 32;
  // WebCrypto rejects zero-length HMAC keys, but HMAC zero-pads any key shorter
  // than its 64-byte block, so a single zero byte is equivalent to an empty key.
  const keyBytes = password.length === 0 ? new Uint8Array(1) : password;
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hmac = async (data: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(await subtle.sign('HMAC', key, data));

  const blocks = Math.ceil(keyLength / hLen);
  const dk = new Uint8Array(blocks * hLen);
  for (let block = 1; block <= blocks; block++) {
    // U_1 = HMAC(P, S || INT_32_BE(block))
    const saltBlock = new Uint8Array(salt.length + 4);
    saltBlock.set(salt, 0);
    saltBlock[salt.length] = (block >>> 24) & 0xff;
    saltBlock[salt.length + 1] = (block >>> 16) & 0xff;
    saltBlock[salt.length + 2] = (block >>> 8) & 0xff;
    saltBlock[salt.length + 3] = block & 0xff;

    let u = await hmac(saltBlock);
    const t = new Uint8Array(u);
    for (let i = 1; i < iterations; i++) {
      u = await hmac(u);
      for (let j = 0; j < hLen; j++) t[j] ^= u[j];
    }
    dk.set(t.subarray(0, Math.min(hLen, keyLength - (block - 1) * hLen)), (block - 1) * hLen);
  }
  return dk.subarray(0, keyLength);
}

/**
 * Pure-JS scrypt key derivation.
 * Uses Web Crypto PBKDF2 for HMAC-SHA256 steps, pure-JS Salsa20/8 for ROMix.
 * Compatible with Node.js crypto.scryptSync output.
 *
 * @param password - The password bytes
 * @param salt - The salt bytes
 * @param keyLength - Desired output key length in bytes
 * @param options - Scrypt params { N, r, p, maxmem? }
 * @returns The derived key
 */
export async function scrypt(
  password: Uint8Array,
  salt: Uint8Array,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem?: number },
): Promise<Uint8Array> {
  const N = options.N;
  const r = options.r;
  const p = options.p;
  const blockSize = 128 * r;

  // Step 1: B = PBKDF2-HMAC-SHA256(P, S, 1, p * blockSize)
  const totalBlocks = p * blockSize;
  const B = await pbkdf2HmacSha256(password, salt, 1, totalBlocks);

  // Step 2: ROMix each p chunk
  for (let i = 0; i < p; i++) {
    const start = i * blockSize;
    const chunk = B.subarray(start, start + blockSize);
    romixBlock(chunk, N, r);
  }

  // Step 3: DK = PBKDF2-HMAC-SHA256(P, B, 1, dkLen)
  return pbkdf2HmacSha256(password, B, 1, keyLength);
}
