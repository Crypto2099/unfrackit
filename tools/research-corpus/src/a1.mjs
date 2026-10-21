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
// through Koios. With none, the sets must be equal. With some, a difference is
// explained only if every line found only on the other side was created by one
// of those transactions, and every line found only in the database is an
// input that one of those transactions spends (Koios tx_info inputs).
//
// Pointer addresses (CIP-19 header types 4 and 5) are left out of the node
// comparison on both sides: db-sync attributes pointer outputs to the stake
// credential before Conway and not after (Era/Universal/Insert/Other.hs), while
// the node's query by address returns them all. The count left out is
// reported.

import { q } from './db.mjs';
import { Koios } from './koios.mjs';
import { fromKoios, fromNode, diff, sortLines } from './canon.mjs';
import { nodeTip, nodeUtxoByAddress } from './nodequery.mjs';

// d.onlyA: lines in the database only; d.onlyB: lines on the other side only.
// spent: the set of "<tx hash>#<index>" inputs of the later transactions.
export function explained(d, laterTxs, spent) {
  const later = new Set(laterTxs.map((t) => t.tx_hash));
  const ref = (l) => l.split(':')[0];
  if (d.onlyA.length + d.onlyB.length === 0 || laterTxs.length === 0) return false;
  return d.onlyB.every((l) => later.has(l.split('#')[0])) && d.onlyA.every((l) => spent.has(ref(l)));
}

// CIP-19 header types 4 and 5 (pointer delegation part), from the bech32 text:
// the first data character encodes the header's type and the network tag's
// high bit, which is 0 on both networks, so types 4 and 5 read g and 2.
export const isPointerAddress = (a) => /^addr(_test)?1[g2]/.test(a);

async function spentInputs(koios, laterTxs) {
  const spent = new Set();
  const hashes = [...new Set(laterTxs.map((t) => t.tx_hash))];
  for (let i = 0; i < hashes.length; i += 50) {
    for (const tx of await koios.txInfo(hashes.slice(i, i + 50))) {
      for (const inp of tx.inputs || []) spent.add(`${inp.tx_hash}#${Number(inp.tx_index)}`);
    }
  }
  return spent;
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
    const spent = later.length ? await spentInputs(koios, later) : new Set();
    const d = diff(dbLines, kLines);
    const equal = d.onlyA.length === 0 && d.onlyB.length === 0;
    const r = {
      view,
      sa_id: Number(s.sa_id),
      n_db: dbLines.length,
      n_koios: kLines.length,
      later_txs: later.map((t) => ({ tx_hash: t.tx_hash, block_height: Number(t.block_height) })),
      koios: { equal, only_db: d.onlyA.length, only_koios: d.onlyB.length, explained_by_later_txs: !equal && explained(d, later, spent), diff_sample: equal ? [] : [...d.onlyA.slice(0, 3), ...d.onlyB.slice(0, 3)] }
    };
    if (node && nodeViews.includes(view)) {
      const all = (await q(client, blocks, 'wallet_addresses', { sa_id: { type: 'int', value: s.sa_id } })).map((x) => x.address);
      const addrs = all.filter((a) => !isPointerAddress(a));
      const merged = {};
      for (const a of addrs) Object.assign(merged, nodeUtxoByAddress(node, a));
      const nLines = fromNode(merged);
      const dbNodeLines = sortLines(dbRows.filter((x) => !isPointerAddress(x.address)).map((x) => x.line));
      const dn = diff(dbNodeLines, nLines);
      const eq = dn.onlyA.length === 0 && dn.onlyB.length === 0;
      r.node = { addresses: addrs.length, pointer_addresses_left_out: all.length - addrs.length, n_db: dbNodeLines.length, n_node: nLines.length, equal: eq, only_db: dn.onlyA.length, only_node: dn.onlyB.length, explained_by_later_txs: !eq && explained(dn, later, spent), diff_sample: eq ? [] : [...dn.onlyA.slice(0, 3), ...dn.onlyB.slice(0, 3)] };
    }
    results.push(r);
    log(`a1 ${view.slice(0, 20)}...: db ${r.n_db}, koios ${r.n_koios}${r.node ? `, node ${r.node.n_node}` : ''}, later txs ${later.length}`);
  }
  const kTip1 = await koios.tip();
  const out = { db_tip: T, koios_tip_before: kTip0, koios_tip_after: kTip1, koios_requests: koios.requests, results };
  if (node) out.node_tip = nodeTip(node);
  return out;
}
