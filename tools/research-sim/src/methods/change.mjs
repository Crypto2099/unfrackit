// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The change policies the simulator owns, put on a selector's input
// selection in place of the selector's own change (H-9's layout-preserving
// change for the primary selector, and H-11's three strategies). Each is built
// from the treatment's own functions, not reimplemented: asset classes by
// planner2.mjs classifyAssets over the whole wallet (held UTxOs included, as
// the study's classification counts them), token outputs by planner2.mjs
// packByRules at the planner's default settings, and every token output's
// minimum by the adapter's describe (adapter2.mjs), at the change address.
//
//   layout   token change grouped by class and policy under the bundle-size
//            and value caps, each token output at its minimum, the ADA change
//            as one pure-ADA output, never a ladder; ADA left below the
//            pure-ADA minimum stays on the last token change output
//   single   one change output holding every leftover asset and the ADA
//            change; it fails with class value-size when its Value exceeds
//            the limit
//   naive    the naive-tidy control's rule applied to change: every leftover
//            token packed next-fit, classes together, in the order of the
//            inputs (transaction id then index, each input's tokens in policy
//            and name order, a token at its first input) under the count and
//            value caps, each output at its minimum, the ADA change as one
//            pure-ADA output; ADA below the pure-ADA minimum stays on the
//            last token output, as the control's plan leaves it
//
// The change is built from the selector's own inputs. When they cannot fund
// it (the ADA left is negative, or under the minimum with no token output to
// carry it), the spend fails with class change-minimum (setting
// substitutedChange 'fail').
//
// A replayed intent's fixed inputs (non-wallet inputs and the wallet's held
// UTxOs it spends) bring their value into the balance beside the selector's
// inputs, and its transaction is assembled by kit/replay.mjs with the intent's
// fixed parts and, for a script spend, the collateral the engine set aside
// before selection (replay/engine.mjs setAside), which is not in the state the
// selector was given; the asset classes count its tokens with the wallet's.

import { treatmentParams } from '../treatment/bridge.mjs';
import { adapterFor } from '../treatment/wallet.mjs';
import { assembleAtMinimumFee } from '../kit/assemble.mjs';
import { assembleReplayAtMinimumFee, fixedInputValues, setAsideCollateralFor } from '../kit/replay.mjs';
import { CLASSES } from '../kit/check.mjs';
import { cmpRef } from '../state/state.mjs';
import { valueSize } from '../history/value.mjs';

export const CHANGE_POLICIES = Object.freeze(['layout', 'single', 'naive']);

