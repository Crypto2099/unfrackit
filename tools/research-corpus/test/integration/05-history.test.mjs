// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// T5. History: every transaction that created or consumed an output of each
// shape. Expected from the seeder: S1 one receipt; S3 a receipt of 95, a spend
// of all 95 that burns 90 assets (ma_tx_mint quantity -1 for each) and pays the
// funder, a receipt of 95; M2 25 receipts summing to 3,005 outputs. Seeding
// transactions spend only funder UTxOs; neither kind carries metadata.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, record, RUN_B, SHAPES, FUNDER, seederAddress, stakeOf, saIdOf } from './env.mjs';
import { history } from '../lib/history.mjs';

test('T5 every transaction that touched each shape is a seeder transaction', async () => {
  const c = await db();
  try {
    const funder = await saIdOf(c, stakeOf(FUNDER));
    const out = {};
    for (const shape of SHAPES) {
      const sa = await saIdOf(c, stakeOf(seederAddress(shape)[0]));
      const h = await history(c, sa);
      out[shape] = h;
      for (const t of h) assert.equal(t.n_metadata, 0, `${shape} ${t.hash}: no metadata`);
      const receipts = h.filter((t) => t.n_created > 0 && t.n_consumed === 0);
      const spends = h.filter((t) => t.n_consumed > 0);
      for (const t of receipts) assert.deepEqual(t.input_creds, [funder], `${shape} ${t.hash}: a seeding transaction spends only funder UTxOs`);
      if (shape === 'S1') {
        assert.equal(h.length, 1);
        assert.equal(receipts[0].n_created, 3);
      } else if (shape === 'S3') {
        assert.equal(h.length, 3);
        assert.equal(receipts.length, 2);
        assert.equal(spends.length, 1);
        const [first, sweep, second] = h;
        assert.equal(first.n_created, 95);
        assert.equal(second.n_created, 95);
        assert.equal(sweep.n_consumed, 95, 'the sweep spends all 95');
        assert.equal(sweep.n_created, 0);
        assert.equal(sweep.n_burn_one, 90, 'the sweep burns the 90 NFTs, one each');
        assert.equal(sweep.n_mint_rows, 90);
        assert.deepEqual(sweep.input_creds, [sa], 'the sweep spends only the shape UTxOs');
        assert.deepEqual(sweep.output_creds, [funder], 'the sweep pays the funder');
        assert.ok(first.tx < sweep.tx && sweep.tx < second.tx);
      } else if (shape === 'M2') {
        assert.equal(h.length, 25);
        assert.equal(spends.length, 0);
        assert.equal(h.reduce((s, t) => s + t.n_created, 0), 3005);
      }
    }
    record('T5', { run: RUN_B, funder_sa_id: funder, history: out });
  } finally {
    await c.end();
  }
});
