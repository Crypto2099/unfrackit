// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A run: a plan's jobs over a set of wallets through the worker pool, the
// engine's output written as records (out/records.mjs), and the joins that
// need two arms (H-6's rescue test).
//
// For each wallet: its source is read once in the parent to decide whether
// the window holds a script interaction (which expands the collateral rules),
// the jobs run in the pool, and each job's output becomes records. A replay
// that times out is recorded as a time-out; an engine refusal (a wallet the
// rules do not settle, such as one with no change address) as refused; a stop
// point stops the run.
//
// H-6's rescue test: each trigger of a maintained-tidy arm under the decided or
// an alternative threshold is followed for 30 days of block time; it rescues
// when, at a script interaction, the never-propose arm (same selector, change
// policy, collateral rule and repetition) has no eligible collateral under a
// confirmatory rule and the rule's arm has, or a parallel burst is infeasible
// in the never-propose arm and feasible in the rule's arm. The outcome is
// recorded under each confirmatory collateral rule, since the collateral
// measurement chooses which one is confirmatory.

import { record } from '../out/records.mjs';
import { loadSource } from './source.mjs';
import { expandJobs } from '../arms/plan.mjs';
import { batteryRuns, batterySpends } from '../battery/runner-core.mjs';
import { SHAPE_POOLS } from '../battery/battery.mjs';
import { CONFIRMATORY_RULES } from './collateral.mjs';

const MONTH = 30 * 86400;
// The thresholds whose triggers are tested against the never-propose arm.
const H6_RULES = new Set(['default', 'dust-1', 'band-3-6', 'band-5-20']);

export function rescueOutcomes(rule, never) {
  return rule.triggers.map((tr) => {
    const within = (t) => t !== null && t > tr.t && t <= tr.t + MONTH;
    const rescue = {};
    for (const cr of CONFIRMATORY_RULES) {
      let rescued = false;
      for (const s of rule.spends) {
        if (!within(s.t) || !s.collateralAvailable) continue;
        const ns = never.spends.find((x) => x.intent === s.intent);
        if (ns && ns.collateralAvailable && ns.collateralAvailable[cr] === false && s.collateralAvailable[cr] === true) rescued = true;
      }
      for (const b of rule.bursts) {
        if (!within(b.t)) continue;
        const nb = never.bursts.find((x) => x.id === b.id);
        if (nb && !nb.feasible && b.feasible) rescued = true;
      }
      rescue[cr] = rescued;
    }
    return { ...tr, rescue };
  });
}

const needsCollateral = (source) => source.events.some((e) => e.kind === 'intent' && e.intent.collateral.required);

