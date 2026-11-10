// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The worker counts of the replay and battery commands (no cap: they change
// no record), the machine record beside them, the watchdogs' values, the
// battery's oracle settings (the work budget only), and the unseeded runs the
// battery keeps beside a reference. No CSL: every refusal comes before the
// treatment is loaded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pool from '../../../src/replay/pool.mjs';
import { workerCount, REPLAY_WATCHDOG_MS, ANSWER_WATCHDOG_MS } from '../../../src/replay/pool.mjs';
import { workersOf, batteryOracleSettings, cmdReplay, cmdBattery } from '../../../src/replay/commands.mjs';
import { unseededBeside } from '../../../src/replay/run.mjs';
import { ORACLE_SETTINGS, ORACLE_WATCHDOG_MS, oracleSettings } from '../../../src/oracle/settings.mjs';
import { machineRecord } from '../../../src/out/host.mjs';
import { RECORD_KINDS } from '../../../src/out/records.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';

test('the watchdogs: a day per replay, half an hour per answer, an hour per oracle call; no time limit, record kind or class', () => {
  assert.deepEqual([REPLAY_WATCHDOG_MS, ANSWER_WATCHDOG_MS, ORACLE_WATCHDOG_MS], [24 * 3600 * 1000, 30 * 60 * 1000, 3600 * 1000]);
  for (const gone of ['REPLAY_LIMIT_MS', 'ANSWER_LIMIT_MS', 'MAX_BUSY_THREADS', 'checkBusyThreads']) assert.equal(pool[gone], undefined, gone);
  assert.ok(!RECORD_KINDS.includes('timeout'));
  assert.ok(!Object.values(CLASSES).includes('time-limit'));
  // The oracle's watchdog is not a setting, so no result records it.
  assert.ok(!('guardMs' in ORACLE_SETTINGS));
  assert.throws(() => oracleSettings({ guardMs: '3000' }), /the oracle setting guardMs is gone/);
});

test('worker counts are positive whole numbers', () => {
  assert.equal(workerCount(undefined, '--workers'), 1);
  assert.equal(workerCount('8', '--workers'), 8);
  assert.equal(workerCount(3, '--workers'), 3);
  for (const v of ['0', '-2', '1.5', 'x', '', true, 0, NaN]) assert.throws(() => workerCount(v, '--workers'), /--workers takes a positive whole number/, String(v));
});

test('any number of workers: replay\'s, and battery\'s with the oracle\'s, with no cap', () => {
  assert.deepEqual(workersOf({ workers: '64' }, 'replay'), { workers: 64, oracleWorkers: 0 });
  // The replay command has no oracle; --oracle-workers starts nothing there.
  assert.deepEqual(workersOf({ workers: '12', oracleWorkers: '4' }, 'replay'), { workers: 12, oracleWorkers: 0 });
  assert.deepEqual(workersOf({ workers: '48', oracle: true, oracleWorkers: '16' }, 'battery'), { workers: 48, oracleWorkers: 16 });
  assert.deepEqual(workersOf({ oracle: true }, 'battery'), { workers: 1, oracleWorkers: 1 });
  // Without --oracle the battery starts no oracle worker.
  assert.deepEqual(workersOf({ workers: '12', oracleWorkers: '4' }, 'battery'), { workers: 12, oracleWorkers: 0 });
  assert.throws(() => workersOf({ workers: '0' }, 'replay'), /--workers takes a positive whole number/);
});

test('the machine record: the worker counts and the host, for the timings only', () => {
  const m = machineRecord({ workers: 6, oracleWorkers: 2 });
  assert.deepEqual([m.workers, m.oracleWorkers, m.node, m.v8, m.platform], [6, 2, process.version, process.versions.v8, process.platform]);
  assert.ok(Number.isSafeInteger(m.logicalCores) && m.logicalCores > 0);
  assert.ok(Number.isSafeInteger(m.totalMemoryBytes) && m.totalMemoryBytes > 0);
  assert.equal(machineRecord({ workers: 1 }).oracleWorkers, 0);
});

test('the commands refuse before anything is loaded', async () => {
  await assert.rejects(cmdBattery({ treatment: '/nonexistent', shapes: 'S1', workers: 'two' }), /--workers takes a positive whole number/);
  await assert.rejects(cmdBattery({ treatment: '/nonexistent', shapes: 'S1', oracle: true, oracleLimitMs: '60000' }), /--oracle-limit-ms is gone/);
  await assert.rejects(cmdBattery({ treatment: '/nonexistent', shapes: 'S1', oracle: true, oracleSettings: 'limit=wall-clock' }), /limit=wall-clock is kept for the oracle's checks/);
});

test('the battery\'s oracle settings: the defaults, overrides of the budget, never the wall-clock limit', () => {
  assert.equal(batteryOracleSettings({}), null);
  assert.deepEqual(batteryOracleSettings({ oracle: true }), ORACLE_SETTINGS);
  const s = batteryOracleSettings({ oracle: true, oracleSettings: 'maxCandidateSets=50,maxProgramWork=5000' });
  assert.deepEqual([s.limit, s.maxCandidateSets, s.maxProgramWork], ['budget', 50, 5000]);
  assert.throws(() => batteryOracleSettings({ oracle: true, oracleSettings: 'maxProgramWork=0' }), /not implemented/);
  assert.throws(() => batteryOracleSettings({ oracle: true, oracleSettings: 'maxSolves=5' }), /unknown oracle setting maxSolves/);
  assert.throws(() => batteryOracleSettings({ oracleLimitMs: '1000' }), /--oracle-limit-ms is gone/);
  assert.throws(() => batteryOracleSettings({ oracle: true, oracleSettings: 'guardMs=3000' }), /the oracle setting guardMs is gone/);
});

test('unseeded runs beside a reference: per method, the runs, those below it, the least fee', () => {
  const runs = [{ name: 'csl-ri', fee: 172000n }, { name: 'csl-ri', fee: 170500n }, { name: 'csl-ri', fee: 171000n }, { name: 'other', fee: 180000n }];
  assert.deepEqual(unseededBeside(runs, 171000n), [{ name: 'csl-ri', runs: 3, below: 1, least: 170500n }, { name: 'other', runs: 1, below: 0, least: 180000n }]);
  // A reference with no fee is above every passing run.
  assert.deepEqual(unseededBeside(runs.slice(0, 2), null), [{ name: 'csl-ri', runs: 2, below: 2, least: 170500n }]);
  assert.deepEqual(unseededBeside([], 1n), []);
});
