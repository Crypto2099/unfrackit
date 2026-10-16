// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A small CBOR encoder and decoder, written independently of the SDK's so the
// two can be compared byte for byte on every record this tool builds.
//
// The encoder emits the deterministic encoding CIP-190 requires ("Canonical
// CBOR (deterministic encoding)", RFC 8949 section 4.2.1): shortest-form
// integers and lengths, definite lengths only, map keys sorted bytewise by
// their encoding, no duplicate keys, no tags, no floats. It covers the value
// kinds a record body and a COSE structure use: unsigned and negative
// integers, byte strings, text strings, arrays, maps (a JS Map with any key
// kind, or a plain object with text keys), null and booleans.
//
// The decoder accepts definite-length items only. With `canonical: true` it
// also refuses non-shortest integers and lengths and map keys out of order or
// duplicated, which is the canonical-decode rule of the same section.

import { concat, toHex } from './util.mjs';

function head(major, n) {
  const v = typeof n === 'bigint' ? n : BigInt(n);
  if (v < 0n) throw new Error('negative length');
  const m = major << 5;
  if (v < 24n) return Uint8Array.of(m | Number(v));
  if (v < 0x100n) return Uint8Array.of(m | 24, Number(v));
  if (v < 0x10000n) return Uint8Array.of(m | 25, Number(v >> 8n), Number(v & 0xffn));
  if (v < 0x100000000n) {
    const out = new Uint8Array(5);
    out[0] = m | 26;
    new DataView(out.buffer).setUint32(1, Number(v));
    return out;
  }
  if (v < 0x10000000000000000n) {
    const out = new Uint8Array(9);
    out[0] = m | 27;
    new DataView(out.buffer).setBigUint64(1, v);
    return out;
  }
  throw new Error('integer out of the 64-bit CBOR range');
}

function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export function encode(value) {
  if (value === null) return Uint8Array.of(0xf6);
  if (value === true) return Uint8Array.of(0xf5);
  if (value === false) return Uint8Array.of(0xf4);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`refusing to encode a non-integer or unsafe number: ${value}`);
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'bigint') return value >= 0n ? head(0, value) : head(1, -1n - value);
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  if (typeof value === 'string') {
    const b = new TextEncoder().encode(value);
    return concat(head(3, b.length), b);
  }
  if (Array.isArray(value)) return concat(head(4, value.length), ...value.map(encode));
  let entries;
  if (value instanceof Map) entries = [...value.entries()];
  else if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) entries = Object.entries(value);
  else throw new Error(`refusing to encode ${Object.prototype.toString.call(value)}`);
  const pairs = entries.map(([k, v]) => {
    if (v === undefined) throw new Error('refusing to encode an undefined map value');
    return [encode(k), encode(v)];
  });
  pairs.sort((x, y) => compareBytes(x[0], y[0]));
  for (let i = 1; i < pairs.length; i++) {
    if (compareBytes(pairs[i - 1][0], pairs[i][0]) === 0) throw new Error('duplicate map key');
  }
  return concat(head(5, pairs.length), ...pairs.flat());
}

// A decoded tag, kept distinct from the value it wraps.
export class Tagged {
  constructor(tag, value) {
    this.tag = tag;
    this.value = value;
  }
}

function readArg(bytes, pos, ai, canonical) {
  if (ai < 24) return [BigInt(ai), pos];
  const len = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : ai === 27 ? 8 : 0;
  if (!len) throw new Error(`CBOR: unsupported additional information ${ai} (indefinite lengths are refused)`);
  if (pos + len > bytes.length) throw new Error('CBOR: truncated argument');
  let v = 0n;
  for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(bytes[pos + i]);
  if (canonical) {
    const min = ai === 24 ? 24n : ai === 25 ? 0x100n : ai === 26 ? 0x10000n : 0x100000000n;
    if (v < min) throw new Error('CBOR: non-shortest integer or length');
  }
  return [v, pos + len];
}

function toNumberIfSafe(v) {
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

// Returns [value, nextPosition]. Maps decode to JS Maps (keys in wire order).
export function decodeItem(bytes, pos = 0, { canonical = false } = {}) {
  if (pos >= bytes.length) throw new Error('CBOR: truncated input');
  const ib = bytes[pos];
  const major = ib >> 5;
  const ai = ib & 0x1f;
  if (major === 7) {
    if (ai === 20) return [false, pos + 1];
    if (ai === 21) return [true, pos + 1];
    if (ai === 22) return [null, pos + 1];
    throw new Error(`CBOR: unsupported simple value or float (0x${ib.toString(16)})`);
  }
  const [arg, p] = readArg(bytes, pos + 1, ai, canonical);
  switch (major) {
    case 0:
      return [toNumberIfSafe(arg), p];
    case 1:
      return [arg <= BigInt(Number.MAX_SAFE_INTEGER) - 1n ? -1 - Number(arg) : -1n - arg, p];
    case 2:
    case 3: {
      const n = Number(arg);
      if (p + n > bytes.length) throw new Error('CBOR: truncated string');
      const raw = bytes.slice(p, p + n);
      if (major === 2) return [raw, p + n];
      return [new TextDecoder('utf-8', { fatal: true }).decode(raw), p + n];
    }
    case 4: {
      const out = [];
      let q = p;
      for (let i = 0n; i < arg; i++) {
        const [v, nq] = decodeItem(bytes, q, { canonical });
        out.push(v);
        q = nq;
      }
      return [out, q];
    }
    case 5: {
      const out = new Map();
      let q = p;
      let prevKey = null;
      for (let i = 0n; i < arg; i++) {
        const keyStart = q;
        const [k, kq] = decodeItem(bytes, q, { canonical });
        const keyBytes = bytes.slice(keyStart, kq);
        if (canonical && prevKey && compareBytes(prevKey, keyBytes) >= 0) {
          throw new Error('CBOR: map keys out of canonical order or duplicated');
        }
        prevKey = keyBytes;
        const [v, vq] = decodeItem(bytes, kq, { canonical });
        if (!canonical) {
          for (const existing of out.keys()) {
            if (sameKey(existing, k)) throw new Error('CBOR: duplicate map key');
          }
        }
        out.set(k, v);
        q = vq;
      }
      return [out, q];
    }
    case 6: {
      if (canonical) throw new Error('CBOR: tags are not allowed in a canonical record');
      const [v, q] = decodeItem(bytes, p, { canonical });
      return [new Tagged(toNumberIfSafe(arg), v), q];
    }
    default:
      throw new Error('CBOR: unreachable major type');
  }
}

function sameKey(a, b) {
  if (a instanceof Uint8Array && b instanceof Uint8Array) return toHex(a) === toHex(b);
  return a === b;
}

export function decode(bytes, opts) {
  const [v, end] = decodeItem(bytes, 0, opts);
  if (end !== bytes.length) throw new Error(`CBOR: ${bytes.length - end} trailing bytes`);
  return v;
}

// Byte span [start, end) of the item at `pos`, without interpreting it.
export function itemSpan(bytes, pos) {
  const [, end] = decodeItem(bytes, pos);
  return [pos, end];
}

// Look up a text or integer key in a decoded Map.
export function mapGet(map, key) {
  for (const [k, v] of map) if (k === key) return v;
  return undefined;
}
