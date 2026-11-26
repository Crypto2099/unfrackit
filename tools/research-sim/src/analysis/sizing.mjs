// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Sizing by simulation on the exploration split (pre-registration section 5.4,
// decision D8): for each primary outcome and library, the smallest effect the
// confirmation analysis would detect with power 0.8.
//
// Procedure, per cell (one outcome of one library, as questions.mjs defines
// it):
//   0. The cell is centered: its exploration point estimate (the cell's own
//      statistic, the weighted mean for failures and the weighted median for
//      fees) is subtracted from every exploration wallet's value, so the
//      effect the exploration wallets already show is not part of the effect
//      detected and the simulated samples are centered at zero.
//   1. The centered per-wallet outcomes of the cell are resampled
//      with replacement within each size group to the group's target: the
//      sample's A_k (the wallets the frame's sample took in group k) times
//      the share e_k of the pilot's group-k wallets that enter the cell,
//      rounded half up; a group no pilot wallet enters has target 0. No
//      confirmation record is read. Each drawn wallet keeps its own weight
//      and value.
//   2. Every simulated wallet is shifted by delta in the claimed direction, which
//      is negative for all four outcomes (fewer failures, a lower fee ratio):
//      v - delta.
//   3. Each of `samples` (1,000) simulated samples is decided with the same
//      bootstrap as the verdicts (stats.mjs), at `resamples` (1,000) resamples:
//      the sample detects the effect when its 98.75% interval lies below zero.
//   4. The reported delta is the smallest one at which at least `power` (0.8,
//      read inclusively: 800 of 1,000) of the samples detect it, found by
//      bisection on [0, hi] until the bracket is at most 0.05 of the outcome's
//      smallest effect of interest (verdicts' SESOI) wide; the upper end of the
//      final bracket is reported. hi starts at the smallest effect and doubles
//      until the power is reached, at most MAX_DOUBLINGS times; if it is not
//      reached the cell reports `reached: false` and a null delta.
//
// Shift equivariance. The statistics (weighted mean, weighted median) and the
// percentile interval shift exactly with the data, so a sample whose
// unshifted 98.75% interval has upper end u detects delta exactly when
// u - delta < 0. Every sample therefore keeps one bootstrap stream whatever
// delta is tried (common random numbers), is bootstrapped once, and the
// bisection tests deltas against the stored upper ends. This decides every
// sample as shifting and bootstrapping again would, up to floating-point
// rounding, and makes the power nondecreasing in delta.
//
// The cell's exploration estimate is reported (`estimate`) with
// `estimateBelowZero`, whether the uncentered estimate was already below zero.
// A delta of 0 can arise only from rounding or a lopsided sample.
//
// Streams. Every random stream is named under the prefix `sizing/`:
//   sizing/<cell>/draw     chunk = sample index: the within-group resample
//   sizing/<cell>/s<NNNNNN> the sample's bootstrap, <NNNNNN> the zero-padded
//                          sample index; stats.mjs cuts it into its own chunks
// with <cell> the questions.mjs cell name (q1/failures/csl-lf/layout-vs-own).
// Questions' own cells are never prefixed `sizing/`, so no name is reused.
// Results do not depend on the number of workers.

import { bootstrap, seedFor, weightedMean, weightedMedian } from './stats.mjs';
import { makeRng } from '../shapes/rng.mjs';
import { failureValue, feeValue, studyLibraries, cellName, QUESTIONS, SESOI } from './questions.mjs';
import { RULE_METHOD } from './read.mjs';

export const SAMPLES = 1000;
export const RESAMPLES = 1000;
export const POWER = 0.8;
export const TOLERANCE = 0.05;
export const MAX_DOUBLINGS = 6;
export const LEVEL = '0.9875';
const BATCH = 50;

const STATISTIC = { failures: 'mean', fees: 'median' };
const armOf = (t, method, kind) => t.arms.get(`${method}/${kind}`) || null;

// The cell's exploration point estimate, by the cell's statistic (questions.mjs).
export function pointEstimate(statistic, wallets) {
  const v = wallets.map((w) => w.v[0]);
  const w = wallets.map((x) => x.weight);
  return statistic === 'median' ? weightedMedian(v, w, wallets.map((x) => x.id)) : weightedMean(v, w);
}

// Wallets by size group: { B1: n, ... }, keys in group order.
export function groupCounts(wallets) {
  const out = {};
  for (const g of [...new Set(wallets.map((w) => w.group))].sort()) out[g] = wallets.filter((w) => w.group === g).length;
  return out;
}

