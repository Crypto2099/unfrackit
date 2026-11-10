#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The heavy probe's parts: one measured replay job, the queue that runs the
// probe, and the table that reads its results. scripts/heavy-probe.sh runs
// them.
//
//   node scripts/heavy-probe.mjs job --wallet H20E05 --method csl-lf --arm observed [--variant default]
//   node scripts/heavy-probe.mjs queue --dir <queue dir> --snapshot <simulator dir> --env <env file>
//   node scripts/heavy-probe.mjs summary --dir <queue dir>
//
// job: builds the heavy wallet (src/shapes/heavy.mjs) with its stream and
// replays it in this one process under one method and arm (test method
// settings: the default change policy, seed 1, the ledger collateral rule,
// no validity checks). It prints one JSON line per intent after the method
// has answered it (the process's resident size, CSL's WebAssembly memory
// (the exported memory's byte length, which only grows), V8's heap and
// external memory, and the time since the replay began), one line at the
// start and one RESULT line at the end. The resident peak between samples is
// the `time -v` figure of the queue's job; the timer inside the job adds the
// peaks seen between intents.
//
// queue: the probe's twelve jobs, three wallets by the four heaviest job
// kinds, one process each, under /usr/bin/time -v.
//
// summary: one table row per job from its time file and its RESULT line.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));

// Cheapest first within a kind, for the same reason.
export const WALLETS = Object.freeze(['H20E01', 'H3E6', 'H20E05']);

// The four heaviest job kinds, cheapest first, so that a stopped probe has
// the most readings.
export const KINDS = Object.freeze([
  { id: 'csl-lf-observed', method: 'csl-lf', arm: 'observed', variant: 'default' },
  { id: 'cjs-rrri-maintained-tidy', method: 'cjs-rrri', arm: 'maintained-tidy', variant: 'default' },
  { id: 'cjs-rrri-tidy-once-byte-optimal', method: 'cjs-rrri', arm: 'tidy-once', variant: 'byte-optimal' },
  { id: 'evo-lf-observed', method: 'evo-lf', arm: 'observed', variant: 'default' }
]);

// Caps per job, in minutes: a job that passes its cap is stopped and the
// probe goes on.
const CAP_MINUTES = { H20E01: 90, H20E05: 360, H3E6: 360 };

export function probeQueue({ snapshot, envFile, dir }) {
  const jobs = [];
  for (const k of KINDS) {
    for (const w of WALLETS) {
      const id = `${w}-${k.id}`;
      jobs.push({
        id,
        cwd: snapshot,
        argv: ['/usr/bin/time', '-v', '-a', '-o', join(dir, 'out', 'time', `${id}.txt`), 'node', 'scripts/heavy-probe.mjs', 'job', '--wallet', w, '--method', k.method, '--arm', k.arm, '--variant', k.variant],
        timeoutMinutes: CAP_MINUTES[w]
      });
    }
  }
  return { name: 'heavy-probe', out: 'out/queue', envFile, jobs };
}

const MiB = (b) => +(b / 1048576).toFixed(1);

async function job(a) {
  const imp = (p) => import(pathToFileURL(join(HERE, '..', 'src', p)).href);
  const { loadTreatment } = await imp('treatment/bridge.mjs');
  const T = await loadTreatment(process.env.RESEARCH_SIM_TREATMENT_DIR, readFileSync(process.env.RESEARCH_SIM_TREATMENT_PINS, 'utf8'));
  const { loadSource } = await imp('replay/source.mjs');
  const { makeMethod } = await imp('methods/registry.mjs');
  const { replay } = await imp('replay/engine.mjs');
  const memory = T.CSL.__wasm.memory;
  const peak = { rss: 0, csl: 0, heapUsed: 0, external: 0 };
  const sample = () => {
    const m = process.memoryUsage();
    const c = memory.buffer.byteLength;
    peak.rss = Math.max(peak.rss, m.rss);
    peak.csl = Math.max(peak.csl, c);
    peak.heapUsed = Math.max(peak.heapUsed, m.heapUsed);
    peak.external = Math.max(peak.external, m.external);
    return { rssMiB: MiB(m.rss), cslMiB: MiB(c), heapUsedMiB: MiB(m.heapUsed), heapTotalMiB: MiB(m.heapTotal), externalMiB: MiB(m.external) };
  };
  const print = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

  const t0 = performance.now();
  const source = loadSource(T, { kind: 'shape', name: a.wallet, stream: 'synthetic' });
  const counts = source.events.reduce((m, e) => ((m[e.kind] = (m[e.kind] || 0) + 1), m), {});
  print({ start: true, wallet: a.wallet, method: a.method, arm: a.arm, variant: a.variant, utxos: source.start.length, events: source.events.length, counts, sourceMs: Math.round(performance.now() - t0), ...sample() });

  const base = makeMethod(T, a.method, {});
  let k = 0;
  const r0 = performance.now();
  const method = Object.create(base);
  method.build = async (...args) => {
    const x = await base.build(...args);
    k++;
    print({ k, ms: Math.round(performance.now() - r0), ...sample() });
    return x;
  };
  const timer = setInterval(sample, 50);
  const job = { arm: a.arm, variant: a.variant, repetition: 1, opts: { seed: 1, changePolicy: 'default', collateralRule: 'ledger' }, settleEvery: 25, policyLock: false, validity: false };
  const x = await replay(T, source.params, source, { ...job, method });
  clearInterval(timer);
  const end = sample();
  const c = x.summary ? x.summary.counts : null;
  print({ result: true, wallet: a.wallet, method: a.method, arm: a.arm, variant: a.variant, wallMs: Math.round(performance.now() - t0), replayMs: Math.round(performance.now() - r0), refused: x.refused || null, builds: k, intents: c && c.intents, built: c && c.built, failed: c && c.failed, byClass: c && c.byClass, plans: x.plans.length, spends: x.spends.length, peakRssMiB: MiB(peak.rss), peakCslMiB: MiB(peak.csl), peakHeapUsedMiB: MiB(peak.heapUsed), peakExternalMiB: MiB(peak.external), endRssMiB: end.rssMiB });
  process.exit(0);
}

