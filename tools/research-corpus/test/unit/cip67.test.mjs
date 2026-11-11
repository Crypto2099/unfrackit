// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// study.cip67_label and the classification rule, run in PGlite.
// Vectors: CIP-67 "Test Vectors" (cardano-foundation/CIPs@befcdb75, CIP-0067/README.md),
// the registry's five label prefixes, and the M8 names of the preprod seeder,
// whose labeled names carry the four-byte prefix in front of the name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb } from '../lib/pglite.mjs';

const CIP67_VECTORS = [
  [0, '00000000'],
  [1, '00001070'],
  [23, '00017650'],
  [99, '000632e0'],
  [533, '00215410'],
  [2000, '007d0550'],
  [4567, '011d7690'],
  [11111, '02b670b0'],
  [49328, '0c0b0f40'],
  [65535, '0ffff240']
];
const PREFIXES = [
  [100, '000643b0'],
  [222, '000de140'],
  [333, '0014df10'],
  [444, '001bc280'],
  [500, '001f4d70']
];

const label = async (r, hex) => (await r(`SELECT study.cip67_label(decode($1, 'hex')) AS l`, [hex]))[0].l;

test('CIP-67 test vectors, alone and with a name after the prefix', async () => {
  const { rows } = await freshDb();
  for (const [n, hex] of CIP67_VECTORS) {
    assert.equal(await label(rows, hex), n, `vector ${n}`);
    assert.equal(await label(rows, hex + '4e616d65'), n, `vector ${n} with content`);
  }
});

test('the five registry prefixes, and CIP-102 royalty names', async () => {
  const { rows } = await freshDb();
  for (const [n, hex] of PREFIXES) assert.equal(await label(rows, hex + '54657374313233'), n);
  assert.equal(await label(rows, '001f4d70526f79616c7479'), 500);
  assert.equal(await label(rows, '001f4d70526f79616c747932'), 500);
});

test('names that are not labels', async () => {
  const { rows } = await freshDb();
  assert.equal(await label(rows, ''), null);
  assert.equal(await label(rows, '000de1'), null, 'shorter than four bytes');
  assert.equal(await label(rows, '000de141'), null, 'low nibble of byte 3 set');
  assert.equal(await label(rows, '100de140'), null, 'high nibble of byte 0 set');
  assert.equal(await label(rows, '000de150'), null, 'checksum off by one');
  assert.equal(await label(rows, '4e49474854'), null, 'NIGHT');
  assert.equal(await label(rows, '484f534b59'), null, 'HOSKY');
});

test('M8 names from the seeder generator', async () => {
  const { rows } = await freshDb();
  const fx = JSON.parse(readFileSync(new URL('../fixtures/m8-names.json', import.meta.url), 'utf8'));
  assert.equal(fx.names.length, 30);
  for (const n of fx.names) assert.equal(await label(rows, n.name), n.label, n.name);
});

test('classification rule: label 333 and 444 fungible; 100, 222, 500 and unlabeled fungible only above one unit', async () => {
  const { rows } = await freshDb();
  const f = async (hex, qty) => (await rows(`SELECT study.is_fungible(decode($1, 'hex'), $2::numeric) AS f`, [hex, qty]))[0].f;
  assert.equal(await f('0014df10474f4c44', '1'), true);
  assert.equal(await f('001bc2805368617264', '1'), true);
  assert.equal(await f('000de1404e4654', '1'), false);
  assert.equal(await f('000de1404e4654', '2'), true);
  assert.equal(await f('000643b04e4654', '1'), false);
  assert.equal(await f('001f4d70526f79616c7479', '1'), false);
  assert.equal(await f('4275643030303031', '1'), false);
  assert.equal(await f('4275643030303031', '5'), true);
  // Label 600 (CIPs pull request 1207, not in the rule) falls to the quantity rule.
  const l600 = (await rows(`SELECT study.crc8_2(2, 88) AS c`))[0].c;
  const p600 = (((600 << 12) | (l600 << 4)) >>> 0).toString(16).padStart(8, '0');
  assert.equal(await label(rows, p600), 600);
  assert.equal(await f(p600, '1'), false);
  assert.equal(await f(p600, '3'), true);
  const g = async (l, qty) => (await rows(`SELECT study.is_fungible_l($1::integer, $2::numeric) AS f`, [l, qty]))[0].f;
  assert.equal(await g(null, '1'), false);
  assert.equal(await g(333, '1'), true);
  assert.equal(await g(222, '7'), true);
});
