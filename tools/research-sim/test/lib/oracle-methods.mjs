// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The methods whose transactions seed the oracle in its tests, per change
// policy: for the layout-preserving change, the H-12 rule with absorption on
// and off (its single-transaction answers) and the test method; for
// cardano-serialization-lib's change, the csl-lf and csl-ri adapters (with
// prefer_pure_change for csl-ppc) when their module is present, or else the
// library selecting on its own (test/lib/csl-select.mjs); for cardano-js-sdk's
// change, the cjs-rrri adapter at seeds 1 to 3; for the Evolution SDK's, the
// evo-lf adapter. Every answer is checked by the ledger kit and carries its
// method's `seeded` flag (methods/contract.mjs); only those that pass, by a
// method the oracle's incumbents rule admits, are incumbents. csl-ri and
// csl-ri-pure draw from a generator no caller can seed, so under the default
// rule their answers are kept apart.

import { h12Method } from '../../src/methods/h12.mjs';
import { testLargestMethod } from '../../src/methods/test-largest.mjs';
import { checkAndApply } from '../../src/kit/apply.mjs';
import { ORACLE_SETTINGS, admitsIncumbent } from '../../src/oracle/settings.mjs';
import { cslSelect } from './csl-select.mjs';

const optional = async (path) => {
  try {
    return await import(path);
  } catch {
    return null;
  }
};
const CJS_SEEDS = [1, 2, 3];

export async function methodAnswers(T, state, spend, params, policy) {
  const out = [];
  const add = (name, r, seeded) => {
    if (typeof seeded !== 'boolean') throw new Error(`${name}: no seeded flag`);
    if (!r.ok) {
      out.push({ name, seeded, ok: false, class: r.class, detail: r.detail });
      return;
    }
    const k = checkAndApply(state, params, [{ bytes: r.bytes, walletInputs: r.walletInputs }], { implicit: spend.implicit });
    out.push({ name, seeded, ok: true, kitOk: k.ok, kitFailure: k.ok ? null : k.failure, bytes: r.bytes, walletInputs: r.walletInputs, fee: r.fee });
  };
  if (policy === 'layout') {
    const h12 = h12Method(T);
    for (const absorb of [true, false]) {
      const r = await h12.build(state, spend, params, { changePolicy: 'default', absorb });
      const name = absorb ? 'h12-on' : 'h12-off';
      if (r.ok && r.kind !== 'single') out.push({ name, seeded: h12.seeded, ok: false, class: 'chain', detail: 'answered with a chain' });
      else add(name, r.ok ? { ok: true, bytes: r.txs[0].bytes, walletInputs: r.txs[0].walletInputs, fee: r.txs[0].fee } : r, h12.seeded);
    }
    const tm = testLargestMethod(T);
    const r = await tm.build(state, spend, params, { changePolicy: 'layout' });
    add('test-largest', r.ok ? { ok: true, bytes: r.txs[0].bytes, walletInputs: r.txs[0].walletInputs, fee: r.txs[0].fee } : r, tm.seeded);
  } else if (policy === 'csl' || policy === 'csl-ppc') {
    const preferPure = policy === 'csl-ppc';
    const csl = await optional('../../src/methods/csl.mjs');
    for (const strategy of ['lf', 'ri']) {
      const name = `csl-${strategy}${preferPure ? '-pure' : ''}`;
      if (csl) {
        const m = csl.cslMethod(T, { strategy, preferPureChange: preferPure });
        const r = await m.build(state, spend, params, { changePolicy: 'default' });
        add(name, r.ok ? { ok: true, bytes: r.txs[0].bytes, walletInputs: r.txs[0].walletInputs, fee: r.txs[0].fee } : r, m.seeded);
      } else add(`${name}-standin`, cslSelect(T, state, spend, params, { strategy, preferPure }), strategy === 'lf');
    }
  } else if (policy === 'cjs') {
    const { cjsMethod } = await import('../../src/methods/cjs.mjs');
    const m = cjsMethod(T);
    for (const seed of CJS_SEEDS) {
      const r = await m.build(state, spend, params, { changePolicy: 'default', seed });
      add(`cjs-rrri-${seed}`, r.ok ? { ok: true, bytes: r.txs[0].bytes, walletInputs: r.txs[0].walletInputs, fee: r.txs[0].fee } : r, m.seeded);
    }
  } else if (policy === 'evo') {
    const { evoMethod } = await import('../../src/methods/evo.mjs');
    const m = evoMethod();
    const r = await m.build(state, spend, params, { changePolicy: 'default' });
    add('evo-lf', r.ok ? { ok: true, bytes: r.txs[0].bytes, walletInputs: r.txs[0].walletInputs, fee: r.txs[0].fee } : r, m.seeded);
  }
  return out;
}

// Whether an answer may be an incumbent under the settings' incumbents rule.
export const admitted = (a, settings = ORACLE_SETTINGS) => admitsIncumbent(settings, a);
// The incumbents of an oracle run: every answer that passed the kit, by a
// method the incumbents rule admits.
export const incumbentsOf = (answers, settings = ORACLE_SETTINGS) => answers.filter((a) => a.ok && a.kitOk && admitted(a, settings)).map((a) => ({ name: a.name, seeded: a.seeded, walletInputs: a.walletInputs, bytes: a.bytes, fee: a.fee }));
