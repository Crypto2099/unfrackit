// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The time limits, forced: a replay that runs past its limit is recorded as
// timed out and its worker terminated, and the next job runs in a fresh
// worker; a method that does not answer within its limit has returned an
// error with the reason "time limit", and the wallet's remaining battery
// spends continue. The method that forces both is the registry's test-stall,
// which blocks its thread as a synchronous library call does.
//
// By default the limits are shortened (2 seconds) so the test is quick;
// RESEARCH_SIM_REAL_LIMITS=1 runs them at the study's values, 300 seconds per
// replay and 60 seconds per method answer.
// Needs RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treatment, skip, TREATMENT_DIR } from '../lib/treatment.mjs';
import { Pool, REPLAY_LIMIT_MS, ANSWER_LIMIT_MS } from '../../src/replay/pool.mjs';
import { runReplays, runBatteries } from '../../src/replay/run.mjs';
import { RunOutput } from '../../src/out/records.mjs';
import { DEFAULT_PINS } from '../../src/treatment/bridge.mjs';

const T = await treatment();
const REAL = process.env.RESEARCH_SIM_REAL_LIMITS === '1';
const replayLimit = REAL ? REPLAY_LIMIT_MS : 2000;
const answerLimit = REAL ? ANSWER_LIMIT_MS : 2000;
const pins = process.env.RESEARCH_SIM_TREATMENT_PINS || DEFAULT_PINS;

function withHome(fn) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'research-sim-limits-'));
    const prev = process.env.RESEARCH_SIM_HOME;
    process.env.RESEARCH_SIM_HOME = home;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.RESEARCH_SIM_HOME;
      else process.env.RESEARCH_SIM_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

const readRecords = (out) => readFileSync(join(out.dir, 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test(`a replay past its ${replayLimit / 1000}-second limit is recorded and its worker terminated`, { skip, timeout: replayLimit * 4 + 600 * 1000 }, withHome(async () => {
  const pool = new Pool({ treatmentDir: TREATMENT_DIR, pinsPath: pins, size: 1 });
  const out = new RunOutput('synthetic', 'limits-replay', { command: 'test' });
  try {
    const plan = [{ hypothesis: 'test', arm: 'observed', variant: 'default', role: 'stall', change: 'default', repetitions: 1 }, { hypothesis: 'test', arm: 'observed', variant: 'default', role: 'test', change: 'default', repetitions: 1 }];
    const t0 = performance.now();
    const totals = await runReplays(T, pool, { wallets: [{ spec: { kind: 'shape', name: 'S1', stream: 'synthetic' } }], plan, roles: { stall: 'test-stall', test: 'test-largest-first' }, out, limitMs: replayLimit, methodOptions: { 'test-stall': { stallMs: replayLimit * 3 } }, collateralRules: ['ledger'] });
    const ms = performance.now() - t0;
    out.close();
    const recs = readRecords(out);
    const timeouts = recs.filter((r) => r.kind === 'timeout');
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0].method, 'test-stall');
    assert.equal(timeouts[0].limitMs, replayLimit);
    assert.equal(pool.stats.terminated, 1);
    assert.equal(recs.filter((r) => r.kind === 'wallet-arm' && r.method === 'test-largest-first').length, 1, 'the next job ran in a fresh worker');
    assert.equal(pool.stats.started, 2);
    assert.equal(totals.timeouts, 1);
    assert.ok(ms >= replayLimit && ms < replayLimit + 120 * 1000, `${ms} ms`);
  } finally {
    await pool.close();
  }
}));

test(`a method answer past its ${answerLimit / 1000}-second limit is a time-limit error, and the battery continues`, { skip, timeout: answerLimit * 20 + 600 * 1000 }, withHome(async () => {
  const pool = new Pool({ treatmentDir: TREATMENT_DIR, pinsPath: pins, size: 1 });
  const out = new RunOutput('synthetic', 'limits-battery', { command: 'test' });
  try {
    // One stalling method on two spends, then the test method on every spend.
    const methods = [{ name: 'test-stall', options: { stallMs: answerLimit * 3, only: ['ada-payment', 'h10-0.5'] }, opts: [{ changePolicy: 'default' }], repetitions: 1 }, { name: 'test-largest-first', opts: [{ changePolicy: 'layout' }], repetitions: 1 }];
    const totals = await runBatteries(T, pool, { wallets: [{ spec: { kind: 'shape', name: 'S1', stream: null } }], methods, out, answerLimitMs: answerLimit });
    out.close();
    const recs = readRecords(out).filter((r) => r.kind === 'battery' && r.method !== 'none');
    const stall = recs.filter((r) => r.method === 'test-stall');
    const limited = stall.filter((r) => r.class === 'time-limit');
    // ada-payment, and h10-0.5 from both layouts.
    assert.deepEqual(limited.map((r) => `${r.spend} ${r.arm}`).sort(), ['ada-payment observed', 'h10-0.5 observed', 'h10-0.5 tidy-once']);
    assert.ok(stall.filter((r) => r.class !== 'time-limit').every((r) => r.detail === 'not stalled'));
    assert.equal(totals.timeouts, 3);
    assert.equal(pool.stats.terminated, 3);
    const others = recs.filter((r) => r.method === 'test-largest-first');
    assert.equal(others.length, stall.length, 'every spend ran under the test method too, after the time-outs');
    assert.ok(others.some((r) => r.ok));
  } finally {
    await pool.close();
  }
}));
