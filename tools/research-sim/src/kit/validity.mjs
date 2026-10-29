// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The validity checks as a run mode (`--validity` of the replay and battery
// commands): every transaction a method or plan returns and the kit passes is
// read by cardano-serialization-lib, whose re-serialization must have the
// transaction's inputs, fee and witness count and its outputs by decoded
// content, and the four negative controls (kit/controls.mjs) must each be
// caught by their own check.
//
// CSL writes a policy's asset names shortest first, so an output's bytes can
// differ from the transaction's; and it re-encodes some fixed parts (the
// certificates, the witness lists) as tagged sets, so the transaction's hash
// can differ. Both are counted (cslOutputBytes, cslReencoded) and neither is
// a failure.
//
// A transaction with no outputs has no fee or value control
// (kit/controls.mjs); it is counted in notApplicable, not as a failure.
//
// An accumulator is made per wallet and arm (a replay) or per battery run,
// checkAndApply feeds it, and `summarize` turns it into the record's
// `validity` field. A failure names the transaction by position, never by
// hash.

import { negativeControls, EXPECTED } from './controls.mjs';
import { inspectTx } from './inspect.mjs';

const MAX_DETAILS = 20;
const CONTROLS = Object.freeze(['fee', 'size', 'value', 'witnesses']);

export function newValidity(CSL) {
  return { CSL, txs: 0, cslRead: 0, cslOutputBytes: 0, cslReencoded: 0, controls: { fee: 0, size: 0, value: 0, witnesses: 0 }, notApplicable: { fee: 0, value: 0 }, failed: 0, details: [], onFailure: null };
}

// An output by what it holds: address, coin, assets as a set, datum and
// script reference.
const content = (o) => JSON.stringify({
  address: Buffer.from(o.address).toString('hex'),
  coin: o.coin,
  assets: [...o.assets].map((a) => ({ policy: a.policy, name: a.name, qty: a.qty })).sort((x, y) => (x.policy + x.name < y.policy + y.name ? -1 : x.policy + x.name > y.policy + y.name ? 1 : 0)),
  datum: o.datum,
  scriptRef: o.scriptRef
}, (_, v) => (typeof v === 'bigint' ? `${v}n` : v && v.type === 'Buffer' ? Buffer.from(v.data).toString('hex') : v));

const fail = (v, at, index, what, detail) => {
  v.failed++;
  if (v.details.length < MAX_DETAILS) v.details.push({ at, tx: index, check: what, detail });
  if (v.onFailure) v.onFailure({ at, tx: index, check: what, detail });
};

// One transaction (hex) the kit passed. `at` names where in the run it came
// from; `index` its position in the answer; `state` is the state it spends
// from; ctx is the kit's: { resolve, implicit, scriptFee, extraWitnesses }.
export function checkValidity(v, at, index, state, params, bytes, ctx) {
  v.txs++;
  let c;
  try {
    c = negativeControls(state, params, bytes, ctx);
  } catch (e) {
    fail(v, at, index, 'controls', `a control could not be built: ${String(e && e.message || e)}`);
  }
  if (c) for (const k of ['base', ...CONTROLS]) {
    if (c[k] === null) v.notApplicable[k]++;
    else if (c[k] !== EXPECTED[k]) fail(v, at, index, k === 'base' ? 'base' : `control ${k}`, `${k === 'base' ? 'the unmutated transaction' : `the ${k} control`} gave '${c[k]}', expected '${EXPECTED[k]}'`);
    else if (k !== 'base') v.controls[k]++;
  }
  let again;
  try {
    const t = v.CSL.Transaction.from_bytes(Buffer.from(bytes, 'hex'));
    again = inspectTx(Buffer.from(t.to_bytes()).toString('hex'));
    t.free();
  } catch (e) {
    fail(v, at, index, 'csl read', String(e && e.message || e));
    return;
  }
  const mine = inspectTx(bytes);
  if (again.hash !== mine.hash) v.cslReencoded++;
  if (again.outputs.map((o) => o.raw.toString('hex')).join() !== mine.outputs.map((o) => o.raw.toString('hex')).join()) v.cslOutputBytes++;
  const sameOutputs = again.outputs.length === mine.outputs.length && again.outputs.every((o, i) => content(o) === content(mine.outputs[i]));
  const diffs = [];
  if (again.fee !== mine.fee) diffs.push('fee');
  if (again.inputs.map((i) => i.ref).join() !== mine.inputs.map((i) => i.ref).join()) diffs.push('inputs');
  if (!sameOutputs) diffs.push('outputs');
  if (again.vkeys.length !== mine.vkeys.length) diffs.push('witness count');
  if (diffs.length) fail(v, at, index, 'csl read', `CSL's re-serialization differs in ${diffs.join(', ')}`);
  else v.cslRead++;
}

// The record's validity field.
export function summarize(v) {
  return { txs: v.txs, cslRead: v.cslRead, cslOutputBytes: v.cslOutputBytes, cslReencoded: v.cslReencoded, controls: { ...v.controls }, notApplicable: { ...v.notApplicable }, failed: v.failed, ...(v.details.length ? { failures: v.details } : {}) };
}

// The sum of summaries.
export function sumValidity(list) {
  const t = { txs: 0, cslRead: 0, cslOutputBytes: 0, cslReencoded: 0, controls: { fee: 0, size: 0, value: 0, witnesses: 0 }, notApplicable: { fee: 0, value: 0 }, failed: 0 };
  for (const s of list) {
    if (!s) continue;
    for (const k of ['txs', 'cslRead', 'cslOutputBytes', 'cslReencoded', 'failed']) t[k] += s[k];
    for (const k of CONTROLS) t.controls[k] += s.controls[k];
    for (const k of ['fee', 'value']) t.notApplicable[k] += s.notApplicable[k];
  }
  return t;
}
