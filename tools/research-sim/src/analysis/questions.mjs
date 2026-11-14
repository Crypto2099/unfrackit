// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Questions 1 and 2 (pre-registration sections 3 and 7.3): the four primary
// outcomes per library and the figures the two defaults rest on, computed
// from per-wallet tables (read.mjs) of one split. The verdict rules that turn
// these figures into results, answers and defaults are in verdicts.mjs.
//
// Arms and pairing (section 7.1). Question 1: A = L/layout, B = L/own, paired
// by repetition. Question 2: A = the rule with absorption on (one run, entering
// every repetition of B), B = L/layout. A run that the replay refused, and a
// wallet lacking an arm, give no value.
//
// Per wallet and repetition: failures y = 100 fail_A / att_A - 100 fail_B /
// att_B, entering when both arms hold at least MIN_SPENDS attempted spends
// (built or failed); fees R = F_A / F_B - 1, F the sum of the wallet-controlled
// fees (walletFee, whole-chain for a chained answer, set by the reader) over
// the intents built in both arms, entering when at least MIN_SPENDS intents are
// built in both. The wallet's value is the mean over its entering repetitions;
// a wallet with none does not enter the cell. The failures cell's estimate is
// the weighted mean, the fees cell's the weighted median (stats.mjs).
//
// Cell names. A bootstrap cell's name is its random stream's seed (stats.mjs),
// so every cell has one stable, unique name and renaming a cell changes its
// interval:
//   <question>/<outcome>/<library>/<A>-vs-<B>
// with question q1 or q2, outcome failures or fees, library the method name,
// and A and B the arms compared (q1: layout-vs-own; q2: on-vs-layout). The
// absorption default's two cells are named
//   absorption/fees/off-vs-on     and     absorption/failures/on-vs-off.
// A later caller that adds a breakdown appends a label as a further path
// segment; it never reuses a name.
//
// Ratio resamples with a zero denominator are dropped and counted by the
// bootstrap (its `dropped`); a fee ratio with a zero F_B (impossible for built
// spends, which pay a fee) is left out of the wallet's mean.

import { bootstrap, weightedMean, weightedMedian } from './stats.mjs';
import { libraryMethods, RULE_METHOD } from './read.mjs';

export const MIN_SPENDS = 5;
export const SESOI = Object.freeze({ failures: 1, fees: 0.05 });
export const LEVEL_KEYS = Object.freeze({ decision: '0.9875', report: '0.95' });

export const QUESTIONS = Object.freeze({
  q1: Object.freeze({ a: 'layout', b: 'own', broadcast: null }),
  q2: Object.freeze({ a: 'on', b: 'layout', broadcast: 'a' })
});

const armOf = (table, method, kind) => table.arms.get(`${method}/${kind}`) || null;
const ruleArm = (table, kind) => table.arms.get(`${RULE_METHOD}/${kind}`) || null;

// The run pairs (runA, runB) of two arms of a wallet. broadcast 'a' pairs A's
// first run with every run of B, 'b' the reverse, null pairs equal repetitions.
export function pairedRuns(armA, armB, broadcast = null) {
  if (!armA || !armB) return [];
  const out = [];
  if (broadcast === 'a' || broadcast === 'b') {
    const one = broadcast === 'a' ? armA : armB;
    const many = broadcast === 'a' ? armB : armA;
    const first = [...one.runs.keys()].sort((x, y) => x - y)[0];
    if (first === undefined) return [];
    for (const rep of [...many.runs.keys()].sort((x, y) => x - y)) {
      const a = broadcast === 'a' ? one.runs.get(first) : many.runs.get(rep);
      const b = broadcast === 'a' ? many.runs.get(rep) : one.runs.get(first);
      out.push([a, b]);
    }
  } else {
    for (const rep of [...armA.runs.keys()].sort((x, y) => x - y)) if (armB.runs.has(rep)) out.push([armA.runs.get(rep), armB.runs.get(rep)]);
  }
  return out.filter(([a, b]) => !a.refused && !b.refused);
}

export const failuresPer100 = (run) => (100 * run.n.failed) / run.n.attempted;

// Per-wallet failures value: the mean over entering repetitions of f_A - f_B.
export function failureValue(armA, armB, broadcast = null) {
  const ys = [];
  for (const [a, b] of pairedRuns(armA, armB, broadcast)) {
    if (a.n.attempted >= MIN_SPENDS && b.n.attempted >= MIN_SPENDS) ys.push(failuresPer100(a) - failuresPer100(b));
  }
  return ys.length === 0 ? null : ys.reduce((s, y) => s + y, 0) / ys.length;
}

