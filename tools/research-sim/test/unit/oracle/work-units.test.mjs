// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The program path's size-weighted work counts (mip.mjs): on a program small
// enough to count by hand, exact values, checked against the matrix HiGHS
// receives and the nodes and iterations it reports for each solve; the same
// on repeats; and, with the treatment, the same from two oracle workers on a
// synthetic shape.

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
      solves.push({ nnz, rows, cols: data.numCols, nodes: Number(m.info.get('mip_node_count')), iterations: Number(m.info.get('simplex_iteration_count')) });
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
  const budget = { maxSets: 100, maxSolves: 100, maxNodes: 1000, maxSolveNodes: 100 };
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
