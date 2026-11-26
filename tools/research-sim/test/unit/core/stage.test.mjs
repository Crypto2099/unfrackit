// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A replay stage's run directory (src/out/stage.mjs), with no treatment: the
// layout and file names; each segment file written under a temporary name and
// renamed; a resume that keeps the done wallets, redoes a partial one and one
// whose bytes do not match its done file; run.json compared field by field
// (another option, wallet list, Node version or CSL build refused, another
// worker count or machine label accepted); the stage's end refusing a missing
// wallet; the joined stream equal to the segments' members joined and to
// their decompressed bytes joined, read whole by zlib.createGunzip() and by
// zcat; the machine label's rule. Then runReplays over history files with a
// stand-in pool: a run stopped by a failed job and resumed writes the records
// and totals of one uninterrupted run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, watch, mkdirSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync, createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { record } from '../../../src/out/records.mjs';
import { openStage, walletList, runDifferences, gunzipDigest, STAGE_LAYOUT } from '../../../src/out/stage.mjs';
import { runDir } from '../../../src/history/paths.mjs';
import { machineLabel, parseArgs } from '../../../src/options.mjs';
import { spoolJob, runReplays } from '../../../src/replay/run.mjs';
import { windowPlan, TEST_ROLES } from '../../../src/arms/plan.mjs';
import { HISTORY_FORMAT } from '../../../src/state/history.mjs';
import { paramsFromRow } from '../../../src/history/params.mjs';
import { stageText, stageLog } from '../../lib/stage.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const HEADER = Object.freeze({ layout: STAGE_LAYOUT, command: 'replay', plan: 'recent', options: { plan: 'recent', reps: '1' }, node: process.version, csl: { package: 'csl', version: '17.0.0', wasm: { 'a.wasm': 'ab'.repeat(32) } }, manifest: 'stand-in manifest\n' });
const SHAPES = ['S1', 'S8', 'M1', 'CL1', 'E2'];
const shapes = (names = SHAPES) => names.map((name) => ({ spec: { kind: 'shape', name, stream: 'synthetic' } }));

function withHome(fn) {
  return async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'research-sim-stage-'));
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

const open = (runId, { wallets = shapes(), header = HEADER, machine, workers = 2 } = {}) => openStage(runDir('synthetic', runId), { header, wallets: walletList(wallets), machine, workers });

// Wallet i's stand-in records: a few per wallet, with times; wallet 2 has
// none with a time, so its timings segment is empty.
function recordsOf(i, name) {
  const key = { wallet: name, window: 'synthetic', arm: 'observed', variant: 'default', method: 'test-largest-first', change: 'default', collateral: 'none-needed', repetition: 1 };
  return Array.from({ length: 3 + i }, (_x, n) => record('spend', key, { intent: n, outcome: 'built', fee: BigInt(170000 + n), ...(i === 2 ? {} : { ms: n + i / 4 }) }));
}

async function writeWallet(stage, i, { stopAfter = null } = {}) {
  const seg = stage.segment(i);
  const recs = recordsOf(i, SHAPES[i]);
  for (const [n, rec] of recs.entries()) {
    if (n === stopAfter) {
      seg.close();
      return null;
    }
    seg.write(rec);
  }
  return stage.complete(i, seg, { wallet: SHAPES[i], totals: { jobs: 1, refused: 0, validity: { txs: recs.length, failed: 0 } }, start: new Date() });
}

async function whole(runId, opts) {
  const stage = await open(runId, opts);
  try {
    for (let i = 0; i < stage.n; i++) await writeWallet(stage, i);
    return { totals: await stage.finish(), counts: stage.counts, dir: stage.dir };
  } finally {
    stage.close();
  }
}

