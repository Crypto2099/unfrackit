// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The canonical UTxO line built in SQL (lines_life, digest_life) equals the
// line built in Node from Koios and node-query shapes, so set comparisons
// across sources are exact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { freshDb, int } from '../lib/pglite.mjs';
import { line, fromKoios, fromNode, sortLines } from '../../src/canon.mjs';

const P1 = 'ff'.repeat(28);
const P0 = '01'.repeat(28);
const TX = 'ab'.repeat(32);

test('SQL lines and digests equal the Node canonical form', async () => {
  const { db, rows } = await freshDb();
  await db.exec(`
    CREATE TABLE public.tx (id bigint PRIMARY KEY, hash bytea);
    CREATE TABLE public.tx_out (id bigint PRIMARY KEY, address text);
    CREATE TABLE study.txo (tx_out_id bigint PRIMARY KEY, created_tx bigint, consumed_tx bigint, sa_id bigint, out_index smallint, value numeric,
                            payment_cred bytea, script_pay boolean, has_datum boolean, has_ref_script boolean, via_payment boolean);
    CREATE TABLE study.txo_asset (tx_out_id bigint, ident bigint, quantity numeric);
    CREATE TABLE study.asset (ident bigint PRIMARY KEY, policy bytea, name bytea, label integer);
  `);
  await db.query(`INSERT INTO public.tx VALUES (1, decode($1, 'hex'))`, [TX]);
  await db.exec(`INSERT INTO public.tx_out VALUES (10, 'addr_test1x'), (11, 'addr_test1x'), (12, 'addr_test1x')`);
  await db.exec(`INSERT INTO study.txo VALUES (10, 1, NULL, 7, 0, 1500000, NULL, false, false, false, false),
                                             (11, 1, NULL, 7, 1, 2000000, NULL, false, false, false, false),
                                             (12, 1, NULL, 7, 2, 3000000, NULL, false, false, false, false)`);
  await db.query(`INSERT INTO study.asset VALUES (1, decode($1, 'hex'), decode('62', 'hex'), NULL), (2, decode($1, 'hex'), decode('61', 'hex'), NULL),
                                                 (3, decode($2, 'hex'), decode('6161', 'hex'), NULL), (4, decode($2, 'hex'), '', NULL)`, [P1, P0]);
  await db.exec(`INSERT INTO study.txo_asset VALUES (10, 1, 5), (10, 2, 1), (10, 3, 18446744073709551615), (11, 4, 2)`);
  const fill = await import('../../src/sqlfile.mjs');
  const blocks = fill.loadAll();
  const sqlLines = (await rows(fill.fill(blocks.get('lines_life').statements[0], { sa_id: int(7), t: int(1) }))).map((r) => r.line);
  const expected = sortLines([
    line(TX, 0, 1500000, [{ policy: P1, name: '62', qty: 5 }, { policy: P1, name: '61', qty: 1 }, { policy: P0, name: '6161', qty: '18446744073709551615' }]),
    line(TX, 1, 2000000, [{ policy: P0, name: '', qty: 2 }]),
    line(TX, 2, 3000000, [])
  ]);
  assert.deepEqual(sqlLines, expected);
  assert.equal(expected[0], `${TX}#0:1500000:${P0}.6161=18446744073709551615,${P1}.61=1,${P1}.62=5`);
  const d = (await rows(fill.fill(blocks.get('digest_life').statements[0], { sa_ids: { type: 'intarr', value: [7, 8] }, t: int(1) })))
    .sort((a, b) => Number(a.sa_id) - Number(b.sa_id));
  assert.equal(Number(d[0].n), 3);
  assert.equal(d[0].digest, createHash('md5').update(expected.join('\n')).digest('hex'));
  assert.equal(Number(d[1].n), 0, 'a wallet with no UTxOs gives an empty set');
  assert.equal(d[1].digest, createHash('md5').update('').digest('hex'));

  // The same set from a Koios account_utxos shape and a node query shape.
  const koios = [
    { tx_hash: TX, tx_index: 2, value: '3000000', asset_list: [] },
    { tx_hash: TX, tx_index: 1, value: '2000000', asset_list: [{ policy_id: P0, asset_name: '', quantity: '2' }] },
    { tx_hash: TX, tx_index: 0, value: '1500000', asset_list: [{ policy_id: P1, asset_name: '62', quantity: '5' }, { policy_id: P0, asset_name: '6161', quantity: '18446744073709551615' }, { policy_id: P1, asset_name: '61', quantity: '1' }] },
    { tx_hash: TX, tx_index: 3, value: '1', asset_list: [], is_spent: true }
  ];
  assert.deepEqual(fromKoios(koios), expected);
  const node = {
    [`${TX}#0`]: { address: 'addr_test1x', value: { lovelace: 1500000, [P1]: { '61': 1, '62': 5 }, [P0]: { '6161': 18446744073709551615n } } },
    [`${TX}#1`]: { address: 'addr_test1x', value: { lovelace: 2000000, [P0]: { '': 2 } } },
    [`${TX}#2`]: { address: 'addr_test1x', value: { lovelace: 3000000 } }
  };
  assert.deepEqual(fromNode(node), expected);
});
