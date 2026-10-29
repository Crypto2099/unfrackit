// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The planner and the H-12 rule run on a state, every transaction built by
// the treatment's own code (build2.mjs buildPlan, select2-csl.mjs
// buildResult), checked by the treatment's own checks (conform.mjs
// checkBuiltTx, select2-csl.mjs checkPayment) and by the ledger kit. Every
// transaction the treatment builds must pass both; a transaction that fails
// either is a stop point (StopPoint), never a tolerance, because it means the
// treatment, or the kit, is wrong.

import { treatmentParams } from './bridge.mjs';
import { treatmentWallet, adapterFor } from './wallet.mjs';
import { checkAndApply } from '../kit/apply.mjs';
import { inspectTx } from '../kit/inspect.mjs';

export class StopPoint extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'StopPoint';
    this.detail = detail;
  }
}

const toHex = (b) => Buffer.from(b).toString('hex');

// A built treatment transaction as a transaction record, its CSL objects freed.
function record(b, ptx, source) {
  const bytes = toHex(b.tx.to_bytes());
  const t = inspectTx(bytes);
  if (t.hash !== b.hashHex) throw new StopPoint(`the treatment's transaction hash ${b.hashHex} differs from the body hash ${t.hash}`);
  const roles = {};
  for (const x of ptx.inputs) roles[x.role] = (roles[x.role] || 0) + 1;
  return {
    bytes,
    hash: t.hash,
    walletInputs: b.inputRefs.slice(),
    fee: BigInt(ptx.fee),
    size: t.size,
    serializedSize: t.serializedSize,
    k: b.k,
    roles,
    source,
    plannedSize: ptx.size
  };
}

function free(built) {
  for (const b of built) {
    for (const o of b.outputs) o.free();
    b.hash.free();
    b.tx.free();
  }
}

// Kit checks over the treatment's transactions, applied in order from `state`.
function kitAgree(state, params, txs, treatmentPass, what, validity = null) {
  const r = checkAndApply(state, params, txs, { validity });
  if (!r.ok) {
    const f = r.failure;
    throw new StopPoint(`${what}: transaction ${r.failed} passes the treatment's checks and fails the kit's (${f.check}: ${f.detail})`, { failures: r.checks[r.failed].failures });
  }
  treatmentPass.forEach((ok, i) => {
    if (!ok.pass) throw new StopPoint(`${what}: transaction ${i} passes the kit's checks and fails the treatment's (${ok.detail.join('; ')})`, ok);
  });
  return r;
}

// The planner's plan for a state without building it (planner2.mjs plan's
// return value), for comparing two settings on one state.
export function planOnly(T, state, params, settings = {}, { ladder, refs, arrival } = {}) {
  const tp = treatmentParams(T, params);
  const { utxos } = treatmentWallet(T, state, { refs, arrival });
  const adapter = adapterFor(T, state.changeAddress, tp, 'plan');
  return T.planner.plan(utxos, settings, tp, adapter, ladder === undefined ? {} : { ladder });
}

// The planner's plan for a state. options: { ladder } as planner2.mjs plan
// takes it; refs: the order (state order by default); arrival: as
// treatmentWallet takes it; validity: { acc, at } as kit/apply.mjs takes it.
export function planState(T, state, params, settings = {}, { ladder, refs, arrival, validity = null } = {}) {
  const tp = treatmentParams(T, params);
  const { wallet, utxos } = treatmentWallet(T, state, { refs, arrival });
  const adapter = adapterFor(T, state.changeAddress, tp, 'plan');
  const plan = T.planner.plan(utxos, settings, tp, adapter, ladder === undefined ? {} : { ladder });
  if (!plan.txs.length) return { plan, txs: [], after: state, treatmentChecks: [], kitChecks: [] };
  const built = T.build2.buildPlan(plan, wallet);
  const treatmentChecks = built.map((b, i) => T.conform.checkBuiltTx(b, plan.txs[i], plan));
  const txs = built.map((b, i) => record(b, plan.txs[i], 'plan'));
  free(built);
  const k = kitAgree(state, params, txs, treatmentChecks, 'plan', validity);
  return { plan, txs, after: k.state, treatmentChecks, kitChecks: k.checks };
}

// The H-12 rule's answer to a request ({ outputs: [{ address (bech32), coin,
// tokens }] }) on a state. options: { absorb (required), settings, refs }.
// Returns the selector's error, or its transactions with both checks passed
// and the state after them.
export function selectState(T, state, request, params, { absorb, settings = {}, refs } = {}) {
  const tp = treatmentParams(T, params);
  const { wallet, utxos } = treatmentWallet(T, state, { refs });
  const adapter = adapterFor(T, state.changeAddress, tp, 'select');
  const result = T.select.select(utxos, request, tp, adapter, { absorb, settings });
  if (!result.ok) return { ok: false, result };
  const built = T.selectCsl.buildResult(result, wallet);
  const n = result.payment.index;
  const pay = T.selectCsl.checkPayment(built[n], result.txs[n], result, request);
  const chain = built.slice(0, n).map((b, i) => T.conform.checkBuiltTx(b, result.txs[i], result.plan));
  const noLadder = result.txs.every((t) => t.outputs.every((o) => o.kind !== 'ladder'));
  const idsMatch = result.planIds.every((id, i) => id === built[i].hashHex);
  if (!noLadder) throw new StopPoint('a chain transaction of the H-12 rule lays out the ladder');
  if (!idsMatch) throw new StopPoint('a plan transaction id the H-12 rule used differs from the built one');
  const txs = built.map((b, i) => record(b, result.txs[i], i === n ? 'payment' : 'plan'));
  free(built);
  const k = kitAgree(state, params, txs, [...chain, pay], 'H-12 rule');
  return { ok: true, result, txs, after: k.state, treatmentChecks: [...chain, pay], kitChecks: k.checks };
}
