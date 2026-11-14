// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Questions 1 and 2 and the verdict rules, on synthetic studies written by
// test/lib/analysis-fixtures.mjs, each expected number computed by hand in the
// test. Bootstrap resamples are kept small.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStudy } from '../../../src/analysis/read.mjs';
import { failureValue, feeValue, runQuestions, selectionFigures, cellName, studyLibraries } from '../../../src/analysis/questions.mjs';
import { classify, acrossLibraries, questionAnswer, absorptionDefault, selectionDefault, buildVerdicts, renderVerdicts } from '../../../src/analysis/verdicts.mjs';
import { writeStudy, optionsFor, fullJobs, built, failed, infeasible, METHODS, RULE } from '../../lib/analysis-fixtures.mjs';

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

// n spends of intents 0..n-1: the intents in `fail` fail, those in `skip` are
// infeasible, the rest are built with the given fee (intent 0 carries `d0` of
// fixed fee part on top, as a history intent with a fixed part does).
const run = (n, { fail = [], skip = [], fee = 100000, d0 = 0 } = {}) =>
  Array.from({ length: n }, (_, i) => (fail.includes(i) ? failed(i, 'change-minimum') : skip.includes(i) ? infeasible(i) : built(i, { fee: fee + (i === 0 ? d0 : 0), walletFee: fee })));

// Jobs of every library and the rule: `over` maps `<method>/<arm>[/<rep>]` to
// spends; every other job holds five built spends at a fee of 100000.
function jobs(over = {}, { reps = 2, d0 = 0 } = {}) {
  return fullJobs((m, arm, rep) => over[`${m}/${arm}/${rep}`] || over[`${m}/${arm}`] || run(5, { d0 }), { reps });
}

function tablesOf(wallets, desc = {}) {
  const root = mkdtempSync(join(tmpdir(), 'analysis-q-'));
  dirs.push(root);
  const w = writeStudy(root, { wallets, ...desc });
  return readStudy(optionsFor(root, w));
}
const wal = (id, group, over, extra = {}, jo = {}) => ({ id, group, jobs: jobs(over, jo), ...extra });
const lf = (own, layout, rule) => ({ 'csl-lf/own': own, 'csl-lf/layout': layout, ...(rule ? { [`${RULE}/on`]: rule, [`${RULE}/off`]: rule } : {}) });
const cellOf = (res, q, o, lib) => res.cells.find((c) => c.question === q && c.outcome === o && c.library === lib);
const N = 300;

test('cell names: question, outcome, library and arms, unique across a result', async () => {
  assert.equal(cellName('q1', 'failures', 'csl-lf', 'layout', 'own'), 'q1/failures/csl-lf/layout-vs-own');
  const { wallets } = await tablesOf([wal(101, 'B1', {})]);
  const res = await runQuestions(wallets, { resamples: 20 });
  assert.equal(res.libraries.length, 23);
  const names = [...res.cells.map((c) => c.name), res.absorption.fees.name, res.absorption.failures.name];
  assert.equal(new Set(names).size, 23 * 4 + 2);
  assert.ok(names.includes('q2/fees/csl-ri/on-vs-layout'));
});

test('per-wallet values: failures per 100 and fee ratio over intents built in both, hand computed', async () => {
  // csl-lf, deterministic. Own: 8 attempted (intents 6, 7 fail) = 25 per 100. Layout: 8 attempted
  // (intent 7 fails) = 12.5 per 100. y = 12.5 - 25 = -12.5.
  // Built in both: intents 0..5 (6 intents). F_own = 6 * 200000 = 1,200,000; F_layout = 6 * 150000 = 900,000;
  // R = 900000 / 1200000 - 1 = -0.25. Intent 6 is built in layout only and does not enter.
  const own = run(8, { fail: [6, 7], fee: 200000 });
  const layout = [...run(6, { fee: 150000 }), built(6, { fee: 150000 }), failed(7, 'change-minimum')];
  const { wallets } = await tablesOf([wal(101, 'B1', lf(own, layout))]);
  const t = wallets[0];
  near(failureValue(t.arms.get('csl-lf/layout'), t.arms.get('csl-lf/own')), -12.5);
  near(feeValue(t.arms.get('csl-lf/layout'), t.arms.get('csl-lf/own')), -0.25);
});

