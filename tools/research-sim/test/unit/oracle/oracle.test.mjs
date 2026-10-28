// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The oracle's parts that need no treatment: its settings, the spends it
// refuses, the input bytes and counts the bounds rest on, and the method to
// policy mapping. The searches themselves need cardano-serialization-lib and
// are checked in test/oracle/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oracleSettings, ORACLE_SETTINGS } from '../../../src/oracle/settings.mjs';
import { checkSpend, OracleRefusal } from '../../../src/oracle/spend.mjs';
import { inputBytes } from '../../../src/oracle/bound.mjs';
import { leastCount } from '../../../src/oracle/mip.mjs';
import { policyOfMethod } from '../../../src/oracle/policies.mjs';

const spend = (over = {}) => ({ source: 'battery', requested: [{ cbor: '82', address: 'x', coin: 1n, assets: [], datum: null, scriptRef: null }], implicit: { withdrawals: 0n, refunds: 0n, deposits: 0n, donation: 0n, mint: [], burn: [] }, fixed: null, collateral: { required: false }, ...over });

test('settings: the defaults are the recommended answers, other values are refused', () => {
  assert.deepEqual(oracleSettings(), ORACLE_SETTINGS);
  assert.equal(ORACLE_SETTINGS.searchSpace, 'requested-plus-20');
  assert.equal(ORACLE_SETTINGS.exactness, 'library-forced');
  assert.equal(ORACLE_SETTINGS.solver, 'highs-1.15.4');
  assert.equal(ORACLE_SETTINGS.incumbents, 'all-methods');
  assert.equal(oracleSettings({ setFee: 'ledger-minimum' }).setFee, 'ledger-minimum');
  assert.throws(() => oracleSettings({ searchSpace: 'all' }), /not implemented/);
  assert.throws(() => oracleSettings({ nope: 1 }), /unknown oracle setting/);
});

test('spends: battery spends only, with requested outputs and nothing else', () => {
  assert.equal(checkSpend(spend()).source, 'battery');
  assert.throws(() => checkSpend(spend({ source: 'replay' })), OracleRefusal);
  assert.throws(() => checkSpend(spend({ fixed: { inputs: [] } })), OracleRefusal);
  assert.throws(() => checkSpend(spend({ collateral: { required: true } })), OracleRefusal);
  assert.throws(() => checkSpend(spend({ implicit: { withdrawals: 1n, refunds: 0n, deposits: 0n, donation: 0n, mint: [], burn: [] } })), OracleRefusal);
  assert.throws(() => checkSpend(spend({ requested: [] })), OracleRefusal);
  assert.throws(() => checkSpend(spend({ requested: [{ cbor: '82', assets: [], datum: { kind: 'hash' }, scriptRef: null }] })), OracleRefusal);
});

test('an input is 36, 37 or 38 bytes by its index', () => {
  assert.equal(inputBytes(0), 36);
  assert.equal(inputBytes(23), 36);
  assert.equal(inputBytes(24), 37);
  assert.equal(inputBytes(255), 37);
  assert.equal(inputBytes(256), 38);
});

test('the least count of values that reach a need, largest first', () => {
  assert.equal(leastCount([5n, 1n, 3n], 0n), 0);
  assert.equal(leastCount([5n, 1n, 3n], 5n), 1);
  assert.equal(leastCount([5n, 1n, 3n], 6n), 2);
  assert.equal(leastCount([5n, 1n, 3n], 9n), 3);
  assert.equal(leastCount([5n, 1n, 3n], 10n), null);
  assert.equal(leastCount([-4n, 2n], 2n), 1);
});

test('each method maps to the change policy its reference uses', () => {
  assert.equal(policyOfMethod('csl-lf', 'default'), 'csl');
  assert.equal(policyOfMethod('csl-ri', 'default'), 'csl');
  assert.equal(policyOfMethod('csl-lf-pure', 'default'), 'csl-ppc');
  assert.equal(policyOfMethod('cjs-rrri', 'default'), 'cjs');
  assert.equal(policyOfMethod('evo-lf', 'default'), 'evo');
  assert.equal(policyOfMethod('unfrackit-h12', 'default'), 'layout');
  assert.equal(policyOfMethod('cjs-rrri', 'layout'), 'layout');
  assert.equal(policyOfMethod('csl-lf', 'single'), null);
});
