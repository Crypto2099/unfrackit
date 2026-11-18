// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The drift slope of one metric over a run's points (section 7.3, H-7). The
// reader computes it once per run so that a wallet table holds three numbers
// where it would hold four arrays.

// A year in seconds, the windows' length (src/history/windows.mjs).
export const YEAR_SECONDS = 365 * 86400;
export const SLOPE_METRICS = Object.freeze(['utxos', 'largestValueBytes', 'lockedAdaPerToken']);

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

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

// The slope of one metric over points { t, <metric> }: the OLS slope over
// (0, start) and the state after each built spend, divided by the start value
// and scaled to a year. None unless the run has at least two built-spend
// points and a positive start value. For locked ADA per token a point with no
// token held is left out of the regression (the measure is undefined there),
// and the slope stays while at least two built-spend points remain.
export function slopeOfPoints(points, metric) {
  if (!points) return null;
  const { t, [metric]: raw } = points;
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

export const slopesOfPoints = (points) => Object.fromEntries(SLOPE_METRICS.map((m) => [m, slopeOfPoints(points, m)]));
