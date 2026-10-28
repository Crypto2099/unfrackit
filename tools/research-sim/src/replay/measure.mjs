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
  return {
    inputs: walletInputs.length,
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

export function stateMeasures(state, params) {
  let largest = 0;
  let locked = 0n;
  const assets = new Set();
  for (const u of state.utxos.values()) {
    largest = Math.max(largest, valueSize(u.coin, u.assets));
    if (u.assets.length) {
      locked += utxoMinimum(params, u);
      for (const a of u.assets) assets.add(key(a));
    }
  }
  return { utxos: state.utxos.size, largestValueBytes: largest, lockedAda: locked, lockedAdaPerToken: assets.size ? locked / BigInt(assets.size) : null, tokens: assets.size };
}

// H-3's per-window part: each policy's share of the minimum ADA of the outputs
// holding it, shared pro rata by the policy's bytes in mixed outputs,
// integrated over block time. add(state, seconds) accrues the state's shares
// for that long; result() gives each policy's time average.
export class PolicyLock {
  constructor(params) {
    this.params = params;
    this.acc = new Map();
    this.seconds = 0;
  }
  add(state, seconds) {
    if (seconds <= 0) return;
    this.seconds += seconds;
    for (const u of state.utxos.values()) {
      if (!u.assets.length) continue;
      const min = utxoMinimum(this.params, u);
      const pols = [...new Set(u.assets.map((a) => a.policy))];
      const parts = pols.map((p) => ({ p, b: BigInt(bytesOf(u, (a) => a.policy === p)) }));
      const total = parts.reduce((s, x) => s + x.b, 0n);
      for (const { p, b } of parts) this.acc.set(p, (this.acc.get(p) || 0n) + (min * b * BigInt(Math.round(seconds))) / total);
    }
  }
  result() {
    if (!this.seconds) return [];
    return [...this.acc].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([policy, x]) => ({ policy, lockedAda: x / BigInt(Math.round(this.seconds)) }));
  }
}
