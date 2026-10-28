// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The mixed-integer path: a relaxation of the fee bound of bound.mjs over a
// pool of UTxOs (every spendable UTxO, by the setting searchSpace), solved by
// HiGHS (the npm package highs at 1.15.4, HiGHS compiled to WebAssembly,
// single-threaded; github.com/lovasoa/highs-js and github.com/ERGO-Code/HiGHS),
// each chosen set rebuilt exactly by the change policy and checked by the
// ledger kit.
//
// Variables: x_u in {0, 1} per UTxO (selected); r_j for each asset held by
// more than one UTxO or requested (its entry returned in change; a requested
// asset's entry is returned only when the inputs hold more than the request);
// pi_p (a change entry for policy p); w_k (a witness for payment key k); c
// (token change); o (a change output); B (the bytes); F (the fee in ADA, the
// objective). On a small pool (at most STRICT_POOL UTxOs) r of a requested
// asset and o are binary and the no-change branch below is kept; on a larger
// pool they are continuous and the branch is dropped, which keeps the program
// a relaxation (a weaker bound) while sparing the solver the subset-sum
// problems that deciding an exact cover or an exact leftover poses.
// Constraints:
//
//   coverage      sum_u q_uj x_u >= request_j for every requested asset
//   returned      r_j >= x_u for an unrequested asset held by several UTxOs
//                 (an asset held by one UTxO is charged to that UTxO's x_u);
//                 sum_u q_uj x_u - request_j <= (held_j - request_j) r_j for a
//                 requested one; pi_p >= every entry of p; c >= pi_p; o >= c;
//                 w_k >= x_u for every UTxO of key k
//   bytes         B = the fixed bytes of bound.mjs + the inputs' bytes + 101
//                 per witness + the ADA-only change output's bytes times o +
//                 the token change's extra bytes (2 c, 31 per policy entry,
//                 each returned entry's name and shortest quantity);
//                 B <= maxTxSize
//   fee           F >= minFeeA * B + minFeeB; on a small pool under setFee
//                 'as-built' also F >= the inputs' coin - the requested coin
//                 - M o (with no change output the fee takes the whole
//                 leftover)
//   coin          the inputs' coin >= the requested coin + F + the minimum of
//                 the ADA-only change output times o + coinsPerUtxoByte times
//                 the token change's extra bytes
//   nonempty      at least one input
//   cutoff        F <= the best exact fee found, less one lovelace
//   no-good       sum over S of x_u - sum outside S of x_u <= |S| - 1 for
//                 every set S already rebuilt exactly
//
// Every term is at most what the exact transaction holds, so the program's
// optimum is a lower bound on the fee of every set it has not excluded. The
// loop solves, rebuilds the chosen set exactly, keeps it when it is feasible
// and cheaper than the best, cuts it off, and solves again, until the program
// is infeasible (no remaining set can beat the best, which is then the
// optimum over the pool, or there is none) or the time limit passes. A
// rebuild whose transaction fails a check, or whose exact fee differs from
// the program's, is recorded as a rejection.
//
// The program's bound: the highest dual bound any solve reported, in
// lovelace rounded down. Cuts and a lower cutoff only shrink the program, so
// a bound reported by any solve holds for every set still admitted, and
// every set excluded was rebuilt exactly, refuted by the bound's exact
// conditions, or costs at least the best fee; the optimum over the pool is
// therefore at least the lower of the best fee and this bound. The loop records why it stopped: 'proven' (the program is
// infeasible, or the pool cannot hold the spend), 'limit' (the time limit),
// 'solver-error' (a second solver failure), 'status' (a solve ended without
// a set for another reason, named in statuses) or 'empty' (a solve chose no
// input).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { headSize } from '../history/cbor.mjs';
import { inputBytes, indexOfRef, VKEY_WITNESS_BYTES, boundOf } from './bound.mjs';

export const SOLVER_PACKAGE = 'highs';
export const SOLVER_VERSION = '1.15.4';

