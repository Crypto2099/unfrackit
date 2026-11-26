// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Protocol parameters in the simulator's form:
//
//   network                  'mainnet' | 'preprod' | 'synthetic'
//   epoch, protocolMajor     numbers (protocolMajor null where not stated)
//   minFeeA, minFeeB         bigint lovelace per byte and per transaction
//   coinsPerUtxoByte         bigint
//   maxValSize, maxTxSize    numbers of bytes
//   maxCollateralInputs      number
//   collateralPercent        number
//   priceMem, priceStep      rationals [num, den] of bigints
//   minFeeRefScriptCostPerByte  rational, or null where not stated
//   keyDeposit, poolDeposit, drepDeposit, govActionDeposit
//                            bigint lovelace, or null where not stated
//
// A history file carries them as db-sync gives them (history/params.mjs
// paramsFromRow: amounts as decimal strings, rationals as string pairs);
// normalizeParams converts. A field the code needs and finds null is an
// error, never a value filled in.

const big = (x, what) => {
  if (x === null || x === undefined) return null;
  if (typeof x === 'bigint') return x;
  if (typeof x === 'number' && Number.isSafeInteger(x)) return BigInt(x);
  if (typeof x === 'string' && /^[0-9]+$/.test(x)) return BigInt(x);
  throw new TypeError(`parameter ${what}: not a non-negative integer (${String(x)})`);
};
const num = (x, what) => {
  if (x === null || x === undefined) return null;
  const v = Number(x);
  if (!Number.isSafeInteger(v) || v < 0) throw new TypeError(`parameter ${what}: not a non-negative integer (${String(x)})`);
  return v;
};
const rat = (x, what) => {
  if (x === null || x === undefined) return null;
  if (!Array.isArray(x) || x.length !== 2) throw new TypeError(`parameter ${what}: not a [numerator, denominator] pair`);
  const r = [big(x[0], what), big(x[1], what)];
  if (r[1] === 0n) throw new RangeError(`parameter ${what}: zero denominator`);
  return Object.freeze(r);
};

const REQUIRED = ['minFeeA', 'minFeeB', 'coinsPerUtxoByte', 'maxValSize', 'maxTxSize', 'maxCollateralInputs', 'collateralPercent'];

export function normalizeParams(p) {
  if (!p || typeof p !== 'object') throw new TypeError('protocol parameters: not an object');
  if (!['mainnet', 'preprod', 'synthetic'].includes(p.network)) throw new TypeError(`protocol parameters: unknown network ${p.network}`);
  const out = Object.freeze({
    network: p.network,
    epoch: num(p.epoch, 'epoch'),
    protocolMajor: num(p.protocolMajor, 'protocolMajor'),
    minFeeA: big(p.minFeeA, 'minFeeA'),
    minFeeB: big(p.minFeeB, 'minFeeB'),
    coinsPerUtxoByte: big(p.coinsPerUtxoByte, 'coinsPerUtxoByte'),
    maxValSize: num(p.maxValSize, 'maxValSize'),
    maxTxSize: num(p.maxTxSize, 'maxTxSize'),
    maxCollateralInputs: num(p.maxCollateralInputs, 'maxCollateralInputs'),
    collateralPercent: num(p.collateralPercent, 'collateralPercent'),
    priceMem: rat(p.priceMem, 'priceMem'),
    priceStep: rat(p.priceStep, 'priceStep'),
    minFeeRefScriptCostPerByte: rat(p.minFeeRefScriptCostPerByte, 'minFeeRefScriptCostPerByte'),
    keyDeposit: big(p.keyDeposit, 'keyDeposit'),
    poolDeposit: big(p.poolDeposit, 'poolDeposit'),
    drepDeposit: big(p.drepDeposit, 'drepDeposit'),
    govActionDeposit: big(p.govActionDeposit, 'govActionDeposit')
  });
  for (const k of REQUIRED) if (out[k] === null) throw new TypeError(`protocol parameter ${k} is missing`);
  return out;
}

// A field that must be stated for the computation at hand.
export function need(params, field) {
  const v = params[field];
  if (v === null || v === undefined) throw new Error(`protocol parameter ${field} is not stated for this run (network ${params.network}, epoch ${params.epoch})`);
  return v;
}

// The synthetic shapes' parameters: mainnet at epoch 659 (Koios
// epoch_params, read 2026-10-04): min_fee_a 44, min_fee_b 155381,
// coins_per_utxo_size 4310, max_val_size 5000, max_tx_size 16384,
// max_collateral_inputs 3, collateral_percent 150; key_deposit, pool_deposit,
// price_mem and price_step as the treatment's defaults record them for the same
// epoch. The protocol version, the reference-script price and the governance
// deposits were not read, so they are null and any computation that needs one
// stops.
export const SYNTHETIC_PARAMS = normalizeParams({
  network: 'synthetic',
  epoch: 659,
  protocolMajor: null,
  minFeeA: 44,
  minFeeB: 155381,
  coinsPerUtxoByte: 4310,
  maxValSize: 5000,
  maxTxSize: 16384,
  maxCollateralInputs: 3,
  collateralPercent: 150,
  priceMem: [577, 10000],
  priceStep: [721, 10000000],
  minFeeRefScriptCostPerByte: null,
  keyDeposit: 2000000,
  poolDeposit: 500000000,
  drepDeposit: null,
  govActionDeposit: null
});

// The parameters as JSON (bigint as decimal strings).
export function paramsJson(p) {
  return JSON.parse(JSON.stringify(p, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
