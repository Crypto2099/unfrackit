// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// T11. Classifiers: preprod's label-674 messages containing "unfrack.it",
// found by the run's unfrackit_tx step, reported with their dates; the
// seeder's transactions carry no metadata and must not match. Also the
// Evolution fingerprints the run found among sampled wallets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, blocks, record, RUN_B, SHAPES, seederAddress, stakeOf, saIdOf } from './env.mjs';
import { q } from '../../src/db.mjs';
import { history } from '../lib/history.mjs';

test('T11 UnFrack.It messages on preprod; seeder transactions do not match', async () => {
  const c = await db();
  try {
    const snap = (await c.query(`SELECT value FROM study.param WHERE run_id = $1 AND key = 'snapshot'`, [RUN_B])).rows[0].value;
    const rep = (await q(c, blocks, 'unfrackit_report', { snap_tx: { type: 'int', value: snap.t } }))[0];
    const matches = await q(c, blocks, 'unfrackit_matches');
    const messages = {};
    for (const m of matches) messages[m.json] = (messages[m.json] || 0) + 1;
    const seederTxs = [];
    for (const s of SHAPES) for (const t of await history(c, await saIdOf(c, stakeOf(seederAddress(s)[0])))) seederTxs.push(t.tx);
    const hit = (await c.query('SELECT count(*) AS n FROM study.unfrackit_tx WHERE tx_id = ANY($1)', [seederTxs])).rows[0].n;
    const meta = (await c.query('SELECT count(*) AS n FROM public.tx_metadata WHERE tx_id = ANY($1)', [seederTxs])).rows[0].n;
    assert.equal(Number(hit), 0, 'no seeder transaction matches');
    assert.equal(Number(meta), 0, 'seeder transactions carry no metadata');
    assert.equal(Number(rep.n_match_json) + Number(rep.n_match_bytes), matches.length);
    // The earliest match should not predate the app's first message (v0.0.3, 2023-05-04).
    assert.ok(!rep.earliest_match_time || rep.earliest_match_time >= '2023-05-04');
    const evo = (await c.query(`SELECT p.sa_id, encode(t.hash, 'hex') AS tx, b.time::text AS time
                                 FROM study.prior_evolution p JOIN public.tx t ON t.id = p.tx JOIN public.block b ON b.id = t.block_id
                                 JOIN study.sample_wallet w ON w.sa_id = p.sa_id ORDER BY p.tx`)).rows;
    const uf = (await c.query(`SELECT count(DISTINCT sa_id) AS wallets, count(*) AS txs FROM study.prior_unfrackit p JOIN study.sample_wallet w USING (sa_id)`)).rows[0];
    record('T11', {
      report: rep,
      distinct_messages: messages,
      seeder_transactions: seederTxs.length,
      seeder_matches: Number(hit),
      sampled_unfrackit: { wallets: Number(uf.wallets), txs: Number(uf.txs) },
      evolution: evo
    });
  } finally {
    await c.end();
  }
});
