// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The statistics core, each function against a hand-computed small case.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  weightedMean, weightedMedian, quantile, quantiles, effectiveN, wilson, weightedShare, insideBand, reportable,
  mergeSizeGroups, seedFor, bootstrap, SEED_CONSTANT, CHUNK_SIZE
} from '../../../src/analysis/stats.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);
const W = (id, group, weight, ...v) => ({ id, group, weight, v });

test('weighted mean: (1*1 + 2*1 + 3*2 + 4*4) / (1+1+2+4) = 25/8', () => {
  assert.equal(weightedMean([1, 2, 3, 4], [1, 1, 2, 4]), 3.125);
  assert.equal(weightedMean([], []), null);
});

test('weighted median: equal weights give the ordinary median, even count takes the mean of the middle two', () => {
  // total 4, half 2; cumulative weight reaches 2 exactly at the value 2, so mean(2, 3).
  assert.equal(weightedMedian([4, 1, 3, 2], [1, 1, 1, 1], ['d', 'a', 'c', 'b']), 2.5);
  // odd count: total 3, half 1.5; cumulative 1, 2: first value at or above half is the middle one.
  assert.equal(weightedMedian([5, 1, 3], [1, 1, 1]), 3);
});

test('weighted median: cumulative weight crossing half takes that value', () => {
  // values 1,2,3,4 with weights 1,1,3,1: total 6, half 3; cumulative 1, 2, 5: crosses at 3.
  assert.equal(weightedMedian([1, 2, 3, 4], [1, 1, 3, 1]), 3);
  // a heavy low value: weights 5,1,1: total 7, half 3.5; cumulative 5 at the value 1.
  assert.equal(weightedMedian([1, 2, 3], [5, 1, 1]), 1);
});

test('weighted median: exactly half takes the mean of that value and the next', () => {
  // weights 3,1,1,1: total 6, half 3, cumulative 3 at the first value: mean(1, 2).
  assert.equal(weightedMedian([1, 2, 3, 4], [3, 1, 1, 1]), 1.5);
  // weights 1,1,2 on values 5,5,7: total 4, half 2, cumulative 2 at the second 5: mean(5, 7).
  assert.equal(weightedMedian([5, 5, 7], [1, 1, 2]), 6);
  // fractional weights summing to exact halves: 0.5, 0.25, 0.25.
  assert.equal(weightedMedian([10, 20, 30], [0.5, 0.25, 0.25]), 15);
});

test('weighted median: tied values give the same value whatever the ids, and the tied half takes the next value', () => {
  // values 2,2,2,9 equal weights: half 2, cumulative 2 at the second 2, next value is 2: mean(2, 2) = 2.
  assert.equal(weightedMedian([2, 2, 2, 9], [1, 1, 1, 1]), 2);
  // ids order the ties only: ('b' weight 1, 'a' weight 3) sorts a first, cumulative 3 > half 2.
  assert.equal(weightedMedian([3, 3], [1, 3], ['b', 'a']), 3);
  assert.equal(weightedMedian([3, 3], [1, 3], ['a', 'b']), 3);
  assert.equal(weightedMedian([7], [0.3]), 7);
  assert.equal(weightedMedian([], []), null);
});

test('quantiles, type 7, on 1..10: h = 9 p, interpolating between order statistics', () => {
  const v = [10, 3, 1, 7, 5, 2, 9, 4, 8, 6];
  near(quantile(v, 0), 1);
  near(quantile(v, 1), 10);
  near(quantile(v, 0.5), 5.5); // h = 4.5: 5 + 0.5 * (6 - 5)
  near(quantile(v, 0.1), 1.9); // h = 0.9: 1 + 0.9 * (2 - 1)
  near(quantile(v, 0.025), 1.225); // h = 0.225
  near(quantile(v, 0.99), 9.91); // h = 8.91: 9 + 0.91 * (10 - 9)
  const q = quantiles(v, [0.25, 0.75]); // h = 2.25 and 6.75
  near(q[0], 3.25);
  near(q[1], 7.75);
  assert.equal(quantile([], 0.5), null);
});

test('Wilson against published values (Newcombe 1998: 81/263, 15/148, 0/20)', () => {
  const a = wilson(81 / 263, 263);
  near(a[0], 0.2553, 5e-5);
  near(a[1], 0.3662, 5e-5);
  const b = wilson(15 / 148, 148);
  near(b[0], 0.0624, 5e-5);
  near(b[1], 0.1605, 5e-5);
  const c = wilson(0, 20);
  assert.equal(c[0], 0);
  near(c[1], 0.1611, 5e-5);
});

test('effective sample size and the weighted share: weights 2,2,1,1', () => {
  // (2+2+1+1)^2 / (4+4+1+1) = 36 / 10 = 3.6
  near(effectiveN([2, 2, 1, 1]), 3.6);
  // share = (2 + 1) / 6 = 0.5; Wilson at n = 3.6: z2 = 3.8416, d = 1 + 3.8416 / 3.6 = 2.0671,
  // centre 0.5, half = 1.96 * sqrt(0.25 / 3.6 + 3.8416 / (4 * 12.96)) / d = 0.3592.
  const s = weightedShare([true, false, false, true], [2, 2, 1, 1]);
  near(s.share, 0.5);
  near(s.n, 3.6);
  near(s.interval[0], 0.5 - 0.3592, 5e-4);
  near(s.interval[1], 0.5 + 0.3592, 5e-4);
  assert.equal(weightedShare([], []).share, null);
});

