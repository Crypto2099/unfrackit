// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The draw and split digests computed by the frame step's SQL against Node's
// crypto for fixed inputs (both readings of x5_reward29) and against a
// published test vector; the frame stages, the draw (the guard path and the
// path where all three targets are reached) and the split on a fixture small
// enough to check by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { freshDb, bool, int, num, text, bytea } from '../lib/pglite.mjs';
import { defaultSettings, sqlParams } from '../../src/params.mjs';

const H = 'a5'.repeat(16) + '5a'.repeat(16);
const sha = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest('hex');

function credHex(i) {
  return createHash('sha256').update(`cred ${i}`).digest('hex').slice(0, 56);
}

async function fixture(db, n) {
  await db.exec(`
    CREATE TABLE study.cred (sa_id bigint PRIMARY KEY, hash_raw bytea, cred_hash bytea, header_type int, network_tag int, is_script boolean, script_hash bytea, view text);
    CREATE TABLE study.activity (win text, sa_id bigint, n_tx_key bigint, n_tx_any bigint, n_spends_key bigint, n_spends_any bigint, n_receipts bigint, n_tx bigint, n_spends bigint);
    CREATE TABLE study.state (point text, sa_id bigint, n_utxo bigint, lovelace numeric, lovelace_all numeric, lovelace_script_pay numeric, n_assets bigint, n_nft bigint, n_units numeric);
    CREATE TABLE study.paycount (point text, sa_id bigint, n_pay bigint, n_pay_key bigint);
  `);
  for (let i = 1; i <= n; i++) {
    const c = credHex(i);
    const script = i === 3;
    const header = script ? 'f0' : 'e0';
    await db.query(`INSERT INTO study.cred VALUES ($1, decode($2, 'hex'), decode($3, 'hex'), $4, 0, $5, $6, $7)`, [i, header + c, c, script ? 15 : 14, script, script ? Buffer.from(c, 'hex') : null, `v${i}`]);
    // Every credential is active in both windows with i spends.
    for (const win of ['recent', 'peak']) await db.query(`INSERT INTO study.activity VALUES ($1, $2, $3, $3, $3, $3, 0, $3, $3)`, [win, i, i]);
    // Credential 4 holds nothing at the snapshot; 5 has 30,000 UTxOs; 6 has 300
    // key payment credentials; 7 has most of its value at script credentials;
    // even credentials hold one token, 10 holds 150 distinct assets.
    const nUtxo = i === 4 ? 0 : i === 5 ? 30000 : 2;
    const tok = i === 10 ? 150 : i % 2 === 0 ? 1 : 0;
    for (const point of ['snap', 'peak_start', 'peak_end']) {
      if (nUtxo > 0) await db.query(`INSERT INTO study.state VALUES ($1, $2, $3, 100, 100, $4::numeric, $5::bigint, $5::bigint, $5::bigint::numeric)`, [point, i, nUtxo, i === 7 ? 60 : 0, tok]);
    }
    // 6 has 300 key payment credentials; 11 has 300 payment credentials, only
    // one of them a key, so the key-credential cap keeps it.
    for (const point of ['snap', 'peak_end']) await db.query(`INSERT INTO study.paycount VALUES ($1, $2, $3, $4)`, [point, i, i === 6 || i === 11 ? 300 : 1, i === 6 ? 300 : 1]);
  }
}

function params(over = {}) {
  const settings = { ...defaultSettings(), ...over };
  const p = sqlParams({ network: 'preprod', settings, snapshot: { id: 1, t: 1 }, h: H, windows: { recent: { lo: 1, hi: 1, t_start: 0, first_epoch: 1, last_epoch: 1 }, peak: { lo: 1, hi: 1, t_start: 0, first_epoch: 1, last_epoch: 1 } } });
  return p;
}

test('draw and split keys match Node SHA-256 of "draw"/"split" || h || credential', async () => {
  const { db, runBlock, rows } = await freshDb();
  await fixture(db, 12);
  await runBlock('frame', params());
  const got = await rows(`SELECT sa_id, encode(cred_hash, 'hex') AS c, encode(draw_key, 'hex') AS d, encode(split_key, 'hex') AS s, is_script FROM study.frame WHERE frame = 'recent' ORDER BY sa_id`);
  assert.equal(got.length, 12);
  for (const r of got) {
    if (r.is_script) {
      assert.equal(r.d, null);
      continue;
    }
    const c = Buffer.from(r.c, 'hex');
    assert.equal(r.d, sha(Buffer.from('draw', 'ascii'), Buffer.from(H, 'hex'), c));
    assert.equal(r.s, sha(Buffer.from('split', 'ascii'), Buffer.from(H, 'hex'), c));
  }
});

