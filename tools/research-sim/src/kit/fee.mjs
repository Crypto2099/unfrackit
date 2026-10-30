// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Fees. Ledger paths are in IntersectMBO/cardano-ledger at
// 391db20866113f08bc6317cb5c341304365986c6.
//
// The minimum fee of a transaction is minFeeA * |tx| + minFeeB plus its script
// fee (eras/alonzo/impl/src/Cardano/Ledger/Alonzo/Tx.hs:498-508,
// alonzoMinFeeTx; eras/conway/impl/src/Cardano/Ledger/Conway/Tx.hs:105-145,
// getConwayMinFeeTx, which adds the reference-script term), where |tx| is the
// ledger's size: the length of [body, witness set, auxiliary data or null] as
// a three-element list, the validity flag left out
// (eras/alonzo/impl/src/Cardano/Ledger/Alonzo/Tx.hs:377-385 and :482-496,
// sizeAlonzoTxF and toCBORForSizeComputation). A transaction serialized with
// the flag is one byte longer than |tx|.
//
// The script fee of a replayed script spend is the execution term
// ceiling(priceMem * mem + priceStep * steps)
// (libs/cardano-ledger-core/src/Cardano/Ledger/Plutus/ExUnits.hs:198-203)
// plus the reference-script term, whose price per byte grows by 1.2 for every
// further 25,600 bytes (Conway/Tx.hs:105-145, tierRefScriptFee) over the
// reference scripts of the inputs and reference inputs
// (eras/conway/impl/src/Cardano/Ledger/Conway/UTxO.hs:149-171). Both terms are
// computed once per intent under the run's parameters and held constant across
// arms; history/params.mjs implements them and the history reader stores the
// sum as the intent's scriptFee.
//
// The wallet-controlled fee is the fee less the script fee and less minFeeA
// times the bytes of the intent's fixed parts: what the selector and the
// layout decide.

import { executionFee as execFee, refScriptFee as refFee } from '../history/params.mjs';
import { need } from './params.mjs';

export function minFee(params, size, scriptFee = 0n) {
  return params.minFeeA * BigInt(size) + params.minFeeB + BigInt(scriptFee);
}

// The fee of one transaction of the largest size.
export const maxFee = (params) => params.minFeeA * BigInt(params.maxTxSize) + params.minFeeB;

export function walletControlledFee(params, fee, { scriptFee = 0n, fixedBytes = 0 } = {}) {
  return BigInt(fee) - BigInt(scriptFee) - params.minFeeA * BigInt(fixedBytes);
}

export function executionFee(params, mem, steps) {
  need(params, 'priceMem');
  need(params, 'priceStep');
  return execFee(params, mem, steps);
}

export function refScriptFee(params, bytes) {
  if (BigInt(bytes) === 0n) return 0n;
  need(params, 'minFeeRefScriptCostPerByte');
  return refFee(params, Number(bytes));
}

// The script fee of an intent recomputed from its redeemers and reference
// script bytes, for the check against the fee the history reader stored.
export function scriptFeeOf(params, fixed) {
  if (!fixed) return 0n;
  let mem = 0n;
  let steps = 0n;
  for (const r of fixed.redeemers || []) {
    mem += BigInt(r.exUnits[0]);
    steps += BigInt(r.exUnits[1]);
  }
  const exec = (fixed.redeemers || []).length ? executionFee(params, mem, steps) : 0n;
  return exec + refScriptFee(params, fixed.refScriptBytes || 0);
}
