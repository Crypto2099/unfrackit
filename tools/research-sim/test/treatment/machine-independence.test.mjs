// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The records do not depend on how the machine runs the jobs. The same
// replays over S1, S8 and M1 run three ways: through one worker
// that runs every job in turn; through three workers, each replaced after a
// single job, so every job starts in a fresh worker; and the same with a
// two workers each replaced after three jobs. (A job that reaches the time
// limit is stopped and recorded as stopped, which depends on the machine; it is
// the one rule that does, and test/unit/core/replay-stop.test.mjs checks it.)
// The three write the same records, byte for byte once the unseeded
// selectors' (csl-ri and cml-ri, the library table's seeded column) are set aside; theirs are compared by key and count,
// where those are fixed (the jobs, and one spend record per intent). The
// replay plan is the study's recent plan under the ledger collateral rule.
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
import { DEFAULT_PINS } from '../../src/treatment/bridge.mjs';
import { windowPlan, STUDY_ROLES, LIBRARY_TABLE } from '../../src/arms/plan.mjs';

const T = await treatment();
const pins = process.env.RESEARCH_SIM_TREATMENT_PINS || DEFAULT_PINS;
const SHAPES = ['S1', 'S8', 'M1'];
const UNSEEDED = new Set(LIBRARY_TABLE.filter((r) => !r.seeded).map((r) => r.method));
// One worker running every job; three, each job in a fresh worker; two, each
// replaced after three jobs.
const WAYS = [{ name: 'one', size: 1, maxJobs: 40 }, { name: 'fresh', size: 3, maxJobs: 1 }, { name: 'pair', size: 2, maxJobs: 3 }];

function withHome(fn) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'research-sim-machine-'));
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

const lines = (dir, file) => readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean);
const keyOf = (r) => JSON.stringify([r.kind, r.wallet, r.window, r.arm, r.variant, r.method, r.change, r.collateral, r.repetition, r.spend ?? null]);

// The records split: the seeded methods' lines as written, and the unseeded
// selectors' keys and counts for the kinds whose number is fixed.
function split(text, countedKinds) {
  const seeded = [];
  const unseeded = new Map();
  for (const l of text) {
    const r = JSON.parse(l);
    if (!UNSEEDED.has(r.method)) seeded.push(l);
    else if (countedKinds.includes(r.kind)) unseeded.set(keyOf(r), (unseeded.get(keyOf(r)) || 0) + 1);
  }
  return { seeded, unseeded: [...unseeded].sort() };
}

// A replay run (wallets given) is a stage, whose joined records and log are
// read; a run without wallets writes its records whole.
async function runWay(way, runId, go, { wallets = null } = {}) {
  const pool = new Pool({ treatmentDir: TREATMENT_DIR, pinsPath: pins, size: way.size, maxJobs: way.maxJobs });
  const out = wallets ? await testStage(runId, wallets, { workers: way.size }) : new RunOutput('synthetic', runId, { command: 'test' });
  try {
    const totals = await go(pool, out);
    out.close();
    if (wallets) return { records: stageText(out.dir).split('\n').filter(Boolean), log: stageLog(out.dir), totals, stats: { ...pool.stats } };
    return { records: lines(out.dir, 'records.jsonl'), log: lines(out.dir, 'log.jsonl').map((l) => JSON.parse(l)), totals, stats: { ...pool.stats } };
  } finally {
    await pool.close();
  }
}

function assertSame(runs, countedKinds) {
  const [a, ...rest] = runs.map((r) => split(r.records, countedKinds));
  assert.ok(a.seeded.length > 100, `${a.seeded.length} seeded records`);
  assert.ok(a.unseeded.length > 0, 'the unseeded selectors ran');
  rest.forEach((b, i) => {
    assert.equal(b.seeded.length, a.seeded.length, `${WAYS[i + 1].name}: seeded record count`);
    const at = b.seeded.findIndex((l, j) => l !== a.seeded[j]);
    assert.equal(at, -1, `${WAYS[i + 1].name}: the first record that differs is number ${at}`);
    assert.deepEqual(b.unseeded, a.unseeded, `${WAYS[i + 1].name}: the unseeded selectors' keys and counts`);
    assert.deepEqual(runs[i + 1].totals, runs[0].totals, `${WAYS[i + 1].name}: totals`);
  });
}

test('replays: one worker, a fresh worker per job, and two workers replaced after three jobs write the same records', { skip, timeout: 20 * 60 * 1000 }, withHome(async () => {
  const wallets = SHAPES.map((name) => ({ spec: { kind: 'shape', name, stream: 'synthetic' } }));
  // The study's arms, one repetition each.
  const plan = windowPlan('recent', { reps: 1 });
  const opts = { wallets, plan, roles: { ...STUDY_ROLES }, collateralRules: ['ledger'] };
  const runs = [];
  for (const way of WAYS) runs.push(await runWay(way, `machine-replay-${way.name}`, (pool, out) => runReplays(T, pool, { ...opts, out }), { wallets }));
  assert.deepEqual(runs.map((r) => r.stats.watchdogStops), [0, 0, 0]);
  assert.ok(runs[1].stats.started >= runs[1].totals.jobs, 'a fresh worker per job');
  assertSame(runs, ['wallet-arm', 'spend']);
}));
