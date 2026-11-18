#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The library build-time benchmark's harness. Every library (the baselines and
// the rule, absorption on and off) builds the first intent of a synthetic
// shape at its start state, own change, one build at a time, and the wall-clock
// time of each build is kept. It reads no wallet data and no record reads it.
//
//   node scripts/bench-builds.mjs run --shape S9 --row csl-lf --out <dir>
//       The supervisor: starts one fresh child process for the cell in its own
//       process group, arms the per-build cap on each build's start line, kills
//       the group at the cap, samples the tree's resident set every 0.5 s and
//       writes <dir>/cells/<shape>-<row>.jsonl.
//   node --expose-gc scripts/bench-builds.mjs cell --shape S9 --row csl-lf
//       The child: loads the treatment, the shape and the method outside any
//       timing, then makes the warm-up build and N timed builds, a line each on
//       standard output, calling gc() before each.
//   node scripts/bench-builds.mjs summary --out <dir> [--warmup]
//       Reads <dir>/cells/*.jsonl; writes summary.json and table.md.
//   node scripts/bench-builds.mjs ratios <first dir> <second dir> --out <dir>
//       Reads two runs' summary.json and machine.json; writes ratios.json and
//       ratios.md (the second run's medians over the first's).
//   node scripts/bench-builds.mjs machine --out <dir> --phase start|end
//       Writes the machine's facts into <dir>/machine.json.
//
// A cell's file holds JSON lines: a header; one `build` line per build (build 0
// is the warm-up, marked `warmup: true`); then either all N timed builds, or a
// `timeout` or `error` line at the build that stopped the cell and a `not-run`
// line for each build after it; and an end line with the status (`done`,
// `timeout` or `error`) and the peak resident set of the process tree.
//
// Test overrides (--n, --cap-seconds, --warmups) are recorded in the header
// under `overrides` when used. The treatment comes from
// RESEARCH_SIM_TREATMENT_DIR and RESEARCH_SIM_TREATMENT_PINS, as in the tests.

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, readdirSync, mkdirSync, existsSync, writeSync, renameSync } from 'node:fs';
import os from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE_METHODS } from '../src/methods/registry.mjs';
import { quantileSorted } from '../src/analysis/stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// Fixed before the run; nothing the run measures changes them.
export const LADDER = Object.freeze([
  { shape: 'S9', utxos: 71, assets: 210 },
  { shape: 'S6', utxos: 500, assets: 406 },
  { shape: 'M3', utxos: 3005, assets: 3000 },
  { shape: 'H4E005', utxos: 4000, assets: 3378 }
]);
export const SHAPES = Object.freeze(LADDER.map((l) => l.shape));
export const N_TIMED = 10;
export const WARMUPS = 1;
export const CAP_SECONDS = 1800;
export const CHANGE_POLICY = 'default';
export const SEED = 1;
export const ROWS = Object.freeze([
  ...BASELINE_METHODS.map((m) => ({ row: m, method: m, absorb: undefined })),
  { row: 'unfrackit-h12-absorb-on', method: 'unfrackit-h12', absorb: true },
  { row: 'unfrackit-h12-absorb-off', method: 'unfrackit-h12', absorb: false }
]);
export const HELPER_ROWS = Object.freeze(['apollo-macs', 'scalus-pool', 'ccl-pw', 'pycardano-lf', 'tx3-vd', 'kuber-prune', 'cwallet-rrri']);
// The runtime each helper library runs on, for the ratio table's version marks.
const HELPER_RUNTIME = Object.freeze({ 'ccl-pw': 'jvm', 'scalus-pool': 'jvm', 'pycardano-lf': 'python' });
export const SAMPLE_MS = 500;

const rowDef = (name) => {
  const r = ROWS.find((x) => x.row === name) || (name.startsWith('test-') ? { row: name, method: name, absorb: undefined } : null);
  if (!r) throw new Error(`unknown row ${name}`);
  return r;
};

