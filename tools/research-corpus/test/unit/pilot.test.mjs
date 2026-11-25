// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The pilot draw and the split by kind, on synthetic rows with every value
// worked by hand: the pilot starts after the sample's stopping point, skips a
// wallet in the other frame's sample (and leaves it out of D_k), takes the
// quotas scaled to its size with at least one per group, stops short at the
// guard or at the frame's last key, weighs its wallets by its own D_k and A_k,
// labels a wallet in both frames' pilots once, and is outside both samples;
// the draw's check fails when a pilot wallet is placed in a sample.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from '../lib/pglite.mjs';
import { defaultSettings, sqlParams, applyOverrides } from '../../src/params.mjs';
import { fill } from '../../src/sqlfile.mjs';

const H = 'a5'.repeat(16) + '5a'.repeat(16);
const WINDOWS = { recent: { lo: 101, hi: 200, t_start: 100, first_epoch: 2, last_epoch: 3 }, peak: { lo: 11, hi: 60, t_start: 10, first_epoch: 1, last_epoch: 1 } };

function params(over = {}) {
  const settings = applyOverrides(defaultSettings(), Object.entries(over).map(([k, v]) => `${k}=${v}`));
  return { settings, p: sqlParams({ network: 'preprod', settings, snapshot: { id: 1, t: 200 }, h: H, windows: WINDOWS }) };
}

// A frame's eligible keys in draw order: [wallet, UTxOs at the reference
// block, token-holding]. The draw key is the position as one byte, so the
// order is the list's. 250 UTxOs put a wallet in B1; every wallet has 5
// window transactions (n_tx_any) and no UTxO at the window's start.
async function load(db, order) {
  await db.exec(`
    CREATE TABLE study.frame (frame text, sa_id bigint, eligible boolean, tok boolean, ge5 boolean, frag boolean, n_utxo bigint, draw_key bytea, split_key bytea);
    CREATE TABLE study.txo (tx_out_id bigint PRIMARY KEY, created_tx bigint, consumed_tx bigint, sa_id bigint, out_index int, value numeric,
                            payment_cred bytea, script_pay boolean, has_datum boolean, has_ref_script boolean, via_payment boolean);
    CREATE TABLE study.activity (win text, sa_id bigint, n_tx_any bigint);
  `);
  for (const [frame, list] of Object.entries(order)) {
    for (const [i, [sa, nUtxo, tok = true]] of list.entries()) {
      const key = (i + 1).toString(16).padStart(2, '0');
      await db.query(`INSERT INTO study.frame VALUES ($1, $2, true, $3, true, false, $4, decode($5, 'hex'), decode($5, 'hex'))`, [frame, sa, tok, nUtxo, key]);
      await db.query(`INSERT INTO study.activity VALUES ($1, $2, 5)`, [frame, sa]);
    }
  }
}

async function drawAll(order, over) {
  const h = await freshDb();
  await load(h.db, order);
  const { p } = params(over);
  await h.runBlock('draw', p);
  await h.runBlock('split', p);
  await h.runBlock('sample_wallets', p);
  return { ...h, p };
}

const ids = async (h, frame, kind) => (await h.rows(`SELECT sa_id FROM study.sample WHERE frame = $1 AND kind = $2 ORDER BY draw_rank`, [frame, kind])).map((r) => Number(r.sa_id));
const summary = async (h, frame, kind) => {
  const r = (await h.rows(`SELECT k_full, k_stop, n_drawn, n_taken, guard_reached, sample_n FROM study.draw_summary WHERE frame = $1 AND kind = $2`, [frame, kind]))[0];
  return { k_full: r.k_full === null ? null : Number(r.k_full), k_stop: Number(r.k_stop), n_drawn: Number(r.n_drawn), n_taken: Number(r.n_taken), guard_reached: r.guard_reached, sample_n: Number(r.sample_n) };
};
const groups = async (h, frame, kind) => (await h.rows(`SELECT size_group, quota, n_drawn, n_taken, n_skipped FROM study.draw_group WHERE frame = $1 AND kind = $2 ORDER BY size_group`, [frame, kind]))
  .map((r) => [r.size_group, r.quota === null ? null : Number(r.quota), Number(r.n_drawn), Number(r.n_taken), Number(r.n_skipped)]);

