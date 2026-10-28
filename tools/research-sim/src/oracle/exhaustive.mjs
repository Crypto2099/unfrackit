// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The exhaustive path: a best-first branch and bound over the subsets of the
// candidate set. Each subset is a node of the usual enumeration tree (a
// node's children add one candidate after its last), and the queue is
// ordered by a lower bound on the fee of every feasible set in the node's
// subtree: the node's own fee bound (bound.mjs boundOf) plus minFeeA times 36
// bytes (the shortest input) for each further input the subtree must add to
// cover what the node still lacks. That count is the least number of
// remaining candidates whose quantities reach the shortfall of a requested
// asset, or whose coin less its own input fee (its effective value, as in
// Erhardt's Branch and Bound) reaches the ADA shortfall, the larger of the
// two, found by taking the largest first. A node whose remaining candidates
// cannot cover a shortfall, or whose bytes would pass the size limit, is
// pruned. A node that meets every necessary condition is evaluated exactly
// when it leaves the queue (the change policy's own transaction, checked by
// the ledger kit), and the search stops at the first node whose bound is at
// or above the best fee found: every set not yet evaluated lies under a node
// still queued, so the best is the optimum over the candidate set.
//
// The search checks its deadline between evaluations; at the deadline it
// returns its best so far, not proven.

import { boundOf, inputBytes, indexOfRef } from './bound.mjs';

const key = (a) => `${a.policy}.${a.name}`;

// A binary heap of nodes by (bound, sequence), so ties keep insertion order.
class Heap {
  constructor() {
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  less(x, y) {
    return x.bound < y.bound || (x.bound === y.bound && x.seq < y.seq);
  }
  push(n) {
    const a = this.a;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

// The least count of items, largest first, whose values reach `need`; null
// when all of them do not.
function leastCount(values, need) {
  if (need <= 0n) return 0;
  const v = values.filter((x) => x > 0n).sort((x, y) => (x > y ? -1 : x < y ? 1 : 0));
  let acc = 0n;
  for (let i = 0; i < v.length; i++) {
    acc += v[i];
    if (acc >= need) return i + 1;
  }
  return null;
}

// model: bound.mjs makeBoundModel; candidates: UTxO records; evaluate(S):
// policies.mjs, resolving to an evaluation; best: the incumbent evaluation or
// null; deadline: a performance.now() time. Resolves to { complete, best,
// nodes, popped, evaluated, pruned }.
export async function exhaustiveSearch({ model: M, candidates, evaluate, best = null, deadline = Infinity, onImprove = () => {} }) {
  const C = candidates;
  const n = C.length;
  if (n > 30) throw new Error(`the exhaustive path takes at most 30 candidates, not ${n}`);
  const eff = C.map((u) => u.coin - M.a * BigInt(inputBytes(indexOfRef(u.ref))));
  const reqKeys = [...M.req.keys()];
  const qty = C.map((u) => {
    const m = new Map();
    for (const x of u.assets) if (M.req.has(key(x))) m.set(key(x), (m.get(key(x)) || 0n) + x.qty);
    return m;
  });
  const minIn = 36n * M.a;
  const stats = { nodes: 0, popped: 0, evaluated: 0, pruned: 0 };
  let seq = 0;

  // The node for set `idx` (candidate indexes, ascending), or null if pruned.
  function node(idx) {
    const S = idx.map((i) => C[i]);
    const bd = boundOf(M, S);
    const last = idx.length ? idx[idx.length - 1] : -1;
    let extra = 0;
    for (const k of reqKeys) {
      let have = 0n;
      for (const i of idx) have += qty[i].get(k) || 0n;
      const short = M.req.get(k) - have;
      if (short > 0n) {
        const vals = [];
        for (let j = last + 1; j < n; j++) vals.push(qty[j].get(k) || 0n);
        const c = leastCount(vals, short);
        if (c === null) return null;
        if (c > extra) extra = c;
      }
    }
    const coinShort = bd.need - bd.coinIn;
    if (coinShort > 0n) {
      const vals = [];
      for (let j = last + 1; j < n; j++) vals.push(eff[j]);
      const c = leastCount(vals, coinShort);
      if (c === null) return null;
      if (c > extra) extra = c;
    }
    if (bd.bytes + 36 * extra > M.maxTxSize) return null;
    const bound = bd.fee + minIn * BigInt(extra);
    return { idx, last, bound, evaluable: extra === 0 && bd.feasible, seq: seq++, lb: bd.fee };
  }

  const heap = new Heap();
  const root = node([]);
  if (root) heap.push(root);
  let complete = true;
  while (heap.size) {
    if (performance.now() >= deadline) {
      complete = false;
      break;
    }
    const nd = heap.pop();
    stats.popped++;
    if (best && nd.bound >= best.fee) break;
    if (nd.evaluable) {
      const ev = await evaluate(nd.idx.map((i) => C[i]));
      stats.evaluated++;
      if (ev.ok && (!best || ev.fee < best.fee)) {
        best = ev;
        onImprove(ev);
      }
    }
    for (let j = nd.last + 1; j < n; j++) {
      const ch = node([...nd.idx, j]);
      if (!ch) {
        stats.pruned++;
        continue;
      }
      if (best && ch.bound >= best.fee) {
        stats.pruned++;
        continue;
      }
      heap.push(ch);
      stats.nodes++;
    }
  }
  return { complete, best, ...stats };
}