// The options one build is given: the default policy, seed 1, and for the
// rule its variant (the method refuses a build without it).
export function buildOptions(row) {
  const r = typeof row === 'string' ? rowDef(row) : row;
  return { changePolicy: CHANGE_POLICY, seed: SEED, ...(r.absorb !== undefined ? { absorb: r.absorb } : {}) };
}

export const cellName = (shape, row) => `${shape}-${row}`;

const line = (o) => JSON.stringify(o) + '\n';
const emit = (o) => writeSync(1, line(o));

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (['warmup'].includes(k)) flags[k] = true;
      else {
        if (i + 1 >= argv.length) throw new Error(`--${k} needs a value`);
        flags[k] = argv[++i];
      }
    } else positional.push(a);
  }
  return { flags, positional };
}

const intFlag = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
};

// The commit to record: the one given (a snapshot has no .git), else git's
// answer in `dir`, else null.
export function gitCommit(dir = ROOT, given = null) {
  if (given) return given;
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// The cell's overrides, recorded when used.
function overridesOf(flags) {
  const o = {};
  if (flags.n !== undefined) o.n = intFlag(flags.n, 'n');
  if (flags['cap-seconds'] !== undefined) o.capSeconds = Number(flags['cap-seconds']);
  if (flags.warmups !== undefined) o.warmups = intFlag(flags.warmups, 'warmups');
  return o;
}

// ---- the child ----------------------------------------------------------

async function cellMain(flags) {
  const { shape, row } = flags;
  if (!shape || !row) throw new Error('cell needs --shape and --row');
  const def = rowDef(row);
  const overrides = overridesOf(flags);
  const n = overrides.n ?? N_TIMED;
  const warmups = overrides.warmups ?? WARMUPS;
  const cap = overrides.capSeconds ?? CAP_SECONDS;
  if (typeof globalThis.gc !== 'function') throw new Error('the cell needs node --expose-gc');
  const { loadTreatment } = await import('../src/treatment/bridge.mjs');
  const { makeMethod } = await import('../src/methods/registry.mjs');
  const { loadSource } = await import('../src/replay/source.mjs');
  const { makeState } = await import('../src/state/state.mjs');
  const dir = process.env.RESEARCH_SIM_TREATMENT_DIR;
  if (!dir) throw new Error('RESEARCH_SIM_TREATMENT_DIR names no treatment directory');
  const pins = process.env.RESEARCH_SIM_TREATMENT_PINS ? readFileSync(process.env.RESEARCH_SIM_TREATMENT_PINS, 'utf8') : undefined;
  const T = await loadTreatment(dir, pins);
  const source = loadSource(T, { kind: 'shape', name: shape, stream: 'synthetic' });
  const state = makeState({ network: 'synthetic', stakeCred: source.stakeCred, changeAddress: source.changeAddress, utxos: source.start, at: { slot: 0, time: 0 } });
  const intent = source.events.find((e) => e.kind === 'intent').intent;
  const method = makeMethod(T, def.method);
  const opts = buildOptions(def);
  emit({
    line: 'header', cell: cellName(shape, row), row, method: def.method, variant: def.absorb === undefined ? null : { absorb: def.absorb },
    shape, version: method.version ?? null, commit: gitCommit(ROOT, flags.commit), node: process.version, v8: process.versions.v8,
    n, warmups, capSeconds: cap, changePolicy: CHANGE_POLICY, seed: SEED, startedAt: new Date().toISOString(),
    ...(Object.keys(overrides).length ? { overrides } : {})
  });
  for (let b = 0; b < warmups + n; b++) {
    globalThis.gc();
    const startedAt = new Date().toISOString();
    const load1 = os.loadavg()[0];
    emit({ line: 'start', build: b });
    const t0 = performance.now();
    let r;
    try {
      r = await method.build(state, intent, source.params, { ...opts });
    } catch (e) {
      emit({ line: 'error', cell: cellName(shape, row), build: b, status: 'error', message: String((e && e.message) || e).slice(0, 500) });
      process.exit(0);
    }
    const seconds = (performance.now() - t0) / 1000;
    const h = r && r.helper ? { buildMs: r.helper.buildMs ?? null, witnessMs: r.helper.witnessMs ?? null } : null;
    emit({
      line: 'build', build: b, ...(b < warmups ? { warmup: true } : {}), startedAt, load1, seconds, ok: !!r.ok,
      class: r.ok ? null : (r.class ?? null), detail: r.ok ? null : (r.detail ? String(r.detail).slice(0, 120) : null), helper: h
    });
  }
  process.exit(0);
}

// ---- the supervisor -----------------------------------------------------

// The resident set, in kilobytes, of every process in a group.
export function groupRssKb(pgid) {
  let total = 0;
  let names;
  try {
    names = readdirSync('/proc');
  } catch {
    return 0;
  }
  for (const d of names) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(rest[2]) !== pgid) continue;
      const pages = Number(readFileSync(`/proc/${d}/statm`, 'utf8').split(' ')[1]);
      total += (pages * 4096) / 1024;
    } catch {
      // the process ended between the listing and the read
    }
  }
  return Math.round(total);
}

