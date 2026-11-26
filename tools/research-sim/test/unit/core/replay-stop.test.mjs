// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A replay job that reaches the time limit is stopped, not run again, and
// keeps the spends it completed (pre-registration, "Run logistics after the
// cost probes"). Without the treatment: the spool a worker writes as the job
// goes (SpoolStream) holds the same bytes as the spool written at its end; a
// killed job's spool is made whole (repairSpool); a stage over a stand-in pool
// that answers one job as killed writes its spends, the wallet-arm record of
// `stopped` (named fields, the stage's machine label), counts the job stopped,
// is done for that wallet on resume, and merges with another shard's stage
// into the stage of one run. With the treatment: a job stopped at a spend
// boundary by the engine keeps the records a finished job writes for the same
// spends, a job whose build outlasts the limit is killed in a real worker and
// keeps the spends before it, and a job under the limit writes the records it
// wrote before the limit existed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, readFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStage, walletList } from '../../../src/out/stage.mjs';
import { mergeStage } from '../../../src/out/merge.mjs';
import { selectionOf } from '../../../src/replay/shards.mjs';
import { spoolJob, spoolKilled, keptValidity, runJob, runReplays, STOPPED_AT } from '../../../src/replay/run.mjs';
import { record } from '../../../src/out/records.mjs';
import { SpoolStream, spoolRecords, spoolPaths, repairSpool } from '../../../src/out/spool.mjs';
import { windowPlan, expandJobs, TEST_ROLES } from '../../../src/arms/plan.mjs';
import { HISTORY_FORMAT } from '../../../src/state/history.mjs';
import { paramsFromRow } from '../../../src/history/params.mjs';
import { runDir } from '../../../src/history/paths.mjs';
import { STAGE_LAYOUT } from '../../../src/out/stage.mjs';
import { stageText, stageLog, testStage } from '../../lib/stage.mjs';
import { Pool } from '../../../src/replay/pool.mjs';
import { treatment, skip, TREATMENT_DIR } from '../../lib/treatment.mjs';

function withHome(fn) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'research-sim-stop-'));
    const prev = process.env.RESEARCH_SIM_HOME;
    process.env.RESEARCH_SIM_HOME = home;
    try {
      await fn(home);
    } finally {
      if (prev === undefined) delete process.env.RESEARCH_SIM_HOME;
      else process.env.RESEARCH_SIM_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

const KEY = { wallet: 7, window: 'recent', arm: 'observed', variant: 'default', method: 'test-largest-first', change: 'default', collateral: 'ledger', repetition: 1 };
const spend = (intent, over = {}) => record('spend', KEY, { intent, type: 'T1', t: 10 * (intent + 1), outcome: 'built', fee: 170000n, ms: 2.5 + intent, ...over });
const lines = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean);
const plain = (t) => t.replace(/"ms":\d+(\.\d+)?/g, '"ms":0');
// Timing rows with every time set to 0.
const timeless = (text) => text.split('\n').filter(Boolean).map((l) => {
  const r = JSON.parse(l);
  return JSON.stringify({ ...r, times: Object.fromEntries(Object.keys(r.times).map((q) => [q, 0])) });
});

test('a spool written as the job goes holds the bytes of one written at its end, and a kill leaves whole record lines', withHome(async (home) => {
  const recs = [spend(0), spend(1), record('burst', KEY, { id: 'b', t: 5, feasible: true, txs: 1 }), record('wallet-arm', KEY, { counts: { built: 2 }, ms: 7 })];
  const hold = (r) => r.kind === 'wallet-arm';
  mkdirSync(join(home, 'a'));
  mkdirSync(join(home, 'b'));
  const whole = spoolRecords(spoolPaths(join(home, 'a'), 0), recs, { hold });
  const s = new SpoolStream(spoolPaths(join(home, 'b'), 0), { hold, eager: true });
  s.add(recs[0]);
  // Eager: the first record is in the file before the stream is closed.
  assert.equal(lines(spoolPaths(join(home, 'b'), 0).records).length, 1);
  for (const r of recs.slice(1)) s.add(r);
  const streamed = s.close();
  assert.deepEqual({ ...streamed, records: null, timings: null }, { ...whole, records: null, timings: null });
  for (const f of ['records', 'timings']) assert.equal(readFileSync(streamed[f], 'utf8'), readFileSync(whole[f], 'utf8'), f);
}));

test('repairSpool keeps the whole record lines and the timing rows of those records, and an absent spool is empty', withHome(async (home) => {
  const paths = spoolPaths(home, 4);
  assert.deepEqual(repairSpool(paths), { count: 0, counts: {}, spends: 0, last: null, lastKind: null, lastRecord: null });
  const s = new SpoolStream(paths, { eager: true });
  s.add(spend(0));
  s.add(spend(1));
  s.close();
  // A kill after the third timing row and during the third record's line.
  appendFileSync(paths.timings, '{"n":3,"kind":"spend","times":{"ms":4}}\n{"n":4,"ki');
  appendFileSync(paths.records, '{"kind":"spend","intent":2,"t"');
  const r = repairSpool(paths);
  assert.deepEqual({ ...r, lastRecord: null }, { count: 2, counts: { spend: 2 }, spends: 2, last: { intent: 1, t: 20 }, lastKind: 'spend', lastRecord: null });
  assert.equal(r.lastRecord.intent, 1);
  assert.equal(lines(paths.records).length, 2);
  assert.deepEqual(lines(paths.timings).map((l) => JSON.parse(l).n), [1, 2]);
  // Reopened, the stream goes on from the records kept.
  const again = new SpoolStream(paths, { resume: r });
  again.add(record('wallet-arm', KEY, { ms: 9 }));
  const closed = again.close();
  assert.deepEqual([closed.count, closed.counts], [3, { spend: 2, 'wallet-arm': 1 }]);
  assert.deepEqual(lines(paths.records).map((l) => JSON.parse(l).kind), ['spend', 'spend', 'wallet-arm']);
}));

