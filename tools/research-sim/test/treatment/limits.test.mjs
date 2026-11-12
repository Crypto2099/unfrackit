// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// No time limit decides a result; the watchdogs, forced. A replay the
// watchdog stops is set aside, its worker terminated, and it runs again with
// the watchdog doubled until it completes; a method answer the watchdog stops
// is set aside the same way, and the wallet's battery resumes at it in a
// fresh worker. Neither stop is a record: there is no time-out record and no
// time-limit failure, and the records are byte for byte those of the same
// run that no watchdog stopped. The method that forces both is the
// registry's test-stall, which blocks its thread as a synchronous library
// call does, here for 3 seconds on one intent or spend, under a 2-second
// watchdog (the study's are a day per replay and half an hour per answer).
// Needs RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treatment, skip, TREATMENT_DIR } from '../lib/treatment.mjs';
import { Pool } from '../../src/replay/pool.mjs';
import { runReplays, runBatteries } from '../../src/replay/run.mjs';
import { RunOutput } from '../../src/out/records.mjs';
import { testStage, stageText, stageLog } from '../lib/stage.mjs';
import { loadSource } from '../../src/replay/source.mjs';
import { DEFAULT_PINS } from '../../src/treatment/bridge.mjs';

const T = await treatment();
const pins = process.env.RESEARCH_SIM_TREATMENT_PINS || DEFAULT_PINS;
const WATCHDOG_MS = 2000;
const STALL_MS = 3000;

function withHome(fn) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'research-sim-limits-'));
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

const lines = (out, file) => readFileSync(join(out.dir, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// One run through a pool of one worker: { text, recs, log, totals, stats }.
// A battery run writes its records whole; a replay run (wallets given) is a
// stage, whose joined records and log are read.
async function run(runId, go, { wallets = null } = {}) {
  const pool = new Pool({ treatmentDir: TREATMENT_DIR, pinsPath: pins, size: 1 });
  const out = wallets ? await testStage(runId, wallets) : new RunOutput('synthetic', runId, { command: 'test' });
  try {
    const totals = await go(pool, out);
    out.close();
    if (wallets) {
      const text = stageText(out.dir);
      return { text, recs: text.split('\n').filter(Boolean).map((l) => JSON.parse(l)), log: stageLog(out.dir), totals, stats: { ...pool.stats } };
    }
    return { text: readFileSync(join(out.dir, 'records.jsonl'), 'utf8'), recs: lines(out, 'records.jsonl'), log: lines(out, 'log.jsonl'), totals, stats: { ...pool.stats } };
  } finally {
    await pool.close();
  }
}

test('a replay the watchdog stops runs again to completion, and its records are those of a run it never stopped', { skip, timeout: 10 * 60 * 1000 }, withHome(async () => {
  const spec = { kind: 'shape', name: 'S1', stream: 'synthetic' };
  const first = loadSource(T, spec).events.find((e) => e.kind === 'intent').intent.id;
  const plan = [{ hypothesis: 'test', arm: 'observed', variant: 'default', role: 'stall', change: 'default', repetitions: 1 }, { hypothesis: 'test', arm: 'observed', variant: 'default', role: 'test', change: 'default', repetitions: 1 }];
  const opts = { wallets: [{ spec }], plan, roles: { stall: 'test-stall', test: 'test-largest-first' }, methodOptions: { 'test-stall': { stallMs: STALL_MS, only: [first] } }, collateralRules: ['ledger'] };
  const stopped = await run('watchdog-replay', (pool, out) => runReplays(T, pool, { ...opts, out, watchdogMs: WATCHDOG_MS }), { wallets: opts.wallets });
  const plain = await run('plain-replay', (pool, out) => runReplays(T, pool, { ...opts, out }), { wallets: opts.wallets });
  // One stop, of the stalling job, at the watchdog; the rerun at twice it
  // completed.
  const stops = stopped.log.filter((e) => e.event === 'watchdog stop');
  assert.deepEqual(stops.map((e) => [e.method, e.watchdogMs]), [['test-stall', WATCHDOG_MS]]);
  assert.deepEqual([stopped.stats.watchdogStops, plain.stats.watchdogStops], [1, 0]);
  assert.equal(stopped.stats.started, 2, 'the rerun ran in a fresh worker');
  // Nothing of the stop is a record: the records are the plain run's, byte
  // for byte, with the stalled intent's answer completed.
  assert.equal(stopped.text, plain.text);
  assert.deepEqual(stopped.totals, plain.totals);
  assert.ok(!stopped.recs.some((r) => r.kind === 'timeout' || r.class === 'time-limit'));
  const stall = stopped.recs.filter((r) => r.kind === 'spend' && r.method === 'test-stall');
  assert.equal(stall.filter((r) => r.detail === `stalled ${STALL_MS} ms`).length, 1);
  assert.equal(stopped.recs.filter((r) => r.kind === 'wallet-arm').length, 2);
}));

test('an answer the watchdog stops runs again to completion, the battery resuming at it; its records are those of a run it never stopped', { skip, timeout: 10 * 60 * 1000 }, withHome(async () => {
  // One stalling method on one spend, then the test method on every spend.
  const methods = [{ name: 'test-stall', options: { stallMs: STALL_MS, only: ['ada-payment'] }, opts: [{ changePolicy: 'default' }], repetitions: 1 }, { name: 'test-largest-first', opts: [{ changePolicy: 'layout' }], repetitions: 1 }];
  const opts = { wallets: [{ spec: { kind: 'shape', name: 'S1', stream: null } }], methods };
  const stopped = await run('watchdog-battery', (pool, out) => runBatteries(T, pool, { ...opts, out, watchdogMs: WATCHDOG_MS }));
  const plain = await run('plain-battery', (pool, out) => runBatteries(T, pool, { ...opts, out }));
  const stops = stopped.log.filter((e) => e.event === 'watchdog stop');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].watchdogMs, WATCHDOG_MS);
  assert.deepEqual([stopped.stats.watchdogStops, plain.stats.watchdogStops], [1, 0]);
  assert.equal(stopped.stats.started, 2, 'the battery resumed in a fresh worker');
  assert.equal(stopped.text, plain.text);
  assert.deepEqual(stopped.totals, plain.totals);
  const recs = stopped.recs.filter((r) => r.kind === 'battery' && r.method !== 'none');
  assert.ok(!recs.some((r) => r.class === 'time-limit'));
  const stall = recs.filter((r) => r.method === 'test-stall');
  // ada-payment's answer ran to completion; every other spend failed at once.
  assert.deepEqual(stall.filter((r) => r.detail === `stalled ${STALL_MS} ms`).map((r) => r.spend), ['ada-payment']);
  assert.ok(stall.filter((r) => r.spend !== 'ada-payment').every((r) => r.detail === 'not stalled'));
  const others = recs.filter((r) => r.method === 'test-largest-first');
  assert.equal(others.length, stall.length, 'every spend ran under the test method too, after the stop');
  assert.ok(others.some((r) => r.ok));
}));
