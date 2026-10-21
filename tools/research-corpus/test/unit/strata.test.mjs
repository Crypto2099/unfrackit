// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The purposive strata, each run as its real step on synthetic study tables:
// the NFT top ten (running supply, per-wallet class, exclusions, the snapshot
// bound, the tie-break by policy bytes), the holder floor of the fungible
// part (named tokens skipped, the floor, the count of ten, eligible holders at
// the snapshot only, held UTxOs counted), and the fill of every stratum
// (matching rules, skip order, start or end of the peak window, no holders
// giving no stratum).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from '../lib/pglite.mjs';
import { defaultSettings, sqlParams } from '../../src/params.mjs';

const P = (b) => b.repeat(28);
const SNAP = 100;

function params(over = {}) {
  return sqlParams({
    network: 'preprod',
    settings: { ...defaultSettings(), ...over },
    snapshot: { id: 1, t: SNAP },
    h: '00'.repeat(32),
    windows: { recent: { lo: 1, hi: SNAP, t_start: 0, first_epoch: 1, last_epoch: 1 }, peak: { lo: 1, hi: 60, t_start: 50, first_epoch: 1, last_epoch: 1 } }
  });
}

async function tables(db) {
  await db.exec(`
    CREATE TABLE study.frame (frame text, sa_id bigint, eligible boolean);
    CREATE TABLE study.txo (tx_out_id bigint PRIMARY KEY, created_tx bigint, consumed_tx bigint, sa_id bigint, script_pay boolean);
    CREATE TABLE study.txo_asset (tx_out_id bigint, ident bigint, quantity numeric);
    CREATE TABLE study.asset (ident bigint PRIMARY KEY, policy bytea, name bytea, label integer);
    CREATE TABLE public.ma_tx_mint (id serial PRIMARY KEY, ident bigint, quantity numeric, tx_id bigint);
    CREATE TABLE study.draw_order (frame text, sa_id bigint, k bigint);
    CREATE TABLE study.sample (frame text, kind text, stratum text, sa_id bigint, draw_rank bigint, prevalence_member boolean, split text, excluded_6_1 boolean,
                               PRIMARY KEY (frame, kind, stratum, sa_id));
  `);
  let out = 0;
  return {
    eligible: async (ids, eligible = true) => {
      for (const i of ids) await db.query(`INSERT INTO study.frame VALUES ('recent', $1, $2)`, [i, eligible]);
    },
    asset: (ident, policy, name) => db.query(`INSERT INTO study.asset SELECT $1::bigint, decode($2, 'hex'), decode($3, 'hex'), study.cip67_label(decode($3, 'hex'))`, [ident, policy, name]),
    mint: (ident, qty, tx) => db.query(`INSERT INTO public.ma_tx_mint (ident, quantity, tx_id) VALUES ($1, $2, $3)`, [ident, qty, tx]),
    hold: async (sa, ident, qty = 1, { created = 1, consumed = null, script = false } = {}) => {
      out++;
      await db.query(`INSERT INTO study.txo VALUES ($1, $2, $3, $4, $5)`, [out, created, consumed, sa, script]);
      await db.query(`INSERT INTO study.txo_asset VALUES ($1, $2, $3)`, [out, ident, qty]);
    }
  };
}

async function loadList(db, named, candidates = []) {
  const { blocks } = await import('../../src/sqlfile.mjs').then((m) => ({ blocks: m.loadAll() }));
  await db.query(blocks.get('strata_list_load').statements[0], [JSON.stringify(named)]);
  await db.query(blocks.get('strata_candidate_load').statements[0], [JSON.stringify(candidates)]);
}

