// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The draw and split digests computed by the frame step's SQL against Node's
// crypto for fixed inputs (both readings of x5_reward29) and against a
// published test vector; the frame stages and the flow table; the draw and
// its sample against an independent statement of the rule in this file (size
// groups by the UTxO count at the window's start or the reference block and
// the window's transactions, quotas filled in draw order with later wallets
// of a full group skipped and counted, the stop at the full sample, the
// guard, the frame's end, the quota scale, held UTxOs, the history cap and
// where each history ends); the fragmentation flag on every sample row; the
// state step's fragmentation measure; and the split on a fixture small
// enough to check by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { freshDb, bool, int, num, text, bytea } from '../lib/pglite.mjs';
import { defaultSettings, sqlParams, applyOverrides } from '../../src/params.mjs';
import { fill } from '../../src/sqlfile.mjs';

const H = 'a5'.repeat(16) + '5a'.repeat(16);
const sha = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest('hex');

function credHex(i) {
  return createHash('sha256').update(`cred ${i}`).digest('hex').slice(0, 56);
}

const payCred = (i) => createHash('sha256').update(`payment ${i}`).digest().subarray(0, 28);

async function fixture(db, n) {
  await db.exec(`
    CREATE TABLE study.cred (sa_id bigint PRIMARY KEY, hash_raw bytea, cred_hash bytea, header_type int, network_tag int, is_script boolean, script_hash bytea, view text);
    CREATE TABLE study.activity (win text, sa_id bigint, n_tx_key bigint, n_tx_any bigint, n_spends_key bigint, n_spends_any bigint, n_receipts bigint, n_tx bigint, n_spends bigint);
    CREATE TABLE study.state (point text, sa_id bigint, n_utxo bigint, lovelace numeric, lovelace_all numeric, lovelace_script_pay numeric, n_assets bigint, n_nft bigint, n_units numeric, max_ft_utxos bigint);
    CREATE TABLE study.paycount (point text, sa_id bigint, n_pay bigint, n_pay_key bigint);
    CREATE TABLE public.tx_out (id bigint PRIMARY KEY, tx_id bigint, stake_address_id bigint, index int DEFAULT 0, value numeric DEFAULT 1000000,
                                payment_cred bytea, address_has_script boolean DEFAULT false, data_hash bytea, inline_datum_id bigint, reference_script_id bigint);
    CREATE TABLE public.tx_in (tx_in_id bigint, tx_out_id bigint, tx_out_index int);
  `);
  for (let i = 1; i <= n; i++) {
    const c = credHex(i);
    await db.query(`INSERT INTO public.tx_out (id, tx_id, stake_address_id, payment_cred) VALUES ($1, 1, $1, $2)`, [i, payCred(i)]);
    const script = i === 3;
    const header = script ? 'f0' : 'e0';
    await db.query(`INSERT INTO study.cred VALUES ($1, decode($2, 'hex'), decode($3, 'hex'), $4, 0, $5, $6, $7)`, [i, header + c, c, script ? 15 : 14, script, script ? Buffer.from(c, 'hex') : null, `v${i}`]);
    // Every credential is active in both windows with i spends.
    for (const win of ['recent', 'peak']) await db.query(`INSERT INTO study.activity VALUES ($1, $2, $3, $3, $3, $3, 0, $3, $3)`, [win, i, i]);
    // Credential 4 holds nothing at the snapshot; 5 has 30,000 UTxOs; 6 has 300
    // key payment credentials; 7 has most of its value at script credentials;
    // even credentials hold one token, 10 holds 150 distinct assets; every
    // credential divisible by 4 has a fungible asset on 12 UTxOs (fragmented),
    // at the peak window's end only for 28.
    const nUtxo = i === 4 ? 0 : i === 5 ? 30000 : 2;
    const tok = i === 10 ? 150 : i % 2 === 0 ? 1 : 0;
    for (const point of ['snap', 'peak_start', 'peak_end']) {
      const maxFt = i % 4 === 0 && (i !== 28 || point === 'peak_end') ? 12 : tok ? 1 : 0;
      if (nUtxo > 0) await db.query(`INSERT INTO study.state VALUES ($1, $2, $3, 100, 100, $4::numeric, $5::bigint, $5::bigint, $5::bigint::numeric, $6::bigint)`, [point, i, nUtxo, i === 7 ? 60 : 0, tok, maxFt]);
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
  const p = params({ guard: 7, sample_n: 2 });
  await runBlock('frame', p);
  await runBlock('txo', p);
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
  const order = await rows(`SELECT sa_id, k, tok, ge5, candidate, taken FROM study.draw_order WHERE frame = 'recent' ORDER BY k`);
  const keys = await rows(`SELECT sa_id, draw_key FROM study.frame WHERE frame = 'recent' AND eligible ORDER BY draw_key`);
  assert.deepEqual(order.map((r) => r.sa_id), keys.map((r) => r.sa_id));
  // The candidates are the token-holding wallets with at least 5 spends within
  // the guard; the sample, the first two of them in draw order.
  const cands = order.filter((r) => r.tok && r.ge5 && Number(r.k) <= 7);
  assert.deepEqual(order.filter((r) => r.candidate).map((r) => Number(r.sa_id)), cands.map((r) => Number(r.sa_id)));
  assert.deepEqual(cands.map((r) => Number(r.sa_id)).sort((a, b) => a - b), [8, 10, 12], 'token-holding with 5 or more spends: 8, 10 and 12');
  const random = await rows(`SELECT sa_id, draw_rank, size_group, n_utxo_start, n_utxo_ref, n_window_tx, capped, history_hi FROM study.sample WHERE frame = 'recent' AND kind = 'random' ORDER BY draw_rank`);
  assert.deepEqual(random.map((r) => Number(r.draw_rank)), cands.slice(0, 2).map((r) => Number(r.k)));
  for (const r of random) {
    // One output each at transaction 1, after the window's start (0); i
    // transactions in the window; two UTxOs at the snapshot.
    assert.deepEqual([r.size_group, Number(r.n_utxo_start), Number(r.n_utxo_ref), Number(r.n_window_tx), r.capped, Number(r.history_hi)], ['B0', 0, 2, Number(r.sa_id), false, 1]);
  }
  assert.equal((await rows(`SELECT count(*) AS n FROM study.sample WHERE kind <> 'random'`))[0].n, 0);
  const sum = (await rows(`SELECT k_full, k_stop, guard_reached, n_taken FROM study.draw_summary WHERE frame = 'recent'`))[0];
  assert.deepEqual([Number(sum.k_full), Number(sum.k_stop), sum.guard_reached, Number(sum.n_taken)], [Number(cands[1].k), Number(cands[1].k), false, 2]);

  await db.exec(`CREATE TABLE study.sample_frame_dummy (x int)`);
  await runBlock('split', p);
  // One label per credential: every sampled credential ranked once by its split
  // key, the first floor(N / 5) exploration (the one-label rule of split.sql).
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

// The draw rule stated here, independently of draw.sql. Per frame: the
// eligible keys in draw order; within the guard, every token-holding wallet
// with at least 5 spends is a candidate; U is the larger of its UTxO count at
// the window's start, counted here from the life table's rows, and at the
// reference block; T is the number of distinct window transactions that
// create or consume one of its outputs; the group is the highest edge U or T
// reaches; a candidate is taken while its group has room, and the draw stops
// at the candidate that fills the sample. A capped wallet's history ends at
// its history_cap-th window transaction, any other's at the window's end.
const W = {
  recent: { lo: 101, hi: 200, t_start: 100, first_epoch: 2, last_epoch: 3 },
  peak: { lo: 11, hi: 60, t_start: 10, first_epoch: 1, last_epoch: 1 }
};
const GROUPS = ['B0', 'B1', 'B2', 'B3'];

// Each quota is its value times s rounded to a whole number, halves up,
// computed exactly from s's decimal digits.
function quotaAt(base, s) {
  const [whole, frac = ''] = s.split('.');
  const den = 10n ** BigInt(frac.length);
  return Number((2n * BigInt(base) * BigInt(whole + frac) + den) / (2n * den));
}

function rule({ wallets, txo }, settings, windows = W) {
  const out = {};
  for (const frame of ['recent', 'peak']) {
    const w = windows[frame];
    const elig = wallets.filter((x) => x.frames[frame] && x.frames[frame].eligible).sort((a, b) => Buffer.compare(a.frames[frame].key, b.frames[frame].key));
    const quota = { B0: null, B1: quotaAt(settings.quota_b1, settings.quota_scale), B2: quotaAt(settings.quota_b2, settings.quota_scale), B3: quotaAt(settings.quota_b3, settings.quota_scale) };
    const groups = Object.fromEntries(GROUPS.map((g) => [g, { quota: quota[g], drawn: 0, taken: 0 }]));
    const sample = [];
    let kFull = null;
    for (let k = 1; k <= Math.min(elig.length, settings.guard); k++) {
      const x = elig[k - 1];
      const f = x.frames[frame];
      if (!(f.tok && f.ge5)) continue;
      const rows = txo.filter((t) => t.sa === x.sa);
      const start = rows.filter((t) => t.created <= w.t_start && (t.consumed === null || t.consumed > w.t_start) && (settings.x9_count_held || !t.held)).length;
      const txs = [...new Set(rows.flatMap((t) => [t.created, t.consumed]).filter((v) => v !== null && v >= w.lo && v <= w.hi))].sort((a, b) => a - b);
      const u = Math.max(start, f.nUtxo);
      const t = txs.length;
      const reaches = (e) => u >= e || t >= e;
      const g = reaches(settings.group_edge_b3) ? 'B3' : reaches(settings.group_edge_b2) ? 'B2' : reaches(settings.group_edge_b1) ? 'B1' : 'B0';
      groups[g].drawn++;
      if (quota[g] !== null && groups[g].taken >= quota[g]) continue;
      groups[g].taken++;
      const capped = t > settings.history_cap;
      sample.push({ sa: x.sa, k, g, start, ref: f.nUtxo, t, capped, hi: capped ? txs[settings.history_cap - 1] : w.hi });
      if (sample.length === settings.sample_n) {
        kFull = k;
        break;
      }
    }
    out[frame] = { sample, groups, kFull, kStop: kFull ?? Math.min(settings.guard, elig.length), guardReached: kFull === null && elig.length >= settings.guard, nEligible: elig.length };
  }
  return out;
}

function lcg(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

// A world of wallets in both frames: eligible or not, token-holding or not,
// active or not; UTxOs held before both windows' starts (some spent before or
// inside a window, some held); window transactions, some of them both
// creating and consuming the wallet's outputs; a reference UTxO count. The
// counts are skewed so that every group occurs at small edges.
function world(seed, n) {
  const rnd = lcg(seed);
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const skew = () => {
    const r = rnd();
    return r < 0.7 ? int(0, 4) : r < 0.85 ? int(5, 9) : r < 0.95 ? int(10, 19) : int(20, 30);
  };
  const wallets = [];
  const txo = [];
  let id = 0;
  for (let sa = 1; sa <= n; sa++) {
    const frames = {};
    for (const frame of ['recent', 'peak']) {
      if (frame === 'peak' && sa % 3 === 0) continue;
      frames[frame] = { eligible: sa % 11 !== 0, tok: rnd() < 0.85, ge5: rnd() < 0.8, frag: rnd() < 0.2, nUtxo: skew(), key: createHash('sha256').update(`${frame} ${seed} ${sa}`).digest(), split: createHash('sha256').update(`split ${seed} ${sa}`).digest() };
    }
    for (let i = skew(); i > 0; i--) txo.push({ id: ++id, sa, created: int(1, 9), consumed: rnd() < 0.3 ? int(5, 150) : null, held: rnd() < 0.15 });
    for (const [lo, hi] of [[W.recent.lo, W.recent.hi], [W.peak.lo, W.peak.hi]]) {
      const txs = new Set();
      for (let i = skew(); i > 0; i--) txs.add(int(lo, hi));
      const list = [...txs].sort((a, b) => a - b);
      list.forEach((tx, i) => {
        const later = list.slice(i + 1);
        txo.push({ id: ++id, sa, created: tx, consumed: later.length && rnd() < 0.3 ? later[int(0, later.length - 1)] : null, held: false });
      });
    }
    wallets.push({ sa, frames });
  }
  return { wallets, txo };
}

async function loadWorld(db, { wallets, txo }) {
  await db.exec(`
    CREATE TABLE study.frame (frame text, sa_id bigint, eligible boolean, tok boolean, ge5 boolean, frag boolean, n_utxo bigint, draw_key bytea, split_key bytea);
    CREATE TABLE study.txo (tx_out_id bigint PRIMARY KEY, created_tx bigint, consumed_tx bigint, sa_id bigint, out_index int, value numeric,
                            payment_cred bytea, script_pay boolean, has_datum boolean, has_ref_script boolean, via_payment boolean);
  `);
  const frames = wallets.flatMap((x) => Object.entries(x.frames).map(([frame, f]) => ({ frame, sa: x.sa, eligible: f.eligible, tok: f.tok, ge5: f.ge5, frag: f.frag, n: f.nUtxo, key: f.key.toString('hex'), split: f.split.toString('hex') })));
  await db.query(`INSERT INTO study.frame SELECT x.frame, x.sa, x.eligible, x.tok, x.ge5, x.frag, x.n, decode(x.key, 'hex'), decode(x.split, 'hex')
                    FROM json_to_recordset($1::json) AS x(frame text, sa bigint, eligible boolean, tok boolean, ge5 boolean, frag boolean, n bigint, key text, split text)`, [JSON.stringify(frames)]);
  await db.query(`INSERT INTO study.txo SELECT x.id, x.created, x.consumed, x.sa, 0, 1000000, NULL, false, x.held, false, false
                    FROM json_to_recordset($1::json) AS x(id bigint, created bigint, consumed bigint, sa bigint, held boolean)`, [JSON.stringify(txo)]);
}

const SMALL = { sample_n: 15, group_edge_b1: 5, group_edge_b2: 10, group_edge_b3: 20, quota_b1: 3, quota_b2: 2, quota_b3: 1, history_cap: 8, guard: 1000 };

// Runs the activity and draw steps (and the split) on a loaded world, and
// compares every sample row, group and frame summary with the rule above.
async function drawAgainstRule(h, w, over, windows = W) {
  const settings = applyOverrides(defaultSettings(), Object.entries(over).map(([k, v]) => `${k}=${v}`));
  const p = sqlParams({ network: 'preprod', settings, snapshot: { id: 1, t: 200 }, h: H, windows });
  await h.runBlock('activity', p);
  await h.runBlock('draw', p);
  await h.runBlock('split', p);
  const want = rule(w, settings, windows);
  for (const frame of ['recent', 'peak']) {
    const m = want[frame];
    const got = await h.rows(`SELECT sa_id, kind, draw_rank, size_group, n_utxo_start, n_utxo_ref, n_window_tx, capped, history_hi FROM study.sample WHERE frame = $1 ORDER BY draw_rank`, [frame]);
    assert.deepEqual(
      got.map((r) => [Number(r.sa_id), r.kind, Number(r.draw_rank), r.size_group, Number(r.n_utxo_start), Number(r.n_utxo_ref), Number(r.n_window_tx), r.capped, Number(r.history_hi)]),
      m.sample.map((x) => [x.sa, 'random', x.k, x.g, x.start, x.ref, x.t, x.capped, x.hi]),
      `${frame}: the sample`
    );
    const groups = await h.rows(`SELECT size_group, quota, n_drawn, n_taken, n_skipped FROM study.draw_group WHERE frame = $1 ORDER BY size_group`, [frame]);
    assert.deepEqual(
      groups.map((r) => [r.size_group, r.quota === null ? null : Number(r.quota), Number(r.n_drawn), Number(r.n_taken), Number(r.n_skipped)]),
      GROUPS.map((g) => [g, m.groups[g].quota, m.groups[g].drawn, m.groups[g].taken, m.groups[g].drawn - m.groups[g].taken]),
      `${frame}: D_k and A_k`
    );
    const sum = (await h.rows(`SELECT k_full, k_stop, n_eligible, guard_reached, n_drawn, n_taken, sample_n, quota_scale::text AS s, history_cap FROM study.draw_summary WHERE frame = $1`, [frame]))[0];
    assert.deepEqual(
      [sum.k_full === null ? null : Number(sum.k_full), Number(sum.k_stop), Number(sum.n_eligible), sum.guard_reached, Number(sum.n_drawn), Number(sum.n_taken), Number(sum.sample_n), sum.s, Number(sum.history_cap)],
      [m.kFull, m.kStop, m.nEligible, m.guardReached, GROUPS.reduce((a, g) => a + m.groups[g].drawn, 0), m.sample.length, settings.sample_n, settings.quota_scale, settings.history_cap],
      `${frame}: the summary`
    );
  }
  const check = (await h.db.query(fill(h.blocks.get('draw_check').statements[0], p))).rows[0];
  assert.deepEqual(check, { groups_add_up: true, quotas_hold: true, sample_size_holds: true, caps_hold: true });
  // Every sample row carries its frame's fragmentation flag.
  const flags = await h.rows(`SELECT s.fragmented, f.frag FROM study.sample s JOIN study.frame f ON f.frame = s.frame AND f.sa_id = s.sa_id`);
  assert.ok(flags.length > 0 && flags.every((r) => r.fragmented === r.frag));
  return want;
}

test('the draw: groups, quotas filled in draw order, skipped wallets counted, the stop at a full sample, the cap', async () => {
  const w = world(7, 150);
  const h = await freshDb();
  await loadWorld(h.db, w);
  const want = await drawAgainstRule(h, w, SMALL);
  for (const frame of ['recent', 'peak']) {
    const m = want[frame];
    // What this world exercises, so a change to it cannot hollow the test.
    assert.equal(m.sample.length, 15, `${frame}: the sample fills`);
    assert.ok(m.kFull < m.nEligible, `${frame}: the draw stops before the frame's end`);
    for (const g of ['B1', 'B2', 'B3']) assert.ok(m.groups[g].drawn > m.groups[g].taken && m.groups[g].taken === m.groups[g].quota, `${frame}: ${g} fills and skips`);
    assert.ok(m.groups.B0.taken === 15 - 6 && m.groups.B0.drawn === m.groups.B0.taken, `${frame}: B0 takes the rest and skips none`);
    assert.ok(m.sample.some((x) => x.capped) && m.sample.some((x) => !x.capped), `${frame}: capped and uncapped wallets`);
    assert.ok(m.sample.some((x) => x.start > x.ref) && m.sample.some((x) => x.ref > x.start), `${frame}: U from the window's start and from the reference block`);
  }
  // One label per credential across both frames.
  const labels = await h.rows(`SELECT sa_id FROM study.sample GROUP BY sa_id HAVING count(DISTINCT split) > 1`);
  assert.deepEqual(labels, []);
});

test('the draw: the guard, the frame\'s end, the quota scale and held UTxOs', async () => {
  const w = world(11, 150);
  // The guard reached before the sample fills.
  let h = await freshDb();
  await loadWorld(h.db, w);
  let m = await drawAgainstRule(h, w, { ...SMALL, guard: 20 });
  for (const frame of ['recent', 'peak']) {
    assert.equal(m[frame].guardReached, true, `${frame}: guard reached`);
    assert.equal(m[frame].kStop, 20);
    assert.ok(m[frame].sample.length < 15);
  }
  // A sample larger than the frame: the draw runs to the frame's last key.
  h = await freshDb();
  await loadWorld(h.db, w);
  m = await drawAgainstRule(h, w, { ...SMALL, sample_n: 1000 });
  for (const frame of ['recent', 'peak']) {
    assert.deepEqual([m[frame].guardReached, m[frame].kFull, m[frame].kStop], [false, null, m[frame].nEligible], frame);
  }
  // The quota scale: halves round up, and a quota of 0 skips every wallet of
  // its group.
  for (const [s, quotas] of [['0.5', [2, 1, 1]], ['0.25', [1, 1, 0]], ['2.5', [8, 5, 3]], ['1.45', [4, 3, 1]]]) {
    assert.deepEqual([3, 2, 1].map((b) => quotaAt(b, s)), quotas, `quotas at s = ${s}`);
    h = await freshDb();
    await loadWorld(h.db, w);
    m = await drawAgainstRule(h, w, { ...SMALL, quota_scale: s });
    if (s === '0.25') for (const frame of ['recent', 'peak']) assert.ok(m[frame].groups.B3.drawn > 0 && m[frame].groups.B3.taken === 0, `${frame}: B3 at quota 0`);
  }
  // Held UTxOs left out of U (x9_count_held false) change the groups.
  h = await freshDb();
  await loadWorld(h.db, w);
  const held = await drawAgainstRule(h, w, { ...SMALL, x9_count_held: false });
  const counted = rule(w, applyOverrides(defaultSettings(), Object.entries(SMALL).map(([k, v]) => `${k}=${v}`)));
  assert.notDeepEqual(held.recent.sample, counted.recent.sample, 'held UTxOs matter in this world');
});

test('the draw at the study\'s edges: 250, 1,000 and 4,000 on either count, and the 1,000-transaction cap', async () => {
  // Recent window [1001, 6000] after a start at 1000; the peak frame is empty.
  const windows = { recent: { lo: 1001, hi: 6000, t_start: 1000, first_epoch: 2, last_epoch: 3 }, peak: { lo: 11, hi: 60, t_start: 10, first_epoch: 1, last_epoch: 1 } };
  // sa: [UTxOs at the reference block, UTxOs at the window's start, window transactions]
  const spec = {
    1: [249, 0, 249], 2: [250, 0, 0], 3: [0, 250, 0], 4: [0, 0, 250],
    5: [999, 999, 999], 6: [1000, 0, 0], 7: [0, 1000, 0], 8: [0, 0, 1000],
    9: [3999, 0, 1001], 10: [4000, 0, 0], 11: [0, 0, 4000], 12: [0, 4000, 1]
  };
  const wallets = [];
  const txo = [];
  let id = 0;
  for (const [k, [ref, start, ntx]] of Object.entries(spec)) {
    const sa = Number(k);
    wallets.push({ sa, frames: { recent: { eligible: true, tok: true, ge5: true, frag: false, nUtxo: ref, key: createHash('sha256').update(`edge ${sa}`).digest(), split: createHash('sha256').update(`edge split ${sa}`).digest() } } });
    for (let i = 0; i < start; i++) txo.push({ id: ++id, sa, created: 1 + (i % 999), consumed: null, held: false });
    // One output created at each window transaction, every other one spent
    // two transactions later, so a transaction both creates and consumes.
    for (let i = 0; i < ntx; i++) txo.push({ id: ++id, sa, created: 1001 + i, consumed: i % 2 === 0 && i + 2 < ntx ? 1001 + i + 2 : null, held: false });
  }
  const w = { wallets, txo };
  const h = await freshDb();
  await loadWorld(h.db, w);
  const m = await drawAgainstRule(h, w, {}, windows);
  // Every wallet's group, taken or skipped.
  const groups = Object.fromEntries((await h.rows(`SELECT sa_id, size_group FROM study.draw_order WHERE frame = 'recent'`)).map((r) => [Number(r.sa_id), r.size_group]));
  assert.deepEqual(groups, { 1: 'B0', 2: 'B1', 3: 'B1', 4: 'B1', 5: 'B1', 6: 'B2', 7: 'B2', 8: 'B2', 9: 'B2', 10: 'B3', 11: 'B3', 12: 'B3' });
  // B3's quota of 2 at s = 1 skips one of its three wallets.
  assert.deepEqual([m.recent.groups.B3.quota, m.recent.groups.B3.drawn, m.recent.groups.B3.taken], [2, 3, 2]);
  assert.equal(m.recent.sample.length, 11);
  // T = 1,000 is not capped; T = 1,001 and T = 4,000 are, and their histories
  // end at their 1,000th window transaction, 2,000.
  const caps = Object.fromEntries(m.recent.sample.map((x) => [x.sa, [x.t, x.capped, x.hi]]));
  assert.deepEqual(caps[8], [1000, false, 6000]);
  assert.deepEqual(caps[9], [1001, true, 2000]);
  if (caps[11]) assert.deepEqual(caps[11], [4000, true, 2000]);
});

test('flow stage 1 counts only credentials with an output at or before the snapshot', async () => {
  const { db, runBlock, rows } = await freshDb();
  await fixture(db, 12);
  // Credentials 13 and 14 exist in stake_address but are first seen after the
  // snapshot (transaction 2, the snapshot being transaction 1); 15 has an
  // output at the snapshot transaction itself.
  for (const i of [13, 14, 15]) {
    const c = credHex(i);
    await db.query(`INSERT INTO study.cred VALUES ($1, decode($2, 'hex'), decode($3, 'hex'), 14, 0, false, NULL, $4)`, [i, 'e0' + c, c, `v${i}`]);
    await db.query(`INSERT INTO public.tx_out (id, tx_id, stake_address_id, payment_cred) VALUES ($1, $2, $1, $3)`, [i, i === 15 ? 1 : 2, payCred(i)]);
  }
  const p = params();
  await runBlock('frame', p);
  await runBlock('txo', p);
  await runBlock('flow', p);
  const [s1] = await rows(`SELECT n_in, n_out FROM study.flow WHERE frame = 'recent' AND stage_no = 1`);
  assert.equal(Number(s1.n_in), 13, 'twelve fixture credentials and the one at the snapshot, not the two after it');
});

// Flow stage 1 reads the life table, which holds exactly the outputs with a
// stake credential up to the snapshot, instead of public.tx_out: the count is
// the one the tx_out predicate gives, with x1_enterprise off and on.
test('flow stage 1 from the life table equals the count from tx_out', async () => {
  for (const x1 of [false, true]) {
    const { db, runBlock, rows } = await freshDb();
    await fixture(db, 12);
    // 13 and 14 first seen after the snapshot; 15 at it; 16 after it, with an
    // enterprise output at its payment credential before it; enterprise
    // outputs at 1's payment credential (owned by 1 alone) and at a payment
    // credential no stake credential owns; 1's outputs also spent, and a
    // second output of 2 after the snapshot.
    for (const i of [13, 14, 15, 16]) {
      const c = credHex(i);
      await db.query(`INSERT INTO study.cred VALUES ($1, decode($2, 'hex'), decode($3, 'hex'), 14, 0, false, NULL, $4)`, [i, 'e0' + c, c, `v${i}`]);
      await db.query(`INSERT INTO public.tx_out (id, tx_id, stake_address_id, payment_cred) VALUES ($1, $2, $1, $3)`, [i, i === 15 ? 1 : 2, payCred(i)]);
    }
    await db.query(`INSERT INTO public.tx_out (id, tx_id, stake_address_id, payment_cred) VALUES (101, 1, NULL, $1), (102, 1, NULL, $2), (103, 1, NULL, $3), (104, 2, 2, $4)`, [payCred(1), payCred(16), payCred(99), payCred(2)]);
    await db.query(`INSERT INTO public.tx_in VALUES (1, 1, 0)`);
    const p = params({ x1_enterprise: x1 });
    await runBlock('frame', p);
    await runBlock('txo', p);
    await runBlock('flow', p);
    const [old] = await rows(`SELECT count(*) AS n FROM study.cred c WHERE EXISTS (SELECT 1 FROM public.tx_out o WHERE o.stake_address_id = c.sa_id AND o.tx_id <= 1)`);
    const [s1] = await rows(`SELECT n_in FROM study.flow WHERE frame = 'recent' AND stage_no = 1`);
    assert.equal(Number(s1.n_in), Number(old.n), `x1_enterprise ${x1}`);
    assert.equal(Number(s1.n_in), 13);
    if (x1) assert.equal(Number((await rows(`SELECT count(*) AS n FROM study.txo WHERE via_payment`))[0].n), 1, 'the enterprise output at 1\'s payment credential is in the life table');
  }
});

// Requirement (d)'s measure in the state step: the most UTxOs one fungible
// asset of the wallet sits on, at each point, held UTxOs always included,
// whatever x9_count_held says of the other measures.
test('state: the most UTxOs a fungible asset sits on, held UTxOs included', async () => {
  for (const x9 of [true, false]) {
    const { db, runBlock, rows } = await freshDb();
    await db.exec(`
      CREATE TABLE study.txo (tx_out_id bigint PRIMARY KEY, created_tx bigint, consumed_tx bigint, sa_id bigint, out_index int, value numeric,
                              payment_cred bytea, script_pay boolean, has_datum boolean, has_ref_script boolean, via_payment boolean);
      CREATE TABLE study.txo_asset (tx_out_id bigint, ident bigint, quantity numeric);
      CREATE TABLE study.asset (ident bigint PRIMARY KEY, policy bytea, name bytea, label integer);
      INSERT INTO study.asset VALUES (1, NULL, NULL, NULL), (2, NULL, NULL, NULL), (3, NULL, NULL, NULL), (4, NULL, NULL, 222), (5, NULL, NULL, NULL);
    `);
    let id = 0;
    const put = async (sa, ident, { created = 1, consumed = null, held = false, qty = 1 } = {}) => {
      id++;
      await db.query(`INSERT INTO study.txo VALUES ($1, $2, $3, $4, 0, 1000000, NULL, false, $5, false, false)`, [id, created, consumed, sa, held]);
      await db.query(`INSERT INTO study.txo_asset VALUES ($1, $2, $3)`, [id, ident, qty]);
    };
    // 1: asset 1 on 10 UTxOs, one of them held. 2: asset 2 on 9. 3: asset 3
    // on 10, five spent before the snapshot, and one unit of a label-222 NFT.
    // 5: asset 5 on two held UTxOs only.
    for (let i = 0; i < 10; i++) await put(1, 1, { held: i === 0 });
    for (let i = 0; i < 9; i++) await put(2, 2);
    for (let i = 0; i < 10; i++) await put(3, 3, { consumed: i < 5 ? 50 : null });
    await put(3, 4);
    await put(5, 5, { held: true });
    await put(5, 5, { held: true });
    const p = sqlParams({ network: 'preprod', settings: { ...defaultSettings(), x9_count_held: x9 }, snapshot: { id: 1, t: 100 }, h: H, windows: { recent: { lo: 1, hi: 100, t_start: 0, first_epoch: 1, last_epoch: 1 }, peak: { lo: 1, hi: 40, t_start: 0, first_epoch: 1, last_epoch: 1 } } });
    await runBlock('state', p);
    const got = Object.fromEntries((await rows(`SELECT point, sa_id, n_assets, max_ft_utxos FROM study.state WHERE point IN ('snap', 'peak_end') ORDER BY point, sa_id`)).map((r) => [`${r.point} ${r.sa_id}`, [Number(r.n_assets), Number(r.max_ft_utxos)]]));
    assert.deepEqual(got, {
      'peak_end 1': [1, 10],
      'peak_end 2': [1, 9],
      'peak_end 3': [2, 10],
      'peak_end 5': [x9 ? 1 : 0, 2],
      'snap 1': [1, 10],
      'snap 2': [1, 9],
      'snap 3': [2, 5],
      'snap 5': [x9 ? 1 : 0, 2]
    }, `x9_count_held ${x9}`);
  }
});
