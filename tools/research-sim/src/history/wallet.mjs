// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A wallet's outputs over its whole history, its UTxO set at any transaction
// id, its UTxO records, its franken-flagged credentials and the arrival of
// its assets.
//
// A wallet is a stake credential; its outputs are those db-sync gives its
// stake_address_id: outputs at base addresses with its stake credential,
// whatever their payment credential, and outputs at pointer addresses created
// before Conway (CIP-19, "Delegation part" and "Pointers"; CIPs at
// 4fa39658c9c0e95a13e2957a88afd353b48b5452). Byron outputs carry no stake
// credential and are never a wallet's.
//
// The UTxO set at transaction id T is every output created at or before T and
// not consumed at or before T: the life-table rule of the extraction tool
// (tools/research-corpus, sql/06-01-txo.sql), computed here from the wallet's
// own rows, without a study table. sql/history.sql's ref_digests is the
// independent reference it is checked against.
//
// Held UTxOs are flagged and kept: a UTxO at a script payment credential, one
// carrying a datum or a reference script, and one at a franken-flagged
// payment credential. Held UTxOs count in holdings and are never offered to a
// selector or the planner.

import { q } from './db.mjs';
import { addressBytes } from './address.mjs';
import { sortAssets, canonicalLine } from './value.mjs';
import { encodeOutput, autoForm, unspentOutput, decodeOutputBytes } from './output.mjs';
import { outputs as txOutputs } from './tx.mjs';
import { createHash } from 'node:crypto';

export const HELD = Object.freeze({ script: 'script-payment', datum: 'datum', refScript: 'reference-script', franken: 'franken' });

// rows of wallet_outputs and wallet_output_assets to the wallet's life.
export async function loadLife(client, blocks, saId, hi) {
  const p = { sa_id: { type: 'int', value: saId }, hi: { type: 'int', value: hi } };
  const rows = await q(client, blocks, 'wallet_outputs', p);
  const assetRows = await q(client, blocks, 'wallet_output_assets', p);
  const assets = new Map();
  for (const a of assetRows) {
    const k = Number(a.tx_out_id);
    if (!assets.has(k)) assets.set(k, []);
    assets.get(k).push({ policy: a.policy, name: a.name, qty: BigInt(a.qty) });
  }
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const id = Number(r.tx_out_id);
    if (seen.has(id)) throw new Error(`wallet ${saId}: output ${r.tx_hash}#${r.index} is consumed twice`);
    seen.add(id);
    out.push(lifeRow(r, assets.get(id) || []));
  }
  return out;
}

export function lifeRow(r, assets) {
  return {
    txOutId: Number(r.tx_out_id),
    createdTx: Number(r.created_tx ?? r.tx_id),
    txHash: r.tx_hash,
    index: Number(r.index),
    ref: `${r.tx_hash}#${Number(r.index)}`,
    coin: BigInt(r.value),
    address: r.address,
    scriptPay: r.script_pay === true,
    paymentCred: r.payment_cred,
    dataHash: r.data_hash || null,
    inlineDatumId: r.inline_datum_id === null || r.inline_datum_id === undefined ? null : Number(r.inline_datum_id),
    refScriptId: r.reference_script_id === null || r.reference_script_id === undefined ? null : Number(r.reference_script_id),
    consumedTx: r.consumed_tx === null || r.consumed_tx === undefined ? null : Number(r.consumed_tx),
    stakeAddressId: r.stake_address_id === undefined ? null : r.stake_address_id === null ? null : Number(r.stake_address_id),
    assets: sortAssets(assets)
  };
}

export const aliveAt = (life, t) => life.filter((r) => r.createdTx <= t && (r.consumedTx === null || r.consumedTx > t));

export function heldReason(row, franken) {
  if (row.scriptPay) return HELD.script;
  if (row.dataHash || row.inlineDatumId !== null) return HELD.datum;
  if (row.refScriptId !== null) return HELD.refScript;
  if (franken && row.paymentCred && franken.has(row.paymentCred)) return HELD.franken;
  return null;
}

