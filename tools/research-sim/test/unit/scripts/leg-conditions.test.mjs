// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// scripts/leg-conditions.mjs on fixture stage directories (done.json,
// run.json, wallets.json, machine records, logs, segment done files, timing
// rows) and driver records: for each leg a met and an unmet condition, the
// conditions every leg shares, and the exit codes. No treatment.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { windowPlan, expandJobs, STUDY_ROLES } from '../../../src/arms/plan.mjs';
import { legConditions } from '../../../scripts/leg-conditions.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'leg-conditions.mjs');
const GIB = 1024 ** 3;
let root;
let seq = 0;
before(() => { root = mkdtempSync(join(tmpdir(), 'leg-conditions-')); });
after(() => rmSync(root, { recursive: true, force: true }));

const entries = windowPlan('peak', { reps: 2 });
const PER_WALLET = expandJobs(entries, { roles: STUDY_ROLES, needsCollateral: false, collateralRules: ['ledger'] }).length;

const INVOCATION = { start: '2026-11-15T10:00:00.000Z', end: '2026-11-15T10:10:00.000Z', finished: true, workers: 2, selection: null, completed: [0], cpuModel: 'AMD Ryzen 9 7845HX', node: 'v24.21.0', memoryBudgetBytes: 20 * GIB, maxJobs: 40, pool: { started: 4, recycled: 0, recycledBySize: 0, admissionWaits: 0, admissionPasses: 0, aloneRuns: 0, estimatesRaised: 0 } };

// A stage directory. wallets: the wallet count; invocations: machine entries
// by label; times: ms per job for the timing rows (a number: every job).
function stage({ wallets = 1, jobs, validityFailed = 0, ended = true, invocations = { local: [INVOCATION] }, logs = {}, times = 100, runExtra = {}, segments = {} } = {}) {
  const dir = join(root, `stage-${seq++}`);
  mkdirSync(join(dir, 'machines'), { recursive: true });
  mkdirSync(join(dir, 'segments'));
  const n = jobs ?? PER_WALLET * wallets;
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ plan: 'peak', entries, options: { shapes: 'S1', plan: 'peak', collateralRule: 'ledger', validity: true, reps: '2' }, node: 'v24.21.0', ...runExtra }, null, 2));
  writeFileSync(join(dir, 'wallets.json'), JSON.stringify(Array.from({ length: wallets }, (_, i) => ({ shape: `S${i}` }))));
  if (ended) writeFileSync(join(dir, 'done.json'), JSON.stringify({ wallets, counts: { spend: n * 2, 'wallet-arm': n }, totals: { wallets, jobs: n, validity: { txs: 100, failed: validityFailed } } }));
  for (const [label, list] of Object.entries(invocations)) {
    writeFileSync(join(dir, 'machines', `${label}.json`), JSON.stringify({ label, invocations: list }));
    writeFileSync(join(dir, 'machines', `${label}.log.jsonl`), (logs[label] || []).map((e) => JSON.stringify(e)).join('\n'));
  }
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(JSON.stringify({ kind: 'wallet-arm', wallet: 'S0', window: 'synthetic', arm: 'observed', variant: 'default', method: 'm', change: 'default', collateral: 'ledger', repetition: i + 1, times: { ms: typeof times === 'function' ? times(i) : times } }));
  writeFileSync(join(dir, 'timings.jsonl.gz'), gzipSync(rows.join('\n') + '\n'));
  for (const [i, machine] of Object.entries(segments)) if (machine !== undefined) writeFileSync(join(dir, 'segments', `${i}.done.json`), JSON.stringify({ index: Number(i), machine }));
  return dir;
}

const inv = (over = {}) => ({ ...INVOCATION, ...over, pool: { ...INVOCATION.pool, ...(over.pool || {}) } });
const unmet = (leg, dir, opts) => legConditions(leg, dir, opts).filter((c) => !c.ok).map((c) => c.name);

