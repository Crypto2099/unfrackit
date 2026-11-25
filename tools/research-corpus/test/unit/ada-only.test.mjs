// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The ADA-only sample and the ADA-only pilot, on synthetic rows with every
// value worked by hand, against the rule stated here: a key of the recent
// frame is an ADA-only candidate when it holds no native asset at the
// snapshot, has at least 5 spends in the window and lies within the guard.
// The ADA-only sample is the ADA-only candidates at or before the sample's
// stopping point, in draw order, until ada_only_n are taken, with no quota;
// its stop is the key of its last wallet when full, else the sample's stop.
// The ADA-only pilot is the ADA-only candidates after the ADA-only sample's
// stop and at or before the recent pilot's, in draw order, leaving out every
// wallet in either frame's sample or in the ADA-only sample, until
// ada_only_pilot_n are taken; its stop is its last wallet's key when full,
// else the recent pilot's stop. Nothing of either kind is drawn in the peak
// frame. The token-holding pilot leaves out the ADA-only sample's wallets.
// ADA-only sample rows are confirmation and ADA-only pilot rows exploration.
// Each kind's draw_group rows have no quota and n_drawn = n_taken, and each
// of the draw check's ADA-only keys is true on a valid draw and false on one
// built to break it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from '../lib/pglite.mjs';
import { defaultSettings, sqlParams, applyOverrides } from '../../src/params.mjs';
import { fill } from '../../src/sqlfile.mjs';

const H = 'a5'.repeat(16) + '5a'.repeat(16);
const WINDOWS = { recent: { lo: 101, hi: 200, t_start: 100, first_epoch: 2, last_epoch: 3 }, peak: { lo: 11, hi: 60, t_start: 10, first_epoch: 1, last_epoch: 1 } };

function params(over = {}) {
  const settings = applyOverrides(defaultSettings(), Object.entries(over).map(([k, v]) => `${k}=${v}`));
  return sqlParams({ network: 'preprod', settings, snapshot: { id: 1, t: 200 }, h: H, windows: WINDOWS });
}

// A frame's eligible keys in draw order: [wallet, UTxOs at the reference
// block, token-holding, at least 5 spends]. The draw key is the position as
// one byte, so the order is the list's. 250 UTxOs put a wallet in B1. Every
// wallet has nTx[wallet] window transactions (n_tx_any), 1 unless given, and
// the life table holds the rows in txo: [wallet, created, consumed].
const T = true;
const F = false;
async function load(db, order, { nTx = {}, txo = [] } = {}) {
  await db.exec(`
    CREATE TABLE study.frame (frame text, sa_id bigint, eligible boolean, tok boolean, ge5 boolean, frag boolean, n_utxo bigint, draw_key bytea, split_key bytea);
    CREATE TABLE study.txo (tx_out_id bigint PRIMARY KEY, created_tx bigint, consumed_tx bigint, sa_id bigint, out_index int, value numeric,
                            payment_cred bytea, script_pay boolean, has_datum boolean, has_ref_script boolean, via_payment boolean);
    CREATE TABLE study.activity (win text, sa_id bigint, n_tx_any bigint);
  `);
  for (const [frame, list] of Object.entries(order)) {
    for (const [i, [sa, nUtxo, tok, ge5]] of list.entries()) {
      const key = (i + 1).toString(16).padStart(2, '0');
      await db.query(`INSERT INTO study.frame VALUES ($1, $2, true, $3, $4, false, $5, decode($6, 'hex'), decode($6, 'hex'))`, [frame, sa, tok, ge5, nUtxo, key]);
      await db.query(`INSERT INTO study.activity VALUES ($1, $2, $3)`, [frame, sa, nTx[sa] ?? 1]);
    }
  }
  for (const [i, [sa, created, consumed]] of txo.entries()) {
    await db.query(`INSERT INTO study.txo VALUES ($1, $2, $3, $4, 0, 1000000, NULL, false, false, false, false)`, [i + 1, created, consumed, sa]);
  }
}

async function drawAll(order, over, extra) {
  const h = await freshDb();
  await load(h.db, order, extra);
  const p = params(over);
  await h.runBlock('draw', p);
  await h.runBlock('split', p);
  await h.runBlock('sample_wallets', p);
  return { ...h, p };
}