// ---- a stage over a stand-in pool

const HEADER = Object.freeze({ layout: STAGE_LAYOUT, command: 'replay', plan: 'recent', options: { plan: 'recent', reps: '1', validity: true }, node: process.version, csl: { package: 'csl', version: '17.0.0', wasm: { 'a.wasm': 'ab'.repeat(32) } }, manifest: 'stand-in manifest\n' });
const PLAN = windowPlan('recent', { reps: 1 });
const PARAMS = paramsFromRow('preprod', { epoch_no: 300, protocol_major: 10, min_fee_a: 44, min_fee_b: 155381, coins_per_utxo_size: 4310, max_val_size: 5000, max_tx_size: 16384, max_collateral_inputs: 3, collateral_percent: 150, price_mem: 0.0577, price_step: 0.0000721, min_fee_ref_script_cost_per_byte: 15, key_deposit: 2000000, pool_deposit: 500000000, drep_deposit: 500000000, gov_action_deposit: 100000000000 });

function walletsIn(home, ids) {
  const files = join(home, 'histories');
  mkdirSync(files, { recursive: true });
  return ids.map((wallet) => {
    const ls = [
      { kind: 'header', format: HISTORY_FORMAT, network: 'preprod', wallet, frame: 'recent', split: null, window: { first: { time: 0 }, last: { time: 1000 } }, snapshot: { block: 1, tx: 1 }, params: PARAMS, franken: [], arrival: [], latestKeyBase: null, settings: {}, source: { bytes: 'tx_cbor' } },
      { kind: 'state', at: { tx: 1 }, utxos: [] },
      { kind: 'end', at: { tx: 2 }, utxos: 0, digest: '00', counts: { deposit: 0, 'held-consumed': 0, intent: 0, 'self-reorganization': 0, mark: 0 } }
    ];
    const path = join(files, `${wallet}.recent.jsonl`);
    writeFileSync(path, ls.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return { spec: { kind: 'history', path, analysisFreezeTx: null } };
  });
}

// An engine result as a worker has it.
const engineResult = () => ({
  spends: [{ intent: 0, type: 'T1', t: 10, burst: null, outcome: 'built', fee: 170000n, ms: 2.5 }, { intent: 1, type: 'T4', t: 40, burst: null, outcome: 'built', fee: 400000n, ms: 9 }],
  bursts: [{ id: 'b1', t: 50, feasible: true, txs: 2 }],
  summary: { counts: { intents: 2 }, fees: { spends: 570000n }, ms: 12.5 },
  method: { name: 'test-largest-first', version: 'test-1', deterministic: true }
});

const placeOf = (job) => {
  const m = /[/\\]spool[/\\](\d+)[/\\](\d+)\.records\.jsonl$/.exec(job.spool.records);
  return [Number(m[1]), Number(m[2])];
};

// The validity summary of n checked transactions, `failed` of them failing.
const V = (txs, failed = 0) => ({ txs, cslRead: txs, cslOutputBytes: 0, cslReencoded: 0, controls: { fee: txs, size: txs, value: txs, witnesses: txs }, notApplicable: { fee: 0, value: 0 }, failed, ...(failed ? { failures: [{ at: 'spend 1', tx: 0, check: 'fee', detail: 'x' }] } : {}) });
// The checks of the stand-in's two spends, and of a third it never keeps.
const CHECKS = [V(2), V(1, 1), V(5)];

// A stand-in pool whose replay of `killAt` (a wallet/job place) is killed at
// the limit: the worker's spool holds two spends and the start of a third
// record, as a kill in the middle of a write leaves it, and with validity on,
// the checks of the spends (and a line beyond them). killAs: the pool's `at`
// for it. `stopAt`: a place whose job stops by itself at a spend boundary,
// with the same two spends. `fail`: a place whose job fails after failAfter
// ms (it stops the run).
function standInPool({ killAt = null, killAs = 'build', stopAt = null, fail = null, failAfter = 0 } = {}) {
  const pool = {
    size: 2,
    stats: { started: 0, recycled: 0, watchdogStops: 0, machineReruns: 0 },
    order: [],
    limits: [],
    async replay(job, { watchdogMs } = {}) {
      const [wi, i] = placeOf(job);
      pool.order.push(`${wi}/${i}`);
      pool.limits.push(watchdogMs);
      await new Promise((r) => setTimeout(r, (wi * 3 + i) % 3 + (`${wi}/${i}` === fail ? failAfter : 0)));
      const here = `${wi}/${i}`;
      if (here === fail) return { ok: false, error: 'stand-in failure', stop: false, ms: 1 };
      if (here === killAt) {
        const s = new SpoolStream(job.spool, { hold: (r) => r.kind === 'wallet-arm', eager: true });
        for (const x of engineResult().spends) s.add(record('spend', job.key, x));
        s.close();
        appendFileSync(job.spool.records, '{"kind":"spend","wallet":');
        if (job.validity) writeFileSync(job.spool.validity, CHECKS.map((c) => `${JSON.stringify(c)}\n`).join(''));
        pool.stats.watchdogStops++;
        return { ok: true, killed: { at: killAs, attempt: 2, limitMs: watchdogMs, info: { methodVersion: 'test-1' } }, ms: 1234.4 };
      }
      if (here === stopAt) {
        const x = { ...engineResult(), stopped: { spends: 2, last: { intent: 1, t: 40 } }, validity: job.validity ? { ...V(3, 1) } : null };
        pool.stats.watchdogStops++;
        return { ok: true, result: spoolJob(x, job, { stop: { at: STOPPED_AT.boundary, elapsedMs: 1234.4, attempt: 2, limitMs: watchdogMs } }), ms: 1234.4 };
      }
      return { ok: true, result: spoolJob(engineResult(), job), ms: 5 };
    }
  };
  return pool;
}

async function run(runId, wallets, pool, { machine, shard, watchdogMs, plan = PLAN, validity = false, maxOpen = 1 } = {}) {
  const list = walletList(wallets);
  const out = await openStage(runDir('preprod', runId), { header: HEADER, wallets: list, workers: pool.size, machine, selection: selectionOf(shard ? { shard } : {}, { plan: 'recent', wallets: list }) });
  try {
    const totals = await runReplays(null, pool, { wallets, plan, roles: TEST_ROLES, out, validity, ...(watchdogMs ? { watchdogMs } : {}), maxOpen });
    return { totals, dir: out.dir };
  } finally {
    out.close();
  }
}

const recordsOf = (dir) => stageText(dir).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const armOf = (dir, i) => recordsOf(dir).filter((r) => r.kind === 'wallet-arm')[i];

test('a job the pool killed at the limit keeps its spends, ends with a wallet-arm record that says it was stopped, and the stage counts it done', withHome(async (home) => {
  const wallets = walletsIn(home, [201, 202, 203]);
  const ref = await run('ref', wallets, standInPool());
  const pool = standInPool({ killAt: '1/3' });
  const r = await run('killed', wallets, pool, { machine: 'rig-b', watchdogMs: 5000 });
  assert.ok(pool.limits.every((l) => l === 5000), 'the limit reaches the pool as it was given');
  const now = recordsOf(r.dir);
  const was = recordsOf(ref.dir);
  const mine = (rs) => rs.filter((x) => x.wallet === 202);
  // Each job of the stand-in writes two spends, a burst and a wallet-arm record; the fourth job of wallet 202 was killed.
  assert.equal(mine(was).length, 4 * expandJobs(PLAN, { roles: TEST_ROLES, needsCollateral: false }).length);
  const block = (rs) => mine(rs).slice(12, 16);
  assert.deepEqual(mine(now).slice(0, 12), mine(was).slice(0, 12));
  assert.deepEqual(mine(now).slice(15), mine(was).slice(16));
  const [s0, s1, arm, ...more] = mine(now).slice(12, 15);
  assert.deepEqual([s0, s1], block(was).slice(0, 2), 'the spends it completed, as a finished job writes them');
  assert.deepEqual(arm, { kind: 'wallet-arm', wallet: 202, window: 'recent', arm: block(was)[3].arm, variant: block(was)[3].variant, method: block(was)[3].method, change: block(was)[3].change, collateral: block(was)[3].collateral, repetition: block(was)[3].repetition, hypotheses: block(was)[3].hypotheses, methodVersion: 'test-1', capped: false, stopped: { reason: 'excessive time', attempt: 2, limitMs: 5000, elapsedMs: 1234, at: STOPPED_AT.build, spends: 2, planned: 0, last: { intent: 1, t: 40 }, machine: 'rig-b' } });
  assert.equal(more.length, 0, 'the stopped job writes no burst record, and the next job follows it');
  // Every other wallet is as the run that stopped no job wrote it.
  for (const w of [201, 203]) assert.deepEqual(now.filter((x) => x.wallet === w), was.filter((x) => x.wallet === w));
  // The wallet-arm's time row is the attempt's, as for any job.
  const rows = stageText(r.dir, 'timings').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(rows.some((x) => x.kind === 'wallet-arm' && x.walletIndex === 1 && x.times.ms === 1234.4), 'the attempt\'s time in the timing row');
  // The totals count the job, and only a stopped job adds the field.
  assert.deepEqual(r.totals, { ...ref.totals, stopped: 1 });
  assert.equal('stopped' in ref.totals, false);
  assert.equal(existsSync(join(r.dir, 'spool')), false);
}));

test('a stopped job is done: a resume does not run its wallet again, and its records stay as they were', withHome(async (home) => {
  const wallets = walletsIn(home, [211, 212, 213]);
  // Wallet 0's job 2 is killed at the limit; wallet 1's job 1 fails and stops the run.
  const pool = standInPool({ killAt: '0/2', fail: '1/1' });
  await assert.rejects(run('resume', wallets, pool, { machine: 'rig-c' }), /replay failed: stand-in failure/);
  const dir = runDir('preprod', 'resume');
  const done0 = readFileSync(join(dir, 'segments', '0.done.json'), 'utf8');
  assert.equal(JSON.parse(done0).totals.stopped, 1);
  const pool2 = standInPool();
  const r = await run('resume', wallets, pool2, { machine: 'rig-d' });
  assert.equal(readFileSync(join(dir, 'segments', '0.done.json'), 'utf8'), done0);
  assert.deepEqual([...new Set(pool2.order.map((p) => p.split('/')[0]))].sort(), ['1', '2'], 'wallet 0 was not run again');
  const stopped = recordsOf(r.dir).filter((x) => x.kind === 'wallet-arm' && x.stopped);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].stopped.machine, 'rig-c', 'the record names the machine that stopped the job, not the one that resumed');
  assert.equal(r.totals.stopped, 1);
}));

