// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The ledger checks on every built transaction, read from its bytes without
// CSL, so that they are a second implementation beside the treatment's and the
// libraries' own. Each failed check is classified into one of the build
// failure classes. Ledger paths are in IntersectMBO/cardano-ledger at
// 391db20866113f08bc6317cb5c341304365986c6; the Conway UTXO rule runs the
// Babbage validation (eras/conway/impl/src/Cardano/Ledger/Conway/Rules/
// Utxo.hs:253, babbageUtxoValidation in eras/babbage/impl/src/Cardano/Ledger/
// Babbage/Rules/Utxo.hs:340-427).
//
//   size          |tx| <= maxTxSize (eras/shelley/impl/src/Cardano/Ledger/
//                 Shelley/Rules/Utxo.hs:570-585, validateMaxTxSizeUTxO), |tx|
//                 the ledger's size (fee.mjs)
//   value-size    every output's Value, re-serialized as the ledger does, at
//                 most maxValSize (eras/alonzo/impl/src/Cardano/Ledger/Alonzo/
//                 Rules/Utxo.hs:425-447, validateOutputTooBigUTxO); the
//                 collateral return included
//   minimum       every output's coin at least coinsPerUtxoByte * (160 + |o|),
//                 |o| the output's bytes as they sit in the transaction
//                 (eras/babbage/impl/src/Cardano/Ledger/Babbage/TxOut.hs:
//                 678-702, babbageMinUTxOValue; Babbage Utxo.hs:400)
//   inputs        every input and reference input resolves (Shelley
//                 validateBadInputsUTxO, Babbage Utxo.hs:390)
//   conservation  consumed = produced, coin and every asset: inputs,
//                 withdrawals and refunds, and mints, against outputs, the
//                 fee, deposits, the treasury donation and burns (Shelley
//                 Utxo.hs:513-529, validateValueNotConservedUTxO; eras/conway/
//                 impl/src/Cardano/Ledger/Conway/UTxO.hs:107-145,
//                 conwayProducedValue); the transaction's own withdrawals,
//                 mint and donation must equal the intent's
//   fee           fee >= minFeeA * |tx| + minFeeB + the script fee (Babbage
//                 Utxo.hs:183-212, feesOK part 1); a fee under it is its own
//                 class, fee-minimum, apart from balance: the network rejects
//                 the transaction although its value balances
//   witnesses     at least one vkey witness per distinct key payment
//                 credential among the inputs and the collateral inputs (both
//                 are spending inputs for this rule: eras/alonzo/impl/src/
//                 Cardano/Ledger/Alonzo/TxBody.hs:307-313,
//                 alonzoSpendableInputsTxBodyF; eras/shelley/impl/src/Cardano/
//                 Ledger/Shelley/UTxO.hs:205-227, inputAuthors), plus the
//                 intent's fixed witnesses (eras/shelley/impl/src/Cardano/
//                 Ledger/Shelley/Rules/Utxow.hs:420-434,
//                 validateNeededWitnesses). Witnesses
//                 here are synthetic, so they are counted, not verified; a key
//                 payment credential is spent with a vkey witness (CIP-0019,
//                 "Payment part").
//   aux-hash      the auxiliary data hash field is present exactly when
//                 auxiliary data is
//   collateral    when the transaction carries redeemers: at least one
//                 collateral input, at most maxCollateralInputs, every one at a
//                 key address, the balance (inputs less the return) ADA only,
//                 at least collateralPercent of the fee, and equal to the total
//                 collateral field when present (Babbage Utxo.hs:231-308,
//                 validateTotalCollateral and validateCollateralContainsNonADA;
//                 eras/babbage/impl/src/Cardano/Ledger/Babbage/Collateral.hs:
//                 30-39, collAdaBalance; Alonzo Utxo.hs:348-364 and 481-495)

import { inspectTx } from './inspect.mjs';
import { minFee } from './fee.mjs';
import { valueSize, assetMap, mergeAssets } from '../history/value.mjs';