test('the band is closed: an interval ending exactly at the smallest effect is inside', () => {
  assert.equal(insideBand(-0.05, 0.05, 0.05), true);
  assert.equal(insideBand(-1, 1, 1), true);
  assert.equal(insideBand(-0.05, 0.0500001, 0.05), false);
  assert.equal(insideBand(-0.0500001, 0, 0.05), false);
  assert.equal(insideBand(0, 0, 0.05), true);
});

test('the ten-wallet rule: 9 is withheld, 10 is reported', () => {
  assert.equal(reportable(9), false);
  assert.equal(reportable(10), true);
});

test('size-group merge: B3 = 2, B2 = 7, B1 = 40 is one cell of 49', () => {
  const m = mergeSizeGroups({ B1: 40, B2: 7, B3: 2 });
  assert.deepEqual(m, { cells: [{ groups: ['B1', 'B2', 'B3'], label: 'B1+B2+B3', n: 49 }], wholeOnly: false });
});

test('size-group merge at 9 and 10 wallets', () => {
  // B3 = 9 merges with B2 (19); B1 = 40 stands alone.
  assert.deepEqual(mergeSizeGroups({ B1: 40, B2: 10, B3: 9 }).cells.map((c) => [c.label, c.n]), [['B1', 40], ['B2+B3', 19]]);
  // B3 = 10 stands alone; B2 = 9 merges with B1 (49).
  assert.deepEqual(mergeSizeGroups({ B1: 40, B2: 9, B3: 10 }).cells.map((c) => [c.label, c.n]), [['B1+B2', 49], ['B3', 10]]);
  // all three at 10 stand alone.
  assert.deepEqual(mergeSizeGroups({ B1: 10, B2: 10, B3: 10 }).cells.map((c) => [c.label, c.n]), [['B1', 10], ['B2', 10], ['B3', 10]]);
});

test('size-group merge reaching B0 leaves only the whole sample', () => {
  // B1..B3 = 4, 3, 2 add to 9: still under ten at B1, so the merge reaches B0.
  assert.deepEqual(mergeSizeGroups({ B1: 4, B2: 3, B3: 2 }), { cells: [], wholeOnly: true });
  // one more wallet makes ten and the merged cell stands.
  assert.deepEqual(mergeSizeGroups({ B1: 5, B2: 3, B3: 2 }).cells.map((c) => c.n), [10]);
  // B1 alone under ten while B2 and B3 stand: B1 would merge with B0, so whole only.
  assert.deepEqual(mergeSizeGroups({ B1: 7, B2: 12, B3: 11 }), { cells: [], wholeOnly: true });
  assert.deepEqual(mergeSizeGroups({}), { cells: [], wholeOnly: true });
});

test('seeds depend on the constant, the cell name and the chunk', () => {
  assert.equal(SEED_CONSTANT, 20261114);
  assert.equal(seedFor('a', 0), seedFor('a', 0));
  assert.notEqual(seedFor('a', 0), seedFor('b', 0));
  assert.notEqual(seedFor('a', 0), seedFor('a', 1));
  assert.ok(Number.isInteger(seedFor('a', 0)) && seedFor('a', 0) >= 0 && seedFor('a', 0) < 2 ** 32);
});

const noisy = () => [
  W('w1', 'B1', 2, 0.5, 1), W('w2', 'B1', 2, -1.5, 2), W('w3', 'B1', 2, 3, 1), W('w4', 'B2', 5, 0, 4), W('w5', 'B2', 5, 2.5, 1),
  W('w6', 'B3', 9, -4, 3)
];

test('bootstrap: estimates are the statistic on the original wallets, hand-computed', async () => {
  const wallets = noisy();
  const cells = [
    { name: 'mean', statistic: 'mean', wallets },
    { name: 'median', statistic: 'median', wallets },
    { name: 'abs', statistic: 'absMean', wallets },
    { name: 'ratio', statistic: 'ratio', wallets }
  ];
  const r = await bootstrap(cells, { resamples: 50 });
  // sum w v0 = 1 - 3 + 6 + 0 + 12.5 - 36 = -19.5 over sum w = 25.
  near(r[0].estimate, -0.78);
  near(r[2].estimate, 0.78);
  // sorted by value: -4 (9), -1.5 (2), 0 (5), 0.5 (2), 2.5 (5), 3 (2); half 12.5; cumulative 9, 11, 16: the value 0.
  assert.equal(r[1].estimate, 0);
  // sum w v1 = 2 + 4 + 2 + 20 + 5 + 27 = 60; ratio = -19.5 / 60 = -0.325.
  near(r[3].estimate, -0.325);
  for (const x of r) assert.equal(x.n, 6);
});