test('minimums: a repetition enters a failures value with 5 attempted spends in each arm and a fee value with 5 built in both; the wallet mean is over the entering repetitions', async () => {
  // csl-ri, 3 repetitions, paired by repetition.
  // rep 1: own 5 attempted, intent 4 fails (20 per 100); layout 5 built (0). Failures y = -20 enters.
  //        Built in both = 4 (< 5): the fee does not enter.
  // rep 2: both 5 built at 100000: y = 0 enters; R = 500000 / 500000 - 1 = 0 enters.
  // rep 3: layout has 4 attempted (intent 4 infeasible): neither enters.
  // Failures: mean(-20, 0) = -10. Fees: 0 (rep 2 only).
  const over = {
    'csl-ri/own/1': run(5, { fail: [4] }),
    'csl-ri/layout/1': run(5),
    'csl-ri/own/2': run(5),
    'csl-ri/layout/2': run(5),
    'csl-ri/own/3': run(5),
    'csl-ri/layout/3': run(5, { skip: [4] })
  };
  const { wallets } = await tablesOf([wal(101, 'B1', over, {}, { reps: 3 })]);
  const t = wallets[0];
  near(failureValue(t.arms.get('csl-ri/layout'), t.arms.get('csl-ri/own')), -10);
  near(feeValue(t.arms.get('csl-ri/layout'), t.arms.get('csl-ri/own')), 0);
});

test('a wallet with fewer than 5 attempted spends in an arm is left out of the failures outcome, and the cell counts only the others', async () => {
  // Wallets 101 to 104 (B1, B1, B2, B3 with weights 2, 2, 2, 1; draw 40/20, 40/20, 10/5, 2/2): own 10 attempted,
  // k = 1, 2, 3, 4 fail (10k per 100), layout 10 built: y = -10, -20, -30, -40.
  // Weighted mean = -(2*10 + 2*20 + 2*30 + 1*40) / 7 = -160/7. Wallet 105 (B1) has 4 attempted spends under own (one is infeasible): it does not enter.
  const mk = (k) => lf(run(10, { fail: Array.from({ length: k }, (_, i) => 6 + i), fee: 100000 }), run(10, { fee: 100000 - 10000 * k }));
  const wallets = [wal(101, 'B1', mk(1)), wal(102, 'B1', mk(2)), wal(103, 'B2', mk(3)), wal(104, 'B3', mk(4)), wal(105, 'B1', lf(run(5, { skip: [4] }), run(5)))];
  const { wallets: tables } = await tablesOf(wallets);
  const res = await runQuestions(tables, { resamples: N });
  const f = cellOf(res, 'q1', 'failures', 'csl-lf');
  assert.equal(f.n, 4);
  near(f.estimate, -160 / 7);
  // Fees: both built intents 0..9-k, F_own = (10-k) * 100000, F_layout = (10-k) * (100000 - 10000k): R = -0.1k.
  // Values -0.1 (w 2), -0.2 (2), -0.3 (2), -0.4 (1): total 7, half 3.5; cumulative from -0.4: 1, 3, 5: the median is -0.2.
  const r = cellOf(res, 'q1', 'fees', 'csl-lf');
  assert.equal(r.n, 4);
  near(r.estimate, -0.2);
  // Question 2 here: the rule arm holds the default five built spends, layout ten: the rule has 5 attempted.
  assert.equal(cellOf(res, 'q2', 'failures', 'csl-lf').n, 5);
});

