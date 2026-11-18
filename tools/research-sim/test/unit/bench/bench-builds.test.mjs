// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// scripts/bench-builds.mjs: the cell and its supervisor on the test methods and
// on csl-lf (these need the treatment and are skipped without it), and the
// summary and the ratio table on hand-made files (no treatment).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BASELINE_METHODS } from '../../../src/methods/registry.mjs';
import { quantileSorted } from '../../../src/analysis/stats.mjs';
import { ROWS, LADDER, N_TIMED, CAP_SECONDS, WARMUPS, buildOptions, summarizeCell, renderTable, computeRatios, renderRatios, gitCommit } from '../../../scripts/bench-builds.mjs';
import { skip } from '../../lib/treatment.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'bench-builds.mjs');
let root;
before(() => { root = mkdtempSync(join(tmpdir(), 'bench-builds-')); });
after(() => rmSync(root, { recursive: true, force: true }));

const bench = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 240000 });
const cellLines = (out, name) => readFileSync(join(out, 'cells', `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };

test('the constants: ladder, rows, N, warm-up and cap', () => {
  assert.deepEqual(LADDER.map((l) => l.shape), ['S9', 'S6', 'M3', 'H4E005']);
  assert.equal(ROWS.length, 25);
  assert.deepEqual(ROWS.slice(0, 23).map((r) => r.row), [...BASELINE_METHODS]);
  assert.deepEqual(ROWS.slice(23).map((r) => [r.row, r.method, r.absorb]), [['unfrackit-h12-absorb-on', 'unfrackit-h12', true], ['unfrackit-h12-absorb-off', 'unfrackit-h12', false]]);
  assert.equal(N_TIMED, 10);
  assert.equal(WARMUPS, 1);
  assert.equal(CAP_SECONDS, 1800);
});

test('the rule gets absorb per variant, a baseline gets none', () => {
  assert.deepEqual(buildOptions('unfrackit-h12-absorb-on'), { changePolicy: 'default', seed: 1, absorb: true });
  assert.deepEqual(buildOptions('unfrackit-h12-absorb-off'), { changePolicy: 'default', seed: 1, absorb: false });
  assert.deepEqual(buildOptions('csl-lf'), { changePolicy: 'default', seed: 1 });
  assert.throws(() => buildOptions('nope'), /unknown row/);
});

test('a test-largest-first cell on S1 at N = 3: header, warm-up, 3 timed lines, end', { skip }, () => {
  const out = join(root, 'largest');
  const r = bench('run', '--shape', 'S1', '--row', 'test-largest-first', '--out', out, '--n', '3');
  assert.equal(r.status, 0, r.stderr);
  const l = cellLines(out, 'S1-test-largest-first');
  assert.deepEqual(l.map((x) => x.line), ['header', 'build', 'build', 'build', 'build', 'end']);
  assert.deepEqual(l.map((x) => x.build), [undefined, 0, 1, 2, 3, undefined]);
  assert.equal(l[0].n, 3);
  assert.deepEqual(l[0].overrides, { n: 3 });
  assert.equal(l[0].capSeconds, 1800);
  assert.equal(l[0].changePolicy, 'default');
  assert.equal(l[1].warmup, true);
  assert.equal(l[2].warmup, undefined);
  for (const b of l.slice(1, 5)) {
    assert.equal(b.ok, true);
    assert.ok(b.seconds > 0);
    assert.equal(b.helper, null);
    assert.equal(typeof b.load1, 'number');
    assert.match(b.startedAt, /^\d{4}-\d\d-\d\dT/);
  }
  assert.equal(l[5].status, 'done');
  assert.ok(l[5].peakRssKb > 0);
  const s = summarizeCell({ header: l[0], builds: l.filter((x) => x.line === 'build'), stop: null, end: l[5] });
  assert.equal(s.n, 3);
  assert.ok(s.warmupSeconds > 0);
});

test('a stalled build ends at the cap: timeout line, not-run lines, no process of the group left', { skip }, () => {
  const out = join(root, 'stall');
  const r = bench('run', '--shape', 'S1', '--row', 'test-stall', '--out', out, '--n', '3', '--cap-seconds', '2');
  assert.equal(r.status, 3, r.stderr);
  const l = cellLines(out, 'S1-test-stall');
  assert.deepEqual(l.map((x) => x.line), ['header', 'timeout', 'not-run', 'not-run', 'not-run', 'end']);
  assert.equal(l[0].capSeconds, 2);
  assert.deepEqual(l[1], { line: 'timeout', cell: 'S1-test-stall', build: 0, status: 'timeout', atLeastSeconds: 2, capSeconds: 2 });
  assert.deepEqual(l.slice(2, 5).map((x) => x.build), [1, 2, 3]);
  assert.equal(l[5].status, 'timeout');
  assert.equal(groupAlive(l[5].pgid), false);
});

test('a csl-lf cell on S9 at N = 3 with the real treatment', { skip }, () => {
  const out = join(root, 'csl');
  const r = bench('run', '--shape', 'S9', '--row', 'csl-lf', '--out', out, '--n', '3');
  assert.equal(r.status, 0, r.stderr);
  const l = cellLines(out, 'S9-csl-lf');
  assert.equal(l.length, 6);
  assert.equal(l[0].method, 'csl-lf');
  assert.match(l[0].version, /\S/);
  assert.equal(l[0].variant, null);
  assert.ok(l.slice(1, 5).every((b) => b.ok === true && b.seconds > 0));
  assert.equal(l[5].status, 'done');
  assert.equal(groupAlive(l[5].pgid), false);
  const sum = bench('summary', '--out', out);
  assert.equal(sum.status, 0, sum.stderr);
  const s = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.equal(s.cells[0].row, 'csl-lf');
  assert.equal(s.cells[0].n, 3);
  assert.match(readFileSync(join(out, 'table.md'), 'utf8'), /\| csl-lf \| \d/);
});

// ---- the summary on a hand-made fixture ----

const header = (shape, row, extra = {}) => ({ line: 'header', cell: `${shape}-${row}`, row, shape, n: 10, warmups: 1, capSeconds: 1800, version: 'v', commit: 'c', node: 'v24', v8: '13', ...extra });
const b = (i, seconds, extra = {}) => ({ line: 'build', build: i, ...(i === 0 ? { warmup: true } : {}), seconds, ok: true, class: null, detail: null, helper: null, ...extra });
const fixture = (dir, name, lines) => {
  mkdirSync(join(dir, 'cells'), { recursive: true });
  writeFileSync(join(dir, 'cells', `${name}.jsonl`), lines.map((x) => JSON.stringify(x)).join('\n') + '\n');
};

test('summary: type-7 quartiles, the marks for a failure class, the cap and the helper line, and the warm-up column only on request', () => {
  const dir = join(root, 'sum');
  const times = [0.9, 0.3, 0.5, 0.7, 0.1, 0.2, 0.4, 0.6, 0.8, 1.0];
  fixture(dir, 'S9-csl-lf', [header('S9', 'csl-lf'), b(0, 5), ...times.map((t, i) => b(i + 1, t)), { line: 'end', status: 'done', peakRssKb: 1 }]);
  fixture(dir, 'S9-csl-ri', [header('S9', 'csl-ri'), b(0, 1), ...times.map((t, i) => b(i + 1, t, { ok: false, class: 'change-minimum', detail: 'x' })), { line: 'end', status: 'done', peakRssKb: 1 }]);
  fixture(dir, 'S9-evo-lf', [header('S9', 'evo-lf'), b(0, 1), ...times.slice(0, 4).map((t, i) => b(i + 1, t, i < 1 ? { ok: false, class: 'change-minimum' } : {})), { line: 'end', status: 'done', peakRssKb: 1 }]);
  fixture(dir, 'S9-tx3-vd', [header('S9', 'tx3-vd'), b(0, 2), b(1, 100), b(2, 110), { line: 'timeout', cell: 'S9-tx3-vd', build: 3, status: 'timeout', atLeastSeconds: 1800, capSeconds: 1800 }, ...Array.from({ length: 8 }, (_, i) => ({ line: 'not-run', build: i + 4 })), { line: 'end', status: 'timeout', peakRssKb: 1 }]);
  fixture(dir, 'S9-pycardano-lf', [header('S9', 'pycardano-lf'), b(0, 3), ...times.map((t, i) => b(i + 1, t, { helper: { buildMs: 200 + i, witnessMs: 100 } })), { line: 'end', status: 'done', peakRssKb: 1 }]);
  fixture(dir, 'S9-kuber-prune', [header('S9', 'kuber-prune'), b(0, 3), { line: 'error', build: 1, status: 'error', message: 'helper died' }, ...Array.from({ length: 9 }, (_, i) => ({ line: 'not-run', build: i + 2 })), { line: 'end', status: 'error', peakRssKb: 1 }]);
  assert.equal(bench('summary', '--out', dir).status, 0);
  const s = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
  const c = (row) => s.cells.find((x) => x.row === row);
  const sorted = Float64Array.from(times).sort();
  assert.equal(c('csl-lf').q1, quantileSorted(sorted, 0.25));
  assert.equal(c('csl-lf').median, quantileSorted(sorted, 0.5));
  assert.equal(c('csl-lf').q3, quantileSorted(sorted, 0.75));
  assert.equal(Math.round(c('csl-lf').q1 * 1e9), 325000000);
  assert.equal(c('csl-lf').min, 0.1);
  assert.equal(c('csl-lf').max, 1);
  assert.equal(c('csl-lf').warmupSeconds, 5);
  assert.equal(c('csl-lf').outcome, 'built');
  assert.equal(c('csl-ri').outcome, 'fails');
  assert.equal(c('evo-lf').outcome, 'mixed');
  assert.equal(c('tx3-vd').status, 'timeout');
  assert.equal(c('tx3-vd').n, 2);
  assert.equal(c('kuber-prune').status, 'error');
  assert.equal(c('kuber-prune').n, 0);
  const p = c('pycardano-lf').helper;
  assert.equal(p.builds, 10);
  assert.ok(Math.abs(p.own.min - 0.3) < 1e-12 && Math.abs(p.own.max - 0.309) < 1e-12);
  assert.ok(Math.abs(p.roundTrip.median - (0.55 - 0.3045)) < 1e-9);
  const t = readFileSync(join(dir, 'table.md'), 'utf8');
  const rowOf = (name) => t.split('\n').find((l) => l.startsWith(`| ${name} |`));
  assert.match(rowOf('csl-lf'), /\| 0\.55 \(0\.325 to 0\.775\) \|/);
  assert.match(rowOf('csl-ri'), /fails: change-minimum 10/);
  assert.match(rowOf('evo-lf'), /1 of 4 fail: change-minimum 1/);
  assert.match(rowOf('tx3-vd'), /at least 1,800 s \(cap\), n=2/);
  assert.match(rowOf('pycardano-lf'), /<br>own 0\.304, round trip 0\.245/);
  assert.match(rowOf('kuber-prune'), /error at build 1: helper died/);
  assert.match(rowOf('lucid-lf'), /not run/);
  assert.match(t, /\| S9 \(71 UTxOs, 210 assets\) \|/);
  assert.doesNotMatch(t, /warm-up/);
  assert.equal(bench('summary', '--out', dir, '--warmup').status, 0);
  assert.match(readFileSync(join(dir, 'table.md'), 'utf8'), /<br>warm-up 5/);
});

test('renderTable reads the machine line from machine.json', () => {
  const m = { start: { cpuModel: 'Test CPU', logicalCores: 4, physicalCores: 4, totalMemoryBytes: 2 ** 33, os: 'Ubuntu', osRelease: '6.1', virtualization: 'none', governor: 'performance', node: 'v24', v8: '13', java: 'openjdk 21', python: 'Python 3.12.3' } };
  const t = renderTable([], m);
  assert.match(t, /Machine: Test CPU, 4 logical \(4 physical\) cores, 8 GiB, Ubuntu \(kernel 6\.1\), virtualization none, governor performance, Node v24, V8 13, openjdk 21, Python 3\.12\.3/);
});

// ---- the ratio table on two hand-made summaries ----

const cellOf = (shape, row, median, extra = {}) => ({ shape, row, status: 'done', outcome: 'built', n: 10, median, helper: null, ...extra });
const machine = (extra = {}) => ({ start: { cpuModel: 'CPU', logicalCores: 4, node: 'v24', v8: '13', java: 'openjdk 21', python: 'Python 3.12.3', ...extra } });
const summaryOf = (cells, m) => ({ cells, machine: m });

test('ratios: three significant figures, blanks, helper rows, and the version mark', () => {
  const h = (own, trip) => ({ builds: 10, own: { median: own }, roundTrip: { median: trip } });
  const first = summaryOf([
    cellOf('S9', 'csl-lf', 0.0123456), cellOf('S6', 'csl-lf', 0.5), cellOf('M3', 'csl-lf', 1), cellOf('H4E005', 'csl-lf', 2),
    cellOf('S9', 'csl-ri', 0.1), cellOf('S6', 'csl-ri', 0.1, { outcome: 'fails' }),
    cellOf('M3', 'csl-ri', 0.1, { status: 'timeout' }), cellOf('H4E005', 'csl-ri', 0.1, { n: 9 }),
    cellOf('S9', 'ccl-pw', 1, { helper: h(0.5, 0.5) }), cellOf('S6', 'ccl-pw', 1, { helper: h(0.5, 0.5) }),
    cellOf('S9', 'tx3-vd', 10, { helper: h(8, 2) })
  ], machine());
  const second = summaryOf([
    cellOf('S9', 'csl-lf', 0.0246912), cellOf('S6', 'csl-lf', 1.5), cellOf('M3', 'csl-lf', 1.9), cellOf('H4E005', 'csl-lf', 4.2),
    cellOf('S9', 'csl-ri', 0.2), cellOf('S6', 'csl-ri', 0.2), cellOf('M3', 'csl-ri', 0.2), cellOf('H4E005', 'csl-ri', 0.2),
    cellOf('S9', 'ccl-pw', 2, { helper: h(1.5, 0.5) }), cellOf('S6', 'ccl-pw', 2, { helper: h(1.5, 0.5) }),
    cellOf('S9', 'tx3-vd', 20, { helper: h(16, 4) })
  ], machine({ java: 'openjdk 17' }));
  const r = computeRatios(first, second);
  const row = (label) => r.rows.find((x) => x.label === label);
  assert.deepEqual(row('csl-lf').ratios, { S9: 2, S6: 3, M3: 1.9, H4E005: 2.1 });
  assert.equal(row('csl-lf').lowest, 1.9);
  assert.equal(row('csl-lf').highest, 3);
  assert.deepEqual(row('csl-ri').ratios, { S9: 2, S6: null, M3: null, H4E005: null });
  assert.deepEqual(row('ccl-pw own time').ratios, { S9: 3, S6: 3, M3: null, H4E005: null });
  assert.deepEqual(row('ccl-pw round trip').ratios, { S9: 1, S6: 1, M3: null, H4E005: null });
  assert.deepEqual(row('tx3-vd own time').ratios.S9, 2);
  assert.deepEqual(row('csl-lf').differentRuntime, []);
  assert.deepEqual(row('ccl-pw').differentRuntime, ['jvm']);
  assert.deepEqual(row('scalus-pool').differentRuntime, ['jvm']);
  assert.deepEqual(row('tx3-vd').differentRuntime, []);
  assert.deepEqual(row('unfrackit-h12-absorb-on').ratios, { S9: null, S6: null, M3: null, H4E005: null });
  assert.equal(row('unfrackit-h12-absorb-on').lowest, null);
  const md = renderRatios(r, { first: 'laptop', second: 'spare' });
  assert.match(md, /spare over laptop/);
  assert.match(md, /\| csl-lf \| 2 \| 3 \| 1\.9 \| 2\.1 \| 1\.9 \| 3 \|/);
  assert.match(md, /\| ccl-pw \[jvm differs\] \|/);
  assert.match(md, /the JVM differs, Python is equal, Node and V8 is equal/);
  assert.match(md, /laptop: CPU, 4 logical/);
});

test('ratios: a Node difference marks every row; the command line writes both files', () => {
  const cells = [cellOf('S9', 'csl-lf', 1)];
  const r = computeRatios(summaryOf(cells, machine()), summaryOf(cells, machine({ v8: '14' })));
  assert.ok(r.rows.every((x) => x.differentRuntime.includes('node')));
  const a = join(root, 'run-a');
  const bdir = join(root, 'run-b');
  mkdirSync(a, { recursive: true });
  mkdirSync(bdir, { recursive: true });
  writeFileSync(join(a, 'summary.json'), JSON.stringify(summaryOf(cells, machine())));
  writeFileSync(join(bdir, 'summary.json'), JSON.stringify(summaryOf([cellOf('S9', 'csl-lf', 3.14159)], machine())));
  const out = join(root, 'ratios');
  const res = bench('ratios', a, bdir, '--out', out, '--first-name', 'laptop', '--second-name', 'spare');
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(join(out, 'ratios.json')));
  const md = readFileSync(join(out, 'ratios.md'), 'utf8');
  assert.match(md, /\| csl-lf \| 3\.14 \|/);
  assert.match(md, /the JVM is equal, Python is equal, Node and V8 is equal/);
});

test('machine writes start and end facts into machine.json', () => {
  const out = join(root, 'machine');
  assert.equal(bench('machine', '--out', out, '--phase', 'start').status, 0);
  assert.equal(bench('machine', '--out', out, '--phase', 'end').status, 0);
  const m = JSON.parse(readFileSync(join(out, 'machine.json'), 'utf8'));
  for (const k of ['start', 'end']) {
    assert.equal(typeof m[k].cpuModel, 'string');
    assert.equal(m[k].node, process.version);
    assert.ok('governor' in m[k] && 'java' in m[k] && 'python' in m[k] && 'uptimeSeconds' in m[k]);
  }
});

test('--commit is the recorded commit; without it git is asked, and outside a work tree the commit is null', { skip }, () => {
  const out = join(root, 'commit');
  const r = bench('run', '--shape', 'S1', '--row', 'test-largest-first', '--out', out, '--n', '1', '--commit', 'abc123');
  assert.equal(r.status, 0, r.stderr);
  const h = cellLines(out, 'S1-test-largest-first')[0];
  assert.equal(h.commit, 'abc123');
  assert.deepEqual(h.overrides, { n: 1 });
  assert.equal(bench('machine', '--out', out, '--phase', 'start', '--commit', 'abc123').status, 0);
  assert.equal(JSON.parse(readFileSync(join(out, 'machine.json'), 'utf8')).start.commit, 'abc123');
});

test('gitCommit: the given value, git inside a work tree, null outside one', () => {
  assert.equal(gitCommit(root, 'given'), 'given');
  assert.equal(gitCommit(root), null);
  assert.match(gitCommit(), /^[0-9a-f]{40}$/);
});

test('ratios: the commits of the two runs, and the note when they differ or one is missing', () => {
  const cells = [cellOf('S9', 'csl-lf', 1)];
  const run = (c) => summaryOf(cells, machine({ commit: c }));
  const note = /Note: the two runs are not known to be the same code/;
  let md = renderRatios(computeRatios(run('aaa'), run('aaa')), { first: 'laptop', second: 'spare' });
  assert.doesNotMatch(md, note);
  assert.match(md, /Commits: laptop aaa, spare aaa\./);
  md = renderRatios(computeRatios(run('aaa'), run('bbb')), { first: 'laptop', second: 'spare' });
  assert.match(md, /Note: .*laptop aaa, spare bbb/);
  assert.ok(md.indexOf('Note:') < md.indexOf('| Library |'));
  md = renderRatios(computeRatios(run('aaa'), run(null)), { first: 'laptop', second: 'spare' });
  assert.match(md, /spare no commit recorded/);
  assert.match(md, /Commits: laptop aaa, spare none recorded\./);
  md = renderRatios(computeRatios(run(null), run(null)), { first: 'laptop', second: 'spare' });
  assert.match(md, note);
});
