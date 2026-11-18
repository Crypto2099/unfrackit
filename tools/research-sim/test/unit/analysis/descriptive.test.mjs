// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// H-7, H-8, H-9 and H-11 (src/analysis/descriptive.mjs) on synthetic studies
// written by test/lib/analysis-fixtures.mjs, each expected number computed by
// hand in the test. Bootstrap resamples are kept small.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStudy } from '../../../src/analysis/read.mjs';
import { wilson, runChunk, STATISTICS, CHUNK_SIZE } from '../../../src/analysis/stats.mjs';
import { runQuestions } from '../../../src/analysis/questions.mjs';
import { driftFlags, runSlope, walletSlope, runDrift, mergeBins, censusSummary, runCensus, conformingShareOf, runConforming, changeSelectionValues, runChangeSelection, runDescriptive } from '../../../src/analysis/descriptive.mjs';
import { writeStudy, optionsFor, fullJobs, built, failed, infeasible, RULE } from '../../lib/analysis-fixtures.mjs';

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);
const N = 250;
const ONE = { minWallets: 1, resamples: N };

// n spends of intents 0..n-1: those in `fail` fail, those in `skip` are
// infeasible, the rest are built at `fee`; `at` overrides the options of
// built spend i.
const run = (n, { fail = [], skip = [], fee = 100000, at = {} } = {}) =>
  Array.from({ length: n }, (_, i) => (fail.includes(i) ? failed(i, 'change-minimum') : skip.includes(i) ? infeasible(i) : built(i, { fee, walletFee: fee, ...(at[i] || {}) })));

// A corpus wallet over every library; `over` maps `<method>/<arm>[/<rep>]` to
// spends, `wa` maps the same keys to wallet-arm fields.
function wal(id, group, over = {}, { reps = 1, wa = {} } = {}) {
  const jobs = fullJobs((m, arm, rep) => over[`${m}/${arm}/${rep}`] || over[`${m}/${arm}`] || run(5), { reps });
  for (const j of jobs) {
    const w = wa[`${j.method}/${j.arm}/${j.rep}`] || wa[`${j.method}/${j.arm}`];
    if (w) j.wa = w;
  }
  return { id, group, jobs };
}

async function tablesOf(wallets, desc = {}) {
  const root = mkdtempSync(join(tmpdir(), 'analysis-d-'));
  dirs.push(root);
  const w = writeStudy(root, { wallets, ...desc });
  return readStudy(optionsFor(root, w));
}
const armOfTable = (t, id) => t.arms.get(id);
const cell = (res, id) => res.arms.find((a) => a.arm === id);

// ---------------------------------------------------------------------------
// H-7

// maxValSize 5000: E1 lines are 2500, 4000 and 4500 bytes. Six wallets in
// csl-lf/own, groups B1, B1, B2, B2, B3, B3 (weights 2, 2, 2, 2, 1, 1; total 10).
//   A: spend 0 writes 4001 bytes of change from inputs of 100: E1 at 0.5 and 0.8, not at 0.9.
//   B: spend 0 writes 4500 from an input of 4001: it consumed a wallet UTxO over the 0.8 and 0.5 lines, and 4500 is not above 0.9 x 5000: no E1.
//   C: spend 0 makes 12 change outputs from 1 input; the other four spends make 1 from 1. Net 16 - 5 = 11, at least 10 and at least the 3 UTxOs at the start: E2.
//   D: the same spends with 20 UTxOs at the start: 11 < 20, no E2.
//   E: spend 0 locks 6,000,000 of change minimum against 1,000,000 consumed: net 5,000,000, E3.
//   F: net 4,999,999 (no E3), but spend 0 writes 4600 bytes of change from 100: E1 at 0.5, 0.8 and 0.9.
async function driftWallets() {
  const at0 = (o) => ({ 'csl-lf/own': run(5, { at: { 0: o } }) });
  const start = (utxos) => ({ 'csl-lf/own': { start: { t: 0, utxos, largestValueBytes: 5, lockedAda: '0', lockedAdaPerToken: null, tokens: 0 } } });
  return tablesOf([
    wal(101, 'B1', at0({ changeBytes: 4001, consumedBytes: 100 })),
    wal(102, 'B1', at0({ changeBytes: 4500, consumedBytes: 4001 })),
    wal(103, 'B2', at0({ changeCount: 12 })),
    wal(104, 'B2', at0({ changeCount: 12 }), { wa: start(20) }),
    wal(105, 'B3', at0({ changeMin: 6000000, consumedMin: 1000000 })),
    wal(106, 'B3', at0({ changeMin: 4999999 + 1000000, consumedMin: 1000000, changeBytes: 4600, consumedBytes: 100 }))
  ]);
}

