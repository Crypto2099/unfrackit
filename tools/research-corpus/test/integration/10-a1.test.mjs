// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// T4. Current state against Koios account_utxos and against the node's
// `query utxo` for every address of each shape: the A1 rehearsal. Twenty
// credentials (the three shapes, the funder, and the first sixteen others in
// the recent frame's draw order) are compared with Koios at the database tip;
// five (the shapes, the funder and the first in draw order) with the node.
// Koios is the preprod public tier with no token, requests 150 ms apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, blocks, record, RUN_B, SHAPES, FUNDER, seederAddress, stakeOf } from './env.mjs';
import { a1Compare } from '../../src/a1.mjs';

test('T4 A1 rehearsal: Koios and the node agree with db-sync at its tip', { timeout: 3600 * 1000 }, async () => {
  const c = await db();
  try {
    const fixed = [...SHAPES.map((s) => stakeOf(seederAddress(s)[0])), stakeOf(FUNDER)];
    const drawn = (await c.query(`SELECT c.view FROM study.draw_order d JOIN study.cred c USING (sa_id)
                                   WHERE d.frame = 'recent' AND NOT (c.view = ANY($1)) ORDER BY d.k LIMIT 16`, [fixed])).rows.map((r) => r.view);
    const views = [...fixed, ...drawn];
    const nodeViews = [...fixed, drawn[0]];
    const container = process.env.RESEARCH_CORPUS_NODE_CONTAINER;
    if (!container) throw new Error('set RESEARCH_CORPUS_NODE_CONTAINER');
    const r = await a1Compare({ client: c, blocks, network: 'preprod', views, nodeViews, node: { container, socket: '/ipc/node.socket', magic: '1' }, log: (s) => process.stderr.write(`  ${s}\n`) });
    const summary = r.results.map((x) => ({
      view: x.view,
      n_db: x.n_db,
      n_koios: x.n_koios,
      later_txs: x.later_txs.length,
      koios_equal: x.koios.equal,
      koios_explained: x.koios.explained_by_later_txs,
      node: x.node ? { n: x.node.n_node, equal: x.node.equal, explained: x.node.explained_by_later_txs, addresses: x.node.addresses } : null
    }));
    record('T4', { run: RUN_B, db_tip: r.db_tip, koios_tip_before: r.koios_tip_before, koios_tip_after: r.koios_tip_after, node_tip: r.node_tip, koios_requests: r.koios_requests, results: summary, differences: r.results.filter((x) => !x.koios.equal || (x.node && !x.node.equal)) });
    assert.equal(r.results.length, 20);
    assert.equal(r.results.filter((x) => x.node).length, 5);
    for (const x of r.results) {
      assert.ok(!x.error, `${x.view}: ${x.error}`);
      if (x.later_txs.length === 0) assert.equal(x.koios.equal, true, `${x.view}: Koios differs with no later transaction`);
      else assert.ok(x.koios.equal || x.koios.explained_by_later_txs, `${x.view}: Koios difference not explained by later transactions`);
      if (x.node) {
        if (x.later_txs.length === 0) assert.equal(x.node.equal, true, `${x.view}: node differs with no later transaction`);
        else assert.ok(x.node.equal || x.node.explained_by_later_txs, `${x.view}: node difference not explained`);
      }
    }
  } finally {
    await c.end();
  }
});