function timeField(text, label) {
  const m = new RegExp(`${label}[^:]*:\\s*(.+)$`, 'm').exec(text);
  return m ? m[1].trim() : null;
}

// One row per job: the time file's wall time and maximum resident size (the
// last attempt's) with the job's RESULT line from its stdout log.
export function summarize(dir) {
  const rows = [];
  const queueOut = join(dir, 'out', 'queue');
  for (const k of KINDS) {
    for (const w of WALLETS) {
      const id = `${w}-${k.id}`;
      const row = { id, wall: null, maxRssMiB: null, exit: null, peakCslMiB: null, peakHeapMiB: null, built: null, failed: null, builds: null };
      const tf = join(dir, 'out', 'time', `${id}.txt`);
      if (existsSync(tf)) {
        const parts = readFileSync(tf, 'utf8').split('Command being timed');
        const t = parts.at(-1);
        row.wall = timeField(t, 'Elapsed \\(wall clock\\) time \\(h:mm:ss or m:ss\\)');
        const kb = Number(timeField(t, 'Maximum resident set size \\(kbytes\\)'));
        row.maxRssMiB = Number.isFinite(kb) ? +(kb / 1024).toFixed(0) : null;
        row.exit = timeField(t, 'Exit status');
      }
      const jd = join(queueOut, id);
      if (existsSync(jd)) {
        const attempts = readdirSync(jd).filter((n) => n.startsWith('attempt-')).sort((x, y) => Number(x.slice(8)) - Number(y.slice(8)));
        const last = attempts.at(-1);
        const lf = last && join(jd, last, 'stdout.log');
        if (lf && existsSync(lf)) {
          const lines = readFileSync(lf, 'utf8').split('\n').filter((l) => l.startsWith('{'));
          const res = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((o) => o && o.result).at(-1);
          if (res) Object.assign(row, { peakCslMiB: res.peakCslMiB, peakHeapMiB: res.peakHeapUsedMiB, built: res.built, failed: res.failed, builds: res.builds });
        }
      }
      rows.push(row);
    }
  }
  return rows;
}

export function table(rows) {
  const cols = ['id', 'wall', 'maxRssMiB', 'exit', 'peakCslMiB', 'peakHeapMiB', 'builds', 'built', 'failed'];
  const cell = (v) => (v === null || v === undefined ? '-' : String(v));
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (r) => cols.map((c, i) => cell(r[c]).padEnd(width[i])).join('  ').trimEnd();
  return [line(Object.fromEntries(cols.map((c) => [c, c]))), ...rows.map(line)].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = { wallet: { type: 'string' }, method: { type: 'string' }, arm: { type: 'string' }, variant: { type: 'string', default: 'default' }, dir: { type: 'string' }, snapshot: { type: 'string' }, env: { type: 'string' } };
  const { values: a } = parseArgs({ args: rest, options: opt });
  if (cmd === 'job') {
    if (!a.wallet || !a.method || !a.arm) throw new Error('job: --wallet, --method and --arm are required');
    await job(a);
  } else if (cmd === 'queue') {
    if (!a.dir || !a.snapshot || !a.env) throw new Error('queue: --dir, --snapshot and --env are required');
    const dir = resolve(a.dir);
    mkdirSync(join(dir, 'out', 'time'), { recursive: true });
    const q = probeQueue({ snapshot: resolve(a.snapshot), envFile: resolve(a.env), dir });
    writeFileSync(join(dir, 'queue.json'), `${JSON.stringify(q, null, 2)}\n`);
    process.stdout.write(`${join(dir, 'queue.json')}: ${q.jobs.length} jobs\n`);
  } else if (cmd === 'summary') {
    if (!a.dir) throw new Error('summary: --dir is required');
    process.stdout.write(`${table(summarize(resolve(a.dir)))}\n`);
  } else {
    throw new Error('usage: heavy-probe.mjs job|queue|summary');
  }
}
