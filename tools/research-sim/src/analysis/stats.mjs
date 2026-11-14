// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The analysis scripts' statistics core (pre-registration section 7.1): weighted
// mean and median, type-7 quantiles, the within-group bootstrap and the cluster
// bootstrap, Wilson intervals at the effective sample size, the size-group
// merge and ten-wallet rules, the closed equivalence band, and a worker pool
// whose results are byte-identical at any worker count.
//
// Bootstrap determinism. A cell's resamples are cut into fixed chunks of
// CHUNK_SIZE; each chunk draws from its own mulberry32 stream (shapes/rng.mjs)
// seeded from SEED_CONSTANT, the cell's name and the chunk's number. The
// chunking does not depend on the worker count, so a pool only decides which
// thread computes a chunk, never what the chunk holds. Results are joined in
// chunk order and cells are returned in the order given.
//
// A bootstrap cell is { name, statistic, wallets }, a wallet being
// { id, group, weight, v: [a] or [a, b] }. Statistics (STATISTICS):
//   mean     weighted mean of v[0]
//   median   weighted median of v[0] (weightedMedian)
//   absMean  absolute value of the weighted mean of v[0]
//   ratio    sum(w v[0]) / sum(w v[1]), the cluster bootstrap's ratio of
//            weighted sums over wallets, each wallet bringing all its units
// Each statistic is computed on the resampled wallets with their weights.

import { Worker } from 'node:worker_threads';
import { makeRng } from '../shapes/rng.mjs';

// The one constant every bootstrap stream is seeded from. Fixed here before any
// record is analyzed and never changed afterwards.
export const SEED_CONSTANT = 20261114;
export const CHUNK_SIZE = 250;
export const RESAMPLES = 10000;
export const LEVEL_DECISION = 0.9875;
export const LEVEL_REPORT = 0.95;
export const WILSON_Z = 1.959963984540054;
export const MIN_CELL_WALLETS = 10;
export const GROUPS = ['B0', 'B1', 'B2', 'B3'];

// Relative tolerance for "cumulative weight is exactly half the total", which
// sums of doubles cannot reach bit for bit.
const HALF_EPS = 1e-12;

export function weightedMean(values, weights) {
  let sw = 0;
  let sx = 0;
  for (let i = 0; i < values.length; i++) {
    sw += weights[i];
    sx += weights[i] * values[i];
  }
  return sw > 0 ? sx / sw : null;
}

// Sort wallets by value, ties by id; take the smallest value at which the
// cumulative weight reaches half the total; when it equals exactly half, the
// mean of that value and the next. With equal weights this is the ordinary
// median. `ids` break ties in the sort order only; the result does not depend
// on them.
export function weightedMedian(values, weights, ids = null) {
  const n = values.length;
  if (n === 0) return null;
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => values[a] - values[b] || (ids ? cmp(ids[a], ids[b]) : a - b));
  return medianInOrder(order, values, weights);
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function medianInOrder(order, values, weights) {
  let total = 0;
  for (const i of order) total += weights[i];
  if (!(total > 0)) return null;
  const half = total / 2;
  let cum = 0;
  for (let k = 0; k < order.length; k++) {
    cum += weights[order[k]];
    if (Math.abs(cum - half) <= HALF_EPS * total) {
      return k + 1 < order.length ? (values[order[k]] + values[order[k + 1]]) / 2 : values[order[k]];
    }
    if (cum > half) return values[order[k]];
  }
  return values[order[order.length - 1]];
}

// Hyndman and Fan type 7: h = (n - 1) p, linear interpolation between the
// order statistics at floor(h) and ceil(h) (zero-based).
export function quantile(values, p) {
  if (values.length === 0) return null;
  const s = Float64Array.from(values).sort();
  return quantileSorted(s, p);
}

export function quantileSorted(s, p) {
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return lo === hi ? s[lo] : s[lo] + (h - lo) * (s[hi] - s[lo]);
}

export function quantiles(values, ps) {
  const s = Float64Array.from(values).sort();
  return ps.map((p) => (s.length === 0 ? null : quantileSorted(s, p)));
}

