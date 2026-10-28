// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Run plans: which arms run in which window, under which selectors, change
// policies, collateral rules and repetitions. The command line expands a plan
// into jobs, one per (wallet, arm, variant, selector, change policy,
// collateral rule, repetition).
//
// Selectors are named by role, so that a plan is the study's for the
// baselines and a test plan for the test method:
//   lf      cardano-serialization-lib Largest-First (deterministic)
//   ri      cardano-serialization-lib random selection
//   rrri    cardano-js-sdk round-robin Random-Improve, seeded: the primary
//           selector of H-2 to H-6 and H-9
//   evo     the Evolution SDK default (deterministic), H-7 and H-12 only
//   lf-pure, ri-pure  lf and ri with prefer_pure_change set: the sensitivity
//           arm on change policy, in the snapshot battery only
// Repetitions: 30 for a random selector in H-1's arms (observed, tidy-once,
// maintained-tidy and the controls), at the snapshot, and for H-9's tidy-once
// arm; 10 in the layout variants and H-11's factorial; one run for each
// deterministic selector. Repetition r runs the seeded selector with seed r
// and any random layout with seed r, so arms compared with each other share
// one seed sequence (common random numbers).
//
// Recent window: H-1's three arms under the three baselines; H-1's two
// controls under the primary selector; the observed arm under the Evolution
// SDK default (H-7's drift); H-2's groupings and byte-optimal packing, H-3's
// six bundle sizes, H-4's three layouts (tidy-once) and H-6's thresholds and
// never-propose arm (maintained-tidy), each under the primary selector with
// Largest-First as sensitivity; H-5's reserve rules (maintained-tidy) under the
// primary selector, with Largest-First and random selection as sensitivity;
// H-9's tidy-once arm under the primary selector with its default and the
// layout-preserving change.
// Peak window: H-1's arms and controls, the Evolution SDK's observed arm, H-5's
// reserve rules, and H-11's factorial (the observed arm, the three baselines
// crossed with the single, layout-preserving and naive change).
// Each arm runs under the ledger and practice collateral rules, with the ledger
// minimum and token-bearing collateral as sensitivity arms, when the wallet's
// window holds a script interaction; otherwise the rule has nothing to decide
// and the arm runs once, its collateral field 'none-needed'.

import { COLLATERAL_RULES } from '../replay/collateral.mjs';

export const STUDY_ROLES = Object.freeze({ lf: 'csl-lf', ri: 'csl-ri', rrri: 'cjs-rrri', evo: 'evo-lf', 'lf-pure': 'csl-lf-pure', 'ri-pure': 'csl-ri-pure' });
export const TEST_ROLES = Object.freeze({ lf: 'test-largest-first', ri: 'test-largest-first', rrri: 'test-largest-first', evo: 'test-largest-first', 'lf-pure': 'test-largest-first', 'ri-pure': 'test-largest-first' });
const DETERMINISTIC_ROLES = new Set(['lf', 'evo', 'lf-pure']);
const BASELINES = ['lf', 'ri', 'rrri'];

const H1 = { arms: ['observed', 'tidy-once', 'maintained-tidy'], controls: ['naive-tidy', 'random-tidy'] };
const H2 = ['default', 'grouping-arrival', 'grouping-policy-arrival', 'grouping-random', 'byte-optimal'];
const H3 = ['bundle-1', 'bundle-5', 'bundle-10', 'bundle-30', 'bundle-60', 'bundle-cap'];
const H4 = ['default', 'isolation-asset', 'isolation-policy'];
const H5 = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6'];
const H6 = ['default', 'never-propose', 'dust-1', 'band-3-6', 'band-5-20'];