const key = (a) => `${a.policy}.${a.name}`;
const ADA = 1e6;

let solver = null;
// The solver, one instance per thread; { fresh: true } replaces an instance
// that has aborted.
export async function loadSolver({ fresh = false } = {}) {
  if (solver && !fresh) return solver;
  const req = createRequire(import.meta.url);
  // The package exports no package.json; its entry is build/highs.js.
  const manifest = JSON.parse(readFileSync(join(dirname(req.resolve(SOLVER_PACKAGE)), '..', 'package.json'), 'utf8'));
  if (manifest.name !== SOLVER_PACKAGE) throw new Error(`the solver's manifest names ${manifest.name}`);
  if (manifest.version !== SOLVER_VERSION) throw new Error(`${SOLVER_PACKAGE} ${manifest.version} is installed; the oracle pins ${SOLVER_VERSION}`);
  const mod = await import(SOLVER_PACKAGE);
  solver = await mod.default();
  return solver;
}

const ratio = (p, q) => Number((p * 1000000000000n) / q) / 1e12;

// The least count of values, largest first, that reach `need`; null when all
// of them do not.
export function leastCount(values, need) {
  if (need <= 0n) return 0;
  const v = values.filter((x) => x > 0n).sort((x, y) => (x > y ? -1 : x < y ? 1 : 0));
  let acc = 0n;
  for (let i = 0; i < v.length; i++) {
    acc += v[i];
    if (acc >= need) return i + 1;
  }
  return null;
}

function mergeEntries(entries) {
  const m = new Map();
  for (const [j, v] of entries) m.set(j, (m.get(j) || 0) + v);
  return [...m].filter(([, v]) => v !== 0).sort((p, q) => p[0] - q[0]);
}

// The program for a pool of UTxO records: { data (highs ModelData), x (the
// selection columns), F, cutoffRow }, or null when the pool lacks a requested
// asset.
export const STRICT_POOL = 40;

