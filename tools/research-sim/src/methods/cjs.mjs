// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The cardano-js-sdk baseline, cjs-rrri: roundRobinRandomImprove of
// @cardano-sdk/input-selection 0.14.35 (input-output-hk/cardano-js-sdk at
// 48019e49c826ea77d81be0e2d2907f94406f5e04, packages/input-selection/src/),
// with the four constraint callbacks implemented exactly by this adapter. The
// library selects inputs and computes change; the ledger kit assembles the
// transaction from its selection.
//
// The library, at that commit:
//   RoundRobinRandomImprove/roundRobin.ts:75-125 treats all requested outputs
//   as one combined bundle and visits each requested asset, then Lovelace, in
//   turn, drawing a random UTxO that holds it and keeping it while the selected
//   quantity is under the target or moves closer to twice the target
//   (improvesSelection, :12-36); an asset leaves the rotation at the first
//   draw that does not improve. The UTxOs are drawn from the list in the order
//   given, by index floor(random() * n) (:96).
//   change.ts:325-372 builds one change bundle per requested output, with token
//   change in proportion to each output's quantities (:103-128, :155-203),
//   puts tokens the inputs brought but no output requested into the bundles
//   (:73-101), merges bundles under their minimum coin (:220-265) and splits a
//   bundle tokenBundleSizeExceedsLimit calls too large (:278-323). The fee is
//   estimated on change computed before the fee and then taken from the change
//   (:398-481), and further inputs are drawn at random, ADA-only UTxOs first
//   (RoundRobinRandomImprove/index.ts:22-33).
//   RoundRobinRandomImprove/index.ts:104-109 throws MaximumInputCountExceeded
//   when the selection has more inputs than computeSelectionLimit returns.
//
// The callbacks (types.ts:44-71), each computed with the kit on the
// transaction as it would be assembled, at the wallet's change address (the
// library hands its change at a stub address, util.ts:11-13, which the
// change-address resolver replaces with the wallet's: setting changeAddress):
//   computeMinimumCost(skeleton)   minFeeA * |tx| + minFeeB, plus the intent's
//                                  script fee, |tx| the ledger's size of the
//                                  skeleton's transaction (its inputs, the
//                                  requested outputs and the skeleton's change,
//                                  synthetic witnesses included) with the fee
//                                  field at that fee itself (a fixed point)
//   computeMinimumCoinQuantity(o)  CSL's min_ada_for_output for the output as
//                                  the kit serializes it
//   tokenBundleSizeExceedsLimit(b) the bundle's serialized Value above
//                                  maxValSize, its coin at the widest encoding
//                                  (setting cjsBundleCoin 'widest'), as the
//                                  library's own default constraint does
//                                  (packages/tx-construction/src/input-selection/
//                                  selectionConstraints.ts:211-222), so a bundle
//                                  it accepts fits whatever coin it carries
//   computeSelectionLimit(sk)      the skeleton's input count when its
//                                  assembled transaction, at the skeleton's
//                                  fee, fits maxTxSize, and one fewer when it
//                                  does not, so the library reports too many
//                                  inputs exactly when the transaction exceeds
//                                  the size limit (the library's own default
//                                  constraint takes the same shape,
//                                  selectionConstraints.ts:233-242)
//
// Random source (setting rng 'mulberry32'): opts.random, a function the
// engine keeps per (wallet, arm, seed) so that a replay's spends draw from one
// stream; without it, a fresh mulberry32 generator seeded with opts.seed.
//
// Errors (InputSelectionError.ts:3-28) to failure classes:
//   UtxoBalanceInsufficient    balance
//   UtxoFullyDepleted          change-minimum
//   MaximumInputCountExceeded  max-inputs
// UtxoNotFragmentedEnough is declared and thrown nowhere in the package at
// this version; it and any other error take class 'other' with its text.
//
// Change substitution (setting substitutedChange 'fail'): with a change policy
// other than 'default', the library's selection.inputs are kept and the
// simulator's policy builds the change (methods/change.mjs).

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { roundRobinRandomImprove, InputSelectionError, InputSelectionFailure } from '@cardano-sdk/input-selection';
import { CLASSES } from '../kit/check.mjs';
import { assembleOnce, assembleAtMinimumFee, outputBytes } from '../kit/assemble.mjs';
import { inspectTx } from '../kit/inspect.mjs';
import { minFee } from '../kit/fee.mjs';
import { valueSize } from '../history/value.mjs';
import { makeRng } from '../shapes/rng.mjs';
import { buildWithChange } from './change.mjs';
import { inputOrder, recordsOf, refuseUncovered, REPLAY_COVERAGE, errorText, txRecord } from './library.mjs';
import { SIM_SETTINGS } from '../settings.mjs';

