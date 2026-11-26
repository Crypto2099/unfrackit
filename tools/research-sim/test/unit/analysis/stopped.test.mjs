// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A replay job stopped at the time limit (pre-registration decisions, "Run
// logistics after the cost probes"): the analysis reads a stage that holds one
// without refusing it, leaves the job's (wallet, library) pair out of every
// comparison, keeps the wallet's other libraries and the rule's arms, and lists
// the stopped jobs beside the comparisons. Studies come from
// test/lib/analysis-fixtures.mjs; a stopped job is written as the replay writes
// it (spend records, then a wallet-arm record with `stopped` and no summary).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdAnalyze } from '../../../src/analysis/command.mjs';
import { AnalysisRefusal, readStudy, RULE_METHOD } from '../../../src/analysis/read.mjs';
import { writeStudy, optionsFor, fullJobs, built, failed, TX, RULE, METHODS, RANDOM_METHODS } from '../../lib/analysis-fixtures.mjs';

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'analysis-stopped-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const refusal = (re) => (e) => e instanceof AnalysisRefusal && re.test(e.message);

const SMALL = { resamples: 40, sizingSamples: 3, sizingResamples: 10, quiet: true };
const [LIB, OTHER] = METHODS.filter((m) => !RANDOM_METHODS.includes(m));
const [RANDOM] = RANDOM_METHODS;

// Eight intents per arm: L/own fails the last, each arm a different fee.
const make = (i) => (m, arm, rep) => {
  const base = 200000 + 1000 * (i % 7);
  const fee = arm === 'own' ? base : arm === 'layout' ? base - 20000 : arm === 'on' ? base - 40000 : base - 30000;
  const out = [];
  for (let k = 0; k < 8; k++) out.push(k === 7 && arm === 'own' ? failed(k, 'change-minimum', 'kit: change-minimum: low') : built(k, { fee: fee + rep + k, ms: 5 + k, type: k % 2 ? 'T1' : 'T2' }));
  return out;
};

// Jobs of wallet i with the jobs `stop` names (method, arm and repetition) stopped after `kept` spends.
function jobsOf(i, stop = [], kept = 3, over = {}) {
  return fullJobs(make(i), { reps: 2 }).map((j) => {
    const hit = stop.some((s) => s.method === j.method && (s.arm === undefined || s.arm === j.arm) && (s.rep === undefined || s.rep === (j.rep || 1)));
    return hit ? { ...j, spends: j.spends.slice(0, kept), stopped: { spends: kept, planned: 8, ...over } } : j;
  });
}

// Six pilot wallets in group B1; `stops` maps a wallet position to the jobs stopped in it.
const CENSUS = [1, 2, 3, 4, 5, 6].map((i) => ({ wallet: 9000 + i, utxos: i, tokenUtxos: i % 3, largestValueBytes: 100 * i, nearCap50: false, nearCap80: false, nearCap90: false, lockedAda: String(i * 1000000), excessAda: String(i * 10), coin: String(i * 5000000) }));
const MACHINES = [{ label: 'rig-a', invocations: [{ start: '2026-11-01T00:00:00Z', end: '2026-11-01T01:00:00Z', workers: 4, cpuModel: 'Test CPU', logicalCores: 8, totalMemoryBytes: 1000, completed: [0, 1, 2] }], log: [] }];
// Both windows are written, as a real study has them; `stops` apply to the recent window and `peakStops` to the peak.
function study(stops = {}, over = {}, peakStops = {}) {
  const root = tmp();
  let w;
  for (const window of ['recent', 'peak']) {
    const st = window === 'recent' ? stops : peakStops;
    const wallets = Array.from({ length: 6 }, (_, i) => ({ id: 7100 + i, group: 'B1', intents: Array.from({ length: 8 }, () => ({})), jobs: jobsOf(i, st[i] || [], 3, over) }));
    const x = writeStudy(root, { window, wallets, analysisFreezeTx: TX, census: window === 'recent' ? CENSUS : undefined, carried: window === 'recent' ? true : undefined, machines: MACHINES });
    if (window === 'recent') w = x;
  }
  return { root, w, opts: { ...optionsFor(root, w), analysisFreezeTx: TX } };
}
const run = async (stops, over, peakStops) => {
  const s = study(stops, over, peakStops);
  const out = join(tmp(), 'out');
  await cmdAnalyze({ ...s.opts, ...SMALL, out });
  return { ...s, out };
};
const cell = (res, name) => res.recent.questions.cells.find((c) => c.name === name);

