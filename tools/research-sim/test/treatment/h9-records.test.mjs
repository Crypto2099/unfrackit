// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// What H-9's cost contrast reads, on two shapes' synthetic streams with the
// cardano-js-sdk selector H-9 runs: the tidy-once arm with layout-preserving
// change and the maintained-tidy arm with the selector's default change.
//   - the same repetition gives the same intent, type and t sequence in both
//     arms (a spend record's `intent` names the same observed intent);
//   - every built spend is one transaction, so `walletFee` is the spend's;
//   - the two arms' start plan records are equal;
//   - the plan records carry `at` and `fee`, a refused mark plan `refused`
//     and no fee, and the restoring plan's fee is `conformity.fee`;
//   - the window-end conformity carries the share for every arm, and the
//     observed arm of a fragmented shape is below 1;
//   - the per-wallet, per-seed contrast is computable from the records alone.
// The records are the fields runReplays writes (run.mjs): the engine's spends,
// plans and summary. Needs RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatment, skip } from '../lib/treatment.mjs';
import { loadSource } from '../../src/replay/source.mjs';
import { replay } from '../../src/replay/engine.mjs';
import { makeMethod } from '../../src/methods/registry.mjs';
import { windowPlan, mergePlan } from '../../src/arms/plan.mjs';
import { settle } from '../../src/kit/heap.mjs';

const T = await treatment();
const SHAPES = ['S7', 'M1'];
const REPS = [1, 2];

const sum = (xs) => xs.reduce((a, b) => a + b, 0n);

// R9 for one wallet and seed from the two arms' records, as the decided rule
// reads them: layout = tidy-once with layout change, maintained = the
// maintained-tidy arm with default change.
export function contrast(layout, maintained) {
  const lbuilt = new Map(layout.spends.filter((s) => s.outcome === 'built').map((s) => [s.intent, s]));
  const mbuilt = new Map(maintained.spends.filter((s) => s.outcome === 'built').map((s) => [s.intent, s]));
  const both = [...lbuilt.keys()].filter((i) => mbuilt.has(i));
  const oneArm = { layoutOnly: {}, maintainedOnly: {} };
  const classOf = (s) => (s ? (s.outcome === 'failed' ? `failed:${s.class}` : s.outcome) : 'missing');
  const lspend = new Map(layout.spends.map((s) => [s.intent, s]));
  const mspend = new Map(maintained.spends.map((s) => [s.intent, s]));
  for (const i of lbuilt.keys()) if (!mbuilt.has(i)) oneArm.layoutOnly[classOf(mspend.get(i))] = (oneArm.layoutOnly[classOf(mspend.get(i))] || 0) + 1;
  for (const i of mbuilt.keys()) if (!lbuilt.has(i)) oneArm.maintainedOnly[classOf(lspend.get(i))] = (oneArm.maintainedOnly[classOf(lspend.get(i))] || 0) + 1;
  const spendsL = sum(both.map((i) => lbuilt.get(i).walletFee));
  const spendsM = sum(both.map((i) => mbuilt.get(i).walletFee));
  const c = layout.summary.conformity;
  const restoring = c.refused || c.noChangeAddress ? null : c.fee;
  const markPlans = maintained.plans.filter((p) => p.at.startsWith('mark') && p.fee !== undefined);
  const cLayout = restoring === null ? null : spendsL + restoring;
  const cMaintained = spendsM + sum(markPlans.map((p) => p.fee));
  return { both: both.length, spendsL, spendsM, restoring, cLayout, cMaintained, tidyPlansMaintained: markPlans.length, refusedMarks: maintained.plans.filter((p) => p.refused).length, r9: cLayout === null || cMaintained === 0n ? null : Number(cLayout) / Number(cMaintained) - 1, ...oneArm };
}

