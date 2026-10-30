// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The battery runner over wallets, through the worker pool: every run of every
// method, option and repetition on every battery spend becomes a record with
// its key, "the balance suffices" flag of the layout it is made from, and the
// plan after; the H-12 rule's runs also become H-12 records; and the oracle hook is
// called once per wallet, spend and distinct change policy, with every
// method's single transaction under that policy as an incumbent. The oracle
// here is a stand-in that returns the cheapest incumbent; the study's is
// src/oracle/.
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

const T = await treatment();

test('battery runs, H-12 records and the oracle hook', { skip, timeout: 3600 * 1000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'research-sim-battery-'));
  const prev = process.env.RESEARCH_SIM_HOME;
  process.env.RESEARCH_SIM_HOME = home;
  const pool = new Pool({ treatmentDir: TREATMENT_DIR, pinsPath: process.env.RESEARCH_SIM_TREATMENT_PINS || DEFAULT_PINS, size: 2 });
  const out = new RunOutput('synthetic', 'battery-test', { command: 'test' });
  const calls = [];
  const oracle = {
    // The test method's layout change and the H-12 rule's own share the
    // oracle's 'layout' policy; the single change has none here.
    policyOf: (name, change) => (change === 'layout' || name === 'unfrackit-h12' ? 'layout' : null),
    async reference(state, intent, params, policy, { incumbents }) {
      calls.push({ utxos: state.utxos.size, spend: intent.id, policy, n: incumbents.length, names: [...new Set(incumbents.map((x) => x.name))].sort() });
      const best = incumbents.reduce((a, b) => (a && a.fee <= b.fee ? a : b), null);
      return { status: best ? 'built' : 'undecided', fee: best ? best.fee : null, from: best ? best.name : null };
    }
  };
  try {
    const methods = [
      { name: 'test-largest-first', opts: [{ changePolicy: 'layout' }, { changePolicy: 'single' }], repetitions: 2 },
      { name: 'unfrackit-h12', opts: [{ changePolicy: 'default', absorb: true }, { changePolicy: 'default', absorb: false }], repetitions: 1 }
    ];
    const totals = await runBatteries(T, pool, { wallets: ['S4', 'M8'].map((name) => ({ spec: { kind: 'shape', name, stream: null } })), methods, out, oracle });
    out.close();
    const recs = readFileSync(join(out.dir, 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const battery = recs.filter((r) => r.kind === 'battery' && r.method !== 'oracle' && r.method !== 'none');
    assert.equal(battery.length, totals.runs);
    assert.ok(battery.every((r) => typeof r.ok === 'boolean' && typeof r.suffices === 'boolean'));
    assert.deepEqual([...new Set(battery.filter((r) => r.method === 'test-largest-first').map((r) => r.repetition))].sort(), [1, 2]);
    const h12 = recs.filter((r) => r.kind === 'h12');
    assert.equal(h12.length, battery.filter((r) => r.method === 'unfrackit-h12').length);
    assert.ok(h12.some((r) => r.completed && r.tidyFee !== null));
    assert.ok(battery.filter((r) => r.ok).every((r) => r.tidyTxs !== undefined && r.measures && r.utxosAfter > 0));
    // One reference per wallet, observed spend and distinct change policy.
    const oracleRecs = recs.filter((r) => r.kind === 'battery' && r.method === 'oracle');
    assert.equal(oracleRecs.length, calls.length);
    assert.equal(totals.oracle, calls.length);
    assert.deepEqual([...new Set(calls.map((c) => c.policy))], ['layout']);
    assert.ok(calls.every((c) => c.utxos > 0));
    assert.ok(calls.every((c) => !c.spend.startsWith('h10-')), 'the oracle prices the standard battery only');
    assert.ok(battery.some((r) => r.spend.startsWith('h10-')), 'H-10 spends run under the test methods');
    assert.ok(calls.some((c) => c.names.join() === 'test-largest-first,unfrackit-h12'), 'two selectors sharing a policy share one reference');
    assert.ok(calls.some((c) => c.n >= 4), 'both repetitions and both absorption settings are incumbents');
    // Timings are kept apart from the records.
    assert.ok(battery.every((r) => r.ms === undefined));
    const timings = readFileSync(join(out.dir, 'timings.jsonl'), 'utf8').trim().split('\n');
    assert.ok(timings.length >= battery.length);
  } finally {
    await pool.close();
    if (prev === undefined) delete process.env.RESEARCH_SIM_HOME;
    else process.env.RESEARCH_SIM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
