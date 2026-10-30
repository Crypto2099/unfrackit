// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The oracle's parts that need no treatment: its settings and work budget,
// the incumbents rule, the spends it refuses, the input bytes and counts the
// bounds rest on, the method to policy mapping, the solver's node limit and
// seed, and what it reports and honors for a MIP solve's simplex iterations.
// The searches themselves need cardano-serialization-lib and are
// checked in test/oracle/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oracleSettings, ORACLE_SETTINGS, admitsIncumbent } from '../../../src/oracle/settings.mjs';
import { checkSpend, OracleRefusal } from '../../../src/oracle/spend.mjs';
import { inputBytes } from '../../../src/oracle/bound.mjs';
import { leastCount, loadSolver } from '../../../src/oracle/mip.mjs';
import { policyOfMethod } from '../../../src/oracle/policies.mjs';
import { programFollows, statusOf, searchOracle } from '../../../src/oracle/search.mjs';

const spend = (over = {}) => ({ source: 'battery', requested: [{ cbor: '82', address: 'x', coin: 1n, assets: [], datum: null, scriptRef: null }], implicit: { withdrawals: 0n, refunds: 0n, deposits: 0n, donation: 0n, mint: [], burn: [] }, fixed: null, collateral: { required: false }, ...over });

test('settings: the defaults are the recommended answers, other values are refused', () => {
  assert.deepEqual(oracleSettings(), ORACLE_SETTINGS);
  assert.equal(ORACLE_SETTINGS.searchSpace, 'requested-plus-20');
  assert.equal(ORACLE_SETTINGS.exactness, 'library-forced');
  assert.equal(ORACLE_SETTINGS.solver, 'highs-1.15.4');
  assert.equal(ORACLE_SETTINGS.incumbents, 'seeded-methods');
  assert.equal(ORACLE_SETTINGS.afterExhaustive, 'mip-always');
  assert.equal(ORACLE_SETTINGS.limit, 'budget');
  assert.equal(ORACLE_SETTINGS.solverSeed, 0);
  for (const k of ['maxCandidateSets', 'maxSolves', 'maxNodes', 'maxSolveNodes', 'guardMs']) assert.ok(Number.isSafeInteger(ORACLE_SETTINGS[k]) && ORACLE_SETTINGS[k] > 0, k);
  assert.equal(oracleSettings({ incumbents: 'all-methods' }).incumbents, 'all-methods');
  assert.equal(oracleSettings({ limit: 'wall-clock' }).limit, 'wall-clock');
  assert.throws(() => oracleSettings({ limit: 'nodes' }), /oracle setting limit=nodes is not implemented \(implemented: budget, wall-clock\)/);
  assert.throws(() => oracleSettings({ incumbents: 'none' }), /not implemented/);
  // The budget's values, from a command line or the environment as strings.
  assert.equal(oracleSettings({ maxCandidateSets: '25' }).maxCandidateSets, 25);
  assert.equal(oracleSettings({ maxSolveNodes: 7 }).maxSolveNodes, 7);
  assert.equal(oracleSettings({ solverSeed: '0' }).solverSeed, 0);
  for (const v of ['0', '-1', '1.5', '1e3', 'many', '', 2 ** 31]) assert.throws(() => oracleSettings({ maxSolves: v }), /not implemented \(a whole number/, String(v));
  assert.throws(() => oracleSettings({ solverSeed: '-1' }), /not implemented/);
  assert.equal(Object.isFrozen(oracleSettings({ maxSolves: '3' })), true);
  assert.equal(oracleSettings({ setFee: 'ledger-minimum' }).setFee, 'ledger-minimum');
  assert.equal(oracleSettings({ afterExhaustive: 'mip' }).afterExhaustive, 'mip');
  assert.equal(oracleSettings({ afterExhaustive: 'report' }).afterExhaustive, 'report');
  assert.throws(() => oracleSettings({ afterExhaustive: 'never' }), /not implemented/);
  assert.throws(() => oracleSettings({ searchSpace: 'all' }), /not implemented/);
  assert.throws(() => oracleSettings({ nope: 1 }), /unknown oracle setting/);
});

test('incumbents: only seeded methods under the default, every method under all-methods', () => {
  assert.equal(admitsIncumbent(ORACLE_SETTINGS, { seeded: true }), true);
  assert.equal(admitsIncumbent(ORACLE_SETTINGS, { seeded: false }), false);
  assert.equal(admitsIncumbent(ORACLE_SETTINGS, {}), false, 'a method that does not say is not seeded');
  const all = oracleSettings({ incumbents: 'all-methods' });
  assert.equal(admitsIncumbent(all, { seeded: false }), true);
  assert.throws(() => admitsIncumbent({ incumbents: 'none' }, { seeded: true }), /not implemented/);
});

// A market-split program (Cornuejols and Dawande): 4 rows of 30 binary
// columns with weights in [0, 99] and each right-hand side half its row's
// sum, slacks priced at 1; hard for branch and bound, so a node limit is
// reached long before the search ends.
function marketSplit(H, m = 4, n = 30, seed = 42) {
  let s = seed >>> 0;
  const r = () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 2 ** 32;
  };
  const a = Array.from({ length: m }, () => Array.from({ length: n }, () => Math.floor(r() * 100)));
  const lower = [], upper = [], cost = [], integ = [];
  for (let j = 0; j < n; j++) lower.push(0), upper.push(1), cost.push(0), integ.push(1);
  for (let i = 0; i < 2 * m; i++) lower.push(0), upper.push(H.infinity), cost.push(1), integ.push(0);
  const starts = [0], indices = [], values = [], rowLower = [], rowUpper = [];
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) indices.push(j), values.push(a[i][j]);
    indices.push(n + 2 * i, n + 2 * i + 1);
    values.push(1, -1);
    starts.push(indices.length);
    const b = Math.floor(a[i].reduce((x, y) => x + y, 0) / 2);
    rowLower.push(b);
    rowUpper.push(b);
  }
  const numCols = lower.length;
  return { numCols, numRows: m, colCost: cost, colLower: lower, colUpper: upper, rowLower, rowUpper, matrix: { format: 'csr', numRows: m, numCols, starts, indices, values }, integrality: integ };
}

