// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Two computations over a transaction split into an intent's parts.
//
// rebuildCheck: the transaction rebuilt from the intent's fixed parts, its
// requested outputs, the observed wallet inputs, change and witnesses, each
// part's original bytes placed where the transaction has it, must have the
// transaction's exact body hash and size. Every input, output, body field and
// witness must come from exactly one part, so the check shows that the
// intent and the observed wallet parts together are the whole transaction.
//
// withoutFixedSize: the size of the same transaction with its fixed parts
// removed, keeping only the selector's wallet inputs, every output, the fee,
// the collateral fields and the wallet's own payment-key witnesses. The bytes
// of the fixed parts are the observed size less this, computed once per
// intent (cardano-ledger's size rule, tx.mjs).

import { headSize, raw } from './cbor.mjs';
import { blake2b256 } from './blake2b.mjs';
import { inputs, collateralInputs, referenceInputs, outputs, fee, totalCollateral } from './tx.mjs';

export class IntentCheck extends Error {}

// Body fields that are not fixed parts: inputs, outputs and fee (the arm's),
// the auxiliary-data and script-data hashes (recomputed by the builder from
// the fixed parts), collateral (the arm's), and reference inputs (a fixed
// part of their own).
export const NOT_FIXED_BODY = new Set([0, 1, 2, 7, 11, 13, 16, 17, 18]);

const hex = (b) => Buffer.from(b).toString('hex');

function fail(tx, msg) {
  throw new IntentCheck(`transaction ${tx.hash}: rebuild: ${msg}`);
}

