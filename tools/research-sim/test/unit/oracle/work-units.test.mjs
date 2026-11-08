// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The program path's size-weighted work counts (mip.mjs): on a program small
// enough to count by hand, exact values, checked against the matrix HiGHS
// receives and the nodes and iterations it reports for each solve; the same
// on repeats; the budget on nnzSolvesPlusIterations, its per-solve cap, the
// solve that follows a capped one without a set, and its stop; and, with the
// treatment, the same counts from two oracle workers on a synthetic shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProgram, mipSearch, loadSolver, ITERATION_WEIGHT } from '../../../src/oracle/mip.mjs';
import { boundOf } from '../../../src/oracle/bound.mjs';
import { treatment, skip, TREATMENT_DIR } from '../../lib/treatment.mjs';
import { createOracle } from '../../../src/oracle/oracle.mjs';
import { oracleSettings } from '../../../src/oracle/settings.mjs';
import { shapeState } from '../../../src/shapes/shapes.mjs';
import { standardBattery, SHAPE_POOLS } from '../../../src/battery/battery.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';

// A bound model (bound.mjs makeBoundModel's fields) for one requested
// ADA-only output of 2 ADA under the synthetic fee parameters, and a pool of
// three ADA-only UTxOs under one key, each able to pay for it alone.
const M = { a: 44n, b: 155381n, rho: 4310n, req: new Map(), reqCoin: 2000000n, reqBytes: 65, reqCount: 1, addrBytes: 59, feeField: 5, pureMinLB: 969750n, adaOutBytes: 65, ledgerMinimum: false, maxTxSize: 16384 };
const POOL = [5000000n, 3000000n, 2500000n].map((coin, i) => ({ ref: `${'ab'.repeat(32)}#${i}`, coin, assets: [], cred: 'k0', held: null }));
// Each set rebuilt "exactly" at its bound's fee: no CSL.
const evaluate = async (S) => {
  const bd = boundOf(M, S);
  return { ok: true, fee: bd.fee, inputs: S.map((u) => u.ref) };
};

// The solver with every matrix it is given and every solve counted from
// outside mip.mjs: the nonzeros of the model as created plus every row added
// before a solve, and the solve's nodes and simplex iterations.
async function watchedSolver() {
  const H = await loadSolver();
  const solves = [];
  const W = Object.create(H);
  W.createModel = (data) => {
    const m = H.createModel(data);
    let nnz = data.matrix.values.filter((v) => v !== 0).length;
    let rows = data.numRows;
    const addRow = m.addRow.bind(m);
    const run = m.run.bind(m);
    m.addRow = (lo, hi, entries) => {
      nnz += entries.values.filter((v) => v !== 0).length;
      rows++;
      return addRow(lo, hi, entries);
    };
    m.run = (cbs) => {
      const r = run(cbs);
      solves.push({ nnz, rows, cols: data.numCols, nodes: Number(m.info.get('mip_node_count')), iterations: Number(m.info.get('simplex_iteration_count')), status: m.getModelStatus(), holdsSet: m.info.get('primal_solution_status') === 2 });
      return r;
    };
    return m;
  };
  return { W, solves };
}

const counters = (r) => ({ solves: r.iterations, nodes: r.nodes, lpIterations: r.lpIterations, nnzSolves: r.nnzSolves, nnzNodes: r.nnzNodes, nnzIterations: r.nnzIterations, nnzSolvesPlusIterations: r.nnzSolvesPlusIterations, cols: r.cols, rows: r.rows, nnz: r.nnz, rowsLast: r.rowsLast, nnzLast: r.nnzLast });