// Wilson score interval for the weighted share of x (0 or 1 per wallet) at the
// effective sample size (sum w)^2 / sum w^2.
export function effectiveN(weights) {
  let s = 0;
  let s2 = 0;
  for (const w of weights) {
    s += w;
    s2 += w * w;
  }
  return s2 > 0 ? (s * s) / s2 : 0;
}

export function wilson(p, n, z = WILSON_Z) {
  if (!(n > 0)) return null;
  const z2 = z * z;
  const d = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export function weightedShare(flags, weights, z = WILSON_Z) {
  const n = effectiveN(weights);
  const p = weightedMean(flags.map((f) => (f ? 1 : 0)), weights);
  if (p === null) return { share: null, n: 0, interval: null };
  return { share: p, n, interval: wilson(p, n, z) };
}

// The closed band: an interval ending exactly at the smallest effect is inside.
export function insideBand(lo, hi, sesoi) {
  return lo >= -sesoi && hi <= sesoi;
}

// A cell holding fewer than MIN_CELL_WALLETS wallets is written with its count
// and no estimate.
export function reportable(n) {
  return n >= MIN_CELL_WALLETS;
}

// Size-group cells (section 7.1, the ten-wallet rule). `counts` maps B1..B3 to
// the wallets entering the cell. Going from B3 down, a cell under ten wallets is
// merged with the next smaller group and the merged cell replaces both. A merge
// that reaches B0 leaves only the whole-sample cell: { cells: [], wholeOnly }.
// Cells come back from the smallest group up.
export function mergeSizeGroups(counts) {
  const cells = [];
  let groups = [];
  let n = 0;
  for (const g of ['B3', 'B2', 'B1']) {
    groups.unshift(g);
    n += counts[g] ?? 0;
    if (n >= MIN_CELL_WALLETS) {
      cells.unshift({ groups, label: groups.join('+'), n });
      groups = [];
      n = 0;
    }
  }
  if (groups.length > 0) return { cells: [], wholeOnly: true };
  return { cells, wholeOnly: false };
}

function fnv32(text) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(text, 'utf8')) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function seedFor(name, chunk = 0) {
  return fnv32(`${SEED_CONSTANT}\u0000${name}\u0000${chunk}`);
}

// Cell preparation: wallets in (group, id) order, columns, group index lists.
function prepare(cell) {
  const wallets = [...cell.wallets].sort((a, b) => cmp(a.group, b.group) || cmp(String(a.id), String(b.id)));
  const n = wallets.length;
  const w = new Float64Array(n);
  const a = new Float64Array(n);
  const b = new Float64Array(n);
  const groups = [];
  let last = null;
  wallets.forEach((x, i) => {
    w[i] = x.weight;
    a[i] = x.v[0];
    b[i] = x.v.length > 1 ? x.v[1] : 0;
    if (x.group !== last) {
      groups.push({ start: i, end: i });
      last = x.group;
    }
    groups[groups.length - 1].end = i + 1;
  });
  const order = Array.from({ length: n }, (_, i) => i).sort((p, q) => a[p] - a[q] || cmp(String(wallets[p].id), String(wallets[q].id)));
  const rank = new Int32Array(n);
  order.forEach((idx, r) => (rank[idx] = r));
  return { n, w, a, b, groups, order, rank };
}

function meanOf(d, idx) {
  let sw = 0;
  let sx = 0;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    sw += d.w[i];
    sx += d.w[i] * d.a[i];
  }
  return sw > 0 ? sx / sw : NaN;
}

export const STATISTICS = {
  mean: meanOf,
  absMean: (d, idx) => Math.abs(meanOf(d, idx)),
  ratio(d, idx) {
    let num = 0;
    let den = 0;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      num += d.w[i] * d.a[i];
      den += d.w[i] * d.b[i];
    }
    return den !== 0 ? num / den : NaN;
  },
  median(d, idx) {
    // Original positions are already in no value order; sort by value rank.
    const ranks = Int32Array.from(idx, (i) => d.rank[i]).sort();
    const order = Array.from(ranks, (r) => d.order[r]);
    const m = medianInOrder(order, d.a, d.w);
    return m === null ? NaN : m;
  }
};

