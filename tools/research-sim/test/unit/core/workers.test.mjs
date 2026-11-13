// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The worker count of the replay command (no cap: it changes no record), the
// machine record beside it and the watchdog's value. No CSL: every refusal
// comes before the treatment is loaded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pool from '../../../src/replay/pool.mjs';
import { workerCount, REPLAY_WATCHDOG_MS } from '../../../src/replay/pool.mjs';
import { workersOf, cmdReplay } from '../../../src/replay/commands.mjs';
import { machineRecord } from '../../../src/out/host.mjs';
import { RECORD_KINDS } from '../../../src/out/records.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';

test('the watchdog: a day per replay; no answer or oracle watchdog, time limit, record kind or class', () => {
  assert.equal(REPLAY_WATCHDOG_MS, 24 * 3600 * 1000);
  for (const gone of ['ANSWER_WATCHDOG_MS', 'REPLAY_LIMIT_MS', 'ANSWER_LIMIT_MS', 'MAX_BUSY_THREADS', 'checkBusyThreads']) assert.equal(pool[gone], undefined, gone);
  assert.ok(!RECORD_KINDS.includes('timeout'));
  assert.ok(!Object.values(CLASSES).includes('time-limit'));
});

test('worker counts are positive whole numbers', () => {
  assert.equal(workerCount(undefined, '--workers'), 1);
  assert.equal(workerCount('8', '--workers'), 8);
  assert.equal(workerCount(3, '--workers'), 3);
  for (const v of ['0', '-2', '1.5', 'x', '', true, 0, NaN]) assert.throws(() => workerCount(v, '--workers'), /--workers takes a positive whole number/, String(v));
});

test('any number of workers, with no cap', () => {
  assert.deepEqual(workersOf({ workers: '64' }), { workers: 64 });
  assert.deepEqual(workersOf({}), { workers: 1 });
  assert.throws(() => workersOf({ workers: '0' }), /--workers takes a positive whole number/);
});

test('the machine record: the worker count and the host, for the timings only', () => {
  const m = machineRecord({ workers: 6 });
  assert.deepEqual([m.workers, m.node, m.v8, m.platform], [6, process.version, process.versions.v8, process.platform]);
  assert.equal('oracleWorkers' in m, false);
  assert.ok(Number.isSafeInteger(m.logicalCores) && m.logicalCores > 0);
  assert.ok(Number.isSafeInteger(m.totalMemoryBytes) && m.totalMemoryBytes > 0);
});

test('the replay command refuses before anything is loaded', async () => {
  await assert.rejects(cmdReplay({ treatment: '/nonexistent', shapes: 'S1', plan: 'recent', collateralRule: 'ledger', workers: 'two' }), /--workers takes a positive whole number/);
});