const query = (h, name) => fill(h.blocks.get(name).statements[0], h.p);
const ids = async (h, frame, kind) => (await h.rows(`SELECT sa_id FROM study.sample WHERE frame = $1 AND kind = $2 ORDER BY draw_rank`, [frame, kind])).map((r) => Number(r.sa_id));
const ranks = async (h, frame, kind) => (await h.rows(`SELECT draw_rank FROM study.sample WHERE frame = $1 AND kind = $2 ORDER BY draw_rank`, [frame, kind])).map((r) => Number(r.draw_rank));
const summary = async (h, frame, kind) => {
  const r = (await h.rows(`SELECT k_full, k_stop, n_drawn, n_taken, guard_reached, sample_n FROM study.draw_summary WHERE frame = $1 AND kind = $2`, [frame, kind]))[0];
  return { k_full: r.k_full === null ? null : Number(r.k_full), k_stop: Number(r.k_stop), n_drawn: Number(r.n_drawn), n_taken: Number(r.n_taken), guard_reached: r.guard_reached, sample_n: Number(r.sample_n) };
};
const groups = async (h, frame, kind) => (await h.rows(`SELECT size_group, quota, n_drawn, n_taken, n_skipped FROM study.draw_group WHERE frame = $1 AND kind = $2 ORDER BY size_group`, [frame, kind]))
  .map((r) => [r.size_group, r.quota === null ? null : Number(r.quota), Number(r.n_drawn), Number(r.n_taken), Number(r.n_skipped)]);
const check = async (h) => (await h.db.query(query(h, 'draw_check'))).rows[0];
const ADA_KEYS = ['ada_only_size_holds', 'ada_only_members_qualify', 'ada_only_none_passed_over', 'ada_only_caps_hold',
  'ada_only_pilot_size_holds', 'ada_only_pilot_members_qualify', 'ada_only_pilot_none_passed_over', 'ada_only_pilot_caps_hold',
  'ada_only_pilot_outside_samples', 'ada_only_outside_pilots'];

// Settings: sample_n 3, pilot_n 2, ada_only_n 2, ada_only_pilot_n 2, every
// sample quota 1 (so a quota would take one B1 wallet; the ADA-only sample has
// none). Every token-holding wallet is B0.
//
// Recent order, k: wallet (UTxOs, token-holding, 5 spends):
//    1 w1  (0, T, T)    sample
//    2 w21 (250, F, T)  ADA-only sample, B1
//    3 w22 (0, F, F)    4 spends: no ADA-only candidate, in no kind
//    4 w2  (0, T, T)    sample
//    5 w23 (250, F, T)  ADA-only sample, B1, a second B1 taken: the ADA-only
//                       sample is full at its 2nd wallet, k_full = k_stop = 5
//    6 w24 (0, F, T)    before the sample's stop but after the ADA-only stop:
//                       not in the ADA-only sample; the ADA-only pilot's first
//    7 w3  (0, T, T)    sample, full: k_stop 7
//    8 w28 (0, F, T)    in the peak sample: the ADA-only pilot leaves it out,
//                       and it is not in that pilot's D_k
//    9 w4  (0, T, T)    pilot
//   10 w25 (0, F, T)    ADA-only pilot, full at its 2nd wallet: k_stop 10
//   11 w5  (0, T, T)    pilot, full: k_stop 11
//   12 w26 (0, F, T)    after every stop
// Peak order, k:
//    1 w23 (T)  sample (w23 is also in the ADA-only sample: two
//               confirmation rows)
//    2 w31 (F)  holds no token, 5 spends: the peak frame has no ADA-only kind
//    3 w28 (T)  sample
//    4 w33 (T)  sample, full: k_stop 4
//    5 w21 (T)  in the ADA-only sample: not a pilot candidate, not in D_k
//    6 w34 (T)  pilot
//    7 w24 (T)  pilot, full: k_stop 7 (w24 is also in the ADA-only pilot: two
//               exploration rows)
//    8 w35 (T)  after the stop
const ORDER = {
  recent: [[1, 0, T, T], [21, 250, F, T], [22, 0, F, F], [2, 0, T, T], [23, 250, F, T], [24, 0, F, T], [3, 0, T, T], [28, 0, F, T], [4, 0, T, T], [25, 0, F, T], [5, 0, T, T], [26, 0, F, T]],
  peak: [[23, 0, T, T], [31, 0, F, T], [28, 0, T, T], [33, 0, T, T], [21, 0, T, T], [34, 0, T, T], [24, 0, T, T], [35, 0, T, T]]
};
const OVER = { sample_n: 3, pilot_n: 2, ada_only_n: 2, ada_only_pilot_n: 2, quota_b1: 1, quota_b2: 1, quota_b3: 1 };