export function linesOf(rows) {
  return rows.map((r) => canonicalLine(r.txHash, r.index, r.coin, r.assets)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// The count and MD5 of a set's canonical lines, as ref_digests computes them.
export function digestOf(rows) {
  const lines = linesOf(rows);
  return { n: lines.length, digest: createHash('md5').update(lines.join('\n')).digest('hex') };
}

// Franken flags (in wallets with two or more key payment credentials): a key
// payment credential is flagged if it never appears as an input in a
// transaction that also spends another of the wallet's key payment
// credentials, across the wallet's whole history up to the snapshot, in a
// wallet where at least one pair does co-spend. The extraction tool's rule
// (sql/05-05-franken.sql), on the wallet's own rows.
export function frankenFlags(life, snapTx) {
  const creds = new Set();
  const byTx = new Map();
  for (const r of life) {
    if (r.scriptPay || !r.paymentCred) continue;
    if (r.createdTx <= snapTx) creds.add(r.paymentCred);
    if (r.consumedTx !== null && r.consumedTx <= snapTx) {
      if (!byTx.has(r.consumedTx)) byTx.set(r.consumedTx, new Set());
      byTx.get(r.consumedTx).add(r.paymentCred);
    }
  }
  const co = new Set();
  for (const s of byTx.values()) if (s.size >= 2) for (const c of s) co.add(c);
  const flagged = new Set();
  if (creds.size >= 2 && co.size > 0) for (const c of creds) if (!co.has(c)) flagged.add(c);
  return { flagged, nCreds: creds.size, anyCospend: co.size > 0 };
}

// Holdings: units of each asset over a set of rows.
export function holdingsOf(rows) {
  const m = new Map();
  for (const r of rows) for (const a of r.assets) m.set(`${a.policy}.${a.name}`, (m.get(`${a.policy}.${a.name}`) || 0n) + a.qty);
  return m;
}

// The arrival of every asset held at transaction id t: the first transaction
// that put the asset in one of the wallet's outputs, over the whole history up
// to t, or, when none can be found, the creating transaction of the UTxO
// holding it at t, flagged.
export function arrivalTable(life, t) {
  const first = new Map();
  for (const r of life) {
    if (r.createdTx > t) continue;
    for (const a of r.assets) {
      const k = `${a.policy}.${a.name}`;
      const f = first.get(k);
      if (!f || r.createdTx < f.txId) first.set(k, { txId: r.createdTx, tx: r.txHash });
    }
  }
  const out = [];
  const held = new Map();
  for (const r of aliveAt(life, t)) {
    for (const a of r.assets) {
      const k = `${a.policy}.${a.name}`;
      if (!held.has(k)) held.set(k, { policy: a.policy, name: a.name, holder: r });
    }
  }
  for (const [k, h] of [...held].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const f = first.get(k);
    if (f) out.push({ policy: h.policy, name: h.name, tx: f.tx, txId: f.txId, flagged: false });
    else out.push({ policy: h.policy, name: h.name, tx: h.holder.txHash, txId: h.holder.createdTx, flagged: true });
  }
  return out;
}

// Loads the datum and script bytes a set of rows needs, and the creating
// transaction's bytes for a native reference script, whose bytes db-sync does
// not keep (doc/schema.md, script.bytes: null for native scripts).
export async function loadExtras(ctx, rows) {
  const datumIds = [...new Set(rows.map((r) => r.inlineDatumId).filter((x) => x !== null && !ctx.datums.has(x)))];
  const scriptIds = [...new Set(rows.map((r) => r.refScriptId).filter((x) => x !== null && !ctx.scripts.has(x)))];
  for (let i = 0; i < datumIds.length; i += 1000) {
    const got = await q(ctx.client, ctx.blocks, 'datums', { ids: { type: 'intarr', value: datumIds.slice(i, i + 1000) } });
    for (const d of got) ctx.datums.set(Number(d.id), { hash: d.hash, bytes: d.bytes });
  }
  for (let i = 0; i < scriptIds.length; i += 1000) {
    const got = await q(ctx.client, ctx.blocks, 'scripts', { ids: { type: 'intarr', value: scriptIds.slice(i, i + 1000) } });
    for (const s of got) ctx.scripts.set(Number(s.id), { hash: s.hash, type: s.type, bytes: s.bytes, size: s.serialised_size });
  }
  // Native reference scripts: the creating transactions' bytes.
  const need = rows.filter((r) => r.refScriptId !== null && ['timelock', 'multisig'].includes(ctx.scripts.get(r.refScriptId).type) && !ctx.nativeRefs.has(r.ref));
  if (need.length) {
    const txIds = [...new Set(need.map((r) => r.createdTx))];
    const txRows = await q(ctx.client, ctx.blocks, 'txs', { ids: { type: 'intarr', value: txIds } });
    const decoded = await ctx.bytes.fetch(txRows);
    for (const r of need) {
      const d = decoded.get(r.createdTx);
      const o = txOutputs(d).find((x) => x.index === r.index);
      if (!o) throw new Error(`output ${r.ref} not found in its transaction's bytes`);
      const dec = decodeOutputBytes(o.raw);
      if (!dec.scriptRef || dec.scriptRef.lang !== 0) throw new Error(`output ${r.ref}: db-sync names a native reference script the bytes do not carry`);
      ctx.nativeRefs.set(r.ref, dec.scriptRef.script);
    }
  }
}

const SCRIPT_LANG = { timelock: 0, multisig: 0, plutusV1: 1, plutusV2: 2, plutusV3: 3 };

// The output re-encoded from db-sync's columns.
export function reencode(ctx, r) {
  let datum = null;
  if (r.inlineDatumId !== null) datum = { kind: 'inline', cbor: ctx.datums.get(r.inlineDatumId).bytes.toString('hex') };
  else if (r.dataHash) datum = { kind: 'hash', hash: r.dataHash };
  let scriptRef = null;
  if (r.refScriptId !== null) {
    const s = ctx.scripts.get(r.refScriptId);
    const lang = SCRIPT_LANG[s.type];
    if (lang === undefined) throw new Error(`output ${r.ref}: unknown script type ${s.type}`);
    scriptRef = { lang, script: lang === 0 ? ctx.nativeRefs.get(r.ref) : s.bytes.toString('hex') };
  }
  const o = { address: addressBytes(r.address), coin: r.coin, assets: r.assets, datum, scriptRef };
  const form = autoForm(o);
  return { bytes: encodeOutput(o, form), form, datum, scriptRef };
}

// A UTxO record in the simulator's form.
export function utxoRecord(ctx, r, origin, franken) {
  const enc = reencode(ctx, r);
  return {
    ref: r.ref,
    cbor: unspentOutput(r.txHash, r.index, enc.bytes).toString('hex'),
    address: r.address,
    cred: r.paymentCred,
    coin: r.coin,
    assets: r.assets,
    held: heldReason(r, franken),
    origin
  };
}

// The reference-script size of an output (for the Conway fee term), from
// db-sync: a Plutus script's bytes, or a native script's CBOR.
export function refScriptSize(ctx, r) {
  if (r.refScriptId === null) return 0;
  const s = ctx.scripts.get(r.refScriptId);
  if (s.type === 'timelock' || s.type === 'multisig') return Buffer.from(ctx.nativeRefs.get(r.ref), 'hex').length;
  return s.bytes.length;
}
