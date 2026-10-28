// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Through the worker pool, a replay run repeated with the same seeds writes
// byte-identical records: three shapes' synthetic streams under the engine's
// test plan, two repetitions each, every collateral rule, two workers. The
// random control and the random grouping change with the repetition. And
// cardano-js-sdk, whose replay jobs each draw from the engine's one generator,
// writes byte-identical records for the same seeds whichever worker runs a
// job: once on two workers that each run many jobs, once on one worker
// replaced after every job; its seeds 1 and 2 differ.
// Needs RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treatment, skip, TREATMENT_DIR } from '../lib/treatment.mjs';
import { testPlan } from '../../src/arms/plan.mjs';
import { Pool } from '../../src/replay/pool.mjs';
import { runReplays } from '../../src/replay/run.mjs';
import { RunOutput } from '../../src/out/records.mjs';
import { DEFAULT_PINS } from '../../src/treatment/bridge.mjs';

const T = await treatment();

test('a run repeated with the same seeds writes byte-identical records', { skip, timeout: 3600 * 1000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'research-sim-repeat-'));
  const prev = process.env.RESEARCH_SIM_HOME;
  process.env.RESEARCH_SIM_HOME = home;
  const runOnce = async (id) => {
    const pool = new Pool({ treatmentDir: TREATMENT_DIR, pinsPath: process.env.RESEARCH_SIM_TREATMENT_PINS || DEFAULT_PINS, size: 2 });
    const out = new RunOutput('synthetic', id, { command: 'test' });
    try {
      await runReplays(T, pool, { wallets: ['S4', 'M8', 'CL1'].map((name) => ({ spec: { kind: 'shape', name, stream: 'synthetic' } })), plan: testPlan({ reps: 2 }), roles: { test: 'test-largest-first' }, out });
    } finally {
      out.close();
      await pool.close();
    }
    return readFileSync(join(out.dir, 'records.jsonl'), 'utf8');
  };
  try {
    const a = await runOnce('repeat-a');
    const b = await runOnce('repeat-b');
    assert.ok(a.length > 1000);
    assert.equal(a, b);
    // The random control and the random grouping differ between seeds.
    const lines = a.trim().split('\n').map((l) => JSON.parse(l));
    const ctl = lines.filter((l) => l.kind === 'plan' && l.arm === 'random-tidy' && l.wallet === 'S4' && l.collateral === 'ledger');
    assert.equal(ctl.length, 2);
    assert.deepEqual(ctl.map((l) => l.control.seed), [1, 2]);
  } finally {
    if (prev === undefined) delete process.env.RESEARCH_SIM_HOME;
    else process.env.RESEARCH_SIM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('cardano-js-sdk\'s replay jobs write byte-identical records for the same seeds, on any worker', { skip, timeout: 3600 * 1000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'research-sim-repeat-cjs-'));
  const prev = process.env.RESEARCH_SIM_HOME;
  process.env.RESEARCH_SIM_HOME = home;
  const plan = ['observed', 'tidy-once'].map((arm) => ({ hypothesis: 'H-1', arm, variant: 'default', role: 'rrri', change: 'default', repetitions: 2 }));
  const runOnce = async (id, poolOptions) => {
    const pool = new Pool({ treatmentDir: TREATMENT_DIR, pinsPath: process.env.RESEARCH_SIM_TREATMENT_PINS || DEFAULT_PINS, ...poolOptions });
    const out = new RunOutput('synthetic', id, { command: 'test' });
    try {
      await runReplays(T, pool, { wallets: ['S1', 'M7', 'M8'].map((name) => ({ spec: { kind: 'shape', name, stream: 'synthetic' } })), plan, roles: { rrri: 'cjs-rrri' }, out, collateralRules: ['ledger', 'practice'] });
    } finally {
      out.close();
      await pool.close();
    }
    return { records: readFileSync(join(out.dir, 'records.jsonl'), 'utf8'), stats: pool.stats };
  };
  try {
    const a = await runOnce('repeat-cjs-a', { size: 2 });
    const b = await runOnce('repeat-cjs-b', { size: 1, maxJobs: 1 });
    // 3 wallets, 2 arms, 2 collateral rules, 2 seeds: 24 jobs, each in a
    // fresh worker in the second run.
    assert.ok(b.stats.started >= 24);
    assert.ok(a.stats.started <= 2);
    assert.equal(a.records, b.records);
    const lines = a.records.trim().split('\n').map((l) => JSON.parse(l));
    const spends = lines.filter((l) => l.kind === 'spend');
    assert.ok(spends.length > 100);
    assert.ok(lines.filter((l) => l.kind === 'wallet-arm').every((l) => l.method === 'cjs-rrri' && /roundRobinRandomImprove/.test(l.methodVersion)));
    // Seeds 1 and 2 build some spend differently.
    const key = (l) => `${l.wallet}|${l.arm}|${l.collateral}|${l.intent}`;
    const second = new Map(spends.filter((l) => l.repetition === 2).map((l) => [key(l), JSON.stringify({ ...l, repetition: 0 })]));
    const differ = spends.filter((l) => l.repetition === 1 && second.get(key(l)) !== JSON.stringify({ ...l, repetition: 0 }));
    assert.ok(differ.length > 0, 'seeds 1 and 2 differ on some spend');
  } finally {
    if (prev === undefined) delete process.env.RESEARCH_SIM_HOME;
    else process.env.RESEARCH_SIM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
