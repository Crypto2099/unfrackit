// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// --max-jobs is a machine option: a replay of S1 run with a fresh worker for
// every job (--max-jobs 1) writes the same run.json and the same records as
// one run with the pool's default, starts at least one worker per job, and
// records the value in the invocation's entry of machines/<label>.json, not in
// run.json. Needs RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treatment, skip, TREATMENT_DIR } from '../lib/treatment.mjs';
import { cmdReplay } from '../../src/replay/commands.mjs';
import { stageText } from '../lib/stage.mjs';

await treatment();

async function replay(runId, extra) {
  const { print } = await cmdReplay({ treatment: TREATMENT_DIR, shapes: 'S1', plan: 'peak', collateralRule: 'ledger', reps: '1', workers: '2', runId, ...(process.env.RESEARCH_SIM_TREATMENT_PINS ? { treatmentPins: process.env.RESEARCH_SIM_TREATMENT_PINS } : {}), ...extra });
  const text = (f) => readFileSync(join(print.dir, f), 'utf8');
  const machine = JSON.parse(text('machines/local.json'));
  return { print, run: text('run.json'), records: stageText(print.dir).split('\n').filter(Boolean), machine };
}

// The seeded methods' lines; the unseeded selectors' records vary between runs.
const seededOnly = (lines) => lines.filter((l) => !['csl-ri', 'cml-ri'].includes(JSON.parse(l).method));

test('--max-jobs 1 leaves run.json and the records as they are, starts a worker per job and is recorded with the machine', { skip, timeout: 12 * 60 * 1000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'research-sim-max-jobs-'));
  const prev = process.env.RESEARCH_SIM_HOME;
  process.env.RESEARCH_SIM_HOME = home;
  try {
    const plain = await replay('max-jobs-default', {});
    const fresh = await replay('max-jobs-one', { maxJobs: '1' });
    // run.json holds the options that change a record; the run IDs differ in
    // nothing it holds.
    assert.equal(fresh.run, plain.run);
    assert.equal(/maxJobs|max-jobs/.test(fresh.run), false);
    assert.deepEqual(seededOnly(fresh.records), seededOnly(plain.records));
    const jobs = fresh.print.totals.jobs;
    assert.equal(jobs, 48);
    const last = (m) => m.invocations[m.invocations.length - 1];
    assert.equal(last(fresh.machine).maxJobs, 1);
    assert.equal(last(plain.machine).maxJobs, 40);
    assert.ok(fresh.print.workers.started >= jobs, `started ${fresh.print.workers.started} workers`);
    assert.ok(fresh.print.workers.started > plain.print.workers.started);
  } finally {
    if (prev === undefined) delete process.env.RESEARCH_SIM_HOME;
    else process.env.RESEARCH_SIM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