function statisticFn(name) {
  const fn = STATISTICS[name];
  if (!fn) throw new Error(`unknown statistic ${name}`);
  return fn;
}

// One chunk of resamples: each draws, within every group, as many wallets as the
// group holds. Returns a Float64Array of the statistic per resample.
export function runChunk(task) {
  const d = prepare({ wallets: task.wallets });
  const fn = statisticFn(task.statistic);
  const rng = makeRng(seedFor(task.name, task.chunk));
  const out = new Float64Array(task.count);
  const idx = new Int32Array(d.n);
  for (let r = 0; r < task.count; r++) {
    for (const g of d.groups) {
      const size = g.end - g.start;
      for (let k = 0; k < size; k++) idx[g.start + k] = g.start + Math.floor(rng.next() * size);
    }
    out[r] = fn(d, idx);
  }
  return out;
}

function levelKey(level) {
  return String(level);
}

// Bootstrap every cell. Returns, in the order given,
// { name, n, estimate, intervals: { '<level>': [lo, hi] | null }, resamples,
//   dropped } where dropped counts resamples whose statistic was not finite
// (such resamples are left out of the percentiles). A cell with no wallets has
// a null estimate and null intervals.
export async function bootstrap(cells, { workers = 1, resamples = RESAMPLES, levels = [LEVEL_DECISION, LEVEL_REPORT] } = {}) {
  const tasks = [];
  const owners = [];
  cells.forEach((cell, ci) => {
    if (cell.wallets.length === 0) return;
    for (let c = 0, left = resamples; left > 0; c++) {
      const count = Math.min(CHUNK_SIZE, left);
      left -= count;
      tasks.push({ name: cell.name, statistic: cell.statistic, wallets: cell.wallets, chunk: c, count });
      owners.push(ci);
    }
  });
  const chunks = await runPool(tasks, workers);
  return cells.map((cell, ci) => {
    const n = cell.wallets.length;
    if (n === 0) return { name: cell.name, n, estimate: null, intervals: Object.fromEntries(levels.map((l) => [levelKey(l), null])), resamples: 0, dropped: 0 };
    const d = prepare(cell);
    const all = Array.from({ length: n }, (_, i) => i);
    const est = statisticFn(cell.statistic)(d, Int32Array.from(all));
    const parts = [];
    owners.forEach((o, t) => {
      if (o === ci) parts.push(chunks[t]);
    });
    const values = Float64Array.from(parts.flatMap((p) => Array.from(p))).filter(Number.isFinite).sort();
    const dropped = parts.reduce((s, p) => s + p.length, 0) - values.length;
    const intervals = {};
    for (const l of levels) {
      intervals[levelKey(l)] = values.length === 0 ? null : [quantileSorted(values, (1 - l) / 2), quantileSorted(values, 1 - (1 - l) / 2)];
    }
    return { name: cell.name, n, estimate: Number.isFinite(est) ? est : null, intervals, resamples: values.length, dropped };
  });
}

// Run tasks through runChunk, inline for one worker or on a pool of threads.
// The result of task i is at index i whatever the count.
async function runPool(tasks, workers) {
  if (workers <= 1 || tasks.length <= 1) return tasks.map(runChunk);
  const results = new Array(tasks.length);
  const size = Math.min(workers, tasks.length);
  let next = 0;
  const pool = [];
  const url = new URL('./stats-worker.mjs', import.meta.url);
  try {
    await Promise.all(
      Array.from({ length: size }, () => {
        const worker = new Worker(url);
        pool.push(worker);
        return new Promise((resolve, reject) => {
          const feed = () => {
            if (next >= tasks.length) return resolve();
            const id = next++;
            worker.postMessage({ id, task: tasks[id] });
          };
          worker.on('message', ({ id, result }) => {
            results[id] = result;
            feed();
          });
          worker.on('error', reject);
          worker.on('exit', (code) => code !== 0 && reject(new Error(`worker exited ${code}`)));
          feed();
        });
      })
    );
  } finally {
    await Promise.all(pool.map((w) => w.terminate()));
  }
  return results;
}