test('the ADA-only sample takes ADA-only candidates only, in draw order, with no quota, and stops at its size at that key', async () => {
  const h = await drawAll(ORDER, OVER);
  assert.deepEqual(await ids(h, 'recent', 'random'), [1, 2, 3]);
  assert.deepEqual(await summary(h, 'recent', 'random'), { k_full: 7, k_stop: 7, n_drawn: 3, n_taken: 3, guard_reached: false, sample_n: 3 });
  assert.deepEqual(await ids(h, 'recent', 'ada_only'), [21, 23], 'w22 has 4 spends; w24 comes after the 2nd ADA-only wallet');
  assert.deepEqual(await ranks(h, 'recent', 'ada_only'), [2, 5]);
  const sg = await h.rows(`SELECT size_group FROM study.sample WHERE kind = 'ada_only' ORDER BY draw_rank`);
  assert.deepEqual(sg.map((r) => r.size_group), ['B1', 'B1'], 'both B1 wallets taken where the sample\'s B1 quota is 1');
  assert.deepEqual(await summary(h, 'recent', 'ada_only'), { k_full: 5, k_stop: 5, n_drawn: 2, n_taken: 2, guard_reached: false, sample_n: 2 });
  assert.deepEqual(await groups(h, 'recent', 'ada_only'), [['B0', null, 0, 0, 0], ['B1', null, 2, 2, 0], ['B2', null, 0, 0, 0], ['B3', null, 0, 0, 0]]);
});

test('the ADA-only pilot starts after the ADA-only sample\'s stop, skips a wallet in the peak sample and stops at its size', async () => {
  const h = await drawAll(ORDER, OVER);
  assert.deepEqual(await ids(h, 'recent', 'pilot'), [4, 5]);
  assert.deepEqual(await summary(h, 'recent', 'pilot'), { k_full: 11, k_stop: 11, n_drawn: 2, n_taken: 2, guard_reached: false, sample_n: 2 });
  assert.deepEqual(await ids(h, 'recent', 'ada_only_pilot'), [24, 25], 'w28 is in the peak sample; w26 is past the stop');
  assert.deepEqual(await ranks(h, 'recent', 'ada_only_pilot'), [6, 10]);
  // D_k leaves w28 out: two candidates drawn, both taken.
  assert.deepEqual(await summary(h, 'recent', 'ada_only_pilot'), { k_full: 10, k_stop: 10, n_drawn: 2, n_taken: 2, guard_reached: false, sample_n: 2 });
  assert.deepEqual(await groups(h, 'recent', 'ada_only_pilot'), [['B0', null, 2, 2, 0], ['B1', null, 0, 0, 0], ['B2', null, 0, 0, 0], ['B3', null, 0, 0, 0]]);
  const w28 = (await h.rows(`SELECT ada_only_candidate, ada_only_pilot_candidate FROM study.draw_order WHERE frame = 'recent' AND sa_id = 28`))[0];
  assert.deepEqual(w28, { ada_only_candidate: true, ada_only_pilot_candidate: false });
});

test('a wallet of the ADA-only sample is not a pilot candidate in the peak frame, and the peak frame has no ADA-only kind', async () => {
  const h = await drawAll(ORDER, OVER);
  assert.deepEqual(await ids(h, 'peak', 'random'), [23, 28, 33]);
  assert.deepEqual(await ids(h, 'peak', 'pilot'), [34, 24], 'w21 (the ADA-only sample) is skipped');
  assert.deepEqual(await summary(h, 'peak', 'pilot'), { k_full: 7, k_stop: 7, n_drawn: 2, n_taken: 2, guard_reached: false, sample_n: 2 });
  const w21 = (await h.rows(`SELECT pilot_candidate FROM study.draw_order WHERE frame = 'peak' AND sa_id = 21`))[0];
  assert.equal(w21.pilot_candidate, false);
  // w31 holds no token in the peak frame and has 5 spends: no kind takes it.
  assert.equal(Number((await h.rows(`SELECT count(*) AS n FROM study.sample WHERE sa_id = 31`))[0].n), 0);
  for (const t of ['sample', 'draw_group', 'draw_summary']) {
    assert.equal(Number((await h.rows(`SELECT count(*) AS n FROM study.${t} WHERE frame = 'peak' AND kind IN ('ada_only', 'ada_only_pilot')`))[0].n), 0, t);
  }
  const w31 = (await h.rows(`SELECT ada_only_candidate FROM study.draw_order WHERE frame = 'peak' AND sa_id = 31`))[0];
  assert.equal(w31.ada_only_candidate, false);
});

