// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// T9. Phase-2-invalid transactions: for five preprod transactions with
// valid_contract false, the tx_in rows are exactly the transaction's
// collateral inputs, the body inputs stay unspent by that transaction, and the
// collateral return is the output at the index equal to the number of body
// outputs.
//
// The ground truth is the transaction's own CBOR: the body's inputs (key 0),
// outputs (key 1), collateral inputs (key 13) and collateral return (key 16),
// from the tx_cbor table and, independently, from Koios tx_cbor, which must
// be the same bytes. Koios tx_info is read too; it is served from db-sync, so
// for an invalid transaction it reports the collateral under `inputs` and the
// return under `outputs`, as db-sync stores them.
//
// Selection, reproducible: the newest two invalid transactions whose return
// sits at index 2, the newest whose return sits at index 3 or more, and the
// newest two with no return output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, record, RUN_B } from './env.mjs';
import { Koios } from '../../src/koios.mjs';
import { txParts } from '../lib/cbor.mjs';

test('T9 phase-2-invalid transactions: collateral as inputs, return at the body output count', { timeout: 600000 }, async () => {
  const c = await db();
  const koios = new Koios('preprod');
  try {
    const snap = (await c.query(`SELECT value FROM study.param WHERE run_id = $1 AND key = 'snapshot'`, [RUN_B])).rows[0].value;
    const pick = (await c.query(
      `WITH inv AS (
         SELECT t.id, encode(t.hash, 'hex') AS hash, (SELECT min(o.index) FROM public.tx_out o WHERE o.tx_id = t.id) AS ret_index
           FROM public.tx t WHERE NOT t.valid_contract AND t.id <= $1)
       (SELECT * FROM inv WHERE ret_index = 2 ORDER BY id DESC LIMIT 2)
       UNION ALL (SELECT * FROM inv WHERE ret_index >= 3 ORDER BY id DESC LIMIT 1)
       UNION ALL (SELECT * FROM inv WHERE ret_index IS NULL ORDER BY id DESC LIMIT 2)`,
      [snap.t]
    )).rows;
    assert.equal(pick.length, 5);
    const total = Number((await c.query('SELECT count(*) AS n FROM public.tx WHERE NOT valid_contract AND id <= $1', [snap.t])).rows[0].n);
    const kCbor = new Map((await koios.request('POST', '/tx_cbor', { _tx_hashes: pick.map((p) => p.hash) })).map((r) => [r.tx_hash, r.cbor]));
    const kInfo = new Map((await koios.txInfo(pick.map((p) => p.hash))).map((r) => [r.tx_hash, r]));
    const out = [];
    for (const p of pick) {
      const id = Number(p.id);
      const local = (await c.query('SELECT bytes FROM public.tx_cbor WHERE tx_id = $1', [id])).rows[0].bytes;
      assert.equal(local.toString('hex'), kCbor.get(p.hash), `${p.hash}: Koios serves the same bytes`);
      const parts = txParts(local);
      assert.equal(parts.isValid, false, `${p.hash}: the CBOR marks it invalid`);
      const dbIn = (await c.query(`SELECT encode(t.hash, 'hex') || '#' || i.tx_out_index AS ref FROM public.tx_in i JOIN public.tx t ON t.id = i.tx_out_id WHERE i.tx_in_id = $1`, [id])).rows.map((r) => r.ref).sort();
      assert.deepEqual(dbIn, [...parts.collateral].sort(), `${p.hash}: tx_in rows are the collateral inputs`);
      const bodyOnly = parts.inputs.filter((x) => !parts.collateral.includes(x));
      for (const ref of bodyOnly) assert.ok(!dbIn.includes(ref), `${p.hash}: body input ${ref} is not spent by this transaction`);
      const laterSpend = [];
      for (const ref of bodyOnly) {
        const [h, ix] = ref.split('#');
        const r = (await c.query(`SELECT encode(st.hash, 'hex') AS by FROM public.tx_in i JOIN public.tx t ON t.id = i.tx_out_id JOIN public.tx st ON st.id = i.tx_in_id WHERE t.hash = decode($1, 'hex') AND i.tx_out_index = $2`, [h, Number(ix)])).rows;
        laterSpend.push({ ref, spent_by: r.length ? r[0].by : null });
        for (const x of r) assert.notEqual(x.by, p.hash);
      }
      const dbOut = (await c.query('SELECT index, value::text AS value FROM public.tx_out WHERE tx_id = $1 ORDER BY index', [id])).rows.map((r) => ({ index: Number(r.index), value: r.value }));
      if (parts.collateralReturnCoin === null) {
        assert.deepEqual(dbOut, [], `${p.hash}: no collateral return, no output`);
      } else {
        assert.deepEqual(dbOut, [{ index: parts.outputs, value: parts.collateralReturnCoin.toString() }], `${p.hash}: the return is the output at index ${parts.outputs}`);
      }
      const info = kInfo.get(p.hash);
      const kIn = info.inputs.map((i) => `${i.tx_hash}#${i.tx_index}`).sort();
      assert.deepEqual(kIn, dbIn, `${p.hash}: Koios tx_info inputs mirror db-sync`);
      assert.deepEqual(info.outputs.map((o) => ({ index: Number(o.tx_index), value: String(o.value) })).sort((a, b) => a.index - b.index), dbOut);
      out.push({
        tx: p.hash,
        body_inputs: parts.inputs.length,
        body_outputs: parts.outputs,
        collateral_inputs: parts.collateral.length,
        body_and_collateral_overlap: parts.inputs.filter((x) => parts.collateral.includes(x)).length,
        collateral_return_coin: parts.collateralReturnCoin === null ? null : parts.collateralReturnCoin.toString(),
        db_tx_in: dbIn.length,
        db_outputs: dbOut,
        koios_collateral_inputs: (info.collateral_inputs || []).length,
        koios_collateral_output: info.collateral_output ? 'present' : null,
        body_inputs_later: laterSpend
      });
    }
    record('T9', { invalid_transactions_up_to_snapshot: total, koios_requests: koios.requests, cases: out });
  } finally {
    await c.end();
  }
});
