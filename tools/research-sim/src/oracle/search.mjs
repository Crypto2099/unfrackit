// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// One oracle run, in the calling thread: for one wallet state, one battery
// spend and one change policy, the least-fee feasible single-transaction
// selection the search finds within its time limit, reported as an upper
// bound on the true optimum.
//
// The run starts from its incumbents (setting incumbents 'all-methods'): the
// input set of every method's transaction with the same change policy on the
// same spend that passed the kit's checks, each evaluated exactly by the
// policy, so the reference is never above a fee a method reached. It then
// takes the exhaustive path when the candidate set numbers at most 24, and
// the mixed-integer path otherwise (setting searchSpace). Statuses:
//
//   optimal        the search completed: the exhaustive path's queue ran out
//                  at a bound at or above the best fee, or the program with
//                  its cutoff became infeasible; the reference is the optimum
//                  over the search space (or an incumbent below it)
//   best-at-limit  a feasible solution exists, the time limit was reached
//                  before the search completed
//   infeasible     the search completed without a feasible set: there is none
//                  in the search space
//   undecided      the time limit was reached with no feasible solution
//
// `scope` names the search space a completed status speaks for: 'candidates'
// on the exhaustive path, 'spendable' on the mixed-integer path.

import { checkSpend, candidateSet, OracleRefusal } from './spend.mjs';
import { makeBoundModel } from './bound.mjs';
import { makeEvaluator, setKey, loadLibraryPolicies, BUILT_IN_POLICIES } from './policies.mjs';
import { exhaustiveSearch } from './exhaustive.mjs';
import { mipSearch, loadSolver, SOLVER_VERSION } from './mip.mjs';
import { oracleSettings, TIME_LIMIT_MS } from './settings.mjs';
import { spendable, cmpRef } from '../state/state.mjs';
import { inspectTx } from '../kit/inspect.mjs';

const summary = (ev) => ev && { fee: ev.fee, txFee: ev.txFee, minFee: ev.minFee, size: ev.size, k: ev.k, inputs: ev.inputs, hash: ev.hash };

