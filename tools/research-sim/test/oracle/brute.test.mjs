// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The oracle against brute force on small wallets: every standard battery
// spend of the shapes with at most 12 spendable UTxOs, and of sub-wallets of
// 8 to 12 UTxOs drawn from each larger shape with fixed seeds, under every
// policy the oracle evaluates. Every subset of the wallet's spendable UTxOs is
// evaluated exactly. The checks:
//
//   - the oracle's fee equals the least exact fee over the search space its
//     setting afterExhaustive gives, its status is proven, and it reports
//     infeasible exactly when no subset of that space is feasible: every
//     subset under 'mip-always' (the default), where the program over every
//     spendable UTxO follows the exhaustive search; the candidate set under
//     'report'; under 'mip', the candidate set when one of its subsets
//     builds and every subset otherwise; and every subset, under any value,
//     when the candidate set holds every spendable UTxO. The status's scope
//     must name that space;
//   - the lower bound is never above the exact fee of a feasible set, and a
//     set the bound calls infeasible never builds;
//   - the mixed-integer path over the same candidates gives the same fee, or
//     a higher one (or none) only at the time limit; over every spendable
//     UTxO it gives the least exact fee over all subsets, or a higher one (or
//     none) only at the limit.
//
// The least exact fee over the candidate set and over every subset are both
// reported, which shows what the candidate set leaves out. Needs
// RESEARCH_SIM_TREATMENT_DIR; RESEARCH_SIM_ORACLE_WORKERS sets the worker
// count (4, at most 12) and RESEARCH_SIM_ORACLE_SETTINGS the oracle's settings
// (test/lib/outdir.mjs; the defaults, the work budget among them, otherwise);
// under limit=wall-clock, RESEARCH_SIM_ORACLE_LIMIT_MS sets the oracle's limit
// per run (60000).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { skip, TREATMENT_DIR } from '../lib/treatment.mjs';
import { runJobs } from '../lib/workers.mjs';
import { oracleOutDir, envOracleOverrides, envOracleWorkers, envOracleLimitMs } from '../lib/outdir.mjs';
import { availablePolicies } from '../../src/oracle/policies.mjs';
import { oracleSettings } from '../../src/oracle/settings.mjs';

const SMALL = ['S1', 'S2b', 'S8', 'M1', 'M7'];
const LARGE = ['S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S9', 'M2', 'M3', 'M4', 'M5', 'M8', 'CL1', 'CL3', 'E1', 'E2'];
export const SUB_SEEDS = (i) => [4001 + 2 * i, 4002 + 2 * i];

// The search space the oracle's own run speaks for under afterExhaustive,
// and the least exact fee over it: r is a record of brute-worker.mjs.
export function expected(afterExhaustive, r) {
  const spendable = !r.exhaustivePath || r.candidates === r.utxos || afterExhaustive === 'mip-always' || (afterExhaustive === 'mip' && r.candidateMin === null);
  return spendable ? { scope: 'spendable', min: r.globalMin } : { scope: 'candidates', min: r.candidateMin };
}

