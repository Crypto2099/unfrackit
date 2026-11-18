// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Outputs re-encoded from db-sync's columns against the original output
// bytes, sliced from the creating transaction's tx_cbor. The reader re-encodes
// every UTxO record and every resolved input this way, on both networks, so
// that preprod runs the code mainnet runs; this test reports, for every
// output form it meets, where the two differ. A difference in content (an
// address, a coin, an asset, a datum or a reference script) fails the test;
// a difference in form (array against map) or in encoding alone is counted.
//
// Selection, reproducible: the seeded wallets' UTxOs at the snapshot, and the
// outputs of tx_out TABLESAMPLE SYSTEM (0.05) REPEATABLE (2026) created at or
// before the snapshot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { context, record, shapeWallets } from './env.mjs';
import { q } from '../../../src/history/db.mjs';
import { loadLife, aliveAt, lifeRow, loadExtras, reencode } from '../../../src/history/wallet.mjs';
import { outputs as txOutputs } from '../../../src/history/tx.mjs';
import { decodeOutputBytes } from '../../../src/history/output.mjs';
import { decodeOutput } from '../../../src/history/output.mjs';

function kindOf(d) {
  return `${d.form}${d.datum ? `+${d.datum.kind}-datum` : ''}${d.scriptRef ? `+${['native', 'plutus-v1', 'plutus-v2', 'plutus-v3'][d.scriptRef.lang]}-ref` : ''}${d.assets.length ? '+assets' : ''}${d.address[0] >> 4 === 8 ? '+byron' : ''}`;
}

const sameContent = (a, b) =>
  a.address.equals(b.address) &&
  a.coin === b.coin &&
  JSON.stringify(a.assets, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) === JSON.stringify(b.assets, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) &&
  JSON.stringify(a.datum) === JSON.stringify(b.datum) &&
  (a.scriptRef ? b.scriptRef && a.scriptRef.lang === b.scriptRef.lang && a.scriptRef.script === b.scriptRef.script : !b.scriptRef);

test('outputs re-encoded from db-sync\'s columns against their original bytes', { timeout: 6 * 3600 * 1000 }, async () => {
  const ctx = await context();
  const tally = {};
  let total = 0;
  try {
    const shapes = await shapeWallets(ctx);
    const rows = [];
    for (const sa of Object.values(shapes)) rows.push(...aliveAt(await loadLife(ctx.client, ctx.blocks, sa, ctx.snapshot.tx), ctx.snapshot.tx));
    const sampled = (await ctx.client.query(
      `WITH s AS MATERIALIZED (SELECT o.id, o.tx_id, o.index FROM public.tx_out o TABLESAMPLE SYSTEM (0.05) REPEATABLE (2026) WHERE o.tx_id <= $1)
       SELECT o.id AS tx_out_id, o.tx_id, encode(t.hash, 'hex') AS tx_hash, o.index, o.value::text AS value, o.address, o.address_has_script AS script_pay,
              encode(o.payment_cred, 'hex') AS payment_cred, o.stake_address_id, encode(o.data_hash, 'hex') AS data_hash, o.inline_datum_id, o.reference_script_id
         FROM s JOIN public.tx_out o ON o.id = s.id JOIN public.tx t ON t.id = o.tx_id`, [ctx.snapshot.tx])).rows;
    const ids = sampled.map((r) => Number(r.tx_out_id));
    const assets = new Map();
    for (let i = 0; i < ids.length; i += 2000) {
      for (const a of await q(ctx.client, ctx.blocks, 'output_assets', { ids: { type: 'intarr', value: ids.slice(i, i + 2000) } })) {
        const k = Number(a.tx_out_id);
        if (!assets.has(k)) assets.set(k, []);
        assets.get(k).push({ policy: a.policy, name: a.name, qty: BigInt(a.qty) });
      }
    }
    for (const r of sampled) rows.push(lifeRow({ ...r, created_tx: r.tx_id, consumed_tx: null }, assets.get(Number(r.tx_out_id)) || []));
    await loadExtras(ctx, rows);
    const byTx = new Map();
    for (const r of rows) {
      if (!byTx.has(r.createdTx)) byTx.set(r.createdTx, []);
      byTx.get(r.createdTx).push(r);
    }
    const txIds = [...byTx.keys()];
    for (let i = 0; i < txIds.length; i += 300) {
      const part = txIds.slice(i, i + 300);
      const txRows = await q(ctx.client, ctx.blocks, 'txs', { ids: { type: 'intarr', value: part } });
      const decoded = await ctx.bytes.fetch(txRows);
      for (const id of part) {
        const d = decoded.get(id);
        const outs = txOutputs(d);
        for (const r of byTx.get(id)) {
          // A phase-2-invalid transaction's one output is its collateral return.
          const o = d.isValid ? outs.find((x) => x.index === r.index) : { raw: d.body.fields.get(16).raw, node: d.body.fields.get(16).node };
          const orig = decodeOutput(d.buf, o.node);
          const enc = reencode(ctx, r);
          const mine = decodeOutputBytes(enc.bytes);
          const kind = kindOf(orig);
          const verdict = enc.bytes.equals(Buffer.from(o.raw)) ? 'equal' : !sameContent(orig, mine) ? 'content' : orig.form !== mine.form ? `form ${orig.form} to ${mine.form}` : 'encoding';
          tally[kind] = tally[kind] || {};
          tally[kind][verdict] = (tally[kind][verdict] || 0) + 1;
          total++;
          assert.notEqual(verdict, 'content', `output ${r.ref}: re-encoded content differs`);
        }
      }
    }
    record('02-reencoding', { outputs: total, byForm: tally });
  } finally {
    await ctx.client.end();
  }
});