test('labels by kind: the ADA-only sample is confirmation, the ADA-only pilot exploration, one label per wallet', async () => {
  const h = await drawAll(ORDER, OVER);
  const rows = await h.rows(`SELECT kind, split, count(*) AS n FROM study.sample GROUP BY kind, split ORDER BY kind, split`);
  assert.deepEqual(rows.map((r) => [r.kind, r.split, Number(r.n)]), [
    ['ada_only', 'confirmation', 2], ['ada_only_pilot', 'exploration', 2], ['pilot', 'exploration', 4], ['random', 'confirmation', 6]
  ]);
  // w23: the ADA-only sample and the peak sample; w24: the ADA-only pilot and
  // the peak pilot. Two rows each, one label each.
  const both = await h.rows(`SELECT sa_id, array_agg(kind ORDER BY kind) AS kinds, count(DISTINCT split) AS labels, min(split) AS split FROM study.sample GROUP BY sa_id HAVING count(*) > 1 ORDER BY sa_id`);
  assert.deepEqual(both.map((r) => [Number(r.sa_id), r.kinds, Number(r.labels), r.split]), [[23, ['ada_only', 'random'], 1, 'confirmation'], [24, ['ada_only_pilot', 'pilot'], 1, 'exploration']]);
  const overall = await h.rows(query(h, 'split_overall'));
  assert.deepEqual(overall.map((r) => [r.kind, Number(r.n_credentials), Number(r.n_exploration), Number(r.n_confirmation)]), [
    ['ada_only', 2, 0, 2], ['ada_only_pilot', 2, 2, 0], ['pilot', 4, 4, 0], ['random', 6, 0, 6]
  ]);
  const bounds = await h.rows(query(h, 'sample_bounds'));
  assert.deepEqual(bounds.map((r) => [r.frame, r.kind, Number(r.n), r.bound]), [
    ['recent', 'ada_only', 2, '05'], ['recent', 'ada_only_pilot', 2, '0a'], ['recent', 'pilot', 2, '0b'], ['recent', 'random', 3, '07'],
    ['peak', 'pilot', 2, '07'], ['peak', 'random', 3, '04']
  ]);
  // Distinct wallets: the samples' w1, w2, w3, w23, w28, w33 and w21; the
  // pilots' w4, w5, w34, w24 and w25.
  const wallets = await h.rows(`SELECT sa_id FROM study.sample_wallet ORDER BY sa_id`);
  assert.deepEqual(wallets.map((r) => Number(r.sa_id)), [1, 2, 3, 4, 5, 21, 23, 24, 25, 28, 33, 34]);
});

test('the ADA-only sample and pilot carry the sample\'s per-wallet fields, computed the same way', async () => {
  // history_cap 2. w21 has 4 window transactions and its life table holds a
  // UTxO created at 50 and never spent, one created at 60 and spent at 103
  // (both held at the window's start, 100), and outputs created at 102, 104
  // and 106: U = max(2 at the start, 250 at the snapshot) puts it in B1, T = 4
  // caps it, and its history ends at its 2nd window transaction, 103 (102,
  // 103, 104, 106 in order). Every other wallet has 1 window transaction and
  // no UTxO at the window's start, so its history ends at the window's end.
  const txo = [[21, 50, null], [21, 60, 103], [21, 102, null], [21, 104, null], [21, 106, null]];
  const h = await drawAll(ORDER, { ...OVER, history_cap: 2 }, { nTx: { 21: 4 }, txo });
  const got = await h.rows(`SELECT frame, kind, sa_id, draw_rank, size_group, n_utxo_start, n_utxo_ref, n_window_tx, capped, history_hi, split, fragmented,
                                   franken_any, franken_no_cospend, unfrackit_user, evolution_tidied, prior_treated
                              FROM study.sample WHERE kind IN ('ada_only', 'ada_only_pilot') ORDER BY kind, draw_rank`);
  assert.deepEqual(got.map((r) => [r.kind, Number(r.sa_id), Number(r.draw_rank), r.size_group, Number(r.n_utxo_start), Number(r.n_utxo_ref), Number(r.n_window_tx), r.capped, Number(r.history_hi), r.split, r.fragmented]), [
    ['ada_only', 21, 2, 'B1', 2, 250, 4, true, 103, 'confirmation', false],
    ['ada_only', 23, 5, 'B1', 0, 250, 1, false, 200, 'confirmation', false],
    ['ada_only_pilot', 24, 6, 'B0', 0, 0, 1, false, 200, 'exploration', false],
    ['ada_only_pilot', 25, 10, 'B0', 0, 0, 1, false, 200, 'exploration', false]
  ]);
  // The flag columns exist on these rows, false until the flag steps run.
  assert.ok(got.every((r) => [r.franken_any, r.franken_no_cospend, r.unfrackit_user, r.evolution_tidied, r.prior_treated].every((v) => v === false)));
  assert.equal((await check(h)).ada_only_caps_hold, true);
});

