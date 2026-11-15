// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The analyze command on studies written by test/lib/analysis-fixtures.mjs:
// its outputs, refusals, splits, windows, sensitivity re-runs and sizing, and
// that two runs at any worker count write the same bytes.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cmdAnalyze, canonicalJson, SENSITIVITY } from '../../../src/analysis/command.mjs';
import { AnalysisRefusal } from '../../../src/analysis/read.mjs';
import { parseArgs } from '../../../src/options.mjs';
import { writeStudy, fullJobs, built, failed, TX, DEFAULT_DRAW } from '../../lib/analysis-fixtures.mjs';

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'analysis-cmd-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const refusal = (re) => (e) => e instanceof AnalysisRefusal && re.test(e.message);
const SMALL = { resamples: 60, sizingSamples: 4, sizingResamples: 20, quiet: true };
const read = (dir, f) => readFileSync(join(dir, f), 'utf8');

// Wallet i's spends: eight intents, each arm a different fee, the L/own arm fails
// intent 7 and the rule's off arm pays more than on.
const make = (i) => (m, arm, rep) => {
  const base = 200000 + 1000 * (i % 7);
  const fee = arm === 'own' ? base : arm === 'layout' ? base - 20000 : arm === 'on' ? base - 40000 : base - 30000;
  const out = [];
  for (let k = 0; k < 8; k++) {
    if (k === 7 && arm === 'own') out.push(failed(k, 'change-minimum', 'kit: change-minimum: low'));
    else out.push(built(k, { fee: fee + rep, ms: 5 + k, spendable: 3 + k, type: k % 2 ? 'T1' : 'T2' }));
  }
  return out;
};

// Pilot wallets (exploration) and sampled wallets (confirmation) over the groups.
function wallets(split, base, n) {
  const groups = ['B1', 'B1', 'B1', 'B2', 'B2', 'B3', 'B0', 'B0', 'B0', 'B0'];
  return Array.from({ length: n }, (_, i) => ({ id: base + i, split, group: groups[i % groups.length], capped: i === 1, flags: { fragmented: i % 2 === 0, franken_any: i === 2, franken_no_cospend: i === 3, prior_treated: i % 5 === 0 }, intents: Array.from({ length: 8 }, () => ({})), jobs: fullJobs(make(i), { reps: 2 }) }));
}

const census = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => ({ wallet: 9000 + i, utxos: i, tokenUtxos: i % 3, largestValueBytes: 100 * i, nearCap50: false, nearCap80: i === 12, nearCap90: false, lockedAda: String(i * 1000000), excessAda: String(i * 10), coin: String(i * 5000000) }));
const MACHINES = [{ label: 'rig-a', invocations: [{ start: '2026-11-01T00:00:00Z', end: '2026-11-01T01:00:00Z', workers: 4, cpuModel: 'Test CPU', logicalCores: 8, totalMemoryBytes: 1000, completed: [0, 1, 2] }], log: [{ event: 'watchdog stop' }] }];

// A corpus study of both windows holding pilot and sampled wallets.
function study({ freeze = TX, draw = DEFAULT_DRAW, pilotN = 12, sampleN = 14, peak = true, carried = true, machines = MACHINES } = {}) {
  const root = tmp();
  const all = [...wallets('exploration', 7000100, pilotN), ...wallets('confirmation', 7000300, sampleN)];
  for (const window of peak ? ['recent', 'peak'] : ['recent']) writeStudy(root, { window, draw, analysisFreezeTx: freeze, wallets: all, census: window === 'recent' ? census : undefined, carried: window === 'recent' && carried ? true : undefined, machines });
  return { root, all };
}
const opts = (root, over = {}) => ({ network: 'preprod', study: 'st', split: 'exploration', analysisFreezeTx: TX, root, out: join(tmp(), 'out'), ...SMALL, ...over });
const files = (dir) => readdirSync(dir).sort();
const bytes = (dir) => Object.fromEntries(files(dir).map((f) => [f, readFileSync(join(dir, f))]));

