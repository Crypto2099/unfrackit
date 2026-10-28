// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The change policies the oracle evaluates, each computed exactly by the
// policy's own code with the candidate set forced as the transaction's inputs
// (setting exactness 'library-forced'), and the evaluation of one candidate
// set: the transaction from the set, the requested outputs and the policy's
// change, with one synthetic vkey witness per distinct key payment credential
// among the inputs, checked by the ledger kit. A set is feasible when that
// transaction passes every check of the kit; its fee is the fee that
// transaction pays (setting setFee 'as-built') or the ledger minimum of its
// size ('ledger-minimum').
//
//   csl      cardano-serialization-lib 13.2.1's own change, the change of the
//            csl-lf and csl-ri baselines: a TransactionBuilder configured from
//            the run's parameters, the set added with add_regular_input at
//            each UTxO's own address (so the library counts one witness per
//            distinct payment key), the requested outputs added from their
//            bytes, then add_change_if_needed at the change address and
//            build_tx (Emurgo/cardano-serialization-lib at
//            846d0f274a436403659fa7b197a09c029d7f2126,
//            rust/src/builders/tx_builder.rs:1828-2196). The library keeps its
//            transaction body and fee; the kit fills the witness set with
//            synthetic witnesses in the library's own encoding.
//   csl-ppc  the same with prefer_pure_change set (tx_builder.rs:2096-2123),
//            the sensitivity arm's change.
//   layout   the layout-preserving change of the H-12 rule and H-9, the
//            simulator's own policy (methods/change.mjs buildWithChange),
//            assembled by the kit at the ledger minimum.
//   cjs      cardano-js-sdk's change (roundRobinRandomImprove with the set as
//            preSelectedUtxo and no other UTxO available) and
//   evo      the Evolution SDK's (the set through collectFrom, no available
//            UTxOs): both are reached through the baseline adapters' own
//            library calls, which are not part of this build yet, so either
//            name is refused.
//
// Each evaluation is cached by its set (the references in txid#index order).

import { buildWithChange } from '../methods/change.mjs';
import { checkTx, CLASSES } from '../kit/check.mjs';
import { inspectTx } from '../kit/inspect.mjs';
import { cmpRef } from '../state/state.mjs';
import { parseAddress, addressBytes } from '../history/address.mjs';
import { OracleRefusal } from './spend.mjs';

export const ORACLE_POLICIES = Object.freeze(['csl', 'csl-ppc', 'cjs', 'evo', 'layout']);
export const AVAILABLE_POLICIES = Object.freeze(['csl', 'csl-ppc', 'layout']);

// The oracle policy of a method's change: the baseline adapters' default
// change, or a simulator-owned policy put on any selector.
export function policyOfMethod(methodName, changePolicy) {
  if (changePolicy === 'layout') return 'layout';
  if (changePolicy !== 'default') return null;
  if (methodName === 'unfrackit-h12') return 'layout';
  if (methodName === 'csl-lf' || methodName === 'csl-ri') return 'csl';
  if (methodName === 'csl-lf-pure' || methodName === 'csl-ri-pure') return 'csl-ppc';
  if (methodName === 'cjs-rrri') return 'cjs';
  if (methodName === 'evo-lf') return 'evo';
  return null;
}

export const setKey = (S) => S.map((u) => u.ref).sort(cmpRef).join(' ');

// cardano-serialization-lib's error texts, mapped to the failure classes.
export function classOfCslError(text) {
  if (/Insufficient input/.test(text)) return CLASSES.balance;
  if (/Not enough ADA leftover/.test(text)) return CLASSES.changeMinimum;
  if (/Maximum transaction size/.test(text)) return CLASSES.txSize;
  if (/Maximum value size|NFTs too large/.test(text)) return CLASSES.valueSize;
  return CLASSES.other;
}

