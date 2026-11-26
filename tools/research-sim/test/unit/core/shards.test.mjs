// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A replay stage split between machines, with no treatment: --shard and
// --wallet-indexes read and checked (k out of range, n of 0, both forms
// given); a shard's invocation ending without the join and recording its
// share; plan-shards' packing (deterministic, every index once, the heaviest
// wallets first, the machines' speeds respected) and its files read back by
// a replay; merge-stage's refusals, each leaving the target as it was
// (another run.json, another wallet list, a damaged source segment, an
// unequal copy of an index, a missing index, machine records that disagree,
// a label only a source carries), an equal copy accepted, and two shards
// merged into the records and timing rows of an unsharded stage, the
// sources unchanged; a merged stage opened again has ended. Then runReplays
// over history files with a stand-in pool, run as two shards and merged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { record } from '../../../src/out/records.mjs';
import { openStage, walletList, walletsSha256, indexRanges, STAGE_LAYOUT } from '../../../src/out/stage.mjs';
import { mergeStage } from '../../../src/out/merge.mjs';
import { selectionOf, checkSelection, machinesOf, packShards, walletCost, WALLET_INDEXES_FORMAT } from '../../../src/replay/shards.mjs';
import { cmdPlanShards } from '../../../src/replay/commands.mjs';
import { shardOf, parseArgs } from '../../../src/options.mjs';
import { spoolJob, runReplays } from '../../../src/replay/run.mjs';
import { windowPlan, TEST_ROLES } from '../../../src/arms/plan.mjs';
import { HISTORY_FORMAT } from '../../../src/state/history.mjs';
import { paramsFromRow } from '../../../src/history/params.mjs';
import { runDir } from '../../../src/history/paths.mjs';
import { stageText, stageLog } from '../../lib/stage.mjs';

const HEADER = Object.freeze({ layout: STAGE_LAYOUT, command: 'replay', plan: 'peak', options: { plan: 'peak', reps: '1' }, node: process.version, csl: { package: 'csl', version: '17.0.0', wasm: {} }, manifest: 'stand-in manifest\n' });
const SHAPES = ['S1', 'S8', 'M1', 'CL1', 'E2'];
const shapes = (names = SHAPES) => names.map((name) => ({ spec: { kind: 'shape', name, stream: 'synthetic' } }));

function withHome(fn) {
  return async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'research-sim-shards-'));
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

// A stage over the shapes; selection from --shard or --wallet-indexes.
function open(runId, { wallets = shapes(), header = HEADER, machine, workers = 2, shard, walletIndexes, plan = 'peak' } = {}) {
  const list = walletList(wallets);
  const selection = selectionOf({ ...(shard !== undefined ? { shard } : {}), ...(walletIndexes !== undefined ? { walletIndexes } : {}) }, { plan, wallets: list });
  return openStage(runDir('synthetic', runId), { header, wallets: list, machine, workers, selection });
}

// Wallet i's stand-in records, with times; `salt` changes a record, as
// another run of an unseeded selector would.
function recordsOf(i, salt = 0) {
  const key = { wallet: SHAPES[i], window: 'synthetic', arm: 'observed', variant: 'default', method: 'test-largest-first', change: 'default', collateral: 'none-needed', repetition: 1 };
  return Array.from({ length: 3 + i }, (_x, n) => record('spend', key, { intent: n, outcome: 'built', fee: BigInt(170000 + n + salt), ms: n + i / 4 }));
}

async function writeWallet(stage, i, salt = 0) {
  const seg = stage.segment(i);
  const recs = recordsOf(i, salt);
  for (const rec of recs) seg.write(rec);
  return stage.complete(i, seg, { wallet: SHAPES[i], totals: { jobs: 1, refused: 0, triggers: 0, validity: { txs: recs.length, failed: 0 } }, start: new Date() });
}

// Runs a stage as the replay command does: its wallets, then its end.
async function runStage(runId, opts = {}, { salt = {} } = {}) {
  const stage = await open(runId, opts);
  try {
    for (let i = 0; i < stage.n; i++) if (stage.runs(i)) await writeWallet(stage, i, salt[i] || 0);
    const totals = await stage.finish();
    return { totals, counts: stage.counts, dir: stage.dir, ended: stage.ended, progress: stage.progress };
  } finally {
    stage.close();
  }
}

