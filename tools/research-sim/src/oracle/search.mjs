// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// One oracle run, in the calling thread: for one wallet state, one battery
// spend and one change policy, the least-fee feasible single-transaction
// selection the search finds within its work budget, reported as an upper
// bound on the true optimum.
//
// The run starts from its incumbents (setting incumbents 'seeded-methods'):
// the input set of every seeded method's transaction with the same change
// policy on the same spend that passed the kit's checks, each evaluated
// exactly by the policy, so the reference is never above a fee such a method
// reached. It then takes the exhaustive path when the candidate set numbers
// at most 24, and the mixed-integer path over every spendable UTxO otherwise
// (setting searchSpace). An exhaustive search that completes within the
// budget is followed by the program over every spendable UTxO for the rest
// of the budget, starting from the best found so far, and the lower fee is
// kept (setting afterExhaustive 'mip-always'; 'mip' runs the program only
// when the exhaustive search finds nothing, 'report' never).
//
// The budget (setting limit 'budget'): maxCandidateSets candidate sets
// evaluated exactly, the exhaustive search's and the program's together; the
// program's maxSolves solves and maxNodes branch-and-bound nodes, each solve
// capped at maxSolveNodes (mip.mjs). The
// incumbents are evaluated apart, uncounted, so a reference's search does
// not grow with the number of runs that seed it. Under limit 'wall-clock'
// the run stops at timeLimitMs instead. Either way `work` reports what the
// run used and `stop` which limit ended it (exhaustive.mjs, mip.mjs); its
// size-weighted counts (nnzSolves, nnzNodes, nnzIterations,
// nnzSolvesPlusIterations, mip.mjs) are recorded and limit nothing.
// Statuses, from the last search that ran:
//
//   optimal        the search completed: the exhaustive path's queue ran out
//                  at a bound at or above the best fee, or the program with
//                  its cutoff became infeasible; the reference is the optimum
//                  over the search space (or an incumbent below it)
//   best-at-limit  a feasible solution exists, and the search stopped before
//                  it completed: at a budget limit (or the time limit), or
//                  for another reason the stop names, such as a second
//                  solver failure
//   infeasible     the search completed without a feasible set: there is none
//                  in the search space
//   undecided      the search stopped before it completed, with no feasible
//                  solution
//
// `scope` names the search space the status speaks for: 'spendable' when the
// program ran over every spendable UTxO, or when the candidate set holds every
// spendable UTxO (the exhaustive search then searched the whole pool, and no
// program follows it, since none could find a lower fee); 'candidates' when
// the search covered the candidate set only (the exhaustive search alone, or
// the program forced onto the candidates for the comparison of the paths).
// So under 'mip-always' a run is optimal or
// infeasible over every spendable UTxO only when the program proves it, and
// a completed exhaustive search alone proves nothing over the pool; the
// exhaustive search's own result over the candidates is kept beside it as
// `exhaustive`. `bound` is a lower bound on the optimum over the scope: the
// fee when optimal, the lower of the fee and the program's bound when the
// program stopped unproven, and null when nothing bounds it. `bestFrom` names
// what produced the reference: 'incumbent', 'exhaustive' or 'mip'.

import { checkSpend, candidateSet, OracleRefusal } from './spend.mjs';
import { makeBoundModel } from './bound.mjs';
import { makeEvaluator, setKey, loadLibraryPolicies, BUILT_IN_POLICIES } from './policies.mjs';
import { exhaustiveSearch } from './exhaustive.mjs';
import { mipSearch, loadSolver, SOLVER_VERSION } from './mip.mjs';
import { oracleSettings, TIME_LIMIT_MS } from './settings.mjs';
import { spendable, cmpRef } from '../state/state.mjs';
import { inspectTx } from '../kit/inspect.mjs';

const summary = (ev) => ev && { fee: ev.fee, txFee: ev.txFee, minFee: ev.minFee, size: ev.size, k: ev.k, inputs: ev.inputs };