test('x5_reward29 hashes the 29-byte reward address', async () => {
  const { db, runBlock, rows } = await freshDb();
  await fixture(db, 2);
  await runBlock('frame', params({ x5_reward29: true }));
  const r = (await rows(`SELECT encode(hash_raw, 'hex') AS a, encode(draw_key, 'hex') AS d FROM study.frame WHERE frame = 'recent' AND sa_id = 1`))[0];
  assert.equal(r.d, sha(Buffer.from('draw'), Buffer.from(H, 'hex'), Buffer.from(r.a, 'hex')));
});

test('stages, flow, draw order, samples and split on the fixture', async () => {
  const { db, runBlock, rows } = await freshDb();
  await fixture(db, 12);
  const p = params({ guard: 6, target_a: 2, target_b: 1, target_c: 1, ada_only_n: 2 });
  await runBlock('frame', p);
  await runBlock('flow', p);
  const f = Object.fromEntries((await rows(`SELECT sa_id, eligible, s3, s4, s5, s6, is_script, tok, ge5, ge100 FROM study.frame WHERE frame = 'recent'`)).map((r) => [r.sa_id, r]));
  assert.equal(f[3].is_script, true);
  assert.equal(f[4].s3, false);
  assert.equal(f[5].s4, false);
  assert.equal(f[6].s5, false);
  assert.equal(f[7].s6, false);
  assert.equal(f[10].ge100, true);
  const eligible = Object.values(f).filter((r) => r.eligible).map((r) => Number(r.sa_id)).sort((a, b) => a - b);
  assert.deepEqual(eligible, [1, 2, 8, 9, 10, 11, 12]);
  const flow = await rows(`SELECT stage_no, n_in, n_removed, n_out FROM study.flow WHERE frame = 'recent' ORDER BY stage_no`);
  assert.deepEqual(flow.map((r) => [r.stage_no, Number(r.n_removed)]), [[1, 0], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 0]]);
  for (let i = 1; i < flow.length; i++) assert.equal(Number(flow[i].n_in), Number(flow[i - 1].n_out));
  const peakFlow = await rows(`SELECT stage_no, n_removed FROM study.flow WHERE frame = 'peak' AND stage_no = 3`);
  assert.equal(Number(peakFlow[0].n_removed), 0, 'stage 3 applies to the recent frame only');

  await runBlock('draw', p);
  const order = await rows(`SELECT sa_id, k, tok, ge5, ge100 FROM study.draw_order WHERE frame = 'recent' ORDER BY k`);
  const keys = await rows(`SELECT sa_id, draw_key FROM study.frame WHERE frame = 'recent' AND eligible ORDER BY draw_key`);
  assert.deepEqual(order.map((r) => r.sa_id), keys.map((r) => r.sa_id));
  // Expected stopping point from the running counts, computed here.
  let na = 0, nb = 0, nc = 0, kAll = null, kA = null;
  for (const r of order) {
    if (r.tok) na++;
    if (r.tok && r.ge5) nb++;
    if (r.tok && r.ge100) nc++;
    if (kA === null && na >= 2) kA = Number(r.k);
    if (kAll === null && na >= 2 && nb >= 1 && nc >= 1) kAll = Number(r.k);
  }
  const kStop = kAll ?? Math.min(6, order.length);
  const random = await rows(`SELECT sa_id, draw_rank, prevalence_member FROM study.sample WHERE frame = 'recent' AND kind = 'random' ORDER BY draw_rank`);
  assert.deepEqual(random.map((r) => Number(r.draw_rank)), order.filter((r) => r.tok && Number(r.k) <= kStop).map((r) => Number(r.k)));
  for (const r of random) assert.equal(r.prevalence_member, Number(r.draw_rank) <= (kA ?? kStop));
  const ada = await rows(`SELECT draw_rank FROM study.sample WHERE frame = 'recent' AND kind = 'ada_only' ORDER BY draw_rank`);
  assert.deepEqual(ada.map((r) => Number(r.draw_rank)), order.filter((r) => !r.tok).slice(0, 2).map((r) => Number(r.k)));

  await db.exec(`CREATE TABLE study.sample_frame_dummy (x int)`);
  await runBlock('split', p);
  // One label per credential: every sampled credential ranked once by its
  // split key, the first floor(N / 5) exploration (X16 as decided).
  const all = await rows(`SELECT DISTINCT s.sa_id, encode(f.split_key, 'hex') AS k FROM study.sample s JOIN study.frame f ON f.frame = s.frame AND f.sa_id = s.sa_id ORDER BY k`);
  const nExp = Math.floor(all.length / 5);
  const want = new Map(all.map((r, i) => [Number(r.sa_id), i < nExp ? 'exploration' : 'confirmation']));
  const got = await rows(`SELECT frame, kind, sa_id, split FROM study.sample`);
  for (const r of got) assert.equal(r.split, want.get(Number(r.sa_id)), `${r.frame} ${r.kind} ${r.sa_id}`);
});

