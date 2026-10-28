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
//   cjs      cardano-js-sdk's change, the change of the cjs-rrri baseline:
//            roundRobinRandomImprove of @cardano-sdk/input-selection 0.14.35
//            (input-output-hk/cardano-js-sdk at
//            48019e49c826ea77d81be0e2d2907f94406f5e04,
//            packages/input-selection/src/) with the set as preSelectedUtxo
//            and no other UTxO available, so the selection must cover from
//            the set alone and the library's own computeChangeBundles
//            (change.ts) makes the change, under the baseline adapter's exact
//            constraint callbacks (methods/cjs.mjs exactConstraints); the kit
//            assembles the transaction at the library's fee, as the adapter
//            does. No UTxO is available to draw, so the random source is a
//            fixed one that is never called upon to choose.
//   evo      the Evolution SDK's change, the change of the evo-lf baseline:
//            @evolution-sdk/evolution 0.8.0's builder (IntersectMBO/
//            evolution-sdk at 4aaf6c3dc75a967fae168e28f42d1306c1a22a90,
//            packages/evolution/src/sdk/builders/) given the set through
//            collectFrom, in the order its largest-first selection holds a
//            selection (it writes a change output's assets in the order its
//            inputs brought them), and no available UTxOs, so its change
//            creation (phases/ChangeCreation.ts:263-382) runs on the set
//            alone; the transaction is the library's own, with its own fake
//            witnesses, as the adapter takes it (methods/evo.mjs).
//
// The cjs and evo policies reach their libraries through the baseline
// adapters' modules, loaded when first needed (loadLibraryPolicies); without
// those modules either name is refused.
//
// Each evaluation is cached by its set (the references in txid#index order).

import { buildWithChange } from '../methods/change.mjs';
import { assembleOnce } from '../kit/assemble.mjs';
import { checkTx, CLASSES } from '../kit/check.mjs';
import { inspectTx } from '../kit/inspect.mjs';
import { cmpRef } from '../state/state.mjs';
import { parseAddress, addressBytes } from '../history/address.mjs';
import { OracleRefusal } from './spend.mjs';

export const ORACLE_POLICIES = Object.freeze(['csl', 'csl-ppc', 'cjs', 'evo', 'layout']);
export const BUILT_IN_POLICIES = Object.freeze(['csl', 'csl-ppc', 'layout']);

let libraries = null;

// The library policies' modules: { cjs, evo, errors }, each null when its
// adapter or library cannot be loaded.
export async function loadLibraryPolicies() {
  if (libraries) return libraries;
  const out = { cjs: null, evo: null, errors: {} };
  try {
    const adapter = await import('../methods/cjs.mjs');
    const lib = await import('@cardano-sdk/input-selection');
    out.cjs = { adapter, roundRobinRandomImprove: lib.roundRobinRandomImprove };
  } catch (e) {
    out.errors.cjs = String(e && (e.message || e));
  }
  try {
    const adapter = await import('../methods/evo.mjs');
    const E = await import('@evolution-sdk/evolution');
    const tb = await import('@evolution-sdk/evolution/sdk/builders/TransactionBuilder');
    out.evo = { adapter, E, makeTxBuilder: tb.makeTxBuilder };
  } catch (e) {
    out.errors.evo = String(e && (e.message || e));
  }
  libraries = out;
  return out;
}

