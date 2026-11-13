// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The reconstruction check: for the seeded wallets and 1,000 random preprod
// wallets at 20 blocks, the UTxO sets this code reconstructs (each wallet's
// own outputs alive at T(B)) equal the reference query's (db-sync's
// UTxO-at-block pattern restricted to the wallet), compared as count and MD5
// of their canonical lines (transaction hash, index, lovelace, assets). The
// comparison with the extraction's life table runs wherever this role can
// read its study tables, and is recorded as not run otherwise.
//
// Selection, reproducible: stake credentials sampled from stake_address with
// TABLESAMPLE SYSTEM (2) REPEATABLE (2026), key credentials only, ordered by
// the MD5 of their id; the first 1,000 with at most 20,000 outputs (larger
// ones are skipped and counted). Blocks: 20 block ids evenly spaced from the
// first block with a transaction output carrying a stake credential to the
// snapshot block, both included.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { context, record, shapeWallets } from './env.mjs';
import { q } from '../../../src/history/db.mjs';
import { loadLife } from '../../../src/history/wallet.mjs';
import { reconstructionCheck } from '../../../src/history/history.mjs';
import { tOf } from '../../../src/history/windows.mjs';

const N = 1000;
const MAX_OUTPUTS = 20000;

test('reconstruction equals the reference query: seeded wallets and 1,000 random wallets at 20 blocks', { timeout: 6 * 3600 * 1000 }, async () => {
  const ctx = await context();
  const out = {};
  try {
    const shapes = await shapeWallets(ctx);
    const cand = (await ctx.client.query(
      `WITH s AS MATERIALIZED (SELECT id FROM public.stake_address TABLESAMPLE SYSTEM (2) REPEATABLE (2026) WHERE script_hash IS NULL)
       SELECT id FROM s ORDER BY md5(id::text)`)).rows.map((r) => Number(r.id));
    const random = [];
    let skipped = 0;
    for (const id of cand) {
      if (random.length >= N) break;
      const n = Number((await ctx.client.query('SELECT count(*) AS n FROM (SELECT 1 FROM public.tx_out WHERE stake_address_id = $1 LIMIT $2) x', [id, MAX_OUTPUTS + 1])).rows[0].n);
      if (n > MAX_OUTPUTS) skipped++;
      else random.push(id);
    }
    assert.equal(random.length, N, 'enough sampled credentials');
    const wallets = [...new Set([...Object.values(shapes), ...random])];
    const t0 = performance.now();
    const life = new Map();
    for (const sa of wallets) life.set(sa, await loadLife(ctx.client, ctx.blocks, sa, ctx.snapshot.tx));
    const loadSeconds = (performance.now() - t0) / 1000;
    const first = Number((await ctx.client.query('SELECT min(tx_id) AS t FROM public.tx_out WHERE stake_address_id IS NOT NULL')).rows[0].t);
    const firstBlock = Number((await ctx.client.query('SELECT block_id FROM public.tx WHERE id = $1', [first])).rows[0].block_id);
    const blocks = [];
    for (let k = 0; k < 20; k++) blocks.push(Math.round(firstBlock + (k * (ctx.snapshot.id - firstBlock)) / 19));
    const perBlock = [];
    let compared = 0;
    let agree = 0;
    let nonEmpty = 0;
    for (const b of blocks) {
      const t = await tOf(ctx, b);
      const s0 = performance.now();
      const res = [];
      for (let i = 0; i < wallets.length; i += 250) res.push(...(await reconstructionCheck(ctx, wallets.slice(i, i + 250), b, t, (sa) => life.get(sa))));
      const a = res.filter((r) => r.agree).length;
      perBlock.push({ block: b, wallets: res.length, agree: a, nonEmpty: res.filter((r) => r.n > 0).length, seconds: (performance.now() - s0) / 1000 });
      compared += res.length;
      agree += a;
      nonEmpty += res.filter((r) => r.n > 0).length;
      for (const r of res) assert.ok(r.agree, `wallet ${r.sa} at block ${b}: ${r.n} reconstructed, ${r.nRef} by the reference query`);
    }
    const study = (await q(ctx.client, ctx.blocks, 'study_readable'))[0];
    Object.assign(out, {
      seeded: Object.keys(shapes).length,
      random: random.length,
      skippedLarge: skipped,
      blocks: blocks.length,
      comparisons: compared,
      agree,
      nonEmptySets: nonEmpty,
      lifeLoadSeconds: loadSeconds,
      perBlock,
      lifeTable: study.usage && study.has_frame ? 'readable' : 'not run: the study tables are not readable by this role'
    });
    record('01-reconstruction', out);
    assert.equal(agree, compared);
  } finally {
    await ctx.client.end();
  }
});