// Settings: sample_n 2, pilot_n 3, quota_b1 1, quota_b2 1, quota_b3 1 (each
// sample quota 1; each pilot quota round(1 * 3 / 2) = round(1.5) = 2, halves up).
// B1 is 250 UTxOs, B0 none.
//
// Recent order, k: wallet (group):
//   1 w1 (B0)  sample          2 w2 (B1)  sample, the sample is full: k_stop 2
//   3 w3 (B1)  pilot, B1 rank 1, taken      4 w4 (B1)  pilot, rank 2, taken
//   5 w5 (B1)  in the peak sample: not a pilot candidate, not in D_k
//   6 w6 (B1)  pilot, rank 3 of a group with quota 2: skipped, counted
//   7 w7 (B0)  pilot, taken: 3 taken, the pilot is full at k = 7
//   8 w8 (B0)  after the stopping point, not drawn
// Peak order, k:
//   1 w5 (B0)  sample          2 w8 (B0)  sample, full: k_stop 2
//   3 w1 (B0)  in the recent sample: not a pilot candidate
//   4 w3 (B0)  pilot, taken    5 w9 (B0)  pilot, taken    6 w7 (B0)  pilot, taken: full at k = 6
const ORDER = {
  recent: [[1, 0], [2, 250], [3, 250], [4, 250], [5, 250], [6, 250], [7, 0], [8, 0]],
  peak: [[5, 0], [8, 0], [1, 0], [3, 0], [9, 0], [7, 0]]
};
const OVER = { sample_n: 2, pilot_n: 3, quota_b1: 1, quota_b2: 1, quota_b3: 1 };

test('the pilot starts after the sample\'s stopping point and a wallet in the other frame\'s sample is skipped and left out of D_k', async () => {
  const h = await drawAll(ORDER, OVER);
  assert.deepEqual(await ids(h, 'recent', 'random'), [1, 2]);
  assert.deepEqual(await ids(h, 'peak', 'random'), [5, 8]);
  assert.deepEqual(await ids(h, 'recent', 'pilot'), [3, 4, 7], 'w5 (peak sample) is skipped, w6 is a full group\'s, w8 is past the stop');
  assert.deepEqual(await ids(h, 'peak', 'pilot'), [3, 9, 7], 'w1 (recent sample) is skipped');
  assert.deepEqual(await summary(h, 'recent', 'random'), { k_full: 2, k_stop: 2, n_drawn: 2, n_taken: 2, guard_reached: false, sample_n: 2 });
  assert.deepEqual(await summary(h, 'recent', 'pilot'), { k_full: 7, k_stop: 7, n_drawn: 4, n_taken: 3, guard_reached: false, sample_n: 3 });
  assert.deepEqual(await summary(h, 'peak', 'pilot'), { k_full: 6, k_stop: 6, n_drawn: 3, n_taken: 3, guard_reached: false, sample_n: 3 });
  const ranks = await h.rows(`SELECT frame, min(draw_rank) AS r FROM study.sample WHERE kind = 'pilot' GROUP BY frame ORDER BY frame`);
  assert.deepEqual(ranks.map((r) => [r.frame, Number(r.r)]), [['peak', 4], ['recent', 3]]);
});

