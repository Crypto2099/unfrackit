// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Item 8 of section 7.3, the build times: the spend records' times from a
// replay stage's timings.jsonl.gz, matched to the spends by wallet index and
// record number, and the machines that ran the stage. Times and machine facts
// reach timings.json and no other output.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { quantileSorted } from './stats.mjs';

// quartiles (type 7), median, maximum and total of times in ms.
export function distribution(xs) {
  const s = Float64Array.from(xs).sort();
  return { n: s.length, q1: quantileSorted(s, 0.25), median: quantileSorted(s, 0.5), q3: quantileSorted(s, 0.75), max: s[s.length - 1], total: s.reduce((a, b) => a + b, 0) };
}

// The bin of a count of spendable UTxOs: 0, 1, 2-3, 4-7, 8-15, ...
export function spendableBin(n) {
  if (!Number.isSafeInteger(n) || n < 0) return 'unknown';
  if (n <= 1) return String(n);
  const lo = 2 ** Math.floor(Math.log2(n));
  return `${lo}-${lo * 2 - 1}`;
}

const byKey = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

// Times collected per library and arm, per method and spend type, and per
// method and bin of the spendable UTxO count before the spend (section 6.4's
// timing context). Each time is held once, in one growing column, with the
// index of its group under each of the three groupings; the groups' arrays are
// built one grouping at a time when the summary is taken.
export class TimingCollector {
  constructor() {
    this.keys = [new Map(), new Map(), new Map()];
    this.names = [[], [], []];
    this.ms = new Float64Array(1024);
    this.group = [new Uint16Array(1024), new Uint16Array(1024), new Uint16Array(1024)];
    this.rows = 0;
  }
  grow() {
    const n = this.ms.length * 2;
    const ms = new Float64Array(n);
    ms.set(this.ms);
    this.ms = ms;
    this.group = this.group.map((g) => {
      const x = new Uint16Array(n);
      x.set(g);
      return x;
    });
  }
  code(d, key) {
    let c = this.keys[d].get(key);
    if (c === undefined) {
      c = this.names[d].length;
      if (c > 0xffff) throw new Error('timings: more than 65,536 groups');
      this.keys[d].set(key, c);
      this.names[d].push(key);
    }
    return c;
  }
  add({ method, kind, type, ms, spendable }) {
    if (this.rows === this.ms.length) this.grow();
    const i = this.rows++;
    this.ms[i] = ms;
    this.group[0][i] = this.code(0, `${method}/${kind}`);
    this.group[1][i] = this.code(1, `${method}/${type}`);
    this.group[2][i] = this.code(2, `${method}/${spendableBin(spendable)}`);
  }
  summary() {
    const g = (d) => {
      const names = this.names[d];
      const counts = new Uint32Array(names.length);
      const col = this.group[d];
      for (let i = 0; i < this.rows; i++) counts[col[i]]++;
      const arrays = names.map((_, c) => new Float64Array(counts[c]));
      const at = new Uint32Array(names.length);
      for (let i = 0; i < this.rows; i++) arrays[col[i]][at[col[i]]++] = this.ms[i];
      const m = new Map(names.map((k, c) => [k, arrays[c]]));
      return Object.fromEntries([...m].sort(byKey).map(([k, xs]) => [k, distribution(xs)]));
    };
    return { rows: this.rows, byArm: g(0), byMethodAndType: g(1), byMethodAndSpendable: g(2) };
  }
}

const readJsonIf = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

// The machines of a replay stage: per label, the invocations' host facts and
// worker counts and the number of watchdog stops and machine reruns in the
// label's log.
export function readMachines(stageDir) {
  const dir = join(stageDir, 'machines');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const m = readJsonIf(join(dir, f));
    if (!m || typeof m.label !== 'string') continue;
    const reruns = { watchdogStops: 0, machineReruns: 0 };
    const logPath = join(dir, `${m.label}.log.jsonl`);
    if (existsSync(logPath)) {
      for (const line of readFileSync(logPath, 'utf8').split('\n')) {
        if (!line) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.event === 'watchdog stop') reruns.watchdogStops++;
        else if (e.event === 'machine rerun') reruns.machineReruns++;
      }
    }
    const invocations = (m.invocations || []).map(({ start, end, selection, completed, ...facts }) => ({ ...facts, wallets: Array.isArray(completed) ? completed.length : null }));
    out.push({ label: m.label, invocations, ...reruns });
  }
  return out;
}
