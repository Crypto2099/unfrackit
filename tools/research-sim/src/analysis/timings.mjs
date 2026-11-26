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

// The key under which rows of a wallet no machine record completed are held.
export const UNATTRIBUTED = 'unattributed';

// The multiple of the interquartile range, on the log of the times, above the
// third quartile at which a build counts as an outlier of its library on its
// machine.
export const OUTLIER_IQR_MULTIPLE = 3;
export const OUTLIER_RULE = `ln(ms) above Q3 + ${OUTLIER_IQR_MULTIPLE} x IQR of the library's builds on this machine`;

// The groupings of a row, each one column of group codes (Uint16) beside the
// time: the three distributions, the machine, the library, and the
// characteristics the outliers are spread over.
const DIMS = ['arm', 'methodType', 'methodSpendable', 'machine', 'method', 'type', 'spendable', 'inputs', 'outcome'];

// Bin names sort by their lower bound (2-3 before 16-31), `unknown` last.
const binOrder = (a, b) => {
  const x = a === 'unknown' ? Infinity : parseInt(a, 10);
  const y = b === 'unknown' ? Infinity : parseInt(b, 10);
  return x === y ? (a < b ? -1 : a > b ? 1 : 0) : x < y ? -1 : 1;
};
const byBin = (a, b) => binOrder(a[0], b[0]);