test('E1, E2 and E3 on six hand-computed wallets, and the weighted shares with their Wilson intervals', async () => {
  const { wallets } = await driftWallets();
  const f = (i) => driftFlags(armOfTable(wallets[i], 'csl-lf/own'));
  assert.equal(f(0).e1, true);
  assert.equal(f(0).e1At50, true);
  assert.equal(f(0).e1At90, false);
  assert.equal(f(1).worse, false);
  assert.equal(f(2).e2, true);
  assert.equal(wallets[2].arms.get('csl-lf/own').runs.get(1).h7.e2.net, 11);
  assert.equal(f(3).e2, false);
  assert.equal(f(4).e3, true);
  assert.equal(wallets[4].arms.get('csl-lf/own').runs.get(1).h7.e3.net, 5000000n);
  assert.equal(f(5).e3, false);
  assert.equal(wallets[5].arms.get('csl-lf/own').runs.get(1).h7.e3.net, 4999999n);
  assert.equal(f(5).e1At90, true);
  const res = await runDrift(wallets, ONE);
  const a = cell(res, 'csl-lf/own');
  assert.equal(a.wallets, 6);
  // Weights 2, 2, 2, 2, 1, 1: effective n = 100 / (4 x 4 + 1 + 1) = 100 / 18.
  const effN = 100 / 18;
  const share = (c, p) => {
    near(c.share, p);
    near(c.effectiveN, effN);
    const w = wilson(p, effN);
    near(c.interval[0], w[0]);
    near(c.interval[1], w[1]);
  };
  // Worse: A, C, E, F = 2 + 2 + 1 + 1 = 6 of 10. E1: A and F = 3. E2: C = 2. E3: E = 1. At 0.5: A and F = 3. At 0.9: F = 1.
  share(a.shares.worse, 0.6);
  share(a.shares.e1, 0.3);
  share(a.shares.e2, 0.2);
  share(a.shares.e3, 0.1);
  share(a.shares.e1At50, 0.3);
  share(a.shares.e1At90, 0.1);
  assert.equal(a.shares.worse.flagged, 4);
  assert.equal(a.shares.worseAnyRun, undefined);
  // Every other csl-lf arm and every other library holds default spends: nobody is worse.
  assert.equal(cell(res, 'csl-lf/layout').shares.worse.share, 0);
});

test('a share cell under ten wallets is written with its count and no estimate', async () => {
  const { wallets } = await driftWallets();
  const res = await runDrift(wallets, { resamples: N });
  const a = cell(res, 'csl-lf/own');
  assert.deepEqual(a.shares.worse, { n: 6, flagged: 4, suppressed: true, share: null, effectiveN: null, interval: null });
  assert.equal(a.slopes.utxos.suppressed, true);
});

test('a chained answer is one spend: E2 and E3 count the chain\'s consolidated inputs', async () => {
  // The rule's spend 0 is a chain of 2 transactions that consumes 12 wallet UTxOs, writes 3 change outputs,
  // 3,000,000 of consumed token minimum and 2,000,000 of change token minimum; spend 1 is a plain 1-for-1.
  // E2 net = (3 + 1) - (12 + 1) = -9; E3 net = 2,000,000 - 3,000,000 = -1,000,000. Neither fires.
  const over = { [`${RULE}/on`]: [built(0, { txs: 2, fee: 500000, walletFee: 500000, consumed: 12, changeCount: 3, changeMin: 2000000, consumedMin: 3000000 }), built(1, { fee: 100000 })] };
  const { wallets } = await tablesOf([wal(101, 'B1', over)]);
  const r = wallets[0].arms.get(`${RULE}/on`).runs.get(1);
  assert.equal(r.n.chains, 1);
  assert.equal(r.h7.e2.net, -9);
  assert.equal(r.h7.e3.net, -1000000n);
  assert.equal(driftFlags(wallets[0].arms.get(`${RULE}/on`)).worse, false);
});

