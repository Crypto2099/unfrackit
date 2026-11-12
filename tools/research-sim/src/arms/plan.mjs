// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Run plans: which arms run in which window, under which selectors, change
// policies, collateral rules and repetitions. The command line expands a plan
// into jobs, one per (wallet, arm, variant, selector, change policy,
// absorption setting, collateral rule, repetition).
//
// Selectors are named by role. Each study library is one row of
// LIBRARY_TABLE: its role, the method the role names, and whether it picks
// at random; the role tables below are derived from it, so a library joins the
// study with one row. The study's roles name the libraries, and the test roles
// map every role to the test method:
//   lf         cardano-serialization-lib Largest-First (deterministic)
//   ri         cardano-serialization-lib random selection
//   rrri       cardano-js-sdk round-robin Random-Improve, seeded
//   evo        the Evolution SDK default (deterministic)
//   blaze-wd   Blaze's default, micahsSelector (deterministic)
//   lucid-lf   Lucid Evolution's complete() default (deterministic)
//   h12        UnFrack.It's H-12 input rule, with UnFrack.It's own change
//
// The study's replay plan answers two questions, in both windows alike. Every
// arm replays the wallet's observed state, under one collateral rule (a job
// of a wallet whose window holds no script interaction records
// 'none-needed'). For each library role L of LIBRARY_ROLES:
//   L/own     L's inputs and L's own change ('default'): question 1's
//             reference and the user switching away from L
//   L/layout  L's inputs and UnFrack.It's change ('layout'): question 1's
//             treatment and question 2's reference
// and for UnFrack.It's rule (h12), its inputs and its own change, once with
// absorption on and once with it off (the variants 'absorb-on' and
// 'absorb-off', which give the planner its default settings; the setting
// reaches the method as opts.absorb). Question 1 compares L/layout with
// L/own; question 2 compares the rule with L/layout.
// Repetitions: 10 for a library that picks at random, one for a deterministic
// one and for the rule. Repetition r seeds the selector with r in L/own and in
// L/layout alike, so the two arms share one seed sequence (common random
// numbers; replay/run.mjs replayJobOpts). Per wallet and window that is 2 jobs
// per deterministic library, 20 per random one and 2 for the rule: with the
// six libraries below, 2 + 20 + 20 + 2 + 2 + 2 + 2 = 50.

import { COLLATERAL_RULES } from '../replay/collateral.mjs';

// One row per study library: { role, method, random }.
export const LIBRARY_TABLE = Object.freeze([
  { role: 'lf', method: 'csl-lf', random: false },
  { role: 'ri', method: 'csl-ri', random: true },
  { role: 'rrri', method: 'cjs-rrri', random: true },
  { role: 'evo', method: 'evo-lf', random: false },
  { role: 'blaze-wd', method: 'blaze-wd', random: false },
  { role: 'lucid-lf', method: 'lucid-lf', random: false }
].map((r) => Object.freeze(r)));
const RULE = Object.freeze({ role: 'h12', method: 'unfrackit-h12' });

export const LIBRARY_ROLES = Object.freeze(LIBRARY_TABLE.map((r) => r.role));
export const STUDY_ROLES = Object.freeze(Object.fromEntries([...LIBRARY_TABLE, RULE].map((r) => [r.role, r.method])));
export const TEST_ROLES = Object.freeze(Object.fromEntries([...LIBRARY_ROLES, RULE.role].map((role) => [role, 'test-largest-first'])));
const DETERMINISTIC_ROLES = new Set([...LIBRARY_TABLE.filter((r) => !r.random).map((r) => r.role), RULE.role]);
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
  for (const absorb of [true, false]) out.push({ hypothesis: 'Q2', arm: 'observed', variant: absorb ? 'absorb-on' : 'absorb-off', role: RULE.role, change: 'default', repetitions: 1, absorb });
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
        jobs.push({ hypotheses: e.hypotheses, arm: e.arm, variant: e.variant, role: e.role, method: roles[e.role], change: e.change, ...(e.absorb !== undefined ? { absorb: e.absorb } : {}), collateral, repetition: rep });
      }
    }
  }
  return jobs;
}
