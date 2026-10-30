// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Transactions the kit assembles with CSL (the treatment's instance): a
// selection-only method's inputs with outputs a change policy made. Inputs are
// sorted by transaction id then index, the order the ledger's input set takes;
// outputs are in the order given; the witness set holds k synthetic vkey
// witnesses (the treatment's build.mjs makeWitnessSet: real public keys from
// fixed seeds and fixed signatures, each 101 bytes as a real one), k the
// distinct key payment credentials among the inputs, so the size is exact
// before signing (a key payment credential is spent with a vkey witness;
// CIP-0019, "Payment part"). No auxiliary data: payments carry none.
//
// The fee is the ledger's minimum for the assembled size, found as a fixed
// point because the fee's own encoding and the change coin's are part of the
// size: the fee rises until it covers the size it produces. When the size
// then falls (a coin's encoding narrows as the change shrinks), the fee is
// lowered to the minimum of the smaller transaction for as long as that still
// covers itself, so the fee is the least that pays for its own transaction.
// `outputsFor(fee)` returns the outputs for a fee, or a failure.

import { cmpRef } from '../state/state.mjs';
import { minFee } from './fee.mjs';
import { inspectTx } from './inspect.mjs';

function valueOf(CSL, coin, assets) {
  const c = CSL.BigNum.from_str(coin.toString());
  const v = CSL.Value.new(c);
  c.free();
  if (!assets.length) return v;
  const ma = CSL.MultiAsset.new();
  for (const a of assets) {
    const sh = CSL.ScriptHash.from_hex(a.policy);
    const an = CSL.AssetName.new(Buffer.from(a.name, 'hex'));
    const bn = CSL.BigNum.from_str(a.qty.toString());
    const prev = ma.set_asset(sh, an, bn);
    if (prev) prev.free();
    for (const x of [sh, an, bn]) x.free();
  }
  v.set_multiasset(ma);
  ma.free();
  return v;
}

// One output's bytes as CSL serializes it: { address (bech32), coin, assets }.
export function outputBytes(T, { address, coin, assets }) {
  const CSL = T.CSL;
  const a = CSL.Address.from_bech32(address);
  const v = valueOf(CSL, coin, assets);
  const o = CSL.TransactionOutput.new(a, v);
  const b = Buffer.from(o.to_bytes());
  for (const x of [o, v, a]) x.free();
  return b;
}

// inputs: UTxO records (state/utxo.mjs); outputs: [{ address, coin, assets }].
export function assembleOnce(T, inputs, outputs, fee) {
  const CSL = T.CSL;
  const ins = CSL.TransactionInputs.new();
  const keys = new Set();
  for (const u of [...inputs].sort((x, y) => cmpRef(x.ref, y.ref))) {
    const [h, i] = u.ref.split('#');
    const th = CSL.TransactionHash.from_hex(h);
    const ti = CSL.TransactionInput.new(th, Number(i));
    ins.add(ti);
    ti.free();
    th.free();
    keys.add(u.cred);
  }
  const outs = CSL.TransactionOutputs.new();
  for (const o of outputs) {
    const a = CSL.Address.from_bech32(o.address);
    const v = valueOf(CSL, o.coin, o.assets);
    const out = CSL.TransactionOutput.new(a, v);
    outs.add(out);
    for (const x of [out, v, a]) x.free();
  }
  const f = CSL.BigNum.from_str(fee.toString());
  const body = CSL.TransactionBody.new_tx_body(ins, outs, f);
  const ws = T.build.makeWitnessSet(keys.size);
  const tx = CSL.Transaction.new(body, ws);
  const bytes = Buffer.from(tx.to_bytes()).toString('hex');
  for (const x of [tx, ws, body, f, outs, ins]) x.free();
  return { bytes, k: keys.size };
}

// The transaction at its minimum fee. Returns { ok, bytes, fee, size, k,
// outputs } or the failure outputsFor gave.
export function assembleAtMinimumFee(T, params, inputs, outputsFor, { scriptFee = 0n } = {}) {
  const at = (fee) => {
    const outs = outputsFor(fee);
    if (!outs.ok) return outs;
    const a = assembleOnce(T, inputs, outs.outputs, fee);
    const t = inspectTx(a.bytes);
    return { ok: true, bytes: a.bytes, fee, size: t.size, serializedSize: t.serializedSize, k: a.k, outputs: outs.outputs, hash: t.hash, need: minFee(params, t.size, scriptFee) };
  };
  return leastSelfCoveringFee(at, minFee(params, 0, scriptFee));
}

// The fixed point of the fee: rising until the fee covers its transaction,
// then lowered while a lower fee still covers its own (smaller) transaction.
// at(fee) returns the transaction at that fee with its minimum as `need`.
export function leastSelfCoveringFee(at, start) {
  let fee = start;
  let cur = null;
  for (let it = 0; it < 24; it++) {
    cur = at(fee);
    if (!cur.ok) return cur;
    if (cur.need <= fee) break;
    fee = cur.need;
    cur = null;
  }
  if (!cur) throw new Error('assemble: the fee did not settle');
  for (let it = 0; it < 24 && cur.need < cur.fee; it++) {
    const lower = at(cur.need);
    if (!lower.ok || lower.need > lower.fee) break;
    cur = lower;
  }
  const { need: _need, ...out } = cur;
  return out;
}