test('the stage\'s layout: the wallet list, run.json, a segment and done file per wallet, the machine\'s files, the joined streams and the end', withHome(async () => {
  const { totals, counts, dir } = await whole('layout');
  assert.deepEqual(readdirSync(dir).sort(), ['done.json', 'machines', 'records.jsonl.gz', 'run.json', 'segments', 'timings.jsonl.gz', 'wallets.json']);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const f of ['run.json', 'wallets.json', 'records.jsonl.gz', 'done.json']) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
  const wallets = readFileSync(join(dir, 'wallets.json'));
  assert.deepEqual(JSON.parse(wallets), SHAPES.map((shape) => ({ shape })));
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  assert.deepEqual(run, { ...HEADER, walletsSha256: sha256(wallets) });
  const runSha256 = sha256(readFileSync(join(dir, 'run.json')));
  assert.deepEqual(readdirSync(join(dir, 'segments')).sort(), SHAPES.flatMap((_s, i) => [`${i}.done.json`, `${i}.records.jsonl.gz`, `${i}.timings.jsonl.gz`]).sort());
  for (let i = 0; i < SHAPES.length; i++) {
    const d = JSON.parse(readFileSync(join(dir, 'segments', `${i}.done.json`), 'utf8'));
    const recs = gunzipSync(readFileSync(join(dir, 'segments', `${i}.records.jsonl.gz`)));
    const tims = gunzipSync(readFileSync(join(dir, 'segments', `${i}.timings.jsonl.gz`)));
    assert.deepEqual(Object.keys(d), ['index', 'wallet', 'runSha256', 'records', 'timings', 'counts', 'totals', 'machine', 'start', 'end']);
    assert.deepEqual([d.index, d.wallet, d.runSha256, d.machine], [i, SHAPES[i], runSha256, 'local']);
    assert.deepEqual(d.records, { sha256: sha256(recs), bytes: recs.length, lines: 3 + i, gzipBytes: statSync(join(dir, 'segments', `${i}.records.jsonl.gz`)).size });
    assert.deepEqual(d.timings, { sha256: sha256(tims), bytes: tims.length, lines: i === 2 ? 0 : 3 + i, gzipBytes: statSync(join(dir, 'segments', `${i}.timings.jsonl.gz`)).size });
    assert.deepEqual(d.counts, { spend: 3 + i });
    assert.ok(Date.parse(d.start) <= Date.parse(d.end));
    // Timing rows carry the wallet's index and a number within its segment.
    assert.deepEqual(tims.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.walletIndex, r.n]), i === 2 ? [] : Array.from({ length: 3 + i }, (_x, n) => [i, n + 1]));
  }
  const end = JSON.parse(readFileSync(join(dir, 'done.json'), 'utf8'));
  const all = gunzipSync(readFileSync(join(dir, 'records.jsonl.gz')));
  assert.deepEqual(end.records, { sha256: sha256(all), bytes: all.length, lines: 3 + 4 + 5 + 6 + 7, gzipBytes: statSync(join(dir, 'records.jsonl.gz')).size });
  assert.deepEqual(end.counts, { spend: 25 });
  assert.deepEqual(end.totals, { wallets: 5, jobs: 5, refused: 0, validity: { txs: 25, failed: 0 } });
  assert.deepEqual(totals, end.totals);
  assert.deepEqual(counts, end.counts);
  assert.equal(end.runSha256, runSha256);
  // The machine: one invocation, its facts, the indexes it completed.
  const m = JSON.parse(readFileSync(join(dir, 'machines', 'local.json'), 'utf8'));
  assert.equal(m.label, 'local');
  assert.equal(m.invocations.length, 1);
  const inv = m.invocations[0];
  assert.deepEqual([inv.workers, inv.completed, inv.finished, inv.node], [2, [0, 1, 2, 3, 4], true, process.version]);
  for (const k of ['cpuModel', 'logicalCores', 'physicalCores', 'totalMemoryBytes', 'os', 'osRelease', 'platform', 'wsl', 'virtualization', 'v8', 'start', 'end']) assert.ok(k in inv, k);
  assert.ok(['wsl2', 'vm', 'none', null].includes(inv.virtualization));
  assert.equal(JSON.stringify(m).includes(process.env.HOSTNAME || '\0'), false, 'no host name');
  const log = stageLog(dir);
  assert.deepEqual(log.map((e) => e.event), ['stage-open', ...SHAPES.map(() => 'segment-done'), 'stage-end']);
  assert.equal(existsSync(join(dir, 'lock')), false, 'the lock is released');
  assert.equal(existsSync(join(dir, 'spool')), false);
}));

