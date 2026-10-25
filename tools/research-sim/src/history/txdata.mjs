// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Everything the intent of one transaction needs, read in batches: the
// transaction's row and bytes, what db-sync records it consumed, its outputs
// with their stake credentials, every output it spends, collateralizes or
// references (resolved by reference from the bytes, since db-sync keeps no
// collateral or reference input of a phase-2-invalid transaction), its
// withdrawals and mints as db-sync records them, and the protocol
// parameters of its epoch.

import { q } from './db.mjs';
import { lifeRow, loadExtras } from './wallet.mjs';
import { inputs, collateralInputs, referenceInputs } from './tx.mjs';

const BATCH = 200;

async function assetsFor(ctx, ids) {
  const m = new Map();
  for (let i = 0; i < ids.length; i += 2000) {
    const got = await q(ctx.client, ctx.blocks, 'output_assets', { ids: { type: 'intarr', value: ids.slice(i, i + 2000) } });
    for (const a of got) {
      const k = Number(a.tx_out_id);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push({ policy: a.policy, name: a.name, qty: BigInt(a.qty) });
    }
  }
  return m;
}

export async function epochParams(ctx, epochs) {
  const need = [...new Set(epochs)].filter((e) => !ctx.epochParams.has(e));
  if (need.length) {
    const got = await q(ctx.client, ctx.blocks, 'epoch_params', { epochs: { type: 'intarr', value: need } });
    for (const r of got) ctx.epochParams.set(Number(r.epoch_no), r);
  }
  for (const e of epochs) if (!ctx.epochParams.has(e)) throw new Error(`no epoch_param row for epoch ${e}`);
}

export async function resolveRefs(ctx, refs) {
  const want = [...new Set(refs)].filter((r) => !ctx.resolved.has(r));
  for (let i = 0; i < want.length; i += 1000) {
    const part = want.slice(i, i + 1000);
    const hashes = part.map((r) => r.split('#')[0]);
    const indexes = part.map((r) => Number(r.split('#')[1]));
    const got = await q(ctx.client, ctx.blocks, 'resolve_outputs', { hashes: { type: 'bytearr', value: hashes }, indexes: { type: 'int4arr', value: indexes } });
    const assets = await assetsFor(ctx, got.map((g) => Number(g.tx_out_id)));
    const rows = got.map((g) => lifeRow({ ...g, created_tx: g.tx_id, consumed_tx: null }, assets.get(Number(g.tx_out_id)) || []));
    await loadExtras(ctx, rows);
    for (const r of rows) ctx.resolved.set(r.ref, r);
  }
  for (const r of refs) if (!ctx.resolved.has(r)) throw new Error(`output ${r} is not in the database`);
}

export async function loadBundles(ctx, txIds) {
  const out = new Map();
  const ids = [...new Set(txIds)].sort((a, b) => a - b);
  for (let i = 0; i < ids.length; i += BATCH) {
    const part = ids.slice(i, i + BATCH);
    const p = { ids: { type: 'intarr', value: part } };
    const rows = await q(ctx.client, ctx.blocks, 'txs', p);
    const decoded = await ctx.bytes.fetch(rows);
    const consumed = new Map(part.map((x) => [x, []]));
    for (const c of await q(ctx.client, ctx.blocks, 'tx_consumed', p)) consumed.get(Number(c.tx_in_id)).push(`${c.src_hash}#${Number(c.src_index)}`);
    const outRows = await q(ctx.client, ctx.blocks, 'tx_outputs', p);
    const outAssets = await assetsFor(ctx, outRows.map((o) => Number(o.tx_out_id)));
    const outputs = new Map(part.map((x) => [x, new Map()]));
    const hashOf = new Map(rows.map((r) => [Number(r.id), r.hash]));
    const outLife = [];
    for (const o of outRows) {
      const r = lifeRow({ ...o, created_tx: o.tx_id, tx_hash: hashOf.get(Number(o.tx_id)), consumed_tx: null }, outAssets.get(Number(o.tx_out_id)) || []);
      outputs.get(Number(o.tx_id)).set(r.index, r);
      outLife.push(r);
    }
    await loadExtras(ctx, outLife);
    const withdrawals = new Map(part.map((x) => [x, []]));
    for (const w of await q(ctx.client, ctx.blocks, 'withdrawals', p)) withdrawals.get(Number(w.tx_id)).push({ account: w.account, coin: BigInt(w.amount) });
    const mints = new Map(part.map((x) => [x, []]));
    for (const m of await q(ctx.client, ctx.blocks, 'mints', p)) mints.get(Number(m.tx_id)).push({ policy: m.policy, name: m.name, qty: BigInt(m.qty) });
    const refs = [];
    for (const r of rows) {
      const d = decoded.get(Number(r.id));
      for (const x of [...inputs(d), ...collateralInputs(d), ...referenceInputs(d)]) refs.push(x.ref);
    }
    await resolveRefs(ctx, refs);
    await epochParams(ctx, rows.map((r) => Number(r.epoch_no)));
    for (const r of rows) {
      const id = Number(r.id);
      out.set(id, {
        row: r,
        id,
        tx: decoded.get(id),
        consumed: consumed.get(id),
        outputs: outputs.get(id),
        withdrawals: withdrawals.get(id),
        mints: mints.get(id),
        ep: ctx.epochParams.get(Number(r.epoch_no))
      });
    }
  }
  return out;
}