test('a stage with a stopped job is read without refusal: the pair leaves the wallet table and the stopped jobs are listed with their partial results', async () => {
  const s = study({ 2: [{ method: LIB, arm: 'own' }] });
  const { wallets } = await readStudy(s.opts);
  assert.equal(wallets.length, 6);
  const t = wallets[2];
  // Both of the library's arms are out, every other library and the rule are in.
  assert.ok(!t.arms.has(`${LIB}/own`) && !t.arms.has(`${LIB}/layout`));
  assert.ok(t.arms.has(`${OTHER}/own`) && t.arms.has(`${OTHER}/layout`) && t.arms.has(`${RULE}/on`) && t.arms.has(`${RULE}/off`));
  assert.equal(wallets[1].arms.size, t.arms.size + 2);
  assert.deepEqual(wallets[1].stopped, []);
  assert.equal(t.stopped.length, 1);
  // The entry has the window, the wallet's index, the job, the machine and what the record says.
  assert.deepEqual({ ...t.stopped[0], partial: null }, { window: 'recent', walletIndex: 2, library: LIB, arm: 'own', repetition: 1, machine: 'rig-a', spends: 3, planned: 8, last: { intent: 2, t: 3000 }, elapsedMs: 86400123, limitMs: 86400000, attempt: 1, at: 'spend boundary', partial: null });
  // Three built spends of fees 200000 + 1000 * 2 + (1 + k) for k = 0..2 under L/own: the partial results come from them alone.
  const p = t.stopped[0].partial;
  assert.deepEqual(p.counts, { attempted: 3, built: 3, failed: 0, infeasible: 0, infeasibleCollateral: 0, notReplayable: 0, forfeit: 0, chains: 0 });
  assert.equal(p.failuresPer100, 0);
  assert.equal(p.fee, 3n * 202000n + 1n + 2n + 3n);
  assert.equal(p.walletFee, p.fee);
});

test('a stopped job at each `at` value is read, and its entry keeps the value; a job with no kept spend has last null', async () => {
  for (const at of ['spend boundary', 'running build', 'killed between spends']) {
    const s = study({ 0: [{ method: OTHER, arm: 'layout' }] }, { at });
    const { wallets } = await readStudy(s.opts);
    assert.equal(wallets[0].stopped[0].at, at);
    assert.ok(!wallets[0].arms.has(`${OTHER}/own`));
  }
  const root = tmp();
  const jobs = fullJobs(make(0), { reps: 1 }).map((j) => (j.method === LIB && j.arm === 'layout' ? { ...j, spends: [], stopped: { spends: 0, planned: 8 } } : j));
  const w = writeStudy(root, { wallets: [{ id: 1, group: 'B1', intents: Array.from({ length: 8 }, () => ({})), jobs }], analysisFreezeTx: TX });
  const { wallets } = await readStudy({ ...optionsFor(root, w), analysisFreezeTx: TX });
  assert.equal(wallets[0].stopped[0].last, null);
  assert.equal(wallets[0].stopped[0].partial.failuresPer100, null);
});

