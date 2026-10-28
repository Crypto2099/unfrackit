// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The methods whose transactions seed the oracle in its tests, per change
// policy, until the baseline adapters exist: for the layout-preserving
// change, the H-12 rule with absorption on and off (its single-transaction
// answers) and the test method; for cardano-serialization-lib's change, the
// library selecting on its own (test/lib/csl-select.mjs) with both of its
// multi-asset strategies, with and without prefer_pure_change. Every answer
// is checked by the ledger kit; only those that pass are incumbents.

import { h12Method } from '../../src/methods/h12.mjs';
import { testLargestMethod } from '../../src/methods/test-largest.mjs';
import { checkAndApply } from '../../src/kit/apply.mjs';
import { cslSelect } from './csl-select.mjs';

export const POLICY_METHODS = Object.freeze({
  layout: ['h12-on', 'h12-off', 'test-largest'],
  csl: ['csl-lf', 'csl-ri'],
  'csl-ppc': ['csl-lf-pure', 'csl-ri-pure']
});

export async function methodAnswers(T, state, spend, params, policy) {
  const out = [];
  const add = (name, r) => {
    if (!r.ok) {
      out.push({ name, ok: false, class: r.class, detail: r.detail });
      return;
    }
    const k = checkAndApply(state, params, [{ bytes: r.bytes, walletInputs: r.walletInputs }], { implicit: spend.implicit });
    out.push({ name, ok: true, kitOk: k.ok, kitFailure: k.ok ? null : k.failure, bytes: r.bytes, walletInputs: r.walletInputs, fee: r.fee });
  };
  if (policy === 'layout') {
    const h12 = h12Method(T);
    for (const absorb of [true, false]) {
      const r = await h12.build(state, spend, params, { changePolicy: 'default', absorb });
      const name = absorb ? 'h12-on' : 'h12-off';
      if (r.ok && r.kind !== 'single') out.push({ name, ok: false, class: 'chain', detail: 'answered with a chain' });
      else add(name, r.ok ? { ok: true, bytes: r.txs[0].bytes, walletInputs: r.txs[0].walletInputs, fee: r.txs[0].fee } : r);
    }
    const tm = testLargestMethod(T);
    const r = await tm.build(state, spend, params, { changePolicy: 'layout' });
    add('test-largest', r.ok ? { ok: true, bytes: r.txs[0].bytes, walletInputs: r.txs[0].walletInputs, fee: r.txs[0].fee } : r);
  } else {
    const preferPure = policy === 'csl-ppc';
    for (const strategy of ['lf', 'ri']) add(`csl-${strategy}${preferPure ? '-pure' : ''}`, cslSelect(T, state, spend, params, { strategy, preferPure }));
  }
  return out;
}

// The incumbents of an oracle run: every answer that passed the kit.
export const incumbentsOf = (answers) => answers.filter((a) => a.ok && a.kitOk).map((a) => ({ name: a.name, walletInputs: a.walletInputs, bytes: a.bytes, fee: a.fee }));
