// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpendTable } from '../../../src/analysis/spends.mjs';
import { TimingCollector, distribution } from '../../../src/analysis/timings.mjs';

const built = (intent, extra = {}) => ({ intent, type: 'payment', outcome: 'built', txs: 1, chained: false, fee: 170000n, walletFee: 170000n, ...extra });
const failed = (intent) => ({ intent, type: 'payment', outcome: 'failed', class: 'balance', unpriced: [], conservation: { consumed: 5n, produced: 7n } });

const table = (rows) => {
  const t = new SpendTable(rows.length);
  for (const r of rows) t.add(r);
  return t;
};

test('a spend table gives back the rows it was given, with the same keys and values', () => {
  const rows = [built(0), built(2, { txs: 3, chained: true, fee: 900000n, walletFee: 400000n, spendable: 12 }), failed(3), built(7, { type: 'withdrawal', spendable: 0 })];
  const t = table(rows);
  assert.equal(t.size, 4);
  assert.deepEqual([...t.values()], rows);
  assert.deepEqual([...t], rows.map((r) => [r.intent, r]));
  assert.deepEqual([...t.keys()], [0, 2, 3, 7]);
  assert.deepEqual(Object.keys(t.get(2)), Object.keys(rows[1]));
  assert.deepEqual(Object.keys(t.get(0)), Object.keys(rows[0]));
  assert.equal(t.get(5), undefined);
  assert.equal(t.has(7), true);
  assert.equal(t.has(6), false);
});

test('a row the columns cannot hold exactly is kept as the object', () => {
  const odd = [built(0, { fee: 2n ** 70n, walletFee: 2n ** 70n }), built(1, { type: 5 }), built(2, { txs: 70000, chained: true }), built(3, { spendable: -4 }), built(4)];
  const t = table(odd);
  assert.deepEqual([...t.values()], odd);
  assert.equal(t.objects.size, 4);
});

test('a filtered view holds the kept rows in order and filters again', () => {
  const rows = [built(0), built(1, { type: 'withdrawal' }), failed(4), built(6, { type: 'withdrawal', txs: 2, chained: true }), built(9)];
  const t = table(rows);
  const v = t.filter((s) => s.type === 'withdrawal');
  assert.deepEqual([...v.values()], [rows[1], rows[3]]);
  assert.equal(v.size, 2);
  assert.equal(v.get(6).txs, 2);
  assert.equal(v.get(4), undefined);
  const w = v.filter((s) => s.chained);
  assert.deepEqual([...w.keys()], [6]);
  assert.deepEqual([...t.filter(() => false).values()], []);
  assert.equal(t.filter((s) => s.outcome === 'failed').get(4).class, 'balance');
});

test('timings collected into columns give the same distributions as plain arrays', () => {
  const rows = [];
  for (let i = 0; i < 3000; i++) rows.push({ method: i % 3 ? 'a' : 'b', kind: i % 2 ? 'own' : 'layout', type: i % 5 ? 'payment' : 'mint', ms: ((i * 7919) % 1000) / 7, spendable: i % 9 === 0 ? undefined : i % 40 });
  const c = new TimingCollector();
  for (const r of rows) c.add(r);
  const s = c.summary();
  assert.equal(s.rows, 3000);
  const ref = (key) => {
    const m = new Map();
    for (const r of rows) {
      const k = key(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r.ms);
    }
    return Object.fromEntries([...m].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map(([k, xs]) => [k, distribution(xs)]));
  };
  assert.deepEqual(s.byArm, ref((r) => `${r.method}/${r.kind}`));
  assert.deepEqual(s.byMethodAndType, ref((r) => `${r.method}/${r.type}`));
  assert.deepEqual(Object.keys(s.byMethodAndSpendable).length > 3, true);
});
