// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The library part of the builder survey (survey/survey.mjs) on its fixture,
// and the comparison of Mesh's default with the cjs-rrri baseline on the
// battery spends of the 21 shapes (survey/mesh-compare.mjs), seeds 1 to 10.
// Descriptive: the tests check that every record is complete and classified,
// and report the matrix. Needs RESEARCH_SIM_TREATMENT_DIR; RESEARCH_SIM_OUT may
// name a directory for the records as JSON.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { treatment, skip } from '../lib/treatment.mjs';
import { SYNTHETIC_PARAMS as P } from '../../src/kit/params.mjs';
import { runSurvey } from '../../src/survey/survey.mjs';
import { SURVEY_SETTINGS, fixtureAda } from '../../src/survey/fixture.mjs';
import { compareOne, classify } from '../../src/survey/mesh-compare.mjs';
import { cjsMethod } from '../../src/methods/cjs.mjs';
import { meshMethod } from '../../src/methods/mesh.mjs';
import { shapeState, SHAPE_NAMES } from '../../src/shapes/shapes.mjs';
import { standardBattery, h10Battery, SHAPE_POOLS } from '../../src/battery/battery.mjs';
import { RESULT_CLASSES } from '../../src/methods/contract.mjs';

const T = await treatment();
const json = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1);
const save = (name, x) => {
  if (process.env.RESEARCH_SIM_OUT) writeFileSync(join(process.env.RESEARCH_SIM_OUT, name), json(x));
};

// One cell per subject, variant and k: outcomes over its runs, and for the
// built transactions the ranges of what they show.
export function matrix(records) {
  const cells = new Map();
  for (const r of records) {
    const key = `${r.subject}|${r.variant}|${r.k}`;
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { subject: r.subject, variant: r.variant, k: r.k, runs: 0, outcomes: {}, errors: {}, fee: [], size: [], inputs: [], splitsOverV: {}, separates: {}, prefersPure: {} }));
    c.runs++;
    c.outcomes[r.outcome] = (c.outcomes[r.outcome] || 0) + 1;
    if (r.outcome !== 'built') c.errors[`${r.class}: ${r.detail.split('\n')[0].slice(0, 160)}`] = (c.errors[`${r.class}: ${r.detail.split('\n')[0].slice(0, 160)}`] || 0) + 1;
    if (r.outcome !== 'failed') {
      c.fee.push(BigInt(r.fee));
      c.size.push(r.size);
      c.inputs.push(r.inputs);
      for (const f of ['splitsOverV', 'separates', 'prefersPure']) c[f][String(r[f])] = (c[f][String(r[f])] || 0) + 1;
    }
  }
  const range = (xs) => (xs.length ? [xs.reduce((a, b) => (a < b ? a : b)), xs.reduce((a, b) => (a > b ? a : b))] : null);
  return [...cells.values()].map((c) => ({ ...c, fee: range(c.fee), size: range(c.size), inputs: range(c.inputs) }));
}

test('the builder survey: every subject on the fixture, k = 1 to 5, with and without pure-ADA UTxOs', { skip, timeout: 2 * 60 * 60 * 1000 }, async (t) => {
  assert.ok(fixtureAda(T) <= SURVEY_SETTINGS.faucetAda, 'the fixture fits one faucet request');
  const records = await runSurvey(T, {});
  for (const r of records) {
    assert.ok(['built', 'built-invalid', 'failed'].includes(r.outcome));
    if (r.outcome !== 'built') assert.ok(RESULT_CLASSES.has(r.class) && r.detail, `${r.subject} ${r.variant} ${r.k}: no class or reason`);
  }
  const m = matrix(records);
  // The smallest k at which a subject fails in any run, per variant.
  const failsAt = {};
  for (const c of m) {
    if (c.outcomes.built === c.runs) continue;
    const key = `${c.subject}|${c.variant}`;
    if (!(key in failsAt) || c.k < failsAt[key]) failsAt[key] = c.k;
  }
  save('survey-records.json', records);
  save('survey-matrix.json', { settings: SURVEY_SETTINGS, failsAt, cells: m });
  t.diagnostic(json({ failsAt, cells: m.map((c) => ({ s: c.subject, v: c.variant, k: c.k, o: c.outcomes, fee: c.fee, size: c.size, split: c.splitsOverV, sep: c.separates, pure: c.prefersPure, e: Object.keys(c.errors) })) }));
});

test('Mesh\'s default against cjs-rrri on the battery spends of the 21 shapes, seeds 1 to 10', { skip, timeout: 3 * 60 * 60 * 1000 }, async (t) => {
  const methods = { cjs: cjsMethod(T), mesh: meshMethod() };
  const seeds = Number(process.env.RESEARCH_SIM_COMPARE_SEEDS || 10);
  const records = [];
  const tally = {};
  for (const name of SHAPE_NAMES) {
    const s = shapeState(T, name).state;
    for (const it of [...standardBattery(T, s, P, { pools: SHAPE_POOLS }), ...h10Battery(T, s, P)]) {
      if (it.unsettled) continue;
      for (let seed = 1; seed <= seeds; seed++) {
        const rec = { shapeName: name, ...(await compareOne(T, s, it, P, seed, methods)) };
        rec.category = classify(rec);
        records.push(rec);
        const k = `${rec.shape}: ${rec.category}`;
        tally[k] = (tally[k] || 0) + 1;
      }
    }
  }
  save('mesh-compare.json', { seeds, tally, records });
  t.diagnostic(json(tally));
  assert.ok(records.length > 0);
});