export function buildProgram(highs, M, pool) {
  const strict = pool.length <= STRICT_POOL;
  const INF = highs.infinity;
  const lower = [];
  const upper = [];
  const cost = [];
  const integ = [];
  const col = (lo, hi, c, integer) => {
    lower.push(lo);
    upper.push(hi);
    cost.push(c);
    integ.push(integer ? 1 : 0);
    return lower.length - 1;
  };
  const rows = [];
  const row = (lo, hi, entries) => rows.push({ lo, hi, entries }) - 1;

  const x = pool.map(() => col(0, 1, 0, true));
  const F = col(0, INF, 1, false);
  const B = col(0, M.maxTxSize, 0, false);
  const o = col(0, 1, 0, strict);
  const c = col(0, 1, 0, false);

  const holders = new Map();
  pool.forEach((u, i) => {
    for (const a of u.assets) {
      const k = key(a);
      if (!holders.has(k)) holders.set(k, { policy: a.policy, name: a.name, list: [] });
      holders.get(k).list.push([i, a.qty]);
    }
  });
  for (const k of M.req.keys()) if (!holders.has(k)) return null;

  // Byte terms: every term of B, and those of the token change, which the
  // coin row prices at coinsPerUtxoByte.
  const bytes = [];
  const tokenBytes = [];
  pool.forEach((u, i) => bytes.push([x[i], inputBytes(indexOfRef(u.ref))]));
  bytes.push([o, M.adaOutBytes]);
  bytes.push([c, 2]);
  tokenBytes.push([c, 2]);
  const pis = new Map();
  const piOf = (p) => {
    if (!pis.has(p)) {
      const j = col(0, 1, 0, false);
      pis.set(p, j);
      bytes.push([j, headSize(28) + 28 + 1]);
      tokenBytes.push([j, headSize(28) + 28 + 1]);
      row(0, INF, [[c, 1], [j, -1]]);
    }
    return pis.get(p);
  };
  for (const [k, h] of holders) {
    const nameLen = h.name.length / 2;
    const req = M.req.get(k) || 0n;
    const held = h.list.reduce((s, [, q]) => s + q, 0n);
    const pi = piOf(h.policy);
    if (req === 0n && h.list.length === 1) {
      const [i, q] = h.list[0];
      const e = headSize(nameLen) + nameLen + headSize(q);
      bytes.push([x[i], e]);
      tokenBytes.push([x[i], e]);
      row(0, INF, [[pi, 1], [x[i], -1]]);
    } else if (req === 0n) {
      const minQ = h.list.reduce((m, [, q]) => (q < m ? q : m), h.list[0][1]);
      const r = col(0, 1, 0, false);
      const e = headSize(nameLen) + nameLen + headSize(minQ);
      bytes.push([r, e]);
      tokenBytes.push([r, e]);
      for (const [i] of h.list) row(0, INF, [[r, 1], [x[i], -1]]);
      row(0, INF, [[pi, 1], [r, -1]]);
    } else {
      // Coverage, scaled by the request so its tolerance is relative, and
      // the least number of holders that reach the request (largest first).
      row(1, INF, h.list.map(([i, q]) => [x[i], ratio(q, req)]));
      const n = leastCount(h.list.map(([, q]) => q), req);
      if (n === null) return null;
      row(n, INF, h.list.map(([i]) => [x[i], 1]));
      if (held > req) {
        const r = col(0, 1, 0, strict);
        const e = headSize(nameLen) + nameLen + 1;
        bytes.push([r, e]);
        tokenBytes.push([r, e]);
        row(-INF, ratio(req, held), [...h.list.map(([i, q]) => [x[i], ratio(q, held)]), [r, -ratio(held - req, held)]]);
        row(0, INF, [[pi, 1], [r, -1]]);
      }
    }
  }
  // Witnesses: one per distinct key; with one key in the pool it is a
  // constant, since every set holds at least one input.
  const creds = [...new Set(pool.map((u) => u.cred))];
  let constBytes = 1 + (1 + 1 + 1 + 1 + headSize(M.reqCount) + M.reqBytes + 1 + M.feeField) + (1 + 1 + 1) + 1;
  if (creds.length === 1) constBytes += VKEY_WITNESS_BYTES;
  else {
    for (const cr of creds) {
      const w = col(0, 1, 0, false);
      bytes.push([w, VKEY_WITNESS_BYTES]);
      pool.forEach((u, i) => {
        if (u.cred === cr) row(0, INF, [[w, 1], [x[i], -1]]);
      });
    }
  }
  row(0, INF, [[o, 1], [c, -1]]);
  row(constBytes, constBytes, [[B, 1], ...bytes.map(([j, v]) => [j, -v])]);
  row(Number(M.b) / ADA, INF, [[F, 1], [B, -Number(M.a) / ADA]]);
  const coinAda = pool.map((u) => Number(u.coin) / ADA);
  const reqAda = Number(M.reqCoin) / ADA;
  if (!M.ledgerMinimum && strict) {
    const big = coinAda.reduce((s, v) => s + v, 0) + 1;
    row(-reqAda, INF, [[F, 1], ...x.map((j, i) => [j, -coinAda[i]]), [o, big]]);
  }
  const rho = Number(M.rho) / ADA;
  row(reqAda, INF, [...x.map((j, i) => [j, coinAda[i]]), [F, -1], [o, -rho * (160 + M.adaOutBytes)], ...tokenBytes.map(([j, v]) => [j, -rho * v])]);
  row(1, INF, x.map((j) => [j, 1]));
  // The least number of inputs whose coin less their own input fee reaches
  // the requested coin and the least fee.
  const eff = pool.map((u) => u.coin - M.a * BigInt(inputBytes(indexOfRef(u.ref))));
  const nCoin = leastCount(eff, M.reqCoin + M.b + M.a * BigInt(constBytes));
  if (nCoin === null) return null;
  if (nCoin > 1) row(nCoin, INF, x.map((j) => [j, 1]));
  const cutoffRow = row(-INF, INF, [[F, 1]]);

  const starts = [0];
  const indices = [];
  const values = [];
  const rowLower = [];
  const rowUpper = [];
  for (const r of rows) {
    for (const [j, v] of mergeEntries(r.entries)) {
      indices.push(j);
      values.push(v);
    }
    starts.push(indices.length);
    rowLower.push(r.lo);
    rowUpper.push(r.hi);
  }
  const numCols = lower.length;
  return {
    data: {
      numCols,
      numRows: rows.length,
      colCost: cost,
      colLower: lower,
      colUpper: upper,
      rowLower,
      rowUpper,
      matrix: { format: 'csr', numRows: rows.length, numCols, starts, indices, values },
      integrality: integ
    },
    x,
    F,
    cutoffRow,
    strict,
    cols: numCols,
    rows: rows.length
  };
}

