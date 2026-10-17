// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Artifact A1, the corpus source checks (pre-registration section 10.5, and
// section 8, "Indexer correctness"): the db-sync schema version, the node
// version and the sync tip recorded; the UTxO sets of 20 stake credentials
// compared with Koios at the same tip; five compared with the node's UTxO query
// by address at the tip.
//
// Koios and the node move with the chain while the database may be stopped.
// Each set is compared at the database tip T: the database side is the
// reference query at T (db-sync's tables only), the other side is read at its
// own tip, and every transaction touching the credential after T is listed
// through Koios. With none, the sets must be equal; with some, a difference is
// reported as explained only if every differing line belongs to one of those
// transactions.

import { q } from './db.mjs';
import { Koios } from './koios.mjs';
import { fromKoios, fromNode, diff, sortLines } from './canon.mjs';
import { nodeTip, nodeUtxoByAddress } from './nodequery.mjs';

function explained(d, laterTxs) {
  const later = new Set(laterTxs.map((t) => t.tx_hash));
  const all = [...d.onlyA, ...d.onlyB];
  // A line created after T names a later transaction; a line spent after T is
  // in the database set only, and Koios lists its spending transaction.
  return all.length > 0 && laterTxs.length > 0 && d.onlyB.every((l) => later.has(l.split('#')[0]));
}

export async function a1Compare({ client, blocks, network, views, nodeViews = [], node = null, log = () => {} }) {
  const tip = (await q(client, blocks, 'tip_block'))[0];
  const T = { id: Number(tip.id), block_no: Number(tip.block_no), hash: tip.hash, time: tip.time };
  const koios = new Koios(network, { log });
  const kTip0 = await koios.tip();
  const results = [];
  for (const view of views) {
    const s = (await q(client, blocks, 'stake_by_view', { view: { type: 'text', value: view } }))[0];
    if (!s) {
      results.push({ view, error: 'not in the database' });
      continue;
    }
    const dbRows = await q(client, blocks, 'lines_ref', { sa_id: { type: 'int', value: s.sa_id }, block_id: { type: 'int', value: T.id } });
    const dbLines = sortLines(dbRows.map((r) => r.line));
    const kLines = fromKoios(await koios.accountUtxos(view));
    const later = await koios.accountTxsAfter(view, T.block_no);
    const d = diff(dbLines, kLines);
    const equal = d.onlyA.length === 0 && d.onlyB.length === 0;
    const r = {
      view,
      sa_id: Number(s.sa_id),
      n_db: dbLines.length,
      n_koios: kLines.length,
      later_txs: later.map((t) => ({ tx_hash: t.tx_hash, block_height: Number(t.block_height) })),
      koios: { equal, only_db: d.onlyA.length, only_koios: d.onlyB.length, explained_by_later_txs: !equal && explained(d, later), diff_sample: equal ? [] : [...d.onlyA.slice(0, 3), ...d.onlyB.slice(0, 3)] }
    };
    if (node && nodeViews.includes(view)) {
      const addrs = (await q(client, blocks, 'wallet_addresses', { sa_id: { type: 'int', value: s.sa_id } })).map((x) => x.address);
      const merged = {};
      for (const a of addrs) Object.assign(merged, nodeUtxoByAddress(node, a));
      const nLines = fromNode(merged);
      const dn = diff(dbLines, nLines);
      const eq = dn.onlyA.length === 0 && dn.onlyB.length === 0;
      r.node = { addresses: addrs.length, n_node: nLines.length, equal: eq, only_db: dn.onlyA.length, only_node: dn.onlyB.length, explained_by_later_txs: !eq && explained(dn, later), diff_sample: eq ? [] : [...dn.onlyA.slice(0, 3), ...dn.onlyB.slice(0, 3)] };
    }
    results.push(r);
    log(`a1 ${view.slice(0, 20)}...: db ${r.n_db}, koios ${r.n_koios}${r.node ? `, node ${r.node.n_node}` : ''}, later txs ${later.length}`);
  }
  const kTip1 = await koios.tip();
  const out = { db_tip: T, koios_tip_before: kTip0, koios_tip_after: kTip1, koios_requests: koios.requests, results };
  if (node) out.node_tip = nodeTip(node);
  return out;
}
