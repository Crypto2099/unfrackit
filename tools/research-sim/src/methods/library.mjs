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
//               for the Evolution SDK, Lucid Evolution and Scalus, the
//               collateral the library chooses from the whole pool
//               (methods/contract.mjs choosesOwnCollateral)
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
//   csl   csl-lf, csl-ri: every part
//         (methods/csl.mjs, its replay path)
//   evo   evo-lf (and the survey's evo-unfrack): every part, collateral as
//         the library chooses it, since it cannot be given the UTxO the
//         engine would set aside (methods/evo.mjs)
//   mesh  mesh-rrri: every part, the fixed parts and the collateral through
//         the kit and the rest through Mesh's selector's own parameters
//         (methods/mesh.mjs, its replay path); the survey's Mesh subjects
//         cover none (mesh.mjs SURVEY_COVERAGE)
//   cjs   cjs-rrri: every part (methods/cjs.mjs, its replay path)
//   h12   unfrackit-h12: every part, each in the rule's request, which the
//         rule takes into its selection, size and fee (methods/h12.mjs)
//   blaze blaze-wd: every part, through the library's operations where one
//         writes it and on its transaction after the build otherwise
//         (methods/blaze.mjs)
//   lucid lucid-lf: every part, collateral as the library chooses it, since
//         it cannot be given the UTxO the engine would set aside
//         (methods/lucid.mjs)
//   typhon typhon-lp: every part, through the library's operations and types
//         where they write it and on its transaction after the build
//         otherwise (methods/typhon.mjs)
//   helios helios-sf: every part, through the library's operations; the parts
//         its types cannot hold are not replayable (methods/helios.mjs)
//   cml   cml-lf, cml-ri: every part (methods/cml.mjs, its replay path)
//   cometa cometa-lf: every part, through the library's operations and types
//         where they write it and on its transaction after the build
//         otherwise (methods/cometa.mjs)
//   lace  lace-rrri: every part, through the builder's operations where one
//         writes it and on its transaction after the build otherwise; a
//         redeemer no operation can attach is not replayable
//         (methods/lace.mjs)
//   adalite adalite-lp: every part, the validity through the wallet's types
//         and the rest on its transaction after the build; a redeemer, and
//         so collateral, and a requested output's datum or script reference
//         are not replayable (methods/adalite.mjs)
//   yoroi yoroi-lf: every part; the send flow writes outputs, a TTL and
//         metadata only, so an intent with any other part is not replayable
//         (methods/yoroi.mjs)
//   apollo apollo-macs: every part, through the builder's operations and the
//         collateral set aside; a redeemer the builder cannot attach (a
//         certificate's, a vote's, a proposal's) is not replayable
//         (methods/apollo.mjs)
//   ccl   ccl-pw: every part, through QuickTx's operations and the
//         collateral set aside (methods/jvm.mjs)
//   scalus scalus-pool: every part, through the builder's steps, collateral
//         as the library chooses it, since it cannot be given the UTxO the
//         engine would set aside (methods/jvm.mjs)
//   pycardano pycardano-lf: every part, through the builder's operations and
//         fields; a bootstrap witness and a vote's or a proposal's redeemer
//         are not replayable (methods/pycardano.mjs)
//   tx3   tx3-vd: every part, each written by the spend's program, the
//         collateral set aside by its collateral block; the parts the
//         language or its compiler cannot hold are not replayable
//         (methods/tx3.mjs)
//   ctl   ctl-rrri: every part, in the unbalanced transaction the balancer
//         is given, through CTL's types; a certificate those types cannot
//         hold (kinds 7 and 8) is not replayable (methods/ctl.mjs)
export const REPLAY_COVERAGE = Object.freeze({
  csl: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  evo: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  mesh: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  cjs: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  h12: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  blaze: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  lucid: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  typhon: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  helios: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  cml: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  cometa: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  lace: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  adalite: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  yoroi: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  apollo: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  scalus: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  ccl: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  pycardano: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  tx3: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData']),
  ctl: Object.freeze(['fixed', 'collateral', 'implicit', 'outputData'])
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
