// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The snapshot block and the two windows, by the extraction tool's rules and
// conventions (tools/research-corpus, sql/windows.sql and
// src/pipeline.mjs): the recent window runs from the first block whose time
// is at or after the snapshot's time less 365 days through the snapshot
// block; the peak window is the busiest run of 73 completed epochs from the
// Mary hard fork. A window [B1, B2] is the transaction-id range [first id
// with block_id >= B1, T(B2)], and its start state is as of T(B1's
// predecessor). When the extraction run's params.json is given, its snapshot
// and windows are used as they are.

import { readFileSync } from 'node:fs';
import { q } from './db.mjs';

export const RECENT_SECONDS = 365 * 86400;

const num = (x) => (x === null || x === undefined ? null : Number(x));
const block = (r) => ({ id: num(r.id), no: num(r.block_no), slot: num(r.slot_no), epoch: num(r.epoch_no), time: num(r.time), hash: r.hash });

export async function blockById(ctx, id) {
  const r = (await q(ctx.client, ctx.blocks, 'block_by_id', { block_id: { type: 'int', value: id } }))[0];
  if (!r) throw new Error(`no block with id ${id}`);
  return block(r);
}

export async function snapshotBlock(ctx, spec) {
  let r;
  if (!spec || spec === 'tip') r = (await q(ctx.client, ctx.blocks, 'tip_block'))[0];
  else if (/^[0-9a-f]{64}$/.test(spec)) r = (await q(ctx.client, ctx.blocks, 'block_by_hash', { hash: { type: 'bytea', value: spec } }))[0];
  else if (/^\d+$/.test(spec)) r = (await q(ctx.client, ctx.blocks, 'block_by_id', { block_id: { type: 'int', value: Number(spec) } }))[0];
  if (!r) throw new Error(`no snapshot block ${spec}`);
  const b = block(r);
  b.tx = await tOf(ctx, b.id);
  return b;
}

export async function tOf(ctx, blockId) {
  return num((await q(ctx.client, ctx.blocks, 't_of_block', { block_id: { type: 'int', value: blockId } }))[0].t);
}

export async function firstTxFrom(ctx, blockId) {
  return num((await q(ctx.client, ctx.blocks, 'first_tx_from_block', { block_id: { type: 'int', value: blockId } }))[0].t);
}

export async function prevBlock(ctx, blockId) {
  return num((await q(ctx.client, ctx.blocks, 'prev_block', { block_id: { type: 'int', value: blockId } }))[0].b);
}

// A window over blocks [b1, b2].
export async function windowOf(ctx, b1, b2) {
  const first = await blockById(ctx, b1);
  const last = await blockById(ctx, b2);
  const lo = await firstTxFrom(ctx, b1);
  const hi = await tOf(ctx, b2);
  const p = await prevBlock(ctx, b1);
  const tStart = p === null ? 0 : await tOf(ctx, p);
  return { first, last, lo, hi, tStart };
}

// The recent window, or, for a test, the window of the given number of days
// ending at the snapshot.
export async function recentWindow(ctx, snap, seconds = RECENT_SECONDS) {
  const r = (await q(ctx.client, ctx.blocks, 'recent_first_block', { snap_block: { type: 'int', value: snap.id }, seconds: { type: 'int', value: seconds } }))[0];
  return windowOf(ctx, num(r.id), snap.id);
}

export async function peakWindow(ctx, snap) {
  const r = (await q(ctx.client, ctx.blocks, 'peak_window', { snap_block: { type: 'int', value: snap.id } }))[0];
  if (!r) throw new Error('no complete 73-epoch run before the snapshot epoch');
  const w = await windowOf(ctx, num(r.first_block), num(r.last_block));
  return { ...w, firstEpoch: num(r.first_epoch), lastEpoch: num(r.last_epoch), nTx: r.n_tx };
}

// The extraction run's params.json: the snapshot block and the windows'
// block and transaction-id bounds. Block rows are read again from the
// database by id.
export function fromExtractionRun(path) {
  const p = JSON.parse(readFileSync(path, 'utf8'));
  const win = (x) => ({ firstBlock: num(x.first_block), lastBlock: num(x.last_block), lo: num(x.lo), hi: num(x.hi), tStart: num(x.t_start) });
  return { network: p.network, runId: p.run_id, snapshot: { id: num(p.snapshot.id), hash: p.snapshot.hash, tx: num(p.snapshot.t) }, windows: { recent: win(p.windows.recent), peak: win(p.windows.peak) } };
}

// A window given by the extraction run, with its block rows, checked against
// the database.
export async function windowFromRun(ctx, w) {
  const x = await windowOf(ctx, w.firstBlock, w.lastBlock);
  if (x.lo !== w.lo || x.hi !== w.hi || x.tStart !== w.tStart) throw new Error('the extraction run\'s window bounds differ from the database\'s');
  return x;
}
