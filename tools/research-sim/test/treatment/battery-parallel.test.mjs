// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The battery command's wallets in parallel: runBatteries through a pool of 1
// and a pool of 3 writes the same records in the same order. With the test
// methods on S1, S7, S8, M1 and M7 the two records files are byte-identical.
// With the study plan at two repetitions on S1 and S8 and the real oracle
// hook they are equal outside the records no caller can reproduce: the runs of
// the selectors that draw from a generator nobody seeds (csl-ri, csl-ri-pure),
// the oracle references at the limit, the csl and csl-ppc references whose
// incumbents include one of those runs, and runs that reached the answer
// limit. A wallet's failure stops the run with its error.
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

const T = await treatment();
const pinsPath = process.env.RESEARCH_SIM_TREATMENT_PINS || DEFAULT_PINS;
const wallets = (names) => names.map((name) => ({ spec: { kind: 'shape', name, stream: null } }));
const UNSEEDED = new Set(['csl-ri', 'csl-ri-pure']);
const PROVEN = new Set(['optimal', 'infeasible']);

async function run(runId, size, names, methods, oracle) {
  const pool = new Pool({ treatmentDir: TREATMENT_DIR, pinsPath, size });
  const out = new RunOutput('synthetic', runId, { command: 'test' });
  try {
    const totals = await runBatteries(T, pool, { wallets: wallets(names), methods, out, oracle });
    out.close();
    const text = readFileSync(join(out.dir, 'records.jsonl'), 'utf8');
    return { totals, text, recs: text.trim().split('\n').map((l) => JSON.parse(l)) };
  } finally {
    await pool.close();
  }
}

// Fields that measure the wall clock beyond the `ms` ones the output strips.
function stable(rec) {
  return JSON.stringify(rec, (k, v) => (k === 'wallMs' || k === 'wallclockMs' ? undefined : v));
}

test('battery: a pool of 3 writes the records of a pool of 1', { skip, timeout: 20 * 60 * 1000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'research-sim-battery-parallel-'));
  const prev = process.env.RESEARCH_SIM_HOME;
  process.env.RESEARCH_SIM_HOME = home;
  const hook = await createBatteryOracle({ treatmentDir: TREATMENT_DIR, pinsText: readFileSync(pinsPath, 'utf8'), workers: 2 });
  try {
    // The test methods: byte-identical.
    const testMethods = [
      { name: 'test-largest-first', opts: [{ changePolicy: 'layout' }, { changePolicy: 'single' }, { changePolicy: 'naive' }], repetitions: 1 },
      { name: 'unfrackit-h12', opts: [{ changePolicy: 'default', absorb: true }, { changePolicy: 'default', absorb: false }], repetitions: 1 }
    ];
    const names = ['S1', 'S7', 'S8', 'M1', 'M7'];
    const one = await run('parallel-test-1', 1, names, testMethods, null);
    const three = await run('parallel-test-3', 3, names, testMethods, null);
    assert.ok(one.recs.length > 50);
    assert.deepEqual(three.totals, one.totals);
    assert.equal(three.text, one.text);
    // In wallet order.
    const order = [];
    for (const r of three.recs) if (order[order.length - 1] !== r.wallet) order.push(r.wallet);
    assert.equal(new Set(order).size, order.length);
    assert.deepEqual(order, names.map((n) => three.recs.find((r) => r.wallet.includes(n) || r.wallet === n)?.wallet));

    // The study plan with the real oracle.
    const methods = batteryPlan({ roles: STUDY_ROLES, reps: 2 });
    const a = await run('parallel-study-1', 1, ['S1', 'S8'], methods, hook);
    const b = await run('parallel-study-3', 3, ['S1', 'S8'], methods, hook);
    assert.equal(b.recs.length, a.recs.length);
    assert.equal(b.totals.oracle, a.totals.oracle);
    const same = (x, y) => x.kind === y.kind && x.wallet === y.wallet && x.method === y.method && x.change === y.change && x.repetition === y.repetition && x.arm === y.arm && x.spend === y.spend;
    let compared = 0;
    let excluded = 0;
    for (let i = 0; i < a.recs.length; i++) {
      const x = a.recs[i];
      const y = b.recs[i];
      assert.ok(same(x, y), `record ${i}: same position`);
      if (x.kind === 'battery' && x.method === 'oracle') {
        const proven = PROVEN.has(x.oracle.status) && PROVEN.has(y.oracle.status);
        const unseededIncumbent = (x.oracle.incumbents || []).some((n) => UNSEEDED.has(n.name)) || (y.oracle.incumbents || []).some((n) => UNSEEDED.has(n.name));
        if (!proven || (unseededIncumbent && (x.change === 'csl' || x.change === 'csl-ppc'))) {
          excluded++;
          continue;
        }
        assert.equal(y.oracle.status, x.oracle.status, `record ${i}: oracle status`);
        assert.equal(y.oracle.fee, x.oracle.fee, `record ${i}: oracle fee`);
        compared++;
        continue;
      }
      if (UNSEEDED.has(x.method) || x.class === 'time-limit' || y.class === 'time-limit') {
        excluded++;
        continue;
      }
      assert.equal(stable(y), stable(x), `record ${i}`);
      compared++;
    }
    assert.ok(compared > a.recs.length / 2, `${compared} compared, ${excluded} excluded`);
  } finally {
    await hook.close();
    if (prev === undefined) delete process.env.RESEARCH_SIM_HOME;
    else process.env.RESEARCH_SIM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('battery: a failing wallet stops the run with its error', { skip, timeout: 5 * 60 * 1000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'research-sim-battery-parallel-'));
  const prev = process.env.RESEARCH_SIM_HOME;
  process.env.RESEARCH_SIM_HOME = home;
  try {
    const methods = [{ name: 'no-such-method', opts: [{ changePolicy: 'default' }], repetitions: 1 }];
    await assert.rejects(run('parallel-fail', 3, ['S1', 'S7', 'S8'], methods, null), /battery failed/);
  } finally {
    if (prev === undefined) delete process.env.RESEARCH_SIM_HOME;
    else process.env.RESEARCH_SIM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