test('a random library: the majority rule over 10 runs and the share in any run', async () => {
  // csl-ri/own, 10 runs. P is worse (E1) in runs 1 to 5 (exactly half: worse), Q in runs 1 to 4 (4 of 10: not worse, but in any run), R in none.
  const worseRun = () => run(5, { at: { 0: { changeBytes: 4001, consumedBytes: 100 } } });
  const over = (k) => Object.fromEntries(Array.from({ length: k }, (_, i) => [`csl-ri/own/${i + 1}`, worseRun()]));
  const { wallets } = await tablesOf([wal(101, 'B1', over(5), { reps: 10 }), wal(102, 'B1', over(4), { reps: 10 }), wal(103, 'B1', over(0), { reps: 10 })]);
  const f = (i) => driftFlags(wallets[i].arms.get('csl-ri/own'));
  assert.equal(f(0).worse, true);
  assert.equal(f(1).worse, false);
  assert.equal(f(1).worseAnyRun, true);
  assert.equal(f(2).worseAnyRun, false);
  assert.equal(f(0).runs, 10);
  const res = await runDrift(wallets, ONE);
  const a = cell(res, 'csl-ri/own');
  // Equal weights: 1 of 3 worse, 2 of 3 in any run.
  near(a.shares.worse.share, 1 / 3);
  near(a.shares.worseAnyRun.share, 2 / 3);
  assert.equal(cell(res, 'csl-lf/own').shares.worseAnyRun, undefined);
});

// Slopes. Wallets in csl-lf/own, each with built spends at t = 1000, 2000, ... (intent i at (i + 1) x 1000).
// A year is 31,536,000 s.
//   W1: UTxO count 3 at the start, 5 and 7 after: y = 3 + 0.002 t, slope 0.002 per second, over start 3, x 31,536,000 = 21,024.
//   W2: 3, 4, 8 at t 0, 1000, 2000: t mean 1000, y mean 5, Sxx = 2e6, Sxy = (-1000)(-2) + 0 + (1000)(3) = 5000, slope 0.0025;
//       0.0025 / 3 x 31,536,000 = 26,280.
//   W3: 3, 3, 3: slope 0.
//   The median over weights 2 (B1), 2 (B2), 1 (B3): values 0 (1), 21,024 (2), 26,280 (2); half of 5 is 2.5, reached at 21,024.
test('drift slopes: OLS on three points, scaled to a year, and the weighted median with its interval', async () => {
  const lf = (a, b) => ({ 'csl-lf/own': [built(0, { utxos: a }), built(1, { utxos: b })] });
  const { wallets } = await tablesOf([wal(101, 'B1', lf(5, 7)), wal(102, 'B2', lf(4, 8)), wal(103, 'B3', lf(3, 3))]);
  near(walletSlope(wallets[0].arms.get('csl-lf/own'), 'utxos'), 21024, 1e-6);
  near(walletSlope(wallets[1].arms.get('csl-lf/own'), 'utxos'), 26280, 1e-6);
  near(walletSlope(wallets[2].arms.get('csl-lf/own'), 'utxos'), 0, 1e-9);
  const res = await runDrift(wallets, ONE);
  const s = cell(res, 'csl-lf/own').slopes.utxos;
  assert.equal(s.n, 3);
  near(s.estimate, 21024, 1e-6);
  assert.ok(s.interval[0] >= 0 && s.interval[1] <= 26280 + 1e-6);
  assert.equal(s.name, 'h7/recent/slope/utxos/csl-lf/own');
});

test('drift slopes: a run with one built spend, or a zero start, has no slope; the largest value bytes slope divides by its own start', async () => {
  // Y: one built spend. Z: three UTxOs at the start become 0, and two built spends: start 0 is not positive.
  // V: largest value bytes 100 at the start, 150 and 200 after: y = 100 + 0.05 t, 0.05 / 100 x 31,536,000 = 15,768.
  const start = (o) => ({ 'csl-lf/own': { start: { t: 0, utxos: 3, largestValueBytes: 5, lockedAda: '0', lockedAdaPerToken: null, tokens: 0, ...o } } });
  const { wallets } = await tablesOf([
    wal(101, 'B1', { 'csl-lf/own': [built(0, { utxos: 9 })] }),
    wal(102, 'B1', { 'csl-lf/own': [built(0, { utxos: 4 }), built(1, { utxos: 5 })] }, { wa: start({ utxos: 0 }) }),
    wal(103, 'B1', { 'csl-lf/own': [built(0, { bytesAfter: 150 }), built(1, { bytesAfter: 200 })] }, { wa: start({ largestValueBytes: 100 }) })
  ]);
  const arm = (i) => wallets[i].arms.get('csl-lf/own');
  assert.equal(walletSlope(arm(0), 'utxos'), null);
  assert.equal(walletSlope(arm(1), 'utxos'), null);
  near(walletSlope(arm(2), 'largestValueBytes'), 15768, 1e-6);
});

