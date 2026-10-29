// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// One battery spend by one method: the method's answer, the ledger kit's
// checks on every transaction in order, and, after the spend, the frozen
// planner's plan for the wallet's resulting state at its default settings,
// whose fee, transaction count and the post-spend UTxO count are recorded
// (the spend-plus-tidy cost of H-12).
//
// A method's exception is a build failure of class 'other' with its text; a
// StopPoint (the treatment and the kit disagree) stops the run. The CSL heap
// is settled before each spend (kit/heap.mjs), and the method's time is
// measured after it.

import { checkAndApply } from '../kit/apply.mjs';
import { planState, StopPoint } from '../treatment/run.mjs';
import { checkResult, checkOptions } from '../methods/contract.mjs';
import { CLASSES } from '../kit/check.mjs';
import { settle } from '../kit/heap.mjs';

const sum = (xs) => xs.reduce((a, b) => a + b, 0n);

// opts: the method options; tidySettings: the planner settings of the plan
// after the spend (the defaults in the study); notWallet: as
// state/state.mjs applyTx takes it; validity: an accumulator of
// kit/validity.mjs, fed with the spend's transactions.
export async function runSpend(T, { state, params, intent, method, opts, tidySettings = {}, notWallet = null, validity = null }) {
  checkOptions(opts);
  await settle();
  const t0 = performance.now();
  let r;
  try {
    r = checkResult(method, await method.build(state, intent, params, opts));
  } catch (e) {
    if (e instanceof StopPoint) throw e;
    r = { ok: false, class: CLASSES.other, detail: String(e && (e.message || e)) };
  }
  const ms = performance.now() - t0;
  if (!r.ok) return { ok: false, class: r.class, detail: r.detail, ms, answer: r };
  const applied = checkAndApply(state, params, r.txs, { implicit: intent.implicit, notWallet, validity: validity && { acc: validity, at: 'spend' } });
  if (!applied.ok) return { ok: false, class: applied.failure.cls, detail: `kit: ${applied.failure.check}: ${applied.failure.detail}`, ms, answer: r, kit: applied.checks };
  const tidy = planState(T, applied.state, params, tidySettings);
  const last = r.txs[r.txs.length - 1];
  return {
    ok: true,
    kind: r.kind,
    ms,
    answer: r,
    txs: r.txs.length,
    fee: sum(r.txs.map((t) => t.fee)),
    paymentFee: last.fee,
    paymentSize: applied.checks[applied.checks.length - 1].facts.size,
    kit: applied.checks,
    after: applied.state,
    beforePayment: applied.states.length > 1 ? applied.states[applied.states.length - 2] : state,
    utxosAfter: applied.state.utxos.size,
    tidyTxs: tidy.txs.length,
    tidyFee: sum(tidy.txs.map((t) => t.fee))
  };
}