test('the ADA-only sample is short at the sample\'s stopping point and the ADA-only pilot at the recent pilot\'s', async () => {
  // sample_n 2, pilot_n 1, ada_only_n 3, ada_only_pilot_n 3. Recent order:
  //   1 w1 (T) sample   2 w21 (F) ADA-only sample   3 w2 (T) sample, full: k_stop 3
  //   4 w22 (F) after the sample's stop: not in the ADA-only sample, which is
  //     short at 1 and stops at 3; the ADA-only pilot's first
  //   5 w3 (T) pilot, full: k_stop 5
  //   6 w23 (F) after the pilot's stop: the ADA-only pilot is short at 1 and
  //     stops at 5
  const order = { recent: [[1, 0, T, T], [21, 0, F, T], [2, 0, T, T], [22, 0, F, T], [3, 0, T, T], [23, 0, F, T]], peak: [] };
  const h = await drawAll(order, { sample_n: 2, pilot_n: 1, ada_only_n: 3, ada_only_pilot_n: 3 });
  assert.deepEqual(await ids(h, 'recent', 'ada_only'), [21]);
  assert.deepEqual(await summary(h, 'recent', 'ada_only'), { k_full: null, k_stop: 3, n_drawn: 1, n_taken: 1, guard_reached: false, sample_n: 3 });
  assert.deepEqual(await ids(h, 'recent', 'ada_only_pilot'), [22]);
  assert.deepEqual(await summary(h, 'recent', 'ada_only_pilot'), { k_full: null, k_stop: 5, n_drawn: 1, n_taken: 1, guard_reached: false, sample_n: 3 });
  const c = await check(h);
  assert.ok(Object.values(c).every((v) => v === true), JSON.stringify(c));
});

test('an ADA-only key past the guard is no candidate, and a kind short at the guard records it', async () => {
  // guard 4, sample_n 5, pilot_n 1, ada_only_n 5, ada_only_pilot_n 5. Recent
  // order: 1 w1 (T), 2 w21 (F), 3 w2 (T), 4 w22 (F), 5 w23 (F), 6 w3 (T). The
  // sample is short at the guard (w1, w2; k_stop 4); the ADA-only sample takes
  // w21 and w22 and stops there too; w23 lies past the guard. The pilot and
  // the ADA-only pilot have nothing within the guard, and stop at 4.
  const order = { recent: [[1, 0, T, T], [21, 0, F, T], [2, 0, T, T], [22, 0, F, T], [23, 0, F, T], [3, 0, T, T]], peak: [] };
  const h = await drawAll(order, { sample_n: 5, pilot_n: 1, ada_only_n: 5, ada_only_pilot_n: 5, guard: 4 });
  assert.deepEqual(await ids(h, 'recent', 'random'), [1, 2]);
  assert.deepEqual(await ids(h, 'recent', 'ada_only'), [21, 22]);
  assert.deepEqual(await summary(h, 'recent', 'ada_only'), { k_full: null, k_stop: 4, n_drawn: 2, n_taken: 2, guard_reached: true, sample_n: 5 });
  assert.deepEqual(await ids(h, 'recent', 'ada_only_pilot'), []);
  assert.deepEqual(await summary(h, 'recent', 'ada_only_pilot'), { k_full: null, k_stop: 4, n_drawn: 0, n_taken: 0, guard_reached: true, sample_n: 5 });
  const w23 = (await h.rows(`SELECT ada_only_candidate FROM study.draw_order WHERE frame = 'recent' AND sa_id = 23`))[0];
  assert.equal(w23.ada_only_candidate, false);
  const c = await check(h);
  assert.ok(Object.values(c).every((v) => v === true), JSON.stringify(c));
});

