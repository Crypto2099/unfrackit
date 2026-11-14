// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The descriptive measures of section 7.3: H-7 (drift), H-8 (census), H-9
// (conforming share) and H-11 (change against selection), computed from
// per-wallet tables (read.mjs) and census rows. Nothing here filters by split:
// the caller passes the tables it wants analyzed.
//
// Cell names. Every bootstrap cell has a stable, unique name under its own
// prefix (stats.mjs seeds a cell's stream from its name):
//   h7/<window>/slope/<metric>/<arm>          metric: utxos, largestValueBytes,
//                                             lockedAdaPerToken; arm: <method>/<own|layout|on|off>
//   h9/<window>/share/<arm>                   and h9/<window>/share-no-coin/<arm>
//   h9/<window>/diff/<library>                and h9/<window>/diff-no-coin/<library>
//   h11/<window>/<outcome>/<library>          outcome: failures, fees
// The three H-11 cells of one outcome and library share that one name on
// purpose: one stream, so the change effect, the selection effect and their
// difference are computed on the same resamples.
// Intervals are percentile intervals at 95% (section 7.3), keyed '0.95'.
//
// Cells under minWallets (10) wallets are written with their count and no
// estimate (section 7.1's ten-wallet rule).

import { bootstrap, quantiles, weightedMean, weightedShare, LEVEL_REPORT, MIN_CELL_WALLETS } from './stats.mjs';
import { armIds, libraryMethods, RULE_METHOD } from './read.mjs';
import { pairedRuns, failuresPer100, MIN_SPENDS } from './questions.mjs';
import { LIBRARY_TABLE } from '../arms/plan.mjs';

const LEVEL = String(LEVEL_REPORT);
const RANDOM = new Set(LIBRARY_TABLE.filter((r) => r.random).map((r) => r.method));
// A year in seconds, the windows' length (src/history/windows.mjs).
export const YEAR_SECONDS = 365 * 86400;
export const SLOPE_METRICS = Object.freeze(['utxos', 'largestValueBytes', 'lockedAdaPerToken']);
export const CENSUS_PERCENTILES = Object.freeze([1, 5, 10, 25, 50, 75, 90, 95, 99]);
// The ADA bins of src/history/reports.mjs: bin i starts at ADA_BINS[i] ADA.
export const ADA_BINS = Object.freeze([0, 1, 2, 5, 10, 20, 50, 100, 1000]);

const wallet = (t, v) => ({ id: t.wallet, group: t.group, weight: t.weight.w, v });
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

// Bootstrap the cells that reach minWallets wallets and give the rest back
// with their counts. entries: [{ name, statistic, wallets }]; the answer is in
// the same order: { name, n, suppressed, estimate, interval, resamples, dropped }.
async function bootstrapEntries(entries, { workers = 1, resamples, minWallets = MIN_CELL_WALLETS } = {}) {
  const live = entries.filter((e) => e.wallets.length >= minWallets && e.wallets.length > 0);
  const opts = { workers, levels: [LEVEL_REPORT], ...(resamples === undefined ? {} : { resamples }) };
  const out = await bootstrap(live, opts);
  const byEntry = new Map(live.map((e, i) => [e, out[i]]));
  return entries.map((e) => {
    const r = byEntry.get(e);
    if (!r) return { name: e.name, n: e.wallets.length, suppressed: true, estimate: null, interval: null, resamples: 0, dropped: 0 };
    return { name: e.name, n: r.n, suppressed: false, estimate: r.estimate, interval: r.intervals[LEVEL], resamples: r.resamples, dropped: r.dropped };
  });
}

const shareCell = (flags, weights, minWallets) => {
  const n = flags.length;
  const flagged = flags.filter(Boolean).length;
  if (n < minWallets || n === 0) return { n, flagged, suppressed: true, share: null, effectiveN: null, interval: null };
  const s = weightedShare(flags, weights);
  return { n, flagged, suppressed: false, share: s.share, effectiveN: s.n, interval: s.interval };
};

// The arms the tables hold, in the reader's order.
function armsOf(tables) {
  return armIds().filter((id) => tables.some((t) => t.arms.has(id)));
}
const armMeta = (id) => {
  const [method, kind] = id.split('/');
  return { arm: id, method, kind, random: RANDOM.has(method) };
};

// ---------------------------------------------------------------------------
// H-7, drift (section 3, section 7.3)