// Per-wallet fee value: the mean over entering repetitions of F_A / F_B - 1.
export function feeValue(armA, armB, broadcast = null) {
  const rs = [];
  for (const [a, b] of pairedRuns(armA, armB, broadcast)) {
    let fa = 0n;
    let fb = 0n;
    let n = 0;
    for (const [intent, sa] of a.spends) {
      const sb = b.spends.get(intent);
      if (sa.outcome === 'built' && sb && sb.outcome === 'built') {
        fa += sa.walletFee;
        fb += sb.walletFee;
        n++;
      }
    }
    if (n >= MIN_SPENDS && fb > 0n) rs.push(Number(fa) / Number(fb) - 1);
  }
  return rs.length === 0 ? null : rs.reduce((s, r) => s + r, 0) / rs.length;
}

export const cellName = (question, outcome, library, a, b) => `${question}/${outcome}/${library}/${a}-vs-${b}`;

// The wallets of a cell: { id, group, weight, v: [value] } for each wallet whose
// value is not null.
function cellWallets(tables, valueOf) {
  const out = [];
  for (const t of tables) {
    const v = valueOf(t);
    if (v !== null && v !== undefined) out.push({ id: t.wallet, group: t.group, weight: t.weight.w, v: [v] });
  }
  return out;
}

// The libraries a study holds: those with both arms for some wallet, in
// LIBRARY_TABLE order.
export function studyLibraries(tables) {
  return libraryMethods().filter((m) => tables.some((t) => t.arms.has(`${m}/own`) && t.arms.has(`${m}/layout`)));
}

const STATISTIC = { failures: 'mean', fees: 'median' };

function primarySpecs(tables, libraries) {
  const specs = [];
  for (const [question, { a, b, broadcast }] of Object.entries(QUESTIONS)) {
    for (const library of libraries) {
      for (const outcome of ['failures', 'fees']) {
        const value = outcome === 'failures' ? failureValue : feeValue;
        const armsOf = (t) => (question === 'q1' ? [armOf(t, library, 'layout'), armOf(t, library, 'own')] : [ruleArm(t, 'on'), armOf(t, library, 'layout')]);
        const wallets = cellWallets(tables, (t) => {
          const [x, y] = armsOf(t);
          return value(x, y, broadcast);
        });
        specs.push({ question, outcome, library, name: cellName(question, outcome, library, a, b), statistic: STATISTIC[outcome], wallets });
      }
    }
  }
  return specs;
}

// The absorption default's two figures (section 3): the rule with absorption off
// against on.
function absorptionSpecs(tables) {
  const fees = cellWallets(tables, (t) => feeValue(ruleArm(t, 'off'), ruleArm(t, 'on')));
  const failures = cellWallets(tables, (t) => failureValue(ruleArm(t, 'on'), ruleArm(t, 'off')));
  return [
    { name: 'absorption/fees/off-vs-on', statistic: 'median', wallets: fees },
    { name: 'absorption/failures/on-vs-off', statistic: 'mean', wallets: failures }
  ];
}

// The input-selection default's figures (section 3, "Contradicted"): per library
// the weighted mean over wallets of the per-wallet failures per 100 attempted
// spends of its L/layout arm (the mean over repetitions that hold at least
// MIN_SPENDS attempted spends; a wallet with none does not enter), and the
// weighted median of F_layout / F_rule - 1 that breaks a tie.
export function selectionFigures(tables, libraries) {
  return libraries.map((library) => {
    const f = cellWallets(tables, (t) => {
      const arm = armOf(t, library, 'layout');
      if (!arm) return null;
      const vs = [...arm.runs.values()].filter((r) => !r.refused && r.n.attempted >= MIN_SPENDS).map(failuresPer100);
      return vs.length === 0 ? null : vs.reduce((s, x) => s + x, 0) / vs.length;
    });
    const r = cellWallets(tables, (t) => feeValue(armOf(t, library, 'layout'), ruleArm(t, 'on'), 'b'));
    return {
      library,
      wallets: f.length,
      failuresPer100: weightedMean(f.map((w) => w.v[0]), f.map((w) => w.weight)),
      feeWallets: r.length,
      feeRatio: weightedMedian(r.map((w) => w.v[0]), r.map((w) => w.weight), r.map((w) => w.id))
    };
  });
}

// All figures of the questions on `tables` (one split's wallet tables):
//   { libraries, cells: [{ question, outcome, library, name, n, estimate,
//     intervals: { '0.9875': [lo, hi]|null, '0.95': ... }, resamples, dropped }],
//     absorption: { fees: cell, failures: cell }, selection: [figure] }
// Cells are in a fixed order (q1 then q2, libraries in LIBRARY_TABLE order,
// failures then fees), so the same tables give the same bytes at any worker
// count.
export async function runQuestions(tables, { workers = 1, resamples, libraries = studyLibraries(tables) } = {}) {
  const specs = primarySpecs(tables, libraries);
  const abs = absorptionSpecs(tables);
  const opts = { workers, ...(resamples === undefined ? {} : { resamples }) };
  const out = await bootstrap([...specs, ...abs], opts);
  const cells = specs.map((s, i) => ({ question: s.question, outcome: s.outcome, library: s.library, ...out[i] }));
  const [fees, failures] = out.slice(specs.length);
  return { libraries, cells, absorption: { fees, failures }, selection: selectionFigures(tables, libraries) };
}