test('highs 1.15.4 honors the node limit and the random seed the oracle sets', async () => {
  const H = await loadSolver();
  const solve = (opts) => {
    const model = H.createModel(marketSplit(H));
    try {
      model.options.set({ output_flag: false, mip_rel_gap: 0, ...opts });
      model.run();
      return { status: model.getModelStatus(), nodes: Number(model.info.get('mip_node_count')), simplex: model.info.get('simplex_iteration_count'), primal: model.info.get('primal_solution_status'), objective: model.info.get('objective_function_value'), seed: model.options.get('random_seed') };
    } finally {
      model.dispose();
    }
  };
  for (const nodes of [40, 300]) {
    const a = solve({ mip_max_nodes: nodes, random_seed: 0 });
    // The node limit's status, as mip.mjs maps it: solutionLimit, with the
    // best set found so far.
    assert.equal(a.status, H.constants.modelStatus.solutionLimit, `status at ${nodes} nodes`);
    assert.equal(a.nodes, nodes);
    assert.equal(a.seed, 0);
    // The same program, limit and seed: the same work and the same answer.
    assert.deepEqual(solve({ mip_max_nodes: nodes, random_seed: 0 }), a);
  }
  const seeded = solve({ mip_max_nodes: 300, random_seed: 7 });
  assert.equal(seeded.seed, 7);
  assert.equal(seeded.nodes, 300);
});