// The flags a wallet carries in one arm. Runs the replay refused have no H-7
// fields and are not counted. A wallet is made worse (or crosses a line) when
// it is so in at least half of the arm's runs; `anyRun` is so in at least one.
// null when the arm has no run with H-7 fields (the wallet is not in the drift
// population for the arm).
const DRIFT_FLAGS = Object.freeze({
  worse: (h) => h.worse,
  e1: (h) => h.e1[0.8],
  e2: (h) => h.e2.worse,
  e3: (h) => h.e3.worse,
  e1At50: (h) => h.e1[0.5],
  e1At90: (h) => h.e1[0.9]
});

export function driftFlags(arm) {
  const runs = [...arm.runs.values()].filter((r) => !r.refused && r.h7);
  if (runs.length === 0) return null;
  const out = { runs: runs.length };
  for (const [k, f] of Object.entries(DRIFT_FLAGS)) {
    const hits = runs.filter((r) => f(r.h7)).length;
    out[k] = 2 * hits >= runs.length;
    if (k === 'worse') out.worseAnyRun = hits >= 1;
  }
  return out;
}

// Ordinary least squares slope of y on t; null when the t values do not vary.
export function olsSlope(t, y) {
  const n = t.length;
  if (n < 2) return null;
  const tm = mean(t);
  const ym = mean(y);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (t[i] - tm) * (t[i] - tm);
    sxy += (t[i] - tm) * (y[i] - ym);
  }
  return sxx > 0 ? sxy / sxx : null;
}

// A run's drift slope of one metric: the OLS slope over (0, start) and the
// state after each built spend, divided by the start value and scaled to a
// year. None unless the run has at least two built-spend points and a positive
// start value. For locked ADA per token a point with no token held is left out
// of the regression (the measure is undefined there), and the slope stays while
// at least two built-spend points remain.
export function runSlope(run, metric) {
  if (run.refused || !run.points) return null;
  const { t, [metric]: raw } = run.points;
  const y = raw.map((v) => (v === null || v === undefined ? null : Number(v)));
  const start = y[0];
  if (start === null || !(start > 0)) return null;
  const ts = [t[0]];
  const ys = [start];
  let built = 0;
  for (let i = 1; i < y.length; i++) {
    if (y[i] === null) continue;
    ts.push(t[i]);
    ys.push(y[i]);
    built++;
  }
  if (built < 2) return null;
  const slope = olsSlope(ts, ys);
  return slope === null ? null : (slope / start) * YEAR_SECONDS;
}

// A wallet's slope in an arm: the mean over the runs that have one.
export function walletSlope(arm, metric) {
  const s = [...arm.runs.values()].map((r) => runSlope(r, metric)).filter((v) => v !== null);
  return s.length === 0 ? null : mean(s);
}

// Per arm: the drift population, the weighted shares made materially worse (E1
// at 0.8, E2, E3 alone and together, E1 at 0.5 and 0.9, the share in any run)
// with Wilson intervals, and the weighted median slope of each metric with its
// 95% bootstrap interval.
export async function runDrift(tables, { workers = 1, resamples, window = 'recent', minWallets = MIN_CELL_WALLETS } = {}) {
  const ids = armsOf(tables);
  const arms = [];
  const entries = [];
  for (const id of ids) {
    const meta = armMeta(id);
    const pop = [];
    for (const t of tables) {
      const arm = t.arms.get(id);
      const f = arm ? driftFlags(arm) : null;
      if (f) pop.push({ t, f });
    }
    const weights = pop.map((p) => p.t.weight.w);
    const shares = {};
    for (const k of ['worse', 'e1', 'e2', 'e3', 'e1At50', 'e1At90']) shares[k] = shareCell(pop.map((p) => p.f[k]), weights, minWallets);
    if (meta.random) shares.worseAnyRun = shareCell(pop.map((p) => p.f.worseAnyRun), weights, minWallets);
    const slopes = {};
    for (const metric of SLOPE_METRICS) {
      const wallets = [];
      for (const t of tables) {
        const arm = t.arms.get(id);
        const s = arm ? walletSlope(arm, metric) : null;
        if (s !== null) wallets.push(wallet(t, [s]));
      }
      entries.push({ name: `h7/${window}/slope/${metric}/${id}`, statistic: 'median', wallets, into: slopes, metric });
    }
    arms.push({ ...meta, wallets: pop.length, shares, slopes });
  }
  const out = await bootstrapEntries(entries, { workers, resamples, minWallets });
  entries.forEach((e, i) => {
    e.into[e.metric] = out[i];
  });
  return { window, arms };
}

