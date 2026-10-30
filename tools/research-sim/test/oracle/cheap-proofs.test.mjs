// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The small programs whose proofs take many cheap solves, as a measurement:
// the calls of the brute-force check (brute.test.mjs) that the work budget's
// solve count stopped before their proof, M2's sub-wallet of seed 4015 on
// payroll-10 and E1's of seeds 4029 and 4030 on ada-payment, under every
// policy, each run as the brute-force check runs it (path auto, no
// incumbents) under the wall-clock limit with a limit long enough to prove
// it. One record per call, with every work counter, its time in its worker
// (`ms`) and its wall time (`wallMs`), in oracle-cheap-proofs.jsonl. The
// check requires every call to prove its optimum.
//
// Needs RESEARCH_SIM_TREATMENT_DIR. RESEARCH_SIM_ORACLE_WORKERS (4, at most
// 12) sets the oracle's workers, RESEARCH_SIM_ORACLE_POLICIES the policies
// (every policy this build evaluates), RESEARCH_SIM_ORACLE_LIMIT_MS each
// call's limit (120000), RESEARCH_SIM_ORACLE_SETTINGS other settings (limit
// is always wall-clock here) and RESEARCH_SIM_ORACLE_OUT the output
// directory (test/lib/outdir.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { treatment, skip, TREATMENT_DIR } from '../lib/treatment.mjs';
import { oracleOutDir, envOracleOverrides, envOracleWorkers, envNumber } from '../lib/outdir.mjs';
import { subWallet } from '../lib/sub-wallet.mjs';
import { createOracle } from '../../src/oracle/oracle.mjs';
import { availablePolicies } from '../../src/oracle/policies.mjs';
import { oracleSettings } from '../../src/oracle/settings.mjs';
import { shapeState } from '../../src/shapes/shapes.mjs';
import { standardBattery, SHAPE_POOLS } from '../../src/battery/battery.mjs';
import { spendable } from '../../src/state/state.mjs';
import { SYNTHETIC_PARAMS as P } from '../../src/kit/params.mjs';

const CHEAP_PROOFS = [
  { shape: 'M2', seed: 4015, spend: 'payroll-10' },
  { shape: 'E1', seed: 4029, spend: 'ada-payment' },
  { shape: 'E1', seed: 4030, spend: 'ada-payment' }
];
const CHEAP_LIMIT_MS = 120000;

const json = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

test('the small programs the solve count stopped prove under the wall-clock limit, with their work recorded', { skip, timeout: 2 * 60 * 60 * 1000 }, async (t) => {
  const T = await treatment();
  const pinsText = process.env.RESEARCH_SIM_TREATMENT_PINS ? readFileSync(process.env.RESEARCH_SIM_TREATMENT_PINS, 'utf8') : undefined;
  const overrides = envOracleOverrides();
  if (overrides.limit !== undefined && overrides.limit !== 'wall-clock') throw new Error(`RESEARCH_SIM_ORACLE_SETTINGS: this check runs under limit=wall-clock (limit=${overrides.limit} asked)`);
  const settings = oracleSettings({ ...overrides, limit: 'wall-clock' });
  const limitMs = envNumber('RESEARCH_SIM_ORACLE_LIMIT_MS', CHEAP_LIMIT_MS);
  const workers = envOracleWorkers();
  const policies = process.env.RESEARCH_SIM_ORACLE_POLICIES ? process.env.RESEARCH_SIM_ORACLE_POLICIES.split(',') : await availablePolicies();
  const file = join(oracleOutDir(), 'oracle-cheap-proofs.jsonl');
  t.diagnostic(`settings ${JSON.stringify(settings)}; workers ${workers}; limit ${limitMs} ms; policies ${policies.join(', ')}; records ${file}`);
  const oracle = createOracle({ treatmentDir: TREATMENT_DIR, pinsText, workers });
  const records = [];
  try {
    const calls = [];
    for (const c of CHEAP_PROOFS) {
      const state = subWallet(shapeState(T, c.shape).state, c.seed);
      const spend = standardBattery(T, state, P, { pools: SHAPE_POOLS }).find((b) => b.id === c.spend && !b.unsettled);
      assert.ok(spend, `${c.shape}/${c.seed} has no settled ${c.spend}`);
      for (const policy of policies) {
        calls.push(
          oracle.oracle(state, spend, P, policy, { timeLimitMs: limitMs, incumbents: [], settings }).then((o) => {
            const m = o.detail && (o.detail.mip || (o.path === 'mip' ? o.detail : null));
            const rec = {
              shape: c.shape,
              seed: c.seed,
              utxos: spendable(state).length,
              spend: c.spend,
              policy,
              limitMs,
              status: o.status,
              stop: o.stop,
              fee: o.fee,
              bound: o.bound ?? null,
              paths: o.paths,
              candidates: o.candidates,
              work: o.work,
              ms: Math.round(o.ms ?? 0),
              wallMs: Math.round(o.wallMs ?? 0),
              terminated: o.terminated,
              mip: m ? { iterations: m.iterations, sets: m.sets, refuted: m.refuted, nodes: m.nodes, lpIterations: m.lpIterations, cols: m.cols, rows: m.rows, nnz: m.nnz, rowsLast: m.rowsLast, nnzLast: m.nnzLast, solverMs: m.solverMs, statuses: m.statuses, solverErrors: m.solverErrors.length } : null,
              evaluations: o.evaluations ?? null
            };
            appendFileSync(file, json(rec) + '\n', { mode: 0o600 });
            records.push(rec);
            t.diagnostic(`${c.shape}/${c.seed} ${c.spend} ${policy}: ${o.status} stop ${o.stop} fee ${o.fee} solves ${o.work ? o.work.solves : null} nnzSolves ${o.work ? o.work.nnzSolves : null} ${rec.ms} ms`);
          })
        );
      }
    }
    await Promise.all(calls);
  } finally {
    await oracle.close();
  }
  assert.equal(records.length, CHEAP_PROOFS.length * policies.length);
  const unproven = records.filter((r) => r.status !== 'optimal' || r.stop !== 'proven' || r.terminated).map((r) => `${r.shape}/${r.seed} ${r.spend} ${r.policy}: ${r.status} stop ${r.stop}${r.terminated ? ' terminated' : ''}`);
  assert.deepEqual(unproven, []);
});
