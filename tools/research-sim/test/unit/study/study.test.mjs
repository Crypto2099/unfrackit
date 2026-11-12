// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The study command (src/study/study.mjs) over stand-in commands
// (test/lib/study-stubs.mjs), with no database and no treatment: the stages
// of each plan in order with the options each is given, the layout, a replay
// stage killed half way and resumed at the wallets it had not done, a stage
// that fails, a resume with other worker counts and another machine label,
// and the refusals (an option, an input file or the code changed on resume,
// a machine label that is not one, the plans' own
// rules, a confirmation-split wallet without the analysis-freeze
// transaction, a second invocation while one runs); the nested run ids, and
// the collateral rule read from the collateral stage's report (and refused
// when the measurement picks none), and the battery-pools command's output.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
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

const preprod = (runId, extra = {}) => ({ _: [], plan: 'preprod', runId, treatment: join(root, 'treatment'), expectNetwork: 'preprod', snapshot: '100', wallets: walletsFile, reps: '1', workers: '2', ...extra });
const synthetic = (runId, extra = {}) => ({ _: [], plan: 'synthetic', runId, treatment: join(root, 'treatment'), shapes: 'S1,S8', reps: '2', collateralRule: 'ledger', ...extra });
const run = (opts, stub = {}, more = {}) => runStudy(opts, { commands: stubCommands({ network: opts.plan === 'synthetic' ? 'synthetic' : opts.expectNetwork, ...stub }), manifest: MANIFEST, say: () => {}, ...more });
const logOf = (network, id) => readFileSync(join(runDir(network, id), 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
// A stage's records; a replay stage's are its joined gzip stream.
const recordsOf = (network, id, stage) => (stage.startsWith('replay-') ? gunzipSync(readFileSync(join(runDir(network, `${id}/${stage}`), 'records.jsonl.gz'))).toString('utf8') : readFileSync(join(runDir(network, `${id}/${stage}`), 'records.jsonl'), 'utf8'));
// The stand-in history stage's wallets per window, each a replay wallet.
const WALLETS = 4;

test('the preprod plan runs its eight stages in order, each in its own run directory with the options it needs', async () => {
  const calls = [];
  const r = await run(preprod('order'), { calls });
  assert.deepEqual(calls.map(([s]) => s), [...PLANS.preprod]);
  assert.deepEqual([...PLANS.preprod], ['history-recent', 'history-peak', 'census', 'near-cap', 'collateral', 'fidelity', 'replay-recent', 'replay-peak']);
  assert.deepEqual([...PLANS.corpus], [...PLANS.preprod]);
  assert.deepEqual([...PLANS.synthetic], ['replay-recent', 'replay-peak']);
  for (const gone of ['battery', 'battery-pools', 'history-snapshot']) assert.ok(![...PLANS.preprod, ...PLANS.corpus, ...PLANS.synthetic].includes(gone), gone);
  const by = new Map(calls);
  for (const s of PLANS.preprod) {
    assert.equal(by.get(s).runId, `order/${s}`);
    assert.equal(recordsOf('preprod', 'order', s).split('\n').filter(Boolean).length, s.startsWith('replay-') ? WALLETS * STUB_RECORDS : STUB_RECORDS);
  }
  assert.deepEqual(['history-recent', 'history-peak'].map((s) => by.get(s).window), ['recent', 'peak']);
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
  assert.deepEqual(by.get('replay-recent').history, [historyDir('preprod', 'order/history-recent')]);
  assert.equal(by.get('replay-recent').plan, 'recent');
  assert.deepEqual(by.get('replay-peak').history, [historyDir('preprod', 'order/history-peak')]);
  assert.equal(by.get('replay-peak').plan, 'peak');
  for (const s of ['replay-recent', 'replay-peak']) {
    // The collateral stand-in's share is 0.75: practice, for every job, and
    // validity checks on every job.
    assert.deepEqual([by.get(s).reps, by.get(s).workers, by.get(s).collateralRule, by.get(s).validity], ['1', '2', 'practice', true], s);
    assert.equal(by.get(s).repsH1, undefined);
  }
  const header = JSON.parse(readFileSync(join(runDir('preprod', 'order'), 'study.json'), 'utf8'));
  assert.equal(header.plan, 'preprod');
  assert.deepEqual(header.stages, [...PLANS.preprod]);
  assert.equal(header.manifest, MANIFEST());
  assert.match(header.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(header.collateralRule.rule, 'practice');
  assert.equal(header.collateralRule.shareUnder20Ada, 0.75);
  assert.match(header.collateralRule.source, /collateral stage/);
  assert.equal(r.failed, false);
  const log = logOf('preprod', 'order');
  assert.deepEqual(log.map((e) => e.event), ['start', ...PLANS.preprod.flatMap((s) => (s === 'replay-recent' ? ['collateral-rule'] : []).concat(['stage-start', 'stage-end'])), 'end']);
  assert.equal(log.find((e) => e.event === 'collateral-rule').rule, 'practice');
  assert.ok(!existsSync(join(runDir('preprod', 'order'), 'lock')));
});

test('the synthetic plan runs both replays over the shapes under the given collateral rule, with the validity checks', async () => {
  const calls = [];
  await run(synthetic('shapes'), { calls });
  assert.deepEqual(calls.map(([s]) => s), ['replay-recent', 'replay-peak']);
  const by = new Map(calls);
  assert.equal(by.get('replay-recent').shapes, 'S1,S8');
  assert.equal(by.get('replay-recent').plan, 'recent');
  assert.equal(by.get('replay-peak').plan, 'peak');
  assert.deepEqual([by.get('replay-peak').validity, by.get('replay-peak').reps, by.get('replay-peak').collateralRule], [true, '2', 'ledger']);
  const header = JSON.parse(readFileSync(join(runDir('synthetic', 'shapes'), 'study.json'), 'utf8'));
  assert.deepEqual(header.collateralRule, { rule: 'ledger', source: '--collateral-rule' });
  assert.equal(header.options.collateralRule, 'ledger');
});

test('the collateral rule is the measurement\'s pick: practice above one half under 20 ADA, ledger otherwise, none when nothing was measured', async () => {
  for (const [share, rule] of [[0.5, 'ledger'], [0.5001, 'practice'], [0, 'ledger'], [1, 'practice']]) {
    const calls = [];
    await run(preprod(`rule-${String(share).replace('.', '_')}`), { calls, share });
    assert.ok(calls.filter(([s]) => s.startsWith('replay-')).every(([, o]) => o.collateralRule === rule), `${share}`);
  }
  const calls = [];
  await assert.rejects(run(preprod('rule-none'), { calls, share: null }), /picks no rule/);
  assert.deepEqual(calls.map(([s]) => s), PLANS.preprod.slice(0, PLANS.preprod.indexOf('replay-recent')));
  const log = logOf('preprod', 'rule-none');
  assert.equal(log[log.length - 1].event, 'stage-error');
  assert.equal(log[log.length - 1].stage, 'replay-recent');
  const header = JSON.parse(readFileSync(join(runDir('preprod', 'rule-none'), 'study.json'), 'utf8'));
  assert.equal(header.collateralRule.rule, null);
  // The synthetic plan takes no measurement: the rule is required.
  await assert.rejects(run({ ...synthetic('rule-req'), collateralRule: undefined }), /--collateral-rule ledger \| practice/);
  await assert.rejects(run(synthetic('rule-bad', { collateralRule: 'ledger-minimum' })), /--collateral-rule ledger \| practice/);
  await assert.rejects(run(preprod('rule-db', { collateralRule: 'ledger' })), /does not use --collateral-rule/);
});

test('the corpus plan reads every sampled wallet with the analysis-freeze transaction', async () => {
  const calls = [];
  await run({ _: [], plan: 'corpus', runId: 'corpus', treatment: join(root, 'treatment'), expectNetwork: 'preprod', extractionRun: walletsFile, analysisFreezeTx: FREEZE }, { calls });
  const by = new Map(calls);
  assert.deepEqual(calls.map(([s]) => s), [...PLANS.corpus]);
  for (const s of ['history-recent', 'history-peak']) {
    assert.equal(by.get(s).fromStudy, 'all');
    assert.equal(by.get(s).analysisFreezeTx, FREEZE);
  }
  assert.equal(by.get('census').fromStudy, true);
  assert.equal(by.get('near-cap').fromStudy, true);
  assert.equal(by.get('replay-recent').analysisFreezeTx, FREEZE);
  assert.equal(by.get('replay-peak').analysisFreezeTx, FREEZE);
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

test('a replay stage killed half way resumes at the wallets it had not done, and the run ends with the records of an uninterrupted one', async () => {
  await run(preprod('whole'));
  const ended = await runChild(preprod('killed'), { network: 'preprod', hang: 'replay-peak' });
  assert.equal(ended.signal, 'SIGKILL');
  const before = logOf('preprod', 'killed');
  assert.deepEqual(before.filter((e) => e.event === 'stage-end').map((e) => e.stage), PLANS.preprod.slice(0, PLANS.preprod.indexOf('replay-peak')));
  assert.equal(before[before.length - 1].event, 'stage-start');
  assert.equal(before[before.length - 1].stage, 'replay-peak');
  const stage = runDir('preprod', 'killed/replay-peak');
  // Two wallets done, the third's records half written to its spool.
  assert.deepEqual(readdirSync(join(stage, 'segments')).filter((f) => f.endsWith('.done.json')).sort(), ['0.done.json', '1.done.json']);
  assert.ok(existsSync(join(stage, 'spool', '2', 'records.jsonl')));
  const doneBefore = ['0', '1'].map((i) => readFileSync(join(stage, 'segments', `${i}.done.json`), 'utf8'));
  assert.ok(existsSync(join(runDir('preprod', 'killed'), 'lock')), 'the killed process leaves its lock');
  assert.ok(existsSync(join(stage, 'lock')), 'and the stage\'s');
  const calls = [];
  const ran = [];
  await run(preprod('killed'), { calls, ran });
  assert.deepEqual(calls.map(([s]) => s), ['replay-peak']);
  assert.deepEqual(ran, [['replay-peak', 2], ['replay-peak', 3]], 'the stage resumes at the wallets it had not done');
  assert.deepEqual(['0', '1'].map((i) => readFileSync(join(stage, 'segments', `${i}.done.json`), 'utf8')), doneBefore, 'the done wallets\' segments are kept');
  assert.ok(!existsSync(join(stage, 'spool')), 'the partial wallet\'s spool is removed');
  for (const s of PLANS.preprod) assert.equal(recordsOf('preprod', 'killed', s), recordsOf('preprod', 'whole', s), s);
  const log = logOf('preprod', 'killed');
  const resumed = log.slice(before.length);
  assert.deepEqual(resumed.map((e) => e.event), ['resume', ...PLANS.preprod.slice(0, 7).map(() => 'stage-skipped'), 'collateral-rule', 'stage-start', 'stage-end', 'end']);
  assert.deepEqual(resumed[0].finished, PLANS.preprod.slice(0, 7));
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
  assert.deepEqual(resumed.map(([s]) => s), ['replay-peak']);
});

test('a resume with an option, an input file or the code changed is refused, and runs nothing', async () => {
  await run(preprod('strict'));
  const calls = [];
  await assert.rejects(run(preprod('strict', { reps: '2' }), { calls }), /differs from its first start in --reps/);
  await assert.rejects(run(preprod('strict', { validity: true }), { calls }), /does not use --validity/);
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

test('a resume may use another worker count: it changes no record, and the log records each invocation\'s with its machine', async () => {
  const calls = [];
  await assert.rejects(run(synthetic('elastic', { workers: '2' }), { calls, fail: 'replay-peak' }), /stand-in failure/);
  const resumed = [];
  await run(synthetic('elastic', { workers: '6' }), { calls: resumed });
  assert.deepEqual(resumed.map(([s]) => s), ['replay-peak']);
  const by = new Map(resumed);
  assert.equal(by.get('replay-peak').workers, '6');
  assert.equal(recordsOf('synthetic', 'elastic', 'replay-peak').length > 0, true);
  const log = logOf('synthetic', 'elastic');
  const starts = log.filter((e) => e.event === 'start' || e.event === 'resume');
  assert.deepEqual(starts.map((e) => [e.event, e.machine.workers, e.machine.node]), [['start', 2, process.version], ['resume', 6, process.version]]);
  assert.ok(starts.every((e) => Number.isSafeInteger(e.machine.logicalCores) && e.machine.totalMemoryBytes > 0));
  // The header holds the options that decide the records, and not the
  // worker count.
  const header = JSON.parse(readFileSync(join(runDir('synthetic', 'elastic'), 'study.json'), 'utf8'));
  assert.equal('workers' in header.options, false);
  assert.equal(header.options.reps, '2');
});

test('the machine label passes to the replay stages, is not in the header, and may change on resume; a label that is not one is refused', async () => {
  const calls = [];
  await assert.rejects(run(synthetic('labelled', { machine: 'spare-1' }), { calls, fail: 'replay-peak' }), /stand-in failure/);
  const by = new Map(calls);
  assert.equal(by.get('replay-recent').machine, 'spare-1');
  assert.ok(existsSync(join(runDir('synthetic', 'labelled/replay-recent'), 'machines', 'spare-1.json')));
  const header = JSON.parse(readFileSync(join(runDir('synthetic', 'labelled'), 'study.json'), 'utf8'));
  assert.equal('machine' in header.options, false);
  const resumed = [];
  await run(synthetic('labelled', { machine: 'laptop_2' }), { calls: resumed });
  assert.deepEqual(resumed.map(([s]) => s), ['replay-peak']);
  assert.equal(new Map(resumed).get('replay-peak').machine, 'laptop_2');
  const starts = logOf('synthetic', 'labelled').filter((e) => e.event === 'start' || e.event === 'resume');
  assert.deepEqual(starts.map((e) => e.machineLabel), ['spare-1', 'laptop_2']);
  const plain = [];
  await run(synthetic('unlabelled'), { calls: plain });
  assert.equal(new Map(plain).get('replay-recent').machine, undefined, 'the replay takes its default, local');
  assert.ok(existsSync(join(runDir('synthetic', 'unlabelled/replay-recent'), 'machines', 'local.json')));
  for (const bad of ['', 'host.example', 'a b', '192.0.2.1', 'x'.repeat(65), 'ä']) {
    await assert.rejects(run(synthetic(`bad-label-${bad.length}`, { machine: bad })), /--machine takes a label of letters, digits, - and _/, JSON.stringify(bad));
  }
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
  // Worker counts are positive whole numbers, with no cap; the time limits
  // and the oracle's wall-clock limit are gone. Before any stage.
  await refuse(synthetic('r19', { workers: 'many' }), /--workers takes a positive whole number/);
  await refuse(synthetic('r18', { oracleWorkers: '1' }), /does not use --oracle-workers/);
  await refuse(synthetic('r23', { oracle: true }), /does not use --oracle/);
  await refuse(synthetic('r24', { repsH1: '2' }), /does not use --reps-h1/);
  await refuse(synthetic('r20', { oracleLimitMs: '60000' }), /does not use --oracle-limit-ms/);
  await refuse(synthetic('r21', { limitMs: '300000' }), /does not use --limit-ms/);
  await refuse(synthetic('r22', { answerLimitMs: '60000' }), /does not use --answer-limit-ms/);
  assert.equal(studyOptions(synthetic('ok12', { workers: '48' })).workers, '48');
  assert.equal(studyOptions(synthetic('ok13', { workers: '64' })).workers, '64');
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
  assert.equal(calls.length, 2);
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
