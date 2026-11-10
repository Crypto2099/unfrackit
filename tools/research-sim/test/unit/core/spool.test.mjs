// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The replay records' spool (src/out/spool.mjs): a job's records written by
// its worker and committed by the run in job order through the wallet's
// segment are the bytes RunOutput.write writes for the same records, whatever
// order the jobs end in; the frontier commits in job order; the commit
// refuses a spool that does not match its job; a worker's answer for a job
// (spoolJob) commits to the records and times the run wrote from the job's
// whole result before, and H-6's fields give the same rescue outcomes as the
// whole results. With the treatment, runReplays through two workers writes
// the records of an in-thread replay of every job written in job order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record, prepare, timingLine, RunOutput } from '../../../src/out/records.mjs';
import { spoolPaths, spoolRecords, Frontier } from '../../../src/out/spool.mjs';
import { rescueOutcomes, rescueFields, spoolJob, runReplays } from '../../../src/replay/run.mjs';
import { treatment, skip, TREATMENT_DIR } from '../../lib/treatment.mjs';

const DAY = 86400;
const key = (over = {}) => ({ wallet: 'S1', window: 'synthetic', arm: 'observed', variant: 'default', method: 'test-largest-first', change: 'default', collateral: 'none-needed', repetition: 1, ...over });

function withHome(fn) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'research-sim-spool-'));
    const prev = process.env.RESEARCH_SIM_HOME;
    process.env.RESEARCH_SIM_HOME = home;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.RESEARCH_SIM_HOME;
      else process.env.RESEARCH_SIM_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

const files = (out) => ({ records: readFileSync(join(out.dir, 'records.jsonl'), 'utf8'), timings: readFileSync(join(out.dir, 'timings.jsonl'), 'utf8') });

// Three jobs' records: times at the top, nested and in arrays, BigInt,
// free text to scrub, and a last record whose time the run sets.
const JOBS = [
  [record('plan', key(), { at: 'start', fee: 170000n, notes: ['pure-ada-only'] }), record('spend', key(), { intent: 0, outcome: 'built', fee: 180000n, ms: 1.25 }), record('wallet-arm', key(), { counts: { built: 1 }, inner: { ms: 7.5 }, ms: 0 })],
  [record('refused', key({ arm: 'tidy-once' }), { reason: `no change address near ${'ab'.repeat(32)}` })],
  [record('spend', key({ arm: 'maintained-tidy' }), { intent: 0, outcome: 'failed', detail: 'x', ms: 3 }), record('burst', key({ arm: 'maintained-tidy' }), { id: 'b1', feasible: true, passes: [{ ms: 2 }, { ms: 4 }] }), record('wallet-arm', key({ arm: 'maintained-tidy' }), { counts: {}, ms: 0 })]
];
const ATTEMPT_MS = [11.5, null, 22.25];
const isArm = (rec) => rec.kind === 'wallet-arm';

test('prepare gives the line and times write() writes', withHome(async () => {
  const out = new RunOutput('synthetic', 'prepare', { command: 'test' });
  const rec = JOBS[2][1];
  out.write(rec);
  out.close();
  const { line, times } = prepare(rec);
  const f = files(out);
  assert.equal(f.records, `${line}\n`);
  assert.deepEqual(times, { 'passes[0].ms': 2, 'passes[1].ms': 4 });
  assert.equal(f.timings, `${timingLine(1, rec, times)}\n`);
}));