// incumbents: [{ name, seeded, walletInputs [ref], bytes (hex), fee }], the
// methods' transactions that passed the kit's checks; under incumbents
// 'seeded-methods' each must be seeded. path: 'auto', 'exhaustive' or
// 'mip'; mipSpace: 'spendable' (the setting's) or 'candidates' (for the
// comparison of the two paths); timeLimitMs: under limit 'wall-clock' only.
// onProgress(best) is called whenever the best improves.
export async function searchOracle(T, state, spend, params, policy, opts = {}) {
  const t0 = performance.now();
  const settings = opts.settings || oracleSettings();
  const budgeted = settings.limit === 'budget';
  if (budgeted && opts.timeLimitMs !== undefined) throw new Error('timeLimitMs applies only under the oracle setting limit=wall-clock');
  const timeLimitMs = budgeted ? null : opts.timeLimitMs ?? TIME_LIMIT_MS;
  const deadline = budgeted ? Infinity : t0 + timeLimitMs;
  // Under the wall-clock limit one solve of the program is capped at a tenth
  // of the limit (at least a second), so that a slow proof still leaves time
  // to rebuild other sets.
  const iterationMs = budgeted ? null : Math.max(1000, timeLimitMs / 10);
  const programBudget = (used) => (budgeted ? { maxSets: settings.maxCandidateSets - used, maxSolves: settings.maxSolves, maxNodes: settings.maxNodes, maxSolveNodes: settings.maxSolveNodes } : null);
  const path = opts.path || 'auto';
  const onProgress = opts.onProgress || (() => {});
  checkSpend(spend);
  if (settings.incumbents === 'seeded-methods') {
    const unseeded = (opts.incumbents || []).filter((i) => i.seeded !== true);
    if (unseeded.length) throw new Error(`incumbents from methods whose answers are not seeded: ${[...new Set(unseeded.map((i) => i.name))].join(', ')} (oracle setting incumbents=seeded-methods)`);
  }
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
    // Incumbents, each evaluated by the policy on its own input set, apart
    // from the budget.
    const incumbents = [];
    let incumbentSets = 0;
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
      incumbentSets++;
      rec.result = e.ok ? 'feasible' : e.class;
      if (e.ok) {
        rec.oracleFee = e.fee;
        if (inc.bytes) rec.sameChange = sameChange(inc.bytes, spend.requested.length, e);
        if (!best || e.fee < best.fee) improve(e);
      } else rec.detail = e.detail;
      incumbents.push(rec);
    }
    const cs = candidateSet(state, spend);
    const chosen = path === 'auto' ? (cs.exhaustive ? 'exhaustive' : 'mip') : path;
    const paths = [];
    let result;
    let scope;
    let detail = {};
    let candidates;
    let exhaustive = null;
    let stop;
    const work = { candidateSets: 0, solves: 0, nodes: 0, mostSolveNodes: 0, lpIterations: 0, incumbentSets, queuePops: 0, nnzSolves: 0, nnzNodes: 0, nnzIterations: 0, nnzSolvesPlusIterations: 0 };
    const addProgram = (m) => {
      work.candidateSets += m.sets;
      work.solves += m.iterations;
      work.nodes += m.nodes;
      if (m.mostSolveNodes > work.mostSolveNodes) work.mostSolveNodes = m.mostSolveNodes;
      work.lpIterations += m.lpIterations;
      work.nnzSolves += m.nnzSolves;
      work.nnzNodes += m.nnzNodes;
      work.nnzIterations += m.nnzIterations;
      work.nnzSolvesPlusIterations += m.nnzSolvesPlusIterations;
    };
    if (chosen === 'exhaustive') {
      phase = 'exhaustive';
      paths.push('exhaustive');
      const pool = spendable(state);
      // The candidates are drawn from the spendable UTxOs, so equal counts
      // mean the candidate set is the whole pool.
      const coversPool = cs.all.length === pool.length;
      candidates = cs.all.length;
      scope = coversPool ? 'spendable' : 'candidates';
      const r = await exhaustiveSearch({ model, candidates: cs.all, evaluate: ev.evaluate, best, maxSets: budgeted ? settings.maxCandidateSets : Infinity, deadline, onImprove: improve });
      best = r.best;
      detail = { nodes: r.nodes, popped: r.popped, evaluated: r.evaluated, pruned: r.pruned, stop: r.stop };
      work.candidateSets += r.evaluated;
      work.queuePops += r.popped;
      stop = r.stop;
      result = statusOf({ proven: r.complete, best });
      exhaustive = { complete: r.complete, status: result.status, fee: best ? best.fee : null, coversPool };
      if (path === 'auto' && programFollows(settings.afterExhaustive, { complete: r.complete, found: best !== null, coversPool })) {
        phase = 'mip';
        paths.push('mip');
        const m = await mipSearch({ highs: highs || (await loadSolver()), model, pool, evaluate: ev.evaluate, best, budget: programBudget(r.evaluated), seed: settings.solverSeed, deadline, iterationMs, onImprove: improve });
        best = m.best;
        detail.mip = mipDetail(m);
        addProgram(m);
        stop = m.stop;
        candidates = pool.length;
        scope = 'spendable';
        result = statusOf({ proven: m.proven, best, programBound: m.bound });
      }
    } else {
      phase = 'mip';
      paths.push('mip');
      const pool = opts.mipSpace === 'candidates' ? cs.all : spendable(state);
      candidates = pool.length;
      scope = opts.mipSpace === 'candidates' ? 'candidates' : 'spendable';
      const m = await mipSearch({ highs, model, pool, evaluate: ev.evaluate, best, budget: programBudget(0), seed: settings.solverSeed, deadline, iterationMs, onImprove: improve });
      best = m.best;
      detail = mipDetail(m);
      addProgram(m);
      stop = m.stop;
      result = statusOf({ proven: m.proven, best, programBound: m.bound });
    }
    const ms = performance.now() - t0;
    // Whether the reference lies in the search space a completed status
    // speaks for (an incumbent may lie outside the exhaustive path's
    // candidates).
    const space = new Set((scope === 'candidates' ? cs.all : spendable(state)).map((u) => u.ref));
    const inCandidates = new Set(cs.all.map((u) => u.ref));
    return {
      status: result.status,
      path: chosen,
      paths,
      scope,
      candidates,
      candidateSet: cs.all.length,
      policy,
      fee: best ? best.fee : null,
      bound: result.bound,
      tx: best ? best.bytes : null,
      best: summary(best),
      bestFrom,
      bestInSpace: best ? best.inputs.every((r) => space.has(r)) : null,
      bestInCandidates: best ? best.inputs.every((r) => inCandidates.has(r)) : null,
      exhaustive,
      stop,
      work,
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

// Whether the program over every spendable UTxO follows an exhaustive
// search, by the setting afterExhaustive: complete, whether the search
// completed; found, whether a feasible set is known; coversPool, whether the
// candidate set holds every spendable UTxO, when a completed search already
// speaks for the pool and no program follows it under any value.
export function programFollows(afterExhaustive, { complete, found, coversPool }) {
  if (!['mip-always', 'mip', 'report'].includes(afterExhaustive)) throw new Error(`afterExhaustive ${afterExhaustive} is not implemented`);
  if (!complete || coversPool) return false;
  if (afterExhaustive === 'mip-always') return true;
  if (afterExhaustive === 'mip') return !found;
  return false;
}

// The status and the lower bound of a run from its last search: proven,
// whether that search completed; best, the best evaluation or null;
// programBound, the program's bound in lovelace when the program ran.
export function statusOf({ proven, best, programBound = null }) {
  if (proven) return best ? { status: 'optimal', bound: best.fee } : { status: 'infeasible', bound: null };
  const pb = programBound === null ? null : BigInt(programBound);
  if (best) return { status: 'best-at-limit', bound: pb === null ? null : pb < best.fee ? pb : best.fee };
  return { status: 'undecided', bound: pb };
}

function mipDetail(m) {
  return { stop: m.stop, bound: m.bound, iterations: m.iterations, sets: m.sets, refuted: m.refuted, nodes: m.nodes, mostSolveNodes: m.mostSolveNodes, lpIterations: m.lpIterations, strict: m.strict, rejections: m.rejections, solverErrors: m.solverErrors, feeDiffers: m.feeDiffers, maxFeeAbove: m.maxFeeAbove, feeBelow: m.feeBelow, cols: m.cols, rows: m.rows, solverMs: Math.round(m.solverMs), statuses: m.statuses, nnz: m.nnz, rowsLast: m.rowsLast, nnzLast: m.nnzLast };
}

// Whether a method's transaction carries the same change outputs, byte for
// byte, as the policy's transaction from the same inputs.
export function sameChange(bytes, nReq, e) {
  const t = inspectTx(bytes);
  const mine = t.outputs.slice(nReq).map((o) => o.raw.toString('hex'));
  const theirs = e.change.map((c) => c.cbor);
  return mine.length === theirs.length && mine.every((x, i) => x === theirs[i]);
}

export { OracleRefusal, setKey };
