// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Parameters, fees, the core settings and the method contract. No CSL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeParams, SYNTHETIC_PARAMS, need, paramsJson } from '../../../src/kit/params.mjs';
import { minFee, maxFee, walletControlledFee, executionFee, refScriptFee, scriptFeeOf } from '../../../src/kit/fee.mjs';
import { simSettings, SIM_SETTINGS } from '../../../src/settings.mjs';
import { checkMethod, checkResult, checkOptions } from '../../../src/methods/contract.mjs';
import { paramsFromRow } from '../../../src/history/params.mjs';

const ROW = {
  epoch_no: 660, protocol_major: 10, min_fee_a: 44, min_fee_b: 155381, coins_per_utxo_size: '4310', max_val_size: '5000', max_tx_size: 16384,
  max_collateral_inputs: 3, collateral_percent: 150, price_mem: 0.0577, price_step: 0.0000721, min_fee_ref_script_cost_per_byte: 15,
  key_deposit: '2000000', pool_deposit: '500000000', drep_deposit: '500000000', gov_action_deposit: '100000000000'
};

test('parameters from the history reader\'s form', () => {
  const p = normalizeParams(paramsFromRow('mainnet', ROW));
  assert.equal(p.minFeeA, 44n);
  assert.equal(p.coinsPerUtxoByte, 4310n);
  assert.equal(p.maxTxSize, 16384);
  assert.deepEqual(p.priceMem, [577n, 10000n]);
  assert.deepEqual(p.priceStep, [721n, 10000000n]);
  assert.deepEqual(p.minFeeRefScriptCostPerByte, [15n, 1n]);
  assert.equal(p.govActionDeposit, 100000000000n);
  assert.equal(paramsJson(p).minFeeB, '155381');
  assert.throws(() => normalizeParams({ ...paramsFromRow('mainnet', ROW), maxTxSize: null }), /maxTxSize is missing/);
  assert.throws(() => normalizeParams({ ...paramsFromRow('mainnet', ROW), network: 'testnet' }), /unknown network/);
});

test('the synthetic parameters state only what was read', () => {
  assert.equal(SYNTHETIC_PARAMS.network, 'synthetic');
  assert.equal(SYNTHETIC_PARAMS.epoch, 659);
  assert.equal(SYNTHETIC_PARAMS.protocolMajor, null);
  assert.throws(() => need(SYNTHETIC_PARAMS, 'drepDeposit'), /not stated/);
  assert.throws(() => refScriptFee(SYNTHETIC_PARAMS, 100), /minFeeRefScriptCostPerByte is not stated/);
  assert.equal(refScriptFee(SYNTHETIC_PARAMS, 0), 0n);
});

test('the minimum fee, the largest fee and the wallet-controlled fee', () => {
  assert.equal(minFee(SYNTHETIC_PARAMS, 300), 44n * 300n + 155381n);
  assert.equal(minFee(SYNTHETIC_PARAMS, 300, 1000n), 44n * 300n + 155381n + 1000n);
  assert.equal(maxFee(SYNTHETIC_PARAMS), 876277n);
  assert.equal(walletControlledFee(SYNTHETIC_PARAMS, 500000n, { scriptFee: 100000n, fixedBytes: 1000 }), 500000n - 100000n - 44000n);
});

test('the execution term and the reference-script term on constructed cases', () => {
  const p = normalizeParams(paramsFromRow('mainnet', ROW));
  // 1,000,000 * 577/10000 + 500,000,000 * 721/10^7 = 57,700 + 36,050.
  assert.equal(executionFee(p, 1000000n, 500000000n), 93750n);
  // ceiling(0.0577 + 0.0000721) = 1.
  assert.equal(executionFee(p, 1n, 1n), 1n);
  // 15 per byte for the first 25,600 bytes, 18 for the next 25,600, 21.6
  // for the rest: 384,000 + 460,800 + 8,800 * 21.6 = 1,034,880.
  assert.equal(refScriptFee(p, 60000), 1034880n);
  assert.equal(refScriptFee(p, 25600), 384000n);
  // 25,601 bytes: 384,000 + 18, rounded down.
  assert.equal(refScriptFee(p, 25601), 384018n);
  // 10 bytes at 21.6 after two full tiers: floor(844,800 + 216) = 845,016.
  assert.equal(refScriptFee(p, 51210), 845016n);
  assert.equal(scriptFeeOf(p, { redeemers: [{ exUnits: [1000000n, 500000000n] }], refScriptBytes: 25600 }), 93750n + 384000n);
});

test('the core settings refuse what is not implemented', () => {
  assert.equal(simSettings().changeAddress, 'latest-key-base-received');
  assert.equal(Object.keys(SIM_SETTINGS).length, 18);
  assert.throws(() => simSettings({ recipients: 'enterprise' }), /not implemented/);
  assert.throws(() => simSettings({ nope: 1 }), /unknown setting/);
});

test('the method contract', () => {
  const m = checkMethod({ name: 'x', version: '1', deterministic: true, build() {} });
  assert.throws(() => checkMethod({ name: 'x', version: '1', build() {} }), /deterministic/);
  assert.throws(() => checkOptions({ changePolicy: 'ladder' }), /unknown change policy/);
  assert.equal(checkResult(m, { ok: false, class: 'balance' }).class, 'balance');
  assert.equal(checkResult(m, { ok: false, class: 'not-replayable' }).class, 'not-replayable');
  assert.throws(() => checkResult(m, { ok: false, class: 'nope' }), /unknown failure class/);
  assert.throws(() => checkResult(m, { ok: true, kind: 'single', txs: [] }), /no transactions/);
  assert.throws(() => checkResult(m, { ok: true, kind: 'single', txs: [{ bytes: 'zz', walletInputs: [], fee: 1n }] }), /not hex/);
  assert.throws(() => checkResult(m, { ok: true, kind: 'single', txs: [{ bytes: '00', walletInputs: [], fee: 1 }] }), /bigint/);
  assert.equal(checkResult(m, { ok: true, kind: 'chain', txs: [{ bytes: '00', walletInputs: [], fee: 1n }, { bytes: '01', walletInputs: [], fee: 1n }] }).kind, 'chain');
});