test('question 2 pairs the rule\'s one run with every repetition of a random library\'s layout arm', async () => {
  // csl-ri layout rep 1: 5 built at 100000; rep 2: 5 built at 100000, rep 3: 4 attempted. Rule: 5 built at 150000.
  // Fees: reps 1 and 2: 750000 / 500000 - 1 = 0.5; rep 3 has 4 built in both and does not enter. Mean 0.5.
  // Failures: rule 0 per 100, layout 0 per 100: y = 0 in reps 1 and 2; rep 3 has 4 attempted under layout and does not enter.
  const over = { 'csl-ri/layout/3': run(5, { skip: [4] }), [`${RULE}/on`]: run(5, { fee: 150000 }) };
  const { wallets } = await tablesOf([wal(101, 'B1', over, {}, { reps: 3 })]);
  const t = wallets[0];
  near(feeValue(t.arms.get(`${RULE}/on`), t.arms.get('csl-ri/layout'), 'a'), 0.5);
  near(failureValue(t.arms.get(`${RULE}/on`), t.arms.get('csl-ri/layout'), 'a'), 0);
  // Reversed, as the selection default's tie uses it: F_layout / F_rule - 1 = 500000 / 750000 - 1 = -1/3.
  near(feeValue(t.arms.get('csl-ri/layout'), t.arms.get(`${RULE}/on`), 'b'), -1 / 3);
});

test('question 2 failures: the rule\'s fail rate against the layout arm\'s, per wallet', async () => {
  // Rule: 10 attempted, 3 fail = 30 per 100. Layout: 10 attempted, 1 fails = 10 per 100. y = +20.
  const { wallets } = await tablesOf([wal(101, 'B1', lf(run(10), run(10, { fail: [3] }), run(10, { fail: [1, 2, 3] })))]);
  const t = wallets[0];
  near(failureValue(t.arms.get(`${RULE}/on`), t.arms.get('csl-lf/layout'), 'a'), 20);
});

test('a chained answer enters the fee ratio with its whole chain\'s wallet-controlled fee', async () => {
  // History intent 0 has a script fee of 100000 and 1000 fixed bytes at minFeeA 44: d = 100000 + 44 * 1000 = 144000.
  // Every single-transaction record of intent 0 has fee 344000 and walletFee 200000 (difference d).
  // The rule answers intent 0 with two transactions, total fee 700000: wallet-controlled fee 700000 - 144000 = 556000
  // (its walletFee field, 123, is the last transaction's only and is not used). Intents 1..4: 200000 each.
  // F_rule = 556000 + 4 * 200000 = 1,356,000; F_layout = 5 * 200000 = 1,000,000. R = 0.356.
  // Using the whole fee 700000 would give 1,500,000 / 1,000,000 - 1 = 0.5.
  const fee200 = (n = 5) => Array.from({ length: n }, (_, i) => built(i, { fee: i === 0 ? 344000 : 200000, walletFee: 200000 }));
  const rule = [built(0, { txs: 2, fee: 700000, walletFee: 123 }), ...fee200().slice(1)];
  const over = { 'csl-lf/own': fee200(), 'csl-lf/layout': fee200(), [`${RULE}/on`]: rule, [`${RULE}/off`]: rule };
  const wallets = [{ id: 101, group: 'B1', intents: Array.from({ length: 5 }, (_, i) => (i === 0 ? { scriptFee: 100000, fixedBytes: 1000 } : {})), jobs: jobs(over, { d0: 144000 }) }];
  const { wallets: tables } = await tablesOf(wallets);
  const t = tables[0];
  assert.equal(t.arms.get(`${RULE}/on`).runs.get(1).spends.get(0).walletFee, 556000n);
  near(feeValue(t.arms.get(`${RULE}/on`), t.arms.get('csl-lf/layout'), 'a'), 0.356);
});

