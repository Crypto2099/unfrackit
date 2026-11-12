// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Several replay wallets in flight (src/replay/run.mjs runReplays), with no
// treatment: history files with no event, replayed by a stand-in pool that
// takes at most twice its worker count of jobs at once, each after a delay,
// some held until the test releases them. The window opens a wallet only
// while fewer than twice the workers' jobs are queued and fewer wallets than
// the cap are open, the pool is never handed more than twice its workers'
// jobs, and jobs are handed in (wallet, job) order. Wallets close out of order, and the stage's
// records, timing rows (times aside), segments and totals equal a run with
// one wallet open at a time. A slow job in wallet 0 does not stop wallets 1
// and 2 from running and closing. A failed job leaves the open wallets with a
// job not ended without a done file and keeps the closed wallets' segments,
// and a resume completes the stage equal to an uninterrupted run. A shard
// runs its own wallets through the window, and its merge with the other
// shard equals the unsharded run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStage, walletList, STAGE_LAYOUT } from '../../../src/out/stage.mjs';
import { mergeStage } from '../../../src/out/merge.mjs';
import { selectionOf } from '../../../src/replay/shards.mjs';
import { spoolJob, runReplays, openWalletCap, poolJobCap } from '../../../src/replay/run.mjs';
import { windowPlan, expandJobs, TEST_ROLES } from '../../../src/arms/plan.mjs';
import { HISTORY_FORMAT } from '../../../src/state/history.mjs';
import { paramsFromRow } from '../../../src/history/params.mjs';
import { runDir } from '../../../src/history/paths.mjs';
import { stageText, stageLog } from '../../lib/stage.mjs';

const HEADER = Object.freeze({ layout: STAGE_LAYOUT, command: 'replay', plan: 'recent', options: { plan: 'recent', reps: '1', validity: true }, node: process.version, csl: { package: 'csl', version: '17.0.0', wasm: { 'a.wasm': 'ab'.repeat(32) } }, manifest: 'stand-in manifest\n' });
// The recent plan at one repetition, every role played by the test method.
const PLAN = windowPlan('recent', { reps: 1 });
const ROLES = TEST_ROLES;
const JOBS = expandJobs(PLAN, { roles: ROLES, needsCollateral: false }).length;

