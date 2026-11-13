// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Transaction outputs: decoding the bytes on chain, re-encoding an output from
// cardano-db-sync's columns, and the CIP-30 TransactionUnspentOutput form.
//
// The Conway CDDL (IntersectMBO/cardano-ledger at
// 391db20866113f08bc6317cb5c341304365986c6, eras/conway/impl/cddl/data/
// conway.cddl:138-206 and :364-383) allows two output forms:
//   alonzo_transaction_output  = [address, amount : value, ? datum_hash : hash32]
//   babbage_transaction_output = { 0 : address, 1 : value, ? 2 : datum_option, ? 3 : script_ref }
//   datum_option = [0, hash32 // 1, #6.24(bytes .cbor plutus_data)]
//   script_ref   = #6.24(bytes .cbor [0, native_script // 1, plutus_v1_script // 2, ... // 3, ...])
// A Plutus script inside script_ref is a byte string whose content is the
// script's serialized bytes; a native script is its CBOR.
//
// CIP-30 ("TransactionUnspentOutput", CIPs at 4fa39658c9c0e95a13e2957a88afd353b48b5452)
// defines a wallet's UTxO as cbor<[input: transaction_input, output: transaction_output]>.

import { decode, raw, asBytes, asUint, head, encArray, encBytes, encUint, encMap, encTag, CborError } from './cbor.mjs';
import { decodeValue, encodeValue } from './value.mjs';

// The reference-script size the Conway fee rule counts: the script's original
// bytes (cardano-ledger, eras/conway/impl/src/Cardano/Ledger/Conway/UTxO.hs:
// 158-171, txNonDistinctRefScriptsSize sums originalBytesSize of each
// reference script). For a Plutus script these are the script bytes inside its
// byte string; for a native script its CBOR.
function scriptOfRef(buf, refNode) {
  if (refNode.mt !== 6 || refNode.tag !== 24n) throw new CborError(`script_ref: expected tag 24 at byte ${refNode.s}`);
  const inner = asBytes(refNode.item, 'script_ref bytes');
  const s = decode(inner);
  if (s.mt !== 4 || s.items.length !== 2) throw new CborError('script_ref: expected [language, script]');
  const lang = Number(asUint(s.items[0], 'script language'));
  let script;
  if (lang === 0) script = raw(inner, s.items[1]);
  else if (lang >= 1 && lang <= 3) script = asBytes(s.items[1], 'plutus script');
  else throw new CborError(`script_ref: unknown language ${lang}`);
  return { cbor: inner.toString('hex'), lang, script: script.toString('hex'), size: script.length, raw: raw(buf, refNode).toString('hex') };
}

function datumOption(buf, node) {
  if (node.mt !== 4 || node.items.length !== 2) throw new CborError(`datum_option: expected a pair at byte ${node.s}`);
  const kind = Number(asUint(node.items[0], 'datum_option kind'));
  if (kind === 0) return { kind: 'hash', hash: asBytes(node.items[1], 'datum hash').toString('hex') };
  if (kind === 1) {
    const t = node.items[1];
    if (t.mt !== 6 || t.tag !== 24n) throw new CborError('inline datum: expected tag 24');
    return { kind: 'inline', cbor: asBytes(t.item, 'inline datum').toString('hex') };
  }
  throw new CborError(`datum_option: unknown kind ${kind}`);
}

