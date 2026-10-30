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
// Random source (setting rng 'mulberry32'): opts.random when given, the
// replay job's one generator (replay/engine.mjs jobOptions), so that a
// replay's builds draw from one stream; without it (a battery run), a fresh
// mulberry32 generator seeded with opts.seed for this build.
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
//
// The replay path: every intent the history reader writes (source 'replay')
// goes through the library's own parameters for what a selection has to
// balance (types.ts:73-92), and through the ledger kit (kit/replay.mjs) for
// the parts a selector does not choose, as follows:
//   fixed inputs     the inputs that are not the selector's (other parties'
//                    and script inputs, and the wallet's held UTxOs the spend
//                    consumed) are preSelectedUtxo, which the selection starts
//                    from (RoundRobinRandomImprove/roundRobin.ts:84), so their
//                    value counts toward every target and their tokens not
//                    requested go to the change (change.ts:45-101); they are
//                    never offered as ordinary UTxOs. The library never reads
//                    a UTxO's address; a Byron one is given as its hex.
//   withdrawals,     ImplicitValue.coin (packages/core/src/Cardano/util/
//   refunds,         computeImplicitCoin.ts:9-19): withdrawals as
//   deposits         withdrawals, refunds as reclaimDeposit, their sum as
//                    input, deposits as deposit. The library reads input and
//                    deposit only (util.ts:107-117, roundRobin.ts:64-65,
//                    change.ts:170-171, :447-449).
//   donation         added to deposit. The library has no donation field, and
//                    the SDK's own builder fills ImplicitValue from
//                    certificates, proposals and withdrawals only
//                    (packages/tx-construction/src/tx-builder/
//                    initializeTx.ts:137-149); deposit is the field the
//                    library reads as coin the transaction spends outside its
//                    outputs, which a donation is.
//   mint, burn       ImplicitValue.mint, a mint as a positive quantity and a
//                    burn as a negative one (types.ts:77-78), which the
//                    library splits into implicit token input and spend
//                    (util.ts:45-52, roundRobin.ts:43-59, change.ts:162-169).
//   requested        outputs, by address and value, which is all the library
//   outputs          reads of them; the kit writes each as its own bytes, so a
//                    datum, a script reference and a coin raised to its
//                    minimum pass through as observed.
//   other fixed      reference inputs, certificates, the withdrawal and mint
//   parts            fields, validity, required signers, network id, votes,
//                    proposals, the treasury fields, auxiliary data, scripts,
//                    datums and redeemers are not input selection's: the
//                    library has no parameter for them. The kit writes each
//                    as its original bytes, each spend redeemer's index
//                    recomputed, into every skeleton transaction the callbacks
//                    assemble and into the final one, so computeMinimumCost
//                    and computeSelectionLimit see their bytes, and
//                    computeMinimumCost adds the intent's script fee, held
//                    constant across arms. The redeemers' execution units are
//                    the observed ones; the callbacks return no redeemers
//                    (types.ts:43).
//   collateral       not input selection's either: for a script spend, the
//                    UTxO the engine set aside before selection under the
//                    arm's rule (replay/engine.mjs setAside), with a return
//                    output and the total-collateral field, in every skeleton
//                    the callbacks assemble and in the final transaction. It
//                    is not among the UTxOs the library is given. Should it
//                    fail to cover a skeleton's fee (only above the largest
//                    fee within the size limit), the spend fails with class
//                    collateral at that point.
// A part the kit cannot write (a body field 6, protocol parameter updates,
// which no Conway transaction carries) makes the intent not replayable for
// this adapter, counted apart from build failures. A battery spend carries
// none of these parts and keeps the battery path: its outputs as CSL
// serializes them, assembled by kit/assemble.mjs.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { roundRobinRandomImprove, InputSelectionError, InputSelectionFailure } from '@cardano-sdk/input-selection';
import { CLASSES } from '../kit/check.mjs';
import { assembleOnce, assembleAtMinimumFee, outputBytes } from '../kit/assemble.mjs';
import { assembleReplayOnce, assembleReplayAtMinimumFee, setAsideCollateralFor, replayRefusal, NotReplayable } from '../kit/replay.mjs';
import { addressTextOf } from '../state/utxo.mjs';
import { inspectTx, unspentOutputParts } from '../kit/inspect.mjs';
import { NOT_REPLAYABLE } from './contract.mjs';
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

// A replayed skeleton whose fee the collateral set aside cannot cover, thrown
// out of a callback so that the selection stops there.
export class NoCollateral extends Error {
  constructor(detail) {
    super(detail);
    this.name = 'NoCollateral';
  }
}