// ---------------------------------------------------------------------------
// H-8, census (section 3, section 7.3)

// Adjacent bins merged from the tails inward until every cell holds at least
// minWallets wallets: the underfull bin nearest an end goes first (the lower
// end on a tie) and joins its neighbor toward the center; the exact middle
// bin of an odd count joins the smaller neighbor (the lower on a tie). One bin
// left under the minimum stays, and the caller treats it as suppressed.
export function mergeBins(bins, minWallets = MIN_CELL_WALLETS) {
  const b = bins.map((x) => ({ ...x }));
  for (;;) {
    if (b.length < 2) return b;
    let pick = -1;
    let depth = Infinity;
    for (let i = 0; i < b.length; i++) {
      if (b[i].n >= minWallets) continue;
      const d = Math.min(i, b.length - 1 - i);
      if (d < depth) {
        depth = d;
        pick = i;
      }
    }
    if (pick < 0) return b;
    const fromEnd = b.length - 1 - pick;
    let to;
    if (pick < fromEnd) to = pick + 1;
    else if (pick > fromEnd) to = pick - 1;
    else to = b[pick - 1].n <= b[pick + 1].n ? pick - 1 : pick + 1;
    const lo = Math.min(pick, to);
    const hi = Math.max(pick, to);
    b.splice(lo, 2, { lo: b[lo].lo, hi: b[hi].hi, n: b[lo].n + b[hi].n });
  }
}

// Bins of powers of two over non-negative integers: [0, 1), then [2^k, 2^(k+1)),
// from the lowest to the highest occupied bin with the empty ones between.
function powerOfTwoBins(values) {
  if (values.length === 0) return [];
  const k = (v) => (v < 1 ? -1 : Math.floor(Math.log2(v)));
  const counts = new Map();
  for (const v of values) counts.set(k(v), (counts.get(k(v)) || 0) + 1);
  const keys = [...counts.keys()];
  const lo = Math.min(...keys);
  const hi = Math.max(...keys);
  const bins = [];
  for (let j = lo; j <= hi; j++) bins.push(j < 0 ? { lo: 0, hi: 1, n: counts.get(j) || 0 } : { lo: 2 ** j, hi: 2 ** (j + 1), n: counts.get(j) || 0 });
  return bins;
}

// ADA bins in lovelace: [ADA_BINS[i], ADA_BINS[i+1]) ADA, the last open ended
// (hi null). Every bin of the list is kept before merging.
function adaBins(values) {
  const bins = ADA_BINS.map((a, i) => ({ lo: BigInt(a) * 1000000n, hi: i + 1 < ADA_BINS.length ? BigInt(ADA_BINS[i + 1]) * 1000000n : null, n: 0 }));
  for (const v of values) {
    let k = 0;
    for (let i = 0; i < bins.length; i++) if (v >= bins[i].lo) k = i;
    bins[k].n++;
  }
  return bins;
}

const lovelaceBin = (b) => ({ fromLovelace: b.lo.toString(), toLovelace: b.hi === null ? null : b.hi.toString(), n: b.n });
const plainBin = (b) => ({ from: b.lo, to: b.hi, n: b.n });
const ratioBig = (a, b) => (b > 0n ? Number((a * 1000000000n) / b) / 1e9 : null);

// One population's census summary. rows: readCensus rows.
export function censusSummary(rows, { minWallets = MIN_CELL_WALLETS } = {}) {
  const n = rows.length;
  if (n < minWallets || n === 0) return { n, suppressed: true };
  const quantityOf = {
    utxos: { values: rows.map((r) => r.utxos), lovelace: false },
    largestValueBytes: { values: rows.map((r) => r.largestValueBytes), lovelace: false },
    lockedAda: { values: rows.map((r) => r.lockedAda), lovelace: true },
    excessAda: { values: rows.map((r) => r.excessAda), lovelace: true }
  };
  const quantities = {};
  for (const [name, { values, lovelace }] of Object.entries(quantityOf)) {
    const qs = quantiles(values.map(Number), CENSUS_PERCENTILES.map((p) => p / 100));
    const bins = lovelace ? mergeBins(adaBins(values), minWallets).map(lovelaceBin) : mergeBins(powerOfTwoBins(values), minWallets).map(plainBin);
    quantities[name] = { quantiles: Object.fromEntries(CENSUS_PERCENTILES.map((p, i) => [`p${p}`, qs[i]])), bins };
  }
  const share = (k) => {
    const c = rows.filter((r) => r[k]).length;
    return { n: c, share: c / n };
  };
  const withCoin = rows.filter((r) => r.coin !== null && r.coin !== undefined);
  const sum = (key) => withCoin.reduce((s, r) => s + r[key], 0n);
  const coin = sum('coin');
  const locked = sum('lockedAda');
  const excess = sum('excessAda');
  return {
    n,
    suppressed: false,
    quantities,
    nearCap: { nearCap50: share('nearCap50'), nearCap80: share('nearCap80'), nearCap90: share('nearCap90') },
    adaWeighted: {
      wallets: withCoin.length,
      walletsWithoutCoin: n - withCoin.length,
      coin: coin.toString(),
      lockedAda: locked.toString(),
      excessAda: excess.toString(),
      lockedShare: ratioBig(locked, coin),
      excessShare: ratioBig(excess, coin)
    }
  };
}

