// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A state in the treatment's wallet form, { utxoJson, utxoHex, changeAddress }
// (the CIP-30 getUtxos() entries, as CSL decodes them, and the change address
// as a CSL Address), and in the planner's UTxO form (adapter2.mjs
// decodeWallet).
//
// Order: the UTxOs are given in the state's order, transaction id then output
// index ascending (setting treatmentOrder 'ref'), or in the order `refs` names
// (the comparison with the treatment's own runners, which take a shape's
// generated order). The planner's plans depend on the order where coins tie.
//
// Held UTxOs are given marked held (setting heldToTreatment 'flagged'): the
// planner and the selector never spend a held UTxO, and both classify assets
// over every UTxO they are given, which is the study's rule (held UTxOs count
// in asset classification). The treatment derives a datum, a reference
// script and a script payment credential itself; a franken flag is added
// here, and any other difference between the two readings stops the run.

// The most recent few change addresses and adapters are kept (a run moves
// from wallet to wallet); older ones are dropped and left to finalization.
const KEEP = 16;
const CHANGE = new Map();
const ADAPTERS = new Map();
function remember(m, k, v) {
  m.set(k, v);
  if (m.size > KEEP) m.delete(m.keys().next().value);
  return v;
}

export function changeAddressObject(T, bech32) {
  return CHANGE.get(bech32) || remember(CHANGE, bech32, T.CSL.Address.from_bech32(bech32));
}

// The treatment's adapter at a change address and parameters, made once and
// reused: its sizes and minimums are pure functions of its inputs, which it
// caches. kind 'plan' is adapter2.mjs makeAdapter, 'select' select2-csl.mjs
// makeSelectAdapter.
export function adapterFor(T, changeAddress, tp, kind) {
  const k = `${kind}|${changeAddress}|${Object.keys(T.cslkit.DEFAULT_PARAMS).map((f) => String(tp[f])).join('|')}`;
  const hit = ADAPTERS.get(k);
  if (hit) return hit;
  const addr = changeAddressObject(T, changeAddress);
  return remember(ADAPTERS, k, kind === 'select' ? T.selectCsl.makeSelectAdapter(addr, tp) : T.adapter.makeAdapter(addr, tp));
}

const AGREE = {
  'script-payment': ['script-credential'],
  datum: ['datum-hash', 'inline-datum'],
  'reference-script': ['reference-script']
};

// States are never changed in place, and neither the planner nor the selector
// changes the wallet it is given (they read it and build their own objects),
// so a state's decoded wallet is kept per order and reused.
const DECODED = new WeakMap();

// `arrival`: for H-2's arrival groupings, a Map from ref to the UTxO's arrival
// object ('policy.name' to its arrival key), as the planner reads it.
export function treatmentWallet(T, state, { refs = null, arrival = null } = {}) {
  if (arrival) return decodeState(T, state, refs, arrival);
  let byOrder = DECODED.get(state);
  if (!byOrder) {
    byOrder = new Map();
    DECODED.set(state, byOrder);
  }
  const key = refs ? refs.join(' ') : '';
  let w = byOrder.get(key);
  if (!w) {
    w = decodeState(T, state, refs, null);
    byOrder.set(key, w);
  }
  return w;
}

function decodeState(T, state, refs, arrival) {
  const list = refs ? refs.map((r) => {
    const u = state.utxos.get(r);
    if (!u) throw new Error(`treatment wallet: ${r} is not in the state`);
    return u;
  }) : [...state.utxos.values()];
  if (refs && list.length !== state.utxos.size) throw new Error('treatment wallet: the order names a different set of UTxOs');
  const utxoHex = list.map((u) => u.cbor);
  const utxoJson = utxoHex.map((h) => T.adapter.decodeUtxo(h));
  const utxos = T.adapter.decodeWallet(utxoJson);
  utxos.forEach((pu, i) => {
    const u = list[i];
    if (pu.ref !== u.ref || pu.coin !== u.coin) throw new Error(`treatment wallet: ${u.ref} decodes differently in the treatment`);
    if (u.held === 'franken') {
      if (pu.held !== null) throw new Error(`treatment wallet: ${u.ref} is franken-flagged and also held by the treatment (${pu.held})`);
      pu.held = 'franken';
    } else if (u.held === null) {
      if (pu.held !== null) throw new Error(`treatment wallet: ${u.ref} is spendable, the treatment holds it (${pu.held})`);
    } else if (!AGREE[u.held].includes(pu.held)) {
      throw new Error(`treatment wallet: ${u.ref} is held (${u.held}), the treatment reads ${pu.held}`);
    }
    if (arrival && arrival.has(u.ref)) pu.arrival = arrival.get(u.ref);
  });
  return { wallet: { utxoJson, utxoHex, changeAddress: changeAddressObject(T, state.changeAddress) }, utxos };
}