// The published draw vector: h is preprod's epoch 320 nonce (as db-sync's
// epoch_param.nonce and Koios epoch_params give it), the credential the stake
// key hash of CIP-19's test vectors (stake_test1uqehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gssrtvn).
// The digests were computed with sha256sum and openssl over the same bytes.
const VECTOR = {
  h: '8827df62e1c5f7909885b09cb156d6f1eca8b15eb793fa4758e95c8aa79a1d00',
  credential: '337b62cfff6403a06a3acbc34f8c46003c69fe79a3628cefa9c47251',
  draw: '88977a462d379bd930e77accf1a8268456042de78447381c9b226cff74846b2c',
  split: '8a31ce172bafcb7ee867a64ccc8a6e0a4f24405d98bf739b74abbd939179d2a2'
};

test('the draw and split keys reproduce the published test vector', async () => {
  assert.equal(sha(Buffer.from('draw', 'ascii'), Buffer.from(VECTOR.h, 'hex'), Buffer.from(VECTOR.credential, 'hex')), VECTOR.draw);
  assert.equal(sha(Buffer.from('split', 'ascii'), Buffer.from(VECTOR.h, 'hex'), Buffer.from(VECTOR.credential, 'hex')), VECTOR.split);
  const { db, runBlock, rows } = await freshDb();
  await fixture(db, 1);
  await db.query(`UPDATE study.cred SET hash_raw = decode($1, 'hex'), cred_hash = decode($2, 'hex')`, ['e0' + VECTOR.credential, VECTOR.credential]);
  const settings = defaultSettings();
  await runBlock('frame', sqlParams({ network: 'preprod', settings, snapshot: { id: 1, t: 1 }, h: VECTOR.h, windows: { recent: { lo: 1, hi: 1, t_start: 0, first_epoch: 1, last_epoch: 1 }, peak: { lo: 1, hi: 1, t_start: 0, first_epoch: 1, last_epoch: 1 } } }));
  const r = (await rows(`SELECT encode(draw_key, 'hex') AS d, encode(split_key, 'hex') AS s FROM study.frame WHERE frame = 'recent'`))[0];
  assert.deepEqual(r, { d: VECTOR.draw, s: VECTOR.split });
});

test('all three targets reached: the sample is the prefix up to k_all, prevalence up to k_a', async () => {
  const { db, runBlock, rows } = await freshDb();
  await fixture(db, 40);
  // Even credentials hold a token, 10 holds 150 assets; spends = id. Targets
  // the fixture reaches well before its end: (a) 4 token-holding, (b) 3 with
  // 5 or more spends, (c) 1 with 100 or more assets.
  const p = params({ guard: 1000, target_a: 4, target_b: 3, target_c: 1, ada_only_n: 3 });
  await runBlock('frame', p);
  await runBlock('draw', p);
  const order = await rows(`SELECT sa_id, k, tok, ge5, ge100 FROM study.draw_order WHERE frame = 'recent' ORDER BY k`);
  let na = 0, nb = 0, nc = 0, kAll = null, kA = null;
  for (const r of order) {
    if (r.tok) na++;
    if (r.tok && r.ge5) nb++;
    if (r.tok && r.ge100) nc++;
    if (kA === null && na >= 4) kA = Number(r.k);
    if (kAll === null && na >= 4 && nb >= 3 && nc >= 1) kAll = Number(r.k);
  }
  assert.ok(kAll !== null && kAll < order.length, 'the fixture reaches every target before its end');
  const s = (await rows(`SELECT k_all, k_a, k_stop, k_prevalence, guard_reached, n_a, n_b, n_c FROM study.draw_summary WHERE frame = 'recent'`))[0];
  assert.equal(Number(s.k_all), kAll);
  assert.equal(Number(s.k_stop), kAll);
  assert.equal(Number(s.k_prevalence), kA);
  assert.equal(s.guard_reached, false);
  assert.ok(Number(s.n_a) >= 4 && Number(s.n_b) >= 3 && Number(s.n_c) >= 1);
  const random = await rows(`SELECT draw_rank, prevalence_member FROM study.sample WHERE frame = 'recent' AND kind = 'random' ORDER BY draw_rank`);
  assert.deepEqual(random.map((r) => Number(r.draw_rank)), order.filter((r) => r.tok && Number(r.k) <= kAll).map((r) => Number(r.k)));
  for (const r of random) assert.equal(r.prevalence_member, Number(r.draw_rank) <= kA);
  assert.equal(random.filter((r) => r.prevalence_member).length, 4, 'prevalence members are the first four token-holding wallets');
  assert.equal(random.length > 4, kAll > kA);
});