test('NFT top ten: running supply, per-wallet class, exclusions, snapshot bound, tie-break by policy bytes', async () => {
  const { db, runBlock, rows } = await freshDb();
  const f = await tables(db);
  await f.eligible([...Array(17).keys()].map((i) => i + 1));
  await f.eligible([30], false);
  const nft = async (ident, policy, name, holder, opts) => {
    await f.asset(ident, policy, name);
    await f.mint(ident, 1, 1);
    if (holder) await f.hold(holder, ident, 1, opts);
  };
  // P1: three NFTs, three holders. A later asset re-minted to two units after
  // the snapshot does not count.
  await nft(101, P('11'), '01', 1);
  await nft(102, P('11'), '02', 2);
  await nft(103, P('11'), '03', 3);
  await f.asset(104, P('11'), '04');
  await f.mint(104, 1, 150);
  await f.mint(104, 1, 160);
  // P2: an asset burned and minted again (a CIP-25 re-mint) stays an NFT; two holders.
  await f.asset(201, P('22'), '01');
  await f.mint(201, 1, 1);
  await f.mint(201, -1, 5);
  await f.mint(201, 1, 9);
  await f.hold(4, 201);
  await nft(202, P('22'), '02', 5);
  // P3: an asset once outstanding in two units (minted twice, then one burned,
  // net supply 1) makes the policy not an NFT policy, though it has four holders.
  await f.asset(301, P('33'), '01');
  await f.mint(301, 1, 1);
  await f.mint(301, 1, 2);
  await f.mint(301, -1, 3);
  await f.hold(6, 301);
  await nft(302, P('33'), '02', 7);
  await nft(303, P('33'), '03', 8);
  await nft(304, P('33'), '04', 9);
  // P4: a fungible token held as one unit by two wallets (the per-wallet
  // class alone would call it an NFT).
  await f.asset(401, P('44'), '01');
  await f.mint(401, 1000, 1);
  await f.hold(10, 401);
  await f.hold(11, 401);
  // P5: a named policy, excluded from the ranking.
  for (let i = 1; i <= 5; i++) await nft(500 + i, P('55'), `0${i}`, i);
  // P6, P7: two holders each, ties with P2, broken by policy bytes (07 < 22 < 66).
  await nft(601, P('66'), '01', 12);
  await nft(602, P('66'), '02', 13);
  await nft(603, P('66'), '03', 30); // ineligible holder
  await nft(701, P('07'), '01', 14);
  await nft(702, P('07'), '02', 15, { script: true }); // a held UTxO counts
  await nft(703, P('07'), '03', 16, { created: 1, consumed: 50 }); // spent before the snapshot
  // P8: a label-333 asset of supply one is fungible by its label; a label-222
  // asset of the same policy is not. One holder counted.
  await nft(801, P('88'), '0014df10aa', 16);
  await nft(802, P('88'), '000de140bb', 17);
  await runBlock('strata_list_table');
  await loadList(db, [{ ord: 1, stratum: 'Named', project: 'Named', class: 'NFT', policy: P('55'), asset_name: null, nft_top_exclude: true }]);
  await runBlock('nft_top', params({ nft_top_n: 4 }));
  const top = (await rows(`SELECT encode(policy, 'hex') AS p, n_holders, rank FROM study.nft_top ORDER BY rank`)).map((r) => [r.p.slice(0, 2), Number(r.n_holders), Number(r.rank)]);
  assert.deepEqual(top, [['11', 3, 1], ['07', 2, 2], ['22', 2, 3], ['66', 2, 4]]);
  await runBlock('nft_top', params({ nft_top_n: 10 }));
  const all = (await rows(`SELECT encode(policy, 'hex') AS p, n_holders FROM study.nft_top ORDER BY rank`)).map((r) => [r.p.slice(0, 2), Number(r.n_holders)]);
  assert.deepEqual(all, [['11', 3], ['07', 2], ['22', 2], ['66', 2], ['88', 1]]);
});

