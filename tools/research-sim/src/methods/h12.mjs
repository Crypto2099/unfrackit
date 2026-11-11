// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// UnFrack.It's H-12 selection rule as a method: the treatment's select()
// (select2.mjs), its transactions built and checked by the treatment
// (treatment/run.mjs selectState). It makes its own change (the
// layout-preserving change) and its chained plans, and is deterministic: one
// run per wallet, spend and absorption setting.
//
// The rule's request (select2.mjs states it). A battery spend's carries its
// requested outputs ({ address, coin, tokens }) and nothing else, as it
// always has. A replayed intent's carries every part the intent holds, and
// the rule takes each into its selection, size and fee:
//   outputs     each requested output with its own bytes (cbor), so a datum,
//               a script reference and a coin raised to its minimum pass
//               through, sized and given their minimum as those bytes
//   fixed       the intent's fixed inputs (always spent, their value counting
//               toward the payment), reference inputs, body fields, witness-
//               set entries, redeemers with the input each spend redeemer
//               points at, auxiliary data and script fee, each as the intent
//               holds it, and the signers: the keys the wallet's synthetic
//               witnesses stand for besides its selected inputs' and the
//               collateral's (kit/replay.mjs replayWitnessKeys: the wallet
//               keys of its held fixed inputs and the required signers no
//               fixed witness signs)
//   implicit    withdrawals, refunds, deposits, the donation, mints and burns
//   collateral  for a script spend, the UTxO the engine set aside
//               (opts.collateral), which the state the rule selects from no
//               longer holds
// So it covers every replay part (methods/library.mjs REPLAY_COVERAGE). An
// intent the kit cannot write (kit/replay.mjs replayRefusal: body field 6) is
// not replayable for it, as for every method.
//
// The rule's errors are mapped to the failure classes:
//   insufficient-assets              balance
//   insufficient-ada                 balance, or change-minimum when every
//                                    spendable UTxO together leaves change
//                                    under the pure-ADA minimum
//   payment-output-too-large         value-size
//   payment-too-large                tx-size (the requested outputs and a
//                                    replayed spend's fixed parts with one
//                                    input do not fit one transaction)
//   payment-unbuildable              tx-size (one transaction cannot carry it
//                                    and the planner proposes none)
//   unbuildable-after-consolidation  tx-size (no prefix of the plan leaves a
//                                    wallet that pays in one transaction)
//   collateral-insufficient          collateral (the UTxO set aside cannot
//                                    carry the total collateral of the
//                                    payment's fee)
//   bad-request, payment-output-below-minimum, change-policy-not-implemented,
//   settings-not-supported           other

import { selectState } from '../treatment/run.mjs';
import { CLASSES } from '../kit/check.mjs';
import { NOT_REPLAYABLE } from './contract.mjs';
import { REPLAY_COVERAGE, refuseUncovered, partsOf } from './library.mjs';
import { replayRefusal, replayWitnessKeys, fixedInputValues } from '../kit/replay.mjs';
import { fixedExtraWitnesses } from '../replay/engine.mjs';

export const H12_ERROR_CLASSES = Object.freeze({
  'insufficient-assets': CLASSES.balance,
  'insufficient-ada': CLASSES.balance,
  'payment-output-too-large': CLASSES.valueSize,
  'payment-too-large': CLASSES.txSize,
  'payment-unbuildable': CLASSES.txSize,
  'unbuildable-after-consolidation': CLASSES.txSize,
  'collateral-insufficient': CLASSES.collateral,
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

const tokensOf = (o) => o.assets.map((a) => ({ policy: a.policy, name: a.name, qty: a.qty }));

// The request the rule takes, or null when the intent cannot be expressed:
// a battery spend that carries a replay part (none does), or a replayed
// intent the kit cannot write. collateral: the UTxO set aside for a replayed
// script spend.
export function h12Request(intent, { collateral = null } = {}) {
  if (intent.source !== 'replay') {
    if (partsOf(intent).length) return null;
    return { outputs: intent.requested.map((o) => ({ address: o.address, coin: o.coin, tokens: tokensOf(o) })) };
  }
  if (replayRefusal(intent)) return null;
  if (intent.collateral.required && !collateral) throw new Error('unfrackit-h12: a script spend needs the collateral the engine sets aside');
  const f = intent.fixed;
  const imp = intent.implicit;
  return {
    outputs: intent.requested.map((o) => ({ address: o.address, coin: o.coin, tokens: tokensOf(o), cbor: o.cbor })),
    fixed: f
      ? {
          inputs: f.inputs.map((x) => ({ cbor: x.cbor })),
          referenceInputs: f.referenceInputs.map((x) => x.ref),
          body: { ...f.body },
          witnesses: { ...f.witnesses },
          redeemers: f.redeemers.map((r) => ({ tag: r.tag, target: r.target })),
          auxiliaryData: f.auxiliaryData,
          scriptFee: f.scriptFee || 0n,
          signers: [...replayWitnessKeys(f, { inputs: [] })].sort()
        }
      : null,
    implicit: { withdrawals: imp.withdrawals, refunds: imp.refunds, deposits: imp.deposits, donation: imp.donation, mint: imp.mint.map((a) => ({ ...a })), burn: imp.burn.map((a) => ({ ...a })) },
    collateral: intent.collateral.required ? { cbor: collateral.cbor } : null
  };
}

// The ledger kit's view of a replayed intent's payment, for the treatment
// runner's own kit check (treatment/run.mjs selectState), as the engine gives
// it (replay/engine.mjs buildOne): the intent's implicit values, script fee,
// fixed parts and fixed witnesses, the held UTxOs it spends, and the
// collateral, which the state the rule selects from no longer holds.
function kitView(state, intent, collateral) {
  return {
    implicit: intent.implicit,
    scriptFee: intent.fixed ? intent.fixed.scriptFee : 0n,
    fixed: intent.fixed,
    extraWitnesses: fixedExtraWitnesses(intent),
    heldInputs: fixedInputValues(intent).filter((x) => x.held && state.utxos.has(x.ref)).map((x) => x.ref),
    collateral
  };
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
      refuseUncovered('unfrackit-h12', REPLAY_COVERAGE.h12, intent);
      const collateral = intent.collateral.required ? opts.collateral || null : null;
      const request = h12Request(intent, { collateral });
      if (!request) return { ok: false, class: NOT_REPLAYABLE, detail: intent.source === 'replay' ? `unfrackit-h12: ${replayRefusal(intent)}` : 'the rule\'s request for a battery spend carries only requested outputs' };
      const kit = intent.source === 'replay' ? kitView(state, intent, collateral) : null;
      const r = selectState(T, state, request, params, { absorb: opts.absorb, settings, kit });
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
