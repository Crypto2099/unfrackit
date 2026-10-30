// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The oracle on every standard battery spend of the 21 synthetic shapes,
// under every policy it evaluates, seeded and unseeded (battery-run.mjs). The
// checks:
//
//   1  every reference transaction passes the ledger kit, and each negative
//      control is caught for its own reason;
//   4  where the exhaustive path ran, the mixed-integer path over the same
//      candidates gives the exhaustive search's own fee over them, or a
//      higher one (or none) only at the limit;
//   5  the seeded reference fee is at most the fee of every method with the
//      same policy whose transaction passed the kit and that the incumbents
//      rule admits; the others' passing answers below the reference are
//      counted apart (unseededBelow), not failures;
//   6  (asserted) every method's change equals the policy's change on its own inputs,
//      byte for byte (the layout-preserving change against the H-12 rule and
//      the test method; cardano-serialization-lib's change against the
//      library selecting on its own);
//   7  the run time and the share of best-at-limit and undecided runs per
//      policy, with each status's scope, the stops and the work used; under
//      afterExhaustive 'mip-always' no run is optimal or infeasible over the
//      candidate set alone.
//
// Needs RESEARCH_SIM_TREATMENT_DIR. RESEARCH_SIM_ORACLE_WORKERS (4, at most
// 12), RESEARCH_SIM_ORACLE_SHAPES (all 21) and RESEARCH_SIM_ORACLE_POLICIES
// (every policy this build evaluates) narrow a run;
// RESEARCH_SIM_ORACLE_SETTINGS sets the oracle's settings, limit=wall-clock
// among them, under which RESEARCH_SIM_ORACLE_LIMIT_MS (60000) sets each
// call's time limit (test/lib/outdir.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { treatment, skip, TREATMENT_DIR } from '../lib/treatment.mjs';
import { oracleOutDir, envOracleOverrides, envOracleWorkers, envOracleLimitMs } from '../lib/outdir.mjs';
import { oracleSettings } from '../../src/oracle/settings.mjs';
import { runBatteryOracle } from './battery-run.mjs';
import { SHAPE_NAMES } from '../../src/shapes/shapes.mjs';
import { SYNTHETIC_PARAMS } from '../../src/kit/params.mjs';

const T = await treatment();

// How a run of the mixed-integer path over the exhaustive path's candidates
// compares with the exhaustive run, whose completed result is the optimum
// over them: the same fee (proven or found at the limit), a higher fee or no
// solution only at the limit, anything else a failure of the check.
export function agree(e, m) {
  const done = (o) => o.status === 'optimal' || o.status === 'infeasible';
  if (!done(e)) return m.fee === e.fee ? 'equalAtLimit' : 'bad';
  if (m.fee === e.fee) return done(m) ? 'equalProven' : 'equalAtLimit';
  if (m.status === 'best-at-limit' && e.fee !== null && BigInt(m.fee) > BigInt(e.fee)) return 'higherAtLimit';
  if (m.status === 'undecided' && e.fee !== null) return 'undecidedAtLimit';
  return 'bad';
}