test('each segment file is written under a temporary name and renamed when complete, its done file last', withHome(async () => {
  const stage = await open('renamed', { wallets: shapes(['S1']) });
  const seen = [];
  const watcher = watch(join(stage.dir, 'segments'), (_e, f) => f && seen.push(f));
  try {
    await writeWallet(stage, 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    watcher.close();
    stage.close();
  }
  const first = (f) => seen.indexOf(f);
  for (const f of ['0.records.jsonl.gz', '0.timings.jsonl.gz', '0.done.json']) {
    assert.ok(first(`${f}.tmp`) !== -1, `${f}.tmp written`);
    assert.ok(first(f) > first(`${f}.tmp`), `${f} after its temporary file`);
  }
  assert.ok(first('0.done.json.tmp') > first('0.records.jsonl.gz') && first('0.done.json.tmp') > first('0.timings.jsonl.gz'), 'the done file after both segment files');
  assert.deepEqual(readdirSync(join(stage.dir, 'segments')).sort(), ['0.done.json', '0.records.jsonl.gz', '0.timings.jsonl.gz']);
}));

test('a resume keeps the done wallets, redoes a partial one and one whose bytes do not match, and ends with an uninterrupted stage\'s streams', withHome(async () => {
  const ref = await whole('resume-ref');
  // A stage stopped with wallets 0 to 3 done, wallet 4 half written to its
  // spool and a temporary file of it left in segments/.
  const a = await open('resume');
  for (let i = 0; i < 4; i++) await writeWallet(a, i);
  await writeWallet(a, 4, { stopAfter: 3 });
  writeFileSync(join(a.dir, 'segments', '4.records.jsonl.gz.tmp'), 'cut short');
  a.close();
  const seg = (i, kind) => join(a.dir, 'segments', `${i}.${kind}`);
  // Wallet 1's records replaced by a valid gzip of other bytes; wallet 3's
  // done file cut short; wallet 2's done file kept.
  writeFileSync(seg(1, 'records.jsonl.gz'), gzipSync('{"kind":"spend"}\n'));
  writeFileSync(seg(3, 'done.json'), '{"index":3,');
  const done0 = readFileSync(seg(0, 'done.json'), 'utf8');
  const b = await open('resume', { workers: 4 });
  try {
    assert.deepEqual(Array.from({ length: 5 }, (_x, i) => b.isDone(i)), [true, false, true, false, false]);
    assert.equal(existsSync(join(b.dir, 'spool')), false, 'the spool is removed');
    assert.deepEqual(readdirSync(join(b.dir, 'segments')).sort(), ['0.done.json', '0.records.jsonl.gz', '0.timings.jsonl.gz', '2.done.json', '2.records.jsonl.gz', '2.timings.jsonl.gz']);
    const opened = stageLog(b.dir).filter((e) => e.event === 'stage-resume');
    assert.equal(opened.length, 1);
    assert.deepEqual([opened[0].kept, opened[0].partial, opened[0].redo, opened[0].workers], [2, [4], [1, 3], 4]);
    const redo = stageLog(b.dir).filter((e) => e.event === 'segment-redo');
    assert.deepEqual(redo.map((e) => e.index), [1, 3]);
    assert.match(redo[0].reason, /records file's decompressed bytes differ/);
    assert.match(redo[1].reason, /done file cannot be read/);
    for (const i of [1, 3, 4]) await writeWallet(b, i);
    assert.deepEqual(await b.finish(), ref.totals);
  } finally {
    b.close();
  }
  assert.equal(readFileSync(seg(0, 'done.json'), 'utf8'), done0, 'a done wallet is not rewritten');
  assert.equal(stageText(b.dir), stageText(ref.dir));
  assert.equal(stageText(b.dir, 'timings'), stageText(ref.dir, 'timings'));
  const m = JSON.parse(readFileSync(join(b.dir, 'machines', 'local.json'), 'utf8'));
  assert.deepEqual(m.invocations.map((v) => [v.workers, v.completed, v.finished]), [[2, [0, 1, 2, 3], false], [4, [1, 3, 4], true]]);
}));

test('a resume refuses another run.json, naming what differs, and changes nothing; another worker count or machine label is accepted', withHome(async () => {
  const a = await open('strict');
  await writeWallet(a, 0);
  a.close();
  const dir = a.dir;
  const snapshot = () => readdirSync(dir, { recursive: true }).sort().map((f) => [f, statSync(join(dir, f)).isFile() ? readFileSync(join(dir, f), 'utf8') : null]);
  const before = snapshot();
  const refuse = async (opts, re) => {
    await assert.rejects(open('strict', opts), re);
    assert.deepEqual(snapshot(), before);
  };
  await refuse({ header: { ...HEADER, node: 'v24.0.0' } }, /it differs in the Node version\. Resume it/);
  await refuse({ header: { ...HEADER, csl: { ...HEADER.csl, wasm: { 'a.wasm': 'cd'.repeat(32) } } } }, /differs in the CSL build/);
  await refuse({ header: { ...HEADER, options: { ...HEADER.options, reps: '2', validity: true } } }, /differs in --reps, --validity/);
  await refuse({ header: { ...HEADER, manifest: 'another\n' } }, /differs in the code manifest/);
  await refuse({ wallets: shapes([...SHAPES].reverse()) }, /differs in the wallet list/);
  await refuse({ header: { ...HEADER, node: 'v25.0.0', manifest: 'another\n' } }, /differs in the Node version, the code manifest/);
  assert.deepEqual(runDifferences({ a: 1, options: { x: '1' } }, { a: 1, options: { x: '1' } }), []);
  // The same run.json at another worker count, under another label.
  const b = await open('strict', { workers: 7, machine: 'spare-1' });
  try {
    assert.equal(b.isDone(0), true);
  } finally {
    b.close();
  }
  assert.ok(existsSync(join(dir, 'machines', 'spare-1.json')));
  assert.ok(existsSync(join(dir, 'machines', 'spare-1.log.jsonl')));
  // A stage that a running process holds is refused.
  writeFileSync(join(dir, 'lock'), `${process.ppid}\n`);
  await assert.rejects(open('strict'), new RegExp(`process ${process.ppid} is running this replay stage`));
  rmSync(join(dir, 'lock'));
}));

test('the stage\'s end refuses a wallet with no done segment and writes nothing', withHome(async () => {
  const stage = await open('missing', { wallets: shapes(['S1', 'S8', 'M1']) });
  try {
    await writeWallet(stage, 0);
    await writeWallet(stage, 2);
    await assert.rejects(stage.finish(), /the stage's end needs every wallet's segment; 1 of 3 have none, the first index 1/);
    assert.deepEqual(readdirSync(stage.dir).filter((f) => /jsonl\.gz|^done\.json$/.test(f)), []);
    assert.throws(() => stage.segment(2), /wallet 2's segment is done/);
    assert.throws(() => stage.segment(3), /no wallet 3/);
  } finally {
    stage.close();
  }
}));

test('the joined stream is the segments\' gzip members joined, decompresses to their bytes joined, and zlib.createGunzip() reads every member, an empty one among them', withHome(async () => {
  const { dir } = await whole('joined');
  const segs = (kind) => SHAPES.map((_s, i) => readFileSync(join(dir, 'segments', `${i}.${kind}.jsonl.gz`)));
  for (const kind of ['records', 'timings']) {
    const joined = readFileSync(join(dir, `${kind}.jsonl.gz`));
    assert.ok(joined.equals(Buffer.concat(segs(kind))), `${kind}: no recompression`);
    const plain = Buffer.concat(segs(kind).map((b) => gunzipSync(b)));
    assert.equal(stageText(dir, kind), plain.toString('utf8'));
    // A stream read through createGunzip, chunk by chunk.
    const chunks = [];
    for await (const c of createReadStream(join(dir, `${kind}.jsonl.gz`), { highWaterMark: 64 }).pipe(createGunzip())) chunks.push(c);
    assert.ok(Buffer.concat(chunks).equals(plain), `${kind}: createGunzip reads every member`);
    assert.deepEqual(await gunzipDigest(join(dir, `${kind}.jsonl.gz`)), { sha256: sha256(plain), bytes: plain.length, lines: plain.toString('utf8').split('\n').length - 1 });
  }
  // Wallet 2's timings segment is an empty member, in the middle.
  assert.equal(gunzipSync(segs('timings')[2]).length, 0);
}));

const ZCAT = spawnSync('zcat', ['--version']).error ? 'zcat is not installed, so the stream is not read with it' : false;

test('zcat reads every member of the joined streams', { skip: ZCAT }, withHome(async () => {
  const { dir } = await whole('zcat');
  assert.equal(execFileSync('zcat', [join(dir, 'records.jsonl.gz')]).toString('utf8'), stageText(dir));
  assert.equal(execFileSync('zcat', [join(dir, 'timings.jsonl.gz')]).toString('utf8'), stageText(dir, 'timings'));
}));

test('the machine label: letters, digits, - and _, at most 64, local by default; anything else refused by the reader and the stage', withHome(async () => {
  assert.equal(machineLabel(undefined), 'local');
  for (const ok of ['local', 'spare-1', 'laptop_2', 'A', 'x'.repeat(64)]) assert.equal(machineLabel(ok), ok);
  for (const bad of ['', 'host.example', 'a b', '192.0.2.1', 'x'.repeat(65), 'ä', 'a/b', true]) assert.throws(() => machineLabel(bad), /--machine takes a label of letters, digits, - and _/, String(bad));
  assert.equal(parseArgs(['--machine', 'spare-1'], 'replay').machine, 'spare-1');
  assert.throws(() => parseArgs(['--machine', 'spare.lan'], 'replay'), /--machine takes a label of letters, digits, - and _ \(at most 64\), not "spare.lan" for replay/);
  assert.equal(parseArgs(['--machine', 'b2'], 'study').machine, 'b2');
  assert.throws(() => parseArgs(['--machine', 'x'], 'census'), /unknown option --machine for census/);
  await assert.rejects(open('bad-label', { machine: '../x' }), /--machine takes a label/);
  assert.equal(existsSync(runDir('synthetic', 'bad-label')), false, 'a refused label writes nothing');
}));

// A minimal history file: one wallet, no UTxO and no event, which the stand-in
// pool replays without the treatment.
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

// A stand-in pool: answers each job after a delay that puts the jobs out of
// order; failAt names a wallet whose last job fails.
function standInPool({ failAt = null } = {}) {
  let started = 0;
  return {
    size: 3,
    stats: { started: 0, recycled: 0, watchdogStops: 0, machineReruns: 0 },
    async replay(job) {
      const n = started++;
      await new Promise((resolve) => setTimeout(resolve, (n * 7) % 5));
      if (job.key.wallet === failAt && job.spool.records.endsWith('/9.records.jsonl')) return { ok: false, error: 'stand-in failure', stop: false, ms: 1 };
      return { ok: true, result: spoolJob(engineResult(job.arm, job.variant, job.repetition), job), ms: 5 + (n % 3) };
    }
  };
}

test('runReplays stopped by a failed job and resumed writes the records, timing rows and totals of one uninterrupted run', withHome(async (home) => {
  const files = join(home, 'histories');
  mkdirSync(files);
  const wallets = [101, 102, 103].map((w) => ({ spec: { kind: 'history', path: historyFile(files, w), analysisFreezeTx: null } }));
  const plan = windowPlan('recent', { reps: 1 });
  const opts = { wallets, plan, roles: TEST_ROLES, validity: true };
  const header = { ...HEADER, plan: 'recent', options: { plan: 'recent', reps: '1', validity: true } };
  const run = async (runId, pool) => {
    const out = await openStage(runDir('preprod', runId), { header, wallets: walletList(wallets), workers: pool.size });
    try {
      return { totals: await runReplays(null, pool, { ...opts, out }), counts: out.counts, dir: out.dir };
    } finally {
      out.close();
    }
  };
  const ref = await run('uninterrupted', standInPool());
  await assert.rejects(run('stopped', standInPool({ failAt: 102 })), /replay failed: stand-in failure/);
  const stopped = runDir('preprod', 'stopped');
  assert.deepEqual(readdirSync(join(stopped, 'segments')).filter((f) => f.endsWith('.done.json')), ['0.done.json']);
  assert.equal(existsSync(join(stopped, 'spool')), false);
  const resumed = await run('stopped', standInPool());
  assert.deepEqual(resumed.totals, ref.totals);
  assert.deepEqual(resumed.counts, ref.counts);
  assert.deepEqual(Object.keys(ref.totals), ['wallets', 'jobs', 'refused', 'validity']);
  assert.equal(ref.totals.wallets, 3);
  assert.equal(stageText(resumed.dir), stageText(ref.dir));
  assert.equal(stageText(resumed.dir, 'timings').replace(/"ms":\d+(\.\d+)?/g, '"ms":0'), stageText(ref.dir, 'timings').replace(/"ms":\d+(\.\d+)?/g, '"ms":0'));
  assert.deepEqual(JSON.parse(readFileSync(join(resumed.dir, 'wallets.json'), 'utf8')).map((w) => w.file), ['101.recent.jsonl', '102.recent.jsonl', '103.recent.jsonl']);
  const inv = JSON.parse(readFileSync(join(resumed.dir, 'machines', 'local.json'), 'utf8')).invocations;
  assert.deepEqual(inv.map((v) => v.completed), [[0], [1, 2]]);
}));