test('the pilot\'s D_k and A_k are its own: candidates from the sample\'s stopping point to the pilot\'s, and those taken', async () => {
  const h = await drawAll(ORDER, OVER);
  // Recent pilot: B1 candidates w3, w4, w6 (w5 left out): D 3, A 2, skipped 1,
  // weight 3 / 2; B0 candidate w7: D 1, A 1. The sample's own counts are apart:
  // B0 w1 and B1 w2, each D 1, A 1, quota 1 for B1.
  assert.deepEqual(await groups(h, 'recent', 'pilot'), [['B0', null, 1, 1, 0], ['B1', 2, 3, 2, 1], ['B2', 2, 0, 0, 0], ['B3', 2, 0, 0, 0]]);
  assert.deepEqual(await groups(h, 'recent', 'random'), [['B0', null, 1, 1, 0], ['B1', 1, 1, 1, 0], ['B2', 1, 0, 0, 0], ['B3', 1, 0, 0, 0]]);
  // Peak pilot: B0 candidates w3, w9, w7 (w1 left out): D 3, A 3.
  assert.deepEqual(await groups(h, 'peak', 'pilot'), [['B0', null, 3, 3, 0], ['B1', 2, 0, 0, 0], ['B2', 2, 0, 0, 0], ['B3', 2, 0, 0, 0]]);
  assert.deepEqual(await groups(h, 'peak', 'random'), [['B0', null, 2, 2, 0], ['B1', 1, 0, 0, 0], ['B2', 1, 0, 0, 0], ['B3', 1, 0, 0, 0]]);
});

test('every pilot row is exploration and every sample row confirmation; a wallet in both frames\' pilots has one label', async () => {
  const h = await drawAll(ORDER, OVER);
  const rows = await h.rows(`SELECT kind, split, count(*) AS n FROM study.sample GROUP BY kind, split ORDER BY kind, split`);
  assert.deepEqual(rows.map((r) => [r.kind, r.split, Number(r.n)]), [['pilot', 'exploration', 6], ['random', 'confirmation', 4]]);
  // w3 and w7 are in both pilots: two rows each, one label, one wallet.
  const both = await h.rows(`SELECT sa_id, count(*) AS n, count(DISTINCT split) AS labels FROM study.sample GROUP BY sa_id HAVING count(*) > 1 ORDER BY sa_id`);
  assert.deepEqual(both.map((r) => [Number(r.sa_id), Number(r.n), Number(r.labels)]), [[3, 2, 1], [7, 2, 1]]);
  // Distinct wallets: w1, w2, w5, w8 (samples) and w3, w4, w7, w9 (pilots).
  const wallets = await h.rows(`SELECT sa_id FROM study.sample_wallet ORDER BY sa_id`);
  assert.deepEqual(wallets.map((r) => Number(r.sa_id)), [1, 2, 3, 4, 5, 7, 8, 9]);
  const counts = await h.rows(blocksQuery(h, 'split_overall'));
  assert.deepEqual(counts.map((r) => [r.kind, Number(r.n_credentials), Number(r.n_exploration), Number(r.n_confirmation)]), [['pilot', 4, 4, 0], ['random', 4, 0, 4]]);
  const bounds = await h.rows(blocksQuery(h, 'sample_bounds'));
  assert.deepEqual(bounds.map((r) => [r.frame, r.kind, Number(r.n)]), [['recent', 'pilot', 3], ['recent', 'random', 2], ['peak', 'pilot', 3], ['peak', 'random', 2]]);
});

const blocksQuery = (h, name) => fill(h.blocks.get(name).statements[0], h.p);

test('draw_check holds on a valid run and fails when a pilot wallet is placed in a sample', async () => {
  const h = await drawAll(ORDER, OVER);
  const check = async () => (await h.db.query(blocksQuery(h, 'draw_check'))).rows[0];
  const valid = await check();
  assert.equal(Object.keys(valid).length, 16);
  assert.ok(Object.values(valid).every((v) => v === true), JSON.stringify(valid));
  // w9 is a peak pilot wallet: put it in the recent sample as well.
  await h.db.exec(`INSERT INTO study.sample (frame, kind, sa_id, draw_rank, size_group, n_utxo_start, n_utxo_ref, n_window_tx, capped, history_hi)
                   VALUES ('recent', 'random', 9, 1, 'B0', 0, 0, 5, false, 200)`);
  const after = await check();
  assert.equal(after.pilot_outside_samples, false);
  assert.equal(after.groups_add_up, false, 'the recent sample now holds a wallet its draw did not take');
});

