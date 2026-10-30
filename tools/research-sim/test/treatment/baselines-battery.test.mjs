// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Every baseline on every battery spend of the 21 synthetic shapes (the
// standard battery and H-10's on the observed layout, H-10's on the tidy
// layout), at its default change and, for csl-lf, csl-ri and cjs-rrri, under
// each simulator-owned change policy: every transaction an adapter builds
// either meets the ledger kit's checks or fails one with its class, every
// refusal carries a class, and the kit's four negative controls are caught on
// every built transaction in the library's own encoding. A transaction whose
// fee is under the ledger minimum is classed fee-minimum, apart from balance. Alongside: whether
// cardano-js-sdk's callbacks are exact (the fee the library was given against
// the minimum of the transaction finally assembled, and the bundle-size
// callback against the kit's value-size check on every change output), and
// the build time per adapter and spend on M2, M3 and E1 with the process's
// memory. Needs RESEARCH_SIM_TREATMENT_DIR; RESEARCH_SIM_OUT may name a
// directory for the summary as JSON.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { treatment, skip } from '../lib/treatment.mjs';
import { negativeControls, EXPECTED } from '../lib/controls.mjs';
import { SYNTHETIC_PARAMS as P } from '../../src/kit/params.mjs';
import { shapeState, SHAPE_NAMES } from '../../src/shapes/shapes.mjs';
import { planState } from '../../src/treatment/run.mjs';
import { checkAndApply } from '../../src/kit/apply.mjs';
import { inspectTx } from '../../src/kit/inspect.mjs';
import { valueSize } from '../../src/history/value.mjs';
import { addressTextOf } from '../../src/state/utxo.mjs';
import { standardBattery, h10Battery, SHAPE_POOLS } from '../../src/battery/battery.mjs';
import { settle } from '../../src/kit/heap.mjs';
import { cslMethod } from '../../src/methods/csl.mjs';
import { cjsMethod } from '../../src/methods/cjs.mjs';
import { evoMethod } from '../../src/methods/evo.mjs';
import { CLASSES } from '../../src/kit/check.mjs';

const T = await treatment();
const MAX_U64 = 18446744073709551615n;
const TIMED = new Set(['M2', 'M3', 'E1']);

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

