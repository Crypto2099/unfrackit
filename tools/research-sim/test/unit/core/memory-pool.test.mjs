// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The worker pool's memory rules (src/replay/pool.mjs), over a stand-in
// worker process (test/lib/stub-pool-worker.mjs), with no treatment: jobs
// admitted against the budget in the order they ask; a job above the budget
// run alone, without deadlock; idle workers stopped to make room; a worker
// grown past its share or past half its CSL memory's ceiling replaced after
// its job; a killed worker's job run again with its estimate doubled, then
// alone, then failed naming the job; a wallet's estimate raised after a
// measured overrun. Also the estimate, the budget's default and the readings
// from /proc. The stand-in's estimates are job.est MiB, and its workers hold
// about 50 MiB idle.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool, MEMORY_ESTIMATE, jobEstimate, walletMemory, memoryAvailable, defaultMemoryBudget, processMemory, jobName } from '../../../src/replay/pool.mjs';
import { wasmMemoryMaximum } from '../../../src/kit/heap.mjs';
import { machineRecord } from '../../../src/out/host.mjs';

const MiB = 1024 * 1024;
const STUB = new URL('../../lib/stub-pool-worker.mjs', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'research-sim-memory-pool-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;
const counter = () => join(dir, `c${seq++}`);

async function withPool(fn, opts = {}) {
  const pool = new Pool({ treatmentDir: '/stand-in', workerUrl: STUB, estimate: (job) => job.est * MiB, ...opts });
  try {
    return await fn(pool);
  } finally {
    await pool.close();
  }
}

const job = (est, attempts, extra = {}) => ({ counter: counter(), est, attempts, trace: true, ...extra });

test('admission: a job waits until the running jobs\' memory is freed, and a later lighter job does not pass it', () => withPool(async (pool) => {
  const a = pool.replay(job(600, ['sleep:300']));
  const b = pool.replay(job(600, ['done']));
  const c = pool.replay(job(100, ['done']));
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert.ok(ra.ok && rb.ok && rc.ok);
  assert.ok(rb.result.start >= ra.result.end, 'b started after a ended');
  assert.ok(rc.result.start >= ra.result.end, 'c, which would have fitted beside a, started after b');
  assert.equal(pool.stats.admissionWaits, 1);
  assert.equal(pool.stats.aloneRuns, 0);
}, { size: 3, memoryBudget: 1000 * MiB }));

test('admission: a job above the budget runs alone once nothing else runs, the log says the machine is short, and the run goes on', () => withPool(async (pool) => {
  const notes = [];
  const y = pool.replay(job(100, ['sleep:200']));
  const x = pool.replay(job(800, ['sleep:200']), { note: (e) => notes.push(e) });
  const z = pool.replay(job(100, ['done']));
  const [ry, rx, rz] = await Promise.all([y, x, z]);
  assert.ok(ry.ok && rx.ok && rz.ok);
  assert.ok(rx.result.start >= ry.result.end, 'x waited for y');
  assert.ok(rz.result.start >= rx.result.end, 'z waited for x, which ran alone');
  assert.deepEqual(notes, [{ event: 'machine short of memory', estimateBytes: 800 * MiB, budgetBytes: 500 * MiB }]);
  assert.deepEqual([pool.stats.aloneRuns, pool.stats.admissionWaits], [1, 1]);
}, { size: 3, memoryBudget: 500 * MiB }));

test('admission: idle workers are stopped, largest first, when that makes a job fit', () => withPool(async (pool) => {
  // Two workers left idle at about 200 MiB each (under the 300 MiB share).
  await Promise.all([pool.replay(job(100, ['hold:150+sleep:100'])), pool.replay(job(100, ['hold:150+sleep:100']))]);
  assert.equal(pool.idle.length, 2);
  const r = await pool.replay(job(450, ['done']));
  assert.ok(r.ok);
  assert.deepEqual([pool.stats.started, pool.idle.length, pool.live.size], [2, 1, 1]);
}, { size: 2, memoryBudget: 600 * MiB }));

test('recycling: a worker whose resident size passes the budget over the worker count, or whose CSL memory passes half its ceiling, is replaced after its job', () => withPool(async (pool) => {
  // 400 MiB over 2 workers: 200 MiB each.
  const big = await pool.replay(job(100, ['hold:250']));
  assert.ok(big.ok);
  assert.deepEqual([pool.stats.recycledBySize, pool.idle.length, pool.live.size], [1, 0, 0]);
  const csl = await pool.replay(job(100, ['csl:2100']));
  assert.ok(csl.ok);
  assert.deepEqual([pool.stats.recycledBySize, pool.idle.length], [2, 0]);
  const small = await pool.replay(job(100, ['csl:1000']));
  assert.ok(small.ok);
  assert.deepEqual([pool.stats.recycledBySize, pool.idle.length, pool.stats.recycled], [2, 1, 0]);
  // maxJobs stays a second bound.
  await pool.replay(job(100, ['done']));
  assert.deepEqual([pool.stats.recycled, pool.idle.length], [1, 0]);
}, { size: 2, memoryBudget: 400 * MiB, maxJobs: 2 }));

test('out of memory: a killed worker\'s job runs again in a fresh worker with its estimate doubled, then alone with the whole budget', () => withPool(async (pool) => {
  const notes = [];
  const y = pool.replay(job(100, ['sleep:400']));
  const x = pool.replay(job(300, ['kill', 'kill', 'done']), { note: (e) => notes.push(e) });
  const [ry, rx] = await Promise.all([y, x]);
  assert.ok(ry.ok && rx.ok);
  assert.deepEqual([rx.result.attempt, rx.result.record], [3, true]);
  assert.deepEqual(notes.map((e) => [e.event, e.cause, e.estimateBytes, e.alone]), [
    ['machine rerun', 'worker died', 600 * MiB, false],
    ['machine rerun', 'worker died', 600 * MiB, true],
    ['running alone', undefined, undefined, undefined]
  ]);
  assert.match(notes[0].error, /the worker was killed by SIGKILL/);
  assert.ok(rx.result.start >= ry.result.end, 'the third attempt ran alone, after y');
  // y's worker, the first two attempts' and a fresh one for the third.
  assert.equal(pool.stats.started, 4);
  assert.deepEqual([pool.stats.outOfMemoryReruns, pool.stats.machineReruns, pool.stats.aloneRuns], [2, 2, 1]);
}, { size: 2, memoryBudget: 1000 * MiB }));

test('out of memory: a third death fails the job with a message naming it, and the other jobs run', () => withPool(async (pool) => {
  const key = { wallet: 'S1', window: 'synthetic', arm: 'observed', variant: 'default', method: 'csl-lf', change: 'default', collateral: 'ledger', repetition: 2 };
  const [d, ok] = await Promise.all([pool.replay(job(100, ['kill'], { key })), pool.replay(job(100, ['sleep:100']))]);
  assert.equal(d.ok, false);
  assert.equal(d.error, 'wallet S1 observed/default csl-lf change default collateral ledger repetition 2: its worker died three times, the last: the worker was killed by SIGKILL');
  assert.ok(ok.ok);
  assert.equal(pool.stats.outOfMemoryReruns, 2);
  // The battery counts deaths at each run.
  const b = await pool.battery({ counter: counter(), est: 100, source: { kind: 'shape', name: 'M2' }, runs: 3, attempts: [{ die: 1 }] });
  assert.equal(b.ok, false);
  assert.equal(b.error, 'wallet M2: its worker died three times at run 1, the last: the worker exited with code 3');
}, { size: 2, memoryBudget: 1000 * MiB }));

test('the estimate: a wallet\'s rises to the peak measured when a job passed it, and only that wallet\'s', () => withPool(async (pool) => {
  const s1 = { kind: 'shape', name: 'S1' };
  const r = await pool.replay(job(20, ['hold:100'], { source: s1 }));
  assert.ok(r.ok);
  const raised = pool.estimateOf({ est: 20, source: s1 });
  assert.ok(raised > 120 * MiB, `${raised / MiB} MiB`);
  assert.equal(pool.estimateOf({ est: 20, source: { kind: 'shape', name: 'S6' } }), 20 * MiB);
  assert.equal(pool.estimateOf({ est: 500, source: s1 }), 500 * MiB, 'a larger estimate of its own stands');
  assert.equal(pool.stats.estimatesRaised, 1);
}));

test('the per-job estimate: a base, a UTxO term and an event term, from the wallet\'s start, deposits and events', () => {
  const { baseMiB, utxoKiB, eventKiB } = MEMORY_ESTIMATE;
  assert.equal(jobEstimate({ utxos: 0, events: 0 }), baseMiB * MiB);
  assert.equal(jobEstimate(undefined), baseMiB * MiB);
  assert.equal(jobEstimate({ utxos: 20000, events: 500 }), Math.round(baseMiB * MiB + 20000 * utxoKiB * 1024 + 500 * eventKiB * 1024));
  const source = { start: [1, 2, 3], events: [{ kind: 'intent' }, { kind: 'deposit', utxos: [4, 5] }, { kind: 'mark' }, { kind: 'deposit', utxos: [6] }] };
  assert.deepEqual(walletMemory(source), { utxos: 6, events: 4 });
});

test('the budget\'s default is 80% of MemAvailable; the readings from /proc are bytes', () => {
  assert.equal(memoryAvailable('MemTotal:       24000000 kB\nMemFree:  1 kB\nMemAvailable:   20000000 kB\n'), 20000000 * 1024);
  const d = defaultMemoryBudget();
  assert.ok(Number.isSafeInteger(d) && d > 0);
  const m = processMemory(process.pid);
  if (m === null) return;
  assert.ok(m.rss > 10 * MiB && m.hwm >= m.rss);
  assert.equal(processMemory(2 ** 30), null);
});

test('a WebAssembly memory\'s declared maximum; the machine record carries the budget', () => {
  // magic, version, a memory section with one memory: min 1, max 3; then none.
  const head = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  assert.equal(wasmMemoryMaximum(Uint8Array.from([...head, 0x05, 0x04, 0x01, 0x01, 0x01, 0x03])), 3);
  assert.equal(wasmMemoryMaximum(Uint8Array.from([...head, 0x05, 0x03, 0x01, 0x00, 0x13])), null);
  assert.equal(wasmMemoryMaximum(Uint8Array.from(head)), undefined);
  assert.equal(machineRecord({ workers: 4, memoryBudgetBytes: 2 * 1024 ** 3 }).memoryBudgetBytes, 2 * 1024 ** 3);
  assert.ok(!('memoryBudgetBytes' in machineRecord({ workers: 4 })));
  assert.equal(jobName({ source: { kind: 'history', path: '/a/b/w123.jsonl' } }), 'wallet file w123.jsonl');
});