const PKG = JSON.parse(readFileSync(join(dirname(createRequire(import.meta.url).resolve('@cardano-sdk/input-selection')), '..', '..', 'package.json'), 'utf8'));
export const CJS_VERSION = PKG.version;
if (CJS_VERSION !== '0.14.35') throw new Error(`@cardano-sdk/input-selection ${CJS_VERSION} is installed; the baseline is 0.14.35`);

// The library's stub change address (util.ts:11-13).
export const STUB_ADDRESS = 'addr_test1qqydn46r6mhge0kfpqmt36m6q43knzsd9ga32n96m89px3nuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475qypp3m9';
const MAX_U64 = 18446744073709551615n;

const ERROR_CLASSES = Object.freeze({
  [InputSelectionFailure.UtxoBalanceInsufficient]: CLASSES.balance,
  [InputSelectionFailure.UtxoFullyDepleted]: CLASSES.changeMinimum,
  [InputSelectionFailure.MaximumInputCountExceeded]: CLASSES.maxInputs
});

export function classOfCjsError(e) {
  if (e instanceof InputSelectionError && ERROR_CLASSES[e.failure]) return ERROR_CLASSES[e.failure];
  return CLASSES.other;
}

// Conversions to the library's types (packages/core/src/Cardano/types/:
// Utxo.ts, TxOut in Transaction.ts, Value.ts with TokenMap keyed by AssetId,
// the policy id followed by the asset name, both hex). A value without assets
// has no token map: the library tells ADA-only UTxOs by its absence
// (RoundRobinRandomImprove/index.ts:25).
export function tokenMap(assets) {
  if (!assets.length) return undefined;
  return new Map(assets.map((a) => [`${a.policy}${a.name}`, BigInt(a.qty)]));
}
export function assetsOf(map) {
  if (!map) return [];
  return [...map.entries()].filter(([, q]) => q !== 0n).map(([id, q]) => ({ policy: id.slice(0, 56), name: id.slice(56), qty: q })).sort((a, b) => (a.policy < b.policy ? -1 : a.policy > b.policy ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
export function cjsUtxo(u) {
  const [txId, index] = u.ref.split('#');
  return [{ txId, index: Number(index), address: u.address }, { address: u.address, value: { coins: u.coin, assets: tokenMap(u.assets) } }];
}
export const cjsTxOut = (o) => ({ address: o.address, value: { coins: o.coin, assets: tokenMap(o.assets) } });
const refOfUtxo = ([i]) => `${i.txId}#${i.index}`;

// The callbacks for one spend. `trace` collects what the checks read: every
// cost the library was given and every bundle it asked about.
export function exactConstraints(T, { state, params, intent, scriptFee = 0n, bundleCoin = SIM_SETTINGS.cjsBundleCoin, trace = null }) {
  if (bundleCoin !== 'widest') throw new Error(`cjs: bundle coin ${bundleCoin} is not implemented`);
  const C = T.CSL;
  const requested = intent.requested.map((o) => ({ address: o.address, coin: o.coin, assets: o.assets }));
  const change = (txOut) => ({ address: state.changeAddress, coin: txOut.value.coins, assets: assetsOf(txOut.value.assets) });
  const outputsOf = (sk) => [...requested, ...sk.change.map(change)];
  const inputsOf = (sk) => recordsOf(state, [...sk.inputs].map(refOfUtxo));
  const dataCost = C.DataCost.new_coins_per_byte(C.BigNum.from_str(params.coinsPerUtxoByte.toString()));
  return {
    computeMinimumCost: async (sk) => {
      const r = assembleAtMinimumFee(T, params, inputsOf(sk), () => ({ ok: true, outputs: outputsOf(sk) }), { scriptFee });
      if (trace) trace.costs.push(r.fee);
      return { fee: r.fee };
    },
    computeMinimumCoinQuantity: (txOut) => {
      const address = txOut.address === STUB_ADDRESS ? state.changeAddress : txOut.address;
      const o = C.TransactionOutput.from_bytes(outputBytes(T, { address, coin: txOut.value.coins, assets: assetsOf(txOut.value.assets) }));
      const m = C.min_ada_for_output(o, dataCost);
      const v = BigInt(m.to_str());
      m.free();
      o.free();
      return v;
    },
    tokenBundleSizeExceedsLimit: (bundle) => {
      if (!bundle) return false;
      const over = valueSize(MAX_U64, assetsOf(bundle)) > params.maxValSize;
      if (trace) trace.bundles.push({ assets: bundle.size, over });
      return over;
    },
    computeSelectionLimit: async (sk) => {
      const a = assembleOnce(T, inputsOf(sk), outputsOf(sk), sk.fee);
      const size = inspectTx(a.bytes).size;
      return size <= params.maxTxSize ? sk.inputs.size : sk.inputs.size - 1;
    },
    free: () => dataCost.free()
  };
}

export function cjsMethod(T, { bundleCoin = SIM_SETTINGS.cjsBundleCoin } = {}) {
  const name = 'cjs-rrri';
  return {
    name,
    version: `@cardano-sdk/input-selection ${CJS_VERSION} roundRobinRandomImprove`,
    deterministic: false,
    async build(state, intent, params, opts) {
      refuseUncovered(name, REPLAY_COVERAGE.cjs, intent);
      let random = opts.random;
      if (!random) {
        if (!Number.isSafeInteger(opts.seed)) throw new Error(`${name}: a seed is required`);
        const rng = makeRng(opts.seed);
        random = () => rng.next();
      }
      const trace = { costs: [], bundles: [] };
      const constraints = exactConstraints(T, { state, params, intent, bundleCoin, trace });
      const changeAddressResolver = { resolve: async (selection) => selection.change.map((c) => ({ ...c, address: state.changeAddress })) };
      let result;
      try {
        result = await roundRobinRandomImprove({ changeAddressResolver, random }).select({
          preSelectedUtxo: new Set(),
          utxo: new Set(inputOrder(state).map(cjsUtxo)),
          outputs: new Set(intent.requested.map(cjsTxOut)),
          constraints,
          implicitValue: {}
        });
      } catch (e) {
        return { ok: false, class: classOfCjsError(e), detail: `roundRobinRandomImprove: ${errorText(e)}` };
      } finally {
        constraints.free();
      }
      const sel = result.selection;
      const inputs = recordsOf(state, [...sel.inputs].map(refOfUtxo));
      if (opts.changePolicy !== 'default') {
        const r = buildWithChange(T, { state, params, inputs, intent, policy: opts.changePolicy });
        if (!r.ok) return { ok: false, class: r.class, detail: `${opts.changePolicy} change on the library's inputs: ${r.detail}` };
        return { ok: true, kind: 'single', txs: [txRecord(r.bytes, inputs.map((u) => u.ref), r.fee, r.size, r.k)] };
      }
      const outputs = [...intent.requested.map((o) => ({ address: o.address, coin: o.coin, assets: o.assets })), ...sel.change.map((c) => ({ address: c.address, coin: c.value.coins, assets: assetsOf(c.value.assets) }))];
      for (const o of outputs) if (o.coin < 0n) return { ok: false, class: CLASSES.other, detail: `the library returned an output with coin ${o.coin}` };
      const a = assembleOnce(T, inputs, outputs, sel.fee);
      const size = inspectTx(a.bytes).size;
      return {
        ok: true,
        kind: 'single',
        txs: [txRecord(a.bytes, inputs.map((u) => u.ref), sel.fee, size, a.k)],
        library: { fee: sel.fee, finalMinFee: minFee(params, size), costs: trace.costs, bundles: trace.bundles, change: sel.change.length }
      };
    }
  };
}
