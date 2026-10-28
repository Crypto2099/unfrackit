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
// The replay path (an intent with fixed parts, or one that needs collateral)
// is not built yet: the adapters refuse such an intent with an error, which the
// engine counts as class 'other', so no replay can be scored by mistake.

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

export function batteryOnly(name, intent) {
  if (intent.fixed || intent.collateral.required) throw new Error(`${name}: the replay path (fixed parts and collateral) is not built yet`);
  const imp = intent.implicit;
  if (imp.withdrawals || imp.refunds || imp.deposits || imp.donation || imp.mint.length || imp.burn.length) throw new Error(`${name}: implicit values come only with fixed parts, whose path is not built yet`);
  if (intent.requested.some((o) => o.datum || o.scriptRef)) throw new Error(`${name}: requested outputs with a datum or a script reference come only with replays, whose path is not built yet`);
}

export const errorText = (e) => (typeof e === 'string' ? e : e && e.message !== undefined ? String(e.message) : String(e));

// One transaction record of the contract.
export function txRecord(bytes, walletInputs, fee, size, k) {
  return { bytes, walletInputs, fee, size, k, roles: { inputs: walletInputs.length } };
}
