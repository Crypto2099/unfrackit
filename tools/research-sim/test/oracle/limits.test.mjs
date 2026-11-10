// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The oracle's limits, in its workers. Under the work budget (the default):
// a call stopped by its budget of candidate sets returns best-at-limit with
// stop candidate-sets and its work equal to it, and one stopped by its
// program work has stop program-work and its units at or past the budget,
// with a solve interrupted at its share; the same call twice, in two workers
// at once and again in a worker that has run other calls, gives the same
// record but for its times; and a call the parent's watchdog stops runs
// again in a fresh worker with the watchdog doubled until it returns, with
// the record of the same call that no watchdog stopped.
// Under limit 'wall-clock', kept for measuring what a time limit allows, a
// call returns at its limit with its work counted, and the parent's margin
// still terminates a worker past it. The cases are E1's fungible share (400
// holders of one fungible) and S4's 100-recipient payroll, whose programs run
// far past these small budgets, and S8's ADA payment, which the program proves
// at once. Needs RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { treatment, skip, TREATMENT_DIR } from '../lib/treatment.mjs';
import { createOracle } from '../../src/oracle/oracle.mjs';
import { oracleRecord } from '../../src/oracle/battery-hook.mjs';
import { oracleSettings } from '../../src/oracle/settings.mjs';
import { shapeState } from '../../src/shapes/shapes.mjs';
import { SYNTHETIC_PARAMS as P } from '../../src/kit/params.mjs';
import { standardBattery, SHAPE_POOLS } from '../../src/battery/battery.mjs';

const T = await treatment();
const pinsText = process.env.RESEARCH_SIM_TREATMENT_PINS ? readFileSync(process.env.RESEARCH_SIM_TREATMENT_PINS, 'utf8') : undefined;

function spendOf(shape, id) {
  const s = shapeState(T, shape).state;
  return { s, spend: standardBattery(T, s, P, { pools: SHAPE_POOLS }).find((b) => b.id === id) };
}

