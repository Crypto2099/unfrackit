// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The cardano-serialization-lib baselines: csl-lf and csl-ri, and the
// sensitivity arm with prefer_pure_change set (csl-lf-pure, csl-ri-pure).
// cardano-serialization-lib 13.2.1 is the treatment's instance, loaded through
// its cslkit.mjs; no second CSL build is installed or imported.
//
// The library at Emurgo/cardano-serialization-lib tag 13.2.1 (commit
// 846d0f274a436403659fa7b197a09c029d7f2126), rust/src/builders/tx_builder.rs:
//
//   add_inputs_from (:412-593). LargestFirstMultiAsset runs
//   cip2_largest_first_by once for each asset of the outputs, in policy and
//   asset-name order, then once for ADA (:506-531). Each pass takes the UTxOs
//   holding its asset, sorted ascending by that asset's quantity with Rust's
//   stable sort_by_key and walked from the end, so among equal quantities the
//   UTxO given later is taken first; it adds inputs until the selected quantity
//   reaches the target, and the target grows by each added input's fee, so
//   the fee is counted in the ADA target (:595-636; CIP-0002 "Largest-First"
//   leaves fees out). A selected UTxO is removed from the shared index list
//   with swap_remove (:626), which moves the list's last index into its place,
//   so the passes after the first see the remaining UTxOs in a permuted order.
//   RandomImproveMultiAsset calls cip2_random_improve_by with pure_ada = false
//   on every pass (:532-590), so its improvement phase, guarded by pure_ada
//   (:705), never runs: it draws random UTxOs holding each asset until that
//   asset is covered, then random UTxOs, any kind, until the coin covers the
//   outputs and the fees ("Phase 3", :563-589), from rand::thread_rng(), which
//   a caller cannot seed. It is random selection, not CIP-0002
//   "Random-Improve".
//
//   add_change_if_needed (:1828-1830, :1844-2209). Every leftover asset goes
//   into change outputs packed greedily in policy and asset-name order, a new
//   output starting only when the next asset would take the output's Value, at
//   its minimum coin, over max_value_size (pack_nfts_for_change, :1911-2022);
//   each output carries its minimum coin and the leftover ADA goes to the last
//   one (:2125-2134), unless prefer_pure_change is set and the leftover after
//   one more output's fee is above the pure-ADA minimum, when it becomes a
//   separate pure-ADA output (:2097-2123). Leftover ADA that cannot fund a
//   token change output fails with "Not enough ADA leftover to include non-ADA
//   assets in a change address" (:2090). With no asset in the change, ADA
//   under an output's minimum is added to the fee (burn_extra, :2151-2167).
//
//   Fees: min_fee prices the transaction as serialized with its validity flag
//   and with fake vkey witnesses (fake_full_tx, :33-97), and with the fee
//   field at 2^32 (:2595-2599), so CSL's fee is a few bytes above the ledger's
//   minimum for its own size (the ledger's size leaves the validity flag out).
//
// Errors to failure classes (setting unclassified 'other' for the rest):
//   "Not enough ADA leftover to include non-ADA assets in a change address"
//                                                    change-minimum
//   "UTxO Balance Insufficient", "UTxO Balance Insufficient[x]",
//   "Insufficient input in transaction", "No inputs to add"   balance
//   "Maximum transaction size of ... exceeded"       tx-size
//   "Maximum value size of ... exceeded"             value-size
//
// Change substitution (H-9 and H-11; setting substitutedChange 'fail'): with a
// change policy other than 'default', the adapter keeps only the inputs
// add_inputs_from chose, before add_change_if_needed, and the simulator's
// policy builds the change (methods/change.mjs), the kit assembling the
// transaction at its exact fee.

import { CLASSES } from '../kit/check.mjs';
import { buildWithChange } from './change.mjs';
import { inputOrder, recordsOf, keyCount, batteryOnly, errorText, txRecord } from './library.mjs';
import { inspectTx } from '../kit/inspect.mjs';

export const CSL_STRATEGIES = Object.freeze({ lf: 'LargestFirstMultiAsset', ri: 'RandomImproveMultiAsset' });

const ERROR_CLASSES = [
  [/^Not enough ADA leftover to include non-ADA assets in a change address/, CLASSES.changeMinimum],
  [/^UTxO Balance Insufficient/, CLASSES.balance],
  [/^Insufficient input in transaction/, CLASSES.balance],
  [/^No inputs to add/, CLASSES.balance],
  [/^Maximum transaction size of \d+ exceeded/, CLASSES.txSize],
  [/^Maximum value size of \d+ exceeded/, CLASSES.valueSize]
];

export function classOfCslError(text) {
  for (const [re, cls] of ERROR_CLASSES) if (re.test(text)) return cls;
  return CLASSES.other;
}

function scope() {
  const xs = [];
  return {
    k(o) {
      if (o) xs.push(o);
      return o;
    },
    free() {
      for (const o of xs.reverse()) o.free();
      xs.length = 0;
    }
  };
}