function sameMultiset(a, b) {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

// A set or list node's bytes before its first item and after its last.
function frame(buf, node) {
  let arr = node;
  let pre = Buffer.alloc(0);
  if (node.mt === 6) {
    pre = buf.subarray(node.s, node.item.s);
    arr = node.item;
  }
  const first = arr.items.length ? arr.items[0].s : arr.e - (arr.indefinite ? 1 : 0);
  return { pre, open: buf.subarray(arr.s, first), close: arr.indefinite ? Buffer.from([0xff]) : Buffer.alloc(0), arr, tagged: node.mt === 6 };
}

function rebuildList(tx, node, items) {
  const f = frame(tx.buf, node);
  return Buffer.concat([f.pre, f.open, ...items, f.close]);
}

export function rebuildCheck(tx, { fixedInputs, selectable, requested, walletOutputs, fixed, collateral, walletWitnesses, otherWitnesses }) {
  const fb = fixed ? fixed.body : {};
  const fw = fixed ? fixed.witnesses : {};
  const parts = [];
  const bodyNode = tx.body.node;
  for (const [k, v] of bodyNode.entries) {
    const key = Number(k.value);
    let bytes;
    if (key === 0) {
      const ins = inputs(tx);
      const got = [...(fixed ? fixed.inputs.map((x) => x.ref) : []), ...selectable.map((r) => r.ref)];
      if (!sameMultiset(got, ins.map((x) => x.ref))) fail(tx, 'the fixed and wallet inputs are not the transaction\'s inputs');
      bytes = rebuildList(tx, v, ins.map((x) => x.raw));
    } else if (key === 1) {
      const byIndex = new Map();
      const put = (i, b) => {
        if (byIndex.has(i) && byIndex.get(i) !== b) fail(tx, `output ${i} from two parts that differ`);
        byIndex.set(i, b);
      };
      for (const r of requested) if (r.index !== null) put(r.index, r.raised ? r.raised.original : r.cbor);
      for (const o of walletOutputs) put(o.index, o.cbor);
      const outs = outputs(tx);
      if (byIndex.size !== outs.length) fail(tx, `${byIndex.size} outputs from the parts, ${outs.length} in the transaction`);
      bytes = rebuildList(tx, v, outs.map((o) => Buffer.from(byIndex.get(o.index), 'hex')));
    } else if (key === 2) {
      bytes = raw(tx.buf, v);
      if (BigInt(v.value) !== fee(tx)) fail(tx, 'fee');
    } else if (key === 7 || key === 11) {
      bytes = raw(tx.buf, v);
    } else if (key === 13) {
      const ci = collateralInputs(tx);
      if (!collateral.observed || !sameMultiset(collateral.observed.inputs.map((x) => x.ref), ci.map((x) => x.ref))) fail(tx, 'collateral inputs');
      bytes = rebuildList(tx, v, ci.map((x) => x.raw));
    } else if (key === 16) {
      if (!collateral.observed || !collateral.observed.return) fail(tx, 'collateral return');
      bytes = Buffer.from(collateral.observed.return, 'hex');
    } else if (key === 17) {
      if (!collateral.observed || collateral.observed.total !== totalCollateral(tx)) fail(tx, 'total collateral');
      bytes = raw(tx.buf, v);
    } else if (key === 18) {
      const ri = referenceInputs(tx);
      if (!fixed || !sameMultiset(fixed.referenceInputs.map((x) => x.ref), ri.map((x) => x.ref))) fail(tx, 'reference inputs');
      bytes = rebuildList(tx, v, ri.map((x) => x.raw));
    } else {
      if (NOT_FIXED_BODY.has(key) || !(key in fb)) fail(tx, `body field ${key} is in no part`);
      bytes = Buffer.from(fb[key], 'hex');
    }
    parts.push(raw(tx.buf, k), bytes);
  }
  for (const k of Object.keys(fb)) if (!tx.body.fields.has(Number(k))) fail(tx, `fixed body field ${k} is not in the transaction`);
  const first = bodyNode.entries.length ? bodyNode.entries[0][0].s : bodyNode.e;
  const body = Buffer.concat([tx.buf.subarray(bodyNode.s, first), ...parts, bodyNode.indefinite ? Buffer.from([0xff]) : Buffer.alloc(0)]);
  if (blake2b256(body).toString('hex') !== tx.hash) fail(tx, 'the rebuilt body does not hash to the transaction id');

  const wparts = [];
  const witsNode = tx.wits.node;
  for (const [k, v] of witsNode.entries) {
    const key = Number(k.value);
    let bytes;
    if (key === 0) {
      const got = [...otherWitnesses.map((x) => hex(x.raw)), ...walletWitnesses.map((x) => hex(x.raw))];
      const f = frame(tx.buf, v);
      const orig = f.arr.items.map((x) => hex(raw(tx.buf, x)));
      if (!sameMultiset(got, orig)) fail(tx, 'the fixed and wallet vkey witnesses are not the transaction\'s');
      bytes = rebuildList(tx, v, orig.map((h) => Buffer.from(h, 'hex')));
    } else {
      if (!(key in fw)) fail(tx, `witness-set key ${key} is in no part`);
      bytes = Buffer.from(fw[key], 'hex');
    }
    wparts.push(raw(tx.buf, k), bytes);
  }
  const wfirst = witsNode.entries.length ? witsNode.entries[0][0].s : witsNode.e;
  const wits = Buffer.concat([tx.buf.subarray(witsNode.s, wfirst), ...wparts, witsNode.indefinite ? Buffer.from([0xff]) : Buffer.alloc(0)]);
  const aux = fixed && fixed.auxiliaryData ? Buffer.from(fixed.auxiliaryData, 'hex') : null;
  if (!!aux !== !!tx.aux) fail(tx, 'auxiliary data');
  const size = 1 + body.length + wits.length + (aux ? aux.length : 1);
  if (size !== tx.size) fail(tx, `rebuilt size ${size}, transaction size ${tx.size}`);
  if (!wits.equals(tx.wits.raw)) {
    // Same items in the same frame: only an item order could differ, which
    // the witness-set multiset check above rules out.
    fail(tx, 'the rebuilt witness set differs from the transaction\'s');
  }
}

function listSize(tx, node, n, itemBytes) {
  const f = frame(tx.buf, node);
  const open = f.arr.indefinite ? 1 : headSize(n);
  return f.pre.length + open + itemBytes + f.close.length;
}

export function withoutFixedSize(tx, { selectableRefs, walletWitnesses }) {
  const KEEP = new Set([0, 1, 2, 13, 16, 17]);
  const bodyNode = tx.body.node;
  const kept = bodyNode.entries.filter(([k]) => KEEP.has(Number(k.value)));
  let body = bodyNode.indefinite ? 2 : headSize(kept.length);
  for (const [k, v] of kept) {
    body += k.e - k.s;
    if (Number(k.value) === 0) {
      const sel = inputs(tx).filter((x) => selectableRefs.has(x.ref));
      body += listSize(tx, v, sel.length, sel.reduce((s, x) => s + x.raw.length, 0));
    } else {
      body += v.e - v.s;
    }
  }
  let wits = 1;
  if (walletWitnesses.length) {
    const f0 = tx.wits.fields.get(0);
    wits = (tx.wits.node.indefinite ? 2 : headSize(1)) + (f0.keyNode.e - f0.keyNode.s) + listSize(tx, f0.node, walletWitnesses.length, walletWitnesses.reduce((s, x) => s + x.raw.length, 0));
  }
  return 1 + body + wits + 1;
}