// A record without its wall-clock fields.
function timeless(r) {
  const x = JSON.parse(JSON.stringify(oracleRecord(r), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  delete x.ms;
  delete x.evaluations.ms;
  return x;
}

const tag = (r) => JSON.stringify({ status: r.status, stop: r.stop, fee: String(r.fee), bound: String(r.bound), work: r.work, ms: Math.round(r.ms) });

test('a budget of a few candidate sets stops best-at-limit, and the same call gives the same record in any worker', { skip, timeout: 10 * 60 * 1000 }, async (t) => {
  const { s, spend } = spendOf('E1', 'fungible-share');
  const settings = oracleSettings({ maxCandidateSets: '4' });
  const o = createOracle({ treatmentDir: TREATMENT_DIR, pinsText, workers: 2 });
  try {
    // Two workers at once, then the first worker again after another call.
    const [a, b] = await Promise.all([o.oracle(s, spend, P, 'csl', { settings }), o.oracle(s, spend, P, 'csl', { settings })]);
    const small = spendOf('S8', 'ada-payment');
    await o.oracle(small.s, small.spend, P, 'csl', { settings });
    const c = await o.oracle(s, spend, P, 'csl', { settings });
    t.diagnostic(tag(a));
    assert.equal(a.status, 'best-at-limit');
    assert.equal(a.stop, 'candidate-sets');
    assert.equal(a.work.candidateSets, 4);
    assert.ok(a.work.solves >= 4 && a.work.nnzSolvesPlusIterations < settings.maxProgramWork, `solves ${a.work.solves}, units ${a.work.nnzSolvesPlusIterations}`);
    assert.equal(a.terminated, false);
    assert.equal(a.settings.maxCandidateSets, 4);
    assert.ok(a.fee !== null && a.bound !== null && a.bound <= a.fee);
    assert.deepEqual(timeless(b), timeless(a));
    assert.deepEqual(timeless(c), timeless(a));
    assert.equal(o.stats.workersStarted, 2);
  } finally {
    await o.close();
  }
});

test('the program-work budget stops the call, each solve interrupted at its share, the same in two workers', { skip, timeout: 10 * 60 * 1000 }, async (t) => {
  const { s, spend } = spendOf('S4', 'payroll-100');
  const o = createOracle({ treatmentDir: TREATMENT_DIR, pinsText, workers: 2 });
  try {
    const settings = oracleSettings({ maxProgramWork: '200000' });
    const [a, b] = await Promise.all([o.oracle(s, spend, P, 'csl', { settings }), o.oracle(s, spend, P, 'csl', { settings })]);
    t.diagnostic(tag(a));
    assert.equal(a.stop, 'program-work');
    assert.ok(['best-at-limit', 'undecided'].includes(a.status));
    assert.equal(a.settings.maxProgramWork, 200000);
    // The call stops once its units reach the budget, which the last solve
    // can pass by what it counts between two checkpoints.
    const w = a.work;
    assert.equal(w.nnzSolvesPlusIterations, w.nnzSolves + 3 * w.lpIterations);
    assert.ok(w.nnzSolvesPlusIterations >= 200000, `units ${w.nnzSolvesPlusIterations}`);
    assert.ok(w.solves >= 2, `solves ${w.solves}`);
    // HiGHS reports a solve stopped by the interrupt as interrupted (17).
    assert.ok(a.detail.mip.statuses[17] >= 1, 'a solve was interrupted at its units');
    assert.deepEqual(timeless(b), timeless(a));
  } finally {
    await o.close();
  }
});

test('a call the watchdog stops runs again with the watchdog doubled until it returns, with the record of a call it never stopped', { skip, timeout: 10 * 60 * 1000 }, async (t) => {
  const { s, spend } = spendOf('E1', 'fungible-share');
  const settings = oracleSettings({ maxCandidateSets: '4' });
  const notes = [];
  const o = createOracle({ treatmentDir: TREATMENT_DIR, pinsText, workers: 1, note: (e) => notes.push(e) });
  try {
    const plain = await o.oracle(s, spend, P, 'csl', { settings });
    assert.equal(o.stats.watchdogStops, 0);
    // A watchdog of 100 ms stops the call (a fresh worker loads the solver
    // first) until it has doubled past the call's time.
    const r = await o.oracle(s, spend, P, 'csl', { settings, watchdogMs: 100 });
    t.diagnostic(`${tag(r)}; ${notes.length} stops`);
    assert.ok(o.stats.watchdogStops >= 1, 'the watchdog stopped the call');
    assert.deepEqual(notes.map((e) => e.watchdogMs), notes.map((_e, i) => 100 * 2 ** i));
    assert.equal(o.stats.workersStarted, 1 + o.stats.watchdogStops);
    assert.deepEqual([r.status, r.stop, r.terminated], [plain.status, plain.stop, false]);
    assert.deepEqual(timeless(r), timeless(plain));
  } finally {
    await o.close();
  }
});

test('under the wall-clock limit a call returns at its limit with its work counted, and the margin still terminates', { skip, timeout: 10 * 60 * 1000 }, async (t) => {
  const { s, spend } = spendOf('E1', 'fungible-share');
  const settings = oracleSettings({ limit: 'wall-clock' });
  const o = createOracle({ treatmentDir: TREATMENT_DIR, pinsText, workers: 1, marginMs: -2000 });
  try {
    await assert.rejects(o.oracle(s, spend, P, 'csl', { timeLimitMs: 5000 }), /timeLimitMs applies only under the oracle setting limit=wall-clock/);
    // The margin of minus 2 seconds terminates the worker 3 seconds into a
    // 5-second call.
    const r = await o.oracle(s, spend, P, 'csl', { settings, timeLimitMs: 5000 });
    t.diagnostic(tag(r));
    assert.deepEqual([r.status, r.stop, r.terminated], ['undecided', 'guard', true]);
    assert.ok(r.wallMs >= 3000 && r.wallMs < 5000, `terminated after ${r.wallMs} ms`);
  } finally {
    await o.close();
  }
  const o2 = createOracle({ treatmentDir: TREATMENT_DIR, pinsText, workers: 1 });
  try {
    const r = await o2.oracle(s, spend, P, 'csl', { settings, timeLimitMs: 5000 });
    t.diagnostic(tag(r));
    assert.ok(r.status === 'best-at-limit' || r.status === 'undecided', `status ${r.status}`);
    assert.equal(r.stop, 'wall-clock');
    assert.equal(r.terminated, false);
    assert.ok(r.ms >= 5000 && r.ms < 10000, `ran ${r.ms} ms`);
    assert.ok(r.work.solves >= 1 && r.work.candidateSets >= 1, 'the work is counted');
  } finally {
    await o2.close();
  }
});
