// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import { CSL, toHex, fromHex } from './util.mjs';

// min_fee = a * size + b, plus the reference-script charge for scripts held by
// spent inputs (15 lovelace per byte on preprod; the tiered multiplier only
// applies above 25 KiB of reference scripts, far beyond anything here).
export function feeFor(params, size, refScriptBytes = 0) {
  return params.minFeeA * BigInt(size) + params.minFeeB + BigInt(Math.ceil(refScriptBytes * params.refScriptFeePerByte));
}

// Assemble and sign a transaction. Every transaction carries network id 0, so
// the ledger itself rejects it anywhere but a testnet.
//   inputs   [{ txHash, index }]
//   outputs  [CSL.TransactionOutput]
//   mint     [{ script, assets: [[nameHex, qty]] }], one entry per policy; a
//            negative quantity burns
//   signers  [CSL.PrivateKey]
export function assemble({ inputs, outputs, fee, mint = [], signers }) {
  const ins = CSL.TransactionInputs.new();
  for (const i of inputs) ins.add(CSL.TransactionInput.new(CSL.TransactionHash.from_bytes(fromHex(i.txHash)), i.index));
  const outs = CSL.TransactionOutputs.new();
  for (const o of outputs) outs.add(o);
  const body = CSL.TransactionBody.new_tx_body(ins, outs, CSL.BigNum.from_str(fee.toString()));
  body.set_network_id(CSL.NetworkId.testnet());
  const witnesses = CSL.TransactionWitnessSet.new();
  if (mint.length) {
    const m = CSL.Mint.new();
    const scripts = CSL.NativeScripts.new();
    for (const p of mint) {
      const ma = CSL.MintAssets.new();
      for (const [name, qty] of p.assets) {
        const q = qty < 0n ? CSL.Int.new_negative(CSL.BigNum.from_str((-qty).toString())) : CSL.Int.new(CSL.BigNum.from_str(qty.toString()));
        ma.insert(CSL.AssetName.new(fromHex(name)), q);
      }
      m.insert(p.script.hash(), ma);
      scripts.add(p.script);
    }
    body.set_mint(m);
    witnesses.set_native_scripts(scripts);
  }
  const bodyBytes = body.to_bytes();
  const hash = CSL.FixedTransaction.new_from_body_bytes(bodyBytes).transaction_hash();
  const vkeys = CSL.Vkeywitnesses.new();
  for (const sk of signers) vkeys.add(CSL.make_vkey_witness(hash, sk));
  witnesses.set_vkeys(vkeys);
  const tx = CSL.Transaction.new(body, witnesses);
  const bytes = tx.to_bytes();
  // The id computed from the body must be the id of the serialized transaction.
  const check = toHex(CSL.FixedTransaction.from_bytes(bytes).transaction_hash().to_bytes());
  if (check !== toHex(hash.to_bytes())) throw new Error('transaction id mismatch after serialization');
  return { bytes, hash: toHex(hash.to_bytes()), size: bytes.length };
}

// Find the exact minimum fee: build with a fee, measure, rebuild with the fee
// that size needs, until the two agree. `build(fee)` returns { size, ... }.
export function settle(params, build, refScriptBytes = 0) {
  let fee = 250000n;
  for (let i = 0; i < 8; i++) {
    const built = build(fee);
    if (built.short) return built;
    const need = feeFor(params, built.size, refScriptBytes);
    if (need === fee) return { ...built, fee };
    fee = need;
  }
  throw new Error('fee did not settle');
}