test('the oracle equals brute force on small wallets, and its bound is sound', { skip, timeout: 24 * 60 * 60 * 1000 }, async (t) => {
  const pinsText = process.env.RESEARCH_SIM_TREATMENT_PINS ? readFileSync(process.env.RESEARCH_SIM_TREATMENT_PINS, 'utf8') : undefined;
  const only = process.env.RESEARCH_SIM_ORACLE_SHAPES ? new Set(process.env.RESEARCH_SIM_ORACLE_SHAPES.split(',')) : null;
  const policies = process.env.RESEARCH_SIM_ORACLE_POLICIES ? process.env.RESEARCH_SIM_ORACLE_POLICIES.split(',') : await availablePolicies();
  const overrides = envOracleOverrides();
  const settings = oracleSettings(overrides);
  const limitMs = envOracleLimitMs(settings);
  const workers = envOracleWorkers();
  t.diagnostic(`policies: ${policies.join(', ')}; settings ${JSON.stringify(settings)}; workers ${workers}`);
  const jobs = [];
  for (const shape of SMALL) if (!only || only.has(shape)) jobs.push({ shape, seed: null, policies, limitMs });
  LARGE.forEach((shape, i) => {
    if (!only || only.has(shape)) for (const seed of SUB_SEEDS(i)) jobs.push({ shape, seed, policies, limitMs });
  });
  const out = join(oracleOutDir(), 'oracle-brute.jsonl');
  const script = new URL('./brute-worker.mjs', import.meta.url);
  const { records, errors } = await runJobs(script, { treatmentDir: TREATMENT_DIR, pinsText, settings: overrides }, jobs, {
    workers,
    onRecord: (r) => appendFileSync(out, JSON.stringify(r) + '\n', { mode: 0o600 })
  });
  assert.deepEqual(errors, []);
  const c = { afterExhaustive: settings.afterExhaustive, wallets: jobs.length, runs: records.length, subsets: 0, feasibleSets: 0, boundAbove: 0, boundInfeasibleButBuilt: 0, oracleEquals: { candidates: 0, spendable: 0 }, oracleDiffers: [], infeasibleAgree: { candidates: 0, spendable: 0 }, candidateAboveGlobal: 0, candidateInfeasibleGlobalFeasible: 0, oracleAboveGlobal: 0, oracleNoneGlobalFeasible: 0, programLowered: 0, programFound: 0, statusScope: {}, bestFrom: {}, stops: {}, autoMs: [], mipCandidates: { equalProven: 0, equalAtLimit: 0, higherAtLimit: 0, undecidedAtLimit: 0, bad: 0 }, mipCandidatesBad: [], mipSpendable: { equalProven: 0, equalAtLimit: 0, higherAtLimit: 0, undecidedAtLimit: 0, bad: 0 }, mipSpendableBad: [], statuses: {}, minBoundGap: null, maxBoundGap: null };
  for (const r of records) {
    c.subsets += r.subsets;
    c.feasibleSets += r.feasible;
    c.boundAbove += r.boundAbove;
    c.boundInfeasibleButBuilt += r.boundInfeasibleButBuilt;
    if (r.minBoundGap !== null) c.minBoundGap = c.minBoundGap === null ? r.minBoundGap : Math.min(c.minBoundGap, r.minBoundGap);
    if (r.maxBoundGap !== null) c.maxBoundGap = c.maxBoundGap === null ? r.maxBoundGap : Math.max(c.maxBoundGap, r.maxBoundGap);
    const a = r.auto;
    c.statuses[a.status] = (c.statuses[a.status] || 0) + 1;
    c.statusScope[`${a.status}/${a.scope}`] = (c.statusScope[`${a.status}/${a.scope}`] || 0) + 1;
    c.bestFrom[a.bestFrom] = (c.bestFrom[a.bestFrom] || 0) + 1;
    if (a.stop) c.stops[a.stop] = (c.stops[a.stop] || 0) + 1;
    c.autoMs.push(a.ms);
    const tag = `${r.shape}${r.seed === null ? '' : '/' + r.seed} ${r.spend} ${r.policy}`;
    const want = expected(settings.afterExhaustive, r);
    if (a.scope === want.scope && a.fee === want.min && (a.status === 'optimal' || a.status === 'infeasible')) {
      if (want.min === null) c.infeasibleAgree[want.scope]++;
      else c.oracleEquals[want.scope]++;
    } else c.oracleDiffers.push(`${tag}: oracle ${a.status} ${a.fee} over ${a.scope}, brute force ${want.min} over ${want.scope}`);
    if (r.candidateMin !== null && r.globalMin !== null && BigInt(r.candidateMin) > BigInt(r.globalMin)) c.candidateAboveGlobal++;
    if (r.candidateMin === null && r.globalMin !== null) c.candidateInfeasibleGlobalFeasible++;
    if (a.fee !== null && r.globalMin !== null && BigInt(a.fee) > BigInt(r.globalMin)) c.oracleAboveGlobal++;
    if (a.fee === null && r.globalMin !== null) c.oracleNoneGlobalFeasible++;
    // Where the program over every spendable UTxO beat the exhaustive search.
    if (a.exhaustive && a.fee !== null) {
      if (a.exhaustive.fee === null) c.programFound++;
      else if (BigInt(a.fee) < BigInt(a.exhaustive.fee)) c.programLowered++;
    }
    const vs = (o, min) => {
      if (o.fee === min) return o.status === 'optimal' || o.status === 'infeasible' ? 'equalProven' : 'equalAtLimit';
      if (o.status === 'best-at-limit' && min !== null && BigInt(o.fee) > BigInt(min)) return 'higherAtLimit';
      if (o.status === 'undecided' && min !== null) return 'undecidedAtLimit';
      return 'bad';
    };
    const m = vs(r.mipCandidates, r.candidateMin);
    c.mipCandidates[m]++;
    if (m === 'bad') c.mipCandidatesBad.push(`${tag}: mip ${r.mipCandidates.status} ${r.mipCandidates.fee}, brute force ${r.candidateMin}`);
    const b = vs(r.mipSpendable, r.globalMin);
    c.mipSpendable[b]++;
    if (b === 'bad') c.mipSpendableBad.push(`${tag}: mip ${r.mipSpendable.status} ${r.mipSpendable.fee}, brute force ${r.globalMin}`);
  }
  const ms = c.autoMs.sort((x, y) => x - y);
  c.autoMs = ms.length ? { median: ms[Math.floor(ms.length / 2)], p90: ms[Math.floor(ms.length * 0.9)], max: ms[ms.length - 1], mean: Math.round(ms.reduce((s, v) => s + v, 0) / ms.length) } : null;
  t.diagnostic(JSON.stringify(c));
  assert.equal(c.boundAbove, 0, 'the bound is above an exact fee');
  assert.equal(c.boundInfeasibleButBuilt, 0, 'a set the bound calls infeasible built');
  assert.deepEqual(c.oracleDiffers, []);
  assert.deepEqual(c.mipCandidatesBad, []);
  assert.deepEqual(c.mipSpendableBad, []);
});
