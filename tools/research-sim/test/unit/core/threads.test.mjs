// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The thread cap of the replay and battery commands, the battery's oracle
// settings (the work budget only), and the unseeded runs the battery keeps
// beside a reference. No CSL: every refusal comes before the treatment is
// loaded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BUSY_THREADS, workerCount, checkBusyThreads } from '../../../src/replay/pool.mjs';
import { threadsOf, batteryOracleSettings, cmdReplay, cmdBattery } from '../../../src/replay/commands.mjs';
import { unseededBeside } from '../../../src/replay/run.mjs';
import { MAX_BUSY_THREADS as LIVE_FIRE_CAP } from '../../../src/study/live-fire.mjs';
import { ORACLE_SETTINGS } from '../../../src/oracle/settings.mjs';

test('one cap of 12 busy threads, shared by every command', () => {
  assert.equal(MAX_BUSY_THREADS, 12);
  assert.equal(LIVE_FIRE_CAP, MAX_BUSY_THREADS);
});

test('worker counts are positive whole numbers', () => {
  assert.equal(workerCount(undefined, '--workers'), 1);
  assert.equal(workerCount('8', '--workers'), 8);
  assert.equal(workerCount(3, '--workers'), 3);
  for (const v of ['0', '-2', '1.5', 'x', '', true, 0, NaN]) assert.throws(() => workerCount(v, '--workers'), /--workers takes a positive whole number/, String(v));
});

test('replay refuses more than 12 workers; battery more than 12 workers and oracle workers together', () => {
  assert.deepEqual(checkBusyThreads(12), { workers: 12, oracleWorkers: 0, busy: 12, cap: 12 });
  assert.throws(() => checkBusyThreads(13), /refusing: --workers may keep at most 12 threads busy \(13 asked\)/);
  assert.deepEqual(threadsOf({ workers: '12' }, 'replay'), { workers: 12, oracleWorkers: 0, busy: 12, cap: 12 });
  assert.throws(() => threadsOf({ workers: '13' }, 'replay'), /--workers may keep at most 12/);
  // The replay command has no oracle; --oracle-workers starts nothing there.
  assert.deepEqual(threadsOf({ workers: '12', oracleWorkers: '4' }, 'replay').busy, 12);
  assert.deepEqual(threadsOf({ workers: '8', oracle: true, oracleWorkers: '4' }, 'battery'), { workers: 8, oracleWorkers: 4, busy: 12, cap: 12 });
  assert.deepEqual(threadsOf({ workers: '11', oracle: true }, 'battery'), { workers: 11, oracleWorkers: 1, busy: 12, cap: 12 });
  assert.throws(() => threadsOf({ workers: '8', oracle: true, oracleWorkers: '5' }, 'battery'), /--workers and --oracle-workers together may keep at most 12 threads busy \(13 asked\)/);
  assert.throws(() => threadsOf({ workers: '12', oracle: true }, 'battery'), /\(13 asked\)/);
  // Without --oracle the battery starts no oracle worker.
  assert.equal(threadsOf({ workers: '12', oracleWorkers: '4' }, 'battery').busy, 12);
});

test('the commands refuse before anything is loaded', async () => {
  await assert.rejects(cmdReplay({ treatment: '/nonexistent', plan: 'test', shapes: 'S1', workers: '13' }), /at most 12 threads busy/);
  await assert.rejects(cmdBattery({ treatment: '/nonexistent', shapes: 'S1', workers: '6', oracle: true, oracleWorkers: '7' }), /at most 12 threads busy/);
  await assert.rejects(cmdBattery({ treatment: '/nonexistent', shapes: 'S1', workers: 'two' }), /--workers takes a positive whole number/);
  await assert.rejects(cmdBattery({ treatment: '/nonexistent', shapes: 'S1', oracle: true, oracleLimitMs: '60000' }), /--oracle-limit-ms is gone/);
  await assert.rejects(cmdBattery({ treatment: '/nonexistent', shapes: 'S1', oracle: true, oracleSettings: 'limit=wall-clock' }), /limit=wall-clock is kept for the oracle's checks/);
});

test('the battery\'s oracle settings: the defaults, overrides of the budget, never the wall-clock limit', () => {
  assert.equal(batteryOracleSettings({}), null);
  assert.deepEqual(batteryOracleSettings({ oracle: true }), ORACLE_SETTINGS);
  const s = batteryOracleSettings({ oracle: true, oracleSettings: 'maxCandidateSets=50,maxSolves=5' });
  assert.deepEqual([s.limit, s.maxCandidateSets, s.maxSolves, s.maxSolveNodes], ['budget', 50, 5, ORACLE_SETTINGS.maxSolveNodes]);
  assert.throws(() => batteryOracleSettings({ oracle: true, oracleSettings: 'maxSolves=0' }), /not implemented/);
  assert.throws(() => batteryOracleSettings({ oracleLimitMs: '1000' }), /--oracle-limit-ms is gone/);
});

test('unseeded runs beside a reference: per method, the runs, those below it, the least fee', () => {
  const runs = [{ name: 'csl-ri', fee: 172000n }, { name: 'csl-ri', fee: 170500n }, { name: 'csl-ri', fee: 171000n }, { name: 'other', fee: 180000n }];
  assert.deepEqual(unseededBeside(runs, 171000n), [{ name: 'csl-ri', runs: 3, below: 1, least: 170500n }, { name: 'other', runs: 1, below: 0, least: 180000n }]);
  // A reference with no fee is above every passing run.
  assert.deepEqual(unseededBeside(runs.slice(0, 2), null), [{ name: 'csl-ri', runs: 2, below: 2, least: 170500n }]);
  assert.deepEqual(unseededBeside([], 1n), []);
});