// The policies this build can evaluate.
export async function availablePolicies() {
  const lib = await loadLibraryPolicies();
  return ORACLE_POLICIES.filter((p) => BUILT_IN_POLICIES.includes(p) || lib[p]);
}

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
// records and resolves to { ok, fee, size, minFee, bytes, k, change, hash }
// or { ok: false, class, detail }; dispose() frees its CSL objects. `lib` is
// loadLibraryPolicies()'s result, needed for cjs and evo.
export function makeEvaluator(T, { state, spend, params, policy, settings, lib = null }) {
  if (!ORACLE_POLICIES.includes(policy)) throw new OracleRefusal(`unknown change policy ${policy}`);
  if (!BUILT_IN_POLICIES.includes(policy) && !(lib && lib[policy])) throw new OracleRefusal(`change policy ${policy} is reached through its baseline adapter, which cannot be loaded${lib && lib.errors[policy] ? ` (${lib.errors[policy]})` : ''}`);
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

  async function build(S) {
    const inputs = [...S].sort((x, y) => cmpRef(x.ref, y.ref));
    const k = new Set(inputs.map((u) => u.cred)).size;
    if (policy === 'cjs') return buildCjs(inputs);
    if (policy === 'evo') return buildEvo(inputs);
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

  const same = (inputs, refs) => refs.length === inputs.length && [...refs].sort(cmpRef).every((r, i) => r === inputs[i].ref);

  async function buildCjs(inputs) {
    const L = lib.cjs;
    const constraints = L.adapter.exactConstraints(T, { state, params, intent: spend });
    const changeAddressResolver = { resolve: async (selection) => selection.change.map((c) => ({ ...c, address: state.changeAddress })) };
    const random = () => 0;
    let result;
    try {
      result = await L.roundRobinRandomImprove({ changeAddressResolver, random }).select({
        preSelectedUtxo: new Set(inputs.map(L.adapter.cjsUtxo)),
        utxo: new Set(),
        outputs: new Set(spend.requested.map(L.adapter.cjsTxOut)),
        constraints,
        implicitValue: {}
      });
    } catch (e) {
      return { ok: false, class: L.adapter.classOfCjsError(e), detail: `roundRobinRandomImprove: ${String(e && (e.message || e))}` };
    } finally {
      constraints.free();
    }
    const sel = result.selection;
    const refs = [...sel.inputs].map(([i]) => `${i.txId}#${i.index}`);
    if (!same(inputs, refs)) throw new Error('cjs: the library selected other inputs than the forced set');
    const outputs = [...spend.requested.map((o) => ({ address: o.address, coin: o.coin, assets: o.assets })), ...sel.change.map((c) => ({ address: c.address, coin: c.value.coins, assets: L.adapter.assetsOf(c.value.assets) }))];
    for (const o of outputs) if (o.coin < 0n) return { ok: false, class: CLASSES.other, detail: `the library returned an output with coin ${o.coin}` };
    const a = assembleOnce(T, inputs, outputs, sel.fee);
    return { ok: true, bytes: a.bytes, k: a.k };
  }

  async function buildEvo(inputs) {
    const L = lib.evo;
    const E = L.E;
    let b = L.makeTxBuilder({ chain: state.network === 'preprod' ? E.preprod : E.mainnet });
    for (const o of spend.requested) {
      const out = E.TxOut.fromCBORHex(o.cbor);
      b = b.payToAddress({ address: out.address, assets: out.assets });
    }
    // The library writes a change output's assets in the order its inputs
    // brought them, so the set is given in the order its own largest-first
    // selection holds a selection: lovelace descending, the given txid#index
    // order among equals (CoinSelection.ts:67-113).
    const ordered = [...inputs].sort((x, y) => (x.coin > y.coin ? -1 : x.coin < y.coin ? 1 : cmpRef(x.ref, y.ref)));
    b = b.collectFrom({ inputs: ordered.map(L.adapter.evoUtxo) });
    let r;
    try {
      r = await b.buildEither({ changeAddress: E.Address.fromBech32(state.changeAddress), availableUtxos: [], protocolParameters: L.adapter.evoProtocolParameters(params) });
    } catch (e) {
      return { ok: false, class: L.adapter.classOfEvoError(e), detail: `build: ${String(e && (e.message || e))}` };
    }
    if (r._tag === 'Left') return { ok: false, class: L.adapter.classOfEvoError(r.left), detail: `build: ${String((r.left && r.left.message) || r.left).split('\n')[0]}` };
    const tx = await r.right.toTransactionWithFakeWitnesses();
    const refs = tx.body.inputs.map((i) => `${E.TransactionHash.toHex(i.transactionId)}#${i.index}`);
    if (!same(inputs, refs)) throw new Error('evo: the library selected other inputs than the forced set');
    return { ok: true, bytes: E.Transaction.toCBORHex(tx), k: new Set(inputs.map((u) => u.cred)).size };
  }

  async function evaluate(S) {
    const key = setKey(S);
    const hit = cache.get(key);
    if (hit) {
      stats.cached++;
      return hit;
    }
    const t0 = performance.now();
    stats.evaluations++;
    let r = await build(S);
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
