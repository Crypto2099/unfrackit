// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The oracle's time limit, in its worker: a run on a spend the search cannot
// finish returns at its limit with its best so far (best-at-limit), and a
// worker that has not returned by the parent's deadline is terminated, the
// termination recorded, the best it had reported kept, and a fresh worker
// serves the next call. The forced case is E1's fungible share (400 holders
// of one fungible), whose search runs to the limit; the termination is forced
// by a negative margin, so the parent stops the worker 55 seconds into a
// 60-second run. Needs RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { treatment, skip, TREATMENT_DIR } from '../lib/treatment.mjs';
import { envNumber } from '../lib/outdir.mjs';
import { createOracle } from '../../src/oracle/oracle.mjs';
import { shapeState } from '../../src/shapes/shapes.mjs';
import { SYNTHETIC_PARAMS as P } from '../../src/kit/params.mjs';
import { standardBattery, SHAPE_POOLS } from '../../src/battery/battery.mjs';

const T = await treatment();
const pinsText = process.env.RESEARCH_SIM_TREATMENT_PINS ? readFileSync(process.env.RESEARCH_SIM_TREATMENT_PINS, 'utf8') : undefined;
const LIMIT = envNumber('RESEARCH_SIM_ORACLE_LIMIT_MS', 60000);

function forcedCase() {
  const s = shapeState(T, 'E1').state;
  const spend = standardBattery(T, s, P, { pools: SHAPE_POOLS }).find((b) => b.id === 'fungible-share');
  return { s, spend };
}

test('a run that cannot finish returns at its limit with its best', { skip, timeout: 10 * 60 * 1000 }, async (t) => {
  const { s, spend } = forcedCase();
  const o = createOracle({ treatmentDir: TREATMENT_DIR, pinsText, workers: 1 });
  try {
    const r = await o.oracle(s, spend, P, 'csl', { timeLimitMs: LIMIT });
    t.diagnostic(JSON.stringify({ status: r.status, path: r.path, candidates: r.candidates, fee: String(r.fee), ms: Math.round(r.ms), wallMs: Math.round(r.wallMs), terminated: r.terminated, iterations: r.detail.iterations }));
    assert.ok(r.status === 'best-at-limit' || r.status === 'undecided', `status ${r.status}`);
    assert.equal(r.terminated, false);
    assert.ok(r.ms >= LIMIT && r.ms < LIMIT + 5000, `ran ${r.ms} ms`);
  } finally {
    await o.close();
  }
});

test('a worker past the parent\'s deadline is terminated and replaced', { skip, timeout: 10 * 60 * 1000 }, async (t) => {
  const { s, spend } = forcedCase();
  const o = createOracle({ treatmentDir: TREATMENT_DIR, pinsText, workers: 1, marginMs: -5000 });
  try {
    const r = await o.oracle(s, spend, P, 'csl', { timeLimitMs: LIMIT });
    t.diagnostic(JSON.stringify({ status: r.status, fee: String(r.fee), wallMs: Math.round(r.wallMs), terminated: r.terminated, tx: !!r.tx }));
    assert.equal(r.terminated, true);
    assert.ok(r.wallMs >= LIMIT - 5000 && r.wallMs < LIMIT, `terminated after ${r.wallMs} ms`);
    if (r.status === 'best-at-limit') assert.ok(r.tx && r.fee !== null);
    else assert.equal(r.status, 'undecided');
    assert.equal(o.stats.terminated, 1);
    // The next call runs on a fresh worker.
    const small = shapeState(T, 'S4').state;
    const sp = standardBattery(T, small, P, { pools: SHAPE_POOLS }).find((b) => b.id === 'ada-payment');
    const r2 = await o.oracle(small, sp, P, 'csl', { timeLimitMs: 10000 });
    assert.equal(r2.status, 'optimal');
    assert.equal(o.stats.workersStarted, 2);
  } finally {
    await o.close();
  }
});