test('each result of section 7.1 for one library and outcome, through the whole computation', async () => {
  // One library (csl-lf), question 1 failures. A wallet's own arm holds `own` failures in 100 attempted
  // spends and its layout arm `lay`; y = lay - own per 100.
  const study = async (pairs) => {
    const wallets = pairs.map(([own, lay], i) => wal(201 + i, 'B1', lf(run(100, { fail: Array.from({ length: own }, (_, k) => k * 2) }), run(100, { fail: Array.from({ length: lay }, (_, k) => k * 2) }))));
    const { wallets: tables } = await tablesOf(wallets);
    const res = await runQuestions(tables, { resamples: N, libraries: ['csl-lf'] });
    const c = cellOf(res, 'q1', 'failures', 'csl-lf');
    return { c, result: classify(c.estimate, c.intervals['0.9875'], 1) };
  };
  // Ten wallets, y = -20 each: every resample's mean is -20, interval [-20, -20], e = -20: supported (hi < 0, e <= -1).
  let r = await study(Array.from({ length: 10 }, () => [20, 0]));
  assert.deepEqual(r.c.intervals['0.9875'], [-20, -20]);
  assert.equal(r.result, 'supported');
  // Ten wallets, y = 0: interval [0, 0] is inside plus or minus 1: no meaningful difference.
  r = await study(Array.from({ length: 10 }, () => [5, 5]));
  assert.equal(r.c.estimate, 0);
  assert.equal(r.result, 'no meaningful difference');
  // Ten wallets, y = +20: interval [20, 20], e = 20: contradicted.
  r = await study(Array.from({ length: 10 }, () => [0, 20]));
  assert.equal(r.result, 'contradicted');
  // Five wallets at -20 and five at +20: e = 0, interval spans about [-20, 20]: inconclusive.
  r = await study([...Array.from({ length: 5 }, () => [20, 0]), ...Array.from({ length: 5 }, () => [0, 20])]);
  assert.equal(r.c.estimate, 0);
  assert.ok(r.c.intervals['0.9875'][0] < -1 && r.c.intervals['0.9875'][1] > 1);
  assert.equal(r.result, 'inconclusive');
  // A study where no wallet enters (own arm has 4 attempted spends): estimate null, inconclusive.
  const t2 = await tablesOf([wal(301, 'B1', lf(run(5, { skip: [4] }), run(5)))]);
  const res2 = await runQuestions(t2.wallets, { resamples: 20, libraries: ['csl-lf'] });
  const c2 = cellOf(res2, 'q1', 'failures', 'csl-lf');
  assert.equal(c2.n, 0);
  assert.equal(c2.estimate, null);
  assert.equal(classify(c2.estimate, c2.intervals['0.9875'], 1), 'inconclusive');
});

test('an interval ending exactly at the smallest effect is inside the band, through the whole computation', async () => {
  // Two wallets with y = -1 and y = +1 (1 failure in 100 attempted under one arm, none under the other).
  // A resample's mean is -1, 0 or 1 with probability 1/4, 1/2, 1/4, so the 0.625% and 99.375% points are -1 and 1:
  // the interval is [-1, 1], ending exactly at plus and minus the smallest effect, and e = 0: no meaningful difference.
  const wallets = [wal(401, 'B1', lf(run(100, { fail: [0] }), run(100))), wal(402, 'B1', lf(run(100), run(100, { fail: [0] })))];
  const { wallets: tables } = await tablesOf(wallets);
  const res = await runQuestions(tables, { resamples: 2000, libraries: ['csl-lf'] });
  const c = cellOf(res, 'q1', 'failures', 'csl-lf');
  assert.equal(c.estimate, 0);
  assert.deepEqual(c.intervals['0.9875'], [-1, 1]);
  assert.equal(classify(c.estimate, c.intervals['0.9875'], 1), 'no meaningful difference');
});

