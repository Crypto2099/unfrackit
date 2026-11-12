// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The measured outputs of a built spend and of a wallet's state.
//
// Per spend (from the built transaction, its wallet inputs and the state it
// was built from):
//   inputs        the wallet inputs the method chose
//   keys          the distinct payment keys that sign (synthetic witnesses)
//   dragged       the assets present in the wallet inputs and absent from the
//                 requested outputs
//   changeOutputs the outputs at the wallet's stake credential that are not
//                 requested outputs: their count, bytes, and the largest
//                 change Value's bytes
//   consumedWalletInputs       the count of wallet UTxOs the spend consumes, the
//                 intent's fixed wallet inputs included (inputs leaves them out)
//   largestConsumedValueBytes  the largest Value among those UTxOs
//   changeTokenMinimum   the minimum coin of the token-carrying change outputs
//                 (coinsPerUtxoByte * (160 + output bytes))
//   consumedTokenMinimum the minimum coin the consumed token-carrying UTxOs
//                 would need without the tokens the spend sends away (a
//                 requested token no change output carries); a UTxO left with
//                 no token adds nothing. Criterion A of H-7's drift compares
//                 the two minimums.
//   dragBytes     H-2's replayed drag: the bytes, in the change outputs' Values,
//                 of the tokens that shared a consumed output with a requested
//                 token without being requested themselves
//   policies      per policy whose tokens the change recreates, the bytes those
//                 tokens take in the change Values (each output's Value with
//                 and without the policy) and their fee at minFeeA per byte
//                 (H-3's replay cost per spend and policy)
// The bytes of a set of tokens in an output are the output's Value bytes less
// the bytes of the same Value without them (history/value.mjs valueSize, the
// ledger's serialization).
//
// Per state:
//   utxos                the UTxO count
//   largestValueBytes    the largest Value of any UTxO, in bytes
//   lockedAda            the minimum coin of every token-carrying UTxO,
//                        coinsPerUtxoByte * (160 + its output's bytes as
//                        written; setting heldBytes 'ledger')
//   lockedAdaPerToken    lockedAda over the distinct assets held
// Each counts every UTxO of the state, held ones included. A held output that
// a replayed intent created is in the state under its observed reference
// until the event or later intent that consumes it (state/state.mjs
// heldOutputRefs), as a held UTxO of the start state or of a deposit is.

import { valueSize } from '../history/value.mjs';
import { outputMinimum } from '../kit/check.mjs';
import { unspentOutputParts } from '../kit/inspect.mjs';
import { addressBytes } from '../history/address.mjs';
import { isWalletAddress } from '../state/state.mjs';

const key = (a) => `${a.policy}.${a.name}`;
const outKey = (addrHex, coin, assets) => `${addrHex}|${coin}|${[...assets].map((a) => `${key(a)}=${a.qty}`).sort().join(',')}`;

// The indexes of a transaction's outputs that are requested outputs, matched
// by address, coin and assets (a method may encode an output differently).
export function requestedIndexes(intent, tx) {
  const want = new Map();
  for (const o of intent.requested) {
    const k = outKey(addressBytes(o.address).toString('hex'), o.coin, o.assets);
    want.set(k, (want.get(k) || 0) + 1);
  }
  const out = new Set();
  for (const o of tx.outputs) {
    const k = outKey(o.address.toString('hex'), o.coin, o.assets);
    const n = want.get(k) || 0;
    if (n > 0) {
      want.set(k, n - 1);
      out.add(o.index);
    }
  }
  return out;
}

function bytesOf(o, drop) {
  const kept = o.assets.filter((a) => !drop(a));
  if (kept.length === o.assets.length) return 0;
  return valueSize(o.coin, o.assets) - valueSize(o.coin, kept);
}