test('spooled jobs committed in job order through a segment write the bytes write() writes, whatever order they end in', withHome(async () => {
  const before = record('battery', key({ window: 'snapshot' }), { spend: 'ada-payment', ms: 5 });
  const trigger = record('trigger', key({ arm: 'maintained-tidy' }), { at: 'mark 1', t: 30 * DAY, fee: 1000n, rescue: null });
  const after = record('battery', key({ window: 'snapshot', repetition: 2 }), { spend: 'ada-payment', ms: 6 });
  // Written one at a time, each wallet-arm with its attempt's time.
  const a = new RunOutput('synthetic', 'direct', { command: 'test' });
  a.write(before);
  JOBS.forEach((recs, j) => recs.forEach((rec) => a.write(isArm(rec) ? { ...rec, ms: ATTEMPT_MS[j] } : rec)));
  a.write(trigger);
  a.write(after);
  a.close();
  for (const order of [[2, 0, 1], [1, 2, 0], [0, 1, 2]]) {
    const b = new RunOutput('synthetic', `spooled-${order.join('')}`, { command: 'test' });
    b.write(before);
    const dir = join(b.dir, 'spool', '0');
    const seg = b.segment(dir);
    const committed = [];
    const frontier = new Frontier(JOBS.length, (j, s) => {
      committed.push(j);
      seg.commit(s);
    });
    for (const j of order) {
      const s = spoolRecords(spoolPaths(dir, j), JOBS[j], { hold: isArm });
      if (s.held) s.held.times.ms = ATTEMPT_MS[j];
      frontier.done(j, s);
    }
    assert.deepEqual(committed, [0, 1, 2]);
    assert.ok(frontier.complete);
    seg.write(trigger);
    b.adopt(seg);
    assert.deepEqual(readdirSync(dir), [], 'the spool and segment files are removed');
    b.write(after);
    b.close();
    assert.deepEqual(files(b), files(a), `jobs ending in order ${order}`);
    assert.equal(b.n, a.n);
    assert.equal(JSON.stringify(b.counts), JSON.stringify(a.counts));
  }
}));

test('a spool larger than the read buffer, with characters of several bytes across its chunk boundaries, commits to the same bytes', withHome(async () => {
  // About 3 MiB of records per job; each detail text puts a two-, three- or
  // four-byte character at a different offset.
  const big = (j) => Array.from({ length: 9000 }, (_, i) => record('spend', key({ repetition: j + 1 }), { intent: i, outcome: 'failed', detail: `${'x'.repeat(i % 331)}${['é', '€', '𝄞'][i % 3]} ${'y'.repeat(200)}`, ms: i / 8 }));
  const jobs = [big(0), big(1)];
  const a = new RunOutput('synthetic', 'big-direct', { command: 'test' });
  for (const recs of jobs) for (const rec of recs) a.write(rec);
  a.close();
  const b = new RunOutput('synthetic', 'big-spooled', { command: 'test' });
  const dir = join(b.dir, 'spool', '0');
  const seg = b.segment(dir);
  const spooled = jobs.map((recs, j) => spoolRecords(spoolPaths(dir, j), recs));
  assert.ok(readFileSync(spooled[0].records).length > 2 * (1 << 20));
  spooled.forEach((s) => seg.commit(s));
  b.adopt(seg);
  b.close();
  assert.deepEqual(files(b), files(a));
}));

test('the frontier commits in job order, keeps a job until every earlier one is done, and stops', () => {
  const seen = [];
  const f = new Frontier(4, (j, v) => seen.push([j, v]));
  assert.equal(f.done(2, 'c'), true);
  assert.equal(f.done(1, 'b'), true);
  assert.deepEqual(seen, []);
  f.done(0, 'a');
  assert.deepEqual(seen, [[0, 'a'], [1, 'b'], [2, 'c']]);
  assert.equal(f.complete, false);
  assert.throws(() => f.done(1, 'again'), /job 1 is not one still to commit/);
  assert.throws(() => f.done(4, 'past'), /job 4/);
  f.done(3, 'd');
  assert.ok(f.complete);
  const g = new Frontier(3, (j) => seen.push(j));
  g.done(1, 'kept');
  g.stop();
  assert.equal(g.done(0, 'late'), false);
  assert.equal(seen.length, 4, 'a stopped frontier commits nothing');
});