test('the shared conditions: a complete stage meets them, each failure is named', () => {
  assert.deepEqual(unmet('qualify', stage()), []);
  assert.deepEqual(unmet('qualify', stage({ ended: false })), ['the stage ended']);
  assert.deepEqual(unmet('qualify', stage({ validityFailed: 2 })), ['no validity failure']);
  assert.deepEqual(unmet('qualify', stage({ jobs: PER_WALLET - 1 })), ['job count as planned']);
  assert.deepEqual(unmet('qualify', stage({ wallets: 2, jobs: PER_WALLET })), ['job count as planned']);
});

test('L1 and L2 check the worker count of every invocation', () => {
  assert.deepEqual(unmet('L1', stage({ invocations: { local: [inv({ workers: 2 })] } })), []);
  assert.deepEqual(unmet('L1', stage({ invocations: { local: [inv({ workers: 4 })] } })), ['2 workers']);
  assert.deepEqual(unmet('L2', stage({ invocations: { local: [inv({ workers: 12 })] } })), []);
  assert.deepEqual(unmet('L2', stage({ invocations: { local: [inv({ workers: 12 }), inv({ workers: 6, start: '2026-11-15T11:00:00.000Z' })] } })), ['12 workers']);
});

test('L3 needs the affinity, busy burners and slower jobs', () => {
  const ref = stage({ times: 100 });
  const slow = () => stage({ invocations: { local: [inv({ workers: 6 })] }, times: 150 });
  const burners = (cpu) => Array.from({ length: 6 }, (_, i) => ({ pid: 100 + i, cpuSeconds: cpu }));
  const rec = (o = {}) => ({ leg: 'L3', affinity: '0-5', wallSeconds: 400, burners: burners(300), ...o });
  assert.deepEqual(unmet('L3', slow(), { reference: ref, record: rec() }), []);
  assert.deepEqual(unmet('L3', slow(), { reference: ref, record: rec({ affinity: '0-23' }) }), ['the replay ran on CPUs 0-5']);
  assert.deepEqual(unmet('L3', slow(), { reference: ref, record: rec({ affinity: '0,1,2,3,4,5' }) }), []);
  assert.deepEqual(unmet('L3', slow(), { reference: ref, record: rec({ burners: burners(50) }) }), ['6 burners each used a quarter of the stage\'s wall time']);
  assert.deepEqual(unmet('L3', slow(), { reference: ref, record: rec({ burners: burners(300).slice(0, 5) }) }), ['6 burners each used a quarter of the stage\'s wall time']);
  assert.deepEqual(unmet('L3', stage({ invocations: { local: [inv({ workers: 6 })] }, times: 110 }), { reference: ref, record: rec() }), ['median per-job time ratio to the reference at least 1.2']);
  assert.deepEqual(unmet('L3', slow(), { record: rec() }), ['median per-job time ratio to the reference at least 1.2']);
  assert.deepEqual(unmet('L3', slow(), { reference: ref }), ['the driver recorded the leg']);
  // the median, not the mean: a few very slow jobs do not make up for most jobs at full speed
  assert.deepEqual(unmet('L3', stage({ invocations: { local: [inv({ workers: 6 })] }, times: (i) => (i < 5 ? 100000 : 100) }), { reference: ref, record: rec() }), ['median per-job time ratio to the reference at least 1.2']);
});

