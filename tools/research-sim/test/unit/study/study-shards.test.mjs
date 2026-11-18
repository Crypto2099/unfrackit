// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The study split across machines (src/study/study.mjs) over stand-in
// commands (test/lib/study-stubs.mjs), each machine a private root of its
// own: the stages before the replays run and stop (--stop-before), their
// ends recording their outputs' digests; the run's directory copied to a
// second machine; a sharded start refused there until those stages have
// ended with their outputs as recorded (a fresh run, a changed or missing
// file, a log without digests); the second machine's input files at other
// paths, compared by content; each machine runs its shard of both replay
// stages; merge-stage joins them; and the study run again, unsharded, sees
// both replay stages as ended without running a wallet, with the records of
// an unsharded run. Also --wallet-indexes through the study, a synthetic
// plan sharded from its start, and the options' refusals.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, cpSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runStudy, PLANS, studyOptions, outputsDigest } from '../../../src/study/study.mjs';
import { runDir, historyDir } from '../../../src/history/paths.mjs';
import { walletsOf } from '../../../src/replay/commands.mjs';
import { walletList, walletsSha256 } from '../../../src/out/stage.mjs';
import { mergeStage } from '../../../src/out/merge.mjs';
import { WALLET_INDEXES_FORMAT } from '../../../src/replay/shards.mjs';
import { stubCommands } from '../../lib/study-stubs.mjs';

