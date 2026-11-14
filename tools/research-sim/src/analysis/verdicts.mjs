// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The verdict rules (pre-registration sections 3, 7.5 and 7.6): each outcome's
// result per library from its estimate and 98.75% interval, the result across
// libraries, each question's answer and the two defaults, and the verdict
// document (JSON and Markdown) generated from them. The figures come from
// questions.mjs, computed on the confirmation split only.
//
// Readings. The equivalence band is closed: an interval ending exactly at the
// smallest effect of interest is inside it, and an estimate exactly at the
// smallest effect is "at least" it. The results are tested in the order
// supported, contradicted, no meaningful difference, inconclusive; the first
// and the third can hold together only with the estimate and the interval's
// lower end at exactly minus the smallest effect, and supported then wins. A cell no wallet enters (estimate null) is
// inconclusive. The across-library rules count N as the libraries the study
// holds.
//
// Input-selection default (section 3, "Contradicted"): when question 2 is
// contradicted, the default delegates to the library whose L/layout arm has the
// lowest weighted mean of its wallets' failures per 100 attempted spends
// (selectionFigures); equal means (exact equality of the doubles computed in a
// fixed order) are broken by the lower weighted median of F_layout / F_rule - 1,
// then by the library's place in the library table. A library with no wallet
// in its figure is not a candidate.

import { SESOI, LEVEL_KEYS } from './questions.mjs';
import { insideBand } from './stats.mjs';

export const RESULTS = Object.freeze(['supported', 'contradicted', 'no meaningful difference', 'inconclusive']);

// One outcome's result from the estimate e, the interval [lo, hi] and the
// smallest effect; the claimed direction is negative.
export function classify(e, interval, sesoi) {
  if (e === null || e === undefined || !interval) return 'inconclusive';
  const [lo, hi] = interval;
  if (hi < 0 && e <= -sesoi) return 'supported';
  if (lo > 0 && e >= sesoi) return 'contradicted';
  if (insideBand(lo, hi, sesoi)) return 'no meaningful difference';
  return 'inconclusive';
}

// Across the libraries: `results` is the per-library result in library order.
export function acrossLibraries(results) {
  const N = results.length;
  const count = (r) => results.filter((x) => x === r).length;
  const s = count('supported');
  const c = count('contradicted');
  const n = count('no meaningful difference');
  if (2 * s >= N && N > 0 && c === 0) return 'supported';
  if (2 * c >= N && N > 0 && s === 0) return 'contradicted';
  if (N > 0 && n === N) return 'no meaningful difference';
  return 'inconclusive';
}

// A question's answer from its two outcomes' across-library results.
export function questionAnswer(failures, fees) {
  const rs = [failures, fees];
  const s = rs.filter((r) => r === 'supported').length;
  const c = rs.filter((r) => r === 'contradicted').length;
  if (s > 0 && c === 0) return 'supported';
  if (c > 0 && s === 0) return 'contradicted';
  if (failures === 'no meaningful difference' && fees === 'no meaningful difference') return 'no meaningful difference';
  return 'inconclusive';
}

// The absorption default (section 3): off when the median fee ratio of off
// against on is at most -0.05 with its 95% interval wholly below zero, or the
// mean failure difference on minus off is at least 1 per 100 with its 95%
// interval wholly above zero; on otherwise. `fees` and `failures` are cells of
// runQuestions.
export function absorptionDefault({ fees, failures }) {
  const fi = fees.intervals[LEVEL_KEYS.report];
  const li = failures.intervals[LEVEL_KEYS.report];
  const feesOff = fees.estimate !== null && fi !== null && fees.estimate <= -SESOI.fees && fi[1] < 0;
  const failuresOff = failures.estimate !== null && li !== null && failures.estimate >= SESOI.failures && li[0] > 0;
  return {
    value: feesOff || failuresOff ? 'off' : 'on',
    offByFees: feesOff,
    offByFailures: failuresOff,
    fees: cellFigure(fees, '0.95'),
    failures: cellFigure(failures, '0.95')
  };
}

function cellFigure(cell, level) {
  return { wallets: cell.n, estimate: cell.estimate, interval: cell.intervals[level] };
}

// The input-selection default from question 2's answer and the figures of
// selectionFigures.
export function selectionDefault(answer, figures) {
  if (answer !== 'contradicted') return { value: 'rule', library: null, candidates: figures };
  const cands = figures.map((f, order) => ({ ...f, order })).filter((f) => f.failuresPer100 !== null);
  if (cands.length === 0) return { value: 'rule', library: null, candidates: figures, note: 'no library has a wallet with enough attempted spends' };
  const feeKey = (f) => (f.feeRatio === null ? Infinity : f.feeRatio);
  cands.sort((a, b) => a.failuresPer100 - b.failuresPer100 || feeKey(a) - feeKey(b) || a.order - b.order);
  const best = cands[0];
  const tied = cands.filter((f) => f.failuresPer100 === best.failuresPer100).sort((a, b) => a.order - b.order).map((f) => f.library);
  return { value: 'library', library: best.library, tied, candidates: figures };
}