test('merge-stage carries a stopped pair through: two shards merged are the stage of one run', withHome(async (home) => {
  const wallets = walletsIn(home, [221, 222, 223, 224, 225]);
  // Wallet index 3 belongs to the second shard, whose machine stopped the job.
  const ref = await run('m-ref', wallets, standInPool({ killAt: '3/5' }), { machine: 'rig-f' });
  const a = await run('m-a', wallets, standInPool({ killAt: '3/5' }), { shard: '0/2', machine: 'rig-e' });
  const b = await run('m-b', wallets, standInPool({ killAt: '3/5' }), { shard: '1/2', machine: 'rig-f' });
  const m = await mergeStage({ into: a.dir, sources: [b.dir], machine: 'rig-e' });
  assert.deepEqual(m.totals, ref.totals);
  assert.equal(m.totals.stopped, 1);
  assert.equal(stageText(a.dir), stageText(ref.dir));
  assert.deepEqual(timeless(stageText(a.dir, 'timings')), timeless(stageText(ref.dir, 'timings')));
  const s = recordsOf(a.dir).filter((x) => x.kind === 'wallet-arm' && x.stopped);
  assert.deepEqual(s.map((x) => [x.wallet, x.stopped.machine]), [[224, 'rig-f']]);
}));

test('a stop inside a wallet that is still open survives the run ending: the resume reuses the stopped job\'s records and does not run it again', withHome(async (home) => {
  const wallets = walletsIn(home, [231, 232]);
  // Wallet 0's job 2 is killed at the limit while jobs of its wallet go on; its job 6 then fails, dropping the wallet before it is done.
  const pool = standInPool({ killAt: '0/2', fail: '0/6', failAfter: 80 });
  await assert.rejects(run('open-resume', wallets, pool, { machine: 'rig-c', maxOpen: 4, validity: true }), /replay failed: stand-in failure/);
  const dir = runDir('preprod', 'open-resume');
  assert.equal(existsSync(join(dir, 'segments', '0.done.json')), false, 'the wallet was not done');
  assert.deepEqual(readdirSync(join(dir, 'stopped')), ['0.2.json']);
  const pool2 = standInPool();
  const r = await run('open-resume', wallets, pool2, { machine: 'rig-d', validity: true });
  assert.equal(pool2.order.includes('0/2'), false, 'the stopped job was not run again');
  assert.equal(pool2.order.includes('0/1') && pool2.order.includes('0/3'), true, 'its wallet\'s other jobs were');
  const ref = await run('open-ref', wallets, standInPool({ killAt: '0/2' }), { machine: 'rig-c', validity: true });
  assert.equal(stageText(r.dir), stageText(ref.dir), 'the stage is the one an uninterrupted run writes');
  assert.deepEqual(r.totals, ref.totals);
  assert.equal(r.totals.stopped, 1);
  const stopped = recordsOf(r.dir).filter((x) => x.kind === 'wallet-arm' && x.stopped);
  assert.equal(stopped[0].stopped.machine, 'rig-c');
  assert.equal(existsSync(join(dir, 'stopped', '0.2.json')), false, 'removed once its wallet is done');
  assert.ok(stageLog(r.dir, 'rig-d').some((e) => e.event === 'stopped job kept'));
}));