test('a commit refuses a spool that is not its job\'s, and a segment adopted out of turn is refused', withHome(async () => {
  const out = new RunOutput('synthetic', 'refusals', { command: 'test' });
  const dir = join(out.dir, 'spool', '0');
  const seg = out.segment(dir);
  const s = spoolRecords(spoolPaths(dir, 0), JOBS[0], { hold: isArm });
  assert.throws(() => seg.commit({ ...s, count: 2 }), /holds 3 records, not the 2/);
  const t = spoolRecords(spoolPaths(dir, 1), JOBS[2], { hold: isArm });
  writeFileSync(t.timings, '{"n":9,"kind":"spend","times":{"ms":1}}\n');
  assert.throws(() => seg.commit(t), /not a timing row of its job/);
  const u = spoolRecords(spoolPaths(dir, 2), JOBS[2], { hold: isArm });
  writeFileSync(u.timings, '{"n":1,"kind":"spend"');
  assert.throws(() => seg.commit(u), /ends inside a line/);
  assert.throws(() => spoolRecords(spoolPaths(dir, 3), JOBS[0], { hold: (rec) => rec.kind === 'spend' }), /only the last record of a job/);
  out.write(JOBS[1][0]);
  assert.throws(() => out.adopt(seg), /a segment opened after record 0 cannot follow record 1/);
  seg.close();
  out.close();
}));

// An engine result as the worker has it, for a maintained-tidy job: spends
// with and without collateral availability, a burst, a trigger.
function engineResult(variant) {
  const never = variant === 'never-propose';
  return {
    plans: [{ at: 'start', t: 0, txs: 1, fee: 170000n, notes: [], control: null, trigger: false }],
    spends: [
      { intent: 0, type: 'T1', t: 10 * DAY, burst: null, outcome: 'built', fee: 170000n, ms: 2.5 },
      { intent: 1, type: 'T4', t: 40 * DAY, burst: null, collateralAvailable: { ledger: true, practice: !never }, outcome: 'built', fee: 400000n, ms: 9 },
      { intent: 2, type: 'T4', t: 45 * DAY, burst: null, collateralAvailable: { ledger: !never, practice: false }, outcome: 'infeasible', reason: 'coin' }
    ],
    bursts: [{ id: 'b1', t: 50 * DAY, feasible: !never, txs: 2 }],
    triggers: never ? [] : [{ at: 'mark 1', t: 30 * DAY, reasons: ['pure-ada-count'], txs: 1, fee: 1000n }],
    summary: { counts: { intents: 3 }, fees: { spends: 570000n }, validity: { checked: 2, failed: 0, failures: [] }, ms: 123.5 },
    method: { name: 'test-largest-first', version: 'test-1', deterministic: true }
  };
}

test('a worker\'s answer commits to the records the run wrote from the whole result, and H-6\'s fields give the same rescue outcomes', withHome(async () => {
  const jobs = [
    { arm: 'maintained-tidy', variant: 'default', x: engineResult('default'), ms: 40.5 },
    { arm: 'maintained-tidy', variant: 'never-propose', x: engineResult('never-propose'), ms: 41 },
    { arm: 'observed', variant: 'default', x: engineResult('default'), ms: 12 },
    { arm: 'tidy-once', variant: 'default', x: { refused: 'the planner refuses the start plan: no', plans: [], spends: [], bursts: [], triggers: [], summary: null }, ms: 3 }
  ].map((j) => ({ ...j, key: key({ arm: j.arm, variant: j.variant }), hypotheses: ['H-6'] }));
  // The run before: every record built in the parent from the whole result.
  const a = new RunOutput('synthetic', 'whole', { command: 'test' });
  for (const j of jobs) {
    const { x } = j;
    if (x.refused) {
      a.write(record('refused', j.key, { reason: x.refused }));
      continue;
    }
    for (const p of x.plans) a.write(record('plan', j.key, p));
    for (const s of x.spends) a.write(record('spend', j.key, s));
    for (const b of x.bursts) a.write(record('burst', j.key, b));
    a.write(record('wallet-arm', j.key, { hypotheses: j.hypotheses, methodVersion: x.method.version, ...x.summary, ms: j.ms }));
  }
  a.close();
  // Through the workers' answers.
  const b = new RunOutput('synthetic', 'answers', { command: 'test' });
  const dir = join(b.dir, 'spool', '0');
  const seg = b.segment(dir);
  const answers = jobs.map((j, i) => spoolJob(j.x, { arm: j.arm, key: j.key, hypotheses: j.hypotheses, spool: spoolPaths(dir, i) }));
  answers.forEach((ans, i) => {
    if (ans.spooled.held) ans.spooled.held.times.ms = jobs[i].ms;
    seg.commit(ans.spooled);
  });
  b.adopt(seg);
  b.close();
  assert.deepEqual(files(b), files(a));
  assert.deepEqual(answers.map((ans) => ans.refused), [false, false, false, true]);
  assert.deepEqual(answers[0].validity, jobs[0].x.summary.validity);
  assert.equal(answers[2].rescue, null, 'only a maintained-tidy job answers with H-6\'s fields');
  assert.deepEqual(answers[0].rescue.spends.map((s) => s.intent), [1, 2], 'only the spends at a script interaction');
  assert.deepEqual(Object.keys(answers[0].rescue.spends[0]), ['t', 'intent', 'collateralAvailable']);
  assert.deepEqual(Object.keys(answers[0].rescue.bursts[0]), ['t', 'id', 'feasible']);
  const whole = rescueOutcomes(jobs[0].x, jobs[1].x);
  assert.deepEqual(rescueOutcomes(answers[0].rescue, answers[1].rescue), whole);
  assert.deepEqual(rescueOutcomes(rescueFields(jobs[0].x), rescueFields(jobs[1].x)), whole);
  assert.deepEqual(whole[0].rescue, { ledger: true, practice: true });
}));

