// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The wallets the history command refuses before reading any: one the
// extraction's reconstruction check excluded, and one in the confirmation
// split unless the analysis-freeze transaction is given. Synthetic ids only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refuseWallets } from '../../../src/history/commands.mjs';

const FREEZE = 'f'.repeat(64);
const samples = new Map([
  [1, { split: 'analysis', excluded: false }],
  [2, { split: 'analysis', excluded: true }],
  [3, { split: 'confirmation', excluded: false }],
  [4, { split: 'confirmation', excluded: true }]
]);

test('a wallet the reconstruction check excluded is refused, with or without the freeze transaction', () => {
  assert.throws(() => refuseWallets([2], samples, null), /reconstruction check excluded it/);
  assert.throws(() => refuseWallets([2], samples, FREEZE), /reconstruction check excluded it/);
  assert.throws(() => refuseWallets([4], samples, FREEZE), /reconstruction check excluded it/);
  assert.throws(() => refuseWallets([1, 2], samples, null), /wallet 2/);
});

test('a confirmation-split wallet is refused without the freeze transaction and accepted with it', () => {
  assert.throws(() => refuseWallets([3], samples, null), /confirmation split/);
  assert.throws(() => refuseWallets([3], samples, undefined), /--analysis-freeze-tx/);
  assert.doesNotThrow(() => refuseWallets([3], samples, FREEZE));
});

test('a wallet outside the samples is accepted, and so is any wallet when the study tables are not readable', () => {
  assert.doesNotThrow(() => refuseWallets([99], samples, null));
  assert.doesNotThrow(() => refuseWallets([1], samples, null));
  assert.doesNotThrow(() => refuseWallets([2, 3], null, null));
});