test('a stopped pair\'s validity counts are those of the spends it kept, the same on both paths, with a kept spend\'s failure counted and logged', withHome(async (home) => {
  const wallets = walletsIn(home, [241, 242]);
  const killed = await run('v-kill', wallets, standInPool({ killAt: '0/2' }), { machine: 'rig-v', validity: true });
  const stopped = await run('v-stop', wallets, standInPool({ stopAt: '0/2' }), { machine: 'rig-v', validity: true });
  const plain = await run('v-plain', wallets, standInPool(), { machine: 'rig-v', validity: true });
  // The kept spends' checks: 2 and 1 transactions, one failure; the line beyond them (5) is not counted.
  for (const r of [killed, stopped]) {
    assert.deepEqual([r.totals.validity.txs, r.totals.validity.failed, r.totals.validity.controls.fee], [3, 1, 3]);
    const fails = stageLog(r.dir, 'rig-v').filter((e) => e.event === 'validity failure');
    assert.deepEqual(fails.map((e) => [e.wallet, e.check]), [[241, 'fee']]);
  }
  assert.deepEqual(killed.totals.validity, stopped.totals.validity);
  assert.equal(plain.totals.validity.txs, 0);
  // Without validity checks nothing is read or counted.
  const off = await run('v-off', wallets, standInPool({ killAt: '0/2' }), { machine: 'rig-v' });
  assert.equal(off.totals.validity, undefined);
}));

test('a kill after the grace is recorded as killed between spends', withHome(async (home) => {
  const wallets = walletsIn(home, [251]);
  const r = await run('grace', wallets, standInPool({ killAt: '0/1', killAs: 'grace' }), { machine: 'rig-g' });
  const s = recordsOf(r.dir).filter((x) => x.kind === 'wallet-arm' && x.stopped);
  assert.deepEqual(s.map((x) => x.stopped.at), [STOPPED_AT.unresponsive]);
  assert.equal(STOPPED_AT.unresponsive, 'killed between spends');
}));

test('a spool the worker had already ended is its result as written: a kill after it adds no second wallet-arm record', withHome(async (home) => {
  mkdirSync(join(home, 'k'));
  const job = (n, over = {}) => ({ key: KEY, hypotheses: ['t'], opts: {}, spool: spoolPaths(join(home, 'k'), n), planned: 3, capped: false, machine: 'rig-k', validity: true, ...over });
  const killed = { at: 'build', attempt: 1, limitMs: 100, info: { methodVersion: 'v1' } };
  // A finished job.
  const a = job(0);
  const done = spoolJob(engineResult(), a);
  const k = spoolKilled(a, killed, 321.5);
  assert.deepEqual(k.spooled.counts, { spend: 2, burst: 1, 'wallet-arm': 1 });
  assert.equal(k.stopped, undefined);
  assert.deepEqual([k.spooled.count, k.spooled.held.n, k.spooled.held.times.ms], [4, 4, 321.5]);
  assert.deepEqual(k.spooled.counts, done.spooled.counts);
  assert.equal(lines(a.spool.records).filter((l) => JSON.parse(l).kind === 'wallet-arm').length, 1);
  // A job that had stopped at its boundary: its own record stands, with its attempt and its kept spends' checks.
  const b = job(1);
  writeFileSync(b.spool.validity, CHECKS.map((c) => `${JSON.stringify(c)}\n`).join(''));
  spoolJob({ ...engineResult(), stopped: { spends: 2, last: { intent: 1, t: 40 } }, validity: null }, b, { stop: { at: STOPPED_AT.boundary, elapsedMs: 50, attempt: 7, limitMs: 100 } });
  const kb = spoolKilled(b, killed, 400);
  assert.equal(kb.stopped.attempt, 7);
  assert.equal(kb.stopped.at, STOPPED_AT.boundary);
  assert.deepEqual([kb.validity.txs, kb.validity.failed], [3, 1]);
  assert.equal(lines(b.spool.records).filter((l) => JSON.parse(l).kind === 'wallet-arm').length, 1);
  assert.deepEqual(keptValidity(join(home, 'absent'), 2), null);
}));

