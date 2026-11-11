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

async function txoTables(db) {
  await db.exec(`
    CREATE TABLE study.txo (tx_out_id bigint PRIMARY KEY, created_tx bigint, consumed_tx bigint, sa_id bigint, out_index smallint, value numeric,
                            payment_cred bytea, script_pay boolean, has_datum boolean, has_ref_script boolean, via_payment boolean);
    CREATE TABLE study.txo_asset (tx_out_id bigint, ident bigint, quantity numeric);
    CREATE TABLE study.sample_wallet (sa_id bigint PRIMARY KEY);
    CREATE TABLE study.unfrackit_tx (tx_id bigint, source text);
  `);
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
  const { db, runBlock, rows } = await freshDb();
  const out = await txoTables(db);
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
  const { db, runBlock, rows } = await freshDb();
  const out = await txoTables(db);
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