// Every file under dir with its bytes, to show a directory unchanged.
const snapshot = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).sort().map((f) => [f, statSync(join(dir, f)).isFile() ? readFileSync(join(dir, f)).toString('base64') : null]) : null);

test('--shard k/n: the indexes modulo n equal to k; k out of range, n of 0, and both forms given are refused', withHome(async () => {
  assert.deepEqual(shardOf('0/1'), { k: 0, n: 1 });
  assert.deepEqual(shardOf('2/3'), { k: 2, n: 3 });
  for (const [bad, re] of [['3/3', /k is below n, not 3 in 3\/3/], ['5/2', /k is below n/], ['0/0', /n is at least 1, not 0 in 0\/0/], ['1', /--shard takes k\/n/], ['-1/2', /--shard takes k\/n/], ['01/2', /--shard takes k\/n/], ['a/b', /--shard takes k\/n/], ['1/2/3', /--shard takes k\/n/]]) {
    assert.throws(() => shardOf(bad), re, bad);
    assert.throws(() => parseArgs(['--shard', bad], 'replay'), re, bad);
  }
  assert.equal(parseArgs(['--shard', '1/2'], 'replay').shard, '1/2');
  assert.equal(parseArgs(['--shard', '0/2'], 'study').shard, '0/2');
  assert.throws(() => parseArgs(['--shard', '0/2'], 'census'), /unknown option --shard for census/);
  const list = walletList(shapes([...SHAPES, 'S2', 'S3', 'S4']));
  assert.deepEqual(selectionOf({ shard: '1/3' }, { plan: 'peak', wallets: list }), { indexes: [1, 4, 7], record: { shard: '1/3', wallets: 3 } });
  assert.deepEqual(selectionOf({ shard: '0/1' }, { plan: 'peak', wallets: list }).indexes, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(selectionOf({ shard: '9/10' }, { plan: 'peak', wallets: list }).indexes, [], 'a shard beyond the wallets runs none');
  assert.equal(selectionOf({}, { plan: 'peak', wallets: list }), null);
  assert.throws(() => checkSelection({ shard: '0/2', walletIndexes: 'x.json' }), /give --shard or --wallet-indexes, not both/);
  assert.throws(() => selectionOf({ shard: '0/2', walletIndexes: 'x.json' }, { plan: 'peak', wallets: list }), /not both/);
}));

test('a shard ends without the join, noting the done indexes and how many remain, and records its share; the stage ends when every index is done', withHome(async () => {
  const ref = await runStage('shard-ref');
  const a = await runStage('shard', { shard: '0/2', machine: 'spare' });
  assert.equal(a.ended, false);
  assert.deepEqual(a.progress, { done: '0,2,4', count: 3, remaining: 2 });
  assert.deepEqual(a.totals, { wallets: 3, jobs: 3, refused: 0, triggers: 0, validity: { txs: 3 + 5 + 7, failed: 0 } });
  assert.deepEqual(readdirSync(a.dir).sort(), ['machines', 'run.json', 'segments', 'wallets.json'], 'no joined stream and no done.json');
  assert.deepEqual(readdirSync(join(a.dir, 'segments')).filter((f) => f.endsWith('.done.json')).sort(), ['0.done.json', '2.done.json', '4.done.json']);
  const part = stageLog(a.dir, 'spare').find((e) => e.event === 'stage-part');
  assert.deepEqual([part.done, part.count, part.remaining], ['0,2,4', 3, 2]);
  assert.equal(stageLog(a.dir, 'spare').some((e) => e.event === 'stage-end'), false);
  const inv = JSON.parse(readFileSync(join(a.dir, 'machines', 'spare.json'), 'utf8')).invocations;
  assert.deepEqual(inv.map((v) => [v.selection, v.completed, v.finished]), [[{ shard: '0/2', wallets: 3 }, [0, 2, 4], false]]);
  // The shard's run.json is the unsharded stage's: the share is not in it.
  assert.equal(readFileSync(join(a.dir, 'run.json'), 'utf8'), readFileSync(join(ref.dir, 'run.json'), 'utf8'));
  // The other shard in the same directory: every index is done, and the
  // stage ends as an unsharded one does.
  const b = await runStage('shard', { shard: '1/2', machine: 'laptop' });
  assert.equal(b.ended, true);
  assert.equal(b.progress, null);
  assert.deepEqual(b.totals, ref.totals);
  assert.equal(stageText(b.dir), stageText(ref.dir));
  assert.equal(stageText(b.dir, 'timings'), stageText(ref.dir, 'timings'));
  assert.deepEqual(JSON.parse(readFileSync(join(b.dir, 'machines', 'laptop.json'), 'utf8')).invocations.map((v) => [v.selection, v.completed, v.finished]), [[{ shard: '1/2', wallets: 2 }, [1, 3], true]]);
  assert.equal(indexRanges([]), 'none');
  assert.equal(indexRanges([7, 1, 2, 3, 5, 9, 10]), '1-3,5,7,9-10');
}));

test('a stage that has ended runs nothing when opened again: its totals come from done.json and no file changes but its machine record and log', withHome(async () => {
  const ref = await runStage('ended');
  const before = snapshot(join(ref.dir, 'segments'));
  const doneBefore = readFileSync(join(ref.dir, 'done.json'), 'utf8');
  const joined = readFileSync(join(ref.dir, 'records.jsonl.gz'));
  const again = await open('ended', { shard: '1/2', machine: 'again' });
  try {
    assert.equal(again.earlier !== null, true);
    assert.deepEqual(Array.from({ length: 5 }, (_x, i) => [again.isDone(i), again.runs(i)]), Array.from({ length: 5 }, () => [true, false]));
    assert.deepEqual(await again.finish(), ref.totals);
    assert.deepEqual(again.counts, ref.counts);
    assert.equal(again.ended, true);
  } finally {
    again.close();
  }
  assert.deepEqual(snapshot(join(ref.dir, 'segments')), before);
  assert.equal(readFileSync(join(ref.dir, 'done.json'), 'utf8'), doneBefore);
  assert.ok(readFileSync(join(ref.dir, 'records.jsonl.gz')).equals(joined));
  assert.deepEqual(stageLog(ref.dir, 'again').map((e) => e.event), ['stage-ended-earlier']);
  // A done.json whose joined file is gone is not an end: the stage resumes
  // and joins again.
  rmSync(join(ref.dir, 'timings.jsonl.gz'));
  const c = await open('ended');
  try {
    assert.equal(c.earlier, null);
    assert.deepEqual(await c.finish(), ref.totals);
  } finally {
    c.close();
  }
  assert.ok(existsSync(join(ref.dir, 'timings.jsonl.gz')));
}));

// History files whose cost facts differ: wallet w has utxos[w] UTxOs at the
// start and events[w] events, none needing collateral.
const PARAMS = paramsFromRow('preprod', { epoch_no: 300, protocol_major: 10, min_fee_a: 44, min_fee_b: 155381, coins_per_utxo_size: 4310, max_val_size: 5000, max_tx_size: 16384, max_collateral_inputs: 3, collateral_percent: 150, price_mem: 0.0577, price_step: 0.0000721, min_fee_ref_script_cost_per_byte: 15, key_deposit: 2000000, pool_deposit: 500000000, drep_deposit: 500000000, gov_action_deposit: 100000000000 });
function historyFile(dir, wallet, { utxos = 0, marks = 0, endUtxos = utxos } = {}) {
  const lines = [
    { kind: 'header', format: HISTORY_FORMAT, network: 'preprod', wallet, frame: 'recent', split: null, window: { first: { time: 0 }, last: { time: 1000 } }, snapshot: { block: 1, tx: 1 }, params: PARAMS, franken: [], arrival: [], latestKeyBase: null, settings: {}, source: { bytes: 'tx_cbor' } },
    { kind: 'state', at: { tx: 1 }, utxos: Array.from({ length: utxos }, (_x, k) => ({ ref: `${'a'.repeat(64)}#${k}` })) },
    ...Array.from({ length: marks }, (_x, n) => ({ kind: 'mark', n: n + 1, blockTime: 10 * (n + 1) })),
    { kind: 'end', at: { tx: 2 }, utxos: endUtxos, digest: '00', counts: { deposit: 0, 'held-consumed': 0, intent: 0, 'self-reorganization': 0, mark: marks } }
  ];
  const path = join(dir, `${wallet}.recent.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

test('the cost estimate and the packing: deterministic, greedy longest first, each machine at its speed', () => {
  // (E + 1) * J * g * sqrt(g), g = 1 + U / 1000.
  assert.equal(walletCost({ events: 9, jobs: 2, utxos: 3000 }), 10 * 2 * 4 * 2);
  assert.equal(walletCost({ events: 0, jobs: 46, utxos: 0 }), 46);
  assert.ok(walletCost({ events: 10, jobs: 1, utxos: 20000 }) / walletCost({ events: 10, jobs: 1, utxos: 3000 }) > 20000 / 3000, 'faster than linear in the UTxO count');
  // Costs 5, 9, 1, 7, 3 over two machines of one speed: 9 to a, 7 to b,
  // 5 to b, 3 to a, then 1 ties at 13 and goes to a, the machine named first.
  assert.deepEqual(packShards([5, 9, 1, 7, 3], machinesOf('a,b')), [{ label: 'a', speed: 1, indexes: [1, 2, 4], cost: 13, time: 13 }, { label: 'b', speed: 1, indexes: [0, 3], cost: 12, time: 12 }]);
  // The heaviest wallet goes first, to the fastest machine: 50 to fast (25
  // against 100), then each 1 to slow (2, 4, 6 against 25.5).
  assert.deepEqual(packShards([1, 1, 50, 1], machinesOf('slow=0.5,fast=2')).map((m) => m.indexes), [[0, 1, 3], [2]]);
  // 50 to fast (50 against 100), 30 to slow (60 against 80), 20 to fast (70
  // against 100), 1 to slow (62 against 71).
  assert.deepEqual(packShards([1, 30, 50, 20], machinesOf('slow=0.5,fast=1')).map((m) => m.indexes), [[0, 1], [2, 3]]);
  // Thirty wallets of one cost over speeds 1 and 0.5: two to one.
  const even = packShards(Array(30).fill(4), machinesOf('spare=1,laptop=0.5'));
  assert.deepEqual(even.map((m) => m.indexes.length), [20, 10]);
  assert.deepEqual(even.map((m) => m.time), [80, 80]);
  const costs = Array.from({ length: 40 }, (_x, i) => ((i * 37) % 11) + 1);
  const p = packShards(costs, machinesOf('spare=1,laptop=0.6'));
  assert.deepEqual(packShards(costs, machinesOf('spare=1,laptop=0.6')), p, 'deterministic');
  assert.deepEqual(p.flatMap((m) => m.indexes).sort((a, b) => a - b), costs.map((_c, i) => i), 'every index once');
  assert.ok(Math.abs(p[0].time - p[1].time) <= Math.max(...costs) / 0.6, 'finishing times within one wallet');
  for (const [bad, re] of [['', /--machines <label>=<speed>/], ['a=0', /a's speed is a positive number/], ['a=-1', /positive number/], ['a=x', /positive number/], ['a=1,a=2', /names a twice/], ['host.lan=1', /a machine is a label/]]) assert.throws(() => machinesOf(bad), re, bad);
  assert.deepEqual(machinesOf('spare=1,laptop=0.6,x=.5'), [{ label: 'spare', speed: 1 }, { label: 'laptop', speed: 0.6 }, { label: 'x', speed: 0.5 }]);
});

test('plan-shards writes one index file per machine, every index in exactly one, heavier wallets first; a replay reads its own and refuses one planned for other wallets', withHome(async (home) => {
  const files = join(home, 'histories');
  mkdirSync(files);
  // Wallet 104 is the heaviest by far; the others differ in UTxOs and events.
  const sizes = { 101: { utxos: 10, marks: 2 }, 102: { utxos: 400, marks: 5 }, 103: { utxos: 50, marks: 1 }, 104: { utxos: 3000, marks: 20, endUtxos: 3500 }, 105: { utxos: 900, marks: 3 }, 106: { utxos: 5, marks: 0 } };
  for (const [w, s] of Object.entries(sizes)) historyFile(files, Number(w), s);
  const opts = (out, extra = {}) => ({ plan: 'peak', reps: '1', collateralRule: 'ledger', history: files, machines: 'spare=1,laptop=0.6', out, ...extra });
  const r = await cmdPlanShards(opts(join(home, 'idx-a')));
  await cmdPlanShards(opts(join(home, 'idx-b')));
  for (const label of ['spare', 'laptop']) assert.equal(readFileSync(join(home, 'idx-a', `${label}.json`), 'utf8'), readFileSync(join(home, 'idx-b', `${label}.json`), 'utf8'), `${label}: deterministic`);
  const wallets = Object.keys(sizes).map((w) => ({ spec: { kind: 'history', path: join(files, `${w}.recent.jsonl`), analysisFreezeTx: null } }));
  const list = walletList(wallets);
  const read = (label) => JSON.parse(readFileSync(join(home, 'idx-a', `${label}.json`), 'utf8'));
  const spare = read('spare');
  const laptop = read('laptop');
  assert.equal(spare.format, WALLET_INDEXES_FORMAT);
  assert.deepEqual(spare.machines, [{ label: 'spare', speed: 1 }, { label: 'laptop', speed: 0.6 }]);
  assert.deepEqual([spare.plans.peak.wallets, spare.plans.peak.walletsSha256], [6, walletsSha256(list)]);
  assert.deepEqual([...spare.plans.peak.indexes, ...laptop.plans.peak.indexes].sort(), [0, 1, 2, 3, 4, 5], 'every index in exactly one file');
  assert.ok(spare.plans.peak.indexes.includes(3), 'the heaviest wallet first, to the fastest machine');
  assert.ok(Math.abs(spare.plans.peak.share + laptop.plans.peak.share - 1) < 1e-12);
  assert.deepEqual(r.print.machines.map((m) => [m.label, m.wallets]), [['spare', spare.plans.peak.indexes.length], ['laptop', laptop.plans.peak.indexes.length]]);
  // A replay reads its machine's indexes, and records the file.
  const sel = selectionOf({ walletIndexes: join(home, 'idx-a', 'laptop.json') }, { plan: 'peak', wallets: list });
  assert.deepEqual(sel.indexes, laptop.plans.peak.indexes);
  assert.deepEqual([sel.record.walletIndexes, sel.record.plannedFor, sel.record.wallets], ['laptop.json', 'laptop', laptop.plans.peak.indexes.length]);
  assert.match(sel.record.sha256, /^[0-9a-f]{64}$/);
  // Another plan, another wallet list, a file that is not one: refused.
  assert.throws(() => selectionOf({ walletIndexes: join(home, 'idx-a', 'laptop.json') }, { plan: 'recent', wallets: list }), /holds no indexes for the recent plan/);
  assert.throws(() => selectionOf({ walletIndexes: join(home, 'idx-a', 'laptop.json') }, { plan: 'peak', wallets: list.slice(1) }), /was planned for another wallet list \(6 wallets against this run's 5/);
  writeFileSync(join(home, 'not-one.json'), '{"plans":{}}');
  assert.throws(() => selectionOf({ walletIndexes: join(home, 'not-one.json') }, { plan: 'peak', wallets: list }), /is not a wallet index file/);
  assert.throws(() => selectionOf({ walletIndexes: join(home, 'missing.json') }, { plan: 'peak', wallets: list }), /cannot be read as a wallet index file \(ENOENT\)/);
  // A second plan joins the same files; other machines' files are refused.
  await cmdPlanShards(opts(join(home, 'idx-a'), { plan: 'recent', reps: '2' }));
  assert.deepEqual(Object.keys(read('spare').plans).sort(), ['peak', 'recent']);
  assert.deepEqual(read('spare').plans.peak, spare.plans.peak, 'the other plan\'s entry is kept');
  await assert.rejects(cmdPlanShards(opts(join(home, 'idx-a'), { machines: 'spare=1,laptop=0.5' })), /was planned for other machines/);
  await assert.rejects(cmdPlanShards(opts(join(home, 'idx-c'), { plan: 'recent', collateralRule: undefined })), /--collateral-rule ledger \| practice/);
  await assert.rejects(cmdPlanShards({ ...opts(join(home, 'idx-d')), history: undefined, shapes: 'S1' }), /--treatment <dir> loads the shapes/);
}));

test('merge-stage joins two shards into an unsharded stage\'s records and timing rows and leaves the sources as they were; an equal copy of an index is accepted', withHome(async () => {
  const ref = await runStage('m-ref');
  const a = await runStage('m-a', { shard: '0/2', machine: 'spare' });
  const b = await runStage('m-b', { shard: '1/2', machine: 'laptop' });
  const bCopy = runDir('synthetic', 'm-b-copy');
  cpSync(b.dir, bCopy, { recursive: true });
  const sources = snapshot(b.dir);
  const r = await mergeStage({ into: a.dir, sources: [b.dir, bCopy], machine: 'spare' });
  assert.deepEqual([r.wallets, r.kept, r.copied, r.duplicates, r.sources], [5, 3, 2, 2, 2]);
  assert.deepEqual(r.totals, ref.totals);
  assert.equal(stageText(a.dir), stageText(ref.dir), 'records');
  assert.equal(stageText(a.dir, 'timings'), stageText(ref.dir, 'timings'), 'timing rows');
  const done = JSON.parse(readFileSync(join(a.dir, 'done.json'), 'utf8'));
  const refDone = JSON.parse(readFileSync(join(ref.dir, 'done.json'), 'utf8'));
  for (const k of ['runSha256', 'wallets', 'counts', 'totals']) assert.deepEqual(done[k], refDone[k], k);
  for (const kind of ['records', 'timings']) assert.deepEqual({ ...done[kind], gzipBytes: 0 }, { ...refDone[kind], gzipBytes: 0 }, kind);
  assert.equal(done.machine, 'spare');
  assert.deepEqual(snapshot(b.dir), sources, 'the source is unchanged');
  assert.equal(existsSync(join(b.dir, 'lock')), false);
  // The machine records: the source's copied, the merge recorded under its
  // own label.
  assert.equal(readFileSync(join(a.dir, 'machines', 'laptop.json'), 'utf8'), readFileSync(join(b.dir, 'machines', 'laptop.json'), 'utf8'));
  const spare = JSON.parse(readFileSync(join(a.dir, 'machines', 'spare.json'), 'utf8')).invocations;
  assert.deepEqual(spare.map((v) => [v.command ?? 'replay', v.completed, v.merged ?? null, v.finished]), [['replay', [0, 2, 4], null, false], ['merge-stage', [], [1, 3], true]]);
  assert.deepEqual(stageLog(a.dir, 'spare').slice(-2).map((e) => e.event), ['stage-merge', 'stage-end']);
  assert.equal(existsSync(join(a.dir, 'lock')), false);
  // Opened again, the merged stage has ended.
  const again = await open('m-a', { machine: 'spare' });
  try {
    assert.ok(again.earlier);
    assert.deepEqual(await again.finish(), ref.totals);
  } finally {
    again.close();
  }
  // Into a new directory, from both shards.
  const fresh = join(runDir('synthetic', 'm-fresh'));
  const f = await mergeStage({ into: fresh, sources: [a.dir, b.dir], machine: 'merger' });
  assert.deepEqual([f.kept, f.copied, f.duplicates], [0, 5, 2]);
  assert.equal(stageText(fresh), stageText(ref.dir));
  assert.equal(readFileSync(join(fresh, 'run.json'), 'utf8'), readFileSync(join(ref.dir, 'run.json'), 'utf8'));
  assert.deepEqual(readdirSync(join(fresh, 'machines')).sort(), ['laptop.json', 'laptop.log.jsonl', 'merger.json', 'merger.log.jsonl', 'spare.json', 'spare.log.jsonl']);
}));

test('merge-stage refuses another run.json, another wallet list, a damaged segment, an unequal copy, a missing index and machine records that disagree, leaving the target as it was', withHome(async () => {
  const a = await runStage('r-a', { shard: '0/2', machine: 'spare' });
  const b = await runStage('r-b', { shard: '1/2', machine: 'laptop' });
  const target = snapshot(a.dir);
  const refuse = async (sources, re, { machine = 'spare', into = a.dir } = {}) => {
    const before = sources.map((s) => snapshot(s));
    await assert.rejects(mergeStage({ into, sources, machine }), re);
    assert.deepEqual(snapshot(a.dir), target, 'the target is unchanged');
    assert.deepEqual(sources.map((s) => snapshot(s)), before, 'the sources are unchanged');
  };
  // Another option, and another wallet list, name the fields.
  const other = await runStage('r-other', { shard: '1/2', machine: 'laptop', header: { ...HEADER, options: { ...HEADER.options, reps: '2' } } });
  await refuse([other.dir], /source .*r-other's run\.json differs from the target .*r-a's in --reps; only shards of one stage are merged/);
  const node = await runStage('r-node', { shard: '1/2', machine: 'laptop', header: { ...HEADER, node: 'v24.0.0' } });
  await refuse([node.dir], /differs from .* in the Node version/);
  const wl = await runStage('r-wallets', { shard: '1/2', machine: 'laptop', wallets: shapes([...SHAPES].reverse()) });
  await refuse([wl.dir], /run\.json differs from .* in the wallet list/);
  // A wallets.json that is not the one its run.json names.
  const edited = runDir('synthetic', 'r-edited');
  cpSync(b.dir, edited, { recursive: true });
  writeFileSync(join(edited, 'wallets.json'), JSON.stringify(SHAPES.map((shape) => ({ shape })), null, 1) + '\n');
  await refuse([edited], /r-edited's wallets\.json is not the one its run\.json names/);
  // A damaged segment of a source: valid gzip of other bytes, and bytes cut
  // short.
  const damaged = runDir('synthetic', 'r-damaged');
  cpSync(b.dir, damaged, { recursive: true });
  writeFileSync(join(damaged, 'segments', '3.records.jsonl.gz'), gzipSync('{"kind":"spend"}\n'));
  await refuse([damaged], /segment 3 of source .*r-damaged fails its check: its records file's decompressed bytes differ from its done file's SHA-256; nothing was copied/);
  const cut = runDir('synthetic', 'r-cut');
  cpSync(b.dir, cut, { recursive: true });
  const t = readFileSync(join(cut, 'segments', '1.timings.jsonl.gz'));
  writeFileSync(join(cut, 'segments', '1.timings.jsonl.gz'), t.subarray(0, t.length - 9));
  await refuse([cut], /segment 1 of source .*r-cut fails its check: its timings file cannot be decompressed/);
  // An index in two places with other records (an unseeded selector's
  // second run): refused, naming the index and both places.
  const second = await runStage('r-second', { walletIndexes: undefined, shard: '0/5', machine: 'other' }, { salt: { 0: 1 } });
  await refuse([b.dir, second.dir], /wallet index 0 is in the target .*r-a and source .*r-second with different records or timing rows .* keep one copy, deleting segments\/0\.records\.jsonl\.gz, 0\.timings\.jsonl\.gz and 0\.done\.json from the other, and merge again/);
  // A missing index.
  const only1 = runDir('synthetic', 'r-only1');
  cpSync(b.dir, only1, { recursive: true });
  for (const k of ['records.jsonl.gz', 'timings.jsonl.gz', 'done.json']) rmSync(join(only1, 'segments', `3.${k}`));
  await refuse([only1], /the merged stage would lack 1 of 5 wallets, the first index 3; run the shards that hold them and merge again/);
  // Machine records that disagree: both shards under one label.
  const same = await runStage('r-same', { shard: '1/2', machine: 'spare' });
  await refuse([same.dir], /the machine record spare\.json is in the target .*r-a and source .*r-same with different contents; each machine writes under a label of its own/);
  // A merge under a label that only a source carries.
  await refuse([b.dir], /the label laptop names a source's machine record; merge under this machine's own label/, { machine: 'laptop' });
  // A target that is no stage, a source that is no stage or is running.
  const junk = runDir('synthetic', 'r-junk');
  mkdirSync(junk, { recursive: true });
  writeFileSync(join(junk, 'notes'), 'x');
  await assert.rejects(mergeStage({ into: junk, sources: [b.dir] }), /holds files but no run\.json/);
  await refuse([runDir('synthetic', 'r-none')], /source .*r-none does not exist/);
  writeFileSync(join(b.dir, 'lock'), `${process.ppid}\n`);
  await refuse([b.dir], new RegExp(`process ${process.ppid} is writing source`));
  rmSync(join(b.dir, 'lock'));
  await refuse([a.dir], /is the target and a source/);
  await refuse([b.dir, b.dir], /a source is named twice/);
  await assert.rejects(mergeStage({ into: a.dir, sources: [] }), /name the source stage directories/);
  // And the merge that is accepted.
  await mergeStage({ into: a.dir, sources: [b.dir], machine: 'spare' });
  assert.ok(existsSync(join(a.dir, 'done.json')));
}));

test('merge-stage on the command line: sources as words after the options', withHome(async () => {
  const opts = parseArgs(['--into', '/x/target', '/y/a', '--machine', 'spare', '/z/b'], 'merge-stage');
  assert.deepEqual(opts, { _: ['/y/a', '/z/b'], into: '/x/target', machine: 'spare' });
  assert.throws(() => parseArgs(['--into', 'x', '--shard', '0/2'], 'merge-stage'), /unknown option --shard for merge-stage/);
  assert.throws(() => parseArgs(['stray'], 'replay'), /unexpected argument "stray" for replay/);
}));

// A stand-in pool: answers each job after a delay that puts the jobs out of
// order, with a minimal engine result.
function standInPool() {
  let started = 0;
  return {
    size: 3,
    stats: { started: 0, recycled: 0, watchdogStops: 0, machineReruns: 0 },
    async replay(job) {
      const n = started++;
      await new Promise((resolve) => setTimeout(resolve, (n * 7) % 5));
      const x = {
        plans: [{ at: 'start', t: 0, txs: 1, fee: 170000n + BigInt(job.repetition), notes: [], control: null, trigger: false }],
        spends: [{ intent: 0, type: 'T1', t: 10, burst: null, outcome: 'built', fee: 170000n, ms: 2.5 }],
        bursts: [],
        triggers: [],
        summary: { counts: { intents: 1 }, fees: { spends: 170000n }, ms: 3 },
        method: { name: 'test-largest-first', version: 'test-1', deterministic: true }
      };
      return { ok: true, result: spoolJob(x, job), ms: 5 + (n % 3) };
    }
  };
}

test('runReplays as two shards in two directories, merged, writes the records and totals of one unsharded run', withHome(async (home) => {
  const files = join(home, 'histories');
  mkdirSync(files);
  const wallets = [201, 202, 203, 204, 205].map((w) => ({ spec: { kind: 'history', path: historyFile(files, w), analysisFreezeTx: null } }));
  const list = walletList(wallets);
  const plan = windowPlan('peak', { reps: 1 });
  const header = { ...HEADER, plan: 'peak' };
  const run = async (runId, opts = {}) => {
    const pool = standInPool();
    const out = await openStage(runDir('preprod', runId), { header, wallets: list, workers: pool.size, machine: opts.machine, selection: selectionOf(opts, { plan: 'peak', wallets: list }) });
    try {
      const totals = await runReplays(null, pool, { wallets, plan, roles: TEST_ROLES, out });
      return { totals, ended: out.ended, progress: out.progress, dir: out.dir };
    } finally {
      out.close();
    }
  };
  const ref = await run('whole');
  const a = await run('half-a', { shard: '0/2', machine: 'spare' });
  const b = await run('half-b', { shard: '1/2', machine: 'laptop' });
  assert.deepEqual([a.ended, a.progress, a.totals.wallets], [false, { done: '0,2,4', count: 3, remaining: 2 }, 3]);
  assert.deepEqual([b.ended, b.progress, b.totals.wallets], [false, { done: '1,3', count: 2, remaining: 3 }, 2]);
  assert.equal(a.totals.jobs + b.totals.jobs, ref.totals.jobs);
  const m = await mergeStage({ into: a.dir, sources: [b.dir], machine: 'spare' });
  assert.deepEqual(m.totals, ref.totals);
  assert.equal(stageText(a.dir), stageText(ref.dir));
  const plain = (t) => t.replace(/"ms":\d+(\.\d+)?/g, '"ms":0');
  assert.equal(plain(stageText(a.dir, 'timings')), plain(stageText(ref.dir, 'timings')));
}));