test('classify: each result from given estimate and interval, including the band\'s ends', () => {
  const f = (e, i) => classify(e, i, 1);
  assert.equal(f(-2, [-3, -0.5]), 'supported');
  assert.equal(f(-1, [-1.5, -0.2]), 'supported'); // e exactly at the smallest effect
  assert.equal(f(-0.9, [-1.5, -0.2]), 'inconclusive'); // e short of it, the interval leaves the band
  assert.equal(f(-0.9, [-1, -0.2]), 'no meaningful difference'); // whole interval inside, lower end exactly -1
  assert.equal(f(-2, [-3, 0]), 'inconclusive'); // hi = 0 does not exclude zero
  assert.equal(f(2, [0.4, 3]), 'contradicted');
  assert.equal(f(1, [0.1, 2]), 'contradicted'); // e exactly at the smallest effect
  assert.equal(f(1.5, [0, 3]), 'inconclusive'); // lo = 0 does not exclude zero
  assert.equal(f(0.3, [-0.5, 1]), 'no meaningful difference'); // upper end exactly 1
  assert.equal(f(0.3, [-0.5, 1.0000001]), 'inconclusive');
  assert.equal(f(0, [-5, 5]), 'inconclusive');
  assert.equal(f(null, null), 'inconclusive');
  assert.equal(classify(-0.2, [-0.3, -0.1], 0.05), 'supported');
  assert.equal(classify(-0.04, [-0.05, 0.05], 0.05), 'no meaningful difference');
});

test('across libraries with N = 23: supported at 12 and none contradicted, and the other rules', () => {
  const mk = (s, c, n) => [...Array(s).fill('supported'), ...Array(c).fill('contradicted'), ...Array(n).fill('no meaningful difference'), ...Array(23 - s - c - n).fill('inconclusive')];
  assert.equal(acrossLibraries(mk(12, 0, 0)), 'supported'); // 2 * 12 = 24 >= 23
  assert.equal(acrossLibraries(mk(11, 0, 0)), 'inconclusive'); // 22 < 23
  assert.equal(acrossLibraries(mk(12, 1, 0)), 'inconclusive'); // one contradicted
  assert.equal(acrossLibraries(mk(0, 12, 0)), 'contradicted');
  assert.equal(acrossLibraries(mk(1, 12, 0)), 'inconclusive');
  assert.equal(acrossLibraries(mk(0, 11, 0)), 'inconclusive');
  assert.equal(acrossLibraries(mk(0, 0, 23)), 'no meaningful difference');
  assert.equal(acrossLibraries(mk(0, 0, 22)), 'inconclusive');
  assert.equal(acrossLibraries(mk(12, 0, 11)), 'supported');
});

test('question answer: every combination of two across-library results', () => {
  const S = 'supported';
  const C = 'contradicted';
  const M = 'no meaningful difference';
  const I = 'inconclusive';
  assert.equal(questionAnswer(S, I), 'supported');
  assert.equal(questionAnswer(S, M), 'supported');
  assert.equal(questionAnswer(S, S), 'supported');
  assert.equal(questionAnswer(S, C), 'inconclusive');
  assert.equal(questionAnswer(C, I), 'contradicted');
  assert.equal(questionAnswer(M, C), 'contradicted');
  assert.equal(questionAnswer(M, M), 'no meaningful difference');
  assert.equal(questionAnswer(M, I), 'inconclusive');
  assert.equal(questionAnswer(I, I), 'inconclusive');
});

const cell = (n, estimate, lo, hi) => ({ n, estimate, intervals: { '0.95': lo === undefined ? null : [lo, hi] } });

test('absorption default: off by the fee condition, off by the failures condition, on otherwise', () => {
  const okFees = cell(40, 0, -0.1, 0.1);
  const okFail = cell(40, 0, -1, 1);
  assert.equal(absorptionDefault({ fees: cell(40, -0.05, -0.2, -0.01), failures: okFail }).value, 'off'); // median exactly -0.05, interval below zero
  assert.equal(absorptionDefault({ fees: cell(40, -0.049, -0.2, -0.01), failures: okFail }).value, 'on'); // short of -0.05
  assert.equal(absorptionDefault({ fees: cell(40, -0.2, -0.3, 0), failures: okFail }).value, 'on'); // interval reaches zero
  assert.equal(absorptionDefault({ fees: okFees, failures: cell(40, 1, 0.2, 3) }).value, 'off'); // mean exactly 1, interval above zero
  assert.equal(absorptionDefault({ fees: okFees, failures: cell(40, 0.99, 0.2, 3) }).value, 'on');
  assert.equal(absorptionDefault({ fees: okFees, failures: cell(40, 2, 0, 3) }).value, 'on'); // interval reaches zero
  assert.equal(absorptionDefault({ fees: cell(0, null), failures: cell(0, null) }).value, 'on'); // nothing enters
  const both = absorptionDefault({ fees: cell(40, -0.2, -0.3, -0.1), failures: cell(40, 2, 1, 3) });
  assert.deepEqual([both.value, both.offByFees, both.offByFailures], ['off', true, true]);
});

