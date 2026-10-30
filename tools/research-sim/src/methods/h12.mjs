// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// UnFrack.It's H-12 selection rule as a method: the treatment's select()
// (select2.mjs), its transactions built and checked by the treatment
// (treatment/run.mjs selectState). The rule's request carries only requested
// outputs ({ address, coin, tokens }), so it serves the batteries: an intent
// with implicit values, fixed parts, or a requested output carrying a datum or
// a script reference is not replayable by it. It makes its own change (the
// layout-preserving change) and its chained plans, and is deterministic: one
// run per wallet, spend and absorption setting.
//
// The rule's errors are mapped to the failure classes:
//   insufficient-assets              balance
//   insufficient-ada                 balance, or change-minimum when every
//                                    spendable UTxO together leaves change
//                                    under the pure-ADA minimum
//   payment-output-too-large         value-size
//   payment-too-large                tx-size
//   payment-unbuildable              tx-size (one transaction cannot carry it
//                                    and the planner proposes none)
//   unbuildable-after-consolidation  tx-size (no prefix of the plan leaves a
//                                    wallet that pays in one transaction)
//   bad-request, payment-output-below-minimum, change-policy-not-implemented,
//   settings-not-supported           other

import { selectState } from '../treatment/run.mjs';
import { CLASSES } from '../kit/check.mjs';
import { NOT_REPLAYABLE } from './contract.mjs';

export const H12_ERROR_CLASSES = Object.freeze({
  'insufficient-assets': CLASSES.balance,
  'insufficient-ada': CLASSES.balance,
  'payment-output-too-large': CLASSES.valueSize,
  'payment-too-large': CLASSES.txSize,
  'payment-unbuildable': CLASSES.txSize,
  'unbuildable-after-consolidation': CLASSES.txSize,
  'bad-request': CLASSES.other,
  'payment-output-below-minimum': CLASSES.other,
  'change-policy-not-implemented': CLASSES.other,
  'settings-not-supported': CLASSES.other
});

export function classOfH12Error(error, detail) {
  if (error === 'insufficient-ada' && /^change .* under the pure-ADA minimum/.test(detail)) return CLASSES.changeMinimum;
  const c = H12_ERROR_CLASSES[error];
  if (!c) throw new Error(`the H-12 rule returned an unknown error ${error}`);
  return c;
}

// The request the rule takes, or null when the intent cannot be expressed.
export function h12Request(intent) {
  if (intent.source === 'replay') return null;
  if (intent.fixed || intent.collateral.required) return null;
  const imp = intent.implicit;
  if (imp.withdrawals || imp.refunds || imp.deposits || imp.donation || imp.mint.length || imp.burn.length) return null;
  if (intent.requested.some((o) => o.datum || o.scriptRef)) return null;
  return { outputs: intent.requested.map((o) => ({ address: o.address, coin: o.coin, tokens: o.assets.map((a) => ({ policy: a.policy, name: a.name, qty: a.qty })) })) };
}

// settings: the planner settings the rule runs with (the planner's defaults
// in the study; a shape's own in the comparison with the treatment's runner).
export function h12Method(T, { settings = {} } = {}) {
  return {
    name: 'unfrackit-h12',
    version: `select2.mjs ${T.pins.get('select2.mjs').slice(0, 16)}`,
    deterministic: true,
    seeded: true,
    build(state, intent, params, opts) {
      if (opts.changePolicy !== 'default') return { ok: false, class: CLASSES.other, detail: 'the H-12 rule makes its own change' };
      const request = h12Request(intent);
      if (!request) return { ok: false, class: NOT_REPLAYABLE, detail: 'the rule\'s request carries only requested outputs' };
      const r = selectState(T, state, request, params, { absorb: opts.absorb, settings });
      if (!r.ok) return { ok: false, class: classOfH12Error(r.result.error, r.result.detail), detail: `${r.result.error}: ${r.result.detail}`, error: r.result.error };
      return {
        ok: true,
        kind: r.result.kind,
        txs: r.txs.map((t) => ({ bytes: t.bytes, walletInputs: t.walletInputs, fee: t.fee, size: t.size, k: t.k, roles: t.roles, source: t.source })),
        treatment: { payment: r.result.payment, notes: r.result.txs[r.result.payment.index].notes, ms: r.result.ms }
      };
    }
  };
}
