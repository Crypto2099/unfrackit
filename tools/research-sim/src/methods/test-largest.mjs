// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A small deterministic method used only to test the engine before the
// baseline adapters exist. It is never a baseline and never appears in a
// study run's results.
//
// Inputs: first the spendable UTxOs that hold a requested asset, largest coin
// first, until every requested asset is covered; then the other spendable
// UTxOs, largest coin first, until the change policy can build the spend.
// Ties go to the lower txid#index. Change: the layout-preserving policy
// unless the options name another. The transaction is assembled by the
// ledger kit.

import { buildWithChange } from './change.mjs';
import { spendable, cmpRef } from '../state/state.mjs';
import { CLASSES } from '../kit/check.mjs';
import { NOT_REPLAYABLE } from './contract.mjs';

const key = (a) => `${a.policy}.${a.name}`;
const byCoinDesc = (a, b) => (a.coin > b.coin ? -1 : a.coin < b.coin ? 1 : cmpRef(a.ref, b.ref));

export function testLargestMethod(T) {
  return {
    name: 'test-largest-first',
    version: '1',
    deterministic: true,
    build(state, intent, params, opts) {
      if (intent.fixed || intent.collateral.required) return { ok: false, class: NOT_REPLAYABLE, detail: 'the test method replays no fixed part or script' };
      const policy = opts.changePolicy === 'default' ? 'layout' : opts.changePolicy;
      const spend = spendable(state).slice().sort(byCoinDesc);
      const need = new Map();
      for (const o of intent.requested) for (const a of o.assets) need.set(key(a), (need.get(key(a)) || 0n) + a.qty);
      for (const a of intent.implicit.burn) need.set(key(a), (need.get(key(a)) || 0n) + a.qty);
      for (const a of intent.implicit.mint) need.set(key(a), (need.get(key(a)) || 0n) - a.qty);
      const chosen = [];
      const used = new Set();
      const have = new Map();
      const take = (u) => {
        chosen.push(u);
        used.add(u.ref);
        for (const a of u.assets) have.set(key(a), (have.get(key(a)) || 0n) + a.qty);
      };
      for (const [k, q] of need) {
        for (const u of spend) {
          if ((have.get(k) || 0n) >= q) break;
          if (!used.has(u.ref) && u.assets.some((a) => key(a) === k)) take(u);
        }
        if ((have.get(k) || 0n) < q) return { ok: false, class: CLASSES.balance, detail: `spendable UTxOs hold too little of ${k}` };
      }
      // The kit assembles a candidate only once the inputs' coin covers the
      // requested coin and the smallest fee, and stops once the inputs alone
      // (at least 36 bytes each) would exceed the size limit.
      const reqCoin = intent.requested.reduce((s, o) => s + o.coin, 0n) + intent.implicit.deposits + intent.implicit.donation;
      const floorFee = params.minFeeB;
      let coin = chosen.reduce((s, u) => s + u.coin, 0n);
      const attempt = () => {
        if (chosen.length * 36 > params.maxTxSize) return { ok: false, class: CLASSES.txSize, detail: `${chosen.length} inputs exceed the size limit` };
        if (!chosen.length || coin + intent.implicit.withdrawals + intent.implicit.refunds < reqCoin + floorFee) return { ok: false, class: CLASSES.balance, detail: 'the inputs do not cover the requested coin' };
        return buildWithChange(T, { state, params, inputs: chosen, intent, policy });
      };
      let last = attempt();
      for (const u of spend) {
        if (last.ok) break;
        if (last.class === CLASSES.txSize || last.class === CLASSES.valueSize) break;
        if (used.has(u.ref)) continue;
        take(u);
        coin += u.coin;
        last = attempt();
      }
      if (!last.ok) return { ok: false, class: last.class, detail: last.detail };
      return { ok: true, kind: 'single', txs: [{ bytes: last.bytes, walletInputs: chosen.map((u) => u.ref), fee: last.fee, size: last.size, k: last.k, roles: { inputs: chosen.length } }] };
    }
  };
}
