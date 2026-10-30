// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// One wallet's batteries at the snapshot, in a worker thread: the standard
// battery and H-10's from the observed layout, and H-10's from the tidy layout
// (the planner's full plan at its defaults applied, its fees not part of the
// spend), each spend built by every method the job names under each of its
// options and repetitions, checked by the kit, and followed by the frozen
// planner's plan of the resulting state (battery/run.mjs runSpend).
//
// "The balance suffices" is evaluated once per wallet and spend on the layout
// the spend is made from (for the standard battery and H-12, the observed
// layout), so every method is scored on the same spends: H-12's base and
// every battery's infeasible-by-balance rule. A spend that fails it is still
// built and its outcome recorded beside the flag.
//
// The parent enforces each method's 60-second limit: the hooks report when a
// method starts and finishes answering, and a method that does not finish is
// stopped by terminating the thread. The spends of a wallet are numbered in a
// fixed order, so that a fresh worker resumes after the one that ran out of
// time (job.skip lists the numbers already done).
//
// job: { source, methods: [{ name, options, opts: [{ changePolicy, absorb,
// seed }], repetitions }], pools, skip, tidySettings, validity }. With
// validity, each run's result carries the validity summary of kit/validity.mjs
// over its spend's transactions.

import { makeState } from '../state/state.mjs';
import { standardBattery, h10Battery, SHAPE_POOLS } from './battery.mjs';
import { balanceSuffices } from './suffices.mjs';
import { runSpend } from './run.mjs';
import { planState } from '../treatment/run.mjs';
import { makeMethod } from '../methods/registry.mjs';
import { spendMeasures } from '../replay/measure.mjs';
import { inspectTx } from '../kit/inspect.mjs';
import { newValidity, summarize } from '../kit/validity.mjs';

const sum = (xs) => xs.reduce((a, b) => a + b, 0n);

// The battery's spends for a wallet, in their fixed order: [{ n, layout,
// intent | unsettled }].
export function batterySpends(T, source, params, { pools }) {
  if (!source.changeAddress) throw new Error('the change-address rule names no address at the snapshot: the wallet has received no output at a key payment credential and a base address');
  const observed = makeState({ network: source.network, stakeCred: source.stakeCred, changeAddress: source.changeAddress, utxos: source.start, franken: source.franken });
  const plan = planState(T, observed, params, {});
  const tidy = plan.after;
  const list = [
    ...standardBattery(T, observed, params, { pools }).map((x) => ({ layout: 'observed', x })),
    ...h10Battery(T, observed, params).map((x) => ({ layout: 'observed', x })),
    ...h10Battery(T, tidy, params, { observed }).map((x) => ({ layout: 'tidy', x }))
  ];
  return { observed, tidy, tidyPlan: { txs: plan.txs.length, fee: sum(plan.txs.map((t) => t.fee)) }, spends: list.map((s, n) => ({ n, layout: s.layout, ...(s.x.unsettled ? { unsettled: s.x } : { intent: s.x }) })) };
}

// The list of (spend, method, options, repetition) runs in their fixed order.
export function batteryRuns(spends, methods) {
  const runs = [];
  for (const s of spends) {
    if (!s.intent) continue;
    for (const m of methods) for (const opts of m.opts) for (let rep = 1; rep <= (m.repetitions || 1); rep++) runs.push({ k: runs.length, spend: s.n, method: m.name, options: m.options || {}, opts: { ...opts, seed: opts.seed ?? rep }, repetition: rep });
  }
  return runs;
}

export async function batteryWallet(T, source, job, hooks) {
  const params = source.params;
  const pools = job.pools || SHAPE_POOLS;
  const { observed, tidy, tidyPlan, spends } = batterySpends(T, source, params, { pools });
  const suffices = new Map();
  for (const s of spends) if (s.intent) suffices.set(s.n, balanceSuffices(T, s.layout === 'observed' ? observed : tidy, params, s.intent).suffices);
  const runs = batteryRuns(spends, job.methods);
  const skip = new Set(job.skip || []);
  const methods = new Map();
  for (const r of runs) {
    if (skip.has(r.k)) continue;
    const s = spends[r.spend];
    const state = s.layout === 'observed' ? observed : tidy;
    const mk = `${r.method} ${JSON.stringify(r.options)}`;
    if (!methods.has(mk)) methods.set(mk, makeMethod(T, r.method, r.options));
    const m = methods.get(mk);
    const timed = { ...m, build: async (...a) => {
      hooks.answering(r.k);
      try {
        return await m.build(...a);
      } finally {
        hooks.answered(r.k);
      }
    } };
    const validity = job.validity ? newValidity(T.CSL) : null;
    const res = await runSpend(T, { state, params, intent: s.intent, method: timed, opts: r.opts, tidySettings: job.tidySettings || {}, validity });
    const out = {
      k: r.k,
      spend: s.n,
      id: s.intent.id,
      type: s.intent.type,
      layout: s.layout,
      method: { name: m.name, version: m.version, seeded: m.seeded },
      opts: r.opts,
      repetition: r.repetition,
      suffices: suffices.get(s.n),
      meta: s.intent.meta,
      ok: res.ok,
      ms: res.ms,
      ...(validity ? { validity: summarize(validity) } : {})
    };
    if (!res.ok) Object.assign(out, { class: res.class, detail: res.detail });
    else {
      const last = res.answer.txs[res.answer.txs.length - 1];
      const t = inspectTx(last.bytes);
      Object.assign(out, {
        answer: res.kind,
        txs: res.txs,
        fee: res.fee,
        paymentFee: res.paymentFee,
        paymentSize: res.paymentSize,
        utxosAfter: res.utxosAfter,
        tidyTxs: res.tidyTxs,
        tidyFee: res.tidyFee,
        measures: spendMeasures(chainBefore(state, res), s.intent, t, last.walletInputs, params),
        // The incumbent transactions for the oracle (a chain has none: there
        // is no oracle for multi-transaction plans); the battery runner keeps
        // those of the methods its oracle's incumbents rule admits.
        incumbent: res.kind === 'single' ? { walletInputs: last.walletInputs, bytes: last.bytes, fee: last.fee } : null
      });
    }
    hooks.result(r.k, out);
  }
  return { spends: spends.map((s) => ({ n: s.n, layout: s.layout, id: s.intent ? s.intent.id : s.unsettled.kind, unsettled: s.unsettled ? s.unsettled.unsettled : null, meta: s.intent ? s.intent.meta : s.unsettled.meta })), runs: runs.length, tidyPlan };
}

// The state the payment of an answer was built from: the start state for a
// single transaction; for a chain, the state after its planner transactions,
// which the kit applied in order (runSpend's checks list).
function chainBefore(state, res) {
  return res.kind === 'chain' ? res.beforePayment : state;
}