test('absorption default through the computation: the rule off against on, per wallet', async () => {
  // Fees: off 80000 per spend, on 100000, 5 built each: R = 400000 / 500000 - 1 = -0.2 for every wallet.
  // Failures: on 5 attempted with 1 failure (20), off none: on minus off = +20. Ten identical wallets.
  const mk = (id, off, on) => wal(id, 'B1', { [`${RULE}/off`]: off, [`${RULE}/on`]: on });
  const off = await tablesOf(Array.from({ length: 10 }, (_, i) => mk(500 + i, run(5, { fee: 80000 }), run(5))));
  let res = await runQuestions(off.wallets, { resamples: 100, libraries: ['csl-lf'] });
  near(res.absorption.fees.estimate, -0.2);
  assert.equal(absorptionDefault(res.absorption).value, 'off');
  const offFail = await tablesOf(Array.from({ length: 10 }, (_, i) => mk(600 + i, run(5), run(5, { fail: [2] }))));
  res = await runQuestions(offFail.wallets, { resamples: 100, libraries: ['csl-lf'] });
  near(res.absorption.failures.estimate, 20);
  const d = absorptionDefault(res.absorption);
  assert.deepEqual([d.value, d.offByFees, d.offByFailures], ['off', false, true]);
  const same = await tablesOf(Array.from({ length: 10 }, (_, i) => mk(700 + i, run(5), run(5))));
  res = await runQuestions(same.wallets, { resamples: 100, libraries: ['csl-lf'] });
  assert.equal(absorptionDefault(res.absorption).value, 'on');
});

test('selection default: not contradicted keeps the rule', () => {
  const figs = [{ library: 'a', failuresPer100: 0, feeRatio: 0 }];
  for (const a of ['supported', 'no meaningful difference', 'inconclusive']) assert.equal(selectionDefault(a, figs).value, 'rule');
});

test('selection default: contradicted delegates to the library with the lowest layout failures; a tie is broken by the fee ratio, then the table order', () => {
  const f = (library, failuresPer100, feeRatio) => ({ library, wallets: 10, failuresPer100, feeWallets: 10, feeRatio });
  // Lowest mean wins: 3.5 beats 4 and 5.
  assert.equal(selectionDefault('contradicted', [f('csl-lf', 5, 0), f('csl-ri', 3.5, 0.3), f('cjs-rrri', 4, -1)]).library, 'csl-ri');
  // D4's tie: csl-lf and csl-ri both 2 per 100; csl-ri's F_layout / F_rule - 1 is lower (-0.1 < 0.2): csl-ri, though csl-lf is first in the table.
  const tie = selectionDefault('contradicted', [f('csl-lf', 2, 0.2), f('csl-ri', 2, -0.1), f('cjs-rrri', 6, -5)]);
  assert.equal(tie.library, 'csl-ri');
  assert.deepEqual(tie.tied, ['csl-lf', 'csl-ri']);
  // Equal means and equal fee ratios: the table order, csl-lf.
  assert.equal(selectionDefault('contradicted', [f('csl-lf', 2, 0.1), f('csl-ri', 2, 0.1)]).library, 'csl-lf');
  // A library with no wallet is not a candidate; with no candidate the rule stays.
  assert.equal(selectionDefault('contradicted', [f('csl-lf', null, null), f('csl-ri', 9, null)]).library, 'csl-ri');
  assert.equal(selectionDefault('contradicted', [f('csl-lf', null, null)]).value, 'rule');
});