test('fungible floor: named skipped, floor, ten taken in rank order, eligible holders at the snapshot, held UTxOs counted', async () => {
  const { db, runBlock, rows } = await freshDb();
  const f = await tables(db);
  await f.eligible([...Array(10).keys()].map((i) => i + 1));
  await f.eligible([20], false);
  const ft = async (ident, policy, name) => {
    await f.asset(ident, policy, name);
    await f.mint(ident, 1000000, 1);
  };
  await ft(1, P('aa'), '01'); // named
  await ft(11, P('11'), '01');
  await ft(33, P('33'), '03');
  await ft(44, P('44'), '04');
  await ft(55, P('55'), '05');
  for (const w of [1, 2, 3, 4, 5]) await f.hold(w, 1, 10);
  for (const w of [1, 2, 3]) await f.hold(w, 11, 10);
  await f.hold(4, 33, 10);
  await f.hold(20, 33, 10); // ineligible
  await f.hold(5, 33, 10, { consumed: 50 }); // spent before the snapshot
  await f.hold(6, 33, 10, { created: 120 }); // created after the snapshot
  await f.hold(5, 44, 10, { script: true }); // held UTxO
  await f.hold(6, 44, 10);
  for (const w of [7, 8, 9, 10]) await f.hold(w, 55, 10);
  await runBlock('strata_list_table');
  await loadList(
    db,
    [{ ord: 1, stratum: 'Named FT', project: 'Named FT', class: 'FT', policy: P('aa'), asset_name: '01', nft_top_exclude: false }],
    [
      { rank: 1, stratum: 'c1', project: 'c1', policy: P('11'), asset_name: '01' },
      { rank: 2, stratum: 'named again', project: 'named again', policy: P('aa'), asset_name: '01' },
      { rank: 3, stratum: 'c3', project: 'c3', policy: P('33'), asset_name: '03' },
      { rank: 4, stratum: 'c4', project: 'c4', policy: P('44'), asset_name: '04' },
      { rank: 5, stratum: 'c5', project: 'c5', policy: P('55'), asset_name: '05' }
    ]
  );
  await runBlock('ft_floor', params({ ft_floor: 2, ft_n: 2 }));
  const got = (await rows(`SELECT rank, named, n_holders, qualifies, taken FROM study.ft_floor ORDER BY rank`)).map((r) => [Number(r.rank), r.named, Number(r.n_holders), r.qualifies, r.taken]);
  assert.deepEqual(got, [
    [1, false, 3, true, true],
    [2, true, 0, false, false],
    [3, false, 1, false, false],
    [4, false, 2, true, true],
    [5, false, 4, true, false]
  ]);
  await runBlock('ft_floor', params({ ft_floor: 2, ft_n: 10 }));
  assert.deepEqual((await rows(`SELECT rank FROM study.ft_floor WHERE taken ORDER BY rank`)).map((r) => Number(r.rank)), [1, 4, 5]);
});

// An independent statement of the fill rule, to compare the SQL with.
function expectedFill({ strata, holdings, order, random, n, skipRandomOnly, points }) {
  const out = [];
  for (const s of strata) {
    const holders = new Set(holdings.filter((h) => s.match(h) && points.some((t) => h.created <= t && (h.consumed === null || h.consumed > t))).map((h) => h.sa));
    const taken = new Set(out.filter((x) => !skipRandomOnly).map((x) => x.sa));
    for (const r of random) taken.add(r);
    const chosen = order.filter((sa) => holders.has(sa) && !taken.has(sa)).slice(0, n);
    for (const sa of chosen) out.push({ stratum: s.name, sa });
  }
  return out;
}

