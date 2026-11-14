// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The sizing by simulation (sizing.mjs) on synthetic per-wallet outcomes with
// known answers; samples, resamples and the bisection are kept small.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStudy } from '../../../src/analysis/read.mjs';
import { bootstrap } from '../../../src/analysis/stats.mjs';
import { runQuestions } from '../../../src/analysis/questions.mjs';
import { resampleWallets, groupCounts, powerAt, detectableDelta, sampleUpperEnds, runSizing, renderSizing } from '../../../src/analysis/sizing.mjs';
import { writeStudy, optionsFor, fullJobs, built, failed, TX } from '../../lib/analysis-fixtures.mjs';

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);
const W = (id, group, v, weight = 1) => ({ id, group, weight, v: [v] });

test('the resample keeps the confirmation group counts and each wallet its weight and value', () => {
  const source = [W('a', 'B1', 1, 2), W('b', 'B1', 2, 2), W('c', 'B1', 3, 2), W('d', 'B2', 10, 5)];
  const r = resampleWallets(source, { B1: 5, B2: 3, B3: 0 }, 'sizing/x/draw', 7);
  assert.deepEqual(groupCounts(r), { B1: 5, B2: 3 });
  for (const w of r) {
    const src = source.find((s) => s.group === w.group && s.v[0] === w.v[0]);
    assert.ok(src, 'every drawn wallet is a source wallet');
    assert.equal(w.weight, src.weight);
  }
  assert.equal(new Set(r.map((w) => w.id)).size, 8);
  assert.deepEqual(resampleWallets(source, { B1: 5, B2: 3 }, 'sizing/x/draw', 7), r, 'same name and sample, same draw');
  assert.notDeepEqual(resampleWallets(source, { B1: 5, B2: 3 }, 'sizing/x/draw', 8), r, 'another sample draws again');
  assert.equal(resampleWallets(source, { B1: 5, B3: 1 }, 'sizing/x/draw', 7), null, 'a group without source wallets cannot be drawn');
});

test('no spread: five wallets of 0.3 are detected at delta above 0.3, found at 0.3125 with a 0.05 resolution', async () => {
  // Every resample is five 0.3s, so the interval is the point 0.3 and a shift
  // by delta is detected when 0.3 - delta < 0. With sesoi 1 the search starts at
  // 1 (detected), then bisects [0, 1]: 0.5 yes, 0.25 no, 0.375 yes, 0.3125 yes,
  // 0.28125 no; the bracket [0.28125, 0.3125] is 0.03125 <= 0.05 wide.
  const source = Array.from({ length: 5 }, (_, i) => W(`w${i}`, 'B1', 0.3));
  const uppers = await sampleUpperEnds({ name: 'sizing/t/none', statistic: 'mean', source, counts: { B1: 5 } }, { samples: 8, resamples: 20 });
  assert.equal(uppers.length, 8);
  for (const u of uppers) near(u, 0.3);
  const d = detectableDelta(uppers, { sesoi: 1 });
  assert.equal(d.delta, 0.3125);
  assert.equal(d.reached, true);
  assert.equal(d.atZero, false);
  assert.equal(d.power, 1);
  assert.equal(d.steps, 5);
  assert.equal(d.resolution, 0.05);
  assert.equal(powerAt(uppers, 0.3), 0, 'exactly at the effect is not detected: the interval must exclude zero');
  assert.equal(powerAt(uppers, 0.3 + 1e-6), 1);
});

test('the bisection stops when the bracket is within 0.05 of the smallest effect and reports its upper end', () => {
  // Upper ends 1 to 5: delta must exceed 4 for 4 of 5 samples. The search doubles
  // 1, 2, 4 (3 of 5, short), 8 (yes), then bisects [4, 8]: 6, 5, 4.5, 4.25,
  // 4.125, 4.0625 (bracket 0.0625 > 0.05), 4.03125 (bracket 0.03125, stop).
  const d = detectableDelta([1, 2, 3, 4, 5], { sesoi: 1 });
  assert.equal(d.delta, 4.03125);
  assert.equal(d.steps, 3 + 7);
  assert.ok(4.03125 - 4 <= 0.05);
  // A sesoi of 0.5 scales the tolerance to 0.025: the bracket must reach 0.0234375 < 0.025 above 4.
  const f = detectableDelta([1, 2, 3, 4, 5], { sesoi: 0.5 });
  assert.ok(f.delta > 4 && f.delta - 4 <= 0.025 + 1e-12);
  assert.equal(f.resolution, 0.025);
});

test('80% is read inclusively: 4 of 5 samples reach it, 3 of 5 do not', () => {
  assert.equal(powerAt([1, 1, 1, 1, 9], 2), 0.8);
  const yes = detectableDelta([1, 1, 1, 1, 9], { sesoi: 1 });
  assert.equal(yes.reached, true);
  assert.equal(yes.delta, 1.03125);
  assert.equal(yes.power, 0.8);
  const no = detectableDelta([1, 1, 1, Infinity, Infinity], { sesoi: 1 });
  assert.equal(no.reached, false);
  assert.equal(no.delta, null);
  assert.equal(detectableDelta([-1, -1, -1, -1, -1], { sesoi: 1 }).delta, 0, 'an effect already detected at zero reports zero');
  assert.equal(detectableDelta([-1, -1, -1, -1, -1], { sesoi: 1 }).atZero, true);
  assert.equal(detectableDelta([Infinity, Infinity], { sesoi: 1 }).reached, false, 'no interval never detects');
});

