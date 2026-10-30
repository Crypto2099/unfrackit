// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// BLAKE2b (RFC 7693) with any digest length from 1 to 64 bytes, unkeyed.
// Node's crypto offers only the 64-byte BLAKE2b; CIP-14 asset fingerprints
// need the 20-byte one (CIP-14, "Specification": blake2b, digest length 20,
// over policy id || asset name). Written with BigInt for clarity; the inputs
// here are a few dozen bytes.

const M64 = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n
];
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
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0]
];

const rotr = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M64;

function compress(h, block, t, last) {
  const m = [];
  for (let i = 0; i < 16; i++) m.push(block.readBigUInt64LE(i * 8));
  const v = [...h, ...IV];
  v[12] ^= t & M64;
  v[13] ^= (t >> 64n) & M64;
  if (last) v[14] ^= M64;
  const g = (a, b, c, d, x, y) => {
    v[a] = (v[a] + v[b] + x) & M64;
    v[d] = rotr(v[d] ^ v[a], 32);
    v[c] = (v[c] + v[d]) & M64;
    v[b] = rotr(v[b] ^ v[c], 24);
    v[a] = (v[a] + v[b] + y) & M64;
    v[d] = rotr(v[d] ^ v[a], 16);
    v[c] = (v[c] + v[d]) & M64;
    v[b] = rotr(v[b] ^ v[c], 63);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10];
    g(0, 4, 8, 12, m[s[0]], m[s[1]]);
    g(1, 5, 9, 13, m[s[2]], m[s[3]]);
    g(2, 6, 10, 14, m[s[4]], m[s[5]]);
    g(3, 7, 11, 15, m[s[6]], m[s[7]]);
    g(0, 5, 10, 15, m[s[8]], m[s[9]]);
    g(1, 6, 11, 12, m[s[10]], m[s[11]]);
    g(2, 7, 8, 13, m[s[12]], m[s[13]]);
    g(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

export function blake2b(input, outLen = 64) {
  if (!(outLen >= 1 && outLen <= 64)) throw new Error('BLAKE2b digest length must be 1 to 64 bytes');
  const data = Buffer.from(input);
  const h = [...IV];
  h[0] ^= 0x01010000n ^ BigInt(outLen);
  let t = 0n;
  let off = 0;
  while (data.length - off > 128) {
    t += 128n;
    compress(h, data.subarray(off, off + 128), t, false);
    off += 128;
  }
  const last = Buffer.alloc(128);
  data.copy(last, 0, off);
  t += BigInt(data.length - off);
  compress(h, last, t, true);
  const out = Buffer.alloc(64);
  h.forEach((x, i) => out.writeBigUInt64LE(x, i * 8));
  return out.subarray(0, outLen);
}
