// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The oracle against brute force on small wallets: every standard battery
// spend of the shapes with at most 12 spendable UTxOs, and of sub-wallets of
// 8 to 12 UTxOs drawn from each larger shape with fixed seeds, under every
// policy the oracle evaluates. Every subset of the wallet's spendable UTxOs is
// evaluated exactly. The checks:
//
//   - the oracle's fee equals the least exact fee over its candidate set, and
//     it reports infeasible exactly when no candidate subset is feasible;
//   - the lower bound is never above the exact fee of a feasible set, and a
//     set the bound calls infeasible never builds;
//   - the mixed-integer path over the same candidates gives the same fee, or
//     a higher one (or none) only at the time limit; over every spendable
//     UTxO it gives the least exact fee over all subsets, or a higher one (or
//     none) only at the limit.
//
// The least exact fee over every subset is reported beside the candidate
// set's, which shows what the candidate set leaves out. Needs
// RESEARCH_SIM_TREATMENT_DIR; RESEARCH_SIM_ORACLE_WORKERS sets the worker
// count (4) and RESEARCH_SIM_ORACLE_LIMIT_MS the oracle's limit per run
// (60000).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { skip, TREATMENT_DIR } from '../lib/treatment.mjs';
import { runJobs } from '../lib/workers.mjs';
import { oracleOutDir, envNumber } from '../lib/outdir.mjs';
import { AVAILABLE_POLICIES } from '../../src/oracle/policies.mjs';

const SMALL = ['S1', 'S2b', 'S8', 'M1', 'M7'];
const LARGE = ['S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S9', 'M2', 'M3', 'M4', 'M5', 'M8', 'CL1', 'CL3', 'E1', 'E2'];
export const SUB_SEEDS = (i) => [4001 + 2 * i, 4002 + 2 * i];

test('the oracle equals brute force on small wallets, and its bound is sound', { skip, timeout: 24 * 60 * 60 * 1000 }, async (t) => {
  const pinsText = process.env.RESEARCH_SIM_TREATMENT_PINS ? readFileSync(process.env.RESEARCH_SIM_TREATMENT_PINS, 'utf8') : undefined;
  const limitMs = envNumber('RESEARCH_SIM_ORACLE_LIMIT_MS', 60000);
  const only = process.env.RESEARCH_SIM_ORACLE_SHAPES ? new Set(process.env.RESEARCH_SIM_ORACLE_SHAPES.split(',')) : null;
  const jobs = [];
  for (const shape of SMALL) if (!only || only.has(shape)) jobs.push({ shape, seed: null, policies: AVAILABLE_POLICIES, limitMs });
  LARGE.forEach((shape, i) => {
    if (!only || only.has(shape)) for (const seed of SUB_SEEDS(i)) jobs.push({ shape, seed, policies: AVAILABLE_POLICIES, limitMs });
  });
  const out = join(oracleOutDir(), 'oracle-brute.jsonl');
  const script = new URL('./brute-worker.mjs', import.meta.url);
  const { records, errors } = await runJobs(script, { treatmentDir: TREATMENT_DIR, pinsText }, jobs, {
    workers: envNumber('RESEARCH_SIM_ORACLE_WORKERS', 4),
    onRecord: (r) => appendFileSync(out, JSON.stringify(r) + '\n', { mode: 0o600 })
  });
  assert.deepEqual(errors, []);
  const c = { wallets: jobs.length, runs: records.length, subsets: 0, feasibleSets: 0, boundAbove: 0, boundInfeasibleButBuilt: 0, oracleEqualsCandidates: 0, oracleDiffers: [], infeasibleAgree: 0, candidateAboveGlobal: 0, candidateInfeasibleGlobalFeasible: 0, mipCandidates: { equalProven: 0, equalAtLimit: 0, higherAtLimit: 0, undecidedAtLimit: 0, bad: 0 }, mipCandidatesBad: [], mipSpendable: { equalProven: 0, equalAtLimit: 0, higherAtLimit: 0, undecidedAtLimit: 0, bad: 0 }, mipSpendableBad: [], statuses: {}, minBoundGap: null, maxBoundGap: null };
  for (const r of records) {
    c.subsets += r.subsets;
    c.feasibleSets += r.feasible;
    c.boundAbove += r.boundAbove;
    c.boundInfeasibleButBuilt += r.boundInfeasibleButBuilt;
    if (r.minBoundGap !== null) c.minBoundGap = c.minBoundGap === null ? r.minBoundGap : Math.min(c.minBoundGap, r.minBoundGap);
    if (r.maxBoundGap !== null) c.maxBoundGap = c.maxBoundGap === null ? r.maxBoundGap : Math.max(c.maxBoundGap, r.maxBoundGap);
    c.statuses[r.auto.status] = (c.statuses[r.auto.status] || 0) + 1;
    const tag = `${r.shape}${r.seed === null ? '' : '/' + r.seed} ${r.spend} ${r.policy}`;
    if (r.auto.fee === r.candidateMin && (r.auto.status === 'optimal' || r.auto.status === 'infeasible')) {
      if (r.candidateMin === null) c.infeasibleAgree++;
      else c.oracleEqualsCandidates++;
    } else c.oracleDiffers.push(`${tag}: oracle ${r.auto.status} ${r.auto.fee}, brute force ${r.candidateMin}`);
    if (r.candidateMin !== null && r.globalMin !== null && BigInt(r.candidateMin) > BigInt(r.globalMin)) c.candidateAboveGlobal++;
    if (r.candidateMin === null && r.globalMin !== null) c.candidateInfeasibleGlobalFeasible++;
    const vs = (o, min) => {
      if (o.fee === min) return o.status === 'optimal' || o.status === 'infeasible' ? 'equalProven' : 'equalAtLimit';
      if (o.status === 'best-at-limit' && min !== null && BigInt(o.fee) > BigInt(min)) return 'higherAtLimit';
      if (o.status === 'undecided' && min !== null) return 'undecidedAtLimit';
      return 'bad';
    };
    const a = vs(r.mipCandidates, r.candidateMin);
    c.mipCandidates[a]++;
    if (a === 'bad') c.mipCandidatesBad.push(`${tag}: mip ${r.mipCandidates.status} ${r.mipCandidates.fee}, brute force ${r.candidateMin}`);
    const b = vs(r.mipSpendable, r.globalMin);
    c.mipSpendable[b]++;
    if (b === 'bad') c.mipSpendableBad.push(`${tag}: mip ${r.mipSpendable.status} ${r.mipSpendable.fee}, brute force ${r.globalMin}`);
  }
  t.diagnostic(JSON.stringify(c));
  assert.equal(c.boundAbove, 0, 'the bound is above an exact fee');
  assert.equal(c.boundInfeasibleButBuilt, 0, 'a set the bound calls infeasible built');
  assert.deepEqual(c.oracleDiffers, []);
  assert.deepEqual(c.mipCandidatesBad, []);
  assert.deepEqual(c.mipSpendableBad, []);
});