// Each break: the key it must turn false and the statement that breaks it,
// run on a fresh valid draw of ORDER.
const row = (frame, kind, sa, k, hi) => `INSERT INTO study.sample (frame, kind, sa_id, draw_rank, size_group, n_utxo_start, n_utxo_ref, n_window_tx, capped, history_hi)
                                        VALUES ('${frame}', '${kind}', ${sa}, ${k}, 'B0', 0, 0, 1, false, ${hi})`;
const BREAKS = [
  ['ada_only_size_holds', 'full, but its stop is not its last wallet\'s key', `UPDATE study.draw_summary SET k_stop = 4 WHERE kind = 'ada_only'`],
  ['ada_only_size_holds', 'more than its size', row('recent', 'ada_only', 24, 6, 200)],
  ['ada_only_members_qualify', 'a wallet holding a native asset', `UPDATE study.frame SET tok = true WHERE frame = 'recent' AND sa_id = 21`],
  ['ada_only_members_qualify', 'a wallet with fewer than 5 spends', `UPDATE study.frame SET ge5 = false WHERE frame = 'recent' AND sa_id = 23`],
  ['ada_only_members_qualify', 'a wallet after the sample\'s stopping point', row('recent', 'ada_only', 26, 12, 200)],
  ['ada_only_members_qualify', 'a row in the peak frame', row('peak', 'ada_only', 31, 2, 60)],
  ['ada_only_none_passed_over', 'a candidate before its stop left out', `DELETE FROM study.sample WHERE kind = 'ada_only' AND sa_id = 21`],
  ['ada_only_caps_hold', 'capped with T under the cap', `UPDATE study.sample SET capped = true WHERE kind = 'ada_only' AND sa_id = 21`],
  ['ada_only_pilot_size_holds', 'full, but its stop is not its last wallet\'s key', `UPDATE study.draw_summary SET k_stop = 9 WHERE kind = 'ada_only_pilot'`],
  ['ada_only_pilot_members_qualify', 'a wallet after the recent pilot\'s stopping point', row('recent', 'ada_only_pilot', 26, 12, 200)],
  ['ada_only_pilot_members_qualify', 'a wallet holding a native asset', `UPDATE study.frame SET tok = true WHERE frame = 'recent' AND sa_id = 25`],
  ['ada_only_pilot_none_passed_over', 'a candidate inside its bounds left out', `DELETE FROM study.sample WHERE kind = 'ada_only_pilot' AND sa_id = 24`],
  ['ada_only_pilot_caps_hold', 'an uncapped history ending before the window\'s end', `UPDATE study.sample SET history_hi = 150 WHERE kind = 'ada_only_pilot' AND sa_id = 25`],
  ['ada_only_pilot_outside_samples', 'an ADA-only pilot wallet in the peak sample', row('peak', 'random', 25, 9, 60)],
  ['ada_only_outside_pilots', 'an ADA-only sample wallet in the peak pilot', row('peak', 'pilot', 21, 5, 60)]
];

test('each ADA-only key of the draw check is true on a valid draw and false on one built to break it', async () => {
  const h0 = await drawAll(ORDER, OVER);
  const valid = await check(h0);
  for (const k of ADA_KEYS) assert.equal(valid[k], true, k);
  assert.ok(Object.values(valid).every((v) => v === true), JSON.stringify(valid));
  assert.deepEqual(new Set(BREAKS.map((b) => b[0])), new Set(ADA_KEYS), 'every key has a break');
  for (const [key, what, sql] of BREAKS) {
    const h = await drawAll(ORDER, OVER);
    await h.db.exec(sql);
    assert.equal((await check(h))[key], false, `${key}: ${what}`);
  }
});

test('the ADA-only sizes are fixed settings of 1,000 and 100', () => {
  const s = defaultSettings();
  assert.deepEqual([s.ada_only_n, s.ada_only_pilot_n], [1000, 100]);
  assert.equal(applyOverrides(s, ['ada_only_n=2']).ada_only_n, 2);
});
