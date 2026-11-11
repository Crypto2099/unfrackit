// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A run: a plan's jobs over a set of wallets through the worker pool, the
// engine's output written as records (out/records.mjs), and the joins that
// need two arms (H-6's rescue test).
//
// For each wallet: its source is read once in the parent to decide whether
// the window holds a script interaction (which expands the collateral rules),
// and the jobs run in the pool. Each job's worker builds the job's records
// and writes them to the job's spool (out/spool.mjs); the parent commits the
// spools in job order to the wallet's segment as the jobs complete, writes
// the wallet's trigger records after them, and appends the segment to the
// run's records once every job of the wallet has completed. So the records
// are those of one thread writing every job in turn, whatever order the jobs
// end in, and the parent holds no wallet's records: of a job it keeps only
// whether it was refused, its validity summary and, for a maintained-tidy
// job, what H-6's join reads. Every job runs to completion: a job the pool's
// watchdog stops, or one a machine error ends, runs again (replay/pool.mjs),
// rewriting its spool, and only the attempt that completes is recorded. An
// engine refusal (a wallet the rules do not settle, such as one with no
// change address) is recorded as refused; a stop point or a failed job stops
// the run, and the wallet's segment is dropped, so the run's records hold
// whole wallets only.
//
// H-6's rescue test: each trigger of a maintained-tidy arm under the decided or
// an alternative threshold is followed for 30 days of block time; it rescues
// when, at a script interaction, the never-propose arm (same selector, change
// policy, collateral rule and repetition) has no eligible collateral under a
// confirmatory rule and the rule's arm has, or a parallel burst is infeasible
// in the never-propose arm and feasible in the rule's arm. The outcome is
// recorded under each confirmatory collateral rule, since the collateral
// measurement chooses which one is confirmatory.

import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { record } from '../out/records.mjs';
import { spoolPaths, spoolRecords, Frontier } from '../out/spool.mjs';
import { loadSource } from './source.mjs';
import { expandJobs } from '../arms/plan.mjs';
import { batteryRuns, batterySpends } from '../battery/runner-core.mjs';
import { countPopulation } from '../battery/population.mjs';
import { SHAPE_POOLS } from '../battery/battery.mjs';
import { CONFIRMATORY_RULES } from './collateral.mjs';
import { sumValidity } from '../kit/validity.mjs';
import { ORACLE_SETTINGS, admitsIncumbent } from '../oracle/settings.mjs';

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

// What H-6's join (rescueOutcomes) reads of a maintained-tidy job: its
// triggers whole, its spends at a script interaction (those with
// collateralAvailable) by time, intent and availability, and its bursts by
// time, id and feasibility. A job names each intent once, so leaving out the
// spends without collateralAvailable changes no outcome.
export function rescueFields(x) {
  return {
    triggers: x.triggers,
    spends: x.spends.filter((s) => s.collateralAvailable).map(({ t, intent, collateralAvailable }) => ({ t, intent, collateralAvailable })),
    bursts: x.bursts.map(({ t, id, feasible }) => ({ t, id, feasible }))
  };
}

// The records of one replay job's result x, in the order a run writes them:
// its refusal, or its plans, spends, bursts and wallet-arm record. The
// wallet-arm's ms is the attempt's time, which the parent measures: it is
// written here as 0, in the position the time takes, and the parent sets it
// in the timing row (spoolJob holds that row back).
export function* jobRecords(x, { key, hypotheses, opts = {} }) {
  const { absorb } = opts;
  if (x.refused) {
    yield record('refused', key, { reason: x.refused });
    return;
  }
  for (const p of x.plans) yield record('plan', key, p);
  for (const s of x.spends) yield record('spend', key, s);
  for (const b of x.bursts) yield record('burst', key, b);
  yield record('wallet-arm', key, { hypotheses, methodVersion: x.method.version, ...(absorb !== undefined ? { absorb } : {}), ...x.summary, ms: 0 });
}

// What a worker answers for a replay job (replay/worker.mjs): the job's
// records written to its spool (job.spool), with the wallet-arm's timing row
// held back, and what the parent reads besides: whether the job was refused,
// its validity summary, and H-6's fields of a maintained-tidy job.
export function spoolJob(x, job) {
  const spooled = spoolRecords(job.spool, jobRecords(x, job), { hold: (rec) => rec.kind === 'wallet-arm' });
  if (x.refused) return { refused: true, spooled };
  return { refused: false, validity: x.summary.validity || null, rescue: job.arm === 'maintained-tidy' ? rescueFields(x) : null, spooled };
}