export const CLASSES = Object.freeze({
  txSize: 'tx-size',
  valueSize: 'value-size',
  changeMinimum: 'change-minimum',
  maxInputs: 'max-inputs',
  balance: 'balance',
  feeMinimum: 'fee-minimum',
  collateral: 'collateral',
  timeLimit: 'time-limit',
  other: 'other'
});

const ZERO_IMPLICIT = Object.freeze({ withdrawals: 0n, refunds: 0n, deposits: 0n, donation: 0n, mint: [], burn: [] });

const sum = (xs) => xs.reduce((a, b) => a + b, 0n);
const sameAssets = (a, b) => {
  const x = assetMap(a);
  const y = assetMap(b);
  if (x.size !== y.size) return false;
  for (const [k, q] of x) if (y.get(k) !== q) return false;
  return true;
};

// The minimum coin of an output of `rawLength` bytes.
export const outputMinimum = (params, rawLength) => params.coinsPerUtxoByte * (160n + BigInt(rawLength));

// ctx:
//   params       the run's parameters (kit/params.mjs)
//   resolve      ref -> { coin, assets, addr } (addr as parseAddress gives it)
//                or undefined, for every input, reference input and
//                collateral input
//   implicit     { withdrawals, refunds, deposits, donation, mint, burn }
//   scriptFee    bigint, the intent's script fee
//   extraWitnesses  the number of vkey witnesses the intent's fixed parts
//                need beyond the inputs' key payment credentials
//   requested    a Set of output indexes that are requested outputs, which
//                classifies a minimum failure as 'other' rather than as change
export function checkTx(bytes, ctx) {
  const failures = [];
  const fail = (check, cls, detail) => failures.push({ check, cls, detail });
  let t;
  try {
    t = inspectTx(bytes);
  } catch (e) {
    return { ok: false, failures: [{ check: 'decode', cls: CLASSES.other, detail: String(e.message || e) }], facts: null };
  }
  const p = ctx.params;
  const imp = { ...ZERO_IMPLICIT, ...(ctx.implicit || {}) };
  const scriptFee = BigInt(ctx.scriptFee || 0n);

  if (t.size > p.maxTxSize) fail('size', CLASSES.txSize, `${t.size} bytes, limit ${p.maxTxSize}`);

  const allOutputs = t.outputs.map((o) => ({ ...o, label: `output ${o.index}` }));
  if (t.collateralReturn) allOutputs.push({ ...t.collateralReturn, index: null, label: 'collateral return' });
  for (const o of allOutputs) {
    const vb = valueSize(o.coin, o.assets);
    if (vb > p.maxValSize) fail('value-size', CLASSES.valueSize, `${o.label}: ${vb} value bytes, limit ${p.maxValSize}`);
    const min = outputMinimum(p, o.raw.length);
    if (o.coin < min) {
      const requested = ctx.requested && o.index !== null && ctx.requested.has(o.index);
      fail('minimum', requested ? CLASSES.other : CLASSES.changeMinimum, `${o.label}: coin ${o.coin} under its minimum ${min}`);
    }
  }

  const resolved = [];
  for (const x of t.inputs) {
    const r = ctx.resolve(x.ref);
    if (!r) fail('inputs', CLASSES.other, `input ${x.ref} does not resolve`);
    else resolved.push(r);
  }
  for (const x of t.referenceInputs) if (!ctx.resolve(x.ref)) fail('inputs', CLASSES.other, `reference input ${x.ref} does not resolve`);

  if (resolved.length === t.inputs.length) {
    const wd = sum(t.withdrawals.map((w) => w.coin));
    if (wd !== BigInt(imp.withdrawals)) fail('conservation', CLASSES.balance, `withdrawals ${wd} in the transaction, ${imp.withdrawals} in the intent`);
    if (t.donation !== BigInt(imp.donation)) fail('conservation', CLASSES.balance, `donation ${t.donation} in the transaction, ${imp.donation} in the intent`);
    const txMint = t.mint.filter((a) => a.qty > 0n);
    const txBurn = t.mint.filter((a) => a.qty < 0n).map((a) => ({ ...a, qty: -a.qty }));
    if (!sameAssets(txMint, imp.mint) || !sameAssets(txBurn, imp.burn)) fail('conservation', CLASSES.balance, 'the mint field differs from the intent\'s mint and burn');
    const coinIn = sum(resolved.map((r) => BigInt(r.coin))) + BigInt(imp.withdrawals) + BigInt(imp.refunds);
    const coinOut = sum(t.outputs.map((o) => o.coin)) + t.fee + BigInt(imp.deposits) + BigInt(imp.donation);
    if (coinIn !== coinOut) fail('conservation', CLASSES.balance, `coin: ${coinIn} consumed, ${coinOut} produced`);
    const aIn = mergeAssets(resolved.flatMap((r) => r.assets), imp.mint);
    const aOut = mergeAssets(t.outputs.flatMap((o) => o.assets), imp.burn);
    if (!sameAssets(aIn, aOut)) fail('conservation', CLASSES.balance, 'assets are not conserved');
  }

  const mf = minFee(p, t.size, scriptFee);
  if (t.fee < mf) fail('fee', CLASSES.feeMinimum, `fee ${t.fee} under the minimum ${mf}`);

  const keys = new Set();
  for (const r of resolved) if (r.addr && r.addr.paymentKind === 'key') keys.add(r.addr.payment);
  for (const x of t.collateralInputs) {
    const r = ctx.resolve(x.ref);
    if (r && r.addr && r.addr.paymentKind === 'key') keys.add(r.addr.payment);
  }
  const required = keys.size + (ctx.extraWitnesses || 0);
  if (t.vkeys.length < required) fail('witnesses', CLASSES.other, `${t.vkeys.length} vkey witnesses, ${required} needed`);

  if (t.hasAux !== t.auxHashField) fail('aux-hash', CLASSES.other, t.hasAux ? 'auxiliary data without its hash' : 'an auxiliary data hash without auxiliary data');

  if (t.redeemers.length) {
    const coll = [];
    for (const x of t.collateralInputs) {
      const r = ctx.resolve(x.ref);
      if (!r) fail('collateral', CLASSES.collateral, `collateral input ${x.ref} does not resolve`);
      else coll.push(r);
    }
    if (!t.collateralInputs.length) fail('collateral', CLASSES.collateral, 'no collateral input');
    if (t.collateralInputs.length > p.maxCollateralInputs) fail('collateral', CLASSES.collateral, `${t.collateralInputs.length} collateral inputs, limit ${p.maxCollateralInputs}`);
    for (const r of coll) if (!r.addr || r.addr.paymentKind !== 'key') fail('collateral', CLASSES.collateral, 'a collateral input is not at a key address');
    const ret = t.collateralReturn;
    const balCoin = sum(coll.map((r) => BigInt(r.coin))) - (ret ? ret.coin : 0n);
    const balAssets = mergeAssets(coll.flatMap((r) => r.assets), ret ? ret.assets.map((a) => ({ ...a, qty: -a.qty })) : []);
    if (balAssets.length) fail('collateral', CLASSES.collateral, 'the collateral balance carries native assets');
    if (100n * balCoin < BigInt(p.collateralPercent) * t.fee) fail('collateral', CLASSES.collateral, `collateral balance ${balCoin} under ${p.collateralPercent}% of the fee ${t.fee}`);
    if (t.totalCollateral !== null && t.totalCollateral !== balCoin) fail('collateral', CLASSES.collateral, `total collateral ${t.totalCollateral} differs from the balance ${balCoin}`);
  }

  return {
    ok: failures.length === 0,
    failures,
    facts: {
      hash: t.hash,
      size: t.size,
      serializedSize: t.serializedSize,
      fee: t.fee,
      minFee: mf,
      inputs: t.inputs.map((x) => x.ref),
      outputs: t.outputs.length,
      vkeys: t.vkeys.length,
      required,
      hasAux: t.hasAux
    }
  };
}

// The class a set of failures is reported under: the first failure's.
export const failureClass = (r) => (r.ok ? null : r.failures[0].cls);
