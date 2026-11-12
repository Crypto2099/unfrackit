// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A helper for the bridge's tests (methods/helper.mjs), in plain Node, so the
// bridge is tested without another language: it answers schema-1 requests
// with the csl-lf adapter (methods/csl.mjs) at its own change, run on the
// state and the intent the request carries, and returns its transaction or
// its failure, classified by the adapter. A 'witness' request writes the vkey
// witnesses it is given in place of the transaction's, keeping the set's
// head as CSL wrote it. It loads the treatment from RESEARCH_SIM_TREATMENT_DIR
// and RESEARCH_SIM_TREATMENT_PINS, as the tests do, and exits at the end of
// its input. With HELPER_TEST_EXIT_ON=<n> it exits with code 3 on its n-th
// request instead of answering it; with HELPER_TEST_GARBAGE_ON=<n> it writes
// a line that is not a response.

import { createInterface } from 'node:readline';
import { treatment } from './treatment.mjs';
import { cslMethod } from '../../src/methods/csl.mjs';
import { makeState } from '../../src/state/state.mjs';
import { utxoFromCbor } from '../../src/state/utxo.mjs';
import { normalizeParams } from '../../src/kit/params.mjs';
import { decodeOutput } from '../../src/history/output.mjs';
import { sortAssets } from '../../src/history/value.mjs';
import { decode, head } from '../../src/history/cbor.mjs';

const T = await treatment();
const method = cslMethod(T, { strategy: 'lf' });
const cache = new Map();
let last = null;
let n = 0;

const assetsOf = (list) => sortAssets((list || []).map((a) => ({ policy: a.policy, name: a.name, qty: BigInt(a.qty) })));

function stateOf(q) {
  const utxos = q.utxos.map((u) => {
    if (u.cbor !== undefined) cache.set(u.ref, utxoFromCbor(u.cbor, { origin: 'initial' }));
    const r = cache.get(u.ref);
    if (!r) throw new Error(`no bytes for ${u.ref}`);
    return r;
  });
  return makeState({ network: q.network, stakeCred: q.stakeCred, changeAddress: q.changeAddress, utxos, at: q.at });
}

function intentOf(q) {
  const j = q.intent;
  const imp = j.implicit || { withdrawals: '0', refunds: '0', deposits: '0', donation: '0', mint: [], burn: [] };
  const f = j.fixed;
  return {
    id: j.id,
    source: j.source,
    requested: q.outputs.map((cbor) => {
      const b = Buffer.from(cbor, 'hex');
      const d = decodeOutput(b, decode(b));
      return { cbor, datum: d.datum, scriptRef: d.scriptRef };
    }),
    implicit: { withdrawals: BigInt(imp.withdrawals), refunds: BigInt(imp.refunds), deposits: BigInt(imp.deposits), donation: BigInt(imp.donation), mint: assetsOf(imp.mint), burn: assetsOf(imp.burn) },
    fixed: f
      ? {
          inputs: f.inputs,
          referenceInputs: f.referenceInputs,
          body: f.body,
          witnesses: f.witnesses,
          redeemers: f.redeemers.map((r) => ({ ...r, exUnits: [BigInt(r.exUnits[0]), BigInt(r.exUnits[1])] })),
          auxiliaryData: f.auxiliaryData,
          scriptFee: BigInt(f.scriptFee),
          fixedBytes: Number(f.fixedBytes),
          refScriptBytes: Number(f.refScriptBytes || 0)
        }
      : null,
    collateral: { required: j.collateralRequired }
  };
}

// The inputs add_inputs_from chose, when it chose any: csl-lf's own path
// with a change policy no change builds ('selection'), on a state whose map
// records the UTxOs the adapter reads by reference (library.mjs recordsOf,
// which it calls on the inputs it chose before it builds any change).
async function selection(state, intent, params, opts) {
  const got = [];
  class Recording extends Map {
    get(k) {
      got.push(k);
      return super.get(k);
    }
  }
  const s = { ...state, utxos: new Recording(state.utxos) };
  try {
    await method.build(s, intent, params, { ...opts, changePolicy: 'selection' });
  } catch (e) {
    if (/^unknown change policy selection$/.test(String(e && e.message))) return got;
  }
  return null;
}

async function build(q) {
  last = null;
  const state = stateOf(q);
  const intent = intentOf(q);
  const params = normalizeParams(q.params);
  const opts = { changePolicy: 'default', seed: q.seed === null ? 1 : Number(q.seed), collateralRule: 'ledger', ...(q.collateral ? { collateral: utxoFromCbor(q.collateral.cbor, { origin: 'initial' }) } : {}) };
  let r;
  try {
    r = await method.build(state, intent, params, opts);
  } catch (e) {
    return { ok: false, class: 'other', error: String(e && (e.message || e)) };
  }
  if (!r.ok) {
    if (r.class === 'not-replayable') return { ok: false, notReplayable: 'csl', error: r.detail };
    const inputs = await selection(state, intent, params, opts);
    return { ok: false, class: r.class, error: r.detail, ...(inputs ? { inputs } : {}) };
  }
  last = r.txs[0].bytes;
  return { ok: true, tx: last, ...(r.library && r.library.unpriced && r.library.unpriced.length ? { unpriced: r.library.unpriced } : {}) };
}

// The transaction's witness-set key 0 replaced by the given items, its head
// (a tag-258 set or a plain array) kept; added as a tag-258 set when absent.
function witness(q) {
  if (!last) throw new Error('no transaction built');
  const buf = Buffer.from(last, 'hex');
  const tx = decode(buf);
  const ws = tx.items[1];
  const items = q.vkeys.map((h) => Buffer.from(h, 'hex'));
  const at = ws.entries.findIndex(([k]) => Number(k.value) === 0);
  let wsBytes;
  if (at >= 0) {
    const v = ws.entries[at][1];
    const arr = v.mt === 6 ? v.item : v;
    const set = Buffer.concat([v.mt === 6 ? buf.subarray(v.s, arr.s) : Buffer.alloc(0), head(4, items.length), ...items]);
    wsBytes = Buffer.concat([buf.subarray(ws.s, v.s), set, buf.subarray(v.e, ws.e)]);
  } else {
    const set = Buffer.concat([Buffer.from([0xd9, 0x01, 0x02]), head(4, items.length), ...items]);
    wsBytes = Buffer.concat([head(5, ws.entries.length + 1), Buffer.from([0x00]), set, ...ws.entries.map(([k, v]) => buf.subarray(k.s, v.e))]);
  }
  return { ok: true, tx: Buffer.concat([buf.subarray(0, ws.s), wsBytes, buf.subarray(ws.e)]).toString('hex') };
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  n++;
  const q = JSON.parse(line);
  if (Number(process.env.HELPER_TEST_EXIT_ON) === n) process.exit(3);
  if (Number(process.env.HELPER_TEST_GARBAGE_ON) === n) {
    process.stdout.write('not a response\n');
    continue;
  }
  let r;
  try {
    r = q.op === 'build' ? await build(q) : q.op === 'witness' ? witness(q) : { ok: false, error: `unknown op ${q.op}` };
  } catch (e) {
    r = { ok: false, error: String(e && (e.message || e)) };
  }
  process.stdout.write(`${JSON.stringify({ id: q.id, ...r })}\n`);
}
