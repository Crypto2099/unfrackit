// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The per-spend measures H-7's drift criterion A reads, on hand-built spends
// with known answers: the largest Value and the count of every wallet UTxO
// consumed (fixed wallet inputs included), and the two minimums of the locking
// line. No CSL and no treatment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unspentOutput, encodeOutput } from '../../../src/history/output.mjs';
import { utxoFromCbor, addressTextOf } from '../../../src/state/utxo.mjs';
import { makeState } from '../../../src/state/state.mjs';
import { parseAddress } from '../../../src/history/address.mjs';
import { valueSize } from '../../../src/history/value.mjs';
import { spendMeasures } from '../../../src/replay/measure.mjs';
import { baseAddr, scriptAddr, keyHash, STAKE } from '../../lib/txcbor.mjs';

const ADA = 1000000n;
const P = { coinsPerUtxoByte: 4310n, minFeeA: 44n };
const A0 = baseAddr(keyHash(0));
const SCRIPT = scriptAddr('ab'.repeat(28));
const POL = 'cc'.repeat(28);
const tok = (name, qty = 1n) => ({ policy: POL, name, qty });
const X = '58';
const Y = '59';
const minOf = (address, coin, assets) => P.coinsPerUtxoByte * (160n + BigInt(encodeOutput({ address, coin, assets }, 'array').length));

const utxo = (txid, i, address, coin, assets = []) => utxoFromCbor(unspentOutput(txid.repeat(32), i, encodeOutput({ address, coin, assets }, 'array')).toString('hex'), { origin: 'initial' });
const stateOf = (utxos) => makeState({ network: 'synthetic', stakeCred: STAKE, changeAddress: addressTextOf(A0), utxos });
const outputOf = (index, address, coin, assets = []) => ({ index, address, addr: parseAddress(address), coin, assets, raw: encodeOutput({ address, coin, assets }, 'array') });
const requested = (assets) => ({ requested: [{ address: 'addr_test1external', coin: 2n * ADA, assets, wallet: false }], implicit: { mint: [] }, fixed: null });

test('a fixed wallet input at a script payment credential counts, and the method inputs stay as they were', () => {
  const pure = utxo('01', 0, A0, 9n * ADA);
  const held = utxo('02', 0, SCRIPT, 3n * ADA, [tok(X)]);
  const state = stateOf([pure, held]);
  const intent = { ...requested([]), fixed: { inputs: [{ ref: held.ref, held: true }, { ref: 'ff'.repeat(32) + '#0', held: false }] } };
  const tx = { outputs: [outputOf(0, A0, 3n * ADA, [tok(X)]), outputOf(1, A0, 5n * ADA)] };
  const m = spendMeasures(state, intent, tx, [pure.ref], P, new Set());
  assert.equal(m.inputs, 1);
  assert.equal(m.consumedWalletInputs, 2);
  assert.equal(m.changeOutputs.count, 2);
  assert.equal(m.largestConsumedValueBytes, valueSize(3n * ADA, [tok(X)]));
  assert.equal(m.changeTokenMinimum, minOf(A0, 3n * ADA, [tok(X)]));
  assert.equal(m.consumedTokenMinimum, minOf(SCRIPT, 3n * ADA, [tok(X)]));
});

test('a method input that is also a fixed input counts once', () => {
  const a = utxo('01', 0, A0, 9n * ADA);
  const state = stateOf([a]);
  const intent = { ...requested([]), fixed: { inputs: [{ ref: a.ref, held: false }] } };
  const m = spendMeasures(state, intent, { outputs: [outputOf(0, A0, 7n * ADA)] }, [a.ref], P, new Set());
  assert.equal(m.consumedWalletInputs, 1);
  assert.equal(m.changeTokenMinimum, 0n);
  assert.equal(m.consumedTokenMinimum, 0n);
});

test('the largest consumed Value is the largest input, not the change', () => {
  const many = Array.from({ length: 150 }, (_, i) => tok(`${(i + 256).toString(16)}`.repeat(16).slice(0, 64)));
  const big = utxo('01', 0, A0, 20n * ADA, many);
  const small = utxo('02', 0, A0, 5n * ADA);
  const state = stateOf([big, small]);
  const m = spendMeasures(state, requested([]), { outputs: [outputOf(0, A0, 24n * ADA, many)] }, [big.ref, small.ref], P, new Set());
  assert.equal(m.largestConsumedValueBytes, valueSize(20n * ADA, many));
  assert.ok(m.largestConsumedValueBytes > 0.8 * 5000, 'the input is near the cap');
  assert.equal(m.changeOutputs.largestValueBytes, valueSize(24n * ADA, many));
  assert.equal(m.consumedWalletInputs, 2);
});

test('the minimum of a consumed UTxO leaves out the tokens the spend sends away', () => {
  const both = utxo('01', 0, A0, 4n * ADA, [tok(X), tok(Y)]);
  const onlyX = utxo('02', 0, A0, 3n * ADA, [tok(X)]);
  const state = stateOf([both, onlyX]);
  const tx = { outputs: [outputOf(0, A0, 5n * ADA, [tok(Y)])] };
  const m = spendMeasures(state, requested([tok(X, 2n)]), tx, [both.ref, onlyX.ref], P, new Set());
  assert.equal(m.consumedTokenMinimum, minOf(A0, 4n * ADA, [tok(Y)]), 'only Y is still held, and the UTxO that held only X adds nothing');
  assert.equal(m.changeTokenMinimum, minOf(A0, 5n * ADA, [tok(Y)]));
});

test('a token only partly sent stays in the minimum of the UTxO it came from', () => {
  const a = utxo('01', 0, A0, 4n * ADA, [tok(X, 5n)]);
  const state = stateOf([a]);
  const tx = { outputs: [outputOf(0, A0, 4n * ADA, [tok(X, 3n)])] };
  const m = spendMeasures(state, requested([tok(X, 2n)]), tx, [a.ref], P, new Set());
  assert.equal(m.consumedTokenMinimum, minOf(A0, 4n * ADA, [tok(X, 5n)]));
  assert.equal(m.changeTokenMinimum, minOf(A0, 4n * ADA, [tok(X, 3n)]));
});

test('ADA-only change adds no change minimum', () => {
  const a = utxo('01', 0, A0, 9n * ADA);
  const m = spendMeasures(stateOf([a]), requested([]), { outputs: [outputOf(0, A0, 7n * ADA)] }, [a.ref], P, new Set());
  assert.equal(m.changeTokenMinimum, 0n);
});