// An output node of `buf` to { form, address, coin, assets, datum, scriptRef }.
export function decodeOutput(buf, node) {
  if (node.mt === 4) {
    if (node.items.length < 2 || node.items.length > 3) throw new CborError(`output: array of ${node.items.length}`);
    const v = decodeValue(node.items[1]);
    return {
      form: 'array',
      address: asBytes(node.items[0], 'address'),
      coin: v.coin,
      assets: v.assets,
      datum: node.items.length === 3 ? { kind: 'hash', hash: asBytes(node.items[2], 'datum hash').toString('hex') } : null,
      scriptRef: null
    };
  }
  if (node.mt === 5) {
    const f = new Map(node.entries.map(([k, x]) => [Number(asUint(k, 'output key')), x]));
    for (const k of f.keys()) if (k > 3) throw new CborError(`output: unknown key ${k}`);
    if (!f.has(0) || !f.has(1)) throw new CborError('output: no address or value');
    const v = decodeValue(f.get(1));
    return {
      form: 'map',
      address: asBytes(f.get(0), 'address'),
      coin: v.coin,
      assets: v.assets,
      datum: f.has(2) ? datumOption(buf, f.get(2)) : null,
      scriptRef: f.has(3) ? scriptOfRef(buf, f.get(3)) : null
    };
  }
  throw new CborError(`output: expected an array or a map at byte ${node.s}`);
}

export function decodeOutputBytes(bytes) {
  const b = Buffer.from(bytes);
  return decodeOutput(b, decode(b));
}

function scriptRefBytes(scriptRef) {
  // scriptRef: { lang, script } where script is the Plutus script's bytes, or
  // the native script's CBOR.
  const s = Buffer.from(scriptRef.script, 'hex');
  const inner = encArray([encUint(scriptRef.lang), scriptRef.lang === 0 ? s : encBytes(s)]);
  return encTag(24, encBytes(inner));
}

// Encodes an output. `form` is 'array' or 'map'; an inline datum or a
// reference script needs the map form. `datum` is null, { kind: 'hash', hash }
// or { kind: 'inline', cbor }; `scriptRef` is null or { lang, script }.
export function encodeOutput({ address, coin, assets, datum = null, scriptRef = null }, form) {
  const addr = encBytes(Buffer.from(address));
  const value = encodeValue(coin, assets);
  if (form === 'array') {
    if (scriptRef || (datum && datum.kind !== 'hash')) throw new Error('an inline datum or a reference script needs the map form');
    const items = [addr, value];
    if (datum) items.push(encBytes(Buffer.from(datum.hash, 'hex')));
    return encArray(items);
  }
  if (form !== 'map') throw new Error(`unknown output form ${form}`);
  const pairs = [
    [encUint(0), addr],
    [encUint(1), value]
  ];
  if (datum) {
    const opt =
      datum.kind === 'hash'
        ? encArray([encUint(0), encBytes(Buffer.from(datum.hash, 'hex'))])
        : encArray([encUint(1), encTag(24, encBytes(Buffer.from(datum.cbor, 'hex')))]);
    pairs.push([encUint(2), opt]);
  }
  if (scriptRef) pairs.push([encUint(3), scriptRefBytes(scriptRef)]);
  return encMap(pairs);
}

// The form a re-encoded output takes when the original form is unknown (it is
// not among db-sync's columns): the map form when the output needs it, the
// array form otherwise.
export const autoForm = ({ datum, scriptRef }) => (scriptRef || (datum && datum.kind === 'inline') ? 'map' : 'array');

// The output's bytes with its coin replaced and every other byte as it was.
export function withCoin(outputBytes, coin) {
  const b = Buffer.from(outputBytes);
  const n = decode(b);
  let valueNode;
  if (n.mt === 4) valueNode = n.items[1];
  else if (n.mt === 5) valueNode = n.entries.find(([k]) => k.mt === 0 && k.value === 1n)[1];
  else throw new CborError('output: expected an array or a map');
  const coinNode = valueNode.mt === 0 ? valueNode : valueNode.items[0];
  if (coinNode.mt !== 0) throw new CborError('output: the coin is not an unsigned integer');
  return Buffer.concat([b.subarray(0, coinNode.s), encUint(coin), b.subarray(coinNode.e)]);
}

export function transactionInput(txHashHex, index) {
  return encArray([encBytes(Buffer.from(txHashHex, 'hex')), encUint(index)]);
}

// cbor<[input, output]> (CIP-30, "TransactionUnspentOutput").
export function unspentOutput(txHashHex, index, outputBytes) {
  return Buffer.concat([head(4, 2), transactionInput(txHashHex, index), Buffer.from(outputBytes)]);
}