// The builder's configuration from the run's parameters.
export function cslConfig(T, params, { preferPureChange = false } = {}, S = scope()) {
  const C = T.CSL;
  const B = (x) => S.k(C.BigNum.from_str(String(x)));
  let b = C.TransactionBuilderConfigBuilder.new();
  const step = (f) => {
    const nb = f(b);
    b.free();
    b = nb;
  };
  step((x) => x.fee_algo(S.k(C.LinearFee.new(B(params.minFeeA), B(params.minFeeB)))));
  step((x) => x.coins_per_utxo_byte(B(params.coinsPerUtxoByte)));
  if (params.poolDeposit === null || params.keyDeposit === null) throw new Error('csl: the builder needs the key and pool deposits, which this run does not state');
  step((x) => x.pool_deposit(B(params.poolDeposit)));
  step((x) => x.key_deposit(B(params.keyDeposit)));
  step((x) => x.max_value_size(params.maxValSize));
  step((x) => x.max_tx_size(params.maxTxSize));
  if (params.priceMem && params.priceStep) {
    const u = (r) => S.k(C.UnitInterval.new(B(r[0]), B(r[1])));
    step((x) => x.ex_unit_prices(S.k(C.ExUnitPrices.new(u(params.priceMem), u(params.priceStep)))));
  }
  if (params.minFeeRefScriptCostPerByte) {
    const r = params.minFeeRefScriptCostPerByte;
    step((x) => x.ref_script_coins_per_byte(S.k(C.UnitInterval.new(B(r[0]), B(r[1])))));
  }
  step((x) => x.prefer_pure_change(!!preferPureChange));
  const cfg = b.build();
  b.free();
  return S.k(cfg);
}

// CSL's transaction with k synthetic vkey witnesses in CSL's encoding (the
// treatment's build.mjs makeWitnessSet), its body kept as CSL serializes it.
export function cslWithWitnesses(T, tx, k, S) {
  const C = T.CSL;
  const body = S.k(tx.body());
  const aux = S.k(tx.auxiliary_data());
  const ws = S.k(T.build.makeWitnessSet(k));
  const full = S.k(aux ? C.Transaction.new(body, ws, aux) : C.Transaction.new(body, ws));
  return Buffer.from(full.to_bytes()).toString('hex');
}

const refOf = (input) => `${Buffer.from(input.transaction_id().to_bytes()).toString('hex')}#${input.index()}`;

export function cslMethod(T, { strategy, preferPureChange = false }) {
  if (!CSL_STRATEGIES[strategy]) throw new Error(`csl: unknown strategy ${strategy}`);
  if (T.cslkit.CSL_VERSION !== '13.2.1') throw new Error(`csl: the treatment loads cardano-serialization-lib ${T.cslkit.CSL_VERSION}, not 13.2.1`);
  const name = `csl-${strategy}${preferPureChange ? '-pure' : ''}`;
  return {
    name,
    version: `cardano-serialization-lib ${T.cslkit.CSL_VERSION} ${CSL_STRATEGIES[strategy]}${preferPureChange ? ', prefer_pure_change' : ''}`,
    deterministic: strategy === 'lf',
    build(state, intent, params, opts) {
      batteryOnly(name, intent);
      const C = T.CSL;
      const S = scope();
      try {
        const tb = S.k(C.TransactionBuilder.new(cslConfig(T, params, { preferPureChange }, S)));
        try {
          for (const o of intent.requested) tb.add_output(S.k(C.TransactionOutput.from_bytes(Buffer.from(o.cbor, 'hex'))));
        } catch (e) {
          // A requested output CSL refuses (its value over the limit, its coin
          // under the minimum) is the intent's, not the selection's.
          const t = errorText(e);
          return { ok: false, class: CLASSES.other, detail: `requested output: ${t}` };
        }
        const utxos = S.k(C.TransactionUnspentOutputs.new());
        for (const u of inputOrder(state)) utxos.add(S.k(C.TransactionUnspentOutput.from_bytes(Buffer.from(u.cbor, 'hex'))));
        try {
          tb.add_inputs_from(utxos, C.CoinSelectionStrategyCIP2[CSL_STRATEGIES[strategy]]);
        } catch (e) {
          const t = errorText(e);
          return { ok: false, class: classOfCslError(t), detail: `add_inputs_from: ${t}` };
        }
        if (opts.changePolicy !== 'default') {
          // The inputs add_inputs_from chose: the body at a zero fee. Its size
          // was checked by the library's own fee estimates while it selected.
          tb.set_fee(S.k(C.BigNum.zero()));
          let body;
          try {
            body = S.k(tb.build());
          } catch (e) {
            const t = errorText(e);
            return { ok: false, class: classOfCslError(t), detail: `the library's inputs: ${t}` };
          }
          const ins = S.k(body.inputs());
          const refs = [];
          for (let i = 0; i < ins.len(); i++) refs.push(refOf(S.k(ins.get(i))));
          const inputs = recordsOf(state, refs);
          const r = buildWithChange(T, { state, params, inputs, intent, policy: opts.changePolicy });
          if (!r.ok) return { ok: false, class: r.class, detail: `${opts.changePolicy} change on the library's inputs: ${r.detail}` };
          return { ok: true, kind: 'single', txs: [txRecord(r.bytes, inputs.map((u) => u.ref), r.fee, r.size, r.k)] };
        }
        try {
          tb.add_change_if_needed(S.k(C.Address.from_bech32(state.changeAddress)));
        } catch (e) {
          const t = errorText(e);
          return { ok: false, class: classOfCslError(t), detail: `add_change_if_needed: ${t}` };
        }
        let tx;
        try {
          tx = S.k(tb.build_tx());
        } catch (e) {
          const t = errorText(e);
          return { ok: false, class: classOfCslError(t), detail: `build_tx: ${t}` };
        }
        const body = S.k(tx.body());
        const ins = S.k(body.inputs());
        const refs = [];
        for (let i = 0; i < ins.len(); i++) refs.push(refOf(S.k(ins.get(i))));
        const inputs = recordsOf(state, refs);
        const k = keyCount(inputs);
        const bytes = cslWithWitnesses(T, tx, k, S);
        const fee = BigInt(S.k(body.fee()).to_str());
        return { ok: true, kind: 'single', txs: [txRecord(bytes, refs, fee, inspectTx(bytes).size, k)] };
      } finally {
        S.free();
      }
    }
  };
}
