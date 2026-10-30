// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Transactions constructed by hand in the Conway CDDL's layout
// (IntersectMBO/cardano-ledger at 391db20866113f08bc6317cb5c341304365986c6,
// eras/conway/impl/cddl/data/conway.cddl), for the ledger kit's tests, and
// mutations of built transactions for its negative controls. Synthetic keys
// and hashes only.

import { encUint, encBytes, encArray, encMap, TRUE, NULL } from '../../src/history/cbor.mjs';
import { encodeOutput } from '../../src/history/output.mjs';
import { blake2b224, blake2b256 } from '../../src/history/blake2b.mjs';
import { assembleTx } from '../../src/history/tx.mjs';

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

export { withBodyField, withFee, withoutOneWitness } from '../../src/kit/controls.mjs';

export { NULL, TRUE, encUint, encBytes, encArray, encMap };
