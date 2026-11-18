// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Protocol parameters from cardano-db-sync's epoch_param row (doc/schema.md,
// epoch_param, at tag 13.7.3.0), and the fee terms computed from them.
//
// db-sync stores the execution prices and the reference-script price as
// doubles. The ledger's values are rationals (cardano-ledger at
// 391db20866113f08bc6317cb5c341304365986c6, libs/cardano-ledger-core/src/
// Cardano/Ledger/Plutus/ExUnits.hs, Prices); each is recovered as the fraction
// with the smallest power-of-ten denominator whose double is the stored
// double, and refused when none up to 10^15 is.

// A Params object, in the simulator's form: amounts as decimal strings,
// counts and sizes as numbers, rationals as [numerator, denominator] strings.
export function rationalOf(x, what) {
  if (x === null || x === undefined) return null;
  const v = Number(x);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${what}: not a non-negative number`);
  for (let k = 0; k <= 15; k++) {
    const d = 10 ** k;
    const n = Math.round(v * d);
    if (Number.isSafeInteger(n) && n / d === v) {
      let a = BigInt(n);
      let b = BigInt(d);
      const g = gcd(a, b);
      if (g > 1n) {
        a /= g;
        b /= g;
      }
      return [a.toString(), b.toString()];
    }
  }
  throw new Error(`${what}: ${v} is not a decimal fraction with at most 15 places`);
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
}

const str = (x) => (x === null || x === undefined ? null : BigInt(x).toString());
const num = (x) => (x === null || x === undefined ? null : Number(x));

export function paramsFromRow(network, row) {
  return {
    network,
    epoch: num(row.epoch_no),
    protocolMajor: num(row.protocol_major),
    minFeeA: str(row.min_fee_a),
    minFeeB: str(row.min_fee_b),
    coinsPerUtxoByte: str(row.coins_per_utxo_size),
    maxValSize: num(row.max_val_size),
    maxTxSize: num(row.max_tx_size),
    maxCollateralInputs: num(row.max_collateral_inputs),
    collateralPercent: num(row.collateral_percent),
    priceMem: rationalOf(row.price_mem, 'price_mem'),
    priceStep: rationalOf(row.price_step, 'price_step'),
    minFeeRefScriptCostPerByte: rationalOf(row.min_fee_ref_script_cost_per_byte, 'min_fee_ref_script_cost_per_byte'),
    keyDeposit: str(row.key_deposit),
    poolDeposit: str(row.pool_deposit),
    drepDeposit: str(row.drep_deposit),
    govActionDeposit: str(row.gov_action_deposit)
  };
}

// The rule that set an output's minimum in the era of its transaction: Mary
// (protocol major 4 and below), Alonzo (5 and 6), Babbage and Conway (7 on).
export function minUtxoRule(protocolMajor) {
  if (protocolMajor <= 4) return 'mary';
  if (protocolMajor <= 6) return 'alonzo';
  return 'babbage-conway';
}

// ceiling(n / d) for non-negative BigInts.
const ceilDiv = (n, d) => (n + d - 1n) / d;

// The execution term: ceiling(priceMem * mem + priceStep * steps), exactly
// (libs/cardano-ledger-core/src/Cardano/Ledger/Plutus/ExUnits.hs:198-203,
// txscriptfee).
export function executionFee(params, mem, steps) {
  const [pmn, pmd] = params.priceMem.map(BigInt);
  const [psn, psd] = params.priceStep.map(BigInt);
  const num = BigInt(mem) * pmn * psd + BigInt(steps) * psn * pmd;
  return ceilDiv(num, pmd * psd);
}

// The reference-script term of the Conway minimum fee
// (eras/conway/impl/src/Cardano/Ledger/Conway/Tx.hs:105-145, getConwayMinFeeTx
// and tierRefScriptFee): the price per byte grows by the factor 1.2 for every
// further 25,600 bytes (the constants ppRefScriptCostMultiplierG and
// ppRefScriptCostStrideG, eras/conway/impl/src/Cardano/Ledger/Conway/
// PParams.hs:984-985), and the sum is rounded down.
export const REF_SCRIPT_MULTIPLIER = [6n, 5n];
export const REF_SCRIPT_STRIDE = 25600;

export function refScriptFee(params, size) {
  if (!params.minFeeRefScriptCostPerByte) return 0n;
  let [pn, pd] = params.minFeeRefScriptCostPerByte.map(BigInt);
  // acc as a rational accN / accD.
  let accN = 0n;
  let accD = 1n;
  let n = BigInt(size);
  const stride = BigInt(REF_SCRIPT_STRIDE);
  for (;;) {
    if (n < stride) {
      // floor(acc + n * price)
      const totN = accN * pd + n * pn * accD;
      const totD = accD * pd;
      return totN / totD;
    }
    // acc += stride * price; price *= multiplier
    accN = accN * pd + stride * pn * accD;
    accD = accD * pd;
    const g = gcd(accN, accD) || 1n;
    accN /= g;
    accD /= g;
    pn *= REF_SCRIPT_MULTIPLIER[0];
    pd *= REF_SCRIPT_MULTIPLIER[1];
    const h = gcd(pn, pd) || 1n;
    pn /= h;
    pd /= h;
    n -= stride;
  }
}

// The value-size limit in force: max_val_size from Alonzo on; before it the
// Mary era's 4,000-byte constant of the ledger code, which the Allegra UTXO
// rule applies to the serialized Value
// (eras/allegra/impl/src/Cardano/Ledger/Allegra/Rules/Utxo.hs:212-218 and
// :249-264, validateOutputTooBigUTxO).
export function valueLimit(row) {
  if (row.max_val_size !== null && row.max_val_size !== undefined) return Number(row.max_val_size);
  if (Number(row.protocol_major) === 4) return 4000;
  return null;
}
