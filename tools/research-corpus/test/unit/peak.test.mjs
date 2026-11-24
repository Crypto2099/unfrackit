// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The peak window's search begins at the Mary hard fork, read from
// protocol_major (4 or more), never from an epoch number: busier runs that
// start before Mary are not eligible, and a run may start in a Mary epoch
// before Alonzo (decided 2026-10-21).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from '../lib/pglite.mjs';
import { defaultSettings, sqlParams } from '../../src/params.mjs';

test('peak runs start at the first epoch with protocol_major >= 4', async () => {
  const { db, runBlock, rows } = await freshDb();
  await db.exec(`
    CREATE TABLE public.block (id bigint PRIMARY KEY, epoch_no int);
    CREATE TABLE public.tx (id bigserial PRIMARY KEY, block_id bigint, valid_contract boolean);
    CREATE TABLE public.epoch (no int PRIMARY KEY, tx_count bigint);
    CREATE TABLE public.epoch_param (epoch_no int PRIMARY KEY, protocol_major int);
  `);
  // Epochs 0 to 12, one block each; protocol 2 and 3 before Mary (epoch 4),
  // Alonzo from epoch 6. Epochs 2 and 3 are the busiest of all.
  const major = { 2: 2, 3: 3, 4: 4, 5: 4, 6: 5, 7: 5, 8: 6, 9: 7, 10: 7, 11: 8, 12: 9 };
  const ntx = { 0: 1, 1: 1, 2: 90, 3: 90, 4: 40, 5: 40, 6: 40, 7: 10, 8: 10, 9: 10, 10: 10, 11: 10, 12: 10 };
  for (let e = 0; e <= 12; e++) {
    await db.query('INSERT INTO public.block VALUES ($1, $2)', [e, e]);
    for (let i = 0; i < ntx[e]; i++) await db.query('INSERT INTO public.tx (block_id, valid_contract) VALUES ($1, true)', [e]);
    await db.query('INSERT INTO public.epoch VALUES ($1, $2)', [e, ntx[e]]);
    if (major[e]) await db.query('INSERT INTO public.epoch_param VALUES ($1, $2)', [e, major[e]]);
  }
  const settings = { ...defaultSettings(), peak_epochs: 3 };
  const p = sqlParams({ network: 'preprod', settings, snapshot: { id: 12, t: 1 } });
  await runBlock('epoch_counts', p);
  await runBlock('peak_runs', p);
  const best = (await rows('SELECT first_epoch, last_epoch, n_tx_rule FROM study.peak_runs WHERE rank = 1'))[0];
  assert.deepEqual([best.first_epoch, best.last_epoch, Number(best.n_tx_rule)], [4, 6, 120]);
  const firsts = (await rows('SELECT min(first_epoch) AS e FROM study.peak_runs'))[0];
  assert.equal(firsts.e, 4, 'the search begins at the Mary epoch');
});