// A parent whose thread is busy past the limit, while the worker ends its
// build and writes its own ending, may decide on a stale view of the worker
// (the deferral narrows that, and cannot remove it under load). Whatever it
// decides, the outcome is the worker's: one wallet-arm record, the worker's own
// ending kept, its validity counted, the stop counted only when the records
// show one.
const finishing = (job) => (killed, ms) => spoolKilled(job, killed, ms);
const arms = (job) => lines(job.spool.records).map((l) => JSON.parse(l)).filter((x) => x.kind === 'wallet-arm');

test('a parent busy across the limit leaves the worker\'s own ending: one wallet-arm record, its validity counted, the stop counted only if recorded', withHome(async (home) => {
  const cases = [['boundary', 'io'], ['boundary', 'check'], ['finish', 'io'], ['finish', 'check'], ['early', 'io']];
  for (const [mode, where] of cases) {
    const dir = join(home, `race-${mode}-${where}`);
    mkdirSync(dir);
    const pool = new Pool({ treatmentDir: 'unused', size: 1, memoryBudget: 64 * 1024 ** 3, workerUrl: new URL('../../lib/race-stop-worker.mjs', import.meta.url) });
    try {
      const job = { key: KEY, hypotheses: ['t'], opts: {}, spool: spoolPaths(dir, 0), planned: 5, capped: false, machine: 'rig', mode, memory: null, validity: true };
      const notes = [];
      const p = pool.replay(job, { watchdogMs: mode === 'early' ? 600 : 300, stopGraceMs: 60000, finishKilled: finishing(job), note: (e) => notes.push(e) });
      // The attempt has begun once the worker has opened its spool.
      for (const t0 = Date.now(); !existsSync(job.spool.records); await new Promise((r) => setTimeout(r, 5))) if (Date.now() - t0 > 20000) throw new Error('the worker did not start');
      await new Promise((r) => setTimeout(r, 50));
      const busy = () => {
        for (const end = Date.now() + 600; Date.now() < end;) {
          // the parent's thread busy
        }
      };
      if (where === 'check') setImmediate(busy);
      else readFile(new URL(import.meta.url), busy);
      const r = await p;
      const at = `${mode}/${where}`;
      // On a starved machine the limit may also fall with the worker's build still running, and the kill is then right. Whatever the pool decided, the record, the checks and the count agree.
      assert.equal(r.killed, undefined, at);
      assert.equal(arms(job).length, 1, `${at}: one wallet-arm record`);
      const st = r.result.stopped;
      assert.equal(arms(job)[0].stopped === undefined, !st, `${at}: the record is the result`);
      assert.equal(r.result.spooled.counts['wallet-arm'], 1, at);
      assert.equal(pool.stats.watchdogStops, st ? 1 : 0, `${at}: the count follows the record`);
      assert.deepEqual(notes.filter((e) => e.event === 'watchdog stop').map((e) => e.at), st ? [st.at] : [], at);
      if (st) {
        assert.equal(st.at === STOPPED_AT.boundary, st.spends === 2, `${at}: ${st.at} with ${st.spends} spends`);
        assert.deepEqual([r.result.validity.txs, r.result.validity.failed], [st.spends, st.spends - 1], `${at}: the kept spends' checks`);
      }
    } finally {
      await pool.close();
    }
  }
}));