export function classOfCjsError(e) {
  if (e instanceof NoCollateral) return CLASSES.collateral;
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

const addressText = (bytes) => {
  try {
    return addressTextOf(bytes);
  } catch {
    return Buffer.from(bytes).toString('hex');
  }
};

// A replayed intent's fixed inputs as the library's pre-selected UTxOs.
export function cjsPreSelected(intent) {
  if (!intent.fixed) return [];
  return intent.fixed.inputs.map((x) => {
    const p = unspentOutputParts(x.cbor);
    if (p.ref !== x.ref) throw new Error(`fixed input ${x.ref}: its bytes name ${p.ref}`);
    const address = addressText(p.address);
    return [{ txId: p.txid, index: p.index, address }, { address, value: { coins: p.coin, assets: tokenMap(p.assets) } }];
  });
}

// A replayed intent's implicit values as the library's ImplicitValue.
export function cjsImplicitValue(imp) {
  const mint = new Map();
  const add = (a, sign) => {
    const id = `${a.policy}${a.name}`;
    mint.set(id, (mint.get(id) || 0n) + sign * BigInt(a.qty));
  };
  for (const a of imp.mint) add(a, 1n);
  for (const a of imp.burn) add(a, -1n);
  for (const [id, q] of [...mint]) if (q === 0n) mint.delete(id);
  const withdrawals = BigInt(imp.withdrawals);
  const reclaimDeposit = BigInt(imp.refunds);
  const coin = { withdrawals, reclaimDeposit, input: withdrawals + reclaimDeposit, deposit: BigInt(imp.deposits) + BigInt(imp.donation) };
  return mint.size ? { coin, mint } : { coin };
}

// A replayed skeleton's transaction as the kit assembles it: the wallet
// inputs among `refs` (every input of the skeleton, the fixed ones included),
// the intent's requested outputs and fixed parts, the change, and for a script
// spend the collateral the engine set aside, at that fee.
export function replayAssembler(T, { state, params, intent, collateral }) {
  const fixedRefs = new Set(intent.fixed ? intent.fixed.inputs.map((x) => x.ref) : []);
  const walletCreds = new Set([...state.utxos.values()].map((u) => u.cred));
  const walletInputs = (refs) => recordsOf(state, refs.filter((r) => !fixedRefs.has(r)));
  const collateralFor = setAsideCollateralFor(params, intent, collateral, state.changeAddress);
  // At a given fee: { ok, bytes, size, k } or the collateral failure.
  const at = (refs, change, fee) => {
    const co = collateralFor(fee);
    if (co && !co.ok) return co;
    const a = assembleReplayOnce(T, { intent, inputs: walletInputs(refs), change, collateral: co ? co.collateral : null, fee, walletCreds });
    return { ok: true, bytes: a.bytes, size: inspectTx(a.bytes).size, k: a.k };
  };
  // At its least self-covering fee: { ok, fee, ... } or the collateral failure.
  const atMinimumFee = (refs, change) => assembleReplayAtMinimumFee(T, params, { intent, inputs: walletInputs(refs), changeFor: () => ({ ok: true, change }), collateralFor, walletCreds });
  return { fixedRefs, walletInputs, at, atMinimumFee };
}

// The callbacks for one spend. `trace` collects what the checks read: every
// cost the library was given and every bundle it asked about. A replayed
// intent's skeletons are assembled with its fixed parts and the collateral set
// aside (replayAssembler); a fee that collateral cannot cover stops the
// selection with NoCollateral.
export function exactConstraints(T, { state, params, intent, scriptFee = 0n, bundleCoin = SIM_SETTINGS.cjsBundleCoin, trace = null, collateral = null }) {
  if (bundleCoin !== 'widest') throw new Error(`cjs: bundle coin ${bundleCoin} is not implemented`);
  const C = T.CSL;
  const replay = intent.source === 'replay' ? replayAssembler(T, { state, params, intent, collateral }) : null;
  const refsOf = (sk) => [...sk.inputs].map(refOfUtxo);
  const requested = intent.requested.map((o) => ({ address: o.address, coin: o.coin, assets: o.assets }));
  const change = (txOut) => ({ address: state.changeAddress, coin: txOut.value.coins, assets: assetsOf(txOut.value.assets) });
  const outputsOf = (sk) => [...requested, ...sk.change.map(change)];
  const inputsOf = (sk) => recordsOf(state, [...sk.inputs].map(refOfUtxo));
  const dataCost = C.DataCost.new_coins_per_byte(C.BigNum.from_str(params.coinsPerUtxoByte.toString()));
  return {
    computeMinimumCost: async (sk) => {
      const r = replay ? replay.atMinimumFee(refsOf(sk), sk.change.map(change)) : assembleAtMinimumFee(T, params, inputsOf(sk), () => ({ ok: true, outputs: outputsOf(sk) }), { scriptFee });
      if (!r.ok) throw r.class === CLASSES.collateral ? new NoCollateral(r.detail) : new Error(r.detail);
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
      let size;
      if (replay) {
        const r = replay.at(refsOf(sk), sk.change.map(change), sk.fee);
        if (!r.ok) throw new NoCollateral(r.detail);
        size = r.size;
      } else {
        size = inspectTx(assembleOnce(T, inputsOf(sk), outputsOf(sk), sk.fee).bytes).size;
      }
      return size <= params.maxTxSize ? sk.inputs.size : sk.inputs.size - 1;
    },
    replay,
    free: () => dataCost.free()
  };
}

export function cjsMethod(T, { bundleCoin = SIM_SETTINGS.cjsBundleCoin } = {}) {
  const name = 'cjs-rrri';
  return {
    name,
    version: `@cardano-sdk/input-selection ${CJS_VERSION} roundRobinRandomImprove`,
    deterministic: false,
    // Its draws come from opts.random or a generator seeded with opts.seed.
    seeded: true,
    async build(state, intent, params, opts) {
      refuseUncovered(name, REPLAY_COVERAGE.cjs, intent);
      const replay = intent.source === 'replay';
      if (replay) {
        const refusal = replayRefusal(intent);
        if (refusal) return { ok: false, class: NOT_REPLAYABLE, detail: refusal };
      }
      let random = opts.random;
      if (!random) {
        if (!Number.isSafeInteger(opts.seed)) throw new Error(`${name}: a seed is required`);
        const rng = makeRng(opts.seed);
        random = () => rng.next();
      }
      const collateral = opts.collateral || null;
      const trace = { costs: [], bundles: [] };
      const constraints = exactConstraints(T, { state, params, intent, bundleCoin, trace, collateral });
      const changeAddressResolver = { resolve: async (selection) => selection.change.map((c) => ({ ...c, address: state.changeAddress })) };
      const preSelected = replay ? cjsPreSelected(intent) : [];
      const fixedRefs = new Set(preSelected.map(refOfUtxo));
      let result;
      try {
        result = await roundRobinRandomImprove({ changeAddressResolver, random }).select({
          preSelectedUtxo: new Set(preSelected),
          utxo: new Set(inputOrder(state).filter((u) => !fixedRefs.has(u.ref)).map(cjsUtxo)),
          outputs: new Set(intent.requested.map(cjsTxOut)),
          constraints,
          implicitValue: replay ? cjsImplicitValue(intent.implicit) : {}
        });
      } catch (e) {
        if (e instanceof NotReplayable) return { ok: false, class: NOT_REPLAYABLE, detail: e.message };
        return { ok: false, class: classOfCjsError(e), detail: `roundRobinRandomImprove: ${errorText(e)}` };
      } finally {
        constraints.free();
      }
      const sel = result.selection;
      const refs = [...sel.inputs].map(refOfUtxo);
      const chosen = new Set(refs);
      for (const r of fixedRefs) if (!chosen.has(r)) return { ok: false, class: CLASSES.other, detail: `the library left out the pre-selected input ${r}` };
      const inputs = recordsOf(state, refs.filter((r) => !fixedRefs.has(r)));
      if (opts.changePolicy !== 'default') {
        const r = buildWithChange(T, { state, params, inputs, intent, policy: opts.changePolicy, collateral });
        if (!r.ok) return { ok: false, class: r.class, detail: `${opts.changePolicy} change on the library's inputs: ${r.detail}` };
        return { ok: true, kind: 'single', txs: [txRecord(r.bytes, inputs.map((u) => u.ref), r.fee, r.size, r.k)] };
      }
      const change = sel.change.map((c) => ({ address: c.address, coin: c.value.coins, assets: assetsOf(c.value.assets) }));
      for (const o of change) if (o.coin < 0n) return { ok: false, class: CLASSES.other, detail: `the library returned an output with coin ${o.coin}` };
      const library = (finalMinFee) => ({ fee: sel.fee, finalMinFee, costs: trace.costs, bundles: trace.bundles, change: sel.change.length });
      if (replay) {
        const a = constraints.replay.at(refs, change, sel.fee);
        if (!a.ok) return { ok: false, class: a.class, detail: a.detail };
        return { ok: true, kind: 'single', txs: [txRecord(a.bytes, inputs.map((u) => u.ref), sel.fee, a.size, a.k)], library: { ...library(minFee(params, a.size, intent.fixed ? intent.fixed.scriptFee : 0n)), preSelected: preSelected.length } };
      }
      const outputs = [...intent.requested.map((o) => ({ address: o.address, coin: o.coin, assets: o.assets })), ...change];
      for (const o of outputs) if (o.coin < 0n) return { ok: false, class: CLASSES.other, detail: `the library returned an output with coin ${o.coin}` };
      const a = assembleOnce(T, inputs, outputs, sel.fee);
      const size = inspectTx(a.bytes).size;
      return {
        ok: true,
        kind: 'single',
        txs: [txRecord(a.bytes, inputs.map((u) => u.ref), sel.fee, size, a.k)],
        library: library(minFee(params, size))
      };
    }
  };
}