test('the exploration run: every output written, private, with the split named and the sizing computed', async () => {
  const { root } = study();
  const o = opts(root);
  const r = await cmdAnalyze(o);
  assert.deepEqual(files(o.out), ['inputs.json', 'results.json', 'sizing.json', 'timings.json', 'verdicts.json', 'verdicts.md']);
  for (const f of files(o.out)) assert.equal(statSync(join(o.out, f)).mode & 0o777, 0o600);
  assert.equal(statSync(o.out).mode & 0o777, 0o700);
  assert.equal(r.print.wallets, 12);
  const md = read(o.out, 'verdicts.md');
  assert.match(md, /^# Verdicts\n\nComputed on the exploration split \(the pilot\) of the study, 12 wallets in the recent window\./);
  const res = JSON.parse(read(o.out, 'results.json'));
  assert.equal(res.split, 'exploration');
  assert.equal(res.libraries.length, 23);
  assert.ok(res.peak && res.peak.questions && res.peak.items);
  assert.equal(res.flow.recent.stage.kept, 12);
  assert.equal(res.flow.recent.stage.otherSplit, 14);
  assert.equal(res.flow.peak.stage.kept, 12);
  // The sizing's targets are the sample's A_k of the draw (B1 20, B2 5, B3 2, B0 10) times the pilot's share entering each cell.
  const sz = JSON.parse(read(o.out, 'sizing.json'));
  const c = sz.cells.find((x) => x.name === 'sizing/q1/failures/csl-lf/layout-vs-own');
  assert.equal(c.targets.B1.sample, 20);
  assert.equal(c.targets.B3.sample, 2);
  assert.equal(c.targets.B1.target, Math.floor((2 * 20 * c.targets.B1.entering + c.targets.B1.total) / (2 * c.targets.B1.total)));
  assert.equal(JSON.parse(read(o.out, 'verdicts.json')).questions.q1.answer !== undefined, true);
});

test('two runs and any worker count write byte-identical outputs', async () => {
  const { root } = study({ pilotN: 10, sampleN: 0 });
  const a = opts(root, { workers: 1 });
  const b = opts(root, { workers: 4 });
  const c = opts(root, { workers: 1 });
  await cmdAnalyze(a);
  await cmdAnalyze(b);
  await cmdAnalyze(c);
  const x = bytes(a.out);
  for (const f of Object.keys(x)) {
    assert.ok(x[f].equals(bytes(b.out)[f]), `${f} differs at 4 workers`);
    assert.ok(x[f].equals(bytes(c.out)[f]), `${f} differs on a second run`);
  }
});

test('no output but timings.json carries a host fact or a time, and none carries a wallet id', async () => {
  const { root, all } = study();
  const o = opts(root);
  await cmdAnalyze(o);
  const ids = all.map((w) => String(w.id));
  for (const f of files(o.out)) {
    const text = read(o.out, f);
    for (const id of ids) assert.ok(!text.includes(id), `${f} holds the wallet id ${id}`);
    for (const id of ['9001', '9012']) assert.ok(!new RegExp(`"wallet"\\s*:\\s*${id}`).test(text), `${f} holds a census wallet`);
    if (f === 'timings.json') continue;
    for (const fact of ['Test CPU', 'logicalCores', 'cpuModel', 'rig-a', '2026-11-01', 'memoryBudget', 'watchdogStops']) assert.ok(!text.includes(fact), `${f} holds ${fact}`);
    assert.ok(!/"ms"\s*:/.test(text), `${f} holds a time`);
    assert.ok(!text.includes(root), `${f} holds the study's path`);
  }
  const t = JSON.parse(read(o.out, 'timings.json'));
  assert.equal(t.windows.recent.machines[0].label, 'rig-a');
  assert.equal(t.windows.recent.machines[0].watchdogStops, 1);
  assert.equal(t.windows.recent.machines[0].invocations[0].cpuModel, 'Test CPU');
  assert.equal(t.windows.recent.machines[0].invocations[0].start, undefined);
  // 12 wallets x 48 arms-and-repetitions of 8 spends, a time on each built spend.
  assert.ok(t.windows.recent.timings.rows > 1000);
  assert.ok(t.windows.recent.timings.byArm['csl-lf/own'].n > 0);
  assert.ok(!('workers' in JSON.parse(read(o.out, 'inputs.json')).options));
});

test('the confirmation run reads the sampled wallets only and computes no sizing', async () => {
  const { root } = study();
  const o = opts(root, { split: 'confirmation' });
  await cmdAnalyze(o);
  assert.ok(!files(o.out).includes('sizing.json'));
  const res = JSON.parse(read(o.out, 'results.json'));
  assert.equal(res.split, 'confirmation');
  assert.equal(res.flow.recent.stage.kept, 14);
  assert.equal(res.flow.recent.stage.otherSplit, 12);
  assert.match(read(o.out, 'verdicts.md'), /Computed on the confirmation split of the study, 14 wallets/);
  // Every wallet is weighed by the sample's groups: B1 40/20 = 2.
  assert.deepEqual(res.flow.recent.draw.groups.B1, { quota: 50, nDrawn: 40, nTaken: 20 });
});

test('the peak window is computed with its own cell names, and the census keeps every eligible wallet', async () => {
  const { root } = study();
  const o = opts(root);
  await cmdAnalyze(o);
  const res = JSON.parse(read(o.out, 'results.json'));
  const names = (r) => new Set(r.questions.cells.map((c) => c.name));
  assert.ok([...names(res.peak)].every((n) => n.endsWith('/peak')));
  assert.ok([...names(res.recent)].every((n) => !n.endsWith('/peak')));
  assert.equal(res.peak.h7.arms[0].shares.worse.n > 0, true);
  assert.equal(res.peak.h7.window, 'peak');
  assert.equal(res.recent.h7.window, 'recent');
  // The census is of the 12 census rows whatever the split.
  assert.equal(res.census.populations.allEligible.n, 12);
  assert.equal(res.census.populations.allEligible.nearCap.nearCap80.n, 1);
  assert.equal(res.census.populations.allEligible.nearCap.nearCap80.share, 1 / 12);
});

test('four sensitivity re-runs, each labeled by its filter and run on the flag the draw holds', async () => {
  const { root } = study();
  const o = opts(root);
  await cmdAnalyze(o);
  const res = JSON.parse(read(o.out, 'results.json'));
  const v = JSON.parse(read(o.out, 'verdicts.json'));
  assert.deepEqual(Object.keys(res.sensitivity).sort(), SENSITIVITY.map((s) => s.label).sort());
  // The pilot has 12 wallets, i = 0..11: franken_any only i = 2, franken_no_cospend only i = 3, prior_treated i = 0, 5, 10.
  assert.equal(res.sensitivity['without-franken-any'].wallets, 11);
  assert.equal(res.sensitivity['without-franken-no-cospend'].wallets, 11);
  assert.equal(res.sensitivity['without-prior-treated'].wallets, 9);
  assert.equal(res.sensitivity['prior-treated-only'].wallets, 3);
  assert.equal(res.sensitivity['prior-treated-only'].filter, 'on prior-treated wallets only');
  assert.ok(res.sensitivity['without-franken-any'].questions.cells.every((c) => c.name.includes('/sens/without-franken-any')));
  assert.ok(v.sensitivity['without-prior-treated'].questions.q1.answer);
  const md = read(o.out, 'verdicts.md');
  assert.match(md, /# Sensitivity: without prior-treated wallets/);
  assert.match(md, /# Sensitivity: on prior-treated wallets only/);
});

test('--drop leaves wallets out of every result and is recorded by its SHA-256 only', async () => {
  const { root, all } = study();
  const list = join(tmp(), 'drop.txt');
  writeFileSync(list, `${all[0].id}\n${all[1].id}\n`);
  const o = opts(root, { drop: list });
  await cmdAnalyze(o);
  const res = JSON.parse(read(o.out, 'results.json'));
  assert.equal(res.flow.recent.stage.dropped, 2);
  assert.equal(res.flow.recent.stage.kept, 10);
  const inputs = JSON.parse(read(o.out, 'inputs.json'));
  assert.equal(inputs.drop.wallets, 2);
  assert.match(inputs.drop.sha256, /^[0-9a-f]{64}$/);
  assert.ok(!read(o.out, 'inputs.json').includes(list));
});

test('inputs.json: each input by role with its SHA-256, the code manifest, Node and the options, and no path', async () => {
  const { root } = study();
  const o = opts(root);
  await cmdAnalyze(o);
  const i = JSON.parse(read(o.out, 'inputs.json'));
  assert.match(i.codeManifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(i.node, process.version);
  assert.deepEqual(i.options, { network: 'preprod', study: 'st', split: 'exploration', analysisFreezeTx: TX, resamples: 60, sizingSamples: 4, sizingResamples: 20 });
  for (const k of ['study.json', 'replay-recent/done.json', 'replay-recent/records', 'replay-recent/timings', 'replay-peak/records', 'history-recent/history-run.json', 'history-peak/history-run.json', 'census/census.jsonl', 'census/census-run.json', 'collateral/collateral.json', 'near-cap/near-cap.json']) assert.match(i.files[k], /^[0-9a-f]{64}$/, k);
  assert.ok(!JSON.stringify(i).includes(root));
});

test('carried reports: their figures without wall-clock fields, with each file\'s SHA-256', async () => {
  const { root } = study();
  const o = opts(root);
  await cmdAnalyze(o);
  const res = JSON.parse(read(o.out, 'results.json'));
  assert.deepEqual(res.carried.collateral.figures, { measured: 100, shareUnder20Ada: 0.25 });
  assert.deepEqual(res.carried.nearCap.figures, { wallets: 50, points: [{ epoch: 500, wallets: 50, n80: 2 }] });
  assert.match(res.carried.nearCap.sha256, /^[0-9a-f]{64}$/);
});

test('refusals before anything is written: a non-empty --out, a missing peak stage or carried report, a split on a synthetic study, a count that is not a whole number', async () => {
  const { root } = study();
  const o = opts(root);
  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, 'x'), 'x');
  await assert.rejects(cmdAnalyze(o), refusal(/is not empty/));
  const nopeak = study({ peak: false });
  const p = opts(nopeak.root);
  await assert.rejects(cmdAnalyze(p), refusal(/replay-peak has no done.json/));
  const nocarry = study({ carried: false });
  const c = opts(nocarry.root);
  await assert.rejects(cmdAnalyze(c), refusal(/collateral.json is missing/));
  await assert.rejects(cmdAnalyze(opts(root, { split: 'confirmation', analysisFreezeTx: undefined })), refusal(/analysis-freeze-tx/));
  await assert.rejects(cmdAnalyze(opts(root, { resamples: 0 })), refusal(/--resamples must be a positive whole number/));
  await assert.rejects(cmdAnalyze(opts(root, { network: 'synthetic', study: 'st' })), refusal(/takes no --split|synthetic-plan/));
  assert.ok(!existsSync(p.out) && !existsSync(c.out), 'a refused run writes nothing');
});

test('a synthetic study takes no split: every wallet enters, in B0, and the sizing runs on them', async () => {
  const root = tmp();
  const ws = Array.from({ length: 12 }, (_, i) => ({ id: `S${i}`, jobs: fullJobs(make(i), { reps: 2 }) }));
  writeStudy(root, { network: 'synthetic', runId: 'syn', window: 'recent', wallets: ws });
  const o = { network: 'synthetic', study: 'syn', root, out: join(tmp(), 'out'), ...SMALL };
  await cmdAnalyze(o);
  assert.deepEqual(files(o.out), ['inputs.json', 'results.json', 'sizing.json', 'timings.json', 'verdicts.json', 'verdicts.md']);
  const res = JSON.parse(read(o.out, 'results.json'));
  assert.equal(res.split, null);
  assert.equal(res.peak, null);
  assert.equal(res.census, null);
  assert.equal(res.carried, null);
  assert.ok(Object.values(res.sensitivity).every((s) => s.absent === true));
  const sz = JSON.parse(read(o.out, 'sizing.json'));
  assert.deepEqual(Object.keys(sz.cells[0].targets), ['B0']);
  assert.equal(sz.cells[0].targets.B0.sample, 12);
  assert.match(read(o.out, 'verdicts.md'), /Computed on a synthetic study, 12 wallets\./);
});

test('the command line: its options are the command\'s, and a split must be one of the two', () => {
  const a = parseArgs(['--network', 'synthetic', '--study', 's', '--out', '/x', '--workers', '4', '--resamples', '100'], 'analyze');
  assert.deepEqual([a.network, a.study, a.out, a.workers, a.resamples], ['synthetic', 's', '/x', '4', '100']);
  assert.throws(() => parseArgs(['--split', 'all'], 'analyze'), /--split takes exploration \| confirmation/);
  assert.throws(() => parseArgs(['--window', 'recent'], 'analyze'), /unknown option --window/);
  assert.throws(() => parseArgs(['--resamples', '0'], 'analyze'), /positive whole number/);
});

test('research-sim analyze runs from the command line and prints counts only', () => {
  const root = tmp();
  const ws = Array.from({ length: 10 }, (_, i) => ({ id: `S${i}`, jobs: fullJobs(make(i), { reps: 2 }) }));
  writeStudy(root, { network: 'synthetic', runId: 'syn', window: 'recent', wallets: ws });
  const out = join(tmp(), 'out');
  const cli = join(fileURLToPath(new URL('../../../src/cli.mjs', import.meta.url)));
  const printed = execFileSync('node', [cli, 'analyze', '--network', 'synthetic', '--study', 'syn', '--out', out, '--resamples', '40', '--sizing-samples', '3', '--sizing-resamples', '10'], { env: { ...process.env, RESEARCH_SIM_HOME: root }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const p = JSON.parse(printed);
  assert.equal(p.command, 'analyze');
  assert.equal(p.wallets, 10);
  assert.ok(!printed.includes('S1'));
});

test('canonical JSON: keys sorted, BigInt as a decimal string, non-finite numbers null, undefined left out', () => {
  assert.equal(canonicalJson({ b: 1n, a: [NaN, 2.5, { z: undefined, y: Infinity }] }), '{\n "a": [\n  null,\n  2.5,\n  {\n   "y": null\n  }\n ],\n "b": "1"\n}\n');
});