test('analyze leaves the stopped pair out of the library\'s comparisons, keeps the other libraries and the rule, and reports the pair beside them', async () => {
  const ref = await run({});
  const hit = await run({ 2: [{ method: LIB, arm: 'own' }] });
  const a = JSON.parse(readFileSync(join(ref.out, 'results.json'), 'utf8'));
  const b = JSON.parse(readFileSync(join(hit.out, 'results.json'), 'utf8'));
  assert.deepEqual(a.stopped, []);
  assert.equal(a.stoppedByLibrary, undefined);
  for (const q of ['q1/failures', 'q1/fees']) {
    const name = `${q}/${LIB}/layout-vs-own`;
    assert.equal(cell(a, name).n, 6, name);
    assert.equal(cell(b, name).n, 5, name);
  }
  // Question 2's cells of the library lose the pair too, since the pair is out of every comparison of the library.
  assert.equal(cell(a, `q2/fees/${LIB}/on-vs-layout`).n, 6);
  assert.equal(cell(b, `q2/fees/${LIB}/on-vs-layout`).n, 5);
  // Another library's cells and the absorption contrast, which no library enters, are as they were.
  for (const name of [`q1/failures/${OTHER}/layout-vs-own`, `q2/fees/${OTHER}/on-vs-layout`, 'absorption/fees/off-vs-on']) {
    const x = cell(a, name) || a.recent.questions.absorption.fees;
    const y = cell(b, name) || b.recent.questions.absorption.fees;
    assert.deepEqual(y, x, name);
  }
  // The listing: one job of one pair, with the count per library, and no address or hash.
  assert.equal(b.stopped.length, 1);
  assert.deepEqual({ ...b.stopped[0], partial: null }, { window: 'recent', walletIndex: 2, library: LIB, arm: 'own', repetition: 1, machine: 'rig-a', spends: 3, planned: 8, last: { intent: 2, t: 3000 }, elapsedMs: 86400123, limitMs: 86400000, attempt: 1, at: 'spend boundary', partial: null });
  assert.equal(b.stopped[0].partial.fee, '606006');
  assert.deepEqual(b.stoppedByLibrary, { recent: { [LIB]: 1 } });
  const md = readFileSync(join(hit.out, 'verdicts.md'), 'utf8');
  assert.match(md, /\n# Stopped pairs\n\n/);
  assert.match(md, new RegExp(`- recent, wallet 2, ${LIB}/own repetition 1: 3 of 8 spends kept \\(last: intent 2 at time 3000\\), stopped at spend boundary, attempt 1, 86400123 ms of 86400000 ms, machine rig-a; 3 built, 0 failed, 0 failures per 100 attempted\\n`));
  assert.match(md, new RegExp(`- recent, ${LIB}: 1\\n`));
  assert.match(readFileSync(join(ref.out, 'verdicts.md'), 'utf8'), /\n# Stopped pairs\n\nNo replay job was stopped for excessive time/);
  for (const f of readdirSync(hit.out)) assert.ok(!readFileSync(join(hit.out, f), 'utf8').includes('71002'), f);
});

test('one stopped seed of a random library takes the library\'s whole pair out, and a stopped rule arm takes the rule out of that wallet', async () => {
  const hit = await run({ 1: [{ method: RANDOM, arm: 'layout', rep: 2 }], 4: [{ method: RULE_METHOD, arm: 'off' }] });
  const ref = await run({});
  const a = JSON.parse(readFileSync(join(ref.out, 'results.json'), 'utf8'));
  const b = JSON.parse(readFileSync(join(hit.out, 'results.json'), 'utf8'));
  assert.equal(cell(a, `q1/failures/${RANDOM}/layout-vs-own`).n, 6);
  assert.equal(cell(b, `q1/failures/${RANDOM}/layout-vs-own`).n, 5);
  // Wallet 4 has no rule arm: every library's question 2 and the absorption contrast lose it, question 1 does not.
  assert.equal(cell(b, `q2/fees/${LIB}/on-vs-layout`).n, 5);
  assert.equal(cell(b, `q1/fees/${LIB}/layout-vs-own`).n, 6);
  assert.equal(b.recent.questions.absorption.fees.n, 5);
  assert.deepEqual(b.stoppedByLibrary, { recent: { [RANDOM]: 1, [RULE]: 1 } });
  assert.deepEqual(b.stopped.map((e) => [e.walletIndex, e.library, e.arm, e.repetition]), [[1, RANDOM, 'layout', 2], [4, RULE, 'off', 1]]);
});

test('a stopped job of the peak window is listed under that window and leaves only the peak comparisons', async () => {
  const hit = await run({}, {}, { 5: [{ method: OTHER, arm: 'own' }] });
  const b = JSON.parse(readFileSync(join(hit.out, 'results.json'), 'utf8'));
  assert.deepEqual(b.stopped.map((e) => [e.window, e.walletIndex, e.library]), [['peak', 5, OTHER]]);
  assert.deepEqual(b.stoppedByLibrary, { peak: { [OTHER]: 1 } });
  assert.equal(cell(b, `q1/failures/${OTHER}/layout-vs-own`).n, 6);
  assert.equal(b.peak.questions.cells.find((c) => c.name === `q1/failures/${OTHER}/layout-vs-own/peak`).n, 5);
  assert.match(readFileSync(join(hit.out, 'verdicts.md'), 'utf8'), new RegExp(`- peak, ${OTHER}: 1\\n`));
});

test('both arms of a pair stopped count the pair once and list both jobs', async () => {
  const hit = await run({ 3: [{ method: LIB }] });
  const b = JSON.parse(readFileSync(join(hit.out, 'results.json'), 'utf8'));
  assert.deepEqual(b.stopped.map((e) => e.arm), ['own', 'layout']);
  assert.deepEqual(b.stoppedByLibrary, { recent: { [LIB]: 1 } });
});

test('the build times of a stopped job count under its machine like any other', async () => {
  const hit = await run({ 0: [{ method: LIB, arm: 'own' }] });
  const ref = await run({});
  const t = (r) => JSON.parse(readFileSync(join(r.out, 'timings.json'), 'utf8'));
  // Wallet 0's L/own job keeps 3 of its 7 built spends (the eighth fails and has no time), so 4 rows go, all of them rig-a's wallet 0.
  assert.equal(t(hit).windows.recent.rows, t(ref).windows.recent.rows - 4);
  assert.equal(t(hit).windows.recent.byMachine['rig-a'].rows, t(ref).windows.recent.byMachine['rig-a'].rows - 4);
});

test('a stopped record with another reason, or one whose spends differ from the spend records, is refused', async () => {
  await assert.rejects(readStudy(study({ 0: [{ method: LIB, arm: 'own' }] }, { reason: 'other' }).opts), refusal(/reason is "other"/));
  await assert.rejects(readStudy(study({ 0: [{ method: LIB, arm: 'own' }] }, { spends: 2 }).opts), refusal(/names 2 kept spends beside 3 spend records/));
});