test('a pilot short at the guard is recorded as it is', async () => {
  // guard 4: keys 1 and 2 fill the sample (sample_n 2); keys 3 and 4 are pilot
  // candidates, both taken; the guard stops the draw at k = 4, short of 3.
  const order = { recent: [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0]], peak: [] };
  const h = await drawAll(order, { ...OVER, guard: 4 });
  assert.deepEqual(await ids(h, 'recent', 'pilot'), [3, 4]);
  assert.deepEqual(await summary(h, 'recent', 'pilot'), { k_full: null, k_stop: 4, n_drawn: 2, n_taken: 2, guard_reached: true, sample_n: 3 });
  assert.equal((await h.rows(blocksQuery(h, 'draw_check')))[0].sample_size_holds, true);
});

test('a pilot short at the frame\'s last key is recorded as it is, and no pilot candidate lies past a guard that the last key of the sample reaches', async () => {
  // Four eligible keys: 1 and 2 the sample, 3 the pilot's one candidate, 4 holds
  // no token and is passed over; the frame ends at k = 4.
  let h = await drawAll({ recent: [[1, 0], [2, 0], [3, 0], [4, 0, false]], peak: [] }, OVER);
  assert.deepEqual(await ids(h, 'recent', 'pilot'), [3]);
  assert.deepEqual(await summary(h, 'recent', 'pilot'), { k_full: null, k_stop: 4, n_drawn: 1, n_taken: 1, guard_reached: false, sample_n: 3 });
  // The guard (3) ends the draw at the key that fills the sample: no candidate
  // lies after the sample's stopping point within the guard.
  h = await drawAll({ recent: [[1, 0], [2, 0, false], [3, 0], [4, 0]], peak: [] }, { ...OVER, guard: 3 });
  assert.deepEqual(await ids(h, 'recent', 'random'), [1, 3]);
  assert.deepEqual(await ids(h, 'recent', 'pilot'), []);
  assert.deepEqual(await summary(h, 'recent', 'pilot'), { k_full: null, k_stop: 3, n_drawn: 0, n_taken: 0, guard_reached: true, sample_n: 3 });
});

test('the default quotas give B1 10, B2 1 and B3 1 in the pilot, at least one binding for B3, and the rounding is halves up', async () => {
  // At the defaults (sample_n 1000, pilot_n 100, quotas 100, 10 and 2 at s = 1):
  // B1 100 * 100 / 1000 = 10; B2 10 * 100 / 1000 = 1; B3 2 * 100 / 1000 = 0.2,
  // which rounds to 0 and is raised to 1.
  let h = await drawAll({ recent: [[1, 0]], peak: [] }, {});
  assert.deepEqual((await groups(h, 'recent', 'pilot')).map((g) => g[1]), [null, 10, 1, 1]);
  assert.deepEqual((await groups(h, 'recent', 'random')).map((g) => g[1]), [null, 100, 10, 2]);
  // 15 * 0.1 = 1.5 rounds to 2; 25 * 0.1 = 2.5 to 3; 4 * 0.1 = 0.4 to 0, raised to 1.
  h = await drawAll({ recent: [[1, 0]], peak: [] }, { quota_b1: 15, quota_b2: 25, quota_b3: 4 });
  assert.deepEqual((await groups(h, 'recent', 'pilot')).map((g) => g[1]), [null, 2, 3, 1]);
  // At s = 2.5: 4 * 2.5 * 0.1 = 1.0.
  h = await drawAll({ recent: [[1, 0]], peak: [] }, { quota_b1: 4, quota_scale: '2.5' });
  assert.equal((await groups(h, 'recent', 'pilot'))[1][1], 1);
});

test('split_den is refused as a removed setting with its reason', () => {
  assert.throws(() => applyOverrides(defaultSettings(), ['split_den=5']), /split_den is not a setting: the split no longer takes a share of each sample/);
  assert.throws(() => applyOverrides(defaultSettings(), ['no_such=1']), /unknown setting no_such/);
  assert.equal(defaultSettings().pilot_n, 100);
  assert.equal('split_den' in defaultSettings(), false);
});
