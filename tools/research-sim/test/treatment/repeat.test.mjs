// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Through the worker pool, a replay run repeated with the same seeds writes
// byte-identical records: three shapes' synthetic streams under the recent
// plan with the test method in every role, two repetitions of the random
// roles, every collateral rule, two workers. And
// cardano-js-sdk, whose replay jobs each draw from the engine's one generator,
// writes byte-identical records for the same seeds whichever worker runs a
// job: once on two workers that each run many jobs, once on one worker
// replaced after every job; its seeds 1 and 2 differ.
// Needs RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treatment, skip, TREATMENT_DIR } from '../lib/treatment.mjs';
import { windowPlan, TEST_ROLES } from '../../src/arms/plan.mjs';
import { Pool } from '../../src/replay/pool.mjs';
import { runReplays } from '../../src/replay/run.mjs';
import { testStage, stageText } from '../lib/stage.mjs';
import { DEFAULT_PINS } from '../../src/treatment/bridge.mjs';

const T = await treatment();

test('a run repeated with the same seeds writes byte-identical records', { skip, timeout: 3600 * 1000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'research-sim-repeat-'));
  const prev = process.env.RESEARCH_SIM_HOME;
  process.env.RESEARCH_SIM_HOME = home;
  const runOnce = async (id) => {
    const pool = new Pool({ treatmentDir: TREATMENT_DIR, pinsPath: process.env.RESEARCH_SIM_TREATMENT_PINS || DEFAULT_PINS, size: 2 });
    const wallets = ['S4', 'M8', 'CL1'].map((name) => ({ spec: { kind: 'shape', name, stream: 'synthetic' } }));
    const out = await testStage(id, wallets);
    try {
      await runReplays(T, pool, { wallets, plan: windowPlan('recent', { reps: 2 }), roles: TEST_ROLES, out, collateralRules: ['ledger', 'practice'] });
    } finally {
      out.close();
      await pool.close();
    }
    return stageText(out.dir);
  };
  try {
    const a = await runOnce('repeat-a');
    const b = await runOnce('repeat-b');
    assert.ok(a.length > 1000);
    assert.equal(a, b);
    // Both repetitions of the random roles are recorded.
    const lines = a.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual([...new Set(lines.filter((l) => l.kind === 'wallet-arm' && l.wallet === 'S4').map((l) => l.repetition))].sort(), [1, 2]);
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
  const plan = [{ hypothesis: 'Q1', arm: 'observed', variant: 'default', role: 'rrri', change: 'default', repetitions: 2 }];
  const runOnce = async (id, poolOptions) => {
    const pool = new Pool({ treatmentDir: TREATMENT_DIR, pinsPath: process.env.RESEARCH_SIM_TREATMENT_PINS || DEFAULT_PINS, ...poolOptions });
    const wallets = ['S1', 'M7', 'M8'].map((name) => ({ spec: { kind: 'shape', name, stream: 'synthetic' } }));
    const out = await testStage(id, wallets);
    try {
      await runReplays(T, pool, { wallets, plan, roles: { rrri: 'cjs-rrri' }, out, collateralRules: ['ledger', 'practice'] });
    } finally {
      out.close();
      await pool.close();
    }
    return { records: stageText(out.dir), stats: pool.stats };
  };
  try {
    const a = await runOnce('repeat-cjs-a', { size: 2 });
    const b = await runOnce('repeat-cjs-b', { size: 1, maxJobs: 1 });
    // 3 wallets, 2 collateral rules, 2 seeds: 12 jobs, each in a fresh worker
    // in the second run.
    assert.ok(b.stats.started >= 12);
    assert.ok(a.stats.started <= 2);
    assert.equal(a.records, b.records);
    const lines = a.records.trim().split('\n').map((l) => JSON.parse(l));
    const spends = lines.filter((l) => l.kind === 'spend');
    assert.ok(spends.length > 100);
    assert.ok(lines.filter((l) => l.kind === 'wallet-arm').every((l) => l.method === 'cjs-rrri' && /roundRobinRandomImprove/.test(l.methodVersion)));
    // Seeds 1 and 2 build some spend differently.
    const key = (l) => `${l.wallet}|${l.collateral}|${l.intent}`;
    const second = new Map(spends.filter((l) => l.repetition === 2).map((l) => [key(l), JSON.stringify({ ...l, repetition: 0 })]));
    const differ = spends.filter((l) => l.repetition === 1 && second.get(key(l)) !== JSON.stringify({ ...l, repetition: 0 }));
    assert.ok(differ.length > 0, 'seeds 1 and 2 differ on some spend');
  } finally {
    if (prev === undefined) delete process.env.RESEARCH_SIM_HOME;
    else process.env.RESEARCH_SIM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
