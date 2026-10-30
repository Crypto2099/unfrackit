// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The mainnet byte source on preprod: transactions reassembled from
// preprod's own node ImmutableDB, read over SSH, against db-sync's tx_cbor,
// byte for byte, over transactions of every Shelley-based era. Every one must
// also hash to db-sync's transaction hash and have db-sync's size.
//
// Selection, reproducible: for each era (by epoch_param.protocol_major),
// every epoch when the era has at most ten, otherwise its first, middle and
// last; in each, the first 40 blocks that carry transactions; every
// transaction of those blocks; and the first and the last 25 phase-2-invalid
// transactions at or before the snapshot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { context, immutableOpts, record } from './env.mjs';
import { q } from '../../../src/history/db.mjs';
import { decodeTx } from '../../../src/history/tx.mjs';
import { checkTx } from '../../../src/history/bytes.mjs';

const ERAS = { shelley: [2, 2], allegra: [3, 3], mary: [4, 4], alonzo: [5, 6], babbage: [7, 8], conway: [9, 10] };

test('ImmutableDB transactions equal tx_cbor byte for byte, across eras', { timeout: 3600 * 1000 }, async () => {
  const ctx = await context(immutableOpts());
  const out = { eras: {}, total: 0, equal: 0 };
  try {
    const eps = (await ctx.client.query('SELECT epoch_no, protocol_major FROM public.epoch_param ORDER BY epoch_no')).rows;
    for (const [era, [lo, hi]] of Object.entries(ERAS)) {
      const es = eps.filter((e) => e.protocol_major >= lo && e.protocol_major <= hi && e.epoch_no < ctx.snapshot.epoch).map((e) => Number(e.epoch_no));
      if (!es.length) continue;
      const pick = es.length <= 10 ? es : [...new Set([es[0], es[Math.floor(es.length / 2)], es[es.length - 1]])];
      const ids = [];
      for (const e of pick) {
        const bl = (await ctx.client.query(
          `WITH b AS MATERIALIZED (SELECT id FROM public.block WHERE epoch_no = $1 AND tx_count > 0 AND id <= $2)
           SELECT id FROM b ORDER BY id LIMIT 40`, [e, ctx.snapshot.id])).rows.map((r) => Number(r.id));
        if (!bl.length) continue;
        for (const r of (await ctx.client.query('SELECT id FROM public.tx WHERE block_id = ANY($1::bigint[])', [bl])).rows) ids.push(Number(r.id));
      }
      const rows = await q(ctx.client, ctx.blocks, 'txs', { ids: { type: 'intarr', value: ids } });
      const t0 = performance.now();
      const imm = await ctx.bytes.immutable.readTxs(rows.map((r) => ({ txId: Number(r.id), blockHash: r.block_hash, slot: Number(r.slot_no), blockIndex: Number(r.block_index) })));
      const ms = performance.now() - t0;
      const cb = new Map((await q(ctx.client, ctx.blocks, 'tx_cbor', { ids: { type: 'intarr', value: ids } })).map((r) => [Number(r.tx_id), r.bytes]));
      let equal = 0;
      for (const r of rows) {
        const a = imm.get(Number(r.id));
        const b = cb.get(Number(r.id));
        checkTx(decodeTx(a), r);
        assert.ok(a.equals(b), `${era}: transaction ${r.hash} differs from tx_cbor`);
        equal++;
      }
      out.eras[era] = { epochs: pick, blocks: new Set(rows.map((r) => r.block_hash)).size, transactions: rows.length, equal, seconds: ms / 1000 };
      out.total += rows.length;
      out.equal += equal;
    }
    const allInv = (await ctx.client.query('WITH t AS MATERIALIZED (SELECT id FROM public.tx WHERE NOT valid_contract) SELECT id FROM t WHERE id <= $1 ORDER BY id', [ctx.snapshot.tx])).rows.map((r) => Number(r.id));
    const inv = [...new Set([...allInv.slice(0, 25), ...allInv.slice(-25)])];
    const irows = await q(ctx.client, ctx.blocks, 'txs', { ids: { type: 'intarr', value: inv } });
    const iimm = await ctx.bytes.immutable.readTxs(irows.map((r) => ({ txId: Number(r.id), blockHash: r.block_hash, slot: Number(r.slot_no), blockIndex: Number(r.block_index) })));
    const icb = new Map((await q(ctx.client, ctx.blocks, 'tx_cbor', { ids: { type: 'intarr', value: inv } })).map((r) => [Number(r.tx_id), r.bytes]));
    let ieq = 0;
    for (const r of irows) {
      const a = iimm.get(Number(r.id));
      const d = decodeTx(a);
      checkTx(d, r);
      assert.equal(d.isValid, false);
      assert.ok(a.equals(icb.get(Number(r.id))), `invalid transaction ${r.hash} differs from tx_cbor`);
      ieq++;
    }
    out.phase2Invalid = { onChain: allInv.length, transactions: irows.length, equal: ieq };
    out.total += irows.length;
    out.equal += ieq;
    record('07-bytes', out);
    assert.ok(out.total > 0);
    assert.equal(out.equal, out.total);
    for (const era of Object.keys(ERAS)) assert.ok(out.eras[era] && out.eras[era].transactions > 0, `${era}: no transaction read`);
  } finally {
    await ctx.client.end();
  }
});