test('bootstrap over identical values collapses to them', async () => {
  const wallets = [W('a', 'B1', 1, 3), W('b', 'B1', 4, 3), W('c', 'B2', 2, 3), W('d', 'B3', 7, 3)];
  const r = await bootstrap(['mean', 'median'].map((s) => ({ name: s, statistic: s, wallets })), { resamples: 300 });
  for (const x of r) {
    assert.equal(x.estimate, 3);
    assert.deepEqual(x.intervals['0.9875'], [3, 3]);
    assert.deepEqual(x.intervals['0.95'], [3, 3]);
    assert.equal(x.resamples, 300);
  }
});

test('bootstrap keeps every size group at its count in every resample', async () => {
  // Unit weights, v0 = 1 for B2 wallets and 0 for the rest, v1 = 1: the ratio is the B2 count over
  // the total. With B2 = 2 of 5 wallets every resample must give exactly 2/5.
  const wallets = [W('a', 'B1', 1, 0, 1), W('b', 'B1', 1, 0, 1), W('c', 'B1', 1, 0, 1), W('d', 'B2', 1, 1, 1), W('e', 'B2', 1, 1, 1)];
  const [r] = await bootstrap([{ name: 'keep', statistic: 'ratio', wallets }], { resamples: CHUNK_SIZE + 10 });
  assert.deepEqual(r.intervals['0.95'], [0.4, 0.4]);
  assert.deepEqual(r.intervals['0.9875'], [0.4, 0.4]);
  // Without groups the same data would vary: one group of five.
  const flat = wallets.map((w) => ({ ...w, group: 'B1' }));
  const [f] = await bootstrap([{ name: 'keep', statistic: 'ratio', wallets: flat }], { resamples: 500 });
  assert.ok(f.intervals['0.95'][0] < 0.4 && f.intervals['0.95'][1] > 0.4);
});

test('bootstrap intervals bracket the estimate for a two-wallet cell and sit inside the data range', async () => {
  const wallets = [W('a', 'B1', 1, 0), W('b', 'B1', 1, 1)];
  const [r] = await bootstrap([{ name: 'two', statistic: 'mean', wallets }], { resamples: 400 });
  assert.equal(r.estimate, 0.5);
  const [lo, hi] = r.intervals['0.95'];
  assert.ok(lo >= 0 && hi <= 1 && lo <= 0.5 && hi >= 0.5);
  // the 98.75% interval is at least as wide as the 95% one.
  const [l2, h2] = r.intervals['0.9875'];
  assert.ok(l2 <= lo && h2 >= hi);
});

test('bootstrap: an empty cell has no estimate; a ratio with a zero denominator drops its resamples', async () => {
  const [e, z] = await bootstrap(
    [
      { name: 'empty', statistic: 'mean', wallets: [] },
      { name: 'zero', statistic: 'ratio', wallets: [W('a', 'B1', 1, 1, 0), W('b', 'B1', 1, 2, 0)] }
    ],
    { resamples: 20 }
  );
  assert.equal(e.estimate, null);
  assert.equal(e.n, 0);
  assert.equal(e.intervals['0.95'], null);
  assert.equal(z.estimate, null);
  assert.equal(z.dropped, 20);
  assert.equal(z.intervals['0.95'], null);
});

test('bootstrap: identical across two runs, input order, and 1, 2 and 4 workers', async () => {
  const cells = [
    { name: 'c1', statistic: 'mean', wallets: noisy() },
    { name: 'c2', statistic: 'median', wallets: noisy() },
    { name: 'c3', statistic: 'ratio', wallets: noisy() },
    { name: 'c4', statistic: 'absMean', wallets: noisy().slice(0, 4) }
  ];
  const opts = { resamples: CHUNK_SIZE * 2 + 30 };
  const base = JSON.stringify(await bootstrap(cells, { ...opts, workers: 1 }));
  assert.equal(JSON.stringify(await bootstrap(cells, { ...opts, workers: 1 })), base);
  for (const workers of [2, 4]) assert.equal(JSON.stringify(await bootstrap(cells, { ...opts, workers })), base);
  const shuffled = cells.map((c) => ({ ...c, wallets: [...c.wallets].reverse() }));
  assert.equal(JSON.stringify(await bootstrap(shuffled, { ...opts, workers: 2 })), base);
});

test('cells beyond one batch give the same results as the same cells in separate calls', async () => {
  const cell = (i) => ({ name: `batch/${i}`, statistic: 'mean', wallets: Array.from({ length: 5 }, (_, k) => ({ id: `w${k}`, group: 'B1', weight: 1 + (k % 2), v: [((i * 7 + k * 3) % 11) - 5] })) });
  const cells = Array.from({ length: 600 }, (_, i) => cell(i));
  const whole = await bootstrap(cells, { resamples: 20 });
  const parts = [...(await bootstrap(cells.slice(0, 300), { resamples: 20 })), ...(await bootstrap(cells.slice(300), { resamples: 20 }))];
  assert.deepEqual(whole, parts);
  assert.equal(whole.length, 600);
});
