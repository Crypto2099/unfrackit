// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The oracle pool's watchdog and machine reruns (src/oracle/oracle.mjs),
// over a stand-in worker (test/lib/stub-oracle-worker.mjs), with no treatment
// or solver. Under the work budget a call runs to completion: one the
// watchdog stops runs again with the watchdog doubled and is never recorded
// as stopped; a call that ends with stop solver-error, a machine error or a
// dead worker runs again once in a fresh worker that records machine errors,
// and its result or error stands; a refusal stands at once. Under the
// wall-clock limit, kept for the oracle's checks, the guard at the limit
// still ends the call undecided.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOracle } from '../../../src/oracle/oracle.mjs';
import { oracleSettings } from '../../../src/oracle/settings.mjs';
import { OracleRefusal } from '../../../src/oracle/spend.mjs';

const STUB = new URL('../../lib/stub-oracle-worker.mjs', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'research-sim-oracle-watchdog-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;
const stub = (attempts) => ({ counter: join(dir, `c${seq++}`), attempts });

async function withOracle(fn, opts = {}) {
  const notes = [];
  const o = createOracle({ treatmentDir: '/stand-in', pinsText: '', workerUrl: STUB, note: (e) => notes.push(e), ...opts });
  try {
    return await fn(o, notes);
  } finally {
    await o.close();
  }
}

const call = (o, attempts, extra = {}) => o.oracle(null, null, null, 'csl', { stub: stub(attempts), ...extra });

test('a call the watchdog stops runs again with the watchdog doubled, until it returns; the stop is never its result', () => withOracle(async (o, notes) => {
  const r = await call(o, ['stall:300']);
  assert.deepEqual([r.status, r.stop, r.attempt, r.terminated], ['optimal', 'proven', 3, false]);
  assert.deepEqual(notes.map((e) => [e.event, e.watchdogMs]), [['watchdog stop', 100], ['watchdog stop', 200]]);
  assert.deepEqual([o.stats.watchdogStops, o.stats.machineReruns, o.stats.workersStarted, o.stats.calls], [2, 0, 3, 1]);
  // A call's own watchdogMs overrides the oracle's.
  const q = await call(o, ['stall:150'], { watchdogMs: 1000 });
  assert.equal(q.attempt, 1);
  assert.equal(o.stats.watchdogStops, 2);
}, { watchdogMs: 100 }));

test('stop solver-error runs the call again once in a fresh worker; the rerun\'s result stands', () => withOracle(async (o, notes) => {
  const r = await call(o, ['solver-error', 'done']);
  assert.deepEqual([r.stop, r.attempt, r.record], ['proven', 2, true]);
  assert.deepEqual(notes.map((e) => [e.event, e.cause]), [['machine rerun', 'solver error']]);
  const again = await call(o, ['solver-error']);
  assert.deepEqual([again.stop, again.attempt, again.record], ['solver-error', 2, true]);
  assert.equal(o.stats.machineReruns, 2);
}));

test('a machine error or a dead worker runs the call again once; twice is an error, and a refusal stands at once', () => withOracle(async (o) => {
  assert.equal((await call(o, ['machine', 'done'])).attempt, 2);
  await assert.rejects(call(o, ['machine']), /oracle worker: RuntimeError: unreachable/);
  assert.equal((await call(o, ['die', 'done'])).attempt, 2);
  await assert.rejects(call(o, ['die']), /exited with code 3/);
  const before = o.stats.machineReruns;
  await assert.rejects(call(o, ['refusal', 'done']), (e) => e instanceof OracleRefusal);
  assert.equal(o.stats.machineReruns, before);
  // The pool still serves calls.
  assert.equal((await call(o, ['done'])).attempt, 1);
}, { workers: 2 }));

test('under the wall-clock limit the guard still ends a call undecided, with no rerun', () => withOracle(async (o) => {
  const settings = oracleSettings({ limit: 'wall-clock' });
  const r = await call(o, ['stall:400'], { settings, timeLimitMs: 100 });
  assert.deepEqual([r.status, r.stop, r.terminated, r.fee], ['undecided', 'guard', true, null]);
  assert.deepEqual([o.stats.terminated, o.stats.watchdogStops], [1, 0]);
}, { marginMs: 0 }));