// The dual bound of the last solve in lovelace, rounded down, or null when
// the solve reported none.
function dualBound(model) {
  let v;
  try {
    v = model.info.get('mip_dual_bound');
  } catch {
    return null;
  }
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v * ADA) : null;
}

// The loop. pool: UTxO records; evaluate(S): policies.mjs, resolving to an
// evaluation; best: the incumbent evaluation or null. Resolves to { proven,
// stop, bound, best, iterations, rejections, solverErrors, cols, rows,
// solverMs }.
//
// HiGHS 1.15.4's presolve aborts on some of these programs once enough cuts
// have been added (a RuntimeError from the WebAssembly runtime, which leaves
// that solver instance unusable; reproduced deterministically, and never with
// presolve off). On any solver failure the loop takes a fresh solver
// instance, rebuilds the program with every cut so far and the cutoff, turns
// presolve off for the rest of the run, and goes on; a second failure ends
// the run, unproven. Every failure is recorded.
export async function mipSearch({ highs, model: M, pool, evaluate, best = null, deadline = Infinity, iterationMs = 6000, onImprove = () => {} }) {
  let H = highs;
  const prog = buildProgram(H, M, pool);
  // feeBelow counts exact fees under the program's value, which would mean
  // the relaxation is not a lower bound; the checks require it to stay 0.
  const out = { proven: false, stop: null, bound: null, best, iterations: 0, rejections: [], solverErrors: [], feeDiffers: 0, maxFeeAbove: 0, feeBelow: 0, cols: 0, rows: 0, solverMs: 0, statuses: {} };
  if (!prog) {
    out.proven = true;
    out.stop = 'proven';
    return out;
  }
  out.cols = prog.cols;
  out.rows = prog.rows;
  out.strict = prog.strict;
  const cuts = [];
  let presolve = 'on';
  let model = null;
  const open = () => {
    model = H.createModel(prog.data);
    // The WebAssembly build is single-threaded and refuses the threads and
    // parallel options.
    model.options.set({ output_flag: false, mip_rel_gap: 0, mip_abs_gap: 1e-7, mip_feasibility_tolerance: 1e-9, primal_feasibility_tolerance: 1e-9, presolve });
    for (const c of cuts) model.addRow(-H.infinity, c.upper, c.entries);
    if (out.best) model.changeRowBounds(prog.cutoffRow, -H.infinity, (Number(out.best.fee) - 1) / ADA);
  };
  const close = () => {
    if (!model) return;
    try {
      model.dispose();
    } catch {
      // a solver instance that aborted cannot dispose its models
    }
    model = null;
  };
  try {
    try {
      open();
    } catch (e) {
      // An instance an earlier run left aborted.
      out.solverErrors.push({ iteration: 0, cuts: 0, presolve, error: String(e && (e.message || e)).split('\n')[0] });
      H = await loadSolver({ fresh: true });
      open();
    }
    let uncapped = false;
    for (;;) {
      const left = deadline - performance.now();
      if (left <= 0) {
        out.stop = 'limit';
        break;
      }
      const t0 = performance.now();
      let st;
      try {
        model.zeroAllClocks();
        // Each solve is capped, so that a program whose optimum is slow to
        // prove still yields sets to rebuild.
        model.options.set({ time_limit: Math.max(0.01, Math.min(left, uncapped ? left : iterationMs) / 1000) });
        model.run();
        st = model.getModelStatus();
      } catch (e) {
        out.solverMs += performance.now() - t0;
        out.solverErrors.push({ iteration: out.iterations, cuts: cuts.length, presolve, error: String(e && (e.message || e)).split('\n')[0] });
        close();
        // The instance is replaced either way, so that later runs in this
        // thread start from a working solver.
        H = await loadSolver({ fresh: true });
        if (out.solverErrors.length > 1) {
          out.stop = 'solver-error';
          break;
        }
        presolve = 'off';
        open();
        continue;
      }
      out.solverMs += performance.now() - t0;
      out.iterations++;
      const ms = H.constants.modelStatus;
      out.statuses[st] = (out.statuses[st] || 0) + 1;
      if (st === ms.infeasible) {
        out.proven = true;
        out.stop = 'proven';
        break;
      }
      const db = dualBound(model);
      if (db !== null && (out.bound === null || db > out.bound)) out.bound = db;
      let sol = null;
      if ((st === ms.optimal || st === ms.timeLimit || st === ms.objectiveBound) && model.info.get('primal_solution_status') === 2) {
        const sv = model.getSolution();
        if (sv && sv.colValue && sv.colValue.length) sol = sv.colValue;
      }
      if (!sol) {
        // No set yet within the cap: the next solve takes the time left.
        if (st === ms.timeLimit && !uncapped && deadline - performance.now() > 0) {
          uncapped = true;
          continue;
        }
        out.stop = st === ms.timeLimit ? 'limit' : 'status';
        break;
      }
      const idx = [];
      prog.x.forEach((j, i) => {
        if (sol[j] > 0.5) idx.push(i);
      });
      if (!idx.length) {
        out.stop = 'empty';
        break;
      }
      const S = idx.map((i) => pool[i]);
      const relaxed = sol[prog.F] * ADA;
      // The program can propose a set that fails the bound's exact
      // conditions: on a large pool its return and change indicators are
      // continuous, so it charges the change and its minimum only in part,
      // and its tolerances can admit a set a little short of a request.
      // Such a set is refuted by the bound (bound.mjs boundOf) without a
      // rebuild, and cut off like any other.
      const bd = boundOf(M, S);
      const ev = bd.feasible ? await evaluate(S) : { ok: false, class: 'bound', detail: !bd.covers ? 'a requested asset is not covered' : bd.coinIn < bd.need ? 'the coin falls short' : 'the bytes pass the size limit' };
      if (!ev.ok) out.rejections.push({ inputs: S.length, reason: ev.class, detail: ev.detail, relaxedFee: Math.round(relaxed) });
      else {
        const d = Number(ev.fee) - relaxed;
        if (Math.abs(d) >= 0.5) {
          out.feeDiffers++;
          if (d > out.maxFeeAbove) out.maxFeeAbove = Math.round(d);
          if (d < 0 && st === ms.optimal) out.feeBelow++;
        }
      }
      if (ev.ok && (!out.best || ev.fee < out.best.fee)) {
        out.best = ev;
        onImprove(ev);
        model.changeRowBounds(prog.cutoffRow, -H.infinity, (Number(out.best.fee) - 1) / ADA);
      }
      // The no-good cut on the set.
      const inSet = new Set(idx);
      const cut = { upper: idx.length - 1, entries: { indices: prog.x, values: prog.x.map((_, i) => (inSet.has(i) ? 1 : -1)) } };
      cuts.push(cut);
      model.addRow(-H.infinity, cut.upper, cut.entries);
    }
  } finally {
    close();
  }
  return out;
}
