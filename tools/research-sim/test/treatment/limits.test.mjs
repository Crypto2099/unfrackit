// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The time limit, forced. A replay that reaches it with a build running is
// stopped: its worker is killed, the job is not run again, the spends it
// completed stay in its records, and its wallet-arm record says it was stopped
// for time (replay/run.mjs, stoppedArm). The stop is not a time-out record or
// a failure class. Every other job of the run writes the records it writes
// without the limit. The method that forces it is the registry's test-stall,
// which blocks its thread as a synchronous library call does, here for 3
// seconds on one intent, under a 2-second limit (the study's is a day per
// replay).
// Needs RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treatment, skip, TREATMENT_DIR } from '../lib/treatment.mjs';
import { Pool } from '../../src/replay/pool.mjs';
import { runReplays } from '../../src/replay/run.mjs';
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
// A replay run (wallets given) is a stage, whose joined records and log are
// read; a run without wallets writes its records whole.
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

test('a replay that reaches the time limit is stopped and not run again, and every other job writes the records it writes without a limit', { skip, timeout: 10 * 60 * 1000 }, withHome(async () => {
  const spec = { kind: 'shape', name: 'S1', stream: 'synthetic' };
  const first = loadSource(T, spec).events.find((e) => e.kind === 'intent').intent.id;
  const plan = [{ hypothesis: 'test', arm: 'observed', variant: 'default', role: 'stall', change: 'default', repetitions: 1 }, { hypothesis: 'test', arm: 'observed', variant: 'default', role: 'test', change: 'default', repetitions: 1 }];
  const opts = { wallets: [{ spec }], plan, roles: { stall: 'test-stall', test: 'test-largest-first' }, methodOptions: { 'test-stall': { stallMs: STALL_MS, only: [first] } }, collateralRules: ['ledger'] };
  const stopped = await run('limit-replay', (pool, out) => runReplays(T, pool, { ...opts, out, watchdogMs: WATCHDOG_MS }), { wallets: opts.wallets });
  const plain = await run('plain-replay', (pool, out) => runReplays(T, pool, { ...opts, out }), { wallets: opts.wallets });
  // One stop, of the stalling job, at the limit, with its build running; no rerun.
  const stops = stopped.log.filter((e) => e.event === 'watchdog stop');
  assert.deepEqual(stops.map((e) => [e.method, e.watchdogMs, e.at, e.attempt]), [['test-stall', WATCHDOG_MS, 'running build', 1]]);
  assert.deepEqual([stopped.stats.watchdogStops, plain.stats.watchdogStops, stopped.stats.machineReruns], [1, 0, 0]);
  assert.deepEqual(stopped.totals, { ...plain.totals, stopped: 1 });
  // The stalled intent was the job's first: no spend was completed, and its
  // wallet-arm record says so. The other job's records are the plain run's.
  const stall = stopped.recs.filter((r) => r.method === 'test-stall');
  assert.deepEqual(stall.map((r) => r.kind), ['wallet-arm']);
  assert.equal(stall[0].stopped.reason, 'excessive time');
  assert.deepEqual([stall[0].stopped.spends, stall[0].stopped.last, stall[0].stopped.at, stall[0].stopped.limitMs], [0, null, 'running build', WATCHDOG_MS]);
  const other = (r) => r.recs.filter((x) => x.method === 'test-largest-first').map((x) => JSON.stringify(x));
  assert.deepEqual(other(stopped), other(plain));
  assert.ok(!stopped.recs.some((r) => r.kind === 'timeout' || r.class === 'time-limit'));
  assert.equal(stopped.recs.filter((r) => r.kind === 'wallet-arm').length, 2);
}));