const T = await treatment();

// The run before this change, in one thread: each job replayed in turn, its
// records built from the whole result in job order, then the trigger join.
async function inThread(wallets, plan, roles, collateralRules) {
  const { loadSource } = await import('../../../src/replay/source.mjs');
  const { expandJobs } = await import('../../../src/arms/plan.mjs');
  const { replay } = await import('../../../src/replay/engine.mjs');
  const { makeMethod } = await import('../../../src/methods/registry.mjs');
  const H6_RULES = new Set(['default', 'dust-1', 'band-3-6', 'band-5-20']);
  const out = new RunOutput('synthetic', 'in-thread', { command: 'test' });
  for (const w of wallets) {
    const source = loadSource(T, w.spec);
    const needs = source.events.some((e) => e.kind === 'intent' && e.intent.collateral.required);
    const results = [];
    for (const j of expandJobs(plan, { roles, needsCollateral: needs, collateralRules })) {
      const k = { wallet: source.wallet, window: source.window, arm: j.arm, variant: j.variant, method: j.method, change: j.change, collateral: j.collateral, repetition: j.repetition };
      const method = makeMethod(T, j.method, {});
      const x = await replay(T, source.params, source, { arm: j.arm, variant: j.variant, repetition: j.repetition, method, opts: { seed: j.repetition, changePolicy: j.change, collateralRule: j.collateral === 'none-needed' ? 'ledger' : j.collateral }, settleEvery: 25, policyLock: j.policyLock, validity: false });
      if (x.refused) {
        out.write(record('refused', k, { reason: x.refused }));
        continue;
      }
      results.push({ key: k, x });
      for (const p of x.plans) out.write(record('plan', k, p));
      for (const s of x.spends) out.write(record('spend', k, s));
      for (const b of x.bursts) out.write(record('burst', k, b));
      out.write(record('wallet-arm', k, { hypotheses: j.hypotheses, methodVersion: method.version, ...x.summary, ms: 1 }));
    }
    const byKey = new Map(results.map((r) => [JSON.stringify(r.key), r]));
    for (const { key: k, x } of results) {
      if (k.arm !== 'maintained-tidy' || !x.triggers.length) continue;
      const twin = H6_RULES.has(k.variant) ? byKey.get(JSON.stringify({ ...k, variant: 'never-propose' })) : null;
      for (const t of twin ? rescueOutcomes(x, twin.x) : x.triggers.map((tr) => ({ ...tr, rescue: null }))) out.write(record('trigger', k, t));
    }
  }
  out.close();
  return out;
}

