// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Run plans: which arms run in which window, under which selectors, change
// policies, collateral rules and repetitions. The command line expands a plan
// into jobs, one per (wallet, arm, variant, selector, change policy,
// absorption setting, collateral rule, repetition).
//
// Selectors are named by role, so that a plan is the study's for the
// libraries and a test plan for the test method:
//   lf      cardano-serialization-lib Largest-First (deterministic)
//   ri      cardano-serialization-lib random selection
//   rrri    cardano-js-sdk round-robin Random-Improve, seeded
//   evo     the Evolution SDK default (deterministic)
//   h12     UnFrack.It's H-12 input rule, with UnFrack.It's own change
//
// The study's replay plan answers two questions, in both windows alike. Every
// arm replays the wallet's observed state, under one collateral rule (a job
// of a wallet whose window holds no script interaction records
// 'none-needed'). For each library role L of lf, ri, rrri and evo:
//   L/own     L's inputs and L's own change ('default'): question 1's
//             reference and the user switching away from L
//   L/layout  L's inputs and UnFrack.It's change ('layout'): question 1's
//             treatment and question 2's reference
// and for UnFrack.It's rule (h12), its inputs and its own change, once with
// absorption on and once with it off (the variants 'absorb-on' and
// 'absorb-off', which give the planner its default settings; the setting
// reaches the method as opts.absorb). Question 1 compares L/layout with
// L/own; question 2 compares the rule with L/layout.
// Repetitions: 10 for a library that picks at random (ri, rrri), one for a
// deterministic one and for the rule. Repetition r seeds the selector with r
// in L/own and in L/layout alike, so the two arms share one seed sequence
// (common random numbers; replay/run.mjs replayJobOpts). With four libraries
// that is 2 + 20 + 20 + 2 + 2 = 46 jobs per wallet and window.

import { COLLATERAL_RULES } from '../replay/collateral.mjs';

export const STUDY_ROLES = Object.freeze({ lf: 'csl-lf', ri: 'csl-ri', rrri: 'cjs-rrri', evo: 'evo-lf', h12: 'unfrackit-h12' });
export const TEST_ROLES = Object.freeze({ lf: 'test-largest-first', ri: 'test-largest-first', rrri: 'test-largest-first', evo: 'test-largest-first', h12: 'test-largest-first' });
const DETERMINISTIC_ROLES = new Set(['lf', 'evo', 'h12']);

const H1 = { arms: ['observed', 'tidy-once', 'maintained-tidy'], controls: ['naive-tidy', 'random-tidy'] };
const H2 = ['default', 'grouping-arrival', 'grouping-policy-arrival', 'grouping-random', 'byte-optimal'];
const H3 = ['bundle-1', 'bundle-5', 'bundle-10', 'bundle-30', 'bundle-60', 'bundle-cap'];
const H4 = ['default', 'isolation-asset', 'isolation-policy'];
const H5 = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6'];
const H6 = ['default', 'never-propose', 'dust-1', 'band-3-6', 'band-5-20'];

export const LIBRARY_ROLES = Object.freeze(['lf', 'ri', 'rrri', 'evo']);
export const RANDOM_REPETITIONS = 10;

// The plan's entries for a window: [{ hypothesis, arm, variant, role, change,
// repetitions, absorb? }], the same in both windows. reps: the repetitions of
// a library that picks at random (10 when absent; tests give fewer).
export function windowPlan(window, { reps = RANDOM_REPETITIONS } = {}) {
  if (window !== 'recent' && window !== 'peak') throw new Error(`no replay plan for window ${window}`);
  if (!Number.isSafeInteger(reps) || reps < 1) throw new Error(`the repetitions must be a positive whole number, not ${reps}`);
  const n = (role) => (DETERMINISTIC_ROLES.has(role) ? 1 : reps);
  const out = [];
  for (const role of LIBRARY_ROLES) {
    out.push({ hypothesis: 'Q1', arm: 'observed', variant: 'default', role, change: 'default', repetitions: n(role) });
    for (const hypothesis of ['Q1', 'Q2']) out.push({ hypothesis, arm: 'observed', variant: 'default', role, change: 'layout', repetitions: n(role) });
  }
  for (const absorb of [true, false]) out.push({ hypothesis: 'Q2', arm: 'observed', variant: absorb ? 'absorb-on' : 'absorb-off', role: 'h12', change: 'default', repetitions: 1, absorb });
  return out;
}

// One entry per distinct (arm, variant, role, change, absorb), the largest repetition
// count and every hypothesis kept: entries the hypotheses share run once.
export function mergePlan(entries) {
  const m = new Map();
  for (const e of entries) {
    const k = `${e.arm}|${e.variant}|${e.role}|${e.change}|${e.absorb ?? ''}`;
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

// The jobs of a plan for one wallet: the collateral rules (one, in the study)
// expanded when the window holds a script interaction.
export function expandJobs(entries, { roles, needsCollateral, collateralRules = COLLATERAL_RULES }) {
  const jobs = [];
  for (const e of mergePlan(entries)) {
    const rules = needsCollateral ? collateralRules : ['none-needed'];
    for (const collateral of rules) {
      for (let rep = 1; rep <= e.repetitions; rep++) {
        jobs.push({ hypotheses: e.hypotheses, arm: e.arm, variant: e.variant, role: e.role, method: roles[e.role], change: e.change, ...(e.absorb !== undefined ? { absorb: e.absorb } : {}), collateral, repetition: rep, policyLock: !!e.policyLock });
      }
    }
  }
  return jobs;
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