export function spendMeasures(state, intent, tx, walletInputs, params, requested = requestedIndexes(intent, tx)) {
  const ins = walletInputs.map((r) => state.utxos.get(r)).filter(Boolean);
  const reqAssets = new Set(intent.requested.flatMap((o) => o.assets.map(key)));
  const inAssets = new Set(ins.flatMap((u) => u.assets.map(key)));
  const dragged = [...inAssets].filter((k) => !reqAssets.has(k)).length;
  const change = tx.outputs.filter((o) => !requested.has(o.index) && isWalletAddress(state, o.addr));
  const sharing = new Set();
  for (const u of ins) if (u.assets.some((a) => reqAssets.has(key(a)))) for (const a of u.assets) if (!reqAssets.has(key(a))) sharing.add(key(a));
  let dragBytes = 0;
  const policies = new Map();
  for (const o of change) {
    dragBytes += bytesOf(o, (a) => sharing.has(key(a)));
    for (const p of new Set(o.assets.map((a) => a.policy))) policies.set(p, (policies.get(p) || 0) + bytesOf(o, (a) => a.policy === p));
  }
  // Every wallet UTxO the spend consumes: the method's inputs and the intent's
  // fixed inputs that are wallet UTxOs of the state (by reference, once each).
  const consumed = new Map();
  for (const r of walletInputs) if (state.utxos.has(r)) consumed.set(r, state.utxos.get(r));
  if (intent.fixed) for (const x of intent.fixed.inputs) if (state.utxos.has(x.ref)) consumed.set(x.ref, state.utxos.get(x.ref));
  // A token is sent away when a requested output carries it and no change
  // output does; one only partly sent stays in the change and in the minimum
  // of the UTxO it came from.
  const kept = new Set(change.flatMap((o) => o.assets.map(key)));
  const away = (a) => reqAssets.has(key(a)) && !kept.has(key(a));
  let largestConsumed = 0;
  let consumedTokenMinimum = 0n;
  for (const u of consumed.values()) {
    largestConsumed = Math.max(largestConsumed, valueSize(u.coin, u.assets));
    const left = u.assets.filter((a) => !away(a));
    if (left.length) consumedTokenMinimum += outputMinimum(params, outputLength(u) - bytesOf(u, away));
  }
  let changeTokenMinimum = 0n;
  for (const o of change) if (o.assets.length) changeTokenMinimum += outputMinimum(params, o.raw.length);
  return {
    inputs: walletInputs.length,
    consumedWalletInputs: consumed.size,
    largestConsumedValueBytes: largestConsumed,
    changeTokenMinimum,
    consumedTokenMinimum,
    keys: new Set(ins.map((u) => u.cred)).size,
    dragged,
    changeOutputs: { count: change.length, bytes: change.reduce((s, o) => s + o.raw.length, 0), largestValueBytes: change.reduce((m, o) => Math.max(m, valueSize(o.coin, o.assets)), 0) },
    dragBytes,
    policies: [...policies].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([policy, bytes]) => ({ policy, bytes, fee: params.minFeeA * BigInt(bytes) }))
  };
}

const RAW = new WeakMap();
function outputLength(u) {
  let n = RAW.get(u);
  if (n === undefined) {
    n = unspentOutputParts(u.cbor).outputRaw.length;
    RAW.set(u, n);
  }
  return n;
}
export const utxoMinimum = (params, u) => outputMinimum(params, outputLength(u));

// What stateMeasures reads of a UTxO, kept with the UTxO (it never changes
// once made): its Value's size, its asset keys, and its minimum under the
// parameters object it was last measured with.
const MEASURED = new WeakMap();
function measured(params, u) {
  let m = MEASURED.get(u);
  if (m === undefined) {
    m = { valueBytes: valueSize(u.coin, u.assets), keys: u.assets.map(key), params: null, minimum: 0n };
    MEASURED.set(u, m);
  }
  if (u.assets.length && m.params !== params) {
    m.minimum = utxoMinimum(params, u);
    m.params = params;
  }
  return m;
}

export function stateMeasures(state, params) {
  let largest = 0;
  let locked = 0n;
  const assets = new Set();
  for (const u of state.utxos.values()) {
    const m = measured(params, u);
    if (m.valueBytes > largest) largest = m.valueBytes;
    if (u.assets.length) {
      locked += m.minimum;
      for (const k of m.keys) assets.add(k);
    }
  }
  return { utxos: state.utxos.size, largestValueBytes: largest, lockedAda: locked, lockedAdaPerToken: assets.size ? locked / BigInt(assets.size) : null, tokens: assets.size };
}

// The token UTxOs a plan can spend: those holding a native asset and not held
// (a held UTxO is never spent). { utxos, coin, minimum }, the minimum as
// stateMeasures sums it for lockedAda. coin - minimum is the ADA on these
// UTxOs above their minimum.
export function tokenLedger(state, params) {
  let utxos = 0;
  let coin = 0n;
  let minimum = 0n;
  for (const u of state.utxos.values()) {
    if (!u.assets.length || u.held !== null) continue;
    utxos++;
    coin += BigInt(u.coin);
    minimum += utxoMinimum(params, u);
  }
  return { utxos, coin, minimum };
}
