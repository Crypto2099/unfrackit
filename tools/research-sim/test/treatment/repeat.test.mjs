// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Through the worker pool, a replay run repeated with the same seeds writes
// byte-identical records: three shapes' synthetic streams under the engine's
// test plan, two repetitions each, every collateral rule, two workers. The
// random control and the random grouping change with the repetition.
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
