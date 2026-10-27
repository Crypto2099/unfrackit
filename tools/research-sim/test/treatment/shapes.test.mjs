// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Every transaction built on the 21 synthetic shapes builds with CSL and meets
// the ledger kit's checks, and the four negative controls are caught on each
// for its own reason; CSL reads each back to the same bytes, and the kit's
// sizes are CSL's. The transactions: the planner's plan of every shape
// under every settings variant; and every battery spend (the standard battery
// and H-10's on the observed layout, H-10's on the tidy layout) by the H-12
// rule with absorption on and off and by the test method under the
// layout-preserving, single and naive change policies. A transaction the
// treatment builds that fails either its own checks or the kit's stops the
// run (treatment/run.mjs StopPoint), so reaching the end means none did.
// Needs RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatment, skip } from '../lib/treatment.mjs';
import { negativeControls, EXPECTED } from '../lib/controls.mjs';
import { SYNTHETIC_PARAMS } from '../../src/kit/params.mjs';
import { shapeState, shapeSettings, SHAPE_NAMES, variantsOf } from '../../src/shapes/shapes.mjs';
import { planState } from '../../src/treatment/run.mjs';
import { checkAndApply } from '../../src/kit/apply.mjs';
import { inspectTx } from '../../src/kit/inspect.mjs';
import { standardBattery, h10Battery, SHAPE_POOLS } from '../../src/battery/battery.mjs';
import { balanceSuffices } from '../../src/battery/suffices.mjs';
import { runSpend } from '../../src/battery/run.mjs';
import { h12Method } from '../../src/methods/h12.mjs';
import { testLargestMethod } from '../../src/methods/test-largest.mjs';
import { settle } from '../../src/kit/heap.mjs';

const T = await treatment();
const P = SYNTHETIC_PARAMS;

test('every transaction built on the 21 shapes meets the kit\'s checks, and every negative control is caught for its own reason', { skip, timeout: 60 * 60 * 1000 }, async (t) => {
  const h12 = T && h12Method(T);
  const tm = T && testLargestMethod(T);
  const methods = T ? [[h12, { changePolicy: 'default', absorb: true }, 'h12-on'], [h12, { changePolicy: 'default', absorb: false }, 'h12-off'], [tm, { changePolicy: 'layout' }, 'test-layout'], [tm, { changePolicy: 'single' }, 'test-single'], [tm, { changePolicy: 'naive' }, 'test-naive']] : [];
  const counts = { plans: 0, planTxs: 0, spends: 0, built: 0, chains: 0, failures: {}, kitFailures: 0, unsettled: {}, txs: { plan: 0, 'chain-plan': 0, payment: 0, kit: 0 }, controls: 0, suffices: 0, sufficesErrors: {} };
  const bad = [];
  const control = (state, bytes, form) => {
    // CSL reads the transaction back to the same bytes, and the kit's sizes
    // are CSL's: the serialized length, and the ledger's size one byte less.
    const ctx = T.CSL.Transaction.from_bytes(Buffer.from(bytes, 'hex'));
    const again = Buffer.from(ctx.to_bytes()).toString('hex');
    ctx.free();
    const d = inspectTx(bytes);
    if (again !== bytes) bad.push(`${form}: CSL re-serializes the transaction differently`);
    if (d.serializedSize !== bytes.length / 2 || d.size !== d.serializedSize - 1) bad.push(`${form}: sizes ${d.size}/${d.serializedSize}`);
    const r = negativeControls(state, P, bytes);
    for (const [k, v] of Object.entries(EXPECTED)) if (r[k] !== v) bad.push(`${form}: control ${k} gave '${r[k]}'`);
    counts.controls++;
    counts.txs[form]++;
  };
  for (const name of SHAPE_NAMES) {
    await settle();
    const s = shapeState(T, name).state;
    let tidy = null;
    for (const variant of variantsOf(name)) {
      const p = planState(T, s, P, shapeSettings(name, variant));
      counts.plans++;
      let cur = s;
      for (const x of p.txs) {
        control(cur, x.bytes, 'plan');
        cur = checkAndApply(cur, P, [x]).state;
        counts.planTxs++;
      }
      if (variant === 'default') tidy = p.after;
    }
    const intents = [
      ...standardBattery(T, s, P, { pools: SHAPE_POOLS }).map((it) => [s, it]),
      ...h10Battery(T, s, P).map((it) => [s, it]),
      ...h10Battery(T, tidy, P, { observed: s }).map((it) => [tidy, it])
    ];
    for (const [state, it] of intents) {
      if (it.unsettled) {
        counts.unsettled[it.unsettled] = (counts.unsettled[it.unsettled] || 0) + 1;
        continue;
      }
      const suf = balanceSuffices(T, state, P, it).suffices;
      for (const [m, opts, label] of methods) {
        const r = await runSpend(T, { state, params: P, intent: it, method: m, opts });
        counts.spends++;
        if (suf) counts.suffices++;
        if (!r.ok) {
          const k = `${label}:${r.class}`;
          counts.failures[k] = (counts.failures[k] || 0) + 1;
          if (/^kit:/.test(r.detail)) {
            counts.kitFailures++;
            bad.push(`${name} ${it.id} ${label}: ${r.detail}`);
          }
          if (suf) counts.sufficesErrors[label] = (counts.sufficesErrors[label] || 0) + 1;
          continue;
        }
        counts.built++;
        if (r.kind === 'chain') counts.chains++;
        let cur = state;
        for (const x of r.answer.txs) {
          const form = m === tm ? 'kit' : x.source === 'plan' ? 'chain-plan' : 'payment';
          control(cur, x.bytes, form);
          cur = checkAndApply(cur, P, [x]).state;
        }
        if (m === h12) assert.equal(inspectTx(r.answer.txs[r.answer.txs.length - 1].bytes).hasAux, false, 'payments carry no auxiliary data');
      }
    }
  }
  assert.deepEqual(bad, []);
  assert.equal(counts.kitFailures, 0);
  t.diagnostic(JSON.stringify(counts));
});