export function cslConfig(CSL, params, preferPure) {
  const B = (x) => CSL.BigNum.from_str(x.toString());
  const objs = [];
  const k = (o) => (objs.push(o), o);
  const fee = k(CSL.LinearFee.new(k(B(params.minFeeA)), k(B(params.minFeeB))));
  let b = CSL.TransactionBuilderConfigBuilder.new();
  const step = (f) => {
    const next = f(b);
    b.free();
    b = next;
  };
  step((x) => x.fee_algo(fee));
  step((x) => x.coins_per_utxo_byte(k(B(params.coinsPerUtxoByte))));
  if (params.poolDeposit !== null) step((x) => x.pool_deposit(k(B(params.poolDeposit))));
  if (params.keyDeposit !== null) step((x) => x.key_deposit(k(B(params.keyDeposit))));
  step((x) => x.max_value_size(params.maxValSize));
  step((x) => x.max_tx_size(params.maxTxSize));
  if (params.priceMem && params.priceStep) {
    const pm = k(CSL.UnitInterval.new(k(B(params.priceMem[0])), k(B(params.priceMem[1]))));
    const ps = k(CSL.UnitInterval.new(k(B(params.priceStep[0])), k(B(params.priceStep[1]))));
    step((x) => x.ex_unit_prices(k(CSL.ExUnitPrices.new(pm, ps))));
  }
  if (params.minFeeRefScriptCostPerByte) {
    const r = params.minFeeRefScriptCostPerByte;
    step((x) => x.ref_script_coins_per_byte(k(CSL.UnitInterval.new(k(B(r[0])), k(B(r[1]))))));
  }
  step((x) => x.prefer_pure_change(preferPure));
  const cfg = b.build();
  b.free();
  for (const o of objs) o.free();
  return cfg;
}

const hex = (b) => Buffer.from(b).toString('hex');

