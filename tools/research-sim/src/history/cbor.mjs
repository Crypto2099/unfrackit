// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A CBOR decoder (RFC 8949) that keeps the byte span of every item, and the
// few encoders the history reader needs.
//
// Transactions are read as they sit on chain, so the decoder is lenient: it
// accepts indefinite lengths, non-shortest heads, tags and every simple value,
// and records where each item starts and ends. Every part of a transaction the
// simulator holds constant (an input set, a certificate, a redeemer, a
// witness) is then sliced from the original bytes rather than re-encoded.
//
// A node is { mt, s, e, ... }: the major type, the offset of its first byte
// and the offset after its last byte. Integers carry `value` as a BigInt;
// byte and text strings carry `value` (a Buffer or a string); arrays carry
// `items`; maps carry `entries` as [key, value] pairs in their order on the
// wire; tags carry `tag` (a BigInt) and `item`; simple values carry `simple`;
// floats carry `float`. `indefinite` is true for an indefinite-length item.

export class CborError extends Error {}

function fail(pos, msg) {
  throw new CborError(`CBOR at byte ${pos}: ${msg}`);
}

function readArg(buf, pos, ai) {
  if (ai < 24) return { v: BigInt(ai), p: pos };
  if (ai === 24) {
    if (pos + 1 > buf.length) fail(pos, 'unexpected end');
    return { v: BigInt(buf[pos]), p: pos + 1 };
  }
  if (ai === 25) {
    if (pos + 2 > buf.length) fail(pos, 'unexpected end');
    return { v: BigInt(buf.readUInt16BE(pos)), p: pos + 2 };
  }
  if (ai === 26) {
    if (pos + 4 > buf.length) fail(pos, 'unexpected end');
    return { v: BigInt(buf.readUInt32BE(pos)), p: pos + 4 };
  }
  if (ai === 27) {
    if (pos + 8 > buf.length) fail(pos, 'unexpected end');
    return { v: buf.readBigUInt64BE(pos), p: pos + 8 };
  }
  if (ai === 31) return { v: null, p: pos };
  return fail(pos, `reserved additional information ${ai}`);
}

function item(buf, pos) {
  const s = pos;
  if (pos >= buf.length) fail(pos, 'unexpected end');
  const ib = buf[pos++];
  const mt = ib >> 5;
  const ai = ib & 31;
  const { v, p } = readArg(buf, pos, ai);
  pos = p;
  switch (mt) {
    case 0:
    case 1: {
      if (v === null) fail(s, 'indefinite integer');
      return { mt, s, e: pos, value: mt === 0 ? v : -1n - v };
    }
    case 2:
    case 3: {
      let bytes;
      let indefinite = false;
      if (v === null) {
        indefinite = true;
        const parts = [];
        for (;;) {
          if (pos >= buf.length) fail(pos, 'unexpected end');
          if (buf[pos] === 0xff) {
            pos++;
            break;
          }
          const chunk = item(buf, pos);
          if (chunk.mt !== mt || chunk.indefinite) fail(pos, 'bad chunk in an indefinite string');
          parts.push(mt === 2 ? chunk.value : Buffer.from(chunk.value, 'utf8'));
          pos = chunk.e;
        }
        bytes = Buffer.concat(parts);
      } else {
        const n = Number(v);
        if (v > BigInt(buf.length - pos)) fail(pos, 'length beyond input');
        bytes = buf.subarray(pos, pos + n);
        pos += n;
      }
      const value = mt === 2 ? bytes : bytes.toString('utf8');
      return { mt, s, e: pos, value, indefinite };
    }
    case 4: {
      const items = [];
      if (v === null) {
        for (;;) {
          if (pos >= buf.length) fail(pos, 'unexpected end');
          if (buf[pos] === 0xff) {
            pos++;
            break;
          }
          const x = item(buf, pos);
          items.push(x);
          pos = x.e;
        }
        return { mt, s, e: pos, items, indefinite: true };
      }
      if (v > BigInt(buf.length - pos)) fail(pos, 'array length beyond input');
      for (let i = 0n; i < v; i++) {
        const x = item(buf, pos);
        items.push(x);
        pos = x.e;
      }
      return { mt, s, e: pos, items, indefinite: false };
    }
    case 5: {
      const entries = [];
      const one = () => {
        const k = item(buf, pos);
        pos = k.e;
        const x = item(buf, pos);
        pos = x.e;
        entries.push([k, x]);
      };
      if (v === null) {
        for (;;) {
          if (pos >= buf.length) fail(pos, 'unexpected end');
          if (buf[pos] === 0xff) {
            pos++;
            break;
          }
          one();
        }
        return { mt, s, e: pos, entries, indefinite: true };
      }
      if (v > BigInt(buf.length - pos)) fail(pos, 'map length beyond input');
      for (let i = 0n; i < v; i++) one();
      return { mt, s, e: pos, entries, indefinite: false };
    }
    case 6: {
      if (v === null) fail(s, 'indefinite tag');
      const x = item(buf, pos);
      return { mt, s, e: x.e, tag: v, item: x };
    }
    case 7: {
      if (ai < 24) return { mt, s, e: pos, simple: ai };
      if (ai === 24) return { mt, s, e: pos, simple: Number(v) };
      if (ai === 25 || ai === 26 || ai === 27) return { mt, s, e: pos, float: v };
      return fail(s, 'unexpected break');
    }
    default:
      return fail(s, 'unreachable');
  }
}