test('D7: a point with no token held is left out of the locked ADA per token regression, and the slope needs two built-spend points', async () => {
  // P: start 1,000,000 per token; after spends at t 1000, 2000, 3000: 2,000,000, none held, 4,000,000.
  // Leaving the null out: points (0, 1), (1000, 2), (3000, 4) in millions: y = 1 + t / 1000, slope 0.001 per second over start 1: x 31,536,000 = 31,536.
  // Q: one built-spend point left (2,000,000, then none held): no slope. R: no token at the start: no slope.
  const tokenStart = { 'csl-lf/own': { start: { t: 0, utxos: 3, largestValueBytes: 5, lockedAda: '0', lockedAdaPerToken: '1000000', tokens: 1 } } };
  const { wallets } = await tablesOf([
    wal(101, 'B1', { 'csl-lf/own': [built(0, { perToken: 2000000 }), built(1, { perToken: null }), built(2, { perToken: 4000000 })] }, { wa: tokenStart }),
    wal(102, 'B1', { 'csl-lf/own': [built(0, { perToken: 2000000 }), built(1, { perToken: null })] }, { wa: tokenStart }),
    wal(103, 'B1', { 'csl-lf/own': [built(0, { perToken: 2000000 }), built(1, { perToken: 3000000 })] })
  ]);
  const arm = (i) => wallets[i].arms.get('csl-lf/own');
  near(walletSlope(arm(0), 'lockedAdaPerToken'), 31536, 1e-6);
  assert.equal(walletSlope(arm(1), 'lockedAdaPerToken'), null);
  assert.equal(walletSlope(arm(2), 'lockedAdaPerToken'), null);
  const res = await runDrift(wallets, ONE);
  const s = cell(res, 'csl-lf/own').slopes.lockedAdaPerToken;
  assert.equal(s.n, 1);
  near(s.estimate, 31536, 1e-6);
});

test('a run the replay refused is outside the drift population and has no slope', async () => {
  const w = wal(101, 'B1', {});
  w.jobs.find((j) => j.method === 'csl-lf' && j.arm === 'own').refused = 'too big';
  const { wallets } = await tablesOf([w, wal(102, 'B1', {})]);
  const res = await runDrift(wallets, ONE);
  assert.equal(cell(res, 'csl-lf/own').wallets, 1);
  assert.equal(cell(res, 'csl-lf/layout').wallets, 2);
  assert.equal(runSlope(wallets[0].arms.get('csl-lf/own').runs.get(1), 'utxos'), null);
});

// ---------------------------------------------------------------------------
// H-8

// Twenty rows i = 1..20: i UTxOs, the first 12 hold a token UTxO, largest value 100 i bytes,
// near the 50% line from i = 10, the 80% line from i = 19, the 90% line at i = 20;
// locked ADA i (millions of lovelace) for i <= 12 else 0, excess 500,000 for i <= 12, coin 10,000,000 i.
const censusRows = () =>
  Array.from({ length: 20 }, (_, k) => {
    const i = k + 1;
    return { wallet: `c${i}`, utxos: i, tokenUtxos: i <= 12 ? 1 : 0, largestValueBytes: 100 * i, nearCap50: i >= 10, nearCap80: i >= 19, nearCap90: i === 20, lockedAda: BigInt(i <= 12 ? i * 1000000 : 0), excessAda: BigInt(i <= 12 ? 500000 : 0), coin: BigInt(i) * 10000000n };
  });

test('census: type-7 quantiles of the UTxO count over all 20 eligible wallets, by hand', () => {
  // Sorted 1..20, h = 19 p. p1: h 0.19, 1.19. p5: 0.95, 1.95. p10: 1.9, 2.9. p25: 4.75 between 5 and 6, 5.75.
  // p50: 9.5, 10.5. p75: 14.25, 15.25. p90: 17.1 between 18 and 19, 18.1. p95: 18.05, 19.05. p99: 18.81, 19.81.
  const c = runCensus(censusRows());
  const q = c.populations.allEligible.quantities.utxos.quantiles;
  const want = { p1: 1.19, p5: 1.95, p10: 2.9, p25: 5.75, p50: 10.5, p75: 15.25, p90: 18.1, p95: 19.05, p99: 19.81 };
  for (const [k, v] of Object.entries(want)) near(q[k], v, 1e-9);
  // Locked ADA, eight zeros then 1..12 million: p50: h 9.5 between index 9 (2,000,000) and index 10 (3,000,000): 2,500,000.
  near(c.populations.allEligible.quantities.lockedAda.quantiles.p50, 2500000, 1e-6);
});