// An evaluator for one (state, spend, params, policy). evaluate(S) takes UTxO
// records and returns { ok, fee, size, minFee, bytes, k, change, hash } or
// { ok: false, class, detail }; dispose() frees its CSL objects.
export function makeEvaluator(T, { state, spend, params, policy, settings }) {
  if (!ORACLE_POLICIES.includes(policy)) throw new OracleRefusal(`unknown change policy ${policy}`);
  if (!AVAILABLE_POLICIES.includes(policy)) throw new OracleRefusal(`change policy ${policy} is reached through its baseline adapter, which this build does not have yet`);
  const CSL = T.CSL;
  const nReq = spend.requested.length;
  const requestedIdx = new Set(spend.requested.map((_, i) => i));
  const views = new Map();
  const resolve = (ref) => {
    let v = views.get(ref);
    if (v === undefined) {
      const u = state.utxos.get(ref);
      v = u ? { coin: u.coin, assets: u.assets, addr: parseAddress(addressBytes(u.address)) } : null;
      views.set(ref, v);
    }
    return v || undefined;
  };
  const cache = new Map();
  const stats = { evaluations: 0, cached: 0, feasible: 0, ms: 0 };
  const owned = [];
  const own = (o) => (owned.push(o), o);

  let csl = null;
  if (policy === 'csl' || policy === 'csl-ppc') {
    const addrs = new Map();
    const inputs = new Map();
    const values = new Map();
    const wsets = new Map();
    csl = {
      cfg: own(cslConfig(CSL, params, policy === 'csl-ppc')),
      change: own(CSL.Address.from_bech32(state.changeAddress)),
      outputs: spend.requested.map((o) => own(CSL.TransactionOutput.from_bytes(Buffer.from(o.cbor, 'hex')))),
      addr: (a) => addrs.get(a) || (addrs.set(a, own(CSL.Address.from_bech32(a))), addrs.get(a)),
      input: (ref) => {
        let x = inputs.get(ref);
        if (!x) {
          const [h, i] = ref.split('#');
          const th = CSL.TransactionHash.from_hex(h);
          x = own(CSL.TransactionInput.new(th, Number(i)));
          th.free();
          inputs.set(ref, x);
        }
        return x;
      },
      value: (u) => {
        let v = values.get(u.ref);
        if (!v) {
          v = own(cslValue(CSL, u.coin, u.assets));
          values.set(u.ref, v);
        }
        return v;
      },
      witnesses: (k) => wsets.get(k) || (wsets.set(k, own(T.build.makeWitnessSet(k))), wsets.get(k))
    };
  }

  function build(S) {
    const inputs = [...S].sort((x, y) => cmpRef(x.ref, y.ref));
    const k = new Set(inputs.map((u) => u.cred)).size;
    if (policy === 'layout') {
      const r = buildWithChange(T, { state, params, inputs, intent: spend, policy: 'layout' });
      if (!r.ok) return { ok: false, class: r.class, detail: r.detail };
      return { ok: true, bytes: r.bytes, k: r.k };
    }
    const b = CSL.TransactionBuilder.new(csl.cfg);
    let tx = null;
    let body = null;
    let full = null;
    try {
      for (const u of inputs) b.add_regular_input(csl.addr(u.address), csl.input(u.ref), csl.value(u));
      for (const o of csl.outputs) b.add_output(o);
      b.add_change_if_needed(csl.change);
      tx = b.build_tx();
      body = tx.body();
      full = CSL.Transaction.new(body, csl.witnesses(k), undefined);
      return { ok: true, bytes: hex(full.to_bytes()), k };
    } catch (e) {
      const text = String(e && (e.message || e));
      return { ok: false, class: classOfCslError(text), detail: `cardano-serialization-lib: ${text}` };
    } finally {
      for (const x of [full, body, tx, b]) if (x) x.free();
    }
  }

  function evaluate(S) {
    const key = setKey(S);
    const hit = cache.get(key);
    if (hit) {
      stats.cached++;
      return hit;
    }
    const t0 = performance.now();
    stats.evaluations++;
    let r = build(S);
    if (r.ok) {
      const chk = checkTx(r.bytes, { params, resolve, requested: requestedIdx });
      if (!chk.ok) r = { ok: false, class: chk.failures[0].cls, detail: `kit: ${chk.failures[0].check}: ${chk.failures[0].detail}`, bytes: r.bytes };
      else {
        const t = inspectTx(r.bytes);
        const change = t.outputs.slice(nReq).map((o) => ({ cbor: o.raw.toString('hex'), coin: o.coin, assets: o.assets }));
        const fee = settings.setFee === 'ledger-minimum' ? chk.facts.minFee : chk.facts.fee;
        r = { ok: true, fee, txFee: chk.facts.fee, minFee: chk.facts.minFee, size: chk.facts.size, bytes: r.bytes, k: r.k, change, hash: chk.facts.hash, inputs: S.map((u) => u.ref).sort(cmpRef) };
        stats.feasible++;
      }
    }
    stats.ms += performance.now() - t0;
    cache.set(key, r);
    return r;
  }

  return {
    policy,
    evaluate,
    stats,
    dispose() {
      for (const o of owned) o.free();
      owned.length = 0;
      cache.clear();
    }
  };
}

function cslValue(CSL, coin, assets) {
  const c = CSL.BigNum.from_str(coin.toString());
  const v = CSL.Value.new(c);
  c.free();
  if (!assets.length) return v;
  const ma = CSL.MultiAsset.new();
  for (const a of assets) {
    const sh = CSL.ScriptHash.from_hex(a.policy);
    const an = CSL.AssetName.new(Buffer.from(a.name, 'hex'));
    const bn = CSL.BigNum.from_str(a.qty.toString());
    const prev = ma.set_asset(sh, an, bn);
    if (prev) prev.free();
    for (const x of [sh, an, bn]) x.free();
  }
  v.set_multiasset(ma);
  ma.free();
  return v;
}
