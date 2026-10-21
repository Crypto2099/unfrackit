// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The check log: entries appended in order with a digest chain, an edit to an
// earlier line detected, kept outputs listed until a cleanup entry closes
// them, and numbers kept out of logged error text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEntry, verifyLog, sanitize, checkLogPath } from '../../src/checklog.mjs';
import { stripPlan } from '../../src/db.mjs';

test('append, chain, tamper detection, kept outputs', () => {
  const home = mkdtempSync(join(tmpdir(), 'rc-log-'));
  const prev = process.env.RESEARCH_CORPUS_HOME;
  process.env.RESEARCH_CORPUS_HOME = home;
  try {
    const a = appendEntry('mainnet', 'live-fire', { run_id: 'lf1', outcome: 'succeeded', wallet_level_output: 'kept for debugging' });
    appendEntry('mainnet', 'fix', { finding: 'a step timed out', commit: 'abc1234' });
    assert.equal(a.seq, 1);
    let v = verifyLog('mainnet');
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.kept_not_cleaned, [{ run_id: 'lf1', seq: 1 }]);
    appendEntry('mainnet', 'cleanup', { run_id: 'lf1', outcome: 'succeeded' });
    v = verifyLog('mainnet');
    assert.deepEqual(v.kept_not_cleaned, []);
    assert.equal(v.entries, 3);
    assert.equal(statSync(checkLogPath('mainnet')).mode & 0o777, 0o600);
    const text = readFileSync(checkLogPath('mainnet'), 'utf8');
    assert.ok(text.endsWith('\n'));
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(Object.keys(lines[0]).slice(0, 4), ['seq', 'prev', 'date', 'type']);
    writeFileSync(checkLogPath('mainnet'), text.replace('a step timed out', 'a step timed  out'));
    assert.match(verifyLog('mainnet').errors.join(), /line 3: prev/);
  } finally {
    if (prev === undefined) delete process.env.RESEARCH_CORPUS_HOME;
    else process.env.RESEARCH_CORPUS_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('sanitize keeps identifiers and hashes, replaces counts', () => {
  assert.equal(sanitize('step check_61_table: 12 rows, 3,400 wallets, 0.05 share'), 'step check_61_table: # rows, # wallets, # share');
  assert.equal(sanitize('Key (tx_out_id)=(123456) already exists'), 'Key (tx_out_id)=(#) already exists');
  assert.equal(sanitize('transaction 0183bce3b177 not found; x5_reward29'), 'transaction 0183bce3b177 not found; x5_reward29');
});

test('a stripped plan keeps its shape and drops every number derived from the data', () => {
  const plan = [{ Plan: { 'Node Type': 'Hash Join', 'Plan Rows': 1200, 'Plan Width': 8, 'Startup Cost': 1.5, 'Total Cost': 99, 'Hash Cond': '(a.id = b.id)', Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'tx_out', 'Plan Rows': 5 }] } }];
  assert.deepEqual(stripPlan(plan), [{ Plan: { 'Node Type': 'Hash Join', 'Hash Cond': '(a.id = b.id)', Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'tx_out' }] } }]);
});
