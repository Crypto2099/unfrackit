// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// "The balance suffices" for a spend, the exact test of the H-12 rule, which
// the batteries use for every method as their infeasible-by-balance rule
// (setting infeasible 'exact'). It holds when:
//   - the wallet holds every requested asset in spendable UTxOs;
//   - the coin of its spendable UTxOs is at least the requested outputs'
//     coin, plus the minimum coin of the tokens it keeps after the spend
//     packed by the planner by bytes alone with classes mixed (its maxUnlock
//     and maxUnlockMixClasses settings), plus the fee of one transaction of
//     the largest size, minFeeA * maxTxSize + minFeeB; and
//   - the requested outputs fit one transaction, by the selector's own test:
//     the requested outputs with one input fit under maxTxSize.
// It is evaluated once per wallet and spend on the observed layout, so that
// every method is scored on the same spends. Every size and minimum comes from
// the treatment's own functions (planner2.mjs packByRules, classifyAssets and
// sizeFormula, select2.mjs NO_AUX, the adapters' describe and paymentOutput).

import { treatmentParams } from '../treatment/bridge.mjs';
import { adapterFor } from '../treatment/wallet.mjs';
import { spendable } from '../state/state.mjs';
import { maxFee } from '../kit/fee.mjs';

const key = (a) => `${a.policy}.${a.name}`;
export const selectAdapterFor = (T, state, tp) => adapterFor(T, state.changeAddress, tp, 'select');

// settings: the planner settings the packing starts from (the defaults in
// the study), with maxUnlock and maxUnlockMixClasses set on top.
export function balanceSuffices(T, state, params, intent, { settings = {} } = {}) {
  const tp = treatmentParams(T, params);
  const adapter = selectAdapterFor(T, state, tp);
  const left = new Map();
  for (const u of spendable(state)) for (const a of u.assets) {
    const e = left.get(key(a));
    if (e) e.qty += a.qty;
    else left.set(key(a), { policy: a.policy, name: a.name, qty: a.qty });
  }
  let coins = 0n;
  let outBytes = 0;
  for (const o of intent.requested) {
    coins += o.coin;
    outBytes += adapter.paymentOutput(o.address, o.coin, o.assets).outputBytes;
    for (const t of o.assets) {
      const e = left.get(key(t));
      if (!e || e.qty < t.qty) return { suffices: false, assets: false, coin: false, oneTx: null };
      e.qty -= t.qty;
    }
  }
  const classes = T.planner.classifyAssets([...state.utxos.values()]);
  const rest = [...left.values()].filter((t) => t.qty > 0n).sort((a, b) => (key(a) < key(b) ? -1 : 1)).map((t) => ({ ...t, cls: classes.get(key(t)).cls }));
  const ctx = { settings: T.planner.mergeSettings({ ...settings, maxUnlock: true, maxUnlockMixClasses: true }), params: tp, adapter };
  const layoutMin = rest.length ? T.planner.packByRules(rest, ctx.settings, ctx).reduce((s, ts) => s + adapter.describe(ts).coin, 0n) : 0n;
  const have = spendable(state).reduce((s, u) => s + u.coin, 0n);
  const need = coins + layoutMin + maxFee(params);
  const coin = have >= need;
  const oneTx = T.planner.sizeFormula(1, 36, intent.requested.length, outBytes, 0xffffffffn, 1, T.select.NO_AUX) <= tp.maxTxSize;
  return { suffices: coin && oneTx, assets: true, coin, oneTx, have, need };
}
