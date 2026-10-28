// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The oracle on every standard battery spend of the 21 synthetic shapes,
// under every policy it evaluates, seeded and unseeded (battery-run.mjs). The
// checks:
//
//   1  every reference transaction passes the ledger kit, and each negative
//      control is caught for its own reason;
//   4  where the exhaustive path ran, the mixed-integer path over the same
//      candidates gives the same fee, or a higher one (or none) only at the
//      limit;
//   5  the seeded reference fee is at most the fee of every method with the
//      same policy whose transaction passed the kit;
//   6  every method's change equals the policy's change on its own inputs,
//      byte for byte (the layout-preserving change against the H-12 rule and
//      the test method; cardano-serialization-lib's change against the
//      library selecting on its own);
//   7  the run time and the share of best-at-limit and undecided runs per
//      policy.
//
// Needs RESEARCH_SIM_TREATMENT_DIR. RESEARCH_SIM_ORACLE_WORKERS (4),
// RESEARCH_SIM_ORACLE_LIMIT_MS (60000) and RESEARCH_SIM_ORACLE_SHAPES (all 21)
// narrow a run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { treatment, skip, TREATMENT_DIR } from '../lib/treatment.mjs';
import { oracleOutDir, envNumber } from '../lib/outdir.mjs';
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
  const { records, file } = await runBatteryOracle({
    T,
    treatmentDir: TREATMENT_DIR,
    pinsText,
    params: SYNTHETIC_PARAMS,
    shapes,
    limitMs: envNumber('RESEARCH_SIM_ORACLE_LIMIT_MS', 60000),
    workers: envNumber('RESEARCH_SIM_ORACLE_WORKERS', 4),
    outDir: oracleOutDir(),
    log: (line) => t.diagnostic(line)
  });
  const c = { records: records.length, file, check1: { references: 0, bad: [] }, check4: { compared: 0, equalProven: 0, equalAtLimit: 0, higherAtLimit: 0, undecidedAtLimit: 0, bad: [] }, check5: { compared: 0, violations: [], missing: [] }, check6: { compared: 0, same: 0, differ: [] }, status: {} };
  for (const r of records) {
    const tag = `${r.shape} ${r.spend} ${r.policy}`;
    for (const [k, v] of Object.entries(r.check1)) {
      c.check1.references++;
      if (!v.ok) c.check1.bad.push(`${tag} ${k}: ${v.bad.join(' ')}`);
    }
    if (r.mipCandidates) {
      c.check4.compared++;
      const e = r.unseeded;
      const m = r.mipCandidates;
      const v = agree(e, m);
      c.check4[v]++;
      if (v === 'bad') c.check4.bad.push(`${tag}: exhaustive ${e.status} ${e.fee}, mip ${m.status} ${m.fee}`);
    }
    c.check5.compared += r.methods.filter((m) => m.ok && m.kitOk).length;
    for (const v of r.check5) c.check5.violations.push(`${tag} ${v}`);
    if (r.check5missing) c.check5.missing.push(tag);
    for (const i of r.check6) {
      if (i.sameChange === null) continue;
      c.check6.compared++;
      if (i.sameChange) c.check6.same++;
      else c.check6.differ.push(`${tag} ${i.name}`);
    }
    for (const [k, o] of [['seeded', r.seeded], ['unseeded', r.unseeded]]) {
      const key = `${r.policy} ${k}`;
      c.status[key] = c.status[key] || {};
      c.status[key][o.status] = (c.status[key][o.status] || 0) + 1;
    }
  }
  t.diagnostic(JSON.stringify(c));
  assert.deepEqual(c.check1.bad, []);
  assert.deepEqual(c.check4.bad, []);
  assert.deepEqual(c.check5.violations, []);
  assert.deepEqual(c.check5.missing, []);
});