const key = (a) => `${a.policy}.${a.name}`;
const cmpTok = (a, b) => (a.policy < b.policy ? -1 : a.policy > b.policy ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const sum = (xs) => xs.reduce((a, b) => a + b, 0n);


// The leftover tokens after the requested outputs and the implicit mint and
// burn, in the order a policy packs them; null when the inputs lack an asset.
function leftover(inputs, requested, implicit, order) {
  const q = new Map();
  const seen = [];
  for (const u of [...inputs].sort((x, y) => cmpRef(x.ref, y.ref))) {
    for (const a of u.assets) {
      if (!q.has(key(a))) {
        q.set(key(a), { policy: a.policy, name: a.name, qty: 0n });
        seen.push(key(a));
      }
      q.get(key(a)).qty += a.qty;
    }
  }
  for (const a of implicit.mint || []) {
    if (!q.has(key(a))) {
      q.set(key(a), { policy: a.policy, name: a.name, qty: 0n });
      seen.push(key(a));
    }
    q.get(key(a)).qty += BigInt(a.qty);
  }
  for (const a of [...requested.flatMap((o) => o.assets), ...(implicit.burn || [])]) {
    const e = q.get(key(a));
    if (!e) return null;
    e.qty -= BigInt(a.qty);
  }
  for (const e of q.values()) if (e.qty < 0n) return null;
  const list = (order === 'inputs' ? seen.map((k) => q.get(k)) : [...q.values()].sort(cmpTok)).filter((e) => e.qty > 0n);
  return list;
}

// Builds the spend: the given inputs, the intent's requested outputs (their
// address, coin and assets, or for a replayed intent their own bytes), and
// the policy's change. Returns { ok, bytes, fee, size, k, outputs } or
// { ok: false, class, detail }. collateral: the UTxO set aside, for a replayed
// script spend.
export function buildWithChange(T, { state, params, inputs, intent, policy, collateral = null }) {
  if (!CHANGE_POLICIES.includes(policy)) throw new Error(`unknown change policy ${policy}`);
  const tp = treatmentParams(T, params);
  const adapter = adapterFor(T, state.changeAddress, tp, 'plan');
  const implicit = intent.implicit || {};
  const replay = intent.source === 'replay';
  const fixedIns = fixedInputValues(intent);
  const tokens = leftover([...inputs, ...fixedIns], intent.requested, implicit, policy === 'naive' ? 'inputs' : 'policy');
  if (!tokens) return { ok: false, class: CLASSES.balance, detail: 'the inputs do not hold every requested asset' };
  // Classes over the wallet's holding, a minted asset included.
  // A non-wallet fixed input's assets are classified with the wallet's (the
  // wallet's held fixed inputs are already in the state).
  const outside = fixedIns.filter((x) => !state.utxos.has(x.ref)).map((x) => ({ assets: x.assets }));
  const classes = T.planner.classifyAssets([...state.utxos.values(), ...(collateral ? [collateral] : []), { assets: (implicit.mint || []).map((a) => ({ policy: a.policy, name: a.name, qty: BigInt(a.qty) })) }, ...outside]);
  const withCls = tokens.map((t) => ({ ...t, cls: classes.get(key(t)).cls }));
  const settings = T.planner.mergeSettings(policy === 'naive' ? { control: 'naive' } : {});
  const ctx = { settings, params: tp, adapter };
  const change = state.changeAddress;

  let tokenOuts;
  if (policy === 'single') tokenOuts = [];
  else tokenOuts = (withCls.length ? T.planner.packByRules(withCls, settings, ctx) : []).map((ts) => ({ address: change, coin: adapter.describe(ts).coin, assets: ts.map((t) => ({ policy: t.policy, name: t.name, qty: t.qty })).sort(cmpTok) }));

  const requested = intent.requested.map((o) => ({ address: o.address, coin: BigInt(o.coin), assets: o.assets.map((a) => ({ policy: a.policy, name: a.name, qty: BigInt(a.qty) })) }));
  const coinIn = sum(inputs.map((u) => u.coin)) + sum(fixedIns.map((x) => x.coin)) + BigInt(implicit.withdrawals || 0n) + BigInt(implicit.refunds || 0n);
  const coinOut = sum(requested.map((o) => o.coin)) + sum(tokenOuts.map((o) => o.coin)) + BigInt(implicit.deposits || 0n) + BigInt(implicit.donation || 0n);
  const pureMin = adapter.pureAdaMin;

  // The change for a fee, or a failure. A script spend's collateral is not an
  // input and moves no value outside its own return output.
  const changeFor = (fee) => {
    const ada = coinIn - coinOut - fee;
    if (ada < 0n) return { ok: false, class: CLASSES.changeMinimum, detail: `the inputs fall ${-ada} lovelace short of the outputs and the fee` };
    if (policy === 'single') {
      const assets = withCls.map((t) => ({ policy: t.policy, name: t.name, qty: t.qty })).sort(cmpTok);
      if (!assets.length && ada === 0n) return { ok: true, change: [] };
      const d = assets.length ? adapter.describe(assets) : null;
      const min = d ? d.coin : pureMin;
      if (ada < min) return { ok: false, class: CLASSES.changeMinimum, detail: `the single change output's coin ${ada} is under its minimum ${min}` };
      const vb = valueSize(ada, assets);
      if (vb > tp.maxValSize) return { ok: false, class: CLASSES.valueSize, detail: `the single change output's Value is ${vb} bytes, over ${tp.maxValSize}` };
      return { ok: true, change: [{ address: change, coin: ada, assets }] };
    }
    if (ada === 0n) return { ok: true, change: tokenOuts };
    if (ada >= pureMin) return { ok: true, change: [...tokenOuts, { address: change, coin: ada, assets: [] }] };
    if (!tokenOuts.length) return { ok: false, class: CLASSES.changeMinimum, detail: `ADA change ${ada} is under the pure-ADA minimum ${pureMin} and no token output can carry it` };
    const last = tokenOuts[tokenOuts.length - 1];
    return { ok: true, change: [...tokenOuts.slice(0, -1), { ...last, coin: last.coin + ada }] };
  };
  let r;
  if (replay) {
    const collateralFor = setAsideCollateralFor(params, intent, collateral, change);
    r = assembleReplayAtMinimumFee(T, params, { intent, inputs, changeFor, collateralFor, walletCreds: new Set([...state.utxos.values()].map((u) => u.cred)) });
    if (r.ok) r.outputs = [...requested, ...r.change];
  } else {
    const outputsFor = (fee) => {
      const c = changeFor(fee);
      return c.ok ? { ok: true, outputs: [...requested, ...c.change] } : c;
    };
    r = assembleAtMinimumFee(T, params, inputs, outputsFor, { scriptFee: intent.fixed ? intent.fixed.scriptFee || 0n : 0n });
  }
  if (!r.ok) return r;
  if (r.size > params.maxTxSize) return { ok: false, class: CLASSES.txSize, detail: `${r.size} bytes, over ${params.maxTxSize}` };
  return r;
}