// incumbents: [{ name, walletInputs [ref], bytes (hex), fee }], the methods'
// transactions that passed the kit's checks. path: 'auto', 'exhaustive' or
// 'mip'; mipSpace: 'spendable' (the setting's) or 'candidates' (for the
// comparison of the two paths). onProgress(best) is called whenever the best
// improves.
export async function searchOracle(T, state, spend, params, policy, opts = {}) {
  const t0 = performance.now();
  const timeLimitMs = opts.timeLimitMs ?? TIME_LIMIT_MS;
  const deadline = t0 + timeLimitMs;
  // One solve of the program is capped at a tenth of the limit (at least a
  // second), so that a slow proof still leaves time to rebuild other sets.
  const iterationMs = Math.max(1000, timeLimitMs / 10);
  const settings = opts.settings || oracleSettings();
  const path = opts.path || 'auto';
  const onProgress = opts.onProgress || (() => {});
  checkSpend(spend);
  const highs = path === 'exhaustive' ? null : await loadSolver();
  const model = makeBoundModel(state, spend, params, settings);
  const lib = BUILT_IN_POLICIES.includes(policy) ? null : await loadLibraryPolicies();
  const ev = makeEvaluator(T, { state, spend, params, policy, settings, lib });
  try {
    let best = null;
    let bestFrom = null;
    let phase = 'incumbent';
    const improve = (e) => {
      best = e;
      bestFrom = phase;
      onProgress(summary(e), e.bytes);
    };
    // Incumbents, each evaluated by the policy on its own input set.
    const incumbents = [];
    for (const inc of opts.incumbents || []) {
      const refs = [...inc.walletInputs].sort(cmpRef);
      const S = refs.map((r) => state.utxos.get(r));
      const rec = { name: inc.name, fee: inc.fee === undefined ? null : BigInt(inc.fee), inputs: refs.length };
      if (S.some((u) => !u || u.held !== null)) {
        rec.result = 'not-in-state';
        incumbents.push(rec);
        continue;
      }
      const e = await ev.evaluate(S);
      rec.result = e.ok ? 'feasible' : e.class;
      if (e.ok) {
        rec.oracleFee = e.fee;
        if (inc.bytes) rec.sameChange = sameChange(inc.bytes, spend.requested.length, e);
        if (!best || e.fee < best.fee) improve(e);
      } else rec.detail = e.detail;
      incumbents.push(rec);
    }
    phase = 'search';
    const cs = candidateSet(state, spend);
    const chosen = path === 'auto' ? (cs.exhaustive ? 'exhaustive' : 'mip') : path;
    let status;
    let scope;
    let detail = {};
    let candidates;
    if (chosen === 'exhaustive') {
      candidates = cs.all.length;
      scope = 'candidates';
      const r = await exhaustiveSearch({ model, candidates: cs.all, evaluate: ev.evaluate, best, deadline, onImprove: improve });
      best = r.best;
      detail = { nodes: r.nodes, popped: r.popped, evaluated: r.evaluated, pruned: r.pruned };
      status = r.complete ? (best ? 'optimal' : 'infeasible') : best ? 'best-at-limit' : 'undecided';
      if (r.complete && !best && settings.exhaustiveEmpty === 'mip' && path === 'auto') {
        const pool = spendable(state);
        const m = await mipSearch({ highs: highs || (await loadSolver()), model, pool, evaluate: ev.evaluate, best, deadline, iterationMs, onImprove: improve });
        best = m.best;
        detail.fallback = mipDetail(m);
        candidates = pool.length;
        scope = 'spendable';
        status = m.proven ? (best ? 'optimal' : 'infeasible') : best ? 'best-at-limit' : 'undecided';
      }
    } else {
      const pool = opts.mipSpace === 'candidates' ? cs.all : spendable(state);
      candidates = pool.length;
      scope = opts.mipSpace === 'candidates' ? 'candidates' : 'spendable';
      const m = await mipSearch({ highs, model, pool, evaluate: ev.evaluate, best, deadline, iterationMs, onImprove: improve });
      best = m.best;
      detail = mipDetail(m);
      status = m.proven ? (best ? 'optimal' : 'infeasible') : best ? 'best-at-limit' : 'undecided';
    }
    const ms = performance.now() - t0;
    // Whether the reference lies in the search space a completed status
    // speaks for (an incumbent may lie outside the exhaustive path's
    // candidates).
    const space = new Set((scope === 'candidates' ? cs.all : spendable(state)).map((u) => u.ref));
    return {
      status,
      path: chosen,
      scope,
      candidates,
      policy,
      fee: best ? best.fee : null,
      tx: best ? best.bytes : null,
      best: summary(best),
      bestFrom,
      bestInSpace: best ? best.inputs.every((r) => space.has(r)) : null,
      ms,
      incumbents,
      evaluations: { ...ev.stats },
      detail,
      settings,
      solver: highs ? `highs ${SOLVER_VERSION}` : null
    };
  } finally {
    ev.dispose();
  }
}

function mipDetail(m) {
  return { iterations: m.iterations, strict: m.strict, rejections: m.rejections, feeDiffers: m.feeDiffers, maxFeeAbove: m.maxFeeAbove, feeBelow: m.feeBelow, cols: m.cols, rows: m.rows, solverMs: Math.round(m.solverMs), statuses: m.statuses };
}

// Whether a method's transaction carries the same change outputs, byte for
// byte, as the policy's transaction from the same inputs.
function sameChange(bytes, nReq, e) {
  const t = inspectTx(bytes);
  const mine = t.outputs.slice(nReq).map((o) => o.raw.toString('hex'));
  const theirs = e.change.map((c) => c.cbor);
  return mine.length === theirs.length && mine.every((x, i) => x === theirs[i]);
}

export { OracleRefusal, setKey };