test('selection figures: a weighted mean of layout failures per 100 over wallets with enough attempted spends, and the fee ratio against the rule', async () => {
  // csl-lf layout. Wallet 101 (B1, w 2): 10 attempted, 1 fails = 10. Wallet 102 (B2, w 2): 4 attempted, does not enter.
  // Wallet 103 (B3, w 1): 10 attempted, 4 fail = 40. Mean = (2*10 + 1*40) / 3 = 20.
  // Fee ratio: layout 120000 per spend against the rule's 100000, 5 built in both: -> 600000/500000 - 1 = 0.2 for
  // wallets 101 and 103 (intents 0..4 built in both); wallet 102 has 4 built in layout: no value. Median of (0.2 w 2, 0.2 w 1) = 0.2.
  const mk = (layout) => lf(run(10), layout, run(10, { fee: 100000 }));
  const { wallets } = await tablesOf([
    wal(101, 'B1', mk(run(10, { fail: [9], fee: 120000 }))),
    wal(102, 'B2', mk(run(5, { skip: [4], fee: 120000 }))),
    wal(103, 'B3', mk(run(10, { fail: [6, 7, 8, 9], fee: 120000 })))
  ]);
  const fig = selectionFigures(wallets, ['csl-lf'])[0];
  assert.equal(fig.wallets, 2);
  near(fig.failuresPer100, 20);
  near(fig.feeRatio, 0.2);
  assert.equal(fig.feeWallets, 2);
});

test('end to end: question 2 contradicted by every library delegates the selection, and results are identical at 1, 2 and 4 workers', async () => {
  // Every wallet: the rule fails 2 of 10 attempted (20 per 100), every layout arm 0, except csl-ri and csl-lf
  // whose layout arms fail 1 of 10 (10 per 100) so the delegate is the lowest of the plain libraries, the first in the table
  // order that has 0: cjs-rrri. Fees are equal everywhere: R = 0.
  const ruleRun = run(10, { fail: [3, 4] });
  const over = { [`${RULE}/on`]: ruleRun, [`${RULE}/off`]: ruleRun, 'csl-lf/layout': run(10, { fail: [3] }), 'csl-ri/layout': run(10, { fail: [3] }) };
  for (const m of METHODS) if (!(`${m}/layout` in over)) over[`${m}/layout`] = run(10);
  for (const m of METHODS) over[`${m}/own`] = run(10);
  const wallets = Array.from({ length: 10 }, (_, i) => wal(800 + i, i < 6 ? 'B1' : 'B2', over));
  const { wallets: tables } = await tablesOf(wallets);
  const base = await runQuestions(tables, { resamples: 500, workers: 1 });
  for (const w of [2, 4]) assert.deepEqual(await runQuestions(tables, { resamples: 500, workers: w }), base);
  assert.deepEqual(await runQuestions(tables.slice().reverse(), { resamples: 500, workers: 1 }), base);
  const v = buildVerdicts(base);
  // Question 2 failures: y = 20 - 0 = +20 for 21 libraries and 20 - 10 = +10 for csl-lf and csl-ri; all contradicted (e >= 1, interval above 0).
  assert.equal(v.outcomes['q2.failures'].across.result, 'contradicted');
  assert.equal(v.outcomes['q2.fees'].across.result, 'no meaningful difference');
  assert.equal(v.questions.q2.answer, 'contradicted');
  // Question 1: layout against own: y = 0 - 0 = 0 everywhere except csl-lf and csl-ri (+10): not supported, so question 1 is not supported.
  assert.notEqual(v.questions.q1.answer, 'supported');
  assert.equal(v.defaults.inputSelection.value, 'library');
  assert.equal(v.defaults.inputSelection.library, 'cjs-rrri');
  assert.equal(v.defaults.absorption.value, 'on');
  assert.deepEqual(buildVerdicts(await runQuestions(tables, { resamples: 500, workers: 4 })), v);
  const md = renderVerdicts(v);
  assert.match(md, /Question 2 is contradicted/);
  assert.match(md, /delegates to cjs-rrri/);
  assert.match(md, /The absorption default is on/);
  assert.equal(md, renderVerdicts(v));
  assert.deepEqual(studyLibraries(tables), METHODS);
});