test('census: bins of powers of two merged from the tails inward until every cell holds the minimum', () => {
  // UTxO counts 1..20: [1,2) 1, [2,4) 2, [4,8) 4, [8,16) 8, [16,32) 5.
  const rows = censusRows();
  // Minimum 10: [1,2) joins [2,4) (3), then [4,8) (7), then [8,16) (15); [16,32) has 5 and joins it: one cell of 20.
  assert.deepEqual(runCensus(rows).populations.allEligible.quantities.utxos.bins, [{ from: 1, to: 32, n: 20 }]);
  // Minimum 5: 1, 3, 7 merge into [1,8) = 7; [8,16) = 8 and [16,32) = 5 stand.
  assert.deepEqual(runCensus(rows, { minWallets: 5 }).populations.allEligible.quantities.utxos.bins, [{ from: 1, to: 8, n: 7 }, { from: 8, to: 16, n: 8 }, { from: 16, to: 32, n: 5 }]);
});

test('census: ADA bins of the collateral report, merged from the tails with the middle joining the smaller neighbor, by hand', () => {
  // Locked ADA of all 20 wallets: eight zeros, then 1..12 ADA. Bins [0,1) 8, [1,2) 1, [2,5) 3 (2, 3, 4), [5,10) 5 (5..9), [10,20) 3 (10, 11, 12), the rest 0.
  // Minimum 5: the empty bins at the high end join inward until [10,20) is the last (3), which joins [5,10): [5, open) 8.
  // Then [1,2) (1) joins [2,5): [1,5) 4, which is the middle of three and joins the lower neighbor on a tie of 8 and 8: [0,5) 12.
  const bins = runCensus(censusRows(), { minWallets: 5 }).populations.allEligible.quantities.lockedAda.bins;
  assert.deepEqual(bins, [{ fromLovelace: '0', toLovelace: '5000000', n: 12 }, { fromLovelace: '5000000', toLovelace: null, n: 8 }]);
});

test('census: both populations are labeled, and the shares near the cap and the ADA-weighted shares come out by hand', () => {
  const c = runCensus(censusRows());
  const all = c.populations.allEligible;
  const tok = c.populations.tokenHolding;
  assert.equal(all.n, 20);
  assert.equal(tok.n, 12);
  assert.ok(all.label && tok.label && all.label !== tok.label);
  // Near the cap, all: 50% line from i = 10 is 11 wallets, 80% line 2, 90% line 1. Token holders (i <= 12): 3, 0, 0 of 12.
  assert.deepEqual(all.nearCap, { nearCap50: { n: 11, share: 0.55 }, nearCap80: { n: 2, share: 0.1 }, nearCap90: { n: 1, share: 0.05 } });
  assert.deepEqual(tok.nearCap, { nearCap50: { n: 3, share: 0.25 }, nearCap80: { n: 0, share: 0 }, nearCap90: { n: 0, share: 0 } });
  // Coin 10,000,000 x (1 + ... + 20) = 2,100,000,000; locked 78,000,000 (1 + ... + 12); excess 12 x 500,000 = 6,000,000.
  assert.equal(all.adaWeighted.coin, '2100000000');
  assert.equal(all.adaWeighted.lockedAda, '78000000');
  assert.equal(all.adaWeighted.excessAda, '6000000');
  near(all.adaWeighted.lockedShare, 78 / 2100, 1e-9);
  near(all.adaWeighted.excessShare, 6 / 2100, 1e-9);
  // Token holders: coin 10,000,000 x 78 = 780,000,000; locked / coin = 0.1; excess / coin = 6 / 780.
  assert.equal(tok.adaWeighted.coin, '780000000');
  near(tok.adaWeighted.lockedShare, 0.1, 1e-9);
  near(tok.adaWeighted.excessShare, 6 / 780, 1e-9);
});

