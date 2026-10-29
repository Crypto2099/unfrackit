// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The check log: entries appended in order with a digest chain, an edit to an
// earlier line detected, kept outputs listed until a cleanup entry closes
// them, and numbers kept out of logged error text. The simulator's live-fire
// runs are read as live-fire runs, and the two tools' run IDs are kept apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendEntry, verifyLog, sanitize, sanitizeError, refuse, checkLogPath, loggedQuery, redactCommand, closeStart, CODE_NAMES } from '../../src/checklog.mjs';
import { stripPlan } from '../../src/db.mjs';
import { runPipeline } from '../../src/pipeline.mjs';
import { sourceCheckCommand } from '../../src/cli.mjs';

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
  assert.equal(sanitize('step reconstruction_check_table: 12 rows, 3,400 wallets, 0.05 share'), 'step reconstruction_check_table: # rows, # wallets, # share');
  assert.equal(sanitize('Key (tx_out_id)=(123456) already exists'), 'Key (tx_out_id)=(#) already exists');
  // A word holding a digit is replaced whole; a snake_case name is kept.
  assert.equal(sanitize('transaction 0183bce3b177 not found; x5_reward29'), 'transaction # not found; x5_reward29');
  assert.equal(sanitize('row37, 1e5 and 12h30m at abc0x1f4 (v1.2)'), '#, # and # at # (#.#)');
  assert.equal(
    sanitize('Koios GET /account_txs?_stake_address=stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw: 500'),
    'Koios GET /account_txs?_stake_address=<bech32>: #'
  );
  assert.equal(sanitize('cardano-cli query utxo --address addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x failed'), 'cardano-cli query utxo --address <bech32> failed');
  assert.equal(sanitize(`credential ${'ab'.repeat(28)} missing`), 'credential <hex> missing');
  assert.equal(sanitizeError(refuse('refusing: a live-fire run needs --test-h <64 lowercase hex>')), 'refusing: a live-fire run needs --test-h <64 lowercase hex>');
  assert.equal(sanitizeError(new Error('needs 64 of them')), 'needs # of them');
  // Prefixed and joined hex, upper-case bech32, numbers with a unit.
  assert.equal(sanitize(`bytes \\x${'ab'.repeat(14)} and 0x${'cd'.repeat(14)} and t_${'ef'.repeat(14)}`), 'bytes <hex> and <hex> and t<hex>');
  assert.equal(sanitize('STAKE1UYEHKCK0LAJQ8GR28T9UXNUVGCQRC6070X3K9R8048Z8Y5GH6FFGW'), '<bech32>');
  assert.equal(sanitize('37k rows in 1500ms'), '# rows in #');
  assert.equal(sanitize('37rows in 1500msec, value 0x1f4'), '# in #, value <hex>');
  // Joined to an underscore: every part that begins with a digit, except in
  // the code's own names; a setting's parts begin with letters.
  assert.equal(sanitize('rows_37 left, n_12345 wallets in x_1500ms, id _37'), 'rows_# left, n_# wallets in x_#, id _#');
  assert.equal(sanitize('tx_out_id_99 and pg_temp_3 at a_1e5'), 'tx_out_id_# and pg_temp_# at a_#');
  assert.equal(sanitize('check label_309_record and n_674_json_null under x5_reward29, txo_sa_created'), 'check label_309_record and n_674_json_null under x5_reward29, txo_sa_created');
});

// CODE_NAMES holds exactly the names in sql/ and src/ that have an
// underscore-separated part beginning with a digit, so sanitize keeps every
// name the code uses and nothing else.
test("sanitize's list of the code's names is the code's", () => {
  const root = new URL('../../', import.meta.url).pathname;
  const found = new Set();
  for (const dir of ['sql', 'src']) {
    for (const f of readdirSync(join(root, dir))) {
      for (const m of readFileSync(join(root, dir, f), 'utf8').matchAll(/(?<![\w])[A-Za-z]\w*_\w*(?![\w])/g)) {
        if (m[0].split('_').some((p) => /^\d/.test(p))) found.add(m[0]);
      }
    }
  }
  assert.deepEqual([...found].sort(), [...CODE_NAMES].sort());
});

test('the logged command names no wallet', () => {
  assert.equal(redactCommand(['source-check', '--live-fire', '--stake', 'stake1abc', '--node-stake', 'stake1def', '--purpose', 'p']), 'source-check --live-fire --stake <address> --node-stake <address> --purpose p');
  assert.equal(redactCommand(['run', '--case', 'stake1abc', '--cases', '/path/cases.txt']), 'run --case <address> --cases /path/cases.txt');
});

