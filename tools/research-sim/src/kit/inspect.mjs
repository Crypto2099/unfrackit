// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A built transaction read from its bytes, without CSL: the parts every check
// reads, each output with its original bytes. The decoder is the history
// reader's (history/tx.mjs), which keeps every part's original encoding. The
// layout is the Conway CDDL's (IntersectMBO/cardano-ledger at
// 391db20866113f08bc6317cb5c341304365986c6,
// eras/conway/impl/cddl/data/conway.cddl: transaction 16-17, body 107-128,
// output 197-202, witness set 760-771, vkeywitness 773).

import { decodeTx, inputs, outputs, fee, mint, withdrawals, donation, vkeyWitnesses, collateralInputs, referenceInputs, collateralReturn, totalCollateral, redeemers } from '../history/tx.mjs';
import { decodeOutput } from '../history/output.mjs';
import { parseAddress } from '../history/address.mjs';
import { decode, asBytes, asUint } from '../history/cbor.mjs';

export function inspectTx(bytesIn) {
  const bytes = typeof bytesIn === 'string' ? Buffer.from(bytesIn, 'hex') : Buffer.from(bytesIn);
  const tx = decodeTx(bytes);
  const outs = outputs(tx).map((o) => {
    const d = decodeOutput(tx.buf, o.node);
    return { index: o.index, raw: Buffer.from(o.raw), address: Buffer.from(d.address), coin: d.coin, assets: d.assets, datum: d.datum, scriptRef: d.scriptRef, form: d.form, addr: parseAddress(d.address) };
  });
  const ret = collateralReturn(tx);
  return {
    tx,
    hash: tx.hash,
    // The ledger's size (without the validity flag) and the length of the
    // bytes as serialized.
    size: tx.size,
    serializedSize: bytes.length,
    alonzo: tx.alonzo,
    isValid: tx.isValid,
    inputs: inputs(tx),
    referenceInputs: referenceInputs(tx),
    collateralInputs: collateralInputs(tx),
    collateralReturn: ret ? (() => { const d = decodeOutput(tx.buf, ret.node); return { raw: Buffer.from(ret.raw), address: Buffer.from(d.address), coin: d.coin, assets: d.assets, datum: d.datum, scriptRef: d.scriptRef }; })() : null,
    totalCollateral: totalCollateral(tx),
    outputs: outs,
    fee: fee(tx),
    mint: mint(tx),
    withdrawals: withdrawals(tx),
    donation: donation(tx),
    vkeys: vkeyWitnesses(tx),
    redeemers: redeemers(tx),
    bodyFields: [...tx.body.order],
    witnessKeys: [...tx.wits.order],
    hasAux: !!tx.aux,
    auxHashField: tx.body.fields.has(7)
  };
}

// The payment credential of an output given as its CIP-30
// TransactionUnspentOutput CBOR ([input, output]; CIP-0030,
// "TransactionUnspentOutput").
export function unspentOutputParts(cborHex) {
  const b = Buffer.from(cborHex, 'hex');
  const n = decode(b);
  if (n.mt !== 4 || n.items.length !== 2) throw new Error('TransactionUnspentOutput: expected [input, output]');
  const [inp, out] = n.items;
  if (inp.mt !== 4 || inp.items.length !== 2) throw new Error('TransactionUnspentOutput: bad input');
  const id = asBytes(inp.items[0], 'transaction id');
  if (id.length !== 32) throw new Error('TransactionUnspentOutput: transaction id of the wrong length');
  const txid = id.toString('hex');
  const index = Number(asUint(inp.items[1], 'output index'));
  const d = decodeOutput(b, out);
  return {
    txid,
    index,
    ref: `${txid}#${index}`,
    outputRaw: Buffer.from(b.subarray(out.s, out.e)),
    address: Buffer.from(d.address),
    coin: d.coin,
    assets: d.assets,
    datum: d.datum,
    scriptRef: d.scriptRef,
    form: d.form,
    addr: parseAddress(d.address)
  };
}