test('L4 needs maxJobs 1, the 4 GiB budget, a worker per job and an admission wait', () => {
  const good = inv({ workers: 12, maxJobs: 1, memoryBudgetBytes: 4 * GIB, pool: { started: PER_WALLET + 3, admissionWaits: 5, recycledBySize: 2, aloneRuns: 1, estimatesRaised: 7 } });
  const checks = legConditions('L4', stage({ invocations: { local: [good] } }));
  assert.deepEqual(checks.filter((c) => !c.ok), []);
  assert.match(checks.at(-1).detail, /recycledBySize 2, aloneRuns 1, estimatesRaised 7/);
  assert.deepEqual(unmet('L4', stage({ invocations: { local: [{ ...good, maxJobs: 40 }] } })), ['maxJobs 1']);
  assert.deepEqual(unmet('L4', stage({ invocations: { local: [{ ...good, memoryBudgetBytes: 8 * GIB }] } })), ['a 4 GiB memory budget']);
  assert.deepEqual(unmet('L4', stage({ invocations: { local: [inv({ ...good, pool: { ...good.pool, started: 3 } })] } })), ['the pool started at least as many workers as jobs']);
  assert.deepEqual(unmet('L4', stage({ invocations: { local: [inv({ ...good, pool: { ...good.pool, admissionWaits: 0 } })] } })), ['at least one admission wait']);
  assert.deepEqual(unmet('L4', stage({ invocations: { local: [{ ...good, workers: 4 }] } })), ['12 workers']);
});

// A merged L5 stage over four wallets, shard 1/2 holding wallets 1 and 3 and
// killed after wallet 1 was done; the shard's directory and the driver record.
function l5(over = {}, rec = {}) {
  const shard = stage({
    wallets: 4,
    jobs: PER_WALLET * 4,
    ended: false,
    invocations: { 'L5-a': [inv({ workers: 4, finished: false, selection: { shard: '1/2' }, completed: [1] })], 'L5-b': [inv({ workers: 4, finished: false, completed: [3], start: '2026-11-15T10:20:00.000Z' })] },
    logs: { 'L5-b': [{ event: 'stage-resume', kept: 1, partial: [3], redo: [] }] },
    segments: { 1: 'L5-a', 3: 'L5-b', ...(over.segments || {}) }
  });
  const merged = stage({ wallets: 4, jobs: PER_WALLET * 4, invocations: { 'L5-merge': [inv({ command: 'merge-stage', workers: null })] } });
  const sh = { shard: '1/2', dir: shard, label: 'L5-a', resumeLabel: 'L5-b', kill: true, killed: true, workers: 4, workersExited: true, workerExitSeconds: 3, ...rec };
  const zero = { shard: '0/2', dir: stage({ wallets: 4, ended: false, segments: { 0: 'L5', 2: 'L5' } }), label: 'L5', kill: false };
  return { merged, record: { leg: 'L5', merge: { kept: 0, copied: 4 }, shards: [zero, sh], ...(over.record || {}) }, shard };
}

test('L5 needs the merge count and, for a killed shard, the kill and resume to have happened', () => {
  const ok = l5();
  assert.deepEqual(unmet('L5', ok.merged, { record: ok.record }), []);
  const t = (over, rec) => { const x = l5(over, rec); return unmet('L5', x.merged, { record: x.record }); };
  assert.deepEqual(t({ record: { merge: { kept: 1, copied: 2 } } }), ['the merge kept plus copied every wallet']);
  assert.deepEqual(t({}, { killed: false }), ['shard 1/2: the killed invocation did not finish']);
  assert.deepEqual(t({ segments: { 3: undefined } }), ['shard 1/2: the resume left nothing remaining', 'shard 1/2: the completed sets are disjoint and cover the shard']);
  assert.deepEqual(t({ segments: { 3: 'L5-a' } }), ['shard 1/2: the completed sets are disjoint and cover the shard']);
  assert.deepEqual(t({ segments: { 5: 'L5-b' } }), ['shard 1/2: the completed sets are disjoint and cover the shard']);
  assert.deepEqual(t({}, { workerExitSeconds: 130 }), ['shard 1/2: every worker of the killed run exited within 120 s']);
  assert.deepEqual(t({}, { workersExited: false }), ['shard 1/2: every worker of the killed run exited within 120 s']);
  assert.deepEqual(unmet('L5', ok.merged, {}), ['the driver recorded the leg']);
});