test('a run resumed to a clean finish settles its earlier starts, kept output and failed deletions', () => {
  const home = mkdtempSync(join(tmpdir(), 'rc-log3-'));
  const prev = process.env.RESEARCH_CORPUS_HOME;
  process.env.RESEARCH_CORPUS_HOME = home;
  try {
    // A gate killed before its end entry, then the same run to a clean finish.
    appendEntry('mainnet', 'query-start', { name: 'live-fire gate', run_id: 'g' });
    const g2 = appendEntry('mainnet', 'query-start', { name: 'live-fire gate', run_id: 'g' });
    appendEntry('mainnet', 'query', { name: 'live-fire gate', start_seq: g2.seq, outcome: 'succeeded' });
    // Kept, then resumed and deleted.
    const k = appendEntry('mainnet', 'live-fire-start', { run_id: 'k' });
    appendEntry('mainnet', 'live-fire', { run_id: 'k', start_seq: k.seq, outcome: 'failed', wallet_level_output: 'kept for debugging' });
    // Interrupted (no end entry), then resumed.
    appendEntry('mainnet', 'live-fire-start', { run_id: 'i' });
    // A failed deletion, then resumed.
    const d = appendEntry('mainnet', 'live-fire-start', { run_id: 'd' });
    appendEntry('mainnet', 'live-fire', { run_id: 'd', start_seq: d.seq, outcome: 'failed', wallet_level_output: 'deletion failed: lost' });
    let v = verifyLog('mainnet');
    assert.deepEqual([v.kept_not_cleaned.map((x) => x.run_id), v.unclosed.map((x) => x.run_id), v.failed_deletions.map((x) => x.run_id)], [['k'], ['i'], ['d']], 'the killed gate is settled by the same run\'s later clean gate');
    // A killed command with no run (health, verify-freeze) is closed by its
    // start sequence; a live-fire start is not.
    const h = appendEntry('mainnet', 'query-start', { name: 'health' });
    assert.deepEqual(verifyLog('mainnet').unclosed.map((x) => x.seq).includes(h.seq), true);
    assert.throws(() => closeStart('mainnet', 1), /not an unclosed start/);
    assert.throws(() => closeStart('mainnet', verifyLog('mainnet').unclosed.find((x) => x.run_id === 'i').seq), /cleanup --run-id/);
    assert.equal(closeStart('mainnet', h.seq, 'cleanup --start-seq').start_seq, h.seq);
    for (const id of ['k', 'i', 'd']) {
      const st = appendEntry('mainnet', 'live-fire-start', { run_id: id });
      appendEntry('mainnet', 'live-fire', { run_id: id, start_seq: st.seq, outcome: 'succeeded', wallet_level_output: 'deleted 2026-10-21T00:00:00Z' });
    }
    v = verifyLog('mainnet');
    assert.deepEqual([v.kept_not_cleaned, v.unclosed, v.failed_deletions], [[], [], []]);
  } finally {
    if (prev === undefined) delete process.env.RESEARCH_CORPUS_HOME;
    else process.env.RESEARCH_CORPUS_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('cleanup --start-seq closes that start only: kept output and other starts of the run stay reported', () => {
  const home = mkdtempSync(join(tmpdir(), 'rc-log4-'));
  const prev = process.env.RESEARCH_CORPUS_HOME;
  process.env.RESEARCH_CORPUS_HOME = home;
  try {
    // A live-fire run X kept for debugging (its tables remain).
    const gx = appendEntry('mainnet', 'query-start', { name: 'live-fire gate', run_id: 'X' });
    appendEntry('mainnet', 'query', { name: 'live-fire gate', start_seq: gx.seq, outcome: 'succeeded' });
    const sx = appendEntry('mainnet', 'live-fire-start', { run_id: 'X' });
    appendEntry('mainnet', 'live-fire', { run_id: 'X', start_seq: sx.seq, outcome: 'failed', wallet_level_output: 'kept for debugging' });
    // A live-fire run Y killed after its gate (no end entry; its tables remain).
    const gy = appendEntry('mainnet', 'query-start', { name: 'live-fire gate', run_id: 'Y' });
    appendEntry('mainnet', 'query', { name: 'live-fire gate', start_seq: gy.seq, outcome: 'succeeded' });
    const sy = appendEntry('mainnet', 'live-fire-start', { run_id: 'Y' });
    // Later gate attempts of X and Y, killed during the gate, closed by hand.
    const gx2 = appendEntry('mainnet', 'query-start', { name: 'live-fire gate', run_id: 'X' });
    const gy2 = appendEntry('mainnet', 'query-start', { name: 'live-fire gate', run_id: 'Y' });
    const closed = closeStart('mainnet', gx2.seq, 'cleanup --start-seq');
    assert.equal(closed.type, 'start-closed');
    closeStart('mainnet', gy2.seq, 'cleanup --start-seq');
    const v = verifyLog('mainnet');
    assert.deepEqual(v.kept_not_cleaned.map((x) => x.run_id), ['X']);
    assert.deepEqual(v.unclosed.map((x) => x.seq), [sy.seq]);
    assert.throws(() => closeStart('mainnet', gx2.seq), /not an unclosed start/);
  } finally {
    if (prev === undefined) delete process.env.RESEARCH_CORPUS_HOME;
    else process.env.RESEARCH_CORPUS_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a clean finish settles only the same query of the same run', () => {
  const home = mkdtempSync(join(tmpdir(), 'rc-log5-'));
  const prev = process.env.RESEARCH_CORPUS_HOME;
  process.env.RESEARCH_CORPUS_HOME = home;
  try {
    const killed = appendEntry('mainnet', 'query-start', { name: 'live-fire gate', run_id: 'g' });
    const open = () => verifyLog('mainnet').unclosed.map((x) => x.seq);
    // Another run's clean gate, another query of the same run, a failed
    // gate of the same run, and another run's clean live-fire finish settle
    // nothing.
    const other = appendEntry('mainnet', 'query-start', { name: 'live-fire gate', run_id: 'h' });
    appendEntry('mainnet', 'query', { name: 'live-fire gate', start_seq: other.seq, outcome: 'succeeded' });
    const run = appendEntry('mainnet', 'query-start', { name: 'run', run_id: 'g' });
    appendEntry('mainnet', 'query', { name: 'run', start_seq: run.seq, outcome: 'succeeded' });
    const failedGate = appendEntry('mainnet', 'query-start', { name: 'live-fire gate', run_id: 'g' });
    appendEntry('mainnet', 'query', { name: 'live-fire gate', start_seq: failedGate.seq, outcome: 'failed' });
    const lf = appendEntry('mainnet', 'live-fire-start', { run_id: 'h' });
    appendEntry('mainnet', 'live-fire', { run_id: 'h', start_seq: lf.seq, outcome: 'succeeded', wallet_level_output: 'deleted 2026-10-22T00:00:00Z' });
    assert.deepEqual(open(), [killed.seq]);
    // The same query of the same run, finished cleanly, settles it.
    const again = appendEntry('mainnet', 'query-start', { name: 'live-fire gate', run_id: 'g' });
    appendEntry('mainnet', 'query', { name: 'live-fire gate', start_seq: again.seq, outcome: 'succeeded' });
    assert.deepEqual(open(), []);
  } finally {
    if (prev === undefined) delete process.env.RESEARCH_CORPUS_HOME;
    else process.env.RESEARCH_CORPUS_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
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

// Runs fn with a fresh tool home, so each test writes its own check log.
function inHome(fn) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'rc-log-sim-'));
    const prev = process.env.RESEARCH_CORPUS_HOME;
    process.env.RESEARCH_CORPUS_HOME = home;
    try {
      await fn(home);
    } finally {
      if (prev === undefined) delete process.env.RESEARCH_CORPUS_HOME;
      else process.env.RESEARCH_CORPUS_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

// The simulator's cleanup entry carries the fields this tool's cleanup
// writes.
const simCleanup = (runId, startSeq, ok) =>
  appendEntry('mainnet', 'cleanup', { run_id: runId, start_seq: startSeq, command: 'simulator cleanup', outcome: ok ? 'succeeded' : 'failed', error: ok ? null : 'disk full', wallet_level_output: ok ? 'deleted 2026-11-08T00:00:00.000Z' : 'deletion failed: disk full', tables_dropped: 0 });

test("the simulator's live-fire runs: closed by the end entry, unclosed, kept until its cleanup, failed deletions", inHome(() => {
  // A run closed by its end entry, its output deleted.
  const a = appendEntry('mainnet', 'sim-live-fire-start', { run_id: 'sim-a', purpose: 'p' });
  appendEntry('mainnet', 'sim-live-fire', { run_id: 'sim-a', start_seq: a.seq, outcome: 'succeeded', wallet_level_output: 'deleted 2026-11-07T00:00:00.000Z' });
  let v = verifyLog('mainnet');
  assert.deepEqual([v.errors, v.unclosed, v.kept_not_cleaned, v.failed_deletions], [[], [], [], []]);
  // A run killed before its end entry, one kept for debugging and one whose
  // deletion failed.
  const b = appendEntry('mainnet', 'sim-live-fire-start', { run_id: 'sim-b' });
  const k = appendEntry('mainnet', 'sim-live-fire-start', { run_id: 'sim-k' });
  const kEnd = appendEntry('mainnet', 'sim-live-fire', { run_id: 'sim-k', start_seq: k.seq, outcome: 'failed', wallet_level_output: 'kept for debugging' });
  const d = appendEntry('mainnet', 'sim-live-fire-start', { run_id: 'sim-d' });
  const dEnd = appendEntry('mainnet', 'sim-live-fire', { run_id: 'sim-d', start_seq: d.seq, outcome: 'succeeded', wallet_level_output: 'deletion failed: permission denied' });
  v = verifyLog('mainnet');
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.unclosed, [{ seq: b.seq, type: 'sim-live-fire-start', run_id: 'sim-b', date: b.date }]);
  assert.deepEqual(v.kept_not_cleaned, [{ run_id: 'sim-k', seq: kEnd.seq }]);
  assert.deepEqual(v.failed_deletions, [{ run_id: 'sim-d', seq: dEnd.seq, wallet_level_output: 'deletion failed: permission denied' }]);
  // This tool's cleanup --start-seq does not close a simulator run.
  assert.throws(() => closeStart('mainnet', b.seq), /the simulator's cleanup closes its runs/);
  // A failed cleanup is reported too, and the kept output stays listed.
  simCleanup('sim-k', null, false);
  v = verifyLog('mainnet');
  assert.deepEqual(v.kept_not_cleaned.map((x) => x.run_id), ['sim-k']);
  assert.deepEqual(v.failed_deletions.map((x) => x.run_id), ['sim-d', 'sim-k']);
  // The cleanups that succeed settle their runs; the killed run is run again
  // to a clean finish, which settles its earlier start.
  simCleanup('sim-k', null, true);
  simCleanup('sim-d', null, true);
  const b2 = appendEntry('mainnet', 'sim-live-fire-start', { run_id: 'sim-b' });
  appendEntry('mainnet', 'sim-live-fire', { run_id: 'sim-b', start_seq: b2.seq, outcome: 'succeeded', wallet_level_output: 'deleted 2026-11-08T00:00:00.000Z' });
  v = verifyLog('mainnet');
  assert.deepEqual([v.errors, v.unclosed, v.kept_not_cleaned, v.failed_deletions], [[], [], [], []]);
  // An interrupted run closed by the simulator's cleanup, which names its start.
  const c = appendEntry('mainnet', 'sim-live-fire-start', { run_id: 'sim-c' });
  assert.deepEqual(verifyLog('mainnet').unclosed.map((x) => x.seq), [c.seq]);
  simCleanup('sim-c', c.seq, true);
  assert.deepEqual(verifyLog('mainnet').unclosed, []);
}));

test("the two tools' runs are kept apart: neither settles the other's, and a run ID beginning with sim- is the simulator's only", inHome(async (home) => {
  // Each tool has a run kept for debugging, a run killed before its end
  // entry and a run whose deletion failed.
  for (const [start, end, prefix] of [['live-fire-start', 'live-fire', ''], ['sim-live-fire-start', 'sim-live-fire', 'sim-']]) {
    const k = appendEntry('mainnet', start, { run_id: `${prefix}k` });
    appendEntry('mainnet', end, { run_id: `${prefix}k`, start_seq: k.seq, outcome: 'failed', wallet_level_output: 'kept for debugging' });
    appendEntry('mainnet', start, { run_id: `${prefix}i` });
    const d = appendEntry('mainnet', start, { run_id: `${prefix}d` });
    appendEntry('mainnet', end, { run_id: `${prefix}d`, start_seq: d.seq, outcome: 'failed', wallet_level_output: 'deletion failed: lost' });
  }
  const report = () => {
    const v = verifyLog('mainnet');
    return [v.kept_not_cleaned.map((x) => x.run_id), v.unclosed.map((x) => x.run_id), v.failed_deletions.map((x) => x.run_id)];
  };
  assert.deepEqual(report(), [['k', 'sim-k'], ['i', 'sim-i'], ['d', 'sim-d']]);
  // The simulator settles its own three; this tool's stay reported.
  for (const id of ['sim-k', 'sim-d']) simCleanup(id, null, true);
  const i2 = appendEntry('mainnet', 'sim-live-fire-start', { run_id: 'sim-i' });
  appendEntry('mainnet', 'sim-live-fire', { run_id: 'sim-i', start_seq: i2.seq, outcome: 'succeeded', wallet_level_output: 'deleted 2026-11-08T00:00:00.000Z' });
  assert.deepEqual(report(), [['k'], ['i'], ['d']]);
  assert.deepEqual(verifyLog('mainnet').errors, []);
  // A simulator entry whose run ID lacks the prefix, and one of this tool's
  // live-fire entries whose run ID has it, are errors.
  const bad1 = appendEntry('mainnet', 'sim-live-fire-start', { run_id: 'k' });
  const bad2 = appendEntry('mainnet', 'sim-live-fire', { run_id: 'k', start_seq: bad1.seq, outcome: 'succeeded', wallet_level_output: 'none written' });
  const bad3 = appendEntry('mainnet', 'source-check-live-fire-start', { run_id: 'sim-s' });
  assert.deepEqual(verifyLog('mainnet').errors, [
    `line ${bad1.seq}: a sim-live-fire-start entry whose run ID does not begin with sim-`,
    `line ${bad2.seq}: a sim-live-fire entry whose run ID does not begin with sim-`,
    `line ${bad3.seq}: a source-check-live-fire-start entry with a simulator run ID`
  ]);
  // This tool refuses a simulator run ID before it writes any entry: run (any
  // mode), source-check, scam-recheck and confirm-snapshot.
  const before = readFileSync(checkLogPath('mainnet'), 'utf8');
  const simId = /run IDs beginning with sim- are the simulator's/;
  await assert.rejects(runPipeline({ runId: 'sim-r', log: () => {}, expectNetwork: 'mainnet', hypothesesTx: 'bb'.repeat(32), liveFire: { testH: 'ab'.repeat(32), purpose: 'p' } }), simId);
  await assert.rejects(runPipeline({ runId: 'sim-r', log: () => {} }), simId);
  await assert.rejects(sourceCheckCommand({ runId: 'sim-r', liveFire: true, purpose: 'p', expectNetwork: 'mainnet', hypothesesTx: 'bb'.repeat(32), stake: [], nodeStake: [] }, 'source-check'), simId);
  const cli = fileURLToPath(new URL('../../src/cli.mjs', import.meta.url));
  for (const args of [['scam-recheck', '--run', 'sim-r', '--scam-list', 'x.json', '--scam-clone', home], ['confirm-snapshot', '--run-id', 'sim-r']]) {
    const r = spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, RESEARCH_CORPUS_HOME: home, PGHOST: '127.0.0.1', PGPORT: '1' }, encoding: 'utf8' });
    assert.equal(r.status, 1, args[0]);
    assert.match(r.stderr, simId, args[0]);
  }
  assert.equal(readFileSync(checkLogPath('mainnet'), 'utf8'), before, 'nothing logged');
}));

test('a stripped plan keeps its shape and drops every number derived from the data', () => {
  const plan = [{ Plan: { 'Node Type': 'Hash Join', 'Plan Rows': 1200, 'Plan Width': 8, 'Startup Cost': 1.5, 'Total Cost': 99, 'Hash Cond': '(a.id = b.id)', 'Workers Planned': 4, Plans: [{ 'Node Type': 'Aggregate', Strategy: 'Hashed', 'Planned Partitions': 32, 'Group Key': ['sa_id'], Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'tx_out', 'Plan Rows': 5 }] }] }, JIT: { Functions: 12 }, Planning: { 'Shared Hit Blocks': 3 } }];
  assert.deepEqual(stripPlan(plan), [{ Plan: { 'Node Type': 'Hash Join', 'Hash Cond': '(a.id = b.id)', Plans: [{ 'Node Type': 'Aggregate', Strategy: 'Hashed', 'Group Key': ['sa_id'], Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'tx_out' }] }] } }]);
});