// The census of both populations, labeled: the token-holding eligible wallets
// (tokenUtxos > 0) and all eligible wallets (ADA-only ones included).
export function runCensus(rows, { minWallets = MIN_CELL_WALLETS } = {}) {
  return {
    populations: {
      tokenHolding: { label: 'eligible wallets holding a token UTxO', ...censusSummary(rows.filter((r) => r.tokenUtxos > 0), { minWallets }) },
      allEligible: { label: 'every eligible wallet, ADA-only ones included', ...censusSummary(rows, { minWallets }) }
    }
  };
}

// ---------------------------------------------------------------------------
// H-9, conforming share (section 3, section 7.3)

const CONFORM_KEYS = Object.freeze({ withCoin: 'conforming', noCoin: 'conformingNoCoin' });

// A run's share of token UTxOs that conform; null for a refused run or one
// whose end state holds no token UTxO.
export function conformingShareOf(run, key = 'conforming') {
  const c = run.refused ? null : run.summary && run.summary.conformity;
  if (!c || !(c.tokenUtxos > 0)) return null;
  return c[key] / c.tokenUtxos;
}

// A wallet's share in an arm: the mean over the runs that have one.
export function walletShare(arm, key = 'conforming') {
  const s = [...arm.runs.values()].map((r) => conformingShareOf(r, key)).filter((v) => v !== null);
  return s.length === 0 ? null : mean(s);
}

// The per-wallet difference of two arms: the mean over the repetitions where
// both runs have a share (the runs paired by repetition).
export function shareDifference(armA, armB, key = 'conforming') {
  const d = [];
  for (const [a, b] of pairedRuns(armA, armB)) {
    const x = conformingShareOf(a, key);
    const y = conformingShareOf(b, key);
    if (x !== null && y !== null) d.push(x - y);
  }
  return d.length === 0 ? null : mean(d);
}

export async function runConforming(tables, { workers = 1, resamples, window = 'recent', minWallets = MIN_CELL_WALLETS, libraries = libraryMethods().filter((m) => tables.some((t) => t.arms.has(`${m}/own`) && t.arms.has(`${m}/layout`))) } = {}) {
  const entries = [];
  const arms = [];
  for (const id of armsOf(tables)) {
    const meta = armMeta(id);
    const rec = { ...meta, share: {}, noTokenUtxo: 0, wallets: 0 };
    for (const t of tables) {
      const arm = t.arms.get(id);
      if (!arm) continue;
      const runs = [...arm.runs.values()].filter((r) => !r.refused && r.summary);
      if (runs.length === 0) continue;
      rec.wallets++;
      if (walletShare(arm) === null) rec.noTokenUtxo++;
    }
    for (const [label, key] of Object.entries(CONFORM_KEYS)) {
      const wallets = [];
      for (const t of tables) {
        const arm = t.arms.get(id);
        const s = arm ? walletShare(arm, key) : null;
        if (s !== null) wallets.push(wallet(t, [s]));
      }
      const name = `h9/${window}/${label === 'withCoin' ? 'share' : 'share-no-coin'}/${id}`;
      entries.push({ name, statistic: 'mean', wallets, into: rec.share, metric: label });
    }
    arms.push(rec);
  }
  const differences = libraries.map((library) => ({ library, difference: {} }));
  for (const rec of differences) {
    for (const [label, key] of Object.entries(CONFORM_KEYS)) {
      const wallets = [];
      for (const t of tables) {
        const d = shareDifference(t.arms.get(`${rec.library}/layout`), t.arms.get(`${rec.library}/own`), key);
        if (d !== null) wallets.push(wallet(t, [d]));
      }
      entries.push({ name: `h9/${window}/${label === 'withCoin' ? 'diff' : 'diff-no-coin'}/${rec.library}`, statistic: 'mean', wallets, into: rec.difference, metric: label });
    }
  }
  const out = await bootstrapEntries(entries, { workers, resamples, minWallets });
  entries.forEach((e, i) => {
    e.into[e.metric] = out[i];
  });
  return { window, arms, differences };
}

