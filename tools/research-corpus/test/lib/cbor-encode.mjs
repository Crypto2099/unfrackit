// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A canonical CBOR encoder for test fixtures (RFC 8949 section 4.2.1):
// shortest heads, definite lengths, map keys sorted by their encoded bytes.
// Integers, Buffers (byte strings), strings, arrays, null, and maps given as
// Map or as plain objects with text keys.

function head(mt, n) {
  const t = mt << 5;
  if (n < 24) return Buffer.from([t | n]);
  if (n < 0x100) return Buffer.from([t | 24, n]);
  if (n < 0x10000) return Buffer.from([t | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = t | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function encode(v, { sortKeys = true } = {}) {
  if (v === null) return Buffer.from([0xf6]);
  if (v === true) return Buffer.from([0xf5]);
  if (v === false) return Buffer.from([0xf4]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map((x) => encode(x, { sortKeys }))]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  let enc = entries.map(([k, x]) => [encode(k, { sortKeys }), encode(x, { sortKeys })]);
  if (sortKeys) enc = enc.sort((a, b) => Buffer.compare(a[0], b[0]));
  return Buffer.concat([head(5, enc.length), ...enc.flat()]);
}
