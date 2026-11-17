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

test('timings collected into columns give, per machine, the same distributions as plain arrays', () => {
  const rows = [];
  for (let i = 0; i < 3000; i++) rows.push({ method: i % 3 ? 'a' : 'b', kind: i % 2 ? 'own' : 'layout', type: i % 5 ? 'payment' : 'mint', ms: ((i * 7919) % 1000) / 7, spendable: i % 9 === 0 ? undefined : i % 40, machine: i % 4 === 0 ? undefined : i % 4 === 1 ? 'x' : 'y' });
  const c = new TimingCollector();
  for (const r of rows) c.add(r);
  const s = c.summary();
  assert.equal(s.rows, 3000);
  assert.deepEqual(Object.keys(s.byMachine), ['x', 'y', 'unattributed']);
  const ref = (label, key) => {
    const m = new Map();
    for (const r of rows.filter((r) => (r.machine || 'unattributed') === label)) {
      const k = key(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r.ms);
    }
    return Object.fromEntries([...m].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map(([k, xs]) => [k, distribution(xs)]));
  };
  for (const label of ['x', 'y', 'unattributed']) {
    const e = s.byMachine[label];
    assert.equal(e.rows, rows.filter((r) => (r.machine || 'unattributed') === label).length);
    assert.deepEqual(e.byArm, ref(label, (r) => `${r.method}/${r.kind}`));
    assert.deepEqual(e.byMethodAndType, ref(label, (r) => `${r.method}/${r.type}`));
    assert.deepEqual(Object.keys(e.byMethodAndSpendable).length > 3, true);
  }
  assert.equal(s.byMachine.unattributed.machine, null);
  assert.equal(Object.values(s.byMachine).reduce((n, e) => n + e.rows, 0), 3000);
});

test('outliers: a library with one far-out build counts it under its spendable bin and type', () => {
  // 19 builds of 10 ms (spendable 5, type T1, 2 inputs) and one of 10,000 ms (spendable 40, type T2, 9 inputs): on ln(ms)
  // Q1 = Q3 = ln 10, the IQR is 0, the limit is ln 10, and only the 10,000 ms build is above it. The other library has no outlier.
  const c = new TimingCollector();
  for (let i = 0; i < 19; i++) c.add({ method: 'a', kind: 'own', type: 'T1', ms: 10, spendable: 5, machine: 'x', inputs: 2, outcome: 'built' });
  c.add({ method: 'a', kind: 'own', type: 'T2', ms: 10000, spendable: 40, machine: 'x', inputs: 9, outcome: 'built' });
  for (let i = 0; i < 5; i++) c.add({ method: 'b', kind: 'own', type: 'T1', ms: 10 * (i + 1), spendable: 5, machine: 'x', inputs: 2, outcome: 'built' });
  const o = c.summary().byMachine.x.outliers;
  assert.deepEqual(Object.keys(o), ['a', 'b']);
  assert.equal(o.a.count, 1);
  assert.equal(o.a.rows, 20);
  assert.ok(Math.abs(o.a.thresholdMs - 10) < 1e-9);
  assert.deepEqual(o.a.bySpendable, { '4-7': { outliers: 0, all: 19 }, '32-63': { outliers: 1, all: 1 } });
  assert.deepEqual(o.a.byType, { T1: { outliers: 0, all: 19 }, T2: { outliers: 1, all: 1 } });
  assert.deepEqual(o.a.byInputs, { '2-3': { outliers: 0, all: 19 }, '8-15': { outliers: 1, all: 1 } });
  assert.equal(o.b.count, 0);
  assert.equal(o.b.rows, 5);
  assert.ok(o.a.rule.includes('3 x IQR'));
});