// verdicts.json's content from runQuestions' result.
export function buildVerdicts(res) {
  const outcomes = {};
  const questions = {};
  for (const question of ['q1', 'q2']) {
    const across = {};
    for (const outcome of ['failures', 'fees']) {
      const sesoi = SESOI[outcome];
      const perLibrary = res.cells
        .filter((c) => c.question === question && c.outcome === outcome)
        .map((c) => ({
          library: c.library,
          wallets: c.n,
          estimate: c.estimate,
          interval9875: c.intervals[LEVEL_KEYS.decision],
          interval95: c.intervals[LEVEL_KEYS.report],
          resamples: c.resamples,
          dropped: c.dropped,
          result: classify(c.estimate, c.intervals[LEVEL_KEYS.decision], sesoi)
        }));
      const result = acrossLibraries(perLibrary.map((p) => p.result));
      const named = (r) => perLibrary.filter((p) => p.result === r).map((p) => p.library);
      across[outcome] = result;
      outcomes[`${question}.${outcome}`] = {
        sesoi,
        perLibrary,
        across: {
          result,
          libraries: {
            supported: named('supported'),
            contradicted: named('contradicted'),
            'no meaningful difference': named('no meaningful difference'),
            inconclusive: named('inconclusive')
          }
        }
      };
    }
    questions[question] = { answer: questionAnswer(across.failures, across.fees), failures: across.failures, fees: across.fees };
  }
  return {
    level: 0.9875,
    libraries: res.libraries.length,
    outcomes,
    questions,
    defaults: {
      absorption: absorptionDefault(res.absorption),
      inputSelection: selectionDefault(questions.q2.answer, res.selection)
    }
  };
}

const NAMES = { 'q1.failures': 'Question 1, failures', 'q1.fees': 'Question 1, fees', 'q2.failures': 'Question 2, failures', 'q2.fees': 'Question 2, fees' };
const num = (x, d = 4) => (x === null || x === undefined ? 'none' : String(Number(x.toFixed(d))));
const ci = (i) => (i ? `[${num(i[0])}, ${num(i[1])}]` : 'none');

// verdicts.md: a fixed template over verdicts.json.
export function renderVerdicts(v) {
  const L = [];
  L.push('# Verdicts', '');
  for (const q of ['q1', 'q2']) {
    L.push(`## Question ${q.slice(1)}`, '');
    L.push(`Question ${q.slice(1)} is ${v.questions[q].answer}: failures ${v.questions[q].failures}, fees ${v.questions[q].fees}.`, '');
    for (const o of ['failures', 'fees']) {
      const out = v.outcomes[`${q}.${o}`];
      L.push(`### ${NAMES[`${q}.${o}`]}`, '');
      L.push(`Across ${v.libraries} libraries the outcome is ${out.across.result}. Smallest effect of interest ${out.sesoi}.`, '');
      for (const r of ['supported', 'contradicted', 'no meaningful difference', 'inconclusive']) L.push(`- ${r}: ${out.across.libraries[r].length === 0 ? 'none' : out.across.libraries[r].join(', ')}`);
      L.push('');
      L.push('| Library | Wallets | Estimate | 98.75% interval | 95% interval | Result |', '|---|---|---|---|---|---|');
      for (const p of out.perLibrary) L.push(`| ${p.library} | ${p.wallets} | ${num(p.estimate)} | ${ci(p.interval9875)} | ${ci(p.interval95)} | ${p.result} |`);
      L.push('');
    }
  }
  const a = v.defaults.absorption;
  L.push('## Defaults', '');
  L.push(`The absorption default is ${a.value}. Fees, off against on: estimate ${num(a.fees.estimate)}, 95% interval ${ci(a.fees.interval)}, ${a.fees.wallets} wallets. Failures per 100, on minus off: estimate ${num(a.failures.estimate)}, 95% interval ${ci(a.failures.interval)}, ${a.failures.wallets} wallets.`, '');
  const s = v.defaults.inputSelection;
  if (s.value === 'rule') L.push(`The input-selection default is the rule, since question 2 is ${v.questions.q2.answer}.`, '');
  else L.push(`The input-selection default delegates to ${s.library}, since question 2 is contradicted; its L/layout arm has the fewest failures per 100 attempted spends.`, '');
  return L.join('\n') + '\n';
}
