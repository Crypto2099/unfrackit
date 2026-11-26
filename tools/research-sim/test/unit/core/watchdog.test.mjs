// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The worker pool's time limit and machine reruns (src/replay/pool.mjs), over
// a stand-in worker process (test/lib/stub-pool-worker.mjs), with no
// treatment: a job whose build is running at the limit is killed and not run
// again, one between builds has the grace to stop by itself, and the limit
// applies to each attempt; a machine error makes the job run
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

test('replay: a job whose build is running at the limit is killed, not run again; its attempt, limit and the worker\'s info are reported', () => withPool(async (pool) => {
  const notes = [];
  const r = await pool.replay({ counter: counter(), attempts: ['stall:600'] }, { watchdogMs: 100, note: (e) => notes.push(e) });
  assert.equal(r.ok, true);
  assert.equal(r.result, undefined);
  assert.deepEqual(r.killed, { at: 'build', attempt: 1, limitMs: 100, info: null });
  assert.ok(r.ms >= 100 && r.ms < 500, `${r.ms} ms: the limit, not the stall`);
  assert.deepEqual(notes.map((e) => [e.event, e.watchdogMs, e.at, e.attempt]), [['watchdog stop', 100, 'running build', 1]]);
  assert.deepEqual([pool.stats.watchdogStops, pool.stats.machineReruns, pool.stats.started], [1, 0, 1]);
  // The worker has exited and its place is free.
  assert.deepEqual([pool.live.size, pool.stopping.size, pool.running.size], [0, 0, 0]);
}));

test('replay: a worker that reports a build running is killed at the limit, and one that reports none is given the grace to stop by itself', () => withPool(async (pool) => {
  const killed = await pool.replay({ counter: counter(), attempts: ['building:600'] }, { watchdogMs: 100 });
  assert.equal(killed.killed.at, 'build');
  // Between builds at the limit, and at its next spend boundary 100 ms later: the job's own answer stands, the worker stays.
  const notes = [];
  const own = await pool.replay({ counter: counter(), attempts: ['idle+selfstop:200'] }, { watchdogMs: 100, stopGraceMs: 5000, note: (e) => notes.push(e) });
  assert.equal(own.ok, true);
  assert.equal(own.killed, undefined);
  assert.deepEqual(own.result.stopped, { reason: 'excessive time', at: 'spend boundary', attempt: 1, spends: 3 });
  assert.deepEqual(notes.map((e) => [e.event, e.at, e.attempt, e.spends]), [['watchdog stop', 'spend boundary', 1, 3]]);
  assert.equal(pool.idle.length, 1, 'the worker that stopped by itself is reused');
  // Between builds and silent past the grace: killed, and said so.
  const late = await pool.replay({ counter: counter(), attempts: ['idle+sleep:3000'] }, { watchdogMs: 100, stopGraceMs: 150 });
  assert.deepEqual([late.killed.at, late.killed.attempt], ['grace', 1]);
  assert.ok(late.ms >= 250 && late.ms < 2000, `${late.ms} ms`);
  // Between builds, a worker that starts one after the limit is killed at once.
  const again = await pool.replay({ counter: counter(), attempts: ['idle+sleep:120+building:2000'] }, { watchdogMs: 100, stopGraceMs: 5000 });
  assert.equal(again.killed.at, 'build');
  assert.ok(again.ms < 1000, `${again.ms} ms`);
  assert.equal(pool.stats.watchdogStops, 4);
  assert.equal(pool.stats.machineReruns, 0);
}));

test('replay: the limit applies to each attempt: a job rerun after a machine error has its full limit again, is not doubled, and names its attempt', () => withPool(async (pool) => {
  const notes = [];
  const r = await pool.replay({ counter: counter(), attempts: ['stall:60+machine', 'stall:600'] }, { watchdogMs: 100, note: (e) => notes.push(e) });
  assert.deepEqual(r.killed, { at: 'build', attempt: 2, limitMs: 100, info: null });
  assert.deepEqual(notes.map((e) => [e.event, e.watchdogMs, e.attempt]), [['machine rerun', undefined, undefined], ['watchdog stop', 100, 2]]);
  assert.deepEqual([pool.stats.watchdogStops, pool.stats.machineReruns, pool.stats.started], [1, 1, 2]);
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

test('replay: jobs in parallel, one killed at the limit and one rerun after a machine error, the others complete', () => withPool(async (pool) => {
  const jobs = [['done'], ['stall:250', 'done'], ['done'], ['machine', 'done'], ['done']];
  const rs = await Promise.all(jobs.map((attempts) => pool.replay({ counter: counter(), attempts }, { watchdogMs: 100 })));
  assert.deepEqual(rs.map((r) => [r.ok, r.killed ? 'killed' : r.result.attempt]), [[true, 1], [true, 'killed'], [true, 1], [true, 2], [true, 1]]);
  assert.deepEqual([pool.stats.watchdogStops, pool.stats.machineReruns], [1, 1]);
  assert.ok(pool.live.size <= 2);
}, { size: 2 }));