// Times collected with the machine that ran the wallet, and summarized per
// machine: per library and arm, per method and spend type, and per method and
// bin of the spendable UTxO count before the spend (section 6.4's timing
// context), and the library's outliers. Each time is held once, in one
// growing column, with a group code per dimension; one machine's groups are
// built at a time when the summary is taken, so nothing is pooled across
// machines and no row is held twice.
export class TimingCollector {
  constructor() {
    this.keys = DIMS.map(() => new Map());
    this.names = DIMS.map(() => []);
    this.ms = new Float64Array(1024);
    this.group = DIMS.map(() => new Uint16Array(1024));
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
  // machine: the label of the machine that completed the wallet, or none.
  add({ method, kind, type, ms, spendable, machine, inputs, outcome }) {
    if (this.rows === this.ms.length) this.grow();
    const i = this.rows++;
    const bin = spendableBin(spendable);
    this.ms[i] = ms;
    const set = [`${method}/${kind}`, `${method}/${type}`, `${method}/${bin}`, machine || UNATTRIBUTED, method, String(type), bin, spendableBin(inputs), String(outcome)];
    for (let d = 0; d < DIMS.length; d++) this.group[d][i] = this.code(d, set[d]);
  }

  // The distributions of the rows idx names (row numbers), per group of
  // dimension d.
  distributions(d, idx) {
    const names = this.names[d];
    const counts = new Uint32Array(names.length);
    const col = this.group[d];
    for (let j = 0; j < idx.length; j++) counts[col[idx[j]]]++;
    const arrays = names.map((_, c) => new Float64Array(counts[c]));
    const at = new Uint32Array(names.length);
    for (let j = 0; j < idx.length; j++) arrays[col[idx[j]]][at[col[idx[j]]]++] = this.ms[idx[j]];
    const m = new Map(names.map((k, c) => [k, arrays[c]]).filter(([, xs]) => xs.length));
    return Object.fromEntries([...m].sort(byKey).map(([k, xs]) => [k, distribution(xs)]));
  }

  // Per library of the rows idx names: the builds whose ln(ms) is above
  // Q3 + 3 x IQR of the library's own, their count against the library's rows,
  // and how the outliers and all the library's rows spread over the spendable
  // bin, the spend type, the bin of the wallet inputs the spend used (unknown
  // for a failed spend, which records none) and the outcome.
  outliers(idx) {
    const d = (n) => DIMS.indexOf(n);
    const out = {};
    const mcol = this.group[d('method')];
    const byMethod = new Map();
    for (let j = 0; j < idx.length; j++) {
      const c = mcol[idx[j]];
      if (!byMethod.has(c)) byMethod.set(c, []);
      byMethod.get(c).push(idx[j]);
    }
    const spreads = [['bySpendable', 'spendable', byBin], ['byType', 'type', byKey], ['byInputs', 'inputs', byBin], ['byOutcome', 'outcome', byKey]];
    for (const [c, rows] of [...byMethod].sort((x, y) => (this.names[d('method')][x[0]] < this.names[d('method')][y[0]] ? -1 : 1))) {
      const logs = Float64Array.from(rows, (r) => Math.log(Math.max(this.ms[r], 1e-9))).sort();
      const q1 = quantileSorted(logs, 0.25);
      const q3 = quantileSorted(logs, 0.75);
      const limit = q3 + OUTLIER_IQR_MULTIPLE * (q3 - q1);
      const far = rows.filter((r) => Math.log(Math.max(this.ms[r], 1e-9)) > limit);
      const entry = { rule: OUTLIER_RULE, count: far.length, rows: rows.length, thresholdMs: Math.exp(limit) };
      for (const [name, dim, order] of spreads) {
        const tally = new Map();
        const bump = (r, k) => {
          const key = this.names[d(dim)][this.group[d(dim)][r]];
          if (!tally.has(key)) tally.set(key, { outliers: 0, all: 0 });
          tally.get(key)[k]++;
        };
        for (const r of rows) bump(r, 'all');
        for (const r of far) bump(r, 'outliers');
        entry[name] = Object.fromEntries([...tally].sort(order));
      }
      out[this.names[d('method')][c]] = entry;
    }
    return out;
  }

  // machines: label to the machine entry (readAttribution's) kept beside the
  // rows of that label; a label without rows is left out, and rows of no label
  // go under UNATTRIBUTED.
  summary(machines = new Map()) {
    const m = DIMS.indexOf('machine');
    const labels = this.names[m];
    const counts = new Uint32Array(labels.length);
    for (let i = 0; i < this.rows; i++) counts[this.group[m][i]]++;
    const order = labels.map((l, c) => [l, c]).sort((x, y) => (x[0] === UNATTRIBUTED ? 1 : y[0] === UNATTRIBUTED ? -1 : x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    const byMachine = {};
    for (const [label, c] of order) {
      const idx = new Uint32Array(counts[c]);
      let k = 0;
      for (let i = 0; i < this.rows; i++) if (this.group[m][i] === c) idx[k++] = i;
      byMachine[label] = {
        machine: label === UNATTRIBUTED ? null : machines.get(label) || null,
        rows: idx.length,
        byArm: this.distributions(0, idx),
        byMethodAndType: this.distributions(1, idx),
        byMethodAndSpendable: this.distributions(2, idx),
        outliers: this.outliers(idx)
      };
    }
    return { rows: this.rows, byMachine };
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

// Which machine label completed each wallet of a replay stage. A machine
// record's invocation lists the indexes it completed; a wallet a resumed
// stage redid is listed by an earlier invocation too, and the segment on disk
// is the last one's, so the last invocation of a label that lists it is its
// invocation. A wallet two labels list (a merge keeps one copy) goes to the
// label its segment's done file names; one that file does not settle, and one
// no record lists, has no label. Returns { labelOf(i), machines } where
// machines maps a label to { label, workers, invocations }, the invocations
// being those that completed wallets, each with its host facts and the number
// of the stage's wallets it completed.
export function readAttribution(stageDir) {
  const dir = join(stageDir, 'machines');
  const records = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const m = readJsonIf(join(dir, f));
      if (m && typeof m.label === 'string' && Array.isArray(m.invocations)) records.push(m);
    }
  }
  const claims = new Map();
  for (const m of records) {
    const last = new Map();
    m.invocations.forEach((inv, j) => {
      if (Array.isArray(inv.completed)) for (const i of inv.completed) if (Number.isSafeInteger(i) && i >= 0) last.set(i, j);
    });
    for (const [i, j] of last) {
      if (!claims.has(i)) claims.set(i, []);
      claims.get(i).push({ label: m.label, j });
    }
  }
  const owner = new Map();
  for (const [i, cs] of claims) {
    let pick = cs.length === 1 ? cs[0] : null;
    if (!pick) {
      const done = readJsonIf(join(stageDir, 'segments', `${i}.done.json`));
      if (done) pick = cs.find((c) => c.label === done.machine) || null;
    }
    if (pick) owner.set(i, pick);
  }
  const machines = new Map();
  for (const m of records) {
    const per = new Map();
    for (const { label, j } of owner.values()) if (label === m.label) per.set(j, (per.get(j) || 0) + 1);
    if (!per.size) continue;
    const invocations = [...per].sort((a, b) => a[0] - b[0]).map(([j, wallets]) => {
      const { start, end, selection, completed, merged, ...facts } = m.invocations[j];
      return { ...facts, wallets };
    });
    const workers = [...new Set(invocations.map((x) => x.workers).filter((w) => Number.isSafeInteger(w)))].sort((a, b) => a - b);
    machines.set(m.label, { label: m.label, workers, invocations });
  }
  return { labelOf: (i) => (owner.has(i) ? owner.get(i).label : null), machines };
}