test('the oracle on the 21 shapes: kit, never above a method, change, paths, limits', { skip, timeout: 48 * 60 * 60 * 1000 }, async (t) => {
  const pinsText = process.env.RESEARCH_SIM_TREATMENT_PINS ? readFileSync(process.env.RESEARCH_SIM_TREATMENT_PINS, 'utf8') : undefined;
  const shapes = process.env.RESEARCH_SIM_ORACLE_SHAPES ? process.env.RESEARCH_SIM_ORACLE_SHAPES.split(',') : SHAPE_NAMES;
  const settings = oracleSettings(envOracleOverrides());
  const limitMs = envOracleLimitMs(settings);
  const workers = envOracleWorkers();
  t.diagnostic(`settings ${JSON.stringify(settings)}; workers ${workers}${limitMs ? `; limit ${limitMs} ms` : ''}`);
  const { records, file } = await runBatteryOracle({
    T,
    treatmentDir: TREATMENT_DIR,
    pinsText,
    params: SYNTHETIC_PARAMS,
    shapes,
    policies: process.env.RESEARCH_SIM_ORACLE_POLICIES ? process.env.RESEARCH_SIM_ORACLE_POLICIES.split(',') : undefined,
    limitMs,
    workers,
    outDir: oracleOutDir(),
    settings,
    log: (line) => t.diagnostic(line)
  });
  const c = { records: records.length, file, check1: { references: 0, bad: [] }, check4: { compared: 0, equalProven: 0, equalAtLimit: 0, higherAtLimit: 0, undecidedAtLimit: 0, bad: [] }, check5: { compared: 0, violations: [], missing: [], unseeded: 0, unseededBelow: {} }, check6: { compared: 0, same: 0, differ: [] }, status: {}, statusScope: {}, provenOverCandidates: [], bestFrom: {}, outsideCandidates: 0, atLimit: {}, stops: {}, guard: [] };
  const errors = records.filter((r) => r.error).map((r) => `${r.shape} ${r.spend} ${r.policy}: ${r.error.split('\n')[0]}`);
  for (const r of records) {
    if (r.error) continue;
    const tag = `${r.shape} ${r.spend} ${r.policy}`;
    for (const [k, v] of Object.entries(r.check1)) {
      c.check1.references++;
      if (!v.ok) c.check1.bad.push(`${tag} ${k}: ${v.bad.join(' ')}`);
    }
    if (r.mipCandidates) {
      c.check4.compared++;
      // The exhaustive search's own result over the candidates, before any
      // program over every spendable UTxO.
      const e = r.unseeded.exhaustive || r.unseeded;
      const m = r.mipCandidates;
      const v = agree(e, m);
      c.check4[v]++;
      if (v === 'bad') c.check4.bad.push(`${tag}: exhaustive ${e.status} ${e.fee}, mip ${m.status} ${m.fee}`);
    }
    c.check5.compared += r.methods.filter((m) => m.ok && m.kitOk).length;
    for (const v of r.check5) c.check5.violations.push(`${tag} ${v}`);
    if (r.check5missing) c.check5.missing.push(tag);
    for (const u of r.unseededMethods || []) {
      if (!u.ok || !u.kitOk) continue;
      c.check5.unseeded++;
      if (u.belowReference) c.check5.unseededBelow[r.policy] = (c.check5.unseededBelow[r.policy] || 0) + 1;
    }
    for (const i of [...r.check6, ...(r.unseededMethods || []).filter((u) => u.sameChange !== undefined)]) {
      if (i.sameChange === null) continue;
      c.check6.compared++;
      if (i.sameChange) c.check6.same++;
      else c.check6.differ.push(`${tag} ${i.name}`);
    }
    for (const [k, o] of [['seeded', r.seeded], ['unseeded', r.unseeded]]) {
      const key = `${r.policy} ${k}`;
      c.status[key] = c.status[key] || {};
      c.status[key][o.status] = (c.status[key][o.status] || 0) + 1;
      c.statusScope[key] = c.statusScope[key] || {};
      c.statusScope[key][`${o.status}/${o.scope}`] = (c.statusScope[key][`${o.status}/${o.scope}`] || 0) + 1;
      if (settings.afterExhaustive === 'mip-always' && (o.status === 'optimal' || o.status === 'infeasible') && o.scope !== 'spendable') c.provenOverCandidates.push(`${tag} ${k}: ${o.status} over ${o.scope}`);
      if (o.stop) c.stops[`${k} ${o.stop}`] = (c.stops[`${k} ${o.stop}`] || 0) + 1;
      if (o.terminated) c.guard.push(`${tag} ${k}`);
    }
    const sd = r.seeded;
    c.bestFrom[sd.bestFrom] = (c.bestFrom[sd.bestFrom] || 0) + 1;
    if (sd.bestInCandidates === false) c.outsideCandidates++;
    c.atLimit[r.policy] = c.atLimit[r.policy] || { runs: 0, atLimit: 0, terminated: 0, ms: 0 };
    c.atLimit[r.policy].runs++;
    if (sd.status === 'best-at-limit' || sd.status === 'undecided') c.atLimit[r.policy].atLimit++;
    if (sd.terminated) c.atLimit[r.policy].terminated++;
    c.atLimit[r.policy].ms += sd.ms;
  }
  c.errors = errors;
  t.diagnostic(JSON.stringify(c));
  assert.deepEqual(errors, []);
  assert.deepEqual(c.check1.bad, []);
  assert.deepEqual(c.check4.bad, []);
  assert.deepEqual(c.check5.violations, []);
  assert.deepEqual(c.check5.missing, []);
  assert.deepEqual(c.check6.differ, []);
  assert.deepEqual(c.provenOverCandidates, []);
});