test('census: a row without coin is left out of the ADA-weighted sums and counted; under ten wallets nothing is estimated', () => {
  const rows = censusRows();
  rows[0].coin = null;
  const a = runCensus(rows).populations.allEligible.adaWeighted;
  // Row 1 (10,000,000 coin, 1,000,000 locked, 500,000 excess) is out: 2,090,000,000, 77,000,000 and 5,500,000.
  assert.equal(a.walletsWithoutCoin, 1);
  assert.equal(a.wallets, 19);
  assert.equal(a.coin, '2090000000');
  assert.equal(a.lockedAda, '77000000');
  assert.equal(a.excessAda, '5500000');
  assert.deepEqual(censusSummary(censusRows().slice(0, 9)), { n: 9, suppressed: true });
  assert.deepEqual(runCensus(censusRows().filter((r) => r.tokenUtxos > 0).slice(0, 5)).populations.tokenHolding.suppressed, true);
});

test('merging bins: a single bin stays and an exact middle takes the smaller neighbor', () => {
  assert.deepEqual(mergeBins([{ lo: 0, hi: 1, n: 3 }], 10), [{ lo: 0, hi: 1, n: 3 }]);
  // [12, 2, 3, 20, 14]: depths 0, 1, 2, 1, 0. Underfull: the 2 (depth 1) and the 3 (depth 2). The 2 joins its inward neighbor, the 3: [12, 5, 20, 14]; the 5 (depth 1) joins the 20: [12, 25, 14].
  assert.deepEqual(mergeBins([{ lo: 0, hi: 1, n: 12 }, { lo: 1, hi: 2, n: 2 }, { lo: 2, hi: 3, n: 3 }, { lo: 3, hi: 4, n: 20 }, { lo: 4, hi: 5, n: 14 }], 10).map((b) => b.n), [12, 25, 14]);
  // [20, 4, 30]: the middle joins the smaller neighbor, the 20.
  assert.deepEqual(mergeBins([{ lo: 0, hi: 1, n: 20 }, { lo: 1, hi: 2, n: 4 }, { lo: 2, hi: 3, n: 30 }], 10), [{ lo: 0, hi: 2, n: 24 }, { lo: 2, hi: 3, n: 30 }]);
});

// ---------------------------------------------------------------------------
// H-9

const conf = (tokenUtxos, conforming, conformingNoCoin) => ({ proposes: true, txs: 1, fee: '200000', tokenUtxos, conforming, conformingNoCoin });

// csl-ri, 2 repetitions, B1 (weight 2), B2 (weight 2), B3 (weight 1).
//   W1: own rep 1: 4 token UTxOs, 2 conform, 3 without the coin rule (.5, .75); rep 2: none (no share). Layout rep 1: 4 of 4 (1, 1); rep 2: 5 of 5 (1, 1).
//       Shares: own .5 / .75, layout 1 / 1. Difference over the repetition both have: rep 1, 1 - .5 = .5 and 1 - .75 = .25.
//   W2: own 5 of 10 conform, all 10 without coin, in both repetitions (.5, 1); layout 8 of 10, 10 of 10 (.8, 1). Difference .3 and 0.
//   W3: no token UTxO in any arm: counted apart.
test('H-9: per-arm weighted shares with and without the coin rule, the difference of a repetition lacking a share, and wallets with no token UTxO', async () => {
  const over = {};
  const wa = {
    'csl-ri/own/1': { conformity: conf(4, 2, 3) },
    'csl-ri/own/2': { conformity: conf(0, 0, 0) },
    'csl-ri/layout/1': { conformity: conf(4, 4, 4) },
    'csl-ri/layout/2': { conformity: conf(5, 5, 5) }
  };
  const wb = { 'csl-ri/own/1': { conformity: conf(10, 5, 10) }, 'csl-ri/own/2': { conformity: conf(10, 5, 10) }, 'csl-ri/layout/1': { conformity: conf(10, 8, 10) }, 'csl-ri/layout/2': { conformity: conf(10, 8, 10) } };
  const { wallets } = await tablesOf([wal(101, 'B1', over, { reps: 2, wa }), wal(102, 'B2', over, { reps: 2, wa: wb }), wal(103, 'B3', over, { reps: 2 })]);
  assert.equal(conformingShareOf(wallets[0].arms.get('csl-ri/own').runs.get(2)), null);
  near(conformingShareOf(wallets[0].arms.get('csl-ri/own').runs.get(1), 'conformingNoCoin'), 0.75);
  const res = await runConforming(wallets, ONE);
  const own = res.arms.find((a) => a.arm === 'csl-ri/own');
  const lay = res.arms.find((a) => a.arm === 'csl-ri/layout');
  assert.equal(own.wallets, 3);
  assert.equal(own.noTokenUtxo, 1);
  // Weights 2, 2: own with coin (2 x .5 + 2 x .5) / 4 = .5; without (2 x .75 + 2 x 1) / 4 = .875; layout (2 x 1 + 2 x .8) / 4 = .9, without 1.
  assert.equal(own.share.withCoin.n, 2);
  near(own.share.withCoin.estimate, 0.5);
  near(own.share.noCoin.estimate, 0.875);
  near(lay.share.withCoin.estimate, 0.9);
  near(lay.share.noCoin.estimate, 1);
  const d = res.differences.find((x) => x.library === 'csl-ri');
  // (2 x .5 + 2 x .3) / 4 = .4; without the coin rule (2 x .25 + 2 x 0) / 4 = .125.
  near(d.difference.withCoin.estimate, 0.4);
  near(d.difference.noCoin.estimate, 0.125);
  assert.equal(d.difference.withCoin.n, 2);
  assert.equal(d.difference.withCoin.name, 'h9/recent/diff/csl-ri');
  // A deterministic library with no token UTxO anywhere has no difference cell estimate.
  assert.equal(res.differences.find((x) => x.library === 'csl-lf').difference.withCoin.estimate, null);
});