test('every baseline on the battery spends of the 21 shapes', { skip, timeout: 3 * 60 * 60 * 1000 }, async (t) => {
  const lf = cslMethod(T, { strategy: 'lf' });
  const ri = cslMethod(T, { strategy: 'ri' });
  const configs = [
    [lf, 'default'], [ri, 'default'], [cslMethod(T, { strategy: 'lf', preferPureChange: true }), 'default'], [cslMethod(T, { strategy: 'ri', preferPureChange: true }), 'default'],
    [cjsMethod(T), 'default'], [evoMethod(), 'default'],
    ...['layout', 'single', 'naive'].flatMap((p) => [[lf, p], [ri, p], [cjsMethod(T), p]])
  ];
  const label = ([m, p]) => (p === 'default' ? m.name : `${m.name}/${p}`);
  const summary = { spends: 0, unsettled: 0, configs: {}, others: [], kitFailures: [], feeUnderMinimum: [], controls: { checked: 0, bad: [] }, cjs: { selections: 0, feeEqual: 0, feeUnder: [], feeOver: [], bundles: 0, bundleAgree: 0, bundleDisagree: [] }, timing: {}, memory: {} };
  for (const c of configs) summary.configs[label(c)] = { built: 0, kitPass: 0, kitFail: {}, failed: {} };
  for (const name of SHAPE_NAMES) {
    await settle();
    const s = shapeState(T, name).state;
    const tidy = planState(T, s, P, {}).after;
    const intents = [
      ...standardBattery(T, s, P, { pools: SHAPE_POOLS }).map((it) => [s, it]),
      ...h10Battery(T, s, P).map((it) => [s, it]),
      ...h10Battery(T, tidy, P, { observed: s }).map((it) => [tidy, it])
    ];
    for (const [state, it] of intents) {
      if (it.unsettled) {
        summary.unsettled++;
        continue;
      }
      summary.spends++;
      for (const c of configs) {
        const [m, policy] = c;
        const L = label(c);
        const rec = summary.configs[L];
        await settle();
        const t0 = performance.now();
        let r;
        try {
          r = await m.build(state, it, P, { changePolicy: policy, seed: 1 });
        } catch (e) {
          r = { ok: false, class: 'other', detail: `exception: ${e.message}` };
        }
        const ms = performance.now() - t0;
        if (TIMED.has(name) && state === s) {
          const k = `${name} ${L}`;
          (summary.timing[k] = summary.timing[k] || []).push(ms);
        }
        if (!r.ok) {
          rec.failed[r.class] = (rec.failed[r.class] || 0) + 1;
          if (r.class === 'other') summary.others.push(`${name} ${it.id} ${L}: ${r.detail}`);
          continue;
        }
        rec.built++;
        const k = checkAndApply(state, P, r.txs, { implicit: it.implicit });
        if (k.ok) rec.kitPass++;
        else {
          rec.kitFail[k.failure.cls] = (rec.kitFail[k.failure.cls] || 0) + 1;
          summary.kitFailures.push(`${name} ${it.id} ${L}: ${k.failure.check}: ${k.failure.detail}`);
          if (k.failure.check === 'fee') summary.feeUnderMinimum.push({ spend: `${name} ${it.id} ${L}`, class: k.failure.cls });
        }
        if (k.ok) {
          const ctl = negativeControls(state, P, r.txs[0].bytes);
          summary.controls.checked++;
          for (const [kk, v] of Object.entries(EXPECTED)) if (ctl[kk] !== v) summary.controls.bad.push(`${name} ${it.id} ${L}: ${kk} gave '${ctl[kk]}'`);
        }
        if (m.name === 'cjs-rrri' && policy === 'default') {
          const j = summary.cjs;
          j.selections++;
          const lib = r.library;
          if (lib.fee === lib.finalMinFee) j.feeEqual++;
          else (lib.fee < lib.finalMinFee ? j.feeUnder : j.feeOver).push(`${name} ${it.id}: fee ${lib.fee}, minimum ${lib.finalMinFee}`);
          const tx = inspectTx(r.txs[0].bytes);
          for (const o of tx.outputs.slice(it.requested.length)) {
            if (addressTextOf(o.address) !== state.changeAddress || !o.assets.length) continue;
            j.bundles++;
            const callback = valueSize(MAX_U64, o.assets) > P.maxValSize;
            const kit = valueSize(o.coin, o.assets) > P.maxValSize;
            if (callback === kit) j.bundleAgree++;
            else j.bundleDisagree.push(`${name} ${it.id}: callback ${callback}, kit ${kit}, ${valueSize(o.coin, o.assets)} bytes`);
          }
        }
      }
    }
    const mem = process.memoryUsage();
    summary.memory[name] = { rssMiB: Math.round(mem.rss / 1048576), heapMiB: Math.round(mem.heapUsed / 1048576) };
  }
  const timing = {};
  for (const [k, xs] of Object.entries(summary.timing)) timing[k] = { n: xs.length, medianMs: Math.round(median(xs)), maxMs: Math.round(Math.max(...xs)) };
  summary.timing = timing;
  const out = JSON.stringify(summary, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1);
  if (process.env.RESEARCH_SIM_OUT) writeFileSync(join(process.env.RESEARCH_SIM_OUT, 'baselines-battery.json'), out);
  t.diagnostic(out);
  assert.deepEqual(summary.controls.bad, []);
  assert.deepEqual(summary.cjs.bundleDisagree, []);
  assert.deepEqual(summary.feeUnderMinimum.filter((f) => f.class !== CLASSES.feeMinimum), []);
  for (const [L, rec] of Object.entries(summary.configs)) assert.equal(rec.built, rec.kitPass + Object.values(rec.kitFail).reduce((a, b) => a + b, 0), L);
});

test('determinism: csl-lf and evo-lf repeat byte for byte, cjs-rrri repeats per seed and varies across seeds, csl-ri varies across runs', { skip, timeout: 60 * 60 * 1000 }, async (t) => {
  const shapes = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'M1', 'M4', 'M7', 'M8', 'CL1', 'CL3', 'E1', 'E2'];
  const lf = cslMethod(T, { strategy: 'lf' });
  const ri = cslMethod(T, { strategy: 'ri' });
  const cjs = cjsMethod(T);
  const evo = evoMethod();
  const key = (r) => (r.ok ? r.txs.map((x) => x.bytes).join(',') : `fail:${r.class}`);
  const n = { spends: 0, lfSame: 0, evoSame: 0, cjsSame: 0, cjsSeedsDiffer: 0, riDiffer: 0 };
  for (const name of shapes) {
    await settle();
    const s = shapeState(T, name).state;
    for (const it of [...standardBattery(T, s, P, { pools: SHAPE_POOLS }), ...h10Battery(T, s, P)]) {
      if (it.unsettled) continue;
      n.spends++;
      const o = { changePolicy: 'default' };
      if (key(await lf.build(s, it, P, o)) === key(await lf.build(s, it, P, o))) n.lfSame++;
      if (key(await evo.build(s, it, P, o)) === key(await evo.build(s, it, P, o))) n.evoSame++;
      const a = key(await cjs.build(s, it, P, { ...o, seed: 1 }));
      if (a === key(await cjs.build(s, it, P, { ...o, seed: 1 }))) n.cjsSame++;
      if (a !== key(await cjs.build(s, it, P, { ...o, seed: 2 }))) n.cjsSeedsDiffer++;
      const runs = new Set();
      for (let i = 0; i < 5; i++) runs.add(key(await ri.build(s, it, P, o)));
      if (runs.size > 1) n.riDiffer++;
    }
  }
  t.diagnostic(JSON.stringify(n));
  assert.equal(n.lfSame, n.spends);
  assert.equal(n.evoSame, n.spends);
  assert.equal(n.cjsSame, n.spends);
  assert.ok(n.cjsSeedsDiffer > 0);
  assert.ok(n.riDiffer > 0);
});