export function runCell({ shape, row, out, commit = null, n = N_TIMED, capSeconds = CAP_SECONDS, warmups = WARMUPS, overrides = {}, scriptPath = fileURLToPath(import.meta.url) }) {
  rowDef(row);
  const dir = join(out, 'cells');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${cellName(shape, row)}.jsonl`);
  writeFileSync(file, '');
  const cell = cellName(shape, row);
  const total = warmups + n;
  const args = ['--expose-gc', scriptPath, 'cell', '--shape', shape, '--row', row];
  if (commit) args.push('--commit', commit);
  for (const [k, flag] of [['n', 'n'], ['capSeconds', 'cap-seconds'], ['warmups', 'warmups']]) if (overrides[k] !== undefined) args.push(`--${flag}`, String(overrides[k]));
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const pgid = child.pid;
    let status = null;
    let message = null;
    let peak = 0;
    let started = -1;
    let lastBuild = -1;
    let buf = '';
    let errTail = '';
    let timer = null;
    let exited = false;
    const write = (o) => appendFileSync(file, line(o));
    const sampler = setInterval(() => { peak = Math.max(peak, groupRssKb(pgid)); }, SAMPLE_MS);
    peak = Math.max(peak, groupRssKb(pgid));
    const finish = (code, signal) => {
      if (exited) return;
      exited = true;
      clearInterval(sampler);
      clearTimeout(timer);
      try { process.kill(-pgid, 'SIGKILL'); } catch { /* nothing left */ }
      if (!status) {
        if (lastBuild >= total - 1) status = 'done';
        else {
          status = 'error';
          message = `the cell process ended before its builds were done (exit ${code}, signal ${signal}): ${errTail.trim().slice(-300)}`;
          write({ line: 'error', cell, build: lastBuild + 1, status: 'error', message });
          lastBuild += 1;
        }
      }
      for (let b = lastBuild + 1; b < total; b++) write({ line: 'not-run', cell, build: b });
      const end = { line: 'end', cell, status, pgid, peakRssKb: peak, endedAt: new Date().toISOString(), ...(message ? { message } : {}) };
      write(end);
      resolveRun(end);
    };
    const onLine = (text) => {
      if (!text.trim()) return;
      let o;
      try {
        o = JSON.parse(text);
      } catch {
        errTail += text + '\n';
        return;
      }
      if (o.line === 'start') {
        started = o.build;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (exited || status) return;
          status = 'timeout';
          try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
          write({ line: 'timeout', cell, build: started, status: 'timeout', atLeastSeconds: capSeconds, capSeconds });
          lastBuild = started;
        }, capSeconds * 1000);
        return;
      }
      clearTimeout(timer);
      if (status === 'timeout') return;
      if (o.line === 'build') lastBuild = o.build;
      if (o.line === 'error') {
        status = 'error';
        message = o.message;
        lastBuild = o.build;
      }
      write(o);
    };
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
    child.on('error', (e) => { errTail += String(e); finish(null, null); });
    child.on('close', (code, signal) => {
      if (buf.trim()) onLine(buf);
      buf = '';
      finish(code, signal);
    });
  });
}

// ---- statistics and the summary ----------------------------------------

export function stats(values) {
  const s = Float64Array.from(values).sort();
  if (!s.length) return { n: 0, min: null, q1: null, median: null, q3: null, max: null };
  return { n: s.length, min: s[0], q1: quantileSorted(s, 0.25), median: quantileSorted(s, 0.5), q3: quantileSorted(s, 0.75), max: s[s.length - 1] };
}

export function readCell(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return {
    header: lines.find((l) => l.line === 'header') || null,
    builds: lines.filter((l) => l.line === 'build'),
    stop: lines.find((l) => l.line === 'timeout' || l.line === 'error') || null,
    end: lines.find((l) => l.line === 'end') || null
  };
}

// One cell's summary: statistics over the timed builds that answered, the
// outcome, the warm-up's time, and for a helper library the library's own time
// (build plus witness) and the round trip (the total less the own time) over
// the builds that carry the helper's times.
export function summarizeCell({ header, builds, stop, end }) {
  const timed = builds.filter((b) => !b.warmup);
  const warm = builds.find((b) => b.warmup);
  const classes = {};
  for (const b of timed) if (!b.ok) classes[b.class || 'unknown'] = (classes[b.class || 'unknown'] || 0) + 1;
  const failed = timed.filter((b) => !b.ok).length;
  const status = end ? end.status : stop ? stop.status : 'incomplete';
  const helped = timed.filter((b) => b.helper && typeof b.helper.buildMs === 'number');
  const own = helped.map((b) => (b.helper.buildMs + (b.helper.witnessMs || 0)) / 1000);
  const trip = helped.map((b, i) => b.seconds - own[i]);
  return {
    shape: header ? header.shape : null,
    row: header ? header.row : null,
    status,
    outcome: failed === 0 ? 'built' : failed === timed.length ? 'fails' : 'mixed',
    failed,
    classes,
    ...stats(timed.map((b) => b.seconds)),
    warmupSeconds: warm ? warm.seconds : null,
    expectedN: header ? header.n : null,
    capSeconds: header ? header.capSeconds : null,
    stopBuild: stop ? stop.build : null,
    message: stop && stop.status === 'error' ? stop.message : null,
    helper: helped.length ? { builds: helped.length, own: stats(own), roundTrip: stats(trip) } : null,
    version: header ? header.version : null,
    commit: header ? header.commit : null,
    node: header ? header.node : null,
    v8: header ? header.v8 : null,
    peakRssKb: end ? end.peakRssKb : null,
    overrides: header && header.overrides ? header.overrides : null
  };
}

const sig3 = (x) => (x === null || x === undefined ? '' : String(Number(x.toPrecision(3))));
const secs = (x) => `${sig3(x)}`;
const thousands = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const classList = (c) => Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ');

// The text of one table cell.
export function cellText(c, { warmup = false } = {}) {
  if (!c) return 'not run';
  const spread = (s) => `${secs(s.median)} (${secs(s.q1)} to ${secs(s.q3)})`;
  let t;
  if (c.status === 'timeout') {
    t = `at least ${thousands(c.capSeconds)} s (cap), n=${c.n}`;
    if (c.n > 0) t += `; ${spread(c)}`;
  } else if (c.status === 'error') {
    t = `error at build ${c.stopBuild ?? ''}: ${c.message ?? ''}`.replace(/\|/g, '/');
    if (c.n > 0) t += `; ${spread(c)}`;
  } else if (c.status === 'incomplete') {
    t = c.n > 0 ? `${spread(c)}, incomplete (n=${c.n})` : 'incomplete';
  } else if (c.outcome === 'fails') {
    t = `${spread(c)}, fails: ${classList(c.classes)}`;
  } else if (c.outcome === 'mixed') {
    t = `${spread(c)}, ${c.failed} of ${c.n} fail: ${classList(c.classes)}`;
  } else t = spread(c);
  if (c.status === 'done' && c.expectedN && c.n < c.expectedN) t += ` (n=${c.n})`;
  if (c.helper) t += `<br>own ${secs(c.helper.own.median)}, round trip ${secs(c.helper.roundTrip.median)}`;
  if (warmup && c.warmupSeconds !== null) t += `<br>warm-up ${secs(c.warmupSeconds)}`;
  return t;
}

export function machineLine(m) {
  if (!m) return 'machine: not recorded';
  const f = m.start || m.end || m;
  const mem = f.totalMemoryBytes ? `${Math.round(f.totalMemoryBytes / 2 ** 30)} GiB` : '?';
  return `${f.cpuModel ?? '?'}, ${f.logicalCores ?? '?'} logical${f.physicalCores ? ` (${f.physicalCores} physical)` : ''} cores, ${mem}, ${f.os ?? '?'} (kernel ${f.osRelease ?? '?'}), virtualization ${f.virtualization ?? '?'}, governor ${f.governor ?? '?'}, Node ${f.node ?? '?'}, V8 ${f.v8 ?? '?'}, ${f.java ?? 'java ?'}, ${f.python ?? 'python ?'}`;
}

export function renderTable(cells, machine, { warmup = false } = {}) {
  const by = new Map(cells.map((c) => [`${c.shape}/${c.row}`, c]));
  const out = [];
  out.push('| Library | ' + LADDER.map((l) => `${l.shape} (${thousands(l.utxos)} UTxOs, ${thousands(l.assets)} assets)`).join(' | ') + ' |');
  out.push('|---|' + LADDER.map(() => '---|').join(''));
  for (const r of ROWS) out.push(`| ${r.row} | ` + LADDER.map((l) => cellText(by.get(`${l.shape}/${r.row}`), { warmup })).join(' | ') + ' |');
  out.push('');
  out.push('Each cell is the median in seconds with the first and third quartiles (type 7) over the timed builds. For a helper library the second line gives the library\'s own time and the round trip, medians.');
  out.push('');
  out.push(`Machine: ${machineLine(machine)}`);
  return out.join('\n') + '\n';
}

export function summarize(outDir, { warmup = false } = {}) {
  const dir = join(outDir, 'cells');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort() : [];
  const cells = files.map((f) => summarizeCell(readCell(join(dir, f))));
  let machine = null;
  const mpath = join(outDir, 'machine.json');
  if (existsSync(mpath)) machine = JSON.parse(readFileSync(mpath, 'utf8'));
  const summary = { format: 'library build-time benchmark summary 1', constants: { ladder: LADDER, n: N_TIMED, warmups: WARMUPS, capSeconds: CAP_SECONDS, rows: ROWS.map((r) => r.row) }, machine, cells };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(join(outDir, 'table.md'), renderTable(cells, machine, { warmup }));
  return summary;
}

// ---- the ratio table ----------------------------------------------------

const medianOf = (c, kind) => {
  if (!c) return null;
  if (c.status !== 'done' || c.outcome !== 'built' || c.n < N_TIMED) return null;
  if (kind === 'total') return c.median;
  if (!c.helper || c.helper.builds < N_TIMED) return null;
  return kind === 'own' ? c.helper.own.median : c.helper.roundTrip.median;
};

export function runtimeDiffs(m1, m2) {
  const a = (m1 && (m1.start || m1)) || {};
  const b = (m2 && (m2.start || m2)) || {};
  const diff = (k) => (a[k] ?? null) !== (b[k] ?? null);
  return { node: diff('node') || diff('v8'), jvm: diff('java'), python: diff('python') };
}

// The commit a run was made from: machine.json's, else the cells'.
export function runCommit(s) {
  const m = s.machine && (s.machine.start || s.machine.end);
  if (m && m.commit) return m.commit;
  const c = s.cells.find((x) => x.commit);
  return c ? c.commit : null;
}

export function computeRatios(first, second) {
  const f = new Map(first.cells.map((c) => [`${c.shape}/${c.row}`, c]));
  const s = new Map(second.cells.map((c) => [`${c.shape}/${c.row}`, c]));
  const diffs = runtimeDiffs(first.machine, second.machine);
  const rows = [];
  const add = (label, row, kind) => {
    const ratios = {};
    for (const l of LADDER) {
      const a = medianOf(f.get(`${l.shape}/${row}`), kind);
      const b = medianOf(s.get(`${l.shape}/${row}`), kind);
      ratios[l.shape] = a !== null && b !== null && a > 0 ? Number((b / a).toPrecision(3)) : null;
    }
    const vals = Object.values(ratios).filter((v) => v !== null);
    const marks = [];
    if (diffs.node) marks.push('node');
    if (HELPER_RUNTIME[row] && diffs[HELPER_RUNTIME[row]]) marks.push(HELPER_RUNTIME[row]);
    rows.push({ label, row, kind, ratios, lowest: vals.length ? Math.min(...vals) : null, highest: vals.length ? Math.max(...vals) : null, differentRuntime: marks });
  };
  for (const r of ROWS) {
    add(r.row, r.row, 'total');
    if (HELPER_ROWS.includes(r.row)) {
      add(`${r.row} own time`, r.row, 'own');
      add(`${r.row} round trip`, r.row, 'roundTrip');
    }
  }
  const c1 = runCommit(first);
  const c2 = runCommit(second);
  return { format: 'library build-time benchmark ratios 1', direction: 'second over first', firstCommit: c1, secondCommit: c2, sameCode: c1 !== null && c1 === c2, runtimeDiffers: diffs, firstMachine: first.machine, secondMachine: second.machine, rows };
}

export function renderRatios(r, names = { first: 'first', second: 'second' }) {
  const o = [];
  if (!r.sameCode) o.push(`Note: the two runs are not known to be the same code (${names.first} ${r.firstCommit ?? 'no commit recorded'}, ${names.second} ${r.secondCommit ?? 'no commit recorded'}).\n`);
  o.push(`Ratio of medians, ${names.second} over ${names.first}, three significant figures; blank where either cell failed, reached the cap or has fewer than ${N_TIMED} timed builds.`);
  o.push('');
  o.push('| Library | ' + SHAPES.join(' | ') + ' | Lowest | Highest |');
  o.push('|---|' + SHAPES.map(() => '---|').join('') + '---|---|');
  for (const x of r.rows) {
    const name = x.differentRuntime.length ? `${x.label} [${x.differentRuntime.join(', ')} differs]` : x.label;
    o.push(`| ${name} | ` + SHAPES.map((s) => (x.ratios[s] === null ? '' : String(x.ratios[s]))).join(' | ') + ` | ${x.lowest === null ? '' : x.lowest} | ${x.highest === null ? '' : x.highest} |`);
  }
  o.push('');
  o.push(`${names.first}: ${machineLine(r.firstMachine)}`);
  o.push('');
  o.push(`${names.second}: ${machineLine(r.secondMachine)}`);
  o.push('');
  o.push(`Commits: ${names.first} ${r.firstCommit ?? 'none recorded'}, ${names.second} ${r.secondCommit ?? 'none recorded'}.`);
  o.push('');
  const d = r.runtimeDiffers;
  const eq = (k, label) => `${label} ${d[k] ? 'differs' : 'is equal'}`;
  o.push(`Runtime versions: ${eq('jvm', 'the JVM')}, ${eq('python', 'Python')}, ${eq('node', 'Node and V8')}. A library that runs on a runtime that differs is marked in its row.`);
  o.push('');
  o.push('The machines differ in more than the processor (cores, memory, and whether Ubuntu runs natively or under WSL2).');
  return o.join('\n') + '\n';
}

// ---- the machine --------------------------------------------------------

const tryRun = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000 });
  if (r.error || r.status !== 0) return null;
  return ((r.stderr || '') + (r.stdout || '')).split('\n')[0].trim() || null;
};
const readOne = (p) => { try { return readFileSync(p, 'utf8').trim(); } catch { return null; } };

export async function machineNow(commit = null) {
  const { machineFacts } = await import('../src/out/host.mjs');
  const cpu = '/sys/devices/system/cpu';
  let governors = null;
  let mhz = null;
  try {
    const cpus = readdirSync(cpu).filter((d) => /^cpu\d+$/.test(d));
    governors = [...new Set(cpus.map((c) => readOne(join(cpu, c, 'cpufreq/scaling_governor'))).filter(Boolean))];
    const f = cpus.map((c) => Number(readOne(join(cpu, c, 'cpufreq/scaling_cur_freq')))).filter((x) => x > 0).map((k) => Math.round(k / 1000));
    mhz = f.length ? { min: Math.min(...f), max: Math.max(...f) } : null;
  } catch { /* no cpufreq */ }
  return {
    ...machineFacts(), governor: governors && governors.length ? governors.join(',') : null, currentMhz: mhz,
    uptimeSeconds: Math.round(os.uptime()), java: tryRun('java', ['-version']), python: tryRun('/usr/bin/python3.12', ['-V']),
    commit: gitCommit(ROOT, commit), recordedAt: new Date().toISOString()
  };
}

// ---- the command line ---------------------------------------------------

async function main(argv) {
  const [cmd, ...rest] = argv;
  const { flags, positional } = parseArgs(rest);
  if (cmd === 'cell') return cellMain(flags);
  if (cmd === 'run') {
    if (!flags.shape || !flags.row || !flags.out) throw new Error('run needs --shape, --row and --out');
    const o = overridesOf(flags);
    const end = await runCell({ shape: flags.shape, row: flags.row, out: flags.out, commit: flags.commit || null, n: o.n ?? N_TIMED, capSeconds: o.capSeconds ?? CAP_SECONDS, warmups: o.warmups ?? WARMUPS, overrides: o });
    console.log(JSON.stringify(end));
    process.exit(end.status === 'done' ? 0 : 3);
  }
  if (cmd === 'summary') {
    if (!flags.out) throw new Error('summary needs --out');
    const s = summarize(flags.out, { warmup: !!flags.warmup });
    console.log(`summary: ${s.cells.length} cells`);
    return;
  }
  if (cmd === 'ratios') {
    if (positional.length !== 2 || !flags.out) throw new Error('ratios needs two run directories and --out');
    const read = (d) => JSON.parse(readFileSync(join(d, 'summary.json'), 'utf8'));
    const [a, b] = positional.map(read);
    const r = computeRatios(a, b);
    mkdirSync(flags.out, { recursive: true });
    writeFileSync(join(flags.out, 'ratios.json'), JSON.stringify(r, null, 2) + '\n');
    writeFileSync(join(flags.out, 'ratios.md'), renderRatios(r, { first: flags['first-name'] || 'first', second: flags['second-name'] || 'second' }));
    console.log(`ratios: ${r.rows.length} rows`);
    return;
  }
  if (cmd === 'machine') {
    if (!flags.out || !['start', 'end'].includes(flags.phase)) throw new Error('machine needs --out and --phase start|end');
    mkdirSync(flags.out, { recursive: true });
    const path = join(flags.out, 'machine.json');
    let cur = {};
    if (existsSync(path)) cur = JSON.parse(readFileSync(path, 'utf8'));
    cur[flags.phase] = await machineNow(flags.commit || null);
    writeFileSync(path + '.tmp', JSON.stringify(cur, null, 2) + '\n');
    renameSync(path + '.tmp', path);
    console.log(machineLine(cur));
    return;
  }
  throw new Error('usage: bench-builds.mjs cell|run|summary|ratios|machine ...');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(2);
  });
}