function withHome(fn) {
  return async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'research-sim-window-'));
    const prev = process.env.RESEARCH_SIM_HOME;
    process.env.RESEARCH_SIM_HOME = home;
    try {
      await fn(home, t);
    } finally {
      if (prev === undefined) delete process.env.RESEARCH_SIM_HOME;
      else process.env.RESEARCH_SIM_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

// A minimal history file: one wallet, no UTxO and no event, which the
// stand-in pool replays without the treatment.
const PARAMS = paramsFromRow('preprod', { epoch_no: 300, protocol_major: 10, min_fee_a: 44, min_fee_b: 155381, coins_per_utxo_size: 4310, max_val_size: 5000, max_tx_size: 16384, max_collateral_inputs: 3, collateral_percent: 150, price_mem: 0.0577, price_step: 0.0000721, min_fee_ref_script_cost_per_byte: 15, key_deposit: 2000000, pool_deposit: 500000000, drep_deposit: 500000000, gov_action_deposit: 100000000000 });
function historyFile(dir, wallet) {
  const lines = [
    { kind: 'header', format: HISTORY_FORMAT, network: 'preprod', wallet, frame: 'recent', split: null, window: { first: { time: 0 }, last: { time: 1000 } }, snapshot: { block: 1, tx: 1 }, params: PARAMS, franken: [], arrival: [], latestKeyBase: null, settings: {}, source: { bytes: 'tx_cbor' } },
    { kind: 'state', at: { tx: 1 }, utxos: [] },
    { kind: 'end', at: { tx: 2 }, utxos: 0, digest: '00', counts: { deposit: 0, 'held-consumed': 0, intent: 0, 'self-reorganization': 0, mark: 0 } }
  ];
  const path = join(dir, `${wallet}.recent.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

function walletsIn(home, ids) {
  const files = join(home, 'histories');
  mkdirSync(files, { recursive: true });
  return ids.map((w) => ({ spec: { kind: 'history', path: historyFile(files, w), analysisFreezeTx: null } }));
}

// An engine result as a worker has it: two spends and a burst.
function engineResult(arm, variant, repetition) {
  const never = repetition % 2 === 0;
  return {
    spends: [
      { intent: 0, type: 'T1', t: 10, burst: null, outcome: 'built', fee: 170000n, ms: 2.5 },
      { intent: 1, type: 'T4', t: 40, burst: null, collateralAvailable: { ledger: true, practice: !never }, outcome: 'built', fee: 400000n, ms: 9 }
    ],
    bursts: [{ id: 'b1', t: 50, feasible: !never, txs: 2 }],
    summary: { counts: { intents: 2 }, fees: { spends: 570000n }, validity: { txs: 3, cslRead: 3, cslOutputBytes: 0, cslReencoded: 0, controls: { fee: 3, size: 3, value: 3, witnesses: 3 }, notApplicable: { fee: 0, value: 0 }, failed: 0 }, ms: 12.5 },
    method: { name: 'test-largest-first', version: 'test-1', deterministic: true }
  };
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Waits until a file exists, for at most ten seconds.
async function until(path) {
  for (const t0 = Date.now(); !existsSync(path);) {
    if (Date.now() - t0 > 10000) throw new Error(`${path} did not appear`);
    await tick(2);
  }
}
// A job's wallet and job index, from its spool's path.
const placeOf = (job) => {
  const m = /[/\\]spool[/\\](\d+)[/\\](\d+)\.records\.jsonl$/.exec(job.spool.records);
  return [Number(m[1]), Number(m[2])];
};

// A stand-in pool of `size` workers. It refuses more than twice its workers'
// jobs at once (the run is to queue the rest), records the order jobs come in,
// answers each after a delay that puts the jobs out of order, holds a job
// whose place `hold` names until the test releases it, and fails the job
// `fail` names.
function standInPool({ size = 2, hold = new Map(), fail = null } = {}) {
  const pool = {
    size,
    stats: { started: 0, recycled: 0, watchdogStops: 0, machineReruns: 0 },
    running: 0,
    most: 0,
    order: [],
    async replay(job) {
      const [wi, i] = placeOf(job);
      pool.running++;
      pool.most = Math.max(pool.most, pool.running);
      pool.order.push([wi, i]);
      assert.ok(pool.running <= poolJobCap(size), `the run handed the pool ${pool.running} jobs at once, over twice its ${size} workers`);
      try {
        await tick((wi * 7 + i * 3) % 4);
        const held = hold.get(`${wi}/${i}`);
        if (held) await held.promise;
        if (fail === `${wi}/${i}`) return { ok: false, error: 'stand-in failure', stop: false, ms: 1 };
        return { ok: true, result: spoolJob(engineResult(job.arm, job.variant, job.repetition), job), ms: 5 + i };
      } finally {
        pool.running--;
      }
    }
  };
  return pool;
}

// The stage under a run ID, opened over the wallets with the pool's worker
// count and the share opts gives; its segment() and complete() watched, so
// that the test sees, at each wallet's opening, the jobs handed to the pool
// and the wallets closed so far. hold: { index, started, gate }, a wallet
// whose close, once it starts, waits for the gate.
async function openWatched(runId, wallets, pool, { machine, shard, hold = null } = {}) {
  const list = walletList(wallets);
  const out = await openStage(runDir('preprod', runId), { header: HEADER, wallets: list, workers: pool.size, machine, selection: selectionOf(shard ? { shard } : {}, { plan: 'recent', wallets: list }) });
  const seen = { opens: [], closes: [] };
  const segment = out.segment.bind(out);
  out.segment = (i) => {
    seen.opens.push({ i, handed: pool.order.length, closed: seen.closes.length });
    return segment(i);
  };
  const complete = out.complete.bind(out);
  out.complete = async (...a) => {
    if (hold && a[0] === hold.index) {
      hold.started.resolve();
      await hold.gate.promise;
    }
    const d = await complete(...a);
    seen.closes.push(a[0]);
    return d;
  };
  return { out, seen };
}

async function run(runId, wallets, pool, { maxOpen, machine, shard, hold } = {}) {
  const { out, seen } = await openWatched(runId, wallets, pool, { machine, shard, hold });
  try {
    const totals = await runReplays(null, pool, { wallets, plan: PLAN, roles: ROLES, out, validity: true, ...(maxOpen ? { maxOpen } : {}) });
    return { totals, counts: out.counts, dir: out.dir, seen, ended: out.ended };
  } finally {
    out.close();
  }
}

const plain = (t) => t.replace(/"ms":\d+(\.\d+)?/g, '"ms":0');
const doneOf = (dir, i) => JSON.parse(readFileSync(join(dir, 'segments', `${i}.done.json`), 'utf8'));
const doneFiles = (dir) => readdirSync(join(dir, 'segments')).filter((f) => f.endsWith('.done.json')).sort();
const machineOf = (dir, label = 'local') => JSON.parse(readFileSync(join(dir, 'machines', `${label}.json`), 'utf8'));

// Every check of the window on a run: each wallet opened in index order of
// the wallets it ran, while fewer than twice the workers' jobs were queued
// (the opened wallets' jobs less those handed to the pool) and fewer than
// maxOpen wallets were open; the pool never held more than twice its
// workers' jobs; the jobs were handed in (wallet, job) order.
function assertWindow(r, pool, { maxOpen = openWalletCap(pool.size), indexes }) {
  assert.deepEqual(r.seen.opens.map((o) => o.i), indexes, 'wallets open in index order');
  r.seen.opens.forEach((o, k) => {
    const queued = k * JOBS - o.handed;
    assert.ok(queued < 2 * pool.size, `wallet ${o.i} opened with ${queued} jobs queued`);
    assert.ok(k - o.closed < maxOpen, `wallet ${o.i} opened with ${k - o.closed} wallets open`);
  });
  assert.ok(pool.most <= poolJobCap(pool.size));
  const order = pool.order.map(([wi, i]) => wi * 1000 + i);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'jobs start in (wallet, job) order');
  assert.equal(pool.order.length, indexes.length * JOBS);
}

// Equal stages: the joined records, the timing rows with their times set
// aside, each segment's records digest, the totals and the counts.
function assertSameStage(a, b) {
  assert.equal(stageText(a.dir), stageText(b.dir));
  assert.equal(plain(stageText(a.dir, 'timings')), plain(stageText(b.dir, 'timings')));
  assert.deepEqual(a.totals, b.totals);
  assert.deepEqual(a.counts, b.counts);
  const n = JSON.parse(readFileSync(join(a.dir, 'wallets.json'), 'utf8')).length;
  for (let i = 0; i < n; i++) {
    const [x, y] = [doneOf(a.dir, i), doneOf(b.dir, i)];
    assert.deepEqual([x.records.sha256, x.records.lines, x.counts, x.totals], [y.records.sha256, y.records.lines, y.counts, y.totals], `wallet ${i}`);
  }
}

test('several wallets open at once, closed out of order, write the records, timing rows, segments and totals of a run with one wallet open at a time', withHome(async (home) => {
  assert.equal(JOBS, 12);
  assert.equal(openWalletCap(2), 4);
  assert.equal(poolJobCap(2), 4);
  const wallets = walletsIn(home, [101, 102, 103, 104, 105, 106]);
  const one = await run('one-at-a-time', wallets, standInPool(), { maxOpen: 1 });
  assert.ok(one.seen.opens.every((o, k) => o.closed === k), 'one wallet open at a time');
  // Wallet 0's first job is slow, so the wallets after it close first.
  const slow = deferred();
  const pool = standInPool({ hold: new Map([['0/0', slow]]) });
  const going = run('window', wallets, pool);
  await until(join(runDir('preprod', 'window'), 'segments', '3.done.json'));
  slow.resolve();
  const many = await going;
  assertWindow(many, pool, { indexes: [0, 1, 2, 3, 4, 5] });
  const completed = machineOf(many.dir).invocations[0].completed;
  assert.deepEqual([...completed].sort(), [0, 1, 2, 3, 4, 5]);
  assert.notEqual(completed[0], 0, `closed out of order: ${completed}`);
  assert.ok(completed.indexOf(0) > completed.indexOf(3));
  assert.ok(Math.max(...many.seen.opens.map((o, k) => k + 1 - o.closed)) >= 3, 'several wallets open at once');
  assertSameStage(many, one);
  assert.deepEqual(many.totals, { wallets: 6, jobs: 6 * JOBS, refused: 0, validity: many.totals.validity });
  assert.equal(existsSync(join(many.dir, 'spool')), false);
  const window = stageLog(many.dir).find((e) => e.event === 'window');
  assert.deepEqual([window.workers, window.queue, window.inPool, window.maxOpen, window.wallets], [2, 4, 4, 4, 6]);
}));

test('the cap on open wallets holds while a slow job keeps a wallet open, and the window still opens wallets up to it', withHome(async (home) => {
  const wallets = walletsIn(home, [111, 112, 113, 114, 115]);
  const ref = await run('cap-ref', wallets, standInPool({ size: 3 }), { maxOpen: 1 });
  const slow = deferred();
  const pool = standInPool({ size: 3, hold: new Map([['1/4', slow]]) });
  const going = run('cap-2', wallets, pool, { maxOpen: 2 });
  // Wallet 1 cannot close, so only one other wallet at a time is open beside
  // it: wallets 0, 2, 3 and 4 close in turn.
  await until(join(runDir('preprod', 'cap-2'), 'segments', '4.done.json'));
  assert.equal(existsSync(join(runDir('preprod', 'cap-2'), 'segments', '1.done.json')), false);
  slow.resolve();
  const r = await going;
  assertWindow(r, pool, { maxOpen: 2, indexes: [0, 1, 2, 3, 4] });
  assert.equal(Math.max(...r.seen.opens.map((o, k) => k + 1 - o.closed)), 2, 'the cap is reached and held');
  assert.deepEqual(machineOf(r.dir).invocations[0].completed, [0, 2, 3, 4, 1]);
  assertSameStage(r, ref);
  await assert.rejects(runReplays(null, standInPool(), { wallets, plan: PLAN, roles: ROLES, out: { n: 5 }, maxOpen: 0 }), /the cap on open wallets is a positive whole number/);
}));

test('a slow job in wallet 0 does not stop wallets 1 and 2 from running and closing', withHome(async (home) => {
  const wallets = walletsIn(home, [121, 122, 123]);
  const ref = await run('slow-ref', wallets, standInPool(), { maxOpen: 1 });
  const slow = deferred();
  const pool = standInPool({ hold: new Map([['0/0', slow]]) });
  let finished = false;
  const going = run('slow', wallets, pool).then((r) => {
    finished = true;
    return r;
  });
  const dir = runDir('preprod', 'slow');
  await until(join(dir, 'segments', '2.done.json'));
  // Wallets 1 and 2 are done while wallet 0's first job still runs: every
  // other job of every wallet has ended, on the pool's other worker.
  await tick(20);
  assert.deepEqual(doneFiles(dir), ['1.done.json', '2.done.json']);
  assert.equal(finished, false);
  assert.deepEqual([pool.running, pool.order.length], [1, 3 * JOBS]);
  assert.deepEqual(machineOf(dir).invocations[0].completed, [1, 2]);
  assert.ok(existsSync(join(dir, 'spool', '0')), 'wallet 0 is still open');
  slow.resolve();
  const r = await going;
  assert.deepEqual(machineOf(dir).invocations[0].completed, [1, 2, 0]);
  assertWindow(r, pool, { indexes: [0, 1, 2] });
  assertSameStage(r, ref);
}));

test('a failed job stops the run: the open wallets with a job not ended have no done file, the closed wallets keep their segments, and a resume completes the stage equal to an uninterrupted run', withHome(async (home) => {
  const wallets = walletsIn(home, [131, 132, 133, 134]);
  const ref = await run('failed-ref', wallets, standInPool(), { maxOpen: 1 });
  // Wallet 0's first job is held, and so is wallet 1's close once it starts.
  // Then wallet 2's sixth job fails, and wallet 0's held job ends, the last
  // of its wallet, while wallet 1 is still closing: the failure dropped
  // wallet 0, so it does not close. Then wallet 1 closes and the run stops.
  const slow = deferred();
  const late = deferred();
  const closing = { index: 1, started: deferred(), gate: deferred() };
  const pool = standInPool({ hold: new Map([['0/0', slow], ['2/5', late]]), fail: '2/5' });
  const going = run('failed', wallets, pool, { hold: closing });
  const dir = runDir('preprod', 'failed');
  await closing.started.promise;
  late.resolve();
  for (const t0 = Date.now(); !stageLog(dir).some((e) => e.event === 'replay error');) {
    if (Date.now() - t0 > 10000) throw new Error('the job did not fail');
    await tick(2);
  }
  slow.resolve();
  await tick(20);
  assert.equal(pool.running, 0);
  assert.deepEqual(doneFiles(dir), []);
  closing.gate.resolve();
  await assert.rejects(going, /replay failed: stand-in failure/);
  assert.deepEqual(doneFiles(dir), ['1.done.json']);
  assert.deepEqual(readdirSync(join(dir, 'segments')).sort(), ['1.done.json', '1.records.jsonl.gz', '1.timings.jsonl.gz']);
  assert.equal(existsSync(join(dir, 'spool')), false, 'the spool is removed');
  assert.equal(existsSync(join(dir, 'done.json')), false, 'the stage has not ended');
  assert.equal(pool.order.some(([wi]) => wi === 3), false, 'no job starts after the failure');
  const log = stageLog(dir);
  assert.deepEqual(log.filter((e) => e.event === 'replay error').map((e) => [e.wallet, e.error]), [[133, 'stand-in failure']]);
  await tick(20);
  assert.deepEqual(doneFiles(dir), ['1.done.json']);
  const done1 = readFileSync(join(dir, 'segments', '1.done.json'), 'utf8');
  const pool2 = standInPool();
  const resumed = await run('failed', wallets, pool2);
  assert.equal(readFileSync(join(dir, 'segments', '1.done.json'), 'utf8'), done1, 'the closed wallet is kept');
  assertWindow(resumed, pool2, { indexes: [0, 2, 3] });
  assertSameStage(resumed, ref);
  const inv = machineOf(dir).invocations;
  assert.deepEqual(inv[0].completed, [1]);
  assert.deepEqual([...inv[1].completed].sort(), [0, 2, 3]);
  const opened = stageLog(dir).find((e) => e.event === 'stage-resume');
  assert.deepEqual([opened.kept, opened.partial], [1, []]);
}));

test('a shard runs its own wallets through the window, in index order, and its merge with the other shard equals the unsharded run', withHome(async (home) => {
  const wallets = walletsIn(home, [141, 142, 143, 144, 145, 146, 147]);
  const ref = await run('shard-ref', wallets, standInPool(), { maxOpen: 1 });
  const slow = deferred();
  const poolA = standInPool({ hold: new Map([['0/0', slow]]) });
  const goingA = run('shard-a', wallets, poolA, { shard: '0/2', machine: 'spare' });
  await until(join(runDir('preprod', 'shard-a'), 'segments', '4.done.json'));
  slow.resolve();
  const a = await goingA;
  const poolB = standInPool();
  const b = await run('shard-b', wallets, poolB, { shard: '1/2', machine: 'laptop' });
  assertWindow(a, poolA, { indexes: [0, 2, 4, 6] });
  assertWindow(b, poolB, { indexes: [1, 3, 5] });
  assert.equal(a.ended, false);
  assert.notEqual(machineOf(a.dir, 'spare').invocations[0].completed[0], 0, 'the shard closed its wallets out of order');
  const m = await mergeStage({ into: a.dir, sources: [b.dir], machine: 'spare' });
  assert.deepEqual(m.totals, ref.totals);
  assert.equal(stageText(a.dir), stageText(ref.dir));
  assert.equal(plain(stageText(a.dir, 'timings')), plain(stageText(ref.dir, 'timings')));
}));
