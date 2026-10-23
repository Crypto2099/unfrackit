// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The lenient CBOR walker that decides who paid for a transaction read from
// chain: exact spans for any well-formed item, at any depth, and only Error
// throws on anything else.

import test from 'node:test';
import assert from 'node:assert/strict';
import { skipItem, arraySpans, mapSpans, bytesAt, untag } from '../src/cbor.mjs';
import { hasLabel309 } from '../src/tx.mjs';

// A deterministic generator (xorshift32), so a failure reproduces.
function rng(seed) {
  let x = seed >>> 0 || 1;
  return (n) => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x % n;
  };
}

// A head with a non-shortest width chosen at random where the value allows.
function head(r, major, n) {
  const widths = [];
  if (n < 24) widths.push(0);
  if (n < 0x100) widths.push(1);
  if (n < 0x10000) widths.push(2);
  if (n < 0x100000000) widths.push(4);
  widths.push(8);
  const w = widths[r(widths.length)];
  if (w === 0) return [(major << 5) | n];
  const out = [(major << 5) | { 1: 24, 2: 25, 4: 26, 8: 27 }[w]];
  for (let i = w - 1; i >= 0; i--) out.push(Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
  return out;
}

// A random well-formed item. Returns its bytes, and for an array or map the
// spans of its elements relative to the item's start, and for a byte string
// its joined content.
function item(r, depth) {
  const kind = depth > 4 ? r(4) : r(10);
  const randBytes = (n) => Array.from({ length: n }, () => r(256));
  switch (kind) {
    case 0:
      return { bytes: head(r, r(2), r(1000)) };
    case 1: {
      const content = randBytes(r(40));
      if (r(2)) return { bytes: [...head(r, 2, content.length), ...content], content };
      const chunks = [];
      let rest = content.slice();
      while (rest.length) {
        const k = 1 + r(rest.length);
        chunks.push(rest.slice(0, k));
        rest = rest.slice(k);
      }
      if (r(2)) chunks.push([]);
      return { bytes: [0x5f, ...chunks.flatMap((c) => [...head(r, 2, c.length), ...c]), 0xff], content };
    }
    case 2:
      return { bytes: [...head(r, 3, 3), 0x61, 0x62, 0x63] };
    case 3:
      return { bytes: [[0xf4], [0xf5], [0xf6], [0xf7], [0xf9, 0x3c, 0x00], [0xfa, 0, 0, 0, 0], [0xfb, 0, 0, 0, 0, 0, 0, 0, 0], [0xf8, 0x20]][r(8)] };
    case 4:
    case 5:
    case 6: {
      const n = r(5);
      const indefinite = r(2) === 1;
      const parts = Array.from({ length: n }, () => item(r, depth + 1));
      const pre = indefinite ? [0x9f] : head(r, 4, n);
      const spans = [];
      let off = pre.length;
      for (const p of parts) {
        spans.push([off, off + p.bytes.length]);
        off += p.bytes.length;
      }
      return { bytes: [...pre, ...parts.flatMap((p) => p.bytes), ...(indefinite ? [0xff] : [])], spans, array: true };
    }
    case 7:
    case 8: {
      const n = r(4);
      const indefinite = r(2) === 1;
      const parts = Array.from({ length: 2 * n }, () => item(r, depth + 1));
      const pre = indefinite ? [0xbf] : head(r, 5, n);
      const spans = [];
      let off = pre.length;
      for (let i = 0; i < parts.length; i += 2) {
        const k = [off, off + parts[i].bytes.length];
        off = k[1];
        const v = [off, off + parts[i + 1].bytes.length];
        off = v[1];
        spans.push({ key: k, value: v });
      }
      return { bytes: [...pre, ...parts.flatMap((p) => p.bytes), ...(indefinite ? [0xff] : [])], mapSpans: spans };
    }
    default: {
      const inner = item(r, depth + 1);
      return { bytes: [...head(r, 6, r(300)), ...inner.bytes], tagged: true };
    }
  }
}

const shift = (spans, by) => spans.map(([a, b]) => [a + by, b + by]);

test('the walker ends exactly at each random well-formed item, embedded between random bytes, and returns its element spans', () => {
  for (const seed of [1, 2, 3]) {
    const r = rng(seed);
    for (let i = 0; i < 4000; i++) {
      const it = item(r, 0);
      const pre = Array.from({ length: r(5) }, () => r(256));
      const post = Array.from({ length: r(5) }, () => r(256));
      const buf = new Uint8Array([...pre, ...it.bytes, ...post]);
      const at = pre.length;
      assert.equal(skipItem(buf, at), at + it.bytes.length, `seed ${seed} item ${i}`);
      if (it.spans) assert.deepEqual(arraySpans(buf, at), shift(it.spans, at));
      if (it.mapSpans) assert.deepEqual(mapSpans(buf, at), it.mapSpans.map((e) => ({ key: [e.key[0] + at, e.key[1] + at], value: [e.value[0] + at, e.value[1] + at] })));
      if (it.content) assert.deepEqual([...bytesAt(buf, at)], it.content);
      if (it.tagged) assert.ok(untag(buf, at) > at);
    }
  }
});

test('the walker handles nesting far deeper than a transaction can hold, without recursion', () => {
  const definite = new Uint8Array([...Array(100000).fill(0x81), 0x00]);
  assert.equal(skipItem(definite, 0), definite.length);
  const indefinite = new Uint8Array([...Array(50000).fill(0x9f), 0x00, ...Array(50000).fill(0xff)]);
  assert.equal(skipItem(indefinite, 0), indefinite.length);
  const maps = new Uint8Array([...Array(50000).fill([0xa1, 0x00]).flat(), 0x00]);
  assert.equal(skipItem(maps, 0), maps.length);
  const tags = new Uint8Array([...Array(50000).fill(0xc1), 0x00]);
  assert.equal(skipItem(tags, 0), tags.length);
  const strings = new Uint8Array([0x9f, ...Array(30000).fill([0x5f, 0x41, 0x00, 0xff]).flat(), 0xff]);
  assert.equal(skipItem(strings, 0), strings.length);
});

test('bytes that are not well-formed only ever throw an Error, and no end passes the buffer', () => {
  const r = rng(7);
  for (let i = 0; i < 20000; i++) {
    const buf = new Uint8Array(Array.from({ length: 1 + r(24) }, () => [0x9f, 0xbf, 0x5f, 0xff, 0x1b, 0x5b, 0x81, 0xa1, 0xc1, r(256)][r(10)]));
    try {
      assert.ok(skipItem(buf, 0) <= buf.length);
    } catch (e) {
      assert.ok(e instanceof Error, String(e));
      assert.ok(!(e instanceof RangeError), `no stack overflow: ${e.message}`);
    }
  }
  assert.throws(() => skipItem(new Uint8Array([0x9b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0), /truncated/);
  assert.throws(() => skipItem(new Uint8Array([0x5b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0), /truncated/);
  assert.throws(() => skipItem(new Uint8Array([0xff]), 0), /unexpected break/);
  assert.throws(() => skipItem(new Uint8Array([0x1c]), 0), /reserved/);
});

test('label 309 is found in every auxiliary-data form: the plain map, the array form and tag 259', () => {
  const tx = (aux) => new Uint8Array([0x84, 0xa0, 0xa0, 0xf5, ...aux]);
  const md309 = [0xa1, 0x19, 0x01, 0x35, 0x80];
  const md674 = [0xa1, 0x19, 0x02, 0xa2, 0x80];
  assert.equal(hasLabel309(tx(md309)), true);
  assert.equal(hasLabel309(tx([0x82, ...md309, 0x80])), true, 'array form [metadata, scripts]');
  assert.equal(hasLabel309(tx([0xd9, 0x01, 0x03, 0xa1, 0x00, ...md309])), true, 'tag 259 {0: metadata}');
  assert.equal(hasLabel309(tx([0xd9, 0x01, 0x03, 0xbf, 0x00, ...md309, 0xff])), true, 'tag 259 with an indefinite map');
  for (const aux of [md674, [0x82, ...md674, 0x80], [0xd9, 0x01, 0x03, 0xa1, 0x00, ...md674], [0xd9, 0x01, 0x03, 0xa0], [0xf6]]) assert.equal(hasLabel309(tx(aux)), false);
  assert.equal(hasLabel309(new Uint8Array([0x83, 0xa0, 0xa0, ...md309])), true, 'a three-item transaction with metadata');
  assert.equal(hasLabel309(new Uint8Array([0x83, 0xa0, 0xa0, 0xf6])), false);
});
