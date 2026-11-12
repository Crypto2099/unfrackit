// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The worker pool's watchdogs and machine reruns (src/replay/pool.mjs), over
// a stand-in worker process (test/lib/stub-pool-worker.mjs), with no
// treatment: a watchdog stop is never a result, and the work runs again with
// its watchdog doubled until it completes; a machine error makes the job run
// again once in a fresh worker that records machine errors, and only what
// happens there stands; a dead worker makes it run again in a fresh worker
// that records them, then alone, and a third death fails it; any other error
// fails the job at once. Also which errors are the machine's
// (src/kit/machine.mjs). The pool's memory rules are in memory-pool.test.mjs.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from '../../../src/replay/pool.mjs';
import { MachineError, isMachineError, passMachineErrors, recordMachineErrors, recordingMachineErrors } from '../../../src/kit/machine.mjs';

const STUB = new URL('../../lib/stub-pool-worker.mjs', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'research-sim-watchdog-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;
const counter = () => join(dir, `c${seq++}`);

async function withPool(fn, opts = {}) {
  const pool = new Pool({ treatmentDir: '/stand-in', workerUrl: STUB, ...opts });
  try {
    return await fn(pool);
  } finally {
    await pool.close();
  }
}

test('errors the machine can cause: RangeErrors and WebAssembly RuntimeErrors, not Node\'s argument checks', () => {
  assert.ok(isMachineError(new RangeError('Array buffer allocation failed')));
  assert.ok(isMachineError(new RangeError('Maximum call stack size exceeded')));
  assert.ok(isMachineError(new WebAssembly.RuntimeError('unreachable')));
  assert.ok(isMachineError(Object.assign(new Error('memory access out of bounds'), { name: 'RuntimeError' })));
  assert.ok(isMachineError(new MachineError(new RangeError('x'))));
  const range = (() => {
    try {
      Buffer.alloc(2).readUInt32LE(0);
    } catch (e) {
      return e;
    }
    return null;
  })();
  assert.ok(range instanceof RangeError && /^ERR_/.test(range.code));
  assert.equal(isMachineError(range), false, 'a buffer read past its end is the input\'s');
  for (const e of [new Error('x'), new TypeError('x'), 'RangeError', null, undefined]) assert.equal(isMachineError(e), false, String(e));
});

test('passMachineErrors throws a machine error on unless the job records them', () => {
  assert.equal(recordingMachineErrors(), false);
  assert.throws(() => passMachineErrors(new RangeError('heap')), (e) => e instanceof MachineError && e.message === 'RangeError: heap' && e.cause instanceof RangeError);
  assert.doesNotThrow(() => passMachineErrors(new Error('a method failure')));
  recordMachineErrors(true);
  try {
    assert.doesNotThrow(() => passMachineErrors(new RangeError('heap')));
    assert.throws(() => passMachineErrors(new MachineError(new RangeError('heap'))), MachineError);
  } finally {
    recordMachineErrors(false);
  }
});

test('replay: a watchdog stop sets the attempt aside, and the job runs again with the watchdog doubled until it completes', () => withPool(async (pool) => {
  const notes = [];
  const r = await pool.replay({ counter: counter(), attempts: ['stall:300'] }, { watchdogMs: 100, note: (e) => notes.push(e) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { attempt: 3, record: false });
  assert.deepEqual(notes.map((e) => [e.event, e.watchdogMs]), [['watchdog stop', 100], ['watchdog stop', 200]]);
  assert.ok(r.ms >= 300, `${r.ms} ms: the completing attempt's time`);
  assert.deepEqual([pool.stats.watchdogStops, pool.stats.machineReruns, pool.stats.started], [2, 0, 3]);
}));

test('replay: a machine error runs the job again once in a fresh worker that records them; what happens there stands', () => withPool(async (pool) => {
  const notes = [];
  const r = await pool.replay({ counter: counter(), attempts: ['machine', 'done'] }, { note: (e) => notes.push(e) });
  assert.deepEqual([r.ok, r.result], [true, { attempt: 2, record: true }]);
  assert.deepEqual(notes.map((e) => [e.event, e.cause]), [['machine rerun', 'machine error']]);
  assert.deepEqual([pool.stats.machineReruns, pool.stats.started], [1, 2]);
  // The worker that recorded is retired after its job.
  assert.equal(pool.live.size, 0);
  const again = await pool.replay({ counter: counter(), attempts: ['machine'] });
  assert.equal(again.ok, false);
  assert.match(again.error, /RangeError: stand-in heap/);
  assert.equal(pool.stats.machineReruns, 2);
}));

test('replay: a worker that dies runs the job again in a fresh worker, then alone; a third death fails it, naming the job', () => withPool(async (pool) => {
  const r = await pool.replay({ counter: counter(), attempts: ['die', 'done'] });
  assert.deepEqual([r.ok, r.result], [true, { attempt: 2, record: true }]);
  const t = await pool.replay({ counter: counter(), attempts: ['throw', 'done'] });
  assert.deepEqual([t.ok, t.result.attempt], [true, 2]);
  const d = await pool.replay({ counter: counter(), source: { kind: 'shape', name: 'S1' }, attempts: ['die'] });
  assert.equal(d.ok, false);
  assert.match(d.error, /^wallet S1: its worker died three times, the last: the worker exited with code 3$/);
  assert.deepEqual([pool.stats.machineReruns, pool.stats.outOfMemoryReruns], [4, 4]);
}));

test('replay: an error that is not the machine\'s fails the job at once, and the worker stays', () => withPool(async (pool) => {
  const r = await pool.replay({ counter: counter(), attempts: ['error', 'done'] });
  assert.deepEqual([r.ok, r.error], [false, 'Error: stand-in']);
  assert.deepEqual([pool.stats.machineReruns, pool.stats.watchdogStops, pool.stats.started, pool.idle.length], [0, 0, 1, 1]);
}));

test('replay: jobs in parallel each run to completion, one stopped among them', () => withPool(async (pool) => {
  const jobs = [['done'], ['stall:250', 'done'], ['done'], ['machine', 'done'], ['done']];
  const rs = await Promise.all(jobs.map((attempts) => pool.replay({ counter: counter(), attempts }, { watchdogMs: 100 })));
  assert.deepEqual(rs.map((r) => [r.ok, r.result.attempt]), [[true, 1], [true, 2], [true, 1], [true, 2], [true, 1]]);
  assert.deepEqual([pool.stats.watchdogStops, pool.stats.machineReruns], [1, 1]);
  assert.ok(pool.live.size <= 2);
}, { size: 2 }));
