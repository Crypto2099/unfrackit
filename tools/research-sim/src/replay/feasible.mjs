// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// "Infeasible by balance" for a replayed intent (setting infeasible 'exact'):
// the H-12 rule's exact test of "the balance suffices" (battery/suffices.mjs)
// with the intent's implicit values and fixed inputs counted. It holds when:
//   - the arm's spendable UTxOs, the intent's fixed inputs and its mints hold
//     every asset the requested outputs and the burns take;
//   - their coin, with the withdrawals and refunds, is at least the requested
//     outputs' coin, the deposits and the donation, plus the minimum coin of
//     the tokens the wallet keeps, packed by the planner by bytes alone with
//     classes mixed, plus the fee of one transaction of the largest size and
//     the intent's script fee; and
//   - the requested outputs fit one transaction: one input, the requested
//     outputs as their own bytes and the intent's fixed bytes under maxTxSize.
// An intent that fails it is recorded as infeasible by balance and is not a
// selector failure; the arm's state is left as it was.

import { treatmentParams } from '../treatment/bridge.mjs';
import { selectAdapterFor } from '../battery/suffices.mjs';
import { spendable } from '../state/state.mjs';
import { maxFee } from '../kit/fee.mjs';
import { fixedInputValues } from '../kit/replay.mjs';

const key = (a) => `${a.policy}.${a.name}`;

export function replaySuffices(T, state, params, intent, { settings = {} } = {}) {
  const tp = treatmentParams(T, params);
  const adapter = selectAdapterFor(T, state, tp);
  const fixedIns = fixedInputValues(intent);
  const fixedRefs = new Set(fixedIns.map((x) => x.ref));
  const own = spendable(state).filter((u) => !fixedRefs.has(u.ref));
  const left = new Map();
  const add = (a) => {
    const e = left.get(key(a));
    if (e) e.qty += BigInt(a.qty);
    else left.set(key(a), { policy: a.policy, name: a.name, qty: BigInt(a.qty) });
  };
  for (const u of own) for (const a of u.assets) add(a);
  for (const x of fixedIns) for (const a of x.assets) add(a);
  for (const a of intent.implicit.mint) add(a);
  const take = [...intent.requested.flatMap((o) => o.assets), ...intent.implicit.burn];
  for (const t of take) {
    const e = left.get(key(t));
    if (!e || e.qty < BigInt(t.qty)) return { suffices: false, assets: false, coin: false, oneTx: null };
    e.qty -= BigInt(t.qty);
  }
  const outside = fixedIns.filter((x) => !state.utxos.has(x.ref)).map((x) => ({ assets: x.assets }));
  const classes = T.planner.classifyAssets([...state.utxos.values(), { assets: intent.implicit.mint }, ...outside]);
  const rest = [...left.values()].filter((t) => t.qty > 0n).sort((a, b) => (key(a) < key(b) ? -1 : 1)).map((t) => ({ ...t, cls: classes.get(key(t)).cls }));
  const ctx = { settings: T.planner.mergeSettings({ ...settings, maxUnlock: true, maxUnlockMixClasses: true }), params: tp, adapter };
  const layoutMin = rest.length ? T.planner.packByRules(rest, ctx.settings, ctx).reduce((s, ts) => s + adapter.describe(ts).coin, 0n) : 0n;
  const imp = intent.implicit;
  const have = own.reduce((s, u) => s + u.coin, 0n) + fixedIns.reduce((s, x) => s + x.coin, 0n) + imp.withdrawals + imp.refunds;
  const scriptFee = intent.fixed ? intent.fixed.scriptFee || 0n : 0n;
  const need = intent.requested.reduce((s, o) => s + o.coin, 0n) + imp.deposits + imp.donation + layoutMin + maxFee(params) + scriptFee;
  const coin = have >= need;
  const outBytes = intent.requested.reduce((s, o) => s + o.cbor.length / 2, 0);
  const fixedBytes = intent.fixed ? intent.fixed.fixedBytes || 0 : 0;
  const oneTx = T.planner.sizeFormula(1, 36, intent.requested.length, outBytes, 0xffffffffn, 1, T.select.NO_AUX) + fixedBytes <= tp.maxTxSize;
  return { suffices: coin && oneTx, assets: true, coin, oneTx, have, need };
}