// One simulated sample: for each group of `counts` (in sorted order), that many
// wallets drawn with replacement from `wallets` of the group. Returns null when
// a group with a positive count has no wallet to draw from. Ids are unique
// (the draw position), so the bootstrap's order does not depend on the source.
export function resampleWallets(wallets, counts, name, sample) {
  const rng = makeRng(seedFor(name, sample));
  const byGroup = new Map();
  for (const w of [...wallets].sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))) {
    if (!byGroup.has(w.group)) byGroup.set(w.group, []);
    byGroup.get(w.group).push(w);
  }
  const out = [];
  for (const g of Object.keys(counts).sort()) {
    const pool = byGroup.get(g) || [];
    if (counts[g] > 0 && pool.length === 0) return null;
    for (let k = 0; k < counts[g]; k++) {
      const src = pool[Math.floor(rng.next() * pool.length)];
      out.push({ id: `${g}.${String(k).padStart(6, '0')}`, group: g, weight: src.weight, v: [src.v[0]] });
    }
  }
  return out;
}

const hits = (uppers, delta) => uppers.reduce((s, u) => s + (u - delta < 0 ? 1 : 0), 0);

// The share of samples that detect delta, given the samples' unshifted upper ends.
export const powerAt = (uppers, delta) => (uppers.length === 0 ? 0 : hits(uppers, delta) / uppers.length);

// The bisection of step 4 over the samples' upper ends. A sample with no
// interval has upper end Infinity and never detects. Returns
// { delta, reached, atZero, power, steps, resolution }.
export function detectableDelta(uppers, { sesoi, power = POWER, tolerance = TOLERANCE, maxDoublings = MAX_DOUBLINGS } = {}) {
  const tol = tolerance * sesoi;
  const enough = (d) => powerAt(uppers, d) >= power;
  if (enough(0)) return { delta: 0, reached: true, atZero: true, power: powerAt(uppers, 0), steps: 0, resolution: tol };
  let lo = 0;
  let hi = sesoi;
  let steps = 0;
  for (let k = 0; !enough(hi); k++) {
    if (k >= maxDoublings) return { delta: null, reached: false, atZero: false, power: powerAt(uppers, hi), steps, resolution: tol };
    lo = hi;
    hi *= 2;
    steps++;
  }
  while (hi - lo > tol) {
    const mid = (lo + hi) / 2;
    if (enough(mid)) hi = mid;
    else lo = mid;
    steps++;
  }
  return { delta: hi, reached: true, atZero: false, power: powerAt(uppers, hi), steps, resolution: tol };
}

// The upper ends of the 98.75% intervals of `samples` simulated samples of one
// cell: [Infinity] entries where a sample gave no interval. `source` are the
// exploration wallets { id, group, weight, v: [value] }, `counts` the
// confirmation group counts. Null when a group cannot be drawn.
export async function sampleUpperEnds({ name, statistic, source, counts }, { workers = 1, samples = SAMPLES, resamples = RESAMPLES } = {}) {
  const uppers = [];
  for (let first = 0; first < samples; first += BATCH) {
    const cells = [];
    for (let s = first; s < Math.min(samples, first + BATCH); s++) {
      const wallets = resampleWallets(source, counts, `${name}/draw`, s);
      if (wallets === null) return null;
      cells.push({ name: `${name}/s${String(s).padStart(6, '0')}`, statistic, wallets });
    }
    const out = await bootstrap(cells, { workers, resamples, levels: [Number(LEVEL)] });
    for (const o of out) {
      const iv = o.intervals[LEVEL];
      uppers.push(iv ? iv[1] : Infinity);
    }
  }
  return uppers;
}

// The cells of the four primary outcomes on `tables`: { question, outcome,
// library, name, statistic, wallets } with wallets { id, group, weight, v }.
function cellsOf(tables, libraries) {
  const specs = [];
  for (const [question, { a, b, broadcast }] of Object.entries(QUESTIONS)) {
    for (const library of libraries) {
      for (const outcome of ['failures', 'fees']) {
        const value = outcome === 'failures' ? failureValue : feeValue;
        const wallets = [];
        for (const t of tables) {
          const x = question === 'q1' ? armOf(t, library, 'layout') : armOf(t, RULE_METHOD, 'on');
          const y = question === 'q1' ? armOf(t, library, 'own') : armOf(t, library, 'layout');
          const v = value(x, y, broadcast);
          if (v !== null && v !== undefined) wallets.push({ id: t.wallet, group: t.group, weight: t.weight.w, v: [v] });
        }
        specs.push({ question, outcome, library, name: cellName(question, outcome, library, a, b), statistic: STATISTIC[outcome], wallets });
      }
    }
  }
  return specs;
}

