// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// What the baseline adapters share.
//
// Input order: every library receives the arm's spendable UTxOs (held ones
// removed) in the state's order, transaction id bytes then output index,
// ascending; the libraries' own tie behavior is recorded by the tests, never
// altered.
//
// Witnesses (setting serialization 'own'): a library that returns transaction
// bytes keeps its own serialization of the body, and its witness set is filled
// with one synthetic vkey witness per distinct payment key among the wallet's
// inputs, in the library's own encoding, so the size is exact before signing.
// A spendable UTxO always has a key payment credential (a script payment
// credential makes it held; state/utxo.mjs), so the count is the number of
// distinct credentials among the inputs.
//
// The replay path. A replayed intent can carry parts a battery spend never
// does (REPLAY_PARTS):
//   fixed       fixed parts: inputs the selector does not choose (other
//               parties' and script inputs, the wallet's held UTxOs the spend
//               consumed), reference inputs, certificates, withdrawals, the
//               mint field, validity, required signers, votes, proposals, the
//               treasury fields, auxiliary data and witnesses
//   collateral  collateral for a script spend: the UTxO the engine set aside
//               under the arm's rule before selection (opts.collateral), or,
//               for the Evolution SDK, the collateral its library chooses from
//               the whole pool (methods/contract.mjs choosesOwnCollateral)
//   implicit    withdrawals, refunds, deposits, a donation, a mint or a burn
//   outputData  a requested output that carries a datum or a script reference
// Each adapter states which of them its replay path covers (REPLAY_COVERAGE),
// and refuses, before it builds anything, an intent with a part it does not
// cover (refuseUncovered). The refusal is an ordinary error, which the engine
// counts as class 'other' with its message, so no replay is scored by an
// adapter that has not built its path. A part an adapter covers but its
// library has no way to express is the adapter's to return as
// 'not-replayable'.

import { spendable } from '../state/state.mjs';

export const inputOrder = (state) => spendable(state);

export function recordsOf(state, refs) {
  return refs.map((r) => {
    const u = state.utxos.get(r);
    if (!u) throw new Error(`the library chose ${r}, which is not in the state`);
    if (u.held !== null) throw new Error(`the library chose ${r}, which is held`);
    return u;
  });
}

export const keyCount = (records) => new Set(records.map((u) => u.cred)).size;

export const REPLAY_PARTS = Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']);

// The parts each adapter's replay path covers, by adapter module:
//   csl   csl-lf, csl-ri, csl-lf-pure, csl-ri-pure: every part
//         (methods/csl.mjs, its replay path)
//   evo   evo-lf (and the survey's evo-unfrack): every part, collateral as
//         the library chooses it, since it cannot be given the UTxO the
//         engine would set aside (methods/evo.mjs)
//   mesh  the survey's Mesh subjects: none; Mesh is surveyed on battery spends
//         only and never replays
//   cjs   cjs-rrri: every part (methods/cjs.mjs, its replay path)
export const REPLAY_COVERAGE = Object.freeze({
  csl: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  evo: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  mesh: Object.freeze([]),
  cjs: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData'])
});

const hasImplicit = (imp) => !!(imp.withdrawals || imp.refunds || imp.deposits || imp.donation || imp.mint.length || imp.burn.length);

// The parts of an intent, among REPLAY_PARTS.
export function partsOf(intent) {
  const out = [];
  if (intent.fixed) out.push('fixed');
  if (intent.collateral.required) out.push('collateral');
  if (hasImplicit(intent.implicit)) out.push('implicit');
  if (intent.requested.some((o) => o.datum || o.scriptRef)) out.push('outputData');
  return out;
}

// Throws for the first part of the intent the adapter's statement does not
// cover, with the same message for every adapter that covers none.
export function refuseUncovered(name, covered, intent) {
  for (const p of covered) if (!REPLAY_PARTS.includes(p)) throw new Error(`${name}: unknown replay part ${p}`);
  const has = new Set(partsOf(intent));
  const covers = new Set(covered);
  const missing = (p) => has.has(p) && !covers.has(p);
  if (missing('fixed') || missing('collateral')) throw new Error(`${name}: the replay path (fixed parts and collateral) is not built yet`);
  if (missing('implicit')) throw new Error(`${name}: implicit values come only with fixed parts, whose path is not built yet`);
  if (missing('outputData')) throw new Error(`${name}: requested outputs with a datum or a script reference come only with replays, whose path is not built yet`);
}

export const errorText = (e) => (typeof e === 'string' ? e : e && e.message !== undefined ? String(e.message) : String(e));

// One transaction record of the contract.
export function txRecord(bytes, walletInputs, fee, size, k) {
  return { bytes, walletInputs, fee, size, k, roles: { inputs: walletInputs.length } };
}