test('strata fill: matching rules, skip order, start or end of the peak window, no holders giving no stratum', async () => {
  for (const skipRandomOnly of [false, true]) {
    const { db, runBlock, rows } = await freshDb();
    const f = await tables(db);
    await runBlock('strata_fn');
    const holdings = [];
    const ident = new Map();
    let next = 1;
    const hold = async (sa, policy, name, { created = 1, consumed = null } = {}) => {
      const key = policy + name;
      if (!ident.has(key)) {
        ident.set(key, next);
        await f.asset(next++, policy, name);
      }
      await f.hold(sa, ident.get(key), 1, { created, consumed });
      holdings.push({ sa, policy, name, created, consumed });
    };
    for (const sa of [1, 2, 3]) await hold(sa, P('aa'), '01');
    await hold(12, P('aa'), '01', { created: 70 }); // after the peak window, before the snapshot
    await hold(4, P('aa'), '09'); // another asset of the named FT's policy
    await hold(2, P('bb'), '01');
    await hold(5, P('bb'), '02');
    await hold(6, P('cc'), '02');
    await hold(7, P('cc'), '02');
    await hold(13, P('cc'), '02', { created: 10, consumed: 55 }); // at the peak window's start only
    await hold(8, P('dd'), '03');
    await hold(9, P('ee'), '0014df1001'); // label 333: not what the NFT ranking counted
    await hold(10, P('ee'), '000de14001');
    await hold(11, P('ee'), '01');
    // Draw order: a fixed permutation, the same in both frames.
    const order = [11, 3, 7, 13, 2, 9, 12, 5, 1, 6, 10, 4, 8];
    for (const frame of ['recent', 'peak']) {
      for (let i = 0; i < order.length; i++) await db.query(`INSERT INTO study.draw_order VALUES ($1, $2, $3)`, [frame, order[i], i + 1]);
      await db.query(`INSERT INTO study.sample VALUES ($1, 'random', '', 3, 2, true, NULL, NULL)`, [frame]);
    }
    await runBlock('strata_list_table');
    await loadList(db, [
      { ord: 1, stratum: 'Named FT', project: 'n', class: 'FT', policy: P('aa'), asset_name: '01', nft_top_exclude: false },
      { ord: 2, stratum: 'Named NFT', project: 'n', class: 'NFT', policy: P('bb'), asset_name: null, nft_top_exclude: true }
    ]);
    await db.exec(`CREATE TABLE study.ft_floor (rank integer, stratum text, project text, policy bytea, asset_name bytea, named boolean, n_holders bigint, qualifies boolean, taken boolean);
                   CREATE TABLE study.nft_top (policy bytea, n_holders bigint, rank bigint);`);
    await db.query(`INSERT INTO study.ft_floor VALUES (1, 'Cand A', 'a', decode($1, 'hex'), decode('02', 'hex'), false, 2, true, true),
                                                       (2, 'Cand B', 'b', decode($2, 'hex'), decode('03', 'hex'), false, 1, false, false)`, [P('cc'), P('dd')]);
    await db.query(`INSERT INTO study.nft_top VALUES (decode($1, 'hex'), 3, 1)`, [P('ee')]);
    await runBlock('strata', params({ strata_n: 2, x10_skip_random_only: skipRandomOnly }));
    const strata = [
      { name: 'Named FT', match: (h) => h.policy === P('aa') && h.name === '01' },
      { name: 'Named NFT', match: (h) => h.policy === P('bb') },
      { name: 'Cand A', match: (h) => h.policy === P('cc') && h.name === '02' },
      { name: 'nft-top-01', match: (h) => h.policy === P('ee') && !/^(0014df1|001bc28)/.test(h.name) }
    ];
    for (const [frame, points] of [['recent', [SNAP]], ['peak', [50, 60]]]) {
      const want = expectedFill({ strata, holdings, order, random: [3], n: 2, skipRandomOnly, points });
      const got = (await rows(`SELECT s.stratum, s.sa_id FROM study.sample s JOIN study.strata_all a ON a.stratum = s.stratum
                                WHERE s.frame = $1 AND s.kind = 'stratum' ORDER BY a.ord, s.draw_rank`, [frame])).map((r) => ({ stratum: r.stratum, sa: Number(r.sa_id) }));
      assert.deepEqual(got, want, `${frame}, skip random only ${skipRandomOnly}`);
      assert.ok(!got.some((x) => x.stratum === 'Cand B'), 'a candidate not taken gives no stratum');
      assert.ok(!got.some((x) => x.sa === 9), 'a label-333 holder is not in an nft-top stratum');
    }
    const parts = (await rows(`SELECT stratum, part, ord FROM study.strata_all ORDER BY ord`)).map((r) => [r.stratum, r.part]);
    assert.deepEqual(parts, [['Named FT', 'named'], ['Named NFT', 'named'], ['Cand A', 'coingecko'], ['nft-top-01', 'nft-top']]);
  }
});