test('the size-weighted counts on a program counted by hand', async () => {
  const H = await loadSolver();
  // Columns x1..x3, F, B, o, c; rows: o >= c (2 entries), the bytes (B, x1..x3,
  // o, c: 6), the fee (F, B: 2), the fee with no change output (F, x1..x3, o:
  // 5), the coin (x1..x3, F, o, c: 6), at least one input (3), the cutoff
  // (1). No least-count row, since one input reaches the coin; 25 nonzeros
  // over 7 rows and 7 columns, and each cut adds a row of 3.
  const prog = buildProgram(H, M, POOL);
  assert.deepEqual([prog.cols, prog.rows, prog.nnz], [7, 7, 25]);
  assert.equal(prog.data.matrix.values.length, 25);
  assert.equal(prog.data.matrix.values.every((v) => v !== 0), true);

  const { W, solves } = await watchedSolver();
  const budget = { maxSets: 100, maxWork: 1000 };
  const r = await mipSearch({ highs: W, model: M, pool: POOL, evaluate, budget, seed: 0 });
  assert.equal(r.proven, true);
  // Solve k sees the program and k - 1 cuts.
  assert.deepEqual(solves.map((s) => [s.nnz, s.rows, s.cols]), solves.map((_, k) => [25 + 3 * k, 7 + k, 7]));
  const sum = (f) => solves.reduce((t, s) => t + f(s), 0);
  assert.deepEqual(counters(r), {
    solves: solves.length,
    nodes: sum((s) => s.nodes),
    lpIterations: sum((s) => s.iterations),
    nnzSolves: sum((s) => s.nnz),
    nnzNodes: sum((s) => s.nnz * Math.max(1, s.nodes)),
    nnzIterations: sum((s) => s.nnz * s.iterations),
    nnzSolvesPlusIterations: sum((s) => s.nnz + ITERATION_WEIGHT * s.iterations),
    cols: 7,
    rows: 7,
    nnz: 25,
    rowsLast: solves.at(-1).rows,
    nnzLast: solves.at(-1).nnz
  });
  // The values highs 1.15.4 gives with seed 0: two solves, of 25 and 28
  // nonzeros (one set rebuilt, then the cutoff leaves none); 4 simplex
  // iterations and 1 node in the first, none in the second.
  assert.deepEqual(solves.map((x) => [x.nodes, x.iterations]), [[1, 4], [0, 0]]);
  assert.deepEqual(counters(r), { solves: 2, nodes: 1, lpIterations: 4, nnzSolves: 25 + 28, nnzNodes: 25 * 1 + 28 * 1, nnzIterations: 25 * 4 + 28 * 0, nnzSolvesPlusIterations: 25 + 28 + 3 * 4, cols: 7, rows: 7, nnz: 25, rowsLast: 8, nnzLast: 28 });
  // The same on a repeat.
  const again = await mipSearch({ highs: H, model: M, pool: POOL, evaluate, budget, seed: 0 });
  assert.deepEqual(counters(again), counters(r));
});

test('the size-weighted counts are the same from two oracle workers and on a repeat', { skip }, async () => {
  const T = await treatment();
  const s = shapeState(T, 'S8').state;
  const spend = standardBattery(T, s, SYNTHETIC_PARAMS, { pools: SHAPE_POOLS }).find((b) => b.id === 'one-nft');
  const settings = oracleSettings();
  const o = createOracle({ treatmentDir: TREATMENT_DIR, workers: 2 });
  try {
    const call = () => o.oracle(s, spend, SYNTHETIC_PARAMS, 'csl', { incumbents: [], settings });
    // Two calls at once, one in each worker, then a third in whichever is
    // free.
    const [a, b] = await Promise.all([call(), call()]);
    const c = await call();
    assert.equal(o.stats.workersStarted, 2);
    for (const x of [b, c]) {
      assert.deepEqual(x.work, a.work);
      assert.deepEqual([x.detail.mip.nnz, x.detail.mip.rowsLast, x.detail.mip.nnzLast], [a.detail.mip.nnz, a.detail.mip.rowsLast, a.detail.mip.nnzLast]);
    }
    // A proven call whose every solve but the last cut off one set: solve k
    // sees the program and k - 1 cuts of one entry per pool UTxO.
    const m = a.detail.mip;
    const n = a.work.solves;
    assert.equal(a.status, 'optimal');
    assert.ok(n >= 3, `${n} solves`);
    assert.equal(a.work.nnzSolves, n * m.nnz + (a.candidates * n * (n - 1)) / 2);
    assert.equal(m.nnzLast, m.nnz + a.candidates * (n - 1));
    assert.equal(m.rowsLast, m.rows + n - 1);
    assert.equal(a.work.nnzSolvesPlusIterations, a.work.nnzSolves + ITERATION_WEIGHT * a.work.lpIterations);
    assert.ok(a.work.nnzNodes >= a.work.nnzSolves);
  } finally {
    await o.close();
  }
});