// The two sequences that kill a worker that has stopped itself (the review's
// S1 and S3), with a worker that runs the real runJob and removes nothing: S1,
// the thread busy in the poll phase right after the limit's timer, with the
// worker's answer queued, and the worker in a build as far as the parent last
// read; S3, the thread busy across the grace's end with the answer queued.
// Whichever way the pool decides, the record, the validity and the counts are
// the worker's.
test('a worker that stopped itself and answered while the parent was busy keeps its record, its kept spends\' validity and one counted stop (the same worker as runJob leaves it)', withHome(async (home) => {
  const net = await import('node:net');
  const busy = (ms) => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      // the parent's thread busy
    }
  };
  const V1 = V(1);
  const V2 = V(1, 1);
  for (const mode of ['S1', 'S3']) {
    const dir = join(home, mode);
    mkdirSync(dir);
    const sock = join(dir, 's');
    const server = net.createServer((c) => c.on('data', () => busy(400)));
    await new Promise((r) => server.listen(sock, r));
    const client = net.connect(sock);
    await new Promise((r) => client.on('connect', r));
    const orig = Pool.prototype.attempt;
    if (mode === 'S1') {
      // Right after the attempt arms its timer, a timer of the same delay makes the socket readable in the same pass.
      Pool.prototype.attempt = function (...a) {
        const p = orig.apply(this, a);
        setTimeout(() => client.write('x'), a[4].arm);
        return p;
      };
    }
    const pool = new Pool({ treatmentDir: 'unused', size: 1, memoryBudget: 64 * 1024 ** 3, workerUrl: new URL('../../lib/runjob-stop-worker.mjs', import.meta.url) });
    try {
      const script = mode === 'S1' ? [{ build: 20, checks: V1 }, { buildUntilDeadline: 100, checks: V2 }, { build: 20 }] : [{ build: 50, checks: V1 }, { idleUntilDeadline: 400, checks: V2 }, { build: 20 }];
      const job = { key: KEY, hypotheses: ['t'], opts: {}, spool: spoolPaths(dir, 0), planned: 3, capped: false, machine: 'rig', validity: true, memory: null, script };
      const notes = [];
      const t0 = Date.now();
      const p = pool.replay(job, { watchdogMs: 300, stopGraceMs: mode === 'S3' ? 500 : 60000, finishKilled: finishing(job), note: (e) => notes.push(e) });
      if (mode === 'S3') {
        // Busy in an I/O callback across the grace's end (about 800 ms), with the worker's answer (about 700 ms) queued.
        for (; !existsSync(job.spool.records); await new Promise((r) => setTimeout(r, 2)));
        await new Promise((r) => setTimeout(r, Math.max(0, 640 - (Date.now() - t0))));
        readFile(new URL(import.meta.url), () => busy(600));
      }
      const r = await p;
      // Under load the pool may also have been right to kill (the build still ran at the limit, or the worker did not answer in the grace): then the job stopped with one spend fewer. Either way the record, the checks and the count agree.
      assert.equal(r.killed, undefined, mode);
      assert.equal(arms(job).length, 1, `${mode}: one wallet-arm record`);
      const st = r.result.stopped;
      assert.ok(st && st.spends >= 1 && st.spends <= 2, `${mode}: stopped with ${st && st.spends} spends`);
      assert.equal(st.at === STOPPED_AT.boundary, st.spends === 2, `${mode}: ${st.at} with ${st.spends} spends`);
      assert.deepEqual([r.result.validity.txs, r.result.validity.failed], [st.spends, st.spends - 1], `${mode}: the kept spends' checks`);
      assert.equal(pool.stats.watchdogStops, 1, mode);
      assert.deepEqual(notes.filter((e) => e.event === 'watchdog stop').map((e) => e.at), [st.at], mode);
    } finally {
      Pool.prototype.attempt = orig;
      await pool.close();
      client.destroy();
      server.close();
    }
  }
}));

test('a job run again after its worker died, through runJob, has the spool of the attempt that completed, none of the dead one\'s lines', withHome(async (home) => {
  mkdirSync(join(home, 'd'));
  const pool = new Pool({ treatmentDir: 'unused', size: 1, memoryBudget: 64 * 1024 ** 3, workerUrl: new URL('../../lib/runjob-stop-worker.mjs', import.meta.url) });
  try {
    // The first attempt writes two spends and dies; the second writes one.
    const job = { key: KEY, hypotheses: ['t'], opts: {}, spool: spoolPaths(join(home, 'd'), 0), counter: join(home, 'd', 'count'), memory: null, validity: true, script: [{ build: 5, checks: V(1) }, { build: 5, checks: V(1) }], dieAfter: [1, 2] };
    const r = await pool.replay(job);
    assert.equal(r.ok, true);
    assert.deepEqual(pool.stats.machineReruns, 1);
    const recs = lines(job.spool.records).map((l) => JSON.parse(l));
    assert.deepEqual(recs.map((x) => [x.kind, x.intent]), [['spend', 0], ['spend', 1], ['wallet-arm', undefined]]);
    assert.deepEqual(lines(job.spool.timings).map((l) => JSON.parse(l).n), [1, 2]);
    assert.equal(lines(job.spool.validity).length, 2, 'the validity file is the completed attempt\'s');
    assert.equal(r.result.spooled.count, 3);
  } finally {
    await pool.close();
  }
}));

// ---- with the treatment

const T = await treatment();
const S1 = { kind: 'shape', name: 'S1', stream: 'synthetic' };
const planStall = [{ hypothesis: 'test', arm: 'observed', variant: 'default', role: 'stall', change: 'default', repetitions: 1 }, { hypothesis: 'test', arm: 'observed', variant: 'default', role: 'test', change: 'default', repetitions: 1 }];

test('a job under the limit writes the records it wrote before the limit existed', { skip, timeout: 4 * 60 * 1000 }, withHome(async () => {
  const { loadSource } = await import('../../../src/replay/source.mjs');
  const { replay } = await import('../../../src/replay/engine.mjs');
  const { makeMethod } = await import('../../../src/methods/registry.mjs');
  const { replayJobOpts } = await import('../../../src/replay/run.mjs');
  const source = loadSource(T, S1);
  mkdirSync(join(process.env.RESEARCH_SIM_HOME, 'x'));
  {
    const j = expandJobs(PLAN, { roles: TEST_ROLES, needsCollateral: false })[0];
    const key = { wallet: source.wallet, window: source.window, arm: j.arm, variant: j.variant, method: j.method, change: j.change, collateral: j.collateral, repetition: j.repetition };
    const base = { arm: j.arm, variant: j.variant, repetition: j.repetition, opts: replayJobOpts(j), settleEvery: 25, validity: true, key, hypotheses: j.hypotheses };
    // The base: the whole result, written at the end.
    const x = await replay(T, source.params, source, { ...base, method: makeMethod(T, j.method, {}) });
    x.method = { name: j.method, version: makeMethod(T, j.method, {}).version, deterministic: true };
    const a = spoolJob(x, { ...base, spool: spoolPaths(join(process.env.RESEARCH_SIM_HOME, 'x'), 0) });
    // Now: written as the job goes, under a limit it does not reach.
    const b = await runJob(T, source, { ...base, spool: spoolPaths(join(process.env.RESEARCH_SIM_HOME, 'x'), 1), planned: 99, machine: 'rig' }, makeMethod(T, j.method, {}), { stopAt: performance.now() + 3600e3, attempt: 1, limitMs: 3600e3 });
    assert.equal(b.stopped, undefined);
    assert.equal(readFileSync(b.spooled.records, 'utf8'), readFileSync(a.spooled.records, 'utf8'));
    assert.deepEqual(timeless(readFileSync(b.spooled.timings, 'utf8')), timeless(readFileSync(a.spooled.timings, 'utf8')));
    assert.deepEqual([b.spooled.count, b.spooled.counts], [a.spooled.count, a.spooled.counts]);
    assert.deepEqual(b.validity, a.validity);
  }
}));

