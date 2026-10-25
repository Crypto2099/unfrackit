// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// BLAKE2b (RFC 7693), unkeyed, any digest length from 1 to 64 bytes, in
// 32-bit arithmetic so that hashing every transaction body of a window stays
// cheap. Node's crypto offers only the 64-byte digest, and Cardano needs the
// 32-byte one (transaction and block hashes) and the 28-byte one (key and
// script hashes; CIP-19, "Shelley Addresses": blake2b-224).
//
// Each 64-bit word is held as two 32-bit halves, low at even and high at odd
// positions of a Uint32Array, as in the RFC's reference implementation.

const IV32 = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19
]);

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3]
].map((r) => r.map((x) => x * 2));

const v = new Uint32Array(32);
const m = new Uint32Array(32);

// v[a] += v[b] (64-bit, on halves)
function add64(a, b) {
  const lo = v[a] + v[b];
  let hi = v[a + 1] + v[b + 1];
  if (lo >= 0x100000000) hi++;
  v[a] = lo;
  v[a + 1] = hi;
}

// v[a] += (m[x] low, m[x+1] high)
function add64m(a, x) {
  const lo = v[a] + m[x];
  let hi = v[a + 1] + m[x + 1];
  if (lo >= 0x100000000) hi++;
  v[a] = lo;
  v[a + 1] = hi;
}

function G(a, b, c, d, x, y) {
  add64(a, b);
  add64m(a, x);
  // v[d] = rotr64(v[d] ^ v[a], 32)
  let xlo = v[d] ^ v[a];
  let xhi = v[d + 1] ^ v[a + 1];
  v[d] = xhi;
  v[d + 1] = xlo;
  add64(c, d);
  // v[b] = rotr64(v[b] ^ v[c], 24)
  xlo = v[b] ^ v[c];
  xhi = v[b + 1] ^ v[c + 1];
  v[b] = (xlo >>> 24) ^ (xhi << 8);
  v[b + 1] = (xhi >>> 24) ^ (xlo << 8);
  add64(a, b);
  add64m(a, y);
  // v[d] = rotr64(v[d] ^ v[a], 16)
  xlo = v[d] ^ v[a];
  xhi = v[d + 1] ^ v[a + 1];
  v[d] = (xlo >>> 16) ^ (xhi << 16);
  v[d + 1] = (xhi >>> 16) ^ (xlo << 16);
  add64(c, d);
  // v[b] = rotr64(v[b] ^ v[c], 63)
  xlo = v[b] ^ v[c];
  xhi = v[b + 1] ^ v[c + 1];
  v[b] = (xhi >>> 31) ^ (xlo << 1);
  v[b + 1] = (xlo >>> 31) ^ (xhi << 1);
}

function compress(h, block, t, last) {
  for (let i = 0; i < 16; i++) {
    v[i] = h[i];
    v[i + 16] = IV32[i];
  }
  // t is below 2^53; its low 64 bits go into v[12..13] (low word pair) and
  // v[14..15] is zero for every input this code hashes.
  v[24] ^= t >>> 0;
  v[25] ^= Math.floor(t / 0x100000000);
  if (last) {
    v[28] = ~v[28];
    v[29] = ~v[29];
  }
  for (let i = 0; i < 32; i++) m[i] = block[i * 4] | (block[i * 4 + 1] << 8) | (block[i * 4 + 2] << 16) | (block[i * 4 + 3] << 24);
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r];
    G(0, 8, 16, 24, s[0], s[1]);
    G(2, 10, 18, 26, s[2], s[3]);
    G(4, 12, 20, 28, s[4], s[5]);
    G(6, 14, 22, 30, s[6], s[7]);
    G(0, 10, 20, 30, s[8], s[9]);
    G(2, 12, 22, 24, s[10], s[11]);
    G(4, 14, 16, 26, s[12], s[13]);
    G(6, 8, 18, 28, s[14], s[15]);
  }
  for (let i = 0; i < 16; i++) h[i] = h[i] ^ v[i] ^ v[i + 16];
}

export function blake2b(input, outLen = 64) {
  if (!(outLen >= 1 && outLen <= 64)) throw new Error('BLAKE2b digest length must be 1 to 64 bytes');
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const h = new Uint32Array(IV32);
  h[0] ^= 0x01010000 ^ outLen;
  const block = Buffer.alloc(128);
  let t = 0;
  let off = 0;
  while (data.length - off > 128) {
    t += 128;
    compress(h, data.subarray(off, off + 128), t, false);
    off += 128;
  }
  block.fill(0);
  data.copy(block, 0, off);
  t += data.length - off;
  compress(h, block, t, true);
  const out = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) out.writeUInt32LE(h[i] >>> 0, i * 4);
  return out.subarray(0, outLen);
}

export const blake2b256 = (b) => blake2b(b, 32);
export const blake2b224 = (b) => blake2b(b, 28);