// ---------------------------------------------------------------------------
// H-11

// csl-lf, deterministic. W1 (B1, weight 2): own 10 spends, 2 fail (20 per 100), built 8 at 100,000 (F 800,000);
// layout 1 fails (10 per 100), 9 built at 90,000 (810,000); the rule none fail, 10 at 80,000 (800,000).
//   a = layout - own: failures 10 - 20 = -10; fees 10,000. b = rule - layout: -10; -10,000.
// W2 (B2, weight 2): own 5 built at 100,000 (0 per 100, 500,000); layout 1 fails of 5 (20 per 100), 4 built at 100,000 (400,000);
// the rule 5 built at 100,000 (0, 500,000). a = 20; -100,000. b = -20; +100,000.
// W3 (B3, weight 1): own has 4 attempted spends: the wallet does not qualify.
const h11Wallets = () => {
  const mk = (own, layout, rule) => ({ 'csl-lf/own': own, 'csl-lf/layout': layout, [`${RULE}/on`]: rule, [`${RULE}/off`]: rule });
  return tablesOf([
    wal(101, 'B1', mk(run(10, { fail: [0, 1] }), run(10, { fail: [0], fee: 90000 }), run(10, { fee: 80000 }))),
    wal(102, 'B2', mk(run(5), run(5, { fail: [0] }), run(5))),
    wal(103, 'B3', mk(run(5, { skip: [4] }), run(5), run(5)))
  ]);
};

test('H-11: the change and selection effects and their difference, by hand, on two qualifying wallets', async () => {
  const { wallets } = await h11Wallets();
  const v = changeSelectionValues(wallets[0], 'csl-lf');
  assert.deepEqual(v.failures, { own: 20, layout: 10, rule: 0 });
  assert.deepEqual(v.fees, { own: 800000, layout: 810000, rule: 800000 });
  assert.equal(changeSelectionValues(wallets[2], 'csl-lf'), null);
  const res = await runChangeSelection(wallets, ONE);
  const row = (outcome) => res.rows.find((r) => r.library === 'csl-lf' && r.outcome === outcome);
  // Failures: mean a = (2 x -10 + 2 x 20) / 4 = 5, mean b = (2 x -10 + 2 x -20) / 4 = -15: change 5, selection 15, difference -10.
  const f = row('failures');
  assert.equal(f.wallets, 2);
  near(f.change.estimate, 5);
  near(f.selection.estimate, 15);
  near(f.difference.estimate, -10);
  // Fees: mean a = (2 x 10,000 + 2 x -100,000) / 4 = -45,000, mean b = (2 x -10,000 + 2 x 100,000) / 4 = 45,000: 45,000, 45,000, 0.
  const g = row('fees');
  near(g.change.estimate, 45000, 1e-6);
  near(g.selection.estimate, 45000, 1e-6);
  near(g.difference.estimate, 0, 1e-6);
  // The means behind them: layout failures (2 x 10 + 2 x 20) / 4 = 15.
  near(f.means.layout, 15);
  assert.equal(f.change.name, 'h11/recent/failures/csl-lf');
});

