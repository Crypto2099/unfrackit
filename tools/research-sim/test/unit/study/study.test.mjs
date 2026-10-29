// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The study command (src/study/study.mjs) over stand-in commands
// (test/lib/study-stubs.mjs), with no database and no treatment: the stages
// of each plan in order with the options each is given, the layout, a stage
// killed half way and the run resumed, a stage that fails, and the refusals
// (an option, an input file or the code changed on resume, the plans' own
// rules, a confirmation-split wallet without the analysis-freeze
// transaction, a second invocation while one runs); the nested run ids, and
// the pools handed from battery-pools to the battery.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runStudy, PLANS, studyOptions } from '../../../src/study/study.mjs';
import { runDir, historyDir } from '../../../src/history/paths.mjs';
import { stubCommands, STUB_RECORDS } from '../../lib/study-stubs.mjs';
import { poolsOf } from '../../../src/replay/commands.mjs';
import { cmdBatteryPools } from '../../../src/history/reports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, '..', '..', 'lib', 'study-child.mjs');
const FREEZE = 'f'.repeat(64);
const MANIFEST = () => 'stand-in manifest\n';
let root;
let walletsFile;
const savedHome = process.env.RESEARCH_SIM_HOME;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'research-sim-study-'));
  process.env.RESEARCH_SIM_HOME = join(root, 'home');
  walletsFile = join(root, 'wallets.txt');
  writeFileSync(walletsFile, '1\n2\n3\n4\n');
});
after(() => {
  if (savedHome === undefined) delete process.env.RESEARCH_SIM_HOME;
  else process.env.RESEARCH_SIM_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

const preprod = (runId, extra = {}) => ({ _: [], plan: 'preprod', runId, treatment: join(root, 'treatment'), expectNetwork: 'preprod', snapshot: '100', wallets: walletsFile, repsH1: '1', reps: '1', workers: '2', ...extra });
const synthetic = (runId, extra = {}) => ({ _: [], plan: 'synthetic', runId, treatment: join(root, 'treatment'), shapes: 'S1,S8', repsH1: '2', reps: '2', oracle: true, validity: true, ...extra });
const run = (opts, stub = {}, more = {}) => runStudy(opts, { commands: stubCommands({ network: opts.plan === 'synthetic' ? 'synthetic' : opts.expectNetwork, ...stub }), manifest: MANIFEST, say: () => {}, ...more });
const logOf = (network, id) => readFileSync(join(runDir(network, id), 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const recordsOf = (network, id, stage) => readFileSync(join(runDir(network, `${id}/${stage}`), 'records.jsonl'), 'utf8');

test('the preprod plan runs its eleven stages in order, each in its own run directory with the options it needs', async () => {
  const calls = [];
  const r = await run(preprod('order'), { calls });
  assert.deepEqual(calls.map(([s]) => s), [...PLANS.preprod]);
  assert.deepEqual([...PLANS.preprod], ['history-recent', 'history-peak', 'history-snapshot', 'census', 'near-cap', 'collateral', 'fidelity', 'battery-pools', 'replay-recent', 'replay-peak', 'battery']);
  const by = new Map(calls);
  for (const s of PLANS.preprod) {
    assert.equal(by.get(s).runId, `order/${s}`);
    assert.equal(recordsOf('preprod', 'order', s).split('\n').filter(Boolean).length, STUB_RECORDS);
  }
  assert.deepEqual(['history-recent', 'history-peak', 'history-snapshot'].map((s) => by.get(s).window), ['recent', 'peak', 'snapshot']);
  for (const s of ['history-recent', 'census', 'near-cap', 'collateral']) {
    assert.equal(by.get(s).expectNetwork, 'preprod');
    assert.equal(by.get(s).snapshot, '100');
  }
  assert.equal(by.get('history-recent').wallets, walletsFile);
  // Fidelity: the recent and peak files of the exploration split and those
  // without a split; never a confirmation-split file or a snapshot file.
  const want = [];
  for (const w of ['recent', 'peak']) for (const k of [1, 3, 4]) want.push(join(historyDir('preprod', `order/history-${w}`), `${k}.${w}.jsonl`));
  assert.deepEqual(by.get('fidelity').history, want);
  assert.equal(by.get('battery-pools').historyRun, 'order/history-recent');
  assert.equal(by.get('battery-pools').network, 'preprod');
  assert.deepEqual(by.get('replay-recent').history, [historyDir('preprod', 'order/history-recent')]);
  assert.equal(by.get('replay-recent').plan, 'recent');
  assert.deepEqual(by.get('replay-peak').history, [historyDir('preprod', 'order/history-peak')]);
  assert.equal(by.get('replay-peak').plan, 'peak');
  assert.equal(by.get('replay-peak').repsH1, '1');
  assert.deepEqual(by.get('battery').history, [historyDir('preprod', 'order/history-snapshot')]);
  assert.equal(by.get('battery').pools, join(runDir('preprod', 'order/battery-pools'), 'battery-pools.json'));
  assert.equal(by.get('battery').reps, '1');
  assert.equal(by.get('battery').workers, '2');
  const header = JSON.parse(readFileSync(join(runDir('preprod', 'order'), 'study.json'), 'utf8'));
  assert.equal(header.plan, 'preprod');
  assert.deepEqual(header.stages, [...PLANS.preprod]);
  assert.equal(header.manifest, MANIFEST());
  assert.match(header.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(r.failed, false);
  const log = logOf('preprod', 'order');
  assert.deepEqual(log.map((e) => e.event), ['start', ...PLANS.preprod.flatMap(() => ['stage-start', 'stage-end']), 'end']);
  assert.ok(!existsSync(join(runDir('preprod', 'order'), 'lock')));
});

test('the synthetic plan runs both replays and the battery over the shapes, with the oracle and the validity checks', async () => {
  const calls = [];
  await run(synthetic('shapes'), { calls });
  assert.deepEqual(calls.map(([s]) => s), ['replay-recent', 'replay-peak', 'battery']);
  const by = new Map(calls);
  assert.equal(by.get('replay-recent').shapes, 'S1,S8');
  assert.equal(by.get('replay-recent').plan, 'recent');
  assert.equal(by.get('replay-peak').plan, 'peak');
  assert.equal(by.get('replay-peak').validity, true);
  assert.equal(by.get('battery').oracle, true);
  assert.equal(by.get('battery').reps, '2');
  assert.equal(by.get('battery').pools, undefined);
});

test('the corpus plan reads every sampled wallet with the analysis-freeze transaction', async () => {
  const calls = [];
  await run({ _: [], plan: 'corpus', runId: 'corpus', treatment: join(root, 'treatment'), expectNetwork: 'preprod', extractionRun: walletsFile, analysisFreezeTx: FREEZE }, { calls });
  const by = new Map(calls);
  assert.deepEqual(calls.map(([s]) => s), [...PLANS.corpus]);
  for (const s of ['history-recent', 'history-peak', 'history-snapshot']) {
    assert.equal(by.get(s).fromStudy, 'all');
    assert.equal(by.get(s).analysisFreezeTx, FREEZE);
  }
  assert.equal(by.get('census').fromStudy, true);
  assert.equal(by.get('near-cap').fromStudy, true);
  assert.equal(by.get('replay-recent').analysisFreezeTx, FREEZE);
  assert.equal(by.get('battery').analysisFreezeTx, FREEZE);
});

function runChild(opts, stub) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, JSON.stringify([opts, stub])], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('HUNG')) child.kill('SIGKILL');
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('a stage killed half way is rerun from its start on resume, and the run ends with the records of an uninterrupted one', async () => {
  await run(preprod('whole'));
  const ended = await runChild(preprod('killed'), { network: 'preprod', hang: 'replay-peak' });
  assert.equal(ended.signal, 'SIGKILL');
  const before = logOf('preprod', 'killed');
  assert.deepEqual(before.filter((e) => e.event === 'stage-end').map((e) => e.stage), PLANS.preprod.slice(0, PLANS.preprod.indexOf('replay-peak')));
  assert.equal(before[before.length - 1].event, 'stage-start');
  assert.equal(before[before.length - 1].stage, 'replay-peak');
  assert.ok(existsSync(join(runDir('preprod', 'killed/replay-peak'), 'partial')));
  assert.ok(existsSync(join(runDir('preprod', 'killed'), 'lock')), 'the killed process leaves its lock');
  const calls = [];
  await run(preprod('killed'), { calls });
  assert.deepEqual(calls.map(([s]) => s), ['replay-peak', 'battery']);
  assert.ok(!existsSync(join(runDir('preprod', 'killed/replay-peak'), 'partial')), 'the rerun stage starts from an empty directory');
  for (const s of PLANS.preprod) assert.equal(recordsOf('preprod', 'killed', s), recordsOf('preprod', 'whole', s), s);
  const log = logOf('preprod', 'killed');
  const resumed = log.slice(before.length);
  assert.deepEqual(resumed.map((e) => e.event), ['resume', ...PLANS.preprod.slice(0, 9).map(() => 'stage-skipped'), 'stage-start', 'stage-end', 'stage-start', 'stage-end', 'end']);
  assert.deepEqual(resumed[0].finished, PLANS.preprod.slice(0, 9));
  // Run again: everything is skipped.
  const again = [];
  await run(preprod('killed'), { calls: again });
  assert.equal(again.length, 0);
});

test('a stage that throws stops the run with its error logged, and a resume reruns it', async () => {
  const calls = [];
  await assert.rejects(run(synthetic('fails'), { calls, fail: 'replay-peak' }), /stage replay-peak: stand-in failure/);
  assert.deepEqual(calls.map(([s]) => s), ['replay-recent', 'replay-peak']);
  const log = logOf('synthetic', 'fails');
  assert.equal(log[log.length - 1].event, 'stage-error');
  assert.equal(log[log.length - 1].stage, 'replay-peak');
  const resumed = [];
  await run(synthetic('fails'), { calls: resumed });
  assert.deepEqual(resumed.map(([s]) => s), ['replay-peak', 'battery']);
});

test('a resume with an option, an input file or the code changed is refused, and runs nothing', async () => {
  await run(preprod('strict'));
  const calls = [];
  await assert.rejects(run(preprod('strict', { repsH1: '2' }), { calls }), /differs from its first start in --reps-h1/);
  await assert.rejects(run(preprod('strict', { workers: '4' }), { calls }), /--workers/);
  await assert.rejects(run(preprod('strict', { validity: true }), { calls }), /--validity/);
  await assert.rejects(run(preprod('strict'), { calls }, { manifest: () => 'another manifest\n' }), /the code manifest/);
  const copy = join(root, 'wallets-copy.txt');
  writeFileSync(copy, readFileSync(walletsFile));
  await assert.rejects(run(preprod('strict', { wallets: copy }), { calls }), /--wallets/);
  writeFileSync(walletsFile, '1\n2\n3\n4\n5\n');
  try {
    await assert.rejects(run(preprod('strict'), { calls }), /the wallets file/);
  } finally {
    writeFileSync(walletsFile, '1\n2\n3\n4\n');
  }
  assert.equal(calls.length, 0);
  await run(preprod('strict'), { calls });
  assert.equal(calls.length, 0, 'the same options resume, with every stage finished');
});

test('each plan refuses what it does not use, before anything is written', async () => {
  const refuse = async (opts, re) => {
    await assert.rejects(run(opts), re);
    assert.ok(!existsSync(runDir(opts.plan === 'synthetic' ? 'synthetic' : opts.expectNetwork || 'preprod', opts.runId)), `${opts.runId} wrote nothing`);
  };
  await refuse({ ...preprod('r1'), plan: 'nope' }, /--plan/);
  await refuse(preprod('r2', { expectNetwork: 'mainnet' }), /test network/);
  await refuse(preprod('r3', { snapshot: 'tip' }), /not the moving tip/);
  await refuse({ ...preprod('r4'), snapshot: undefined }, /--snapshot/);
  await refuse(preprod('r5', { fromStudy: 'all' }), /name the wallets once/);
  await refuse(preprod('r6', { shapes: 'S1' }), /does not use --shapes/);
  await refuse(synthetic('r7', { expectNetwork: 'preprod' }), /does not use --expect-network/);
  await refuse(synthetic('r8', { analysisFreezeTx: FREEZE }), /does not use --analysis-freeze-tx/);
  await refuse(synthetic('r9', { methods: 'test' }), /does not use --methods/);
  await refuse(preprod('r10', { analysisFreezeTx: 'abc' }), /64 lowercase hex/);
  await refuse(preprod('r11', { extractionRun: walletsFile }), /not both/);
  const corpus = { _: [], plan: 'corpus', treatment: join(root, 'treatment'), expectNetwork: 'mainnet', analysisFreezeTx: FREEZE };
  await refuse({ ...corpus, runId: 'r12', analysisFreezeTx: undefined }, /--analysis-freeze-tx/);
  await refuse({ ...corpus, runId: 'r13', wallets: walletsFile }, /--wallets and --wallet are for the preprod plan/);
  await refuse({ ...corpus, runId: 'r14', fromStudy: 'random' }, /--from-study is all/);
  await refuse({ ...corpus, runId: 'r15', snapshot: '100' }, /give no --snapshot/);
  await refuse({ ...corpus, runId: 'r16', expectNetwork: 'preprod' }, /--extraction-run/);
  await refuse({ ...preprod('bad/id') }, /--run-id/);
  assert.equal(studyOptions({ ...corpus, runId: 'ok' }).fromStudy, 'all');
});

test('a confirmation-split wallet without the analysis-freeze transaction stops the run at the first history stage', async () => {
  const samples = new Map([[1, { split: 'exploration', excluded: false }], [2, { split: 'confirmation', excluded: false }]]);
  const calls = [];
  await assert.rejects(run(preprod('split', { wallets: undefined, fromStudy: 'all' }), { calls, samples }), /stage history-recent: wallet 2 is in the confirmation split/);
  assert.deepEqual(calls.map(([s]) => s), ['history-recent']);
  const log = logOf('preprod', 'split');
  assert.equal(log[log.length - 1].event, 'stage-error');
  const given = [];
  await run(preprod('split-freeze', { wallets: undefined, fromStudy: 'all', analysisFreezeTx: FREEZE }), { calls: given, samples });
  assert.deepEqual(given.map(([s]) => s), [...PLANS.preprod]);
});

test('a second invocation is refused while the first runs; a lock left by a process that is gone is taken over', async () => {
  const dir = runDir('synthetic', 'locked');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'lock'), `${process.ppid}\n`);
  await assert.rejects(run(synthetic('locked')), new RegExp(`process ${process.ppid} is running`));
  writeFileSync(join(dir, 'lock'), '2147483646\n');
  const calls = [];
  await run(synthetic('locked'), { calls });
  assert.equal(calls.length, 3);
});

test('a stage\'s run id nests in the study run\'s directory, one level deep', () => {
  assert.equal(runDir('preprod', 'a/b'), join(process.env.RESEARCH_SIM_HOME, 'preprod', 'a', 'b'));
  for (const bad of ['a/b/c', 'a/..', '../a', 'a/.', '/a', 'a/', '']) assert.throws(() => runDir('preprod', bad), /bad run id/);
});

test('the battery reads the pools as battery-pools writes them, from the run whose histories it is given', async () => {
  assert.deepEqual(poolsOf({ t1Amounts: ['2000000', '5'], t5Shares: [['1', '10']] }), { t1: [2000000n, 5n], t5: [[1n, 10n]] });
  assert.deepEqual(poolsOf({ t1: ['7'], t5: [] }), { t1: [7n], t5: [] });
  assert.throws(() => poolsOf({}), /either t1Amounts and t5Shares/);
  assert.throws(() => poolsOf({ t1Amounts: [], t5Shares: [], t1: [] }), /either/);
  assert.throws(() => poolsOf({ t1Amounts: [], t5Shares: [['1', '2', 'x']] }), /units sent, units held/);
  const header = { kind: 'header', wallet: 1, frame: 'recent', split: null };
  mkdirSync(historyDir('preprod', 'pools/history-recent'), { recursive: true });
  writeFileSync(join(historyDir('preprod', 'pools/history-recent'), '1.recent.jsonl'), JSON.stringify(header) + '\n');
  const r = await cmdBatteryPools({ runId: 'pools/battery-pools', network: 'preprod', historyRun: 'pools/history-recent' });
  assert.equal(r.print.files, 1);
  const written = JSON.parse(readFileSync(join(runDir('preprod', 'pools/battery-pools'), 'battery-pools.json'), 'utf8'));
  assert.equal(written.historyRun, 'pools/history-recent');
  assert.deepEqual(poolsOf(written), { t1: [], t5: [] });
});