// wallets: [{ spec }]; plan: the window's entries; roles: role -> method name
// (a test plan's entries name role 'test'); out: a RunOutput.
export async function runReplays(T, pool, { wallets, plan, roles, out, limitMs, settleEvery = 25, methodOptions = {}, collateralRules }) {
  const totals = { wallets: 0, jobs: 0, timeouts: 0, refused: 0, triggers: 0 };
  for (const w of wallets) {
    const source = loadSource(T, w.spec);
    if (source.split === 'confirmation') out.note({ event: 'confirmation-split wallet run', wallet: source.wallet, analysisFreezeTx: source.analysisFreezeTx });
    const jobs = expandJobs(plan, { roles, needsCollateral: needsCollateral(source), ...(collateralRules ? { collateralRules } : {}) });
    totals.wallets++;
    const results = new Array(jobs.length).fill(null);
    // Jobs run in parallel; their records are written afterwards in job
    // order, so a repeated run writes the same records in the same order.
    const writes = jobs.map(() => []);
    const put = (i, kind, key, fields) => writes[i].push(record(kind, key, fields));
    await Promise.all(jobs.map(async (j, i) => {
      const key = { wallet: source.wallet, window: source.window, arm: j.arm, variant: j.variant, method: j.method, change: j.change, collateral: j.collateral, repetition: j.repetition };
      const job = {
        source: w.spec,
        arm: j.arm,
        variant: j.variant,
        repetition: j.repetition,
        method: { name: j.method, options: methodOptions[j.method] || {} },
        opts: { seed: j.repetition, changePolicy: j.change, collateralRule: j.collateral === 'none-needed' ? 'ledger' : j.collateral },
        settleEvery,
        policyLock: j.policyLock
      };
      const r = await pool.replay(job, { limitMs });
      totals.jobs++;
      if (!r.ok && r.timedOut) {
        totals.timeouts++;
        put(i, 'timeout', key, { limitMs: limitMs ?? null, ms: r.ms, hypotheses: j.hypotheses });
        out.note({ event: 'replay timed out', wallet: source.wallet, arm: j.arm, variant: j.variant, method: j.method, repetition: j.repetition });
        return;
      }
      if (!r.ok) {
        out.note({ event: 'replay error', wallet: source.wallet, arm: j.arm, variant: j.variant, method: j.method, repetition: j.repetition, error: r.error, stop: r.stop });
        if (r.stop) throw new Error(`stop point: ${r.error}`);
        throw new Error(`replay failed: ${r.error}`);
      }
      const x = r.result;
      if (x.refused) {
        totals.refused++;
        put(i, 'refused', key, { reason: x.refused });
        return;
      }
      results[i] = { key, x, j };
      for (const p of x.plans) put(i, 'plan', key, p);
      for (const s of x.spends) put(i, 'spend', key, s);
      for (const b of x.bursts) put(i, 'burst', key, b);
      put(i, 'wallet-arm', key, { hypotheses: j.hypotheses, methodVersion: x.method.version, ...x.summary, ms: r.ms });
    }));
    for (const list of writes) for (const rec of list) out.write(rec);
    // H-6's rescue test, per maintained-tidy rule arm against its
    // never-propose twin.
    // In job order, so that a repeated run writes the same records.
    const byKey = new Map(results.filter(Boolean).map((r) => [JSON.stringify(r.key), r]));
    for (const res of results) {
      if (!res) continue;
      const { key, x } = res;
      if (key.arm !== 'maintained-tidy' || !x.triggers.length) continue;
      const twin = H6_RULES.has(key.variant) ? byKey.get(JSON.stringify({ ...key, variant: 'never-propose' })) : null;
      const outcomes = twin ? rescueOutcomes(x, twin.x) : x.triggers.map((t) => ({ ...t, rescue: null }));
      for (const t of outcomes) out.write(record('trigger', key, t));
      totals.triggers += outcomes.length;
    }
  }
  return totals;
}