test('shifting then bootstrapping decides each sample as the stored upper ends do', async () => {
  const source = [W('a', 'B1', 4), W('b', 'B1', -2), W('c', 'B1', 1), W('d', 'B1', 0.5), W('e', 'B2', 3, 3), W('f', 'B2', -1, 3)];
  const counts = { B1: 5, B2: 3 };
  const name = 'sizing/t/spread';
  const uppers = await sampleUpperEnds({ name, statistic: 'median', source, counts }, { samples: 6, resamples: 40 });
  for (const delta of [0.5, 2, 3.5, 6]) {
    for (let s = 0; s < 6; s++) {
      const shifted = resampleWallets(source, counts, `${name}/draw`, s).map((w) => ({ ...w, v: [w.v[0] - delta] }));
      const [o] = await bootstrap([{ name: `${name}/s${String(s).padStart(6, '0')}`, statistic: 'median', wallets: shifted }], { resamples: 40, levels: [0.9875] });
      assert.equal(o.intervals['0.9875'][1] < 0, uppers[s] - delta < 0, `delta ${delta}, sample ${s}`);
    }
  }
});

// Four fixture wallets of csl-lf with a failures difference and a fee ratio
// that are the same for every wallet: layout fails 0 of 6 against own failing
// 1 of 6 (failures -100/6; five intents are built in both arms), layout pays 130000 where own pays 100000 (ratio 0.3).
const run = (n, { fail = [], fee = 100000 } = {}) => Array.from({ length: n }, (_, i) => (fail.includes(i) ? failed(i, 'change-minimum') : built(i, { fee, walletFee: fee })));
const wallet = (id, group, split) => ({ id, group, split, jobs: fullJobs((m, arm) => (m === 'csl-lf' && arm === 'own' ? run(6, { fail: [0] }) : m === 'csl-lf' && arm === 'layout' ? run(6, { fee: 130000 }) : run(5)), { reps: 2 }) });

async function splits(explo, confi) {
  const root = mkdtempSync(join(tmpdir(), 'analysis-sz-'));
  dirs.push(root);
  const w = writeStudy(root, { analysisFreezeTx: TX, wallets: [...explo.map((x) => wallet(x[0], x[1], 'exploration')), ...confi.map((x) => wallet(x[0], x[1], 'confirmation'))] });
  const a = await readStudy(optionsFor(root, w, { split: 'exploration', analysisFreezeTx: TX }));
  const b = await readStudy(optionsFor(root, w, { split: 'confirmation', analysisFreezeTx: TX }));
  return [a.wallets, b.wallets];
}

test('sizing.json on a fixture: confirmation group counts, known deltas, and the same bytes at 1 and 2 workers', async () => {
  const [ex, co] = await splits([[1, 'B1'], [2, 'B1'], [3, 'B1'], [4, 'B2']], [[11, 'B1'], [12, 'B1'], [13, 'B1'], [14, 'B1'], [15, 'B2'], [16, 'B2']]);
  const opts = { samples: 6, resamples: 40, libraries: ['csl-lf'] };
  const one = await runSizing(ex, co, { ...opts, workers: 1 });
  const two = await runSizing(ex, co, { ...opts, workers: 2 });
  assert.equal(renderSizing(one), renderSizing(two));
  assert.equal(one.cells.length, 4);
  const cell = (q, o) => one.cells.find((c) => c.question === q && c.outcome === o);
  const f = cell('q1', 'failures');
  assert.equal(f.name, 'sizing/q1/failures/csl-lf/layout-vs-own');
  assert.deepEqual(f.confirmation.groups, { B1: 4, B2: 2 });
  assert.deepEqual(f.exploration.groups, { B1: 3, B2: 1 });
  // Every wallet is -16.7 failures per 100: the interval sits there, below zero.
  assert.equal(f.delta, 0);
  assert.equal(f.atZero, true);
  // Every wallet's fee ratio is 0.3 with sesoi 0.05: doubling 0.05, 0.1, 0.2 (no), 0.4 (yes), then the bisection of [0.2, 0.4] to a bracket of at most 0.0025.
  const r = cell('q1', 'fees');
  assert.equal(r.sesoi, 0.05);
  assert.equal(r.reached, true);
  assert.ok(r.delta > 0.3 && r.delta - 0.3 <= 0.0025 + 1e-9, `${r.delta}`);
  near(r.deltaOverSesoi, r.delta / 0.05);
  // No stream name of the questions is reused.
  const qNames = new Set((await runQuestions(ex, { resamples: 20, libraries: ['csl-lf'] })).cells.map((c) => c.name));
  for (const c of one.cells) {
    assert.ok(c.name.startsWith('sizing/'));
    assert.ok(!qNames.has(c.name));
  }
  assert.deepEqual(JSON.parse(renderSizing(one)).libraries, ['csl-lf']);
});

test('a confirmation group with no exploration wallet, and a cell with no wallets, give a null delta and a reason', async () => {
  const [ex, co] = await splits([[1, 'B1'], [2, 'B1']], [[11, 'B1'], [12, 'B2']]);
  const res = await runSizing(ex, co, { samples: 4, resamples: 20, libraries: ['csl-lf'] });
  const f = res.cells.find((c) => c.question === 'q1' && c.outcome === 'failures');
  assert.equal(f.delta, null);
  assert.equal(f.reason, 'a confirmation group has no exploration wallet to draw from');
  const none = await runSizing(ex, [], { samples: 4, resamples: 20, libraries: ['csl-lf'] });
  assert.equal(none.cells[0].reason, 'no confirmation wallet enters the cell');
  const empty = await runSizing([], co, { samples: 4, resamples: 20, libraries: ['csl-lf'] });
  assert.equal(empty.cells[0].reason, 'no exploration wallet enters the cell');
});
