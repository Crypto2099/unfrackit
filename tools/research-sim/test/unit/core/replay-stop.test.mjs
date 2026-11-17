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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStage, walletList } from '../../../src/out/stage.mjs';
import { mergeStage } from '../../../src/out/merge.mjs';
import { selectionOf } from '../../../src/replay/shards.mjs';
import { spoolJob, runJob, runReplays, STOPPED_AT } from '../../../src/replay/run.mjs';
import { record } from '../../../src/out/records.mjs';
import { SpoolStream, spoolRecords, spoolPaths, repairSpool } from '../../../src/out/spool.mjs';
import { windowPlan, expandJobs, TEST_ROLES } from '../../../src/arms/plan.mjs';
import { HISTORY_FORMAT } from '../../../src/state/history.mjs';
import { paramsFromRow } from '../../../src/history/params.mjs';
import { runDir } from '../../../src/history/paths.mjs';
import { STAGE_LAYOUT } from '../../../src/out/stage.mjs';
import { stageText, stageLog, testStage } from '../../lib/stage.mjs';
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
  assert.deepEqual(repairSpool(paths), { count: 0, counts: {}, spends: 0, last: null });
  const s = new SpoolStream(paths, { eager: true });
  s.add(spend(0));
  s.add(spend(1));
  s.close();
  // A kill after the third timing row and during the third record's line.
  appendFileSync(paths.timings, '{"n":3,"kind":"spend","times":{"ms":4}}\n{"n":4,"ki');
  appendFileSync(paths.records, '{"kind":"spend","intent":2,"t"');
  const r = repairSpool(paths);
  assert.deepEqual(r, { count: 2, counts: { spend: 2 }, spends: 2, last: { intent: 1, t: 20 } });
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

// A stand-in pool whose replay of `killAt` (a wallet/job place) is killed at
// the limit: the worker's spool holds two spends and the start of a third
// record, as a kill in the middle of a write leaves it. `fail`: a place whose
// job fails (it stops the run).
function standInPool({ killAt = null, fail = null } = {}) {
  const pool = {
    size: 2,
    stats: { started: 0, recycled: 0, watchdogStops: 0, machineReruns: 0 },
    order: [],
    limits: [],
    async replay(job, { watchdogMs } = {}) {
      const [wi, i] = placeOf(job);
      pool.order.push(`${wi}/${i}`);
      pool.limits.push(watchdogMs);
      await new Promise((r) => setTimeout(r, (wi * 3 + i) % 3));
      const here = `${wi}/${i}`;
      if (here === fail) return { ok: false, error: 'stand-in failure', stop: false, ms: 1 };
      if (here === killAt) {
        const s = new SpoolStream(job.spool, { hold: (r) => r.kind === 'wallet-arm', eager: true });
        for (const x of engineResult().spends) s.add(record('spend', job.key, x));
        s.close();
        appendFileSync(job.spool.records, '{"kind":"spend","wallet":');
        pool.stats.watchdogStops++;
        return { ok: true, killed: { at: 'build', attempt: 2, limitMs: watchdogMs, info: { methodVersion: 'test-1' } }, ms: 1234.4 };
      }
      return { ok: true, result: spoolJob(engineResult(), job), ms: 5 };
    }
  };
  return pool;
}

async function run(runId, wallets, pool, { machine, shard, watchdogMs, plan = PLAN } = {}) {
  const list = walletList(wallets);
  const out = await openStage(runDir('preprod', runId), { header: HEADER, wallets: list, workers: pool.size, machine, selection: selectionOf(shard ? { shard } : {}, { plan: 'recent', wallets: list }) });
  try {
    const totals = await runReplays(null, pool, { wallets, plan, roles: TEST_ROLES, out, ...(watchdogMs ? { watchdogMs } : {}), maxOpen: 1 });
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
    const b = await runJob(T, source, { ...base, spool: spoolPaths(join(process.env.RESEARCH_SIM_HOME, 'x'), 1), planned: 99, machine: 'rig' }, makeMethod(T, j.method, {}), { stopAt: Date.now() + 3600e3, attempt: 1, limitMs: 3600e3 });
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
  const stopped = await runJob(T, source, job(1), method(), { stopAt: Date.now() + 300, attempt: 3, limitMs: 300, onBuild: (on) => events.push(on) });
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