test('H-11: a random library qualifies by repetition, and the rule\'s one run enters each', async () => {
  // csl-ri own rep 1: 5 attempted, 1 fails (20 per 100), 4 built at 100,000 (400,000); rep 2: 4 attempted (one infeasible): not qualifying.
  // Layout both reps 5 built (0, 500,000). Rule 5 built (0, 500,000). One repetition qualifies.
  const over = { 'csl-ri/own/1': run(5, { fail: [4] }), 'csl-ri/own/2': run(5, { skip: [4] }) };
  const { wallets } = await tablesOf([wal(101, 'B1', over, { reps: 2 })]);
  const v = changeSelectionValues(wallets[0], 'csl-ri');
  assert.equal(v.repetitions, 1);
  assert.deepEqual(v.failures, { own: 20, layout: 0, rule: 0 });
  assert.deepEqual(v.fees, { own: 400000, layout: 500000, rule: 500000 });
});

test('H-11: the three statistics are computed on one resample', () => {
  // Two wallets per group in B1 and B2 with distinct a and b.
  const wallets = [
    { id: 'a', group: 'B1', weight: 2, v: [3, -1] },
    { id: 'b', group: 'B1', weight: 2, v: [-5, 4] },
    { id: 'c', group: 'B2', weight: 1, v: [2, 7] },
    { id: 'd', group: 'B2', weight: 1, v: [-1, -2] }
  ];
  const task = (statistic) => ({ name: 'h11/recent/failures/x', statistic, wallets, chunk: 0, count: 100 });
  const change = runChunk(task('absMean'));
  const selection = runChunk(task('h11Selection'));
  const difference = runChunk(task('h11Difference'));
  let distinct = 0;
  for (let r = 0; r < change.length; r++) {
    near(difference[r], change[r] - selection[r], 1e-12);
    if (Math.abs(change[r] - selection[r]) > 1e-9) distinct++;
  }
  assert.ok(distinct > 50);
  // On the sample itself: mean a = (6 - 10 + 2 - 1) / 6 = -0.5, mean b = (-2 + 8 + 7 - 2) / 6 = 11/6.
  const d = { w: Float64Array.from([2, 2, 1, 1]), a: Float64Array.from([3, -5, 2, -1]), b: Float64Array.from([-1, 4, 7, -2]) };
  const idx = Int32Array.from([0, 1, 2, 3]);
  near(STATISTICS.absMean(d, idx), 0.5);
  near(STATISTICS.h11Selection(d, idx), 11 / 6);
  near(STATISTICS.h11Difference(d, idx), 0.5 - 11 / 6);
  assert.ok(CHUNK_SIZE >= 100);
});

// ---------------------------------------------------------------------------
// The whole, and determinism

test('every bootstrap cell has a name under its own prefix, unique but for the H-11 triples, and none reuses a name of questions 1 and 2', async () => {
  const { wallets } = await h11Wallets();
  const q = await runQuestions(wallets, { resamples: 20 });
  const qNames = new Set([...q.cells.map((c) => c.name), q.absorption.fees.name, q.absorption.failures.name]);
  const d = await runDescriptive(wallets, censusRows(), { ...ONE });
  const names = [];
  for (const a of d.h7.arms) for (const c of Object.values(a.slopes)) names.push(c.name);
  for (const a of d.h9.arms) for (const c of Object.values(a.share)) names.push(c.name);
  for (const x of d.h9.differences) for (const c of Object.values(x.difference)) names.push(c.name);
  const h11 = d.h11.rows.map((r) => r.change.name);
  for (const n of [...names, ...h11]) {
    assert.ok(/^h(7|9|11)\//.test(n), n);
    assert.ok(!qNames.has(n));
  }
  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(h11).size, h11.length);
  assert.ok(d.h8.populations.allEligible.n === 20);
});

test('results are identical at 1, 2 and 4 workers', async () => {
  const { wallets } = await h11Wallets();
  const census = censusRows();
  const json = (x) => JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const at = async (workers) => json(await runDescriptive(wallets, census, { workers, minWallets: 1, resamples: 2 * N }));
  const one = await at(1);
  assert.equal(await at(2), one);
  assert.equal(await at(4), one);
  assert.equal(await at(1), one);
});