const MANIFEST = () => 'stand-in manifest\n';
let root;
let walletsFile;
const savedHome = process.env.RESEARCH_SIM_HOME;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'research-sim-study-shards-'));
  walletsFile = join(root, 'wallets.txt');
  writeFileSync(walletsFile, '1\n2\n3\n4\n');
});
after(() => {
  if (savedHome === undefined) delete process.env.RESEARCH_SIM_HOME;
  else process.env.RESEARCH_SIM_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

// Each machine's private root.
const home = (name) => join(root, name);
async function on(machine, fn) {
  const prev = process.env.RESEARCH_SIM_HOME;
  process.env.RESEARCH_SIM_HOME = home(machine);
  try {
    return await fn();
  } finally {
    process.env.RESEARCH_SIM_HOME = prev;
  }
}

const preprod = (runId, extra = {}) => ({ _: [], plan: 'preprod', runId, treatment: join(root, 'treatment'), expectNetwork: 'preprod', snapshot: '100', wallets: walletsFile, reps: '1', workers: '2', ...extra });
const synthetic = (runId, extra = {}) => ({ _: [], plan: 'synthetic', runId, treatment: join(root, 'treatment'), shapes: 'S1,S8,M1', reps: '2', collateralRule: 'ledger', ...extra });
const run = (opts, stub = {}) => runStudy(opts, { commands: stubCommands({ network: opts.plan === 'synthetic' ? 'synthetic' : opts.expectNetwork, ...stub }), manifest: MANIFEST, say: () => {} });
const logOf = (network, id) => readFileSync(join(runDir(network, id), 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const recordsOf = (network, id, stage) => (stage.startsWith('replay-') ? gunzipSync(readFileSync(join(runDir(network, `${id}/${stage}`), 'records.jsonl.gz'))).toString('utf8') : readFileSync(join(runDir(network, `${id}/${stage}`), 'records.jsonl'), 'utf8'));
const BEFORE_REPLAYS = PLANS.preprod.slice(0, PLANS.preprod.indexOf('replay-recent'));
const REPLAYS = ['replay-recent', 'replay-peak'];

test('a study split across two machines: the stages before the replays here, a shard on each machine, merge-stage, and the run again sees both replay stages ended with an unsharded run\'s records', async () => {
  // Machine A reaches the database: it runs the stages before the replays
  // and stops; each end records its outputs.
  const first = [];
  const r = await on('a', () => run(preprod('split', { stopBefore: 'replay-recent' }), { calls: first }));
  assert.deepEqual(first.map(([s]) => s), BEFORE_REPLAYS);
  assert.deepEqual(r.unfinished, REPLAYS);
  const logA = await on('a', () => logOf('preprod', 'split'));
  assert.deepEqual(logA.slice(-2).map((e) => e.event), ['stop', 'end']);
  assert.deepEqual([logA.at(-2).before, logA.at(-1).unfinished], ['replay-recent', REPLAYS]);
  assert.equal(logA[0].stopBefore, 'replay-recent');
  for (const e of logA.filter((x) => x.event === 'stage-end')) {
    const now = await on('a', () => outputsDigest(runDir('preprod', `split/${e.stage}`)));
    assert.deepEqual(e.outputs, now, e.stage);
    assert.ok(e.outputs.files >= 1);
  }
  const header = await on('a', () => JSON.parse(readFileSync(join(runDir('preprod', 'split'), 'study.json'), 'utf8')));
  for (const k of ['stopBefore', 'shard', 'walletIndexes', 'machine', 'workers']) assert.equal(k in header.options, false, k);

  // A sharded start where those stages have not run is refused, and writes
  // nothing.
  await on('b', async () => {
    await assert.rejects(run(preprod('split', { shard: '1/2' })), /a sharded study runs only its replay stages, and history-recent, history-peak, census, near-cap, collateral, fidelity have not ended in this run's log; run the stages before the replays where the database is reachable \(--stop-before replay-recent\)/);
    assert.equal(existsSync(runDir('preprod', 'split')), false);
  });

  // The run's directory copied to machine B. A changed or missing output,
  // or a log without the digests, is refused before anything is written.
  const copyTo = (machine) => cpSync(join(home('a'), 'preprod', 'split'), join(home(machine), 'preprod', 'split'), { recursive: true });
  copyTo('b');
  const historyFile = await on('b', () => join(historyDir('preprod', 'split/history-recent'), '2.recent.jsonl'));
  const kept = readFileSync(historyFile);
  const logB = join(home('b'), 'preprod', 'split', 'log.jsonl');
  const logText = readFileSync(logB, 'utf8');
  writeFileSync(historyFile, Buffer.concat([kept, Buffer.from('\n')]));
  await on('b', () => assert.rejects(run(preprod('split', { shard: '1/2' })), /stage history-recent's outputs in .* differ from those its end recorded \(6 files of \d+ bytes recorded, 6 files of \d+ bytes there\); copy the stage's directory again/));
  writeFileSync(historyFile, kept);
  const census = join(home('b'), 'preprod', 'split', 'census', 'records.jsonl');
  const censusText = readFileSync(census);
  rmSync(census);
  await on('b', () => assert.rejects(run(preprod('split', { shard: '1/2' })), /stage census's outputs .* \(1 files of \d+ bytes recorded, 0 files of 0 bytes there\)/));
  writeFileSync(census, censusText);
  writeFileSync(logB, logText.split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((e) => JSON.stringify({ ...e, outputs: undefined })).join('\n') + '\n');
  await on('b', () => assert.rejects(run(preprod('split', { shard: '1/2' })), /the log records no digest of stage history-recent's outputs/));
  writeFileSync(logB, logText);
  assert.equal(readFileSync(logB, 'utf8'), logText, 'the refusals wrote nothing');

  // Machine B's input files sit elsewhere. The study compares them by
  // content: a wallets file with other content is refused, naming it, and
  // copies with the same content at other paths are accepted.
  const walletsB = join(home('b'), 'wallets.txt');
  writeFileSync(walletsB, '1\n2\n');
  await on('b', () => assert.rejects(run(preprod('split', { shard: '1/2', wallets: walletsB })), /differs from its first start in the wallets file;/));
  assert.equal(readFileSync(logB, 'utf8'), logText, 'the refusal wrote nothing');
  writeFileSync(walletsB, readFileSync(walletsFile));
  const atB = { wallets: walletsB, treatment: join(home('b'), 'treatment') };

  // Each machine runs its shard of both replay stages, under its own label.
  const ranB = [];
  const callsB = [];
  await on('b', () => run(preprod('split', { shard: '1/2', machine: 'laptop', ...atB }), { ran: ranB, calls: callsB }));
  assert.deepEqual(callsB.map(([s]) => s), REPLAYS, 'no database stage runs');
  assert.deepEqual(callsB.map(([, o]) => [o.shard, o.treatment]), [['1/2', atB.treatment], ['1/2', atB.treatment]]);
  assert.deepEqual(ranB, [['replay-recent', 1], ['replay-recent', 3], ['replay-peak', 1], ['replay-peak', 3]]);
  const eventsB = await on('b', () => logOf('preprod', 'split').slice(logA.length));
  assert.deepEqual(eventsB.map((e) => e.event), ['resume', ...BEFORE_REPLAYS.map(() => 'stage-skipped'), 'collateral-rule', 'stage-start', 'stage-part', 'stage-start', 'stage-part', 'end']);
  assert.deepEqual(eventsB.at(-1).unfinished, REPLAYS);
  assert.deepEqual(eventsB.find((e) => e.event === 'stage-part').print.shard, { done: '1,3', count: 2, remaining: 2 });
  assert.equal(eventsB[0].shard, '1/2');
  const ranA = [];
  await on('a', () => run(preprod('split', { shard: '0/2', machine: 'spare' }), { ran: ranA }));
  assert.deepEqual(ranA, [['replay-recent', 0], ['replay-recent', 2], ['replay-peak', 0], ['replay-peak', 2]]);
  for (const s of REPLAYS) assert.equal(existsSync(join(home('a'), 'preprod', 'split', s, 'done.json')), false, `${s}: not ended on one shard`);

  // B's replay stages copied to A and merged into A's.
  for (const s of REPLAYS) {
    const from = join(root, 'from-b', s);
    cpSync(join(home('b'), 'preprod', 'split', s), from, { recursive: true });
    const m = await mergeStage({ into: join(home('a'), 'preprod', 'split', s), sources: [from], machine: 'spare' });
    assert.deepEqual([m.kept, m.copied], [2, 2], s);
  }

  // The study run again on A, unsharded: both replay stages have ended, and
  // no wallet runs.
  const ranAfter = [];
  const callsAfter = [];
  const done = await on('a', () => run(preprod('split'), { ran: ranAfter, calls: callsAfter }));
  assert.deepEqual(ranAfter, []);
  assert.deepEqual(callsAfter.map(([s]) => s), REPLAYS);
  assert.deepEqual(done.unfinished, []);
  assert.deepEqual(done.stages.filter((x) => x.ran).map((x) => [x.stage, x.print.ended]), [['replay-recent', true], ['replay-peak', true]]);
  const tail = await on('a', () => logOf('preprod', 'split'));
  assert.deepEqual(tail.filter((e) => e.event === 'stage-end').map((e) => e.stage), PLANS.preprod);
  assert.equal(tail.at(-1).event, 'end');
  assert.equal('unfinished' in tail.at(-1), false);
  // Run again: everything is skipped.
  const again = [];
  await on('a', () => run(preprod('split'), { calls: again }));
  assert.deepEqual(again, []);

  // The records equal an unsharded run's.
  await on('a', () => run(preprod('whole')));
  for (const s of PLANS.preprod) assert.equal(await on('a', () => recordsOf('preprod', 'split', s)), await on('a', () => recordsOf('preprod', 'whole', s)), s);
  // The machine records: each shard's, and the unsharded invocation's under
  // the default label, which found the stage ended.
  const machines = join(home('a'), 'preprod', 'split', 'replay-peak', 'machines');
  assert.deepEqual(readdirSync(machines).sort(), ['laptop.json', 'laptop.log.jsonl', 'local.json', 'local.log.jsonl', 'spare.json', 'spare.log.jsonl']);
  assert.deepEqual(readFileSync(join(machines, 'local.log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).event), ['stage-ended-earlier']);
});

test('--wallet-indexes passes through the study to both replay stages, each reading its plan\'s indexes', async () => {
  await on('c', () => run(preprod('indexed', { stopBefore: 'replay-recent' })));
  const file = join(root, 'laptop.json');
  const entry = async (w, indexes) => {
    const list = await on('c', () => walletList(walletsOf({ history: [historyDir('preprod', `indexed/history-${w}`)] }, { stream: 'synthetic' })));
    return { wallets: list.length, walletsSha256: walletsSha256(list), indexes };
  };
  writeFileSync(file, JSON.stringify({ format: WALLET_INDEXES_FORMAT, machine: 'laptop', machines: [{ label: 'spare', speed: 1 }, { label: 'laptop', speed: 0.6 }], plans: { recent: await entry('recent', [1, 2]), peak: await entry('peak', [0]) } }));
  const calls = [];
  const ran = [];
  await on('c', () => run(preprod('indexed', { walletIndexes: file, machine: 'laptop' }), { calls, ran }));
  assert.deepEqual(calls.map(([s, o]) => [s, o.walletIndexes]), [['replay-recent', file], ['replay-peak', file]]);
  assert.deepEqual(ran, [['replay-recent', 1], ['replay-recent', 2], ['replay-peak', 0]]);
  const machine = await on('c', () => JSON.parse(readFileSync(join(runDir('preprod', 'indexed/replay-recent'), 'machines', 'laptop.json'), 'utf8')));
  assert.deepEqual([machine.invocations[0].selection.walletIndexes, machine.invocations[0].selection.wallets], ['laptop.json', 2]);
});

test('a synthetic plan has no stage before its replays, so its shards start fresh on each machine; merged, the study sees them ended', async () => {
  await on('d', () => run(synthetic('syn', { shard: '0/2', machine: 'spare' })));
  await on('e', () => run(synthetic('syn', { shard: '1/2', machine: 'laptop' })));
  for (const s of REPLAYS) await mergeStage({ into: join(home('d'), 'synthetic', 'syn', s), sources: [join(home('e'), 'synthetic', 'syn', s)], machine: 'spare' });
  const ran = [];
  const r = await on('d', () => run(synthetic('syn'), { ran }));
  assert.deepEqual(ran, []);
  assert.deepEqual(r.unfinished, []);
  await on('d', () => run(synthetic('syn-whole')));
  for (const s of REPLAYS) assert.equal(await on('d', () => recordsOf('synthetic', 'syn', s)), await on('d', () => recordsOf('synthetic', 'syn-whole', s)), s);
});

test('the study refuses both forms of share, a shard that is not one and a stop stage the plan does not have, before anything is written', async () => {
  await on('f', async () => {
    const refuse = async (opts, re) => {
      await assert.rejects(run(opts), re);
      assert.equal(existsSync(runDir(opts.plan === 'synthetic' ? 'synthetic' : 'preprod', opts.runId)), false, opts.runId);
    };
    await refuse(synthetic('both', { shard: '0/2', walletIndexes: walletsFile }), /give --shard or --wallet-indexes, not both/);
    await refuse(synthetic('k-big', { shard: '2/2' }), /--shard takes k\/n, .*k is below n/);
    await refuse(synthetic('n-zero', { shard: '0/0' }), /n is at least 1/);
    await refuse(synthetic('stop-db', { stopBefore: 'census' }), /--stop-before takes a stage of the synthetic plan: replay-recent, replay-peak/);
    await refuse(preprod('stop-x', { stopBefore: 'battery' }), /--stop-before takes a stage of the preprod plan/);
    assert.equal(studyOptions(preprod('ok', { walletIndexes: 'rel.json' })).walletIndexes, join(process.cwd(), 'rel.json'));
  });
});
