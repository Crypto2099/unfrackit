// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The live-fire command (src/study/live-fire.mjs) over stand-in commands
// (test/lib/live-fire-stubs.mjs) and a stand-in gate, with no database: the
// extraction run's pick and entries are written to a temporary
// RESEARCH_CORPUS_HOME (test/lib/live-fire.mjs). The gate's refusals, each
// leaving no start entry; the stages and their options; the start and end
// entries, their fields and the chain; the three checks; the redaction of
// error text; deletion on success and on failure; the kept run and its
// cleanup; a run killed midway. The extraction tool's own reader runs over
// these logs in live-fire-corpus.test.mjs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runLiveFire, liveFireOptions, LIVE_FIRE_STAGES, cleanupLiveFire } from '../../../src/study/live-fire.mjs';
import { chainErrors, readLog, unclosedStarts, keptRun, CODE_NAMES } from '../../../src/study/checklog.mjs';
import { Refusal } from '../../../src/history/db.mjs';
import { IntentCheck } from '../../../src/history/rebuild.mjs';
import { runDir } from '../../../src/history/paths.mjs';
import { TOOL_DIR, hashedFiles } from '../../../src/hash.mjs';
import { seedPick, logText, logEntries, TEST_H, SNAP } from '../../lib/live-fire.mjs';
import { liveFireStubs } from '../../lib/live-fire-stubs.mjs';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, '..', '..', 'lib', 'live-fire-child.mjs');
const saved = { sim: process.env.RESEARCH_SIM_HOME, corpus: process.env.RESEARCH_CORPUS_HOME };
let root;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'research-sim-live-fire-'));
  process.env.RESEARCH_SIM_HOME = join(root, 'sim');
  process.env.RESEARCH_CORPUS_HOME = join(root, 'corpus');
});
after(() => {
  for (const [k, v] of [['RESEARCH_SIM_HOME', saved.sim], ['RESEARCH_CORPUS_HOME', saved.corpus]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

const opts = (runId, extractionRun, extra = {}) => ({ _: [], runId, extractionRun, purpose: 'confirm the replays run on real data', expectNetwork: 'mainnet', treatment: join(root, 'treatment'), workers: '8', oracleWorkers: '4', ...extra });
const run = (o, stub = {}, more = {}) => runLiveFire(o, { commands: liveFireStubs(stub), gate: async () => {}, manifest: () => 'stand-in manifest\n', say: () => {}, argv: ['--run-id', o.runId], ...more });
// A run's entries: those naming its run ID, and those closing one of them.
const simEntries = (runId) => {
  const es = logEntries('mainnet');
  const own = new Set(es.filter((e) => e.run_id === runId).map((e) => e.seq));
  return es.filter((e) => own.has(e.seq) || own.has(e.start_seq));
};
// An entry's text without the fields that carry digits of their own (the
// chain, the dates, the times).
const bare = (e) => JSON.stringify(e, (k, v) => (['prev', 'date', 'seq', 'start_seq', 'gate_seq', 'run_ms', 'ms', 'wallet_level_output', 'code'].includes(k) ? undefined : v));
const startsOf = (network) => logEntries(network).filter((e) => e.type === 'sim-live-fire-start');

test('the gate refuses before anything is logged or queried: no pick, a pick of another network, no live-fire start, no kept pick, a cleaned pick, no wallets file', async () => {
  seedPick('preprod', 'pre-1');
  seedPick('mainnet', 'nostart', { start: false });
  seedPick('mainnet', 'notkept', { kept: false });
  seedPick('mainnet', 'cleaned', { cleanup: true });
  seedPick('mainnet', 'nofile', { file: false });
  seedPick('mainnet', 'otherfile', { fileNetwork: 'preprod' });
  seedPick('mainnet', 'nosnap', { snapshot: null });
  const cases = [
    ['missing', /extraction run missing holds no kept pick of the simulator's live-fire wallets on mainnet: the check log has no live-fire start entry/],
    ['pre-1', /pre-1 holds no kept pick .* on mainnet: the check log has no live-fire start entry/],
    ['nostart', /no live-fire start entry/],
    ['notkept', /no end entry of it that kept the pick/],
    ['cleaned', /a cleanup has deleted it/],
    ['nofile', /has no sim\/wallets.json/],
    ['otherfile', /sim\/wallets.json is for preprod/],
    ['nosnap', /names no snapshot block/]
  ];
  const before = logText('mainnet');
  let gateCalls = 0;
  for (const [x, re] of cases) {
    await assert.rejects(run(opts('sim-refused', x), {}, { gate: async () => gateCalls++ }), (e) => e instanceof Refusal && re.test(e.message), x);
  }
  assert.equal(gateCalls, 0);
  assert.equal(logText('mainnet'), before, 'nothing is appended');
  // The pick on its own network passes the pick check.
  await run({ ...opts('sim-pre-ok', 'pre-1'), expectNetwork: 'preprod' }, { network: 'preprod' });
  assert.equal(startsOf('preprod').length, 1);
});

test('a refused database gate is a failed query, never a live-fire run', async () => {
  seedPick('mainnet', 'gate-1');
  const n0 = logEntries('mainnet').length;
  await assert.rejects(run(opts('sim-gate', 'gate-1'), {}, { gate: async () => { throw new Refusal('refusing: the database is preprod, not mainnet'); } }), /the database is preprod, not mainnet/);
  const added = logEntries('mainnet').slice(n0);
  assert.deepEqual(added.map((e) => e.type), ['query-start', 'query']);
  assert.equal(added[0].name, 'sim live-fire gate');
  assert.equal(added[1].start_seq, added[0].seq);
  assert.equal(added[1].outcome, 'failed');
  assert.equal(added[1].error, 'refusing: the database is preprod, not mainnet');
  assert.equal(startsOf('mainnet').filter((e) => e.run_id === 'sim-gate').length, 0);
  assert.deepEqual(unclosedStarts(logEntries('mainnet')).filter((e) => e.run_id === 'sim-gate'), []);
  // Options are refused before the pick is read.
  for (const [o, re] of [
    [opts('live-x', 'gate-1'), /--run-id sim-<id>/],
    [opts('sim-x', 'sim-other'), /sim- run IDs are the simulator's/],
    [opts('sim-x', 'gate-1', { workers: '9', oracleWorkers: '4' }), /at most 12 threads/],
    [opts('sim-x', 'gate-1', { snapshot: 'tip' }), /does not take --snapshot/],
    [opts('sim-x', 'gate-1', { wallet: 'stake1x' }), /does not take --wallet/],
    [opts('sim-x', 'gate-1', { purpose: true }), /--purpose <text> is required/],
    [opts('sim-x', 'gate-1', { keepForDebug: 'yes' }), /--keep-for-debug takes no value/]
  ]) assert.throws(() => liveFireOptions(o), (e) => e instanceof Refusal && re.test(e.message));
});

test('a clean run: its stages in order on the pick, a start and an end entry in the chain, its output deleted, nothing counted', async () => {
  const { wallets } = seedPick('mainnet', 'clean-1');
  const calls = [];
  const r = await run(opts('sim-clean', 'clean-1'), { calls });
  assert.deepEqual(calls.map(([s]) => s), [...LIVE_FIRE_STAGES]);
  const by = new Map(calls);
  for (const s of ['history-recent', 'history-peak', 'history-snapshot']) {
    const o = by.get(s);
    assert.deepEqual(o.wallet, wallets.map((w) => w.stake_address), s);
    assert.equal(o.snapshot, SNAP.hash);
    assert.equal(o.expectNetwork, 'mainnet');
    assert.equal(o.window, s.slice(8));
    assert.equal(o.runId, `sim-clean/${s}`);
    assert.equal(o.extractionRun, undefined);
  }
  assert.equal(by.get('battery-pools').historyRun, 'sim-clean/history-recent');
  for (const s of ['replay-recent', 'replay-peak']) assert.deepEqual([by.get(s).repsH1, by.get(s).repsVariants, by.get(s).workers, by.get(s).validity, by.get(s).limitMs], ['1', '1', '8', true, undefined]);
  const b = by.get('battery');
  assert.deepEqual([b.reps, b.oracle, b.workers, b.oracleWorkers, b.validity, b.answerLimitMs, b.oracleLimitMs], ['1', true, '8', '4', true, undefined, undefined]);

  const es = simEntries('sim-clean');
  assert.deepEqual(es.map((e) => e.type), ['query-start', 'query', 'sim-live-fire-start', 'sim-live-fire']);
  const [gs, g, st, end] = es;
  assert.deepEqual(Object.keys(st), ['seq', 'prev', 'date', 'type', 'run_id', 'gate_seq', 'command', 'purpose', 'test_h', 'extraction_run', 'code', 'plan']);
  assert.equal(st.gate_seq, gs.seq);
  assert.equal(g.outcome, 'succeeded');
  assert.ok(g.seq < st.seq);
  assert.deepEqual([st.purpose, st.test_h, st.extraction_run, st.command], ['confirm the replays run on real data', TEST_H, 'clean-1', 'live-fire --run-id sim-clean']);
  assert.deepEqual(st.plan.repetitions, { h1: 1, variants: 1, battery: 1 });
  assert.deepEqual(st.plan.limits_ms, { replay: 300000, answer: 60000, oracle: 60000 });
  assert.deepEqual([st.plan.oracle, st.plan.validity, st.plan.workers, st.plan.oracle_workers, st.plan.stages], [true, true, 8, 4, [...LIVE_FIRE_STAGES]]);
  assert.deepEqual(Object.keys(end), ['seq', 'prev', 'date', 'type', 'run_id', 'start_seq', 'command', 'purpose', 'test_h', 'extraction_run', 'code', 'outcome', 'error', 'run_ms', 'steps', 'checks', 'wallet_level_output']);
  assert.equal(end.start_seq, st.seq);
  assert.deepEqual([end.outcome, end.error], ['succeeded', null]);
  assert.deepEqual(end.steps.map((s) => [s.name, s.ok, s.error_class, Number.isInteger(s.ms)]), LIVE_FIRE_STAGES.map((s) => [s, true, null, true]));
  assert.deepEqual(end.checks, { every_intent_parsed: true, every_built_transaction_passed_ledger_checks: true, replay_reached_limit: false });
  assert.match(end.wallet_level_output, /^deleted \d{4}-\d\d-\d\dT/);
  assert.ok(!existsSync(runDir('mainnet', 'sim-clean')), 'the run directory is gone');
  assert.deepEqual(readdirSync(join(root, 'sim', 'mainnet')).filter((d) => d.startsWith('sim-clean')), []);
  // The chain holds, nothing of the run is left open or kept.
  const log = readLog('mainnet');
  assert.deepEqual(chainErrors(log), []);
  assert.deepEqual(unclosedStarts(log.entries).filter((e) => e.run_id === 'sim-clean'), []);
  assert.equal(keptRun(log.entries, 'sim-clean'), false);
  // No stake address, and nothing the stages counted, reaches the log or the print.
  const text = logText('mainnet').split('\n').filter((l) => l.includes('"sim-clean"')).join('\n');
  for (const w of wallets) assert.ok(!text.includes(w.stake_address));
  for (const k of ['jobs', 'records', 'txs', 'wallets', 'runs', 'files']) assert.ok(!text.includes(`"${k}"`), k);
  assert.deepEqual(Object.keys(r.print), ['command', 'runId', 'network', 'outcome', 'error', 'steps', 'checks', 'walletLevelOutput', 'checkLog']);
  assert.ok(!JSON.stringify(r.print).match(/"(jobs|records|txs|wallets|runs|files)"/));
  assert.equal(r.failed, false);
});

test('the three checks: a validity failure, a replay at its limit, a history check failing, another failure', async () => {
  seedPick('mainnet', 'checks-1');
  const v = await run(opts('sim-validity', 'checks-1'), { validityFailed: { battery: 2 }, timeouts: { 'replay-peak': 1 } });
  const e1 = v.entry;
  assert.equal(e1.outcome, 'failed');
  assert.equal(e1.error, 'stage battery: a validity check failed');
  assert.deepEqual(e1.steps.find((s) => s.name === 'battery'), { name: 'battery', ok: false, ms: e1.steps.find((s) => s.name === 'battery').ms, error_class: 'check' });
  assert.deepEqual(e1.checks, { every_intent_parsed: true, every_built_transaction_passed_ledger_checks: false, replay_reached_limit: true });
  assert.ok(!JSON.stringify(e1).includes('"failed":2'));
  const h = await run(opts('sim-intent', 'checks-1'), { throws: { stage: 'history-peak', error: new IntentCheck('transaction ' + 'ab'.repeat(32) + ': an output the intent cannot place') } });
  assert.deepEqual(h.entry.steps.map((s) => [s.name, s.ok, s.error_class]), [['history-recent', true, null], ['history-peak', false, 'history-check']]);
  assert.deepEqual(h.entry.checks, { every_intent_parsed: false, every_built_transaction_passed_ledger_checks: null, replay_reached_limit: null });
  assert.equal(h.entry.error, 'stage history-peak: transaction <hex>: an output the intent cannot place');
  const db = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014', severity: 'ERROR' });
  const d = await run(opts('sim-db', 'checks-1'), { throws: { stage: 'history-recent', error: db } });
  assert.deepEqual(d.entry.steps, [{ name: 'history-recent', ok: false, ms: d.entry.steps[0].ms, error_class: 'database' }]);
  assert.deepEqual(d.entry.checks, { every_intent_parsed: null, every_built_transaction_passed_ledger_checks: null, replay_reached_limit: null });
});

test('error text is redacted: no address, hash, wallet id or count reaches the log', async () => {
  seedPick('mainnet', 'redact-1');
  const ADDR = 'addr1q' + 'x9v8w7'.repeat(9);
  const HASH = 'c0ffee'.repeat(10) + 'beef';
  const err = new Error(`wallet 4182: transaction ${HASH} pays ${ADDR}; 37 UTxOs over 1,234,567 lovelace (row37)`);
  const r = await run(opts('sim-redact', 'redact-1'), { throws: { stage: 'replay-recent', error: err } });
  assert.equal(r.entry.error, 'stage replay-recent: wallet #: transaction <hex> pays <bech32>; # UTxOs over # lovelace (#)');
  const text = simEntries('sim-redact').map(bare).join('\n');
  for (const s of [ADDR, HASH, '4182', '37', '1,234,567', 'row37']) assert.ok(!text.includes(s), s);
  // A refusal of this code's own is redacted in full too: it can name a
  // wallet by its stake-credential id.
  const own = await run(opts('sim-own', 'redact-1'), { throws: { stage: 'history-recent', error: new Refusal('refusing: wallet 77 is outside the pick') } });
  assert.equal(own.entry.error, 'stage history-recent: refusing: wallet # is outside the pick');
  assert.equal(own.entry.steps[0].error_class, 'refusal');
  // The code's names kept whole by the redaction: none in this code.
  const names = new Set();
  for (const f of hashedFiles().filter((p) => /\.(mjs|sql)$/.test(p))) {
    for (const m of readFileSync(join(TOOL_DIR, f), 'utf8').matchAll(/(?<![\w])[A-Za-z]\w*_\w*(?![\w])/g)) if (m[0].split('_').some((p) => /^\d/.test(p))) names.add(m[0]);
  }
  assert.deepEqual([...names].sort(), [...CODE_NAMES].sort());
});

test('deletion on success and on failure; --keep-for-debug keeps a failed run until --cleanup', async () => {
  seedPick('mainnet', 'keep-1');
  const failed = await run(opts('sim-fail', 'keep-1'), { fail: 'replay-peak' });
  assert.match(failed.entry.wallet_level_output, /^deleted /);
  assert.ok(!existsSync(runDir('mainnet', 'sim-fail')));
  const keptOk = await run(opts('sim-keep-ok', 'keep-1', { keepForDebug: true }));
  assert.match(keptOk.entry.wallet_level_output, /^deleted /, 'a run that succeeds keeps nothing');
  assert.ok(!existsSync(runDir('mainnet', 'sim-keep-ok')));
  const kept = await run(opts('sim-keep', 'keep-1', { keepForDebug: true }), { fail: 'replay-peak' });
  assert.equal(kept.entry.wallet_level_output, 'kept for debugging');
  assert.ok(existsSync(join(runDir('mainnet', 'sim-keep'), 'history-recent', 'history')));
  assert.equal(keptRun(logEntries('mainnet'), 'sim-keep'), true);
  // Cleanup: refused for a run the log does not hold, or one with nothing to
  // settle; then the kept run.
  assert.throws(() => cleanupLiveFire({ _: [], cleanup: true, runId: 'sim-none', network: 'mainnet' }), /holds no live-fire run sim-none/);
  assert.throws(() => cleanupLiveFire({ _: [], cleanup: true, runId: 'sim-fail', network: 'mainnet' }), /kept nothing and left nothing to clean up/);
  assert.throws(() => cleanupLiveFire({ _: [], cleanup: true, runId: 'sim-keep', network: 'mainnet', purpose: 'x' }), /does not take --purpose/);
  const c = await runLiveFire({ _: [], cleanup: true, runId: 'sim-keep', network: 'mainnet' }, { argv: ['--cleanup', '--run-id', 'sim-keep', '--network', 'mainnet'] });
  assert.deepEqual(Object.keys(c.entry), ['seq', 'prev', 'date', 'type', 'run_id', 'start_seq', 'command', 'outcome', 'error', 'wallet_level_output', 'tables_dropped']);
  assert.deepEqual([c.entry.type, c.entry.run_id, c.entry.start_seq, c.entry.outcome, c.entry.error, c.entry.tables_dropped, c.entry.command], ['cleanup', 'sim-keep', null, 'succeeded', null, 0, 'live-fire --cleanup --run-id sim-keep --network mainnet']);
  assert.match(c.entry.wallet_level_output, /^deleted /);
  assert.ok(!existsSync(runDir('mainnet', 'sim-keep')));
  assert.equal(keptRun(logEntries('mainnet'), 'sim-keep'), false);
  // A deletion that fails is logged as failed.
  const stuck = await run(opts('sim-stuck', 'keep-1'), { readOnly: 'battery' });
  assert.match(stuck.entry.wallet_level_output, /^deletion failed: /);
  chmodSync(runDir('mainnet', 'sim-stuck'), 0o700);
  const c2 = cleanupLiveFire({ _: [], cleanup: true, runId: 'sim-stuck', network: 'mainnet' });
  assert.equal(c2.entry.outcome, 'succeeded');
  assert.deepEqual(chainErrors(readLog('mainnet')), []);
});

function runChild(o, stub) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, JSON.stringify([o, stub])], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('HUNG')) child.kill('SIGKILL');
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('a run killed in a stage leaves its start unclosed and its output behind, until --cleanup', async () => {
  seedPick('mainnet', 'kill-1');
  const ended = await runChild(opts('sim-killed', 'kill-1'), { network: 'mainnet', hang: 'replay-recent' });
  assert.equal(ended.signal, 'SIGKILL');
  const es = simEntries('sim-killed');
  assert.deepEqual(es.map((e) => e.type), ['query-start', 'query', 'sim-live-fire-start']);
  const open = unclosedStarts(logEntries('mainnet')).filter((e) => e.run_id === 'sim-killed');
  assert.deepEqual(open.map((e) => [e.seq, e.type]), [[es[2].seq, 'sim-live-fire-start']]);
  assert.ok(existsSync(join(runDir('mainnet', 'sim-killed'), 'replay-recent', 'partial')));
  const c = cleanupLiveFire({ _: [], cleanup: true, runId: 'sim-killed', network: 'mainnet' });
  assert.equal(c.entry.start_seq, es[2].seq);
  assert.ok(!existsSync(runDir('mainnet', 'sim-killed')));
  assert.deepEqual(unclosedStarts(logEntries('mainnet')).filter((e) => e.run_id === 'sim-killed'), []);
});
