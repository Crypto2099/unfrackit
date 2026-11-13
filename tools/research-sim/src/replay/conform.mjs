// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The conforming share of a state: how many of the wallet's token UTxOs break
// none of the treatment's output rules at given planner settings and
// parameters.
//
// A token UTxO is a UTxO of the state that is not held and carries at least
// one native asset (the set conform.mjs walletLayoutReport walks). Nothing is
// exempt: a partial split's remainder and an output that absorbed dust change
// count as non-conforming when they break a rule. The verdict is the
// treatment's own outputViolations (T.conform), called with the UTxO's tokens,
// coin, minimum coin and Value bytes, read from the state without CSL
// (utxoMinimum and valueSize); the class map is the treatment's
// classifyAssets over every UTxO of the state, held ones included, which is
// the map the planner computes for the same state.
//
// conformingNoCoin leaves the coin rule out by passing each UTxO's own coin as
// its minimum, so the coin rule cannot fire and every other rule is the same
// call.

import { valueSize } from '../history/value.mjs';
import { treatmentParams } from '../treatment/bridge.mjs';
import { utxoMinimum } from './measure.mjs';

// Each token UTxO's verdict: { ref, violations, violationsNoCoin }, the rules
// it breaks with and without the coin rule. settings: the planner settings of
// the arm (merged over the decided defaults here); {} for the arms that run at
// the defaults.
export function utxoVerdicts(T, state, params, settings = {}) {
  const merged = T.planner.mergeSettings(settings);
  const tp = treatmentParams(T, params);
  const all = [...state.utxos.values()];
  const classMap = T.planner.classifyAssets(all);
  const out = [];
  for (const u of all) {
    if (u.held || !u.assets.length) continue;
    const valueBytes = valueSize(u.coin, u.assets);
    const min = utxoMinimum(params, u);
    out.push({
      ref: u.ref,
      violations: T.conform.outputViolations({ tokens: u.assets, coin: u.coin, min, valueBytes }, merged, classMap, tp),
      violationsNoCoin: T.conform.outputViolations({ tokens: u.assets, coin: u.coin, min: u.coin, valueBytes }, merged, classMap, tp)
    });
  }
  return out;
}

export function conformingShare(T, state, params, settings = {}) {
  const v = utxoVerdicts(T, state, params, settings);
  return { tokenUtxos: v.length, conforming: v.filter((x) => !x.violations.length).length, conformingNoCoin: v.filter((x) => !x.violationsNoCoin.length).length };
}
