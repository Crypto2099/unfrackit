// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// T2. Identification: each shape's addresses map, through tx_out.address, to
// one stake_address_id; that credential's view and cred_hash match the bech32
// decoding of the base address (a 57-byte CIP-19 type-0 address: header,
// 28-byte payment key hash, 28-byte stake key hash, the stake hash at bytes
// 29 to 56); one payment credential per shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, SHAPES, FUNDER, seederAddress, record } from './env.mjs';
import { parseAddress, rewardAddressOf } from '../../src/bech32.mjs';

test('T2 shape addresses identify one key-hash stake credential each', async () => {
  const c = await db();
  const out = {};
  try {
    for (const who of [...SHAPES, 'funder']) {
      const addrs = who === 'funder' ? [FUNDER] : seederAddress(who);
      assert.equal(addrs.length, 1, `${who}: one address`);
      const a = parseAddress(addrs[0]);
      assert.equal(a.type, 0, `${who}: CIP-19 type 0`);
      assert.equal(a.network, 0);
      assert.equal(a.bytes.length, 57);
      const r = await c.query(
        `SELECT o.stake_address_id AS sa, sa.view, encode(substring(sa.hash_raw FROM 2 FOR 28), 'hex') AS cred, sa.script_hash IS NOT NULL AS is_script,
                count(*) AS n, count(DISTINCT o.payment_cred) AS n_pay, min(encode(o.payment_cred, 'hex')) AS pay
           FROM public.tx_out o JOIN public.stake_address sa ON sa.id = o.stake_address_id
          WHERE o.address = $1 GROUP BY 1, 2, 3, 4`,
        [addrs[0]]
      );
      assert.equal(r.rows.length, 1, `${who}: one stake_address_id`);
      const row = r.rows[0];
      assert.equal(row.view, rewardAddressOf(addrs[0]).bech, `${who}: view`);
      assert.equal(row.cred, a.stakeHash, `${who}: cred_hash is bytes 29 to 56`);
      assert.equal(row.is_script, false);
      assert.equal(Number(row.n_pay), 1, `${who}: one payment credential`);
      assert.equal(row.pay, a.paymentHash);
      // Every output with that credential is at this one address.
      const all = await c.query('SELECT count(DISTINCT address) AS n FROM public.tx_out WHERE stake_address_id = $1', [row.sa]);
      out[who] = { sa_id: Number(row.sa), view: row.view, outputs: Number(row.n), addresses_with_credential: Number(all.rows[0].n) };
      if (who !== 'funder') assert.equal(Number(all.rows[0].n), 1, `${who}: the credential is used at one address`);
    }
    record('T2', out);
  } finally {
    await c.end();
  }
});