// What highs 1.15.4 reports and honors for a MIP solve's simplex iterations,
// the count the oracle records as work.lpIterations, on the market-split
// program: exact counts, which a fixed seed repeats.
test('highs 1.15.4 counts a MIP solve\'s LP iterations, ignores simplex_iteration_limit, and stops at a count only by its interrupt callback', async () => {
  const H = await loadSolver();
  const read = (model) => ({ status: model.getModelStatus(), nodes: Number(model.info.get('mip_node_count')), iterations: model.info.get('simplex_iteration_count'), primal: model.info.get('primal_solution_status') });
  // The callbacks that record the last count the MIP interrupt callback saw
  // and interrupt once it reaches `at`.
  const interruptAt = (at, seen) => ({
    [H.constants.callbackType.mipInterrupt](e) {
      seen.push(e.data.mip_total_lp_iterations);
      if (e.data.mip_total_lp_iterations >= BigInt(at)) e.interrupt();
    }
  });
  const solve = (opts, at = null) => {
    const model = H.createModel(marketSplit(H));
    try {
      model.options.set({ output_flag: false, mip_rel_gap: 0, random_seed: 0, ...opts });
      const seen = [];
      model.run(at === null ? undefined : interruptAt(at, seen));
      return { ...read(model), seen: seen.length ? Number(seen.at(-1)) : null };
    } finally {
      model.dispose();
    }
  };
  // simplex_iteration_count is the MIP's total over every LP it solved: it
  // grows with the nodes searched, and a fixed seed repeats it exactly.
  const counts = [1, 40, 300].map((n) => solve({ mip_max_nodes: n }));
  assert.deepEqual(counts.map((c) => [c.status, c.nodes, c.iterations]), [[16, 1, 407], [16, 40, 557], [16, 300, 2762]]);
  assert.deepEqual(solve({ mip_max_nodes: 300 }), counts[2]);
  // simplex_iteration_limit does not apply to a MIP (HiGHS: "when solving
  // LPs, but not subproblems in the MIP solver"): the solve is the same.
  for (const limit of [0, 10, 100]) assert.deepEqual(solve({ mip_max_nodes: 300, simplex_iteration_limit: limit }), counts[2], `simplex_iteration_limit ${limit}`);
  // No MIP option limits iterations.
  const probe = H.createModel(marketSplit(H));
  try {
    assert.deepEqual(probe.options.names().filter((n) => /^mip_/.test(n) && /iter/.test(n)), []);
  } finally {
    probe.dispose();
  }
  // The MIP interrupt callback sees the same count and stops the solve at
  // the first checkpoint past a value, interrupted with its best set; the
  // same seed stops at the same point. A callback that does not interrupt
  // leaves the solve unchanged.
  for (const [at, nodes, iterations] of [[500, 81, 709], [3000, 365, 3412]]) {
    const a = solve({}, at);
    assert.deepEqual([a.status, a.nodes, a.iterations, a.seen, a.primal], [H.constants.modelStatus.interrupted, nodes, iterations, iterations, 2], `interrupt at ${at}`);
    assert.deepEqual(solve({}, at), a);
  }
  const watched = solve({ mip_max_nodes: 300 }, 2 ** 40);
  assert.deepEqual({ ...watched, seen: null }, counts[2]);
  assert.equal(watched.seen, 2762);
  // The count is each run's own: a model run twice and then interrupted at
  // 1000 reports that run's iterations, not a running total.
  const model = H.createModel(marketSplit(H));
  try {
    model.options.set({ output_flag: false, mip_rel_gap: 0, random_seed: 0, mip_max_nodes: 300 });
    model.run();
    model.run();
    model.options.set({ mip_max_nodes: 2147483647 });
    model.run(interruptAt(1000, []));
    assert.deepEqual(read(model), { status: H.constants.modelStatus.interrupted, nodes: 100, iterations: 1146, primal: 2 });
  } finally {
    model.dispose();
  }
});

test('a search refuses an unseeded incumbent under seeded-methods, and a time limit under the budget', async () => {
  const inc = (name, seeded) => ({ name, seeded, walletInputs: [], bytes: null, fee: 1n });
  // Both refusals come before the treatment or the solver is touched.
  await assert.rejects(searchOracle(null, null, spend(), null, 'csl', { incumbents: [inc('csl-lf', true), inc('csl-ri', false)] }), /incumbents from methods whose answers are not seeded: csl-ri/);
  await assert.rejects(searchOracle(null, null, spend(), null, 'csl', { incumbents: [{ name: 'old', walletInputs: [], fee: 1n }] }), /not seeded: old/);
  await assert.rejects(searchOracle(null, null, spend(), null, 'csl', { timeLimitMs: 1000 }), /timeLimitMs applies only under the oracle setting limit=wall-clock/);
});

