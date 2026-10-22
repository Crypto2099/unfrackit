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
import { appendEntry, verifyLog, sanitize, sanitizeError, refuse, checkLogPath, loggedQuery } from '../../src/checklog.mjs';
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

test('sanitize replaces counts, addresses and hashes; a refusal keeps its own numbers', () => {
  assert.equal(sanitize('step check_61_table: 12 rows, 3,400 wallets, 0.05 share'), 'step check_61_table: # rows, # wallets, # share');
  assert.equal(sanitize('Key (tx_out_id)=(123456) already exists'), 'Key (tx_out_id)=(#) already exists');
  assert.equal(sanitize('transaction 0183bce3b177 not found; x5_reward29'), 'transaction 0183bce3b177 not found; x5_reward29');
  assert.equal(
    sanitize('Koios GET /account_txs?_stake_address=stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw: 500'),
    'Koios GET /account_txs?_stake_address=<bech32>: #'
  );
  assert.equal(sanitize('cardano-cli query utxo --address addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x failed'), 'cardano-cli query utxo --address <bech32> failed');
  assert.equal(sanitize(`credential ${'ab'.repeat(28)} missing`), 'credential <hex> missing');
  assert.equal(sanitizeError(refuse('refusing: a live-fire run needs --test-h <64 lowercase hex>')), 'refusing: a live-fire run needs --test-h <64 lowercase hex>');
  assert.equal(sanitizeError(new Error('needs 64 of them')), 'needs # of them');
});

test('unclosed starts and failed deletions are reported; loggedQuery logs mainnet only', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rc-log2-'));
  const prev = process.env.RESEARCH_CORPUS_HOME;
  process.env.RESEARCH_CORPUS_HOME = home;
  try {
    const s1 = appendEntry('mainnet', 'live-fire-start', { run_id: 'a' });
    appendEntry('mainnet', 'live-fire-start', { run_id: 'b' });
    appendEntry('mainnet', 'live-fire', { run_id: 'a', start_seq: s1.seq, outcome: 'failed', wallet_level_output: 'deletion failed: connection lost' });
    let v = verifyLog('mainnet');
    assert.deepEqual(v.unclosed.map((x) => x.run_id), ['b']);
    assert.deepEqual(v.failed_deletions.map((x) => x.run_id), ['a']);
    appendEntry('mainnet', 'cleanup', { run_id: 'a', outcome: 'succeeded', wallet_level_output: 'deleted now' });
    v = verifyLog('mainnet');
    assert.deepEqual(v.failed_deletions, []);
    assert.equal(await loggedQuery('mainnet', 'health', { command: 'health' }, async () => 7), 7);
    await assert.rejects(loggedQuery('mainnet', 'verify-freeze', {}, async () => {
      throw new Error('boom 12');
    }), /boom 12/);
    assert.equal(await loggedQuery('preprod', 'health', {}, async () => 8), 8);
    const lines = readFileSync(checkLogPath('mainnet'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const q = lines.filter((e) => e.type === 'query');
    assert.deepEqual(q.map((e) => [e.name, e.outcome, e.error]), [['health', 'succeeded', null], ['verify-freeze', 'failed', 'boom #']]);
    assert.deepEqual(verifyLog('mainnet').unclosed.map((x) => x.run_id), ['b']);
  } finally {
    if (prev === undefined) delete process.env.RESEARCH_CORPUS_HOME;
    else process.env.RESEARCH_CORPUS_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a stripped plan keeps its shape and drops every number derived from the data', () => {
  const plan = [{ Plan: { 'Node Type': 'Hash Join', 'Plan Rows': 1200, 'Plan Width': 8, 'Startup Cost': 1.5, 'Total Cost': 99, 'Hash Cond': '(a.id = b.id)', 'Workers Planned': 4, Plans: [{ 'Node Type': 'Aggregate', Strategy: 'Hashed', 'Planned Partitions': 32, 'Group Key': ['sa_id'], Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'tx_out', 'Plan Rows': 5 }] }] }, JIT: { Functions: 12 }, Planning: { 'Shared Hit Blocks': 3 } }];
  assert.deepEqual(stripPlan(plan), [{ Plan: { 'Node Type': 'Hash Join', 'Hash Cond': '(a.id = b.id)', Plans: [{ 'Node Type': 'Aggregate', Strategy: 'Hashed', 'Group Key': ['sa_id'], Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'tx_out' }] }] } }]);
});
