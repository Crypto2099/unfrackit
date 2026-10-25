// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The profile features the activity and profile steps compute, on a fixture
// small enough to count by hand: f5, the receipts that consume none of the
// wallet's outputs (not the change of the wallet's own spend, not a DEX fill
// that consumes its order at a script address, a receipt of two outputs
// counted once, a held output counted), and f8, the UTxOs held at the
// window's end, held UTxOs included; and the profile check that compares them
// with the frame.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from '../lib/pglite.mjs';
import { defaultSettings, sqlParams } from '../../src/params.mjs';
import { fill } from '../../src/sqlfile.mjs';

const params = () =>
  sqlParams({
    network: 'preprod',
    settings: defaultSettings(),
    snapshot: { id: 1, t: 100 },
    h: '00'.repeat(32),
    windows: { recent: { lo: 10, hi: 100, t_start: 9, first_epoch: 1, last_epoch: 1 }, peak: { lo: 1, hi: 22, t_start: 0, first_epoch: 1, last_epoch: 1 } }
  });

test('f5 counts receipts that consume none of the wallet\'s outputs, f8 the UTxOs at the window\'s end', async () => {
  const { db, blocks, runBlock, rows } = await freshDb();
  const profileCheck = async () => (await db.query(fill(blocks.get('profile_check').statements[0], params()))).rows[0];
  await db.exec(`
    CREATE TABLE study.txo (tx_out_id bigint PRIMARY KEY, created_tx bigint, consumed_tx bigint, sa_id bigint, out_index int, value numeric,
                            payment_cred bytea, script_pay boolean, has_datum boolean, has_ref_script boolean, via_payment boolean);
    CREATE TABLE study.txo_asset (tx_out_id bigint, ident bigint, quantity numeric);
    CREATE TABLE study.asset (ident bigint PRIMARY KEY, policy bytea, name bytea, label integer);
    CREATE TABLE study.script_tx (tx_id bigint PRIMARY KEY);
    CREATE TABLE public.tx (id bigint PRIMARY KEY, valid_contract boolean);
    CREATE TABLE public.tx_out (id bigint PRIMARY KEY, tx_id bigint, address_has_script boolean);
    CREATE TABLE study.sample_frame (frame text, sa_id bigint, in_sample boolean, lo bigint, hi bigint, t_start bigint, t_end bigint);
    CREATE TABLE study.frame (frame text, sa_id bigint, n_spends bigint, n_utxo bigint);
  `);
  // Wallet 1's outputs: (id, created, consumed, script payment credential, datum).
  //   o1 a receipt before the recent window, spent at 25
  //   o2 at 20, a receipt that consumes nothing of the wallet
  //   o3 at 25, an order the wallet placed at a script address, consuming o1
  //   o4 at 30, change of the wallet's spend of o2
  //   o5 at 40, a DEX fill that consumes the order o3
  //   o6, o7 at 50, one receipt of two outputs
  //   o8 at 60, a receipt at a held output (a datum)
  const outs = [
    [1, 5, 25, false, false],
    [2, 20, 30, false, false],
    [3, 25, 40, true, false],
    [4, 30, null, false, false],
    [5, 40, null, false, false],
    [6, 50, null, false, false],
    [7, 50, null, false, false],
    [8, 60, null, false, true]
  ];
  for (const [id, created, consumed, script, datum] of outs) {
    await db.query(`INSERT INTO study.txo VALUES ($1, $2, $3, 1, 0, 1000000, NULL, $4, $5, false, false)`, [id, created, consumed, script, datum]);
  }
  for (const t of [5, 20, 25, 30, 40, 50, 60]) await db.query(`INSERT INTO public.tx VALUES ($1, true)`, [t]);
  await runBlock('activity', params());
  const act = Object.fromEntries((await rows(`SELECT win, n_receipts, n_receipts_no_input, n_spends_key FROM study.activity WHERE sa_id = 1`)).map((r) => [r.win, [Number(r.n_receipts), Number(r.n_receipts_no_input), Number(r.n_spends_key)]]));
  assert.deepEqual(act, { recent: [6, 3, 2], peak: [2, 2, 0] });

  await db.exec(`
    INSERT INTO study.sample_frame VALUES ('recent', 1, true, 10, 100, 9, 100), ('peak', 1, true, 1, 22, 0, 22), ('recent', 2, false, 10, 100, 9, 100);
    INSERT INTO study.frame VALUES ('recent', 1, 2, 5), ('peak', 1, 0, 2);
  `);
  await runBlock('profile', params());
  const prof = Object.fromEntries((await rows(`SELECT frame, sa_id, n_spends, n_receipts_no_input, n_utxo_end FROM study.profile ORDER BY frame, sa_id`)).map((r) => [`${r.frame} ${r.sa_id}`, [Number(r.n_spends), Number(r.n_receipts_no_input), Number(r.n_utxo_end)]]));
  // Wallet 2, a case wallet with no outputs, has every feature at zero.
  assert.deepEqual(prof, { 'peak 1': [0, 2, 2], 'recent 1': [2, 3, 5], 'recent 2': [0, 0, 0] });
  const check = await profileCheck();
  assert.deepEqual([check.spend_count_mismatch, check.receipt_count_mismatch, check.utxo_count_mismatch].map(Number), [0, 0, 0]);
  // A frame whose UTxO count differs is caught.
  await db.exec(`UPDATE study.frame SET n_utxo = 4 WHERE frame = 'recent'`);
  assert.equal(Number((await profileCheck()).utxo_count_mismatch), 1);
});