// Timing rows with every time set to 0: the rows, numbers, kinds, keys and
// time paths compared, not the times.
const timeless = (text) => text.split('\n').filter(Boolean).map((l) => {
  const r = JSON.parse(l);
  return JSON.stringify({ ...r, times: Object.fromEntries(Object.keys(r.times).map((p) => [p, 0])) });
});

test('runReplays through two workers writes the records of every job replayed in one thread in job order', { skip, timeout: 5 * 60 * 1000 }, withHome(async () => {
  const { Pool } = await import('../../../src/replay/pool.mjs');
  const { testPlan } = await import('../../../src/arms/plan.mjs');
  const { DEFAULT_PINS } = await import('../../../src/treatment/bridge.mjs');
  const wallets = ['S1', 'CL1'].map((name) => ({ spec: { kind: 'shape', name, stream: 'synthetic' } }));
  const plan = testPlan({ reps: 1 }).filter((e) => e.hypothesis === 'H-1' || e.hypothesis === 'H-6');
  const roles = { test: 'test-largest-first' };
  const collateralRules = ['ledger', 'practice'];
  const ref = await inThread(wallets, plan, roles, collateralRules);
  // Two workers, each replaced after three jobs, so jobs end out of order.
  const pool = new Pool({ treatmentDir: TREATMENT_DIR, pinsPath: process.env.RESEARCH_SIM_TREATMENT_PINS || DEFAULT_PINS, size: 2, maxJobs: 3 });
  const out = new RunOutput('synthetic', 'spooled', { command: 'test' });
  let totals;
  try {
    totals = await runReplays(T, pool, { wallets, plan, roles, out, collateralRules });
  } finally {
    out.close();
    await pool.close();
  }
  const a = files(ref);
  const b = files(out);
  assert.ok(totals.triggers > 0, 'the trigger join ran');
  assert.ok(b.records.includes('"rescue":{"ledger":'), 'a trigger met its never-propose twin');
  assert.equal(b.records, a.records);
  assert.deepEqual(timeless(b.timings), timeless(a.timings));
  assert.equal(existsSync(join(out.dir, 'spool')), false, 'the spool is removed');
}));

test('a failed job stops the run and drops its wallet\'s segment: the records hold whole wallets, and the spool is removed', { skip }, withHome(async () => {
  const { testPlan } = await import('../../../src/arms/plan.mjs');
  const wallets = ['S1', 'CL1'].map((name) => ({ spec: { kind: 'shape', name, stream: 'synthetic' } }));
  const plan = testPlan({ reps: 1 }).filter((e) => e.hypothesis === 'H-1' || e.hypothesis === 'H-6');
  // A stand-in pool: each job answers with an engine result after a delay
  // that puts the jobs out of order; CL1's fourth job fails after others of
  // CL1 have been committed.
  let started = 0;
  const pool = {
    size: 2,
    async replay(job) {
      const n = started++;
      await new Promise((resolve) => setTimeout(resolve, (n * 7) % 5));
      if (job.key.wallet === 'CL1' && job.spool.records.endsWith('/3.records.jsonl')) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: false, error: 'stand-in failure', stop: false, ms: 1 };
      }
      return { ok: true, result: spoolJob(engineResult(job.variant), job), ms: 5 };
    }
  };
  const out = new RunOutput('synthetic', 'failed', { command: 'test' });
  try {
    await assert.rejects(runReplays(T, pool, { wallets, plan, roles: { test: 'test-largest-first' }, out }), /replay failed: stand-in failure/);
  } finally {
    out.close();
  }
  const recs = files(out).records.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(recs.length > 0);
  assert.deepEqual([...new Set(recs.map((r) => r.wallet))], ['S1'], 'only the wallet that completed');
  assert.equal(recs.filter((r) => r.kind === 'wallet-arm').length, new Set(recs.map((r) => JSON.stringify([r.arm, r.variant, r.collateral]))).size);
  assert.equal(existsSync(join(out.dir, 'spool')), false, 'the spool is removed');
}));