// The budget on the same program, whose first solve takes 4 simplex
// iterations (37 units: 25 nonzeros plus 3 times 4) and finds the optimum,
// and whose second (28 nonzeros) proves it. Each solve may use a tenth of the
// budget; HiGHS checks its limits at a first checkpoint before any iteration
// and again after the 4.
test('the program-work budget: a tenth per solve, the solve after a capped one without a set, the stop', async () => {
  const H = await loadSolver();
  const ms = H.constants.modelStatus;
  const run = async (maxWork) => {
    const { W, solves } = await watchedSolver();
    const r = await mipSearch({ highs: W, model: M, pool: POOL, evaluate, budget: { maxSets: 100, maxWork }, seed: 0 });
    const units = solves.map((s) => s.nnz + ITERATION_WEIGHT * s.iterations);
    assert.equal(r.nnzSolvesPlusIterations, units.reduce((a, b) => a + b, 0));
    return { stop: r.stop, proven: r.proven, fee: r.best ? r.best.fee : null, units, solves: solves.map((s) => [s.status, s.iterations, s.holdsSet]), counters: counters(r) };
  };
  // 1,000: a cap of 100 interrupts nothing.
  const free = await run(1000);
  assert.deepEqual([free.stop, free.proven, free.fee, free.units, free.solves], ['proven', true, 167833n, [37, 28], [[ms.optimal, 4, true], [ms.infeasible, 0, false]]]);
  // 300: a cap of 30. The first solve reaches it at the checkpoint after its
  // 4 iterations (37 units, 7 past the cap), interrupted with its set, which
  // is rebuilt; the second, capped again, proves.
  const capped = await run(300);
  assert.deepEqual([capped.stop, capped.proven, capped.fee, capped.units, capped.solves], ['proven', true, 167833n, [37, 28], [[ms.interrupted, 4, true], [ms.infeasible, 0, false]]]);
  // 250: a cap of 25, which the 25 nonzeros reach at once. The first solve
  // is interrupted before any iteration without a set, so the next may use
  // all that is left (225) and finds the optimum; the third proves it.
  const followed = await run(250);
  assert.deepEqual([followed.stop, followed.proven, followed.fee, followed.units, followed.solves], ['proven', true, 167833n, [25, 37, 28], [[ms.interrupted, 0, false], [ms.optimal, 4, true], [ms.infeasible, 0, false]]]);
  // 60: the follow-up may use the 35 left and is interrupted at 37 with its
  // set; the call then stands at 62, past the budget by 2, and stops on it,
  // unproven, with that set's fee.
  const spent = await run(60);
  assert.deepEqual([spent.stop, spent.proven, spent.fee, spent.units, spent.solves], ['program-work', false, 167833n, [25, 37], [[ms.interrupted, 0, false], [ms.interrupted, 4, true]]]);
  // 40: the follow-up starts with 15 left, less than its 25 nonzeros, and is
  // interrupted at its first checkpoint without a set: the call stops on its
  // budget at 50 units, with no set.
  const none = await run(40);
  assert.deepEqual([none.stop, none.proven, none.fee, none.units, none.solves], ['program-work', false, null, [25, 25], [[ms.interrupted, 0, false], [ms.interrupted, 0, false]]]);
  // 25: the first solve uses the whole budget; no solve follows.
  const one = await run(25);
  assert.deepEqual([one.stop, one.units], ['program-work', [25]]);
  // The same budget twice: the same solves and every counter the same.
  for (const w of [1000, 300, 250, 60, 40]) assert.deepEqual(await run(w), await run(w), `maxWork ${w}`);
});