test('L5: a killed invocation that finished, and a resume with no wallet to redo', () => {
  const x = l5();
  const fin = stage({ wallets: 4, jobs: PER_WALLET * 4, ended: false, invocations: { 'L5-a': [inv({ finished: true })], 'L5-b': [inv({ finished: false })] }, logs: { 'L5-b': [{ event: 'stage-resume', partial: [], redo: [] }] }, segments: { 1: 'L5-a', 3: 'L5-b' } });
  const rec = { ...x.record, shards: [x.record.shards[0], { ...x.record.shards[1], dir: fin }] };
  assert.deepEqual(unmet('L5', x.merged, { record: rec }), ['shard 1/2: the killed invocation did not finish', 'shard 1/2: the resume\'s open entry names a wallet to redo']);
});

test('L5: a shard the probe does not kill needs only to have run to its end', () => {
  const x = l5();
  const rec = { ...x.record, shards: [x.record.shards[0], { shard: '1/2', dir: x.shard, label: 'L5-a', kill: false, note: '' }] };
  assert.deepEqual(unmet('L5', x.merged, { record: rec }), []);
  const short = { ...x.record, shards: [{ ...x.record.shards[0], dir: stage({ wallets: 4, ended: false, segments: { 0: 'L5' } }) }] };
  assert.deepEqual(unmet('L5', x.merged, { record: short }), ['shard 0/2: ran to its end']);
});

test('L6 needs another CPU model, the same Node and a byte-equal run.json', () => {
  const ref = stage({ invocations: { local: [inv({ cpuModel: 'AMD Ryzen 9 7845HX' })] } });
  const other = (o = {}, extra = {}) => stage({ invocations: { local: [inv({ cpuModel: 'Intel(R) Core(TM) i5-6500 CPU @ 3.20GHz', workers: 4, ...o })] }, ...extra });
  assert.deepEqual(unmet('L6', other(), { reference: ref }), []);
  assert.deepEqual(unmet('L6', stage({ invocations: { local: [inv({ workers: 4 })] } }), { reference: ref }), ['the CPU model differs from the reference']);
  assert.deepEqual(unmet('L6', other({ node: 'v24.20.0' }), { reference: ref }), ['the Node version equals the reference']);
  assert.deepEqual(unmet('L6', other({}, { runExtra: { node: 'v24.20.0' } }), { reference: ref }), ['run.json byte-equal to the reference']);
  assert.deepEqual(unmet('L6', other(), {}), ['a reference stage']);
});

test('L6 with more repetitions than the reference: run.json may differ in them and nothing else', () => {
  const ref = stage();
  const more = stage({ invocations: { local: [inv({ cpuModel: 'other', workers: 4 })] } });
  // the same entries and options: byte-equal, the plain case
  assert.deepEqual(unmet('L6', more, { reference: ref }), []);
  const mk = (reps, node) => stage({ invocations: { local: [inv({ cpuModel: reps === '2' ? 'AMD' : 'other', workers: 4 })] }, runExtra: { options: { shapes: 'S1', plan: 'peak', collateralRule: 'ledger', validity: true, reps }, node } });
  assert.deepEqual(unmet('L6', mk('10', 'v24.21.0'), { reference: mk('2', 'v24.21.0') }).filter((n) => n.startsWith('run.json')), []);
  assert.deepEqual(unmet('L6', mk('10', 'v24.20.0'), { reference: mk('2', 'v24.21.0') }).filter((n) => n.startsWith('run.json')), ['run.json byte-equal to the reference']);
});

test('the command line: exit 0 met, 1 condition not met, 2 unusable', () => {
  const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' });
  const ok = run('L1', stage({ invocations: { local: [inv({ workers: 2 })] } }));
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).result, 'met');
  const bad = run('L1', stage({ invocations: { local: [inv({ workers: 4 })] } }));
  assert.equal(bad.status, 1);
  assert.deepEqual(JSON.parse(bad.stdout).stages[0].unmet, ['2 workers']);
  assert.equal(run('L9', stage()).status, 2);
  assert.equal(run('L1', join(root, 'nothing')).status, 2);
  assert.equal(run('L1').status, 2);
  assert.equal(run('L1', stage(), '--bogus').status, 2);
});