test('spends: battery spends only, with requested outputs and nothing else', () => {
  assert.equal(checkSpend(spend()).source, 'battery');
  assert.throws(() => checkSpend(spend({ source: 'replay' })), OracleRefusal);
  assert.throws(() => checkSpend(spend({ fixed: { inputs: [] } })), OracleRefusal);
  assert.throws(() => checkSpend(spend({ collateral: { required: true } })), OracleRefusal);
  assert.throws(() => checkSpend(spend({ implicit: { withdrawals: 1n, refunds: 0n, deposits: 0n, donation: 0n, mint: [], burn: [] } })), OracleRefusal);
  assert.throws(() => checkSpend(spend({ requested: [] })), OracleRefusal);
  assert.throws(() => checkSpend(spend({ requested: [{ cbor: '82', assets: [], datum: { kind: 'hash' }, scriptRef: null }] })), OracleRefusal);
});

test('an input is 36, 37 or 38 bytes by its index', () => {
  assert.equal(inputBytes(0), 36);
  assert.equal(inputBytes(23), 36);
  assert.equal(inputBytes(24), 37);
  assert.equal(inputBytes(255), 37);
  assert.equal(inputBytes(256), 38);
});

test('the least count of values that reach a need, largest first', () => {
  assert.equal(leastCount([5n, 1n, 3n], 0n), 0);
  assert.equal(leastCount([5n, 1n, 3n], 5n), 1);
  assert.equal(leastCount([5n, 1n, 3n], 6n), 2);
  assert.equal(leastCount([5n, 1n, 3n], 9n), 3);
  assert.equal(leastCount([5n, 1n, 3n], 10n), null);
  assert.equal(leastCount([-4n, 2n], 2n), 1);
});

test('each method maps to the change policy its reference uses', () => {
  assert.equal(policyOfMethod('csl-lf', 'default'), 'csl');
  assert.equal(policyOfMethod('csl-ri', 'default'), 'csl');
  assert.equal(policyOfMethod('csl-lf-pure', 'default'), 'csl-ppc');
  assert.equal(policyOfMethod('cjs-rrri', 'default'), 'cjs');
  assert.equal(policyOfMethod('evo-lf', 'default'), 'evo');
  assert.equal(policyOfMethod('unfrackit-h12', 'default'), 'layout');
  assert.equal(policyOfMethod('cjs-rrri', 'layout'), 'layout');
  assert.equal(policyOfMethod('csl-lf', 'single'), null);
});

test('the program follows a completed exhaustive search as afterExhaustive says', () => {
  const f = (v, complete, found, coversPool = false) => programFollows(v, { complete, found, coversPool });
  for (const found of [true, false]) {
    assert.equal(f('mip-always', true, found), true);
    assert.equal(f('report', true, found), false);
    for (const v of ['mip-always', 'mip', 'report']) {
      assert.equal(f(v, false, found), false, `${v} after an incomplete search`);
      // A candidate set that holds every spendable UTxO leaves the program
      // nothing to search.
      assert.equal(f(v, true, found, true), false, `${v} over the whole pool`);
    }
  }
  assert.equal(f('mip', true, false), true);
  assert.equal(f('mip', true, true), false);
  assert.throws(() => f('never', true, true), /not implemented/);
});

test('statuses and bounds: proven only when the last search completed', () => {
  const best = { fee: 170000n };
  assert.deepEqual(statusOf({ proven: true, best }), { status: 'optimal', bound: 170000n });
  assert.deepEqual(statusOf({ proven: true, best: null }), { status: 'infeasible', bound: null });
  // Unproven: the lower of the fee and the program's bound, or none.
  assert.deepEqual(statusOf({ proven: false, best, programBound: 168500 }), { status: 'best-at-limit', bound: 168500n });
  assert.deepEqual(statusOf({ proven: false, best, programBound: 171000 }), { status: 'best-at-limit', bound: 170000n });
  assert.deepEqual(statusOf({ proven: false, best }), { status: 'best-at-limit', bound: null });
  assert.deepEqual(statusOf({ proven: false, best: null, programBound: 168500 }), { status: 'undecided', bound: 168500n });
  assert.deepEqual(statusOf({ proven: false, best: null }), { status: 'undecided', bound: null });
});
