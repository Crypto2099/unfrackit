// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The battery command's path with the real oracle hook: the study plan at two
// repetitions through the worker pool on S1 and S8, whose references are all
// proven quickly, and the oracle (createBatteryOracle, two workers) called by
// runBatteries. For every observed-layout spend that was built there is one
// oracle record per policy the plan's methods map to; each holds as
// incumbents exactly the single transactions of that policy's runs that
// passed the kit; the reference fee is present whenever there is an
// incumbent, is at most every incumbent's fee, and every incumbent's change
// equals the policy's; tidy-layout spends and chains get none.
// Needs RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treatment, skip, TREATMENT_DIR } from '../lib/treatment.mjs';
import { Pool } from '../../src/replay/pool.mjs';
import { runBatteries } from '../../src/replay/run.mjs';
import { RunOutput } from '../../src/out/records.mjs';
import { DEFAULT_PINS } from '../../src/treatment/bridge.mjs';
import { batteryPlan, STUDY_ROLES } from '../../src/arms/plan.mjs';
import { createBatteryOracle } from '../../src/oracle/battery-hook.mjs';
import { policyOfMethod } from '../../src/oracle/policies.mjs';

const T = await treatment();

test('battery --oracle: references for the study plan\'s change policies', { skip, timeout: 15 * 60 * 1000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'research-sim-battery-oracle-'));
  const prev = process.env.RESEARCH_SIM_HOME;
  process.env.RESEARCH_SIM_HOME = home;
  const pinsPath = process.env.RESEARCH_SIM_TREATMENT_PINS || DEFAULT_PINS;
  const pool = new Pool({ treatmentDir: TREATMENT_DIR, pinsPath, size: 2 });
  const out = new RunOutput('synthetic', 'battery-oracle-test', { command: 'test' });
  const hook = await createBatteryOracle({ treatmentDir: TREATMENT_DIR, pinsText: readFileSync(pinsPath, 'utf8'), workers: 2 });
  try {
    const methods = batteryPlan({ roles: STUDY_ROLES, reps: 2 });
    const totals = await runBatteries(T, pool, { wallets: ['S1', 'S8'].map((name) => ({ spec: { kind: 'shape', name, stream: null } })), methods, out, oracle: hook });
    out.close();
    const recs = readFileSync(join(out.dir, 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const oracleRecs = recs.filter((r) => r.kind === 'battery' && r.method === 'oracle');
    const runs = recs.filter((r) => r.kind === 'battery' && r.method !== 'oracle' && r.method !== 'none');
    assert.equal(totals.oracle, oracleRecs.length);

    // The policies the plan reaches.
    const planPolicies = new Set(methods.flatMap((m) => m.opts.map((o) => policyOfMethod(m.name, o.changePolicy))));
    assert.deepEqual([...planPolicies].sort(), ['cjs', 'csl', 'csl-ppc', 'evo', 'layout']);

    // Observed-layout spends only, one record per wallet, spend and policy.
    assert.ok(oracleRecs.every((r) => r.arm === 'observed' && r.repetition === 1));
    assert.ok(runs.some((r) => r.arm === 'tidy-once'), 'the plan runs tidy-layout spends');
    const keyOf = (r) => `${r.wallet}|${r.spend}|${r.change}`;
    assert.equal(new Set(oracleRecs.map(keyOf)).size, oracleRecs.length);
    const spends = new Set(runs.filter((r) => r.arm === 'observed').map((r) => `${r.wallet}|${r.spend}`));
    assert.ok(spends.size > 10);
    for (const s of spends) for (const p of planPolicies) assert.ok(oracleRecs.some((r) => `${r.wallet}|${r.spend}` === s && r.change === p), `no ${p} record for ${s}`);
    assert.equal(oracleRecs.length, spends.size * planPolicies.size);

    let withIncumbents = 0;
    for (const o of oracleRecs) {
      // The incumbents are the single transactions of the policy's runs that passed.
      const passed = runs.filter((r) => r.wallet === o.wallet && r.spend === o.spend && r.arm === 'observed' && r.ok && r.answer === 'single' && policyOfMethod(r.method, r.change) === o.change);
      assert.equal(o.incumbents, passed.length, `${keyOf(o)}: incumbents`);
      assert.equal(o.oracle.incumbents.length, passed.length);
      if (!passed.length) continue;
      withIncumbents++;
      const ref = o.oracle;
      assert.notEqual(ref.fee, null, `${keyOf(o)}: no reference fee beside an incumbent`);
      assert.ok(['optimal', 'best-at-limit'].includes(ref.status), `${keyOf(o)}: ${ref.status}`);
      for (const i of ref.incumbents) {
        assert.ok(BigInt(ref.fee) <= BigInt(i.fee), `${keyOf(o)}: reference ${ref.fee} above ${i.name} ${i.fee}`);
        assert.equal(i.sameChange, true, `${keyOf(o)}: ${i.name} change`);
      }
    }
    assert.ok(withIncumbents > 10);
  } finally {
    await hook.close();
    await pool.close();
    if (prev === undefined) delete process.env.RESEARCH_SIM_HOME;
    else process.env.RESEARCH_SIM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