test('H-9\'s cost contrast is computable from the records, and each part it reads is in place', { skip, timeout: 30 * 60 * 1000 }, async () => {
  const method = makeMethod(T, 'cjs-rrri');
  const seen = { replays: 0, builtSpends: 0, contrasts: [], refusedEnd: 0, noShareFields: 0 };
  for (const name of SHAPES) {
    const src = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    for (const rep of REPS) {
      await settle();
      const run = async (arm, change) => {
        seen.replays++;
        const r = await replay(T, src.params, src, { arm, variant: 'default', repetition: rep, method, opts: { seed: rep, changePolicy: change, collateralRule: 'ledger' }, settleEvery: 25 });
        assert.ok(!r.refused, `${name} ${arm}/${change}: ${r.refused}`);
        return r;
      };
      const L = await run('tidy-once', 'layout');
      const D = await run('tidy-once', 'default');
      const M = await run('maintained-tidy', 'default');
      const O = await run('observed', 'default');
      const label = `${name} rep ${rep}`;

      // Pairing.
      const seq = (r) => r.spends.map((s) => `${s.intent}|${s.type}|${s.t}`).join();
      assert.equal(seq(L), seq(M), `${label}: intent sequence, layout vs maintained`);
      assert.equal(seq(L), seq(D), `${label}: intent sequence, layout vs default change`);
      assert.equal(seq(L), seq(O), `${label}: intent sequence, layout vs observed`);

      // One transaction per built spend; walletFee is then the spend's.
      for (const r of [L, M]) for (const s of r.spends) if (s.outcome === 'built') {
        seen.builtSpends++;
        assert.equal(s.txs, 1, `${label}: a built spend of ${s.intent} has ${s.txs} transactions`);
      }

      // The shared start plan.
      const start = (r) => r.plans.filter((p) => p.at === 'start').map((p) => JSON.stringify({ txs: p.txs, fee: String(p.fee), size: p.size, utxosAfter: p.utxosAfter }));
      assert.equal(start(L).length, 1);
      assert.deepEqual(start(L), start(M), `${label}: start plans differ`);
      assert.deepEqual(start(L), start(D));

      // Plan records.
      for (const p of M.plans) {
        assert.ok(p.at === 'start' || /^mark \d+$/.test(p.at), `${label}: plan at ${p.at}`);
        if (p.refused !== undefined) assert.equal(p.fee, undefined);
        else assert.equal(typeof p.fee, 'bigint');
      }
      assert.deepEqual(M.plans.filter((p) => p.at !== 'start').map((p) => p.at), ['mark 1', 'mark 2'].slice(0, M.plans.length - 1));

      // The window-end record, every arm.
      for (const [arm, r] of [['tidy-once/layout', L], ['tidy-once/default', D], ['maintained-tidy', M], ['observed', O]]) {
        const c = r.summary.conformity;
        for (const k of ['tokenUtxos', 'conforming', 'conformingNoCoin']) {
          if (!Number.isInteger(c[k])) seen.noShareFields++;
        }
        assert.ok(c.conforming <= c.conformingNoCoin && c.conformingNoCoin <= c.tokenUtxos, `${label} ${arm}: ${JSON.stringify(c, (_, v) => (typeof v === "bigint" ? String(v) : v))}`);
        if (c.refused) seen.refusedEnd++;
      }
      assert.equal(seen.noShareFields, 0);
      const oc = O.summary.conformity;
      if (name === 'S7') assert.ok(oc.conforming < oc.tokenUtxos, `${label}: the observed arm's share is ${oc.conforming} of ${oc.tokenUtxos}`);

      const c = contrast(L, M);
      assert.ok(c.both > 0, `${label}: no spend built in both arms`);
      seen.contrasts.push({ label, ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === 'bigint' ? String(v) : v])) });
    }
  }
  console.log(JSON.stringify(seen));
});

test('the maintained-tidy default entry names H-9 and the replay plan keeps its job count', () => {
  const entries = mergePlan(windowPlan('recent'));
  const m = entries.find((e) => e.arm === 'maintained-tidy' && e.variant === 'default' && e.role === 'rrri' && e.change === 'default');
  assert.deepEqual([...m.hypotheses].sort(), ['H-1', 'H-6', 'H-9']);
  assert.equal(m.repetitions, 30);
  assert.equal(entries.length, 66);
  assert.equal(entries.filter((e) => e.hypotheses.includes('H-9')).length, 3);
});