test('the engine stops before the next intent once its time has passed, keeping the spends made, in the records a finished job writes for them', { skip, timeout: 4 * 60 * 1000 }, withHome(async () => {
  const { loadSource } = await import('../../../src/replay/source.mjs');
  const { makeMethod } = await import('../../../src/methods/registry.mjs');
  const { replayJobOpts } = await import('../../../src/replay/run.mjs');
  const source = loadSource(T, S1);
  const intents = source.events.filter((e) => e.kind === 'intent');
  assert.ok(intents.length >= 3);
  const j = expandJobs(planStall.map((p) => ({ ...p })), { roles: { stall: 'test-stall', test: 'test-largest-first' }, needsCollateral: false })[0];
  const key = { wallet: source.wallet, window: source.window, arm: j.arm, variant: j.variant, method: j.method, change: j.change, collateral: j.collateral, repetition: j.repetition };
  const dir = process.env.RESEARCH_SIM_HOME;
  mkdirSync(join(dir, 's'));
  const job = (n, extra) => ({ arm: j.arm, variant: j.variant, repetition: j.repetition, opts: replayJobOpts(j), settleEvery: 25, validity: true, key, hypotheses: j.hypotheses, spool: spoolPaths(join(dir, 's'), n), planned: intents.length, capped: false, machine: 'rig-g', ...extra });
  // The first intent's build takes 800 ms, past the limit 300 ms after the start; the others fail at once.
  const method = () => makeMethod(T, 'test-stall', { stallMs: 800, only: [intents[0].intent.id] });
  const whole = await runJob(T, source, job(0), method(), {});
  const events = [];
  const stopped = await runJob(T, source, job(1), method(), { stopAt: performance.now() + 300, attempt: 3, limitMs: 300, onBuild: (on) => events.push(on) });
  assert.equal(events.length % 2, 0);
  assert.equal(events.at(-1), false, 'no build began after the limit');
  assert.equal(stopped.stopped.at, STOPPED_AT.boundary);
  assert.equal(stopped.refused, false);
  const kept = lines(stopped.spooled.records).map((l) => JSON.parse(l));
  const all = lines(whole.spooled.records).map((l) => JSON.parse(l));
  assert.deepEqual(kept.map((r) => r.kind), ['spend', 'wallet-arm']);
  // The kept spend is the finished job's first, line for line.
  assert.equal(lines(stopped.spooled.records)[0], lines(whole.spooled.records)[0]);
  const arm = kept[1];
  assert.deepEqual({ ...arm.stopped, elapsedMs: 0 }, { reason: 'excessive time', attempt: 3, limitMs: 300, elapsedMs: 0, at: 'spend boundary', spends: 1, planned: intents.length, last: { intent: all[0].intent, t: all[0].t }, machine: 'rig-g' });
  assert.ok(arm.stopped.elapsedMs >= 300, `${arm.stopped.elapsedMs} ms`);
  assert.deepEqual([arm.methodVersion, arm.capped, arm.hypotheses], ['1', false, j.hypotheses]);
  assert.deepEqual(Object.keys(arm).sort(), ['arm', 'capped', 'change', 'collateral', 'hypotheses', 'kind', 'method', 'methodVersion', 'repetition', 'stopped', 'variant', 'wallet', 'window']);
  assert.equal(stopped.spooled.held.kind, 'wallet-arm');
  assert.equal(stopped.spooled.count, 2);
  // The finished job ends with a wallet-arm record that has none of these fields.
  assert.equal(all.at(-1).stopped, undefined);
}));

