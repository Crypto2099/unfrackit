// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The four negative controls on one built transaction, checked against the
// state it spends from: the fee one lovelace under the ledger's minimum (the
// difference moved into the last output, so the transaction stays balanced),
// one byte over the size limit, a Value one byte over the value-size limit,
// and one vkey witness short. Each must be caught by its own check alone.
// `negativeControls` returns the checks each control failed. The mutations
// (`withFee`, `withoutOneWitness`) rewrite the transaction's CBOR keeping
// every other part's bytes.

import { encUint, encArray, encMap, decode, raw } from '../history/cbor.mjs';
import { withCoin } from '../history/output.mjs';
import { decodeTx, assembleTx } from '../history/tx.mjs';
import { checkTx } from './check.mjs';
import { inspectTx } from './inspect.mjs';
import { minFee } from './fee.mjs';
import { valueSize } from '../history/value.mjs';
import { parseAddress, addressBytes } from '../history/address.mjs';

// Rebuilds a transaction's body with field `key` replaced by `newRaw` (or
// removed when null); everything else keeps its bytes.
export function withBodyField(bytes, key, newRaw) {
  const t = decodeTx(Buffer.from(bytes, 'hex'));
  const pairs = [];
  for (const k of t.body.order) {
    if (k === key) {
      if (newRaw) pairs.push([encUint(k), newRaw]);
    } else pairs.push([raw(t.buf, t.body.fields.get(k).keyNode), t.body.fields.get(k).raw]);
  }
  if (!t.body.fields.has(key) && newRaw) pairs.push([encUint(key), newRaw]);
  const wits = t.wits.raw;
  return assembleTx({ body: encMap(pairs), wits, aux: t.aux ? t.aux.raw : null, isValid: t.isValid, alonzo: t.alonzo }).toString('hex');
}

// The fee set to `fee` and the difference moved into output `index`'s coin,
// so the transaction stays balanced.
export function withFee(bytes, fee, index) {
  const t = decodeTx(Buffer.from(bytes, 'hex'));
  const oldFee = decode(t.body.fields.get(2).raw).value;
  const outs = decode(t.body.fields.get(1).raw).items.map((o) => Buffer.from(raw(t.body.fields.get(1).raw, o)));
  const cur = decode(outs[index]);
  const coinNode = cur.mt === 4 ? cur.items[1] : cur.entries.find(([k]) => k.value === 1n)[1];
  const coin = coinNode.mt === 0 ? coinNode.value : coinNode.items[0].value;
  outs[index] = withCoin(outs[index], coin + (oldFee - BigInt(fee)));
  const b1 = withBodyField(bytes, 1, encArray(outs));
  return withBodyField(b1, 2, encUint(fee));
}

// One vkey witness removed (the witness set otherwise as it was).
export function withoutOneWitness(bytes) {
  const t = decodeTx(Buffer.from(bytes, 'hex'));
  const pairs = [];
  for (const k of t.wits.order) {
    const f = t.wits.fields.get(k);
    if (k === 0) {
      let node = decode(f.raw);
      const tagged = node.mt === 6;
      if (tagged) node = node.item;
      const items = node.items.slice(1).map((n) => raw(tagged ? f.raw : f.raw, n));
      if (items.length) pairs.push([encUint(0), encArray(items)]);
    } else pairs.push([raw(t.buf, f.keyNode), f.raw]);
  }
  return assembleTx({ body: t.body.raw, wits: encMap(pairs), aux: t.aux ? t.aux.raw : null, isValid: t.isValid, alonzo: t.alonzo }).toString('hex');
}

export function negativeControls(state, params, bytes, ctx = {}) {
  const view = (u) => u && { coin: u.coin, assets: u.assets, addr: parseAddress(addressBytes(u.address)) };
  const resolve = (ref) => view(state.utxos.get(ref));
  const c = { params, resolve, ...ctx };
  const base = checkTx(bytes, c);
  const t = inspectTx(bytes);
  // The distinct checks that failed: several outputs may share the largest
  // Value, and each is caught by the same check.
  const reasons = (r) => [...new Set(r.failures.map((f) => f.check))].join(',');
  const vb = Math.max(...t.outputs.map((o) => valueSize(o.coin, o.assets)));
  return {
    base: base.ok ? '' : reasons(base),
    fee: reasons(checkTx(withFee(bytes, minFee(params, t.size, ctx.scriptFee || 0n) - 1n, t.outputs.length - 1), c)),
    size: reasons(checkTx(bytes, { ...c, params: { ...params, maxTxSize: t.size - 1 } })),
    value: reasons(checkTx(bytes, { ...c, params: { ...params, maxValSize: vb - 1 } })),
    witnesses: reasons(checkTx(withoutOneWitness(bytes), c))
  };
}

export const EXPECTED = Object.freeze({ base: '', fee: 'fee', size: 'size', value: 'value-size', witnesses: 'witnesses' });