// Decodes the item at `pos`; returns the node, whose `e` is where the next
// item would start.
export function decodeAt(buf, pos = 0) {
  return item(Buffer.isBuffer(buf) ? buf : Buffer.from(buf), pos);
}

// Decodes exactly one item filling `buf`.
export function decode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const n = item(b, 0);
  if (n.e !== b.length) throw new CborError(`CBOR: ${b.length - n.e} trailing bytes`);
  return n;
}

export const raw = (buf, node) => buf.subarray(node.s, node.e);

// A tag-258 set (or a plain array, as the Conway CDDL allows for set<a>,
// nonempty_set<a>, nonempty_oset<a> and nonempty_list<a>): the array node.
export function setItems(node) {
  if (node.mt === 6 && node.tag === 258n) node = node.item;
  if (node.mt !== 4) throw new CborError(`expected an array or a tag-258 set at byte ${node.s}`);
  return node.items;
}

export function asUint(node, what = 'value') {
  if (node.mt !== 0) throw new CborError(`${what}: expected an unsigned integer at byte ${node.s}`);
  return node.value;
}

export function asInt(node, what = 'value') {
  if (node.mt !== 0 && node.mt !== 1) throw new CborError(`${what}: expected an integer at byte ${node.s}`);
  return node.value;
}

export function asBytes(node, what = 'value') {
  if (node.mt !== 2) throw new CborError(`${what}: expected a byte string at byte ${node.s}`);
  return node.value;
}

// ---- Encoding: definite lengths, shortest heads (RFC 8949 section 4.2.1).

export function head(mt, n) {
  const v = BigInt(n);
  if (v < 0n) throw new CborError('negative head argument');
  const t = mt << 5;
  if (v < 24n) return Buffer.from([t | Number(v)]);
  if (v < 0x100n) return Buffer.from([t | 24, Number(v)]);
  if (v < 0x10000n) {
    const b = Buffer.alloc(3);
    b[0] = t | 25;
    b.writeUInt16BE(Number(v), 1);
    return b;
  }
  if (v < 0x100000000n) {
    const b = Buffer.alloc(5);
    b[0] = t | 26;
    b.writeUInt32BE(Number(v), 1);
    return b;
  }
  if (v < 1n << 64n) {
    const b = Buffer.alloc(9);
    b[0] = t | 27;
    b.writeBigUInt64BE(v, 1);
    return b;
  }
  throw new CborError('head argument beyond 64 bits');
}

// The length in bytes of a shortest head carrying n.
export function headSize(n) {
  const v = BigInt(n);
  if (v < 24n) return 1;
  if (v < 0x100n) return 2;
  if (v < 0x10000n) return 3;
  if (v < 0x100000000n) return 5;
  return 9;
}

export const encUint = (n) => head(0, n);
export function encInt(n) {
  const v = BigInt(n);
  return v >= 0n ? head(0, v) : head(1, -1n - v);
}
export const encBytes = (b) => Buffer.concat([head(2, b.length), Buffer.from(b)]);
export function encText(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([head(3, b.length), b]);
}
export const encArray = (items) => Buffer.concat([head(4, items.length), ...items]);
export const encMap = (pairs) => Buffer.concat([head(5, pairs.length), ...pairs.flat()]);
export const encTag = (tag, inner) => Buffer.concat([head(6, tag), inner]);
export const NULL = Buffer.from([0xf6]);
export const TRUE = Buffer.from([0xf5]);
export const FALSE = Buffer.from([0xf4]);