// The plan's entries for a window: [{ hypothesis, arm, variant, role, change,
// repetitions, policyLock }]. reps: { h1, variants } overrides (tests).
export function windowPlan(window, { reps = {} } = {}) {
  const R1 = reps.h1 ?? 30;
  const RV = reps.variants ?? 10;
  const n = (role, r) => (DETERMINISTIC_ROLES.has(role) ? 1 : r);
  const out = [];
  const add = (hypothesis, arm, variant, role, change, repetitions, extra = {}) => out.push({ hypothesis, arm, variant, role, change, repetitions: n(role, repetitions), ...extra });
  const h1 = () => {
    for (const arm of H1.arms) for (const role of BASELINES) add('H-1', arm, 'default', role, 'default', R1);
    for (const arm of H1.controls) add('H-1', arm, 'default', 'rrri', 'default', R1);
    add('H-7', 'observed', 'default', 'evo', 'default', 1);
  };
  const h5 = () => {
    for (const v of H5) for (const role of ['rrri', 'lf', 'ri']) add('H-5', 'maintained-tidy', v, role, 'default', RV);
  };
  if (window === 'recent') {
    h1();
    for (const v of H2) for (const role of ['rrri', 'lf']) add('H-2', 'tidy-once', v, role, 'default', RV);
    for (const v of H3) for (const role of ['rrri', 'lf']) add('H-3', 'tidy-once', v, role, 'default', RV, { policyLock: true });
    for (const v of H4) for (const role of ['rrri', 'lf']) add('H-4', 'tidy-once', v, role, 'default', RV);
    for (const v of H6) for (const role of ['rrri', 'lf']) add('H-6', 'maintained-tidy', v, role, 'default', RV);
    h5();
    for (const change of ['default', 'layout']) add('H-9', 'tidy-once', 'default', 'rrri', change, R1);
  } else if (window === 'peak') {
    h1();
    h5();
    for (const role of BASELINES) for (const change of ['single', 'layout', 'naive']) add('H-11', 'observed', 'default', role, change, RV);
  } else {
    throw new Error(`no replay plan for window ${window}`);
  }
  return out;
}

// One entry per distinct (arm, variant, role, change), the largest repetition
// count and every hypothesis kept: entries the hypotheses share run once.
export function mergePlan(entries) {
  const m = new Map();
  for (const e of entries) {
    const k = `${e.arm}|${e.variant}|${e.role}|${e.change}`;
    const x = m.get(k);
    if (!x) m.set(k, { ...e, hypotheses: [e.hypothesis] });
    else {
      x.repetitions = Math.max(x.repetitions, e.repetitions);
      x.policyLock = x.policyLock || e.policyLock;
      if (!x.hypotheses.includes(e.hypothesis)) x.hypotheses.push(e.hypothesis);
    }
  }
  return [...m.values()];
}

// The jobs of a plan for one wallet: collateral rules expanded when the
// window holds a script interaction.
export function expandJobs(entries, { roles, needsCollateral, collateralRules = COLLATERAL_RULES }) {
  const jobs = [];
  for (const e of mergePlan(entries)) {
    const rules = needsCollateral ? collateralRules : ['none-needed'];
    for (const collateral of rules) {
      for (let rep = 1; rep <= e.repetitions; rep++) {
        jobs.push({ hypotheses: e.hypotheses, arm: e.arm, variant: e.variant, role: e.role, method: roles[e.role], change: e.change, collateral, repetition: rep, policyLock: !!e.policyLock });
      }
    }
  }
  return jobs;
}

// The battery's selectors at the snapshot: the four of H-7 and H-12, the
// sensitivity arm on change policy (both CSL strategies with
// prefer_pure_change set, each scored against the oracle's csl-ppc
// reference), and the H-12 rule with absorption on and off. Repetitions as
// above.
export function batteryPlan({ roles = STUDY_ROLES, reps = 30, h12 = true } = {}) {
  const methods = [];
  for (const role of ['lf', 'ri', 'rrri', 'evo', 'lf-pure', 'ri-pure']) methods.push({ name: roles[role], role, opts: [{ changePolicy: 'default' }], repetitions: DETERMINISTIC_ROLES.has(role) ? 1 : reps });
  if (h12) methods.push({ name: 'unfrackit-h12', role: 'h12', opts: [{ changePolicy: 'default', absorb: true }, { changePolicy: 'default', absorb: false }], repetitions: 1 });
  return methods;
}

// The engine's test plan (never a study plan): every starting layout and
// every variant on the arm its hypothesis replays, the change policies on the
// tidy-once arm, all under one method, `reps` repetitions each (the random
// control and the random grouping change with the repetition).
export function testPlan({ reps = 2 } = {}) {
  const out = [];
  const add = (hypothesis, arm, variant, change = 'default', extra = {}) => out.push({ hypothesis, arm, variant, role: 'test', change, repetitions: reps, ...extra });
  for (const arm of [...H1.arms, ...H1.controls]) add('H-1', arm, 'default');
  for (const v of H2.slice(1)) add('H-2', 'tidy-once', v);
  for (const v of H3) add('H-3', 'tidy-once', v, 'default', { policyLock: true });
  for (const v of H4.slice(1)) add('H-4', 'tidy-once', v);
  for (const v of H5) add('H-5', 'maintained-tidy', v);
  for (const v of H6.slice(1)) add('H-6', 'maintained-tidy', v);
  for (const change of ['single', 'naive']) add('H-11', 'tidy-once', 'default', change);
  return out;
}
