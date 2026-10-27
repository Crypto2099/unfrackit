// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Transactions constructed by hand in the Conway CDDL's layout
// (IntersectMBO/cardano-ledger at 391db20866113f08bc6317cb5c341304365986c6,
// eras/conway/impl/cddl/data/conway.cddl), for the ledger kit's tests, and
// mutations of built transactions for its negative controls. Synthetic keys
// and hashes only.

import { encUint, encBytes, encArray, encMap, TRUE, NULL, decode, raw } from '../../src/history/cbor.mjs';
import { encodeOutput, withCoin } from '../../src/history/output.mjs';
import { blake2b224, blake2b256 } from '../../src/history/blake2b.mjs';
import { decodeTx, assembleTx } from '../../src/history/tx.mjs';

export const vkeyOf = (i) => Buffer.alloc(32, 0x10 + i);
export const keyHash = (i) => blake2b224(vkeyOf(i)).toString('hex');
export const STAKE = '5a'.repeat(28);

// A base address: key payment part `pay` (hex), key stake part `stake`.
export const baseAddr = (pay, stake = STAKE, net = 1) => Buffer.concat([Buffer.from([net]), Buffer.from(pay, 'hex'), Buffer.from(stake, 'hex')]);
export const scriptAddr = (hash, stake = STAKE, net = 1) => Buffer.concat([Buffer.from([0x10 | net]), Buffer.from(hash, 'hex'), Buffer.from(stake, 'hex')]);

export const input = (txid, i) => encArray([encBytes(Buffer.from(txid, 'hex')), encUint(i)]);
export const out = (address, coin, assets = []) => encodeOutput({ address, coin, assets }, 'array');
export const vkeyWitness = (i) => encArray([encBytes(vkeyOf(i)), encBytes(Buffer.alloc(64, 0x50 + i))]);

// body fields: { inputs: [input bytes], outputs: [output bytes], fee, ...raw
// fields by number }.
export function body({ inputs, outputs, fee, extra = {}, auxHash = null }) {
  const pairs = [
    [encUint(0), encArray(inputs)],
    [encUint(1), encArray(outputs)],
    [encUint(2), encUint(fee)]
  ];
  if (auxHash) pairs.push([encUint(7), encBytes(auxHash)]);
  for (const k of Object.keys(extra).map(Number).sort((a, b) => a - b)) pairs.push([encUint(k), extra[k]]);
  return encMap(pairs);
}

export function tx({ inputs, outputs, fee, vkeys = 1, extra = {}, aux = null, witnessExtra = [] }) {
  const b = body({ inputs, outputs, fee, extra, auxHash: aux ? blake2b256(aux) : null });
  const wpairs = [];
  if (vkeys) wpairs.push([encUint(0), encArray(Array.from({ length: vkeys }, (_, i) => vkeyWitness(i)))]);
  for (const [k, v] of witnessExtra) wpairs.push([encUint(k), v]);
  return assembleTx({ body: b, wits: encMap(wpairs), aux, isValid: true, alonzo: true });
}

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

export { NULL, TRUE, encUint, encBytes, encArray, encMap };