// The options a replay job gives its method (checked by the engine): the seed
// is the repetition, in every arm, so that arms of one repetition share it;
// the absorption setting, where the job has one (UnFrack.It's rule), is
// opts.absorb, which the wallet-arm record shows.
export function replayJobOpts(j) {
  return { seed: j.repetition, changePolicy: j.change, collateralRule: j.collateral === 'none-needed' ? 'ledger' : j.collateral, ...(j.absorb !== undefined ? { absorb: j.absorb } : {}) };
}

const needsCollateral = (source) => source.events.some((e) => e.kind === 'intent' && e.intent.collateral.required);

// wallets: [{ spec }]; plan: the window's entries; roles: role -> method name
// (a test plan's entries name role 'test'); out: a RunOutput; watchdogMs: the
// replay watchdog (the pool's default when absent). The jobs' spools are
// under out.dir/spool/<wallet index>/, removed when the run ends.
export async function runReplays(T, pool, { wallets, plan, roles, out, watchdogMs, settleEvery = 25, methodOptions = {}, collateralRules, validity = false }) {
  const totals = { wallets: 0, jobs: 0, refused: 0, triggers: 0 };
  const validities = [];
  const spool = join(out.dir, 'spool');
  try {
    for (const [wi, w] of wallets.entries()) {
      const source = loadSource(T, w.spec);
      if (source.split === 'confirmation') out.note({ event: 'confirmation-split wallet run', wallet: source.wallet, analysisFreezeTx: source.analysisFreezeTx });
      const jobs = expandJobs(plan, { roles, needsCollateral: needsCollateral(source), ...(collateralRules ? { collateralRules } : {}) });
      totals.wallets++;
      const dir = join(spool, String(wi));
      const seg = out.segment(dir);
      // H-6's fields of each maintained-tidy job that was not refused, by job.
      const rescue = new Array(jobs.length).fill(null);
      const frontier = new Frontier(jobs.length, (_i, spooled) => seg.commit(spooled));
      try {
        await Promise.all(jobs.map(async (j, i) => {
          const key = { wallet: source.wallet, window: source.window, arm: j.arm, variant: j.variant, method: j.method, change: j.change, collateral: j.collateral, repetition: j.repetition };
          const job = {
            source: w.spec,
            arm: j.arm,
            variant: j.variant,
            repetition: j.repetition,
            method: { name: j.method, options: methodOptions[j.method] || {} },
            opts: replayJobOpts(j),
            settleEvery,
            policyLock: j.policyLock,
            validity,
            key,
            hypotheses: j.hypotheses,
            spool: spoolPaths(dir, i)
          };
          const at = { wallet: source.wallet, arm: j.arm, variant: j.variant, method: j.method, change: j.change, collateral: j.collateral, repetition: j.repetition };
          const r = await pool.replay(job, { watchdogMs, note: (e) => out.note({ ...e, ...at }) });
          totals.jobs++;
          if (!r.ok) {
            out.note({ event: 'replay error', wallet: source.wallet, arm: j.arm, variant: j.variant, method: j.method, repetition: j.repetition, error: r.error, stop: r.stop });
            if (r.stop) throw new Error(`stop point: ${r.error}`);
            throw new Error(`replay failed: ${r.error}`);
          }
          const x = r.result;
          if (x.refused) totals.refused++;
          else {
            if (x.validity) {
              validities.push(x.validity);
              noteValidity(out, key, x.validity);
            }
            if (x.rescue) rescue[i] = { key, ...x.rescue };
          }
          if (x.spooled.held) x.spooled.held.times.ms = r.ms;
          frontier.done(i, x.spooled);
        }));
        if (!frontier.complete) throw new Error('a job of the wallet was not committed');
        // H-6's rescue test, per maintained-tidy rule arm against its
        // never-propose twin, in job order.
        const twins = new Map(rescue.filter(Boolean).map((r) => [JSON.stringify(r.key), r]));
        for (const res of rescue) {
          if (!res || !res.triggers.length) continue;
          const twin = H6_RULES.has(res.key.variant) ? twins.get(JSON.stringify({ ...res.key, variant: 'never-propose' })) : null;
          const outcomes = twin ? rescueOutcomes(res, twin) : res.triggers.map((t) => ({ ...t, rescue: null }));
          for (const t of outcomes) seg.write(record('trigger', res.key, t));
          totals.triggers += outcomes.length;
        }
      } catch (e) {
        frontier.stop();
        seg.close();
        throw e;
      }
      out.adopt(seg);
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(spool, { recursive: true, force: true });
  }
  if (validity) totals.validity = sumValidity(validities);
  return totals;
}

// The unseeded runs kept beside a reference: per method, in the order the
// runs came, { name, runs, below, least }, below counting the runs whose fee
// is under the reference's fee, or every run when the reference has none.
export function unseededBeside(runs, refFee) {
  const by = new Map();
  for (const r of runs) {
    const fee = BigInt(r.fee);
    if (!by.has(r.name)) by.set(r.name, { name: r.name, runs: 0, below: 0, least: fee });
    const m = by.get(r.name);
    m.runs++;
    if (refFee === null || refFee === undefined || fee < BigInt(refFee)) m.below++;
    if (fee < m.least) m.least = fee;
  }
  return [...by.values()];
}

// One log note per failure of a validity summary, naming the record's key and
// the transaction's position.
export function noteValidity(out, key, v) {
  for (const f of v.failures || []) out.note({ event: 'validity failure', ...key, ...f });
  if (v.failed > (v.failures || []).length) out.note({ event: 'validity failures not detailed', ...key, count: v.failed - (v.failures || []).length });
}

// The batteries over a set of wallets: every run's result as a 'battery'
// record (an H-12 run also as 'h12'), every answer having run to completion
// (the pool's watchdog stops an answer that hangs, and the wallet's battery
// resumes at it in a fresh worker; replay/pool.mjs), and, when an oracle is
// given, its reference per wallet, standard-battery spend and distinct
// oracle change policy, with the single
// transaction of every run under that policy by a method the oracle's
// incumbents rule admits as an incumbent (under the default,
// 'seeded-methods', the seeded methods'). The passing runs of the other
// methods are kept beside the reference (`unseeded`: per method, the runs,
// how many have a fee below the reference's, every one of them when the
// reference has no fee, and the least fee) and never seed it. The hook:
//   oracle.policyOf(methodName, changePolicy)  the oracle's change policy of
//       a method's change, or null when the oracle has none for it
//   oracle.reference(state, intent, params, policy, { incumbents })
//       the reference for one spend, run however the oracle runs it;
//       incumbents are [{ name, seeded, walletInputs, bytes, fee }]
//   oracle.settings  the oracle's settings (the defaults when absent)
// The oracle prices the standard battery's spends only. The wallet's state and
// battery intents are rebuilt in this thread for it; both are deterministic,
// so they are the worker's.
// A wallet carries `population` ({ kind, batteries: { standard, h10 } },
// battery/population.mjs): its job builds only those batteries, a wallet with
// none starts no job, and a wallet of the recent random sample whose snapshot
// state holds no native asset is counted in `tokenless` (not filtered). A
// wallet with the standard battery also gets one 'snapshot-plan' record.
// watchdogMs: the answer watchdog (the pool's default when absent).
export async function runBatteries(T, pool, { wallets, methods, out, watchdogMs, pools, oracle = null, tidySettings = {}, validity = false }) {
  const totals = { wallets: 0, runs: 0, oracle: 0, tokenless: 0, population: countPopulation(wallets) };
  const validities = [];
  const oracleRules = oracle ? oracle.settings || ORACLE_SETTINGS : null;
  // One task per wallet: its battery job, then its oracle calls. Up to
  // pool.size tasks are in flight, so a wallet's oracle calls overlap the
  // other wallets' methods. A task buffers its records; they are written in
  // wallet order, a wallet's only after every earlier wallet's, so a repeated
  // run writes the same records in the same order whatever the pool size.
  const buffers = wallets.map(() => null);
  let flushed = 0;
  const flush = () => {
    while (flushed < wallets.length && buffers[flushed]) {
      for (const rec of buffers[flushed]) out.write(rec);
      buffers[flushed] = null;
      flushed++;
    }
  };
  const task = async (wi) => {
    const w = wallets[wi];
    if (!(w.population ? w.population.batteries.standard || w.population.batteries.h10 : true)) {
      buffers[wi] = [];
      flush();
      return;
    }
    const recs = [];
    const emit = (rec) => recs.push(rec);
    const source = loadSource(T, w.spec);
    if (source.split === 'confirmation') out.note({ event: 'confirmation-split wallet run', wallet: source.wallet, analysisFreezeTx: source.analysisFreezeTx });
    const keyOf = (res) => ({ wallet: source.wallet, window: 'snapshot', arm: res.layout === 'tidy' ? 'tidy-once' : 'observed', variant: 'default', method: res.method.name, change: res.opts.changePolicy, collateral: 'none-needed', repetition: res.repetition });
    const byK = new Map();
    const population = w.population || { kind: 'no-sample', batteries: { standard: true, h10: true } };
    const job = { source: w.spec, methods, batteries: population.batteries, pools, tidySettings, validity };
    const r = await pool.battery(job, {
      watchdogMs,
      note: (e) => out.note({ ...e, wallet: source.wallet }),
      onSpend: (k, res) => {
        totals.runs++;
        byK.set(k, res);
      }
    });
    if (!r.ok) throw new Error(`battery failed for wallet ${source.wallet}: ${r.error}`);
    totals.wallets++;
    const runs = batteryRuns(r.result.spends.map((s) => ({ n: s.n, battery: s.battery, intent: s.unsettled ? null : { id: s.id } })), methods);
    if (population.batteries.standard) {
      // The snapshot plan of a wallet that runs the standard battery, for the
      // recoverable-ADA measure: the default plan's transactions and fee, and
      // the coin and minimum ADA over the token UTxOs it can spend, before and
      // after it.
      const L = r.result.tidyLedger;
      emit(record('snapshot-plan', { wallet: source.wallet, window: 'snapshot', arm: 'observed', variant: 'default', method: 'snapshot-plan', change: 'none', collateral: 'none-needed', repetition: 1 }, { txs: r.result.tidyPlan.txs, fee: r.result.tidyPlan.fee, tokenUtxosBefore: L.before.utxos, coinBefore: L.before.coin, minimumBefore: L.before.minimum, tokenUtxosAfter: L.after.utxos, coinAfter: L.after.coin, minimumAfter: L.after.minimum }));
      if (population.kind === 'standard-and-h10' && !source.start.some((u) => u.assets.length)) totals.tokenless++;
    }
    const spendOf = new Map(r.result.spends.map((s) => [s.n, s]));
    for (const run of runs) {
      const res = byK.get(run.k);
      if (!res) continue;
      const { incumbent, k: _k, id, method, opts, repetition: _r, spend: _n, ...rest } = res;
      if (res.validity) {
        validities.push(res.validity);
        noteValidity(out, keyOf(res), res.validity);
      }
      const fields = { spend: id, absorb: opts.absorb ?? null, methodVersion: method.version, ...rest };
      emit(record('battery', keyOf(res), fields));
      if (method.name === 'unfrackit-h12') emit(record('h12', keyOf(res), { spend: id, absorb: opts.absorb, completed: res.ok, chain: res.ok ? res.answer === 'chain' : null, txs: res.txs ?? null, chainFee: res.fee ?? null, tidyFee: res.tidyFee ?? null, utxosAfter: res.utxosAfter ?? null, suffices: res.suffices }));
    }
    for (const s of r.result.spends) if (s.unsettled) emit(record('battery', { wallet: source.wallet, window: 'snapshot', arm: s.layout === 'tidy' ? 'tidy-once' : 'observed', variant: 'default', method: 'none', change: 'none', collateral: 'none-needed', repetition: 1 }, { spend: s.id, unsettled: s.unsettled }));
    if (oracle) {
      const built = batterySpends(T, source, source.params, { pools: job.pools || SHAPE_POOLS, batteries: population.batteries });
      const groups = new Map();
      for (const run of runs) {
        const res = byK.get(run.k);
        const s = spendOf.get(run.spend);
        if (s.layout !== 'observed' || s.battery !== 'standard') continue;
        const policy = oracle.policyOf(run.method, run.opts.changePolicy);
        if (!policy) continue;
        const g = `${run.spend}|${policy}`;
        if (!groups.has(g)) groups.set(g, { spend: run.spend, policy, incumbents: [], unseeded: [] });
        if (!res || !res.ok || !res.incumbent) continue;
        if (admitsIncumbent(oracleRules, res.method)) groups.get(g).incumbents.push({ name: res.method.name, seeded: res.method.seeded === true, ...res.incumbent });
        else groups.get(g).unseeded.push({ name: res.method.name, fee: res.incumbent.fee });
      }
      // The calls run together, so that an oracle with several workers uses
      // them; the records are written in group order.
      const list = [...groups.values()];
      const refs = await Promise.all(list.map((g) => oracle.reference(built.observed, built.spends[g.spend].intent, source.params, g.policy, { incumbents: g.incumbents })));
      list.forEach((g, i) => {
        totals.oracle++;
        emit(record('battery', { wallet: source.wallet, window: 'snapshot', arm: 'observed', variant: 'default', method: 'oracle', change: g.policy, collateral: 'none-needed', repetition: 1 }, { spend: built.spends[g.spend].intent.id, incumbents: g.incumbents.length, unseeded: unseededBeside(g.unseeded, refs[i] ? refs[i].fee : null), oracle: refs[i] }));
      });
    }
    buffers[wi] = recs;
    flush();
  };
  // A failure stops the run: no further wallet starts, the tasks in flight
  // finish, and the first error is thrown.
  let next = 0;
  let failure = null;
  const lane = async () => {
    while (!failure && next < wallets.length) {
      const wi = next++;
      try {
        await task(wi);
      } catch (e) {
        failure = failure || e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(pool.size, wallets.length)) }, lane));
  if (failure) throw failure;
  if (validity) totals.validity = sumValidity(validities);
  return totals;
}