test('a stopped job\'s validity is the checks of the spends it kept, the same as the side file a kill leaves, and a rerun on the same spool leaves none of the first run\'s lines', { skip, timeout: 4 * 60 * 1000 }, withHome(async () => {
  const { loadSource } = await import('../../../src/replay/source.mjs');
  const { replay } = await import('../../../src/replay/engine.mjs');
  const { makeMethod } = await import('../../../src/methods/registry.mjs');
  const { replayJobOpts } = await import('../../../src/replay/run.mjs');
  const { summarize, newValidity, mergeValidity } = await import('../../../src/kit/validity.mjs');
  const source = loadSource(T, S1);
  const j = expandJobs(PLAN, { roles: TEST_ROLES, needsCollateral: false })[0];
  const key = { wallet: source.wallet, window: source.window, arm: j.arm, variant: j.variant, method: j.method, change: j.change, collateral: j.collateral, repetition: j.repetition };
  const dir = process.env.RESEARCH_SIM_HOME;
  mkdirSync(join(dir, 'v'));
  const base = { arm: j.arm, variant: j.variant, repetition: j.repetition, opts: replayJobOpts(j), settleEvery: 25, validity: true, key, hypotheses: j.hypotheses };
  // The whole run's per-spend checks, and the stop after the third spend.
  const checks = [];
  const full = await replay(T, source.params, source, { ...base, method: makeMethod(T, j.method, {}), onSpend: (_s, c) => checks.push(c) });
  assert.ok(checks.length >= 4 && full.validity === undefined && full.summary.validity.txs > 0);
  const all = newValidity(null);
  for (const c of checks) if (c) mergeValidity(all, { ...c, details: c.failures || [] });
  assert.ok(full.summary.validity.txs >= summarize(all).txs, 'the run\'s total includes the burst passes\' checks, the spends\' alone do not');
  const jobObj = { ...base, method: makeMethod(T, j.method, {}) };
  let n = 0;
  jobObj.onSpend = () => {
    if (++n === 3) jobObj.stopAt = 0;
  };
  const cut = await replay(T, source.params, source, jobObj);
  assert.equal(cut.stopped.spends, 3);
  const side = join(dir, 'v', '0.validity.jsonl');
  writeFileSync(side, checks.map((c) => `${JSON.stringify(c)}\n`).join(''));
  assert.deepEqual(cut.validity, keptValidity(side, 3), 'the boundary path and the side file of a kill count the same checks');
  assert.deepEqual(keptValidity(side, checks.length), checks.some(Boolean) ? summarize(all) : null);
  // A rerun on the spool of a job that had stopped midway: the same bytes as a clean run.
  const spool = (name) => spoolPaths(join(dir, 'v'), name);
  const first = await runJob(T, source, { ...base, spool: spool(1), planned: 9, machine: 'rig' }, makeMethod(T, j.method, {}), { stopAt: 0 });
  assert.equal(first.stopped.spends, 0);
  const again = await runJob(T, source, { ...base, spool: spool(1), planned: 9, machine: 'rig' }, makeMethod(T, j.method, {}), {});
  const clean = await runJob(T, source, { ...base, spool: spool(2), planned: 9, machine: 'rig' }, makeMethod(T, j.method, {}), {});
  assert.equal(readFileSync(again.spooled.records, 'utf8'), readFileSync(clean.spooled.records, 'utf8'));
  assert.deepEqual(timeless(readFileSync(again.spooled.timings, 'utf8')), timeless(readFileSync(clean.spooled.timings, 'utf8')));
  assert.equal(existsSync(spool(1).validity), true, 'the worker leaves the validity file; the parent removes it');
}));

test('a real worker whose build outlasts the limit is killed and its spool keeps the spends before it; the job is not run again, and its wallet is done', { skip, timeout: 4 * 60 * 1000 }, withHome(async () => {
  const { Pool } = await import('../../../src/replay/pool.mjs');
  const { DEFAULT_PINS } = await import('../../../src/treatment/bridge.mjs');
  const { loadSource } = await import('../../../src/replay/source.mjs');
  const spec = S1;
  const intents = loadSource(T, spec).events.filter((e) => e.kind === 'intent');
  assert.ok(intents.length >= 4);
  const wallets = [{ spec }];
  const roles = { stall: 'test-stall', test: 'test-largest-first' };
  const opts = { wallets, plan: planStall, roles, methodOptions: { 'test-stall': { stallMs: 60 * 1000, only: [intents[2].intent.id] } }, collateralRules: ['ledger'] };
  const go = async (id, extra) => {
    const pool = new Pool({ treatmentDir: TREATMENT_DIR, pinsPath: process.env.RESEARCH_SIM_TREATMENT_PINS || DEFAULT_PINS, size: 1 });
    const out = await testStage(id, wallets, { machine: 'rig-h' });
    try {
      const totals = await runReplays(T, pool, { ...opts, ...extra, out });
      return { totals, dir: out.dir, stats: { ...pool.stats } };
    } finally {
      out.close();
      await pool.close();
    }
  };
  const t0 = Date.now();
  const r = await go('killed-real', { watchdogMs: 3000 });
  assert.ok(Date.now() - t0 < 30000, 'the job was killed at the limit, not run to its minute');
  const recs = recordsOf(r.dir);
  const stall = recs.filter((x) => x.method === 'test-stall');
  assert.deepEqual(stall.map((x) => x.kind), ['spend', 'spend', 'wallet-arm']);
  assert.deepEqual(stall.slice(0, 2).map((x) => x.intent), [0, 1]);
  const arm = stall[2];
  assert.deepEqual({ ...arm.stopped, elapsedMs: 0 }, { reason: 'excessive time', attempt: 1, limitMs: 3000, elapsedMs: 0, at: STOPPED_AT.build, spends: 2, planned: intents.length, last: { intent: 1, t: stall[1].t }, machine: 'rig-h' });
  assert.ok(arm.stopped.elapsedMs >= 3000 && arm.stopped.elapsedMs < 20000, `${arm.stopped.elapsedMs} ms`);
  assert.equal(arm.methodVersion, '1');
  // The other job of the wallet is whole.
  assert.equal(recs.filter((x) => x.method === 'test-largest-first' && x.kind === 'wallet-arm').every((x) => x.stopped === undefined && x.counts), true);
  assert.deepEqual([r.stats.watchdogStops, r.stats.machineReruns, r.stats.started], [1, 0, 2], 'stopped once, never rerun; a second worker only for the next job after the kill');
  assert.deepEqual(r.totals, { wallets: 1, jobs: 2, refused: 0, stopped: 1 });
  const log = stageLog(r.dir, 'rig-h').filter((e) => e.event === 'watchdog stop');
  assert.deepEqual(log.map((e) => [e.method, e.watchdogMs, e.at, e.attempt]), [['test-stall', 3000, 'running build', 1]]);
  // The spends before the build are those of a run that never reaches it.
  const plainRun = await go('plain-real', { methodOptions: { 'test-stall': { stallMs: 1, only: [intents[2].intent.id] } } });
  const first2 = (rs) => rs.filter((x) => x.method === 'test-stall' && x.kind === 'spend').slice(0, 2).map((x) => plain(JSON.stringify(x)));
  assert.deepEqual(first2(recs), first2(recordsOf(plainRun.dir)));
  // Resumed, the stage runs nothing: the wallet is done.
  const again = await go('killed-real', { watchdogMs: 3000 });
  assert.deepEqual([again.stats.started, again.stats.watchdogStops], [0, 0]);
  assert.equal(stageText(again.dir), stageText(r.dir));
}));