// ---------------------------------------------------------------------------
// H-11, change against selection (section 3, section 7.3)

const totalWalletFee = (run) => {
  let f = 0n;
  for (const s of run.spends.values()) if (s.outcome === 'built') f += s.walletFee;
  return Number(f);
};

// A wallet's means per arm and outcome for a library, over the repetitions r in
// which L/own r, L/layout r and the rule (absorption on, its one run entering
// every r) each hold at least MIN_SPENDS attempted spends; null when no r
// qualifies. Failures per 100 attempted spends, and the total wallet-controlled
// fee (lovelace, whole-chain for a chained answer) over all of an arm's built
// spends, not paired.
export function changeSelectionValues(table, library) {
  const own = table.arms.get(`${library}/own`);
  const layout = table.arms.get(`${library}/layout`);
  const ruleArm = table.arms.get(`${RULE_METHOD}/on`);
  if (!own || !layout || !ruleArm) return null;
  const first = [...ruleArm.runs.keys()].sort((x, y) => x - y)[0];
  const rule = first === undefined ? null : ruleArm.runs.get(first);
  if (!rule || rule.refused || rule.n.attempted < MIN_SPENDS) return null;
  const reps = [];
  for (const rep of [...own.runs.keys()].sort((x, y) => x - y)) {
    const a = own.runs.get(rep);
    const b = layout.runs.get(rep);
    if (!b || a.refused || b.refused) continue;
    if (a.n.attempted >= MIN_SPENDS && b.n.attempted >= MIN_SPENDS) reps.push([a, b]);
  }
  if (reps.length === 0) return null;
  const m = (f) => ({ own: mean(reps.map(([a]) => f(a))), layout: mean(reps.map(([, b]) => f(b))), rule: mean(reps.map(() => f(rule))) });
  return { repetitions: reps.length, failures: m(failuresPer100), fees: m(totalWalletFee) };
}

// Per library and outcome: the change effect |m(L/layout) - m(L/own)|, the
// selection effect |m(rule) - m(L/layout)| and the change effect minus the
// selection effect, m the weighted mean over the qualifying wallets, each with
// its 95% bootstrap interval, the three on the same resample.
export async function runChangeSelection(tables, { workers = 1, resamples, window = 'recent', minWallets = MIN_CELL_WALLETS, libraries = libraryMethods().filter((m) => tables.some((t) => t.arms.has(`${m}/own`) && t.arms.has(`${m}/layout`))) } = {}) {
  const entries = [];
  const rows = [];
  for (const library of libraries) {
    const vals = tables.map((t) => [t, changeSelectionValues(t, library)]).filter(([, v]) => v);
    for (const outcome of ['failures', 'fees']) {
      const wallets = vals.map(([t, v]) => wallet(t, [v[outcome].layout - v[outcome].own, v[outcome].rule - v[outcome].layout]));
      const name = `h11/${window}/${outcome}/${library}`;
      const row = { library, outcome, wallets: wallets.length, means: null, change: null, selection: null, difference: null };
      if (wallets.length > 0) {
        const w = vals.map(([t]) => t.weight.w);
        row.means = Object.fromEntries(['own', 'layout', 'rule'].map((a) => [a, weightedMean(vals.map(([, v]) => v[outcome][a]), w)]));
      }
      entries.push({ name, statistic: 'absMean', wallets, into: row, metric: 'change' }, { name, statistic: 'h11Selection', wallets, into: row, metric: 'selection' }, { name, statistic: 'h11Difference', wallets, into: row, metric: 'difference' });
      rows.push(row);
    }
  }
  const out = await bootstrapEntries(entries, { workers, resamples, minWallets });
  entries.forEach((e, i) => {
    e.into[e.metric] = out[i];
  });
  return { window, rows };
}

// All four, for one split's tables and the census rows. census may be null.
export async function runDescriptive(tables, census, opts = {}) {
  return {
    h7: await runDrift(tables, opts),
    h8: census ? runCensus(census, opts) : null,
    h9: await runConforming(tables, opts),
    h11: await runChangeSelection(tables, opts)
  };
}
