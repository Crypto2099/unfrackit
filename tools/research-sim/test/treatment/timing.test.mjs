// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Timing and memory of the work one worker thread does, on the shapes M2 and
// M3 (3,005 UTxOs each) and E1 (405): the planner's plan with its build and
// checks, the whole battery at the snapshot (the H-12 rule with absorption on
// and the test method with the layout-preserving change, each spend followed
// by the plan after it), and a replay of the shape's synthetic stream in the
// maintained-tidy arm. Each is reported as a diagnostic; the test asserts
// only that memory stops growing once the heap is settled: over ten further
// replays, the last five add at most 64 MiB of resident memory.
// Needs RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatment, skip } from '../lib/treatment.mjs';
import { loadSource } from '../../src/replay/source.mjs';
import { replay } from '../../src/replay/engine.mjs';
import { makeMethod } from '../../src/methods/registry.mjs';
import { planState } from '../../src/treatment/run.mjs';
import { makeState } from '../../src/state/state.mjs';
import { batterySpends } from '../../src/battery/runner-core.mjs';
import { runSpend } from '../../src/battery/run.mjs';
import { SHAPE_POOLS } from '../../src/battery/battery.mjs';
import { settle } from '../../src/kit/heap.mjs';

const T = await treatment();
const MiB = 2 ** 20;
const mem = () => {
  const u = process.memoryUsage();
  return { rss: Math.round(u.rss / MiB), heap: Math.round(u.heapUsed / MiB) };
};
const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

test('a plan, a battery and a replay on M2, M3 and E1, with memory', { skip, timeout: 3 * 3600 * 1000 }, async (t) => {
  const test = makeMethod(T, 'test-largest-first');
  const h12 = makeMethod(T, 'unfrackit-h12');
  const rows = [];
  for (const name of ['M2', 'M3', 'E1']) {
    const src = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const state = makeState({ network: src.network, stakeCred: src.stakeCred, changeAddress: src.changeAddress, utxos: src.start });
    const row = { shape: name, utxos: src.start.length, before: mem() };
    const plans = [];
    for (let i = 0; i < 5; i++) {
      await settle();
      const t0 = performance.now();
      planState(T, state, src.params, {});
      plans.push(performance.now() - t0);
    }
    row.planMs = { first: Math.round(plans[0]), median: Math.round(median(plans.slice(1))) };
    const { spends, observed, tidy } = batterySpends(T, src, src.params, { pools: SHAPE_POOLS });
    const per = [];
    const t1 = performance.now();
    for (const s of spends) {
      if (!s.intent) continue;
      for (const [m, opts] of [[h12, { changePolicy: 'default', absorb: true }], [test, { changePolicy: 'layout' }]]) {
        const st = s.layout === 'observed' ? observed : tidy;
        const t0 = performance.now();
        await runSpend(T, { state: st, params: src.params, intent: s.intent, method: m, opts });
        per.push(performance.now() - t0);
      }
    }
    row.battery = { runs: per.length, totalS: Math.round((performance.now() - t1) / 100) / 10, medianMs: Math.round(median(per)) };
    await settle();
    const t2 = performance.now();
    const r = await replay(T, src.params, src, { arm: 'maintained-tidy', variant: 'default', repetition: 1, method: test, opts: { seed: 1, changePolicy: 'default', collateralRule: 'ledger' }, settleEvery: 25 });
    row.replay = { intents: r.summary.counts.intents, plans: r.plans.length, s: Math.round((performance.now() - t2) / 100) / 10 };
    row.after = mem();
    rows.push(row);
    t.diagnostic(JSON.stringify(row));
  }
  // Growth over repeated replays of the largest shape, the heap settled.
  const src = loadSource(T, { kind: 'shape', name: 'M3', stream: 'synthetic' });
  const rss = [];
  for (let i = 0; i < 10; i++) {
    await replay(T, src.params, src, { arm: 'maintained-tidy', variant: 'default', repetition: 1, method: test, opts: { seed: 1, changePolicy: 'default', collateralRule: 'ledger' }, settleEvery: 25 });
    await settle();
    rss.push(mem().rss);
  }
  t.diagnostic(`resident memory over ten M3 replays (MiB): ${rss.join(', ')}`);
  assert.ok(rss[9] - rss[4] <= 64, `memory grew ${rss[9] - rss[4]} MiB over the last five replays`);
});
