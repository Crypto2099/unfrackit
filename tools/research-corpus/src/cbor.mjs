// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A small CBOR decoder (RFC 8949) for reading the freeze record.
//
// Strict mode enforces the deterministic encoding CIP-190 requires of a
// label-309 record body (CIP-190, "Canonical CBOR (deterministic encoding)",
// RFC 8949 section 4.2.1): shortest-form integers and lengths, definite
// lengths only, map keys in strictly increasing bytewise order of their
// encodings (which also rejects duplicates), valid UTF-8 text, no tags, no
// floats and no simple values other than false, true and null. Any violation
// throws. Lenient mode accepts indefinite lengths and non-minimal heads; it is
// used only for the outer metadata wrapper that db-sync re-encodes.
//
// Values: unsigned and negative integers as Number when safe, else BigInt;
// byte strings as Buffer; text as string; arrays as Array; maps as CborMap,
// which keeps each entry's byte span so a verifier can rebuild the record
// without one key and keep every other byte as published.

export class CborMap {
  constructor() {
    this.entries = []; // { key, value, start, end } with start..end covering key and value
  }
  get(key) {
    const e = this.entries.find((x) => x.key === key);
    return e ? e.value : undefined;
  }
  has(key) {
    return this.entries.some((x) => x.key === key);
  }
  keys() {
    return this.entries.map((x) => x.key);
  }
}

class Reader {
  constructor(buf, strict) {
    this.b = buf;
    this.p = 0;
    this.strict = strict;
  }
  fail(msg) {
    throw new Error(`CBOR at byte ${this.p}: ${msg}`);
  }
  byte() {
    if (this.p >= this.b.length) this.fail('unexpected end');
    return this.b[this.p++];
  }
  take(n) {
    if (this.p + n > this.b.length) this.fail('unexpected end');
    const out = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return out;
  }
  // The argument of a head: returns a BigInt, or null for indefinite length.
  arg(ai) {
    if (ai < 24) return BigInt(ai);
    let v;
    if (ai === 24) v = BigInt(this.byte());
    else if (ai === 25) v = BigInt(this.take(2).readUInt16BE(0));
    else if (ai === 26) v = BigInt(this.take(4).readUInt32BE(0));
    else if (ai === 27) v = this.take(8).readBigUInt64BE(0);
    else if (ai === 31) return null;
    else this.fail(`reserved additional information ${ai}`);
    if (this.strict) {
      const min = ai === 24 ? 24n : ai === 25 ? 0x100n : ai === 26 ? 0x10000n : 0x100000000n;
      if (v < min) this.fail('integer or length not in shortest form');
    }
    return v;
  }
  len(ai) {
    const v = this.arg(ai);
    if (v === null) {
      if (this.strict) this.fail('indefinite length');
      return null;
    }
    if (v > BigInt(this.b.length)) this.fail('length beyond input');
    return Number(v);
  }
  item() {
    const ib = this.byte();
    const mt = ib >> 5;
    const ai = ib & 31;
    switch (mt) {
      case 0: {
        const v = this.arg(ai);
        if (v === null) this.fail('indefinite integer');
        return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
      }
      case 1: {
        const v = this.arg(ai);
        if (v === null) this.fail('indefinite integer');
        const n = -1n - v;
        return n >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(n) : n;
      }
      case 2:
      case 3: {
        const n = this.len(ai);
        let bytes;
        if (n === null) {
          const parts = [];
          for (;;) {
            if (this.b[this.p] === 0xff) {
              this.p++;
              break;
            }
            const h = this.byte();
            if (h >> 5 !== mt || (h & 31) === 31) this.fail('bad chunk in indefinite string');
            parts.push(Buffer.from(this.take(this.len(h & 31))));
          }
          bytes = Buffer.concat(parts);
        } else bytes = Buffer.from(this.take(n));
        if (mt === 2) return bytes;
        try {
          return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          return this.fail('text string is not valid UTF-8');
        }
      }
      case 4: {
        const n = this.len(ai);
        const out = [];
        if (n === null) {
          while (this.b[this.p] !== 0xff) out.push(this.item());
          this.p++;
        } else for (let i = 0; i < n; i++) out.push(this.item());
        return out;
      }
      case 5: {
        const n = this.len(ai);
        const m = new CborMap();
        let prevKey = null;
        const one = () => {
          const start = this.p;
          const key = this.item();
          const kEnd = this.p;
          const value = this.item();
          const kb = this.b.subarray(start, kEnd);
          if (this.strict && prevKey && Buffer.compare(prevKey, kb) >= 0) this.fail('map keys not in strictly increasing bytewise order');
          prevKey = kb;
          m.entries.push({ key, value, start, end: this.p });
        };
        if (n === null) {
          while (this.b[this.p] !== 0xff) one();
          this.p++;
        } else for (let i = 0; i < n; i++) one();
        return m;
      }
      case 6:
        if (this.strict) this.fail('tags are not allowed');
        this.arg(ai);
        return this.item();
      case 7:
        if (ai === 20) return false;
        if (ai === 21) return true;
        if (ai === 22) return null;
        return this.fail(`simple value or float ${ai} is not allowed`);
      default:
        return this.fail('unreachable');
    }
  }
}

export function decode(buf, { strict = true } = {}) {
  const r = new Reader(Buffer.from(buf), strict);
  const v = r.item();
  if (r.p !== r.b.length) throw new Error(`CBOR: ${r.b.length - r.p} trailing bytes`);
  return v;
}

// The head of a definite-length major type with the given count, shortest form.
export function head(mt, n) {
  const t = mt << 5;
  if (n < 24) return Buffer.from([t | n]);
  if (n < 0x100) return Buffer.from([t | 24, n]);
  if (n < 0x10000) return Buffer.from([t | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = t | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function encodeBytes(b) {
  return Buffer.concat([head(2, b.length), b]);
}

export function encodeText(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([head(3, b.length), b]);
}

// A canonical map rebuilt from the published bytes of `buf` without the
// entries whose key is in `drop`. Every kept entry keeps its published bytes
// and order, so a canonical input gives a canonical output.
export function withoutKeys(buf, map, drop) {
  const kept = map.entries.filter((e) => !drop.includes(e.key));
  return Buffer.concat([head(5, kept.length), ...kept.map((e) => buf.subarray(e.start, e.end))]);
}
