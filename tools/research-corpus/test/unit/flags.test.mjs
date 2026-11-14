// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Evolution fingerprint (synthetic splits at and just beyond 0.2
// percentage points) and the franken query, each run as its real step on a
// synthetic study.txo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from '../lib/pglite.mjs';
import { defaultSettings, sqlParams } from '../../src/params.mjs';

function params(over = {}) {
  return sqlParams({ network: 'preprod', settings: { ...defaultSettings(), ...over }, snapshot: { id: 1, t: 100000 }, h: '00'.repeat(32), windows: { recent: { lo: 1, hi: 100000, t_start: 0, first_epoch: 1, last_epoch: 1 }, peak: { lo: 1, hi: 100000, t_start: 0, first_epoch: 1, last_epoch: 1 } } });
}

async function txoTables(db, blocks) {
  await db.exec(`
    CREATE TABLE study.txo (tx_out_id bigint PRIMARY KEY, created_tx bigint, consumed_tx bigint, sa_id bigint, out_index smallint, value numeric,
                            payment_cred bytea, script_pay boolean, has_datum boolean, has_ref_script boolean, via_payment boolean);
    CREATE TABLE study.txo_asset (tx_out_id bigint, ident bigint, quantity numeric);
    CREATE TABLE study.sample_wallet (sa_id bigint PRIMARY KEY);
    CREATE TABLE study.unfrackit_tx (tx_id bigint, source text);
  `);
  // study.sample as the draw step declares it, for the flag columns the steps set.
  await db.exec(blocks.get('draw').statements.find((s) => /CREATE TABLE study\.sample \(/.test(s)));
  let id = 0;
  const out = async (o) => {
    id++;
    await db.query('INSERT INTO study.txo VALUES ($1, $2, $3, $4, 0, $5, decode($6, \'hex\'), $7, $8, false, false)', [id, o.created, o.consumed ?? null, o.sa, String(o.value ?? 2000000), o.cred || 'aa'.repeat(28), !!o.script, !!o.datum]);
    if (o.token) await db.query('INSERT INTO study.txo_asset VALUES ($1, 1, 1)', [id]);
    return id;
  };
  return out;
}

test('Evolution fingerprint: exact, at the 0.2-point boundary, and just beyond', async () => {
  const { db, blocks, runBlock, rows } = await freshDb();
  const out = await txoTables(db, blocks);
  await db.query('INSERT INTO study.sample_wallet VALUES (1)');
  const tidy = async (tx, values, opts = {}) => {
    if (!opts.noSpend) await out({ sa: 1, created: 1, consumed: tx, value: 10 });
    for (const v of values) await out({ sa: 1, created: tx, value: v, datum: opts.datumOn === v });
    if (opts.token) await out({ sa: 1, created: tx, value: 1500000, token: true });
  };
  const e = 1000000;
  await tidy(100, [500, 150, 100, 100, 50, 50, 50].map((x) => x * e)); // exact
  await tidy(101, [502, 148, 100, 100, 50, 50, 50].map((x) => x * e)); // first two shares exactly 0.2 points off
  await tidy(102, [502001, 147999, 100000, 100000, 50000, 50000, 50000].map((x) => x * 1000)); // 0.2001 points off
  await tidy(103, [500, 150, 100, 100, 50, 50, 50].map((x) => x * e), { token: true }); // other output beside the seven
  await tidy(104, [500, 150, 100, 100, 50, 50, 50].map((x) => x * e), { noSpend: true }); // spends nothing of the wallet
  await tidy(105, [500, 150, 100, 100, 100, 50].map((x) => x * e)); // six outputs
  await tidy(106, [500, 150, 100, 100, 50, 50, 25, 25].map((x) => x * e)); // eight outputs
  await tidy(107, [500, 150, 100, 100, 50, 51, 49].map((x) => x * e), { datumOn: 51 * e }); // one carries a datum
  await tidy(108, [4980, 1500, 1000, 1000, 521, 500, 499].map((x) => x * e)); // a 5% share 0.21 points off
  await tidy(109, [4980, 1500, 1000, 1000, 520, 500, 500].map((x) => x * e)); // 0.2 points off on two shares
  await runBlock('prior_flags', params());
  const hit = (await rows('SELECT tx FROM study.prior_evolution ORDER BY tx')).map((r) => Number(r.tx));
  assert.deepEqual(hit, [100, 101, 103, 109]);
  await runBlock('prior_flags', params({ x21_others_allowed: false }));
  const strict = (await rows('SELECT tx FROM study.prior_evolution ORDER BY tx')).map((r) => Number(r.tx));
  assert.deepEqual(strict, [100, 101, 109]);
});

test('franken: two credentials co-spend and a third never; one credential; two never co-spending; script credentials (x13_all)', async () => {
  const { db, blocks, runBlock, rows } = await freshDb();
  const out = await txoTables(db, blocks);
  const A = '0a'.repeat(28), B = '0b'.repeat(28), C = '0c'.repeat(28), D = '0d'.repeat(28), E = '0e'.repeat(28), F = '0f'.repeat(28), G = '1a'.repeat(28), Hh = '1b'.repeat(28), S = '5c'.repeat(28);
  await db.exec('INSERT INTO study.sample_wallet VALUES (11), (12), (13), (14)');
  // Wallet 11: A and B co-spend in 200; C is spent alone in 201; A alone in 202.
  await out({ sa: 11, created: 1, consumed: 200, cred: A });
  await out({ sa: 11, created: 1, consumed: 200, cred: B });
  await out({ sa: 11, created: 1, consumed: 201, cred: C });
  await out({ sa: 11, created: 1, consumed: 202, cred: A });
  await out({ sa: 11, created: 202, cred: C });
  // Wallet 12: one credential.
  await out({ sa: 12, created: 1, consumed: 203, cred: D });
  await out({ sa: 12, created: 203, consumed: 204, cred: D });
  // Wallet 13: two credentials that never co-spend.
  await out({ sa: 13, created: 1, consumed: 210, cred: E });
  await out({ sa: 13, created: 1, consumed: 211, cred: F });
  // Wallet 14: G co-spends only with a script credential S; H alone.
  await out({ sa: 14, created: 1, consumed: 220, cred: G });
  await out({ sa: 14, created: 1, consumed: 220, cred: S, script: true });
  await out({ sa: 14, created: 1, consumed: 221, cred: Hh });
  await runBlock('franken', params());
  const flags = async () =>
    Object.fromEntries((await rows(`SELECT sa_id, encode(payment_cred, 'hex') AS c, flagged FROM study.franken`)).map((r) => [`${r.sa_id}:${r.c.slice(0, 2)}`, r.flagged]));
  let f = await flags();
  assert.deepEqual(f, { '11:0a': false, '11:0b': false, '11:0c': true, '12:0d': false, '13:0e': false, '13:0f': false, '14:1a': false, '14:1b': false });
  await runBlock('franken', params({ x13_all: true }));
  f = await flags();
  assert.equal(f['14:1b'], true);
  assert.equal(f['14:1a'], false);
  assert.equal(f['14:5c'], false);
});

test('per-wallet flags on study.sample: each reported count equals the sum of its flag', async () => {
  const { db, blocks, runBlock, rows } = await freshDb();
  const out = await txoTables(db, blocks);
  await runBlock('reconstruction_check_table');
  await db.exec('CREATE TABLE study.sample_frame (frame text, sa_id bigint, lo bigint, hi bigint, PRIMARY KEY (frame, sa_id))');
  const A = '0a'.repeat(28), B = '0b'.repeat(28), C = '0c'.repeat(28), D = '0d'.repeat(28), E = '0e'.repeat(28), F = '0f'.repeat(28);
  const wallets = [21, 22, 23, 24, 25, 26, 27];
  await db.exec(`INSERT INTO study.sample_wallet VALUES ${wallets.map((w) => `(${w})`).join(', ')}`);
  for (const w of wallets) {
    for (const frame of ['recent', 'peak']) {
      if (frame === 'peak' && w === 27) continue; // one wallet in one frame only
      await db.query(`INSERT INTO study.sample (frame, kind, sa_id, draw_rank, size_group, n_utxo_start, n_utxo_ref, n_window_tx, capped, history_hi)
                      VALUES ($1, 'random', $2, $2, 'B0', 1, 1, 1, false, 1)`, [frame, w]);
      await db.query('INSERT INTO study.sample_frame VALUES ($1, $2, 1, 100000)', [frame, w]);
    }
  }
  // 21: A and B co-spend, C never (flagged). 22: E and F never co-spend. 23: one credential.
  // 24: reconstruction-excluded, would be flagged. 25: no credentials in scope. 26, 27: clean multi-credential co-spenders.
  await out({ sa: 21, created: 1, consumed: 200, cred: A });
  await out({ sa: 21, created: 1, consumed: 200, cred: B });
  await out({ sa: 21, created: 1, consumed: 201, cred: C });
  await out({ sa: 22, created: 1, consumed: 210, cred: E });
  await out({ sa: 22, created: 1, consumed: 211, cred: F });
  await out({ sa: 23, created: 1, consumed: 220, cred: D });
  await out({ sa: 24, created: 1, consumed: 230, cred: A });
  await out({ sa: 24, created: 1, consumed: 230, cred: B });
  await out({ sa: 24, created: 1, consumed: 231, cred: C });
  await out({ sa: 26, created: 1, consumed: 240, cred: A });
  await out({ sa: 26, created: 1, consumed: 240, cred: B });
  await out({ sa: 27, created: 1, consumed: 250, cred: A });
  await out({ sa: 27, created: 1, consumed: 250, cred: B });
  // Prior-treated: 21 a UnFrack.It key spend (tx 200), 22 a script-only match, 23 an Evolution split, 26 both, 25 neither.
  await db.exec(`INSERT INTO study.unfrackit_tx VALUES (200, 'json'), (240, 'json'), (212, 'json')`);
  await out({ sa: 22, created: 1, consumed: 212, cred: '5c'.repeat(28), script: true });
  const e = 1000000;
  let tx = 300;
  const tidy = async (sa, cred, values) => {
    await out({ sa, created: 1, consumed: ++tx, value: 10, cred });
    for (const v of values) await out({ sa, created: tx, value: v * e, cred });
  };
  await tidy(23, D, [500, 150, 100, 100, 50, 50, 50]);
  await tidy(26, A, [500, 150, 100, 100, 50, 50, 50]);
  await db.exec(`INSERT INTO study.reconstruction_check VALUES (24, 0, '', 0, '', 0, '', true, false)`);
  await db.exec('UPDATE study.sample s SET reconstruction_excluded = NOT k.agree FROM study.reconstruction_check k WHERE k.sa_id = s.sa_id');
  await runBlock('prior_flags', params());
  await runBlock('franken', params());

  const fr = (await rows(blocks.get('franken_counts').statements[0]))[0];
  const flagSum = async (col) => Number((await rows(`SELECT count(DISTINCT sa_id) AS n FROM study.sample WHERE ${col} AND reconstruction_excluded IS NOT TRUE`))[0].n);
  assert.equal(Number(fr.n_wallets_flagged), 1);
  assert.equal(await flagSum('franken_any'), Number(fr.n_wallets_flagged));
  assert.equal(Number(fr.n_multi_cred_no_cospend), 1);
  assert.equal(await flagSum('franken_no_cospend'), Number(fr.n_multi_cred_no_cospend));
  const prior = await rows(blocks.get('prior_counts').statements[0]);
  assert.equal(prior.length, 2);
  for (const p of prior) {
    const sum = async (col) => Number((await rows(`SELECT count(*) AS n FROM study.sample WHERE frame = $1 AND ${col} AND reconstruction_excluded IS NOT TRUE`, [p.frame]))[0].n);
    assert.equal(await sum('unfrackit_user'), Number(p.unfrackit_any));
    assert.equal(await sum('evolution_tidied'), Number(p.evolution_any));
  }
  const any = prior.find((p) => p.frame === 'recent');
  assert.deepEqual([Number(any.unfrackit_any), Number(any.evolution_any)], [2, 2]);

  // Which wallets carry which flag, and that a wallet carries the same flags on every row.
  const per = Object.fromEntries((await rows(`SELECT sa_id, bool_and(franken_any) AS fa, bool_or(franken_any) AS fo, bool_and(franken_no_cospend) AS na, bool_or(franken_no_cospend) AS no,
                                                    bool_and(prior_treated) AS pa, bool_or(prior_treated) AS po, bool_and(unfrackit_user) AS ua, bool_and(evolution_tidied) AS ea
                                               FROM study.sample GROUP BY sa_id`)).map((r) => [r.sa_id, r]));
  for (const r of Object.values(per)) assert.deepEqual([r.fa, r.na, r.pa], [r.fo, r.no, r.po]);
  const flags = (w) => [per[w].fa, per[w].na, per[w].ua, per[w].ea, per[w].pa];
  assert.deepEqual(flags(21), [true, false, true, false, true]);
  assert.deepEqual(flags(22), [false, true, false, false, false]);
  assert.deepEqual(flags(23), [false, false, false, true, true]);
  assert.deepEqual(flags(25), [false, false, false, false, false]);
  assert.deepEqual(flags(26), [false, false, true, true, true]);
  assert.deepEqual(flags(27), [false, false, false, false, false]);
  assert.deepEqual(flags(24), [true, false, false, false, false]); // flagged but excluded from the counts
});