// The batteries over a set of wallets: every run's result as a 'battery'
// record (an H-12 run also as 'h12'), a time-out as a 'battery' record with
// class time-limit, and, when an oracle is given, its reference per wallet,
// observed-layout spend and distinct oracle change policy, with every
// method's single transaction under that policy as an incumbent. The hook:
//   oracle.policyOf(methodName, changePolicy)  the oracle's change policy of
//       a method's change, or null when the oracle has none for it
//   oracle.reference(state, intent, params, policy, { incumbents })
//       the reference for one spend, run however the oracle runs it;
//       incumbents are [{ name, walletInputs, bytes, fee }]
// The wallet's state and battery intents are rebuilt in this thread for it;
// both are deterministic, so they are the worker's.
export async function runBatteries(T, pool, { wallets, methods, out, answerLimitMs, pools, oracle = null, tidySettings = {} }) {
  const totals = { wallets: 0, runs: 0, timeouts: 0, oracle: 0 };
  for (const w of wallets) {
    const source = loadSource(T, w.spec);
    if (source.split === 'confirmation') out.note({ event: 'confirmation-split wallet run', wallet: source.wallet, analysisFreezeTx: source.analysisFreezeTx });
    const keyOf = (res) => ({ wallet: source.wallet, window: 'snapshot', arm: res.layout === 'tidy' ? 'tidy-once' : 'observed', variant: 'default', method: res.method.name, change: res.opts.changePolicy, collateral: 'none-needed', repetition: res.repetition });
    const byK = new Map();
    const job = { source: w.spec, methods, pools, tidySettings };
    const r = await pool.battery(job, {
      answerLimitMs,
      onSpend: (k, res) => {
        totals.runs++;
        byK.set(k, res);
      }
    });
    if (!r.ok) throw new Error(`battery failed for wallet ${source.wallet}: ${r.error}`);
    totals.wallets++;
    // A time-out has only its run number; the run list gives its key.
    const runs = batteryRuns(r.result.spends.map((s) => ({ n: s.n, intent: s.unsettled ? null : { id: s.id } })), methods);
    const spendOf = new Map(r.result.spends.map((s) => [s.n, s]));
    for (const run of runs) {
      const res = byK.get(run.k);
      if (!res) continue;
      const s = spendOf.get(run.spend);
      if (res.timeLimit) {
        totals.timeouts++;
        const key = { wallet: source.wallet, window: 'snapshot', arm: s.layout === 'tidy' ? 'tidy-once' : 'observed', variant: 'default', method: run.method, change: run.opts.changePolicy, collateral: 'none-needed', repetition: run.repetition };
        out.write(record('battery', key, { spend: s.id, layout: s.layout, ok: false, class: 'time-limit', detail: `no answer within ${res.limitMs} ms`, absorb: run.opts.absorb ?? null }));
        continue;
      }
      const { incumbent, k: _k, id, method, opts, repetition: _r, spend: _n, ...rest } = res;
      const fields = { spend: id, absorb: opts.absorb ?? null, methodVersion: method.version, ...rest };
      out.write(record('battery', keyOf(res), fields));
      if (method.name === 'unfrackit-h12') out.write(record('h12', keyOf(res), { spend: id, absorb: opts.absorb, completed: res.ok, chain: res.ok ? res.answer === 'chain' : null, txs: res.txs ?? null, chainFee: res.fee ?? null, tidyFee: res.tidyFee ?? null, utxosAfter: res.utxosAfter ?? null, suffices: res.suffices }));
    }
    for (const s of r.result.spends) if (s.unsettled) out.write(record('battery', { wallet: source.wallet, window: 'snapshot', arm: s.layout === 'tidy' ? 'tidy-once' : 'observed', variant: 'default', method: 'none', change: 'none', collateral: 'none-needed', repetition: 1 }, { spend: s.id, unsettled: s.unsettled }));
    if (oracle) {
      const built = batterySpends(T, source, source.params, { pools: job.pools || SHAPE_POOLS });
      const groups = new Map();
      for (const run of runs) {
        const res = byK.get(run.k);
        const s = spendOf.get(run.spend);
        if (s.layout !== 'observed') continue;
        const policy = oracle.policyOf(run.method, run.opts.changePolicy);
        if (!policy) continue;
        const g = `${run.spend}|${policy}`;
        if (!groups.has(g)) groups.set(g, { spend: run.spend, policy, incumbents: [] });
        if (res && !res.timeLimit && res.ok && res.incumbent) groups.get(g).incumbents.push({ name: res.method.name, ...res.incumbent });
      }
      for (const g of groups.values()) {
        const intent = built.spends[g.spend].intent;
        const ref = await oracle.reference(built.observed, intent, source.params, g.policy, { incumbents: g.incumbents });
        totals.oracle++;
        out.write(record('battery', { wallet: source.wallet, window: 'snapshot', arm: 'observed', variant: 'default', method: 'oracle', change: g.policy, collateral: 'none-needed', repetition: 1 }, { spend: intent.id, incumbents: g.incumbents.length, oracle: ref }));
      }
    }
  }
  return totals;
}