// The target of a size group in a cell (decision of 2026-11-15): the sample's
// A_k times the share of the pilot's group-k wallets entering the cell,
// rounded half up: floor((2 A entering + total) / (2 total)), in integers. A
// group with no pilot wallet, or none entering, has target 0.
export function groupTarget(sampleTaken, entering, total) {
  if (!(total > 0) || !(entering > 0) || !(sampleTaken > 0)) return 0;
  return Math.floor((2 * sampleTaken * entering + total) / (2 * total));
}

// The targets of a cell: per group of the sample, { sample, entering, total,
// share, target }, in group order.
export function cellTargets(sample, enteringByGroup, totalByGroup) {
  const out = {};
  for (const g of Object.keys(sample).sort()) {
    const entering = enteringByGroup[g] || 0;
    const total = totalByGroup[g] || 0;
    out[g] = { sample: sample[g], entering, total, share: total > 0 ? entering / total : 0, target: groupTarget(sample[g], entering, total) };
  }
  return out;
}

// The sizing of every primary outcome and library. `pilot` are the wallet
// tables of the pilot (read.mjs, the exploration split of the recent window);
// `sample` maps each size group to A_k, the wallets the frame's sample took in
// it. Returns the content of sizing.json:
//   { format, level, direction, samples, resamples, power, tolerance, libraries, cells: [{ question,
//     outcome, library, name, sesoi, exploration: { wallets, groups },
//     targets: { <group>: { sample, entering, total, share, target } }, targetWallets,
//     estimate, estimateBelowZero, delta, deltaOverSesoi, reached,
//     power, steps, resolution, reason? }] }
// A cell no pilot wallet enters, or whose targets are all 0, has a null delta
// and a `reason`.
export async function runSizing(pilot, sample, { workers = 1, samples = SAMPLES, resamples = RESAMPLES, libraries, power = POWER, tolerance = TOLERANCE } = {}) {
  const libs = libraries || studyLibraries(pilot);
  const ex = cellsOf(pilot, libs);
  const totals = groupCounts(pilot.map((t) => ({ group: t.group })));
  const cells = [];
  for (const e of ex) {
    const entering = groupCounts(e.wallets);
    const targets = cellTargets(sample, entering, totals);
    const counts = Object.fromEntries(Object.entries(targets).map(([g, t]) => [g, t.target]));
    const targetWallets = Object.values(counts).reduce((a, b) => a + b, 0);
    const sesoi = SESOI[e.outcome];
    const row = {
      question: e.question,
      outcome: e.outcome,
      library: e.library,
      name: `sizing/${e.name}`,
      sesoi,
      exploration: { wallets: e.wallets.length, groups: entering },
      targets,
      targetWallets
    };
    let reason = null;
    let uppers = null;
    let estimate = null;
    if (e.wallets.length === 0) reason = 'no pilot wallet enters the cell';
    else if (targetWallets === 0) reason = 'every group\'s target is 0';
    else {
      estimate = pointEstimate(e.statistic, e.wallets);
      const centered = e.wallets.map((w) => ({ ...w, v: [w.v[0] - estimate] }));
      uppers = await sampleUpperEnds({ name: `sizing/${e.name}`, statistic: e.statistic, source: centered, counts }, { workers, samples, resamples });
      if (uppers === null) reason = 'a group with a target has no pilot wallet to draw from';
    }
    if (reason !== null) cells.push({ ...row, estimate, estimateBelowZero: estimate !== null && estimate < 0, delta: null, deltaOverSesoi: null, reached: false, power: null, steps: 0, resolution: tolerance * sesoi, reason });
    else {
      const d = detectableDelta(uppers, { sesoi, power, tolerance });
      cells.push({ ...row, estimate, estimateBelowZero: estimate < 0, delta: d.delta, deltaOverSesoi: d.delta === null ? null : d.delta / sesoi, reached: d.reached, power: d.power, steps: d.steps, resolution: d.resolution });
    }
  }
  return { format: 2, level: LEVEL, direction: 'negative', samples, resamples, power, tolerance, libraries: libs, cells };
}

export const renderSizing = (res) => JSON.stringify(res, null, 2) + '\n';
