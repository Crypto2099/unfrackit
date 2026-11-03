// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The draw plan: the randomness stabilization window from k and f, the
// cutoff slot, and N = E + 1 or E + 2.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomnessStabilisationWindow, drawPlan, parseDecimal, sameRatio } from '../src/draw.mjs';

const MAINNET = { securityParam: 2160, activeSlotCoeff: '0.05', epochLength: 432000, protocolMajor: 10 };

test('the window is ceiling(4k/f) from the genesis parameters, for Conway only', () => {
  assert.equal(randomnessStabilisationWindow({ ...MAINNET }), 172800);
  assert.equal(randomnessStabilisationWindow({ securityParam: 432, activeSlotCoeff: '0.1', protocolMajor: 9 }), 17280);
  assert.equal(randomnessStabilisationWindow({ securityParam: 5, activeSlotCoeff: '0.3', protocolMajor: 11 }), 67, 'ceiling of 66.67');
  assert.throws(() => randomnessStabilisationWindow({ ...MAINNET, protocolMajor: 8 }), /Conway \(protocol versions 9, 10, 11\) only/);
  assert.throws(() => randomnessStabilisationWindow({ ...MAINNET, protocolMajor: 12 }), /protocol version 12/);
  assert.deepEqual(parseDecimal('0.05'), { num: 5n, den: 100n });
  assert.ok(sameRatio('0.05', '0.050'));
  assert.throws(() => parseDecimal('5e-2'), /plain decimal/);
});

test('mainnet: the cutoff is 259,200 slots into the epoch; a block before it keys E + 1, at or after it E + 2', () => {
  const first = 4492800 + (600 - 208) * 432000; // first slot of epoch 600
  const at = (epochSlot) => drawPlan({ ...MAINNET, slot: first + epochSlot, epoch: 600, epochSlot });
  const before = at(259199);
  assert.equal(before.epoch_first_slot, first);
  assert.equal(before.cutoff_slot, first + 259200);
  assert.equal(before.nonce_epoch, 601);
  assert.equal(before.nonce_epoch_first_slot, first + 432000);
  assert.equal(at(0).nonce_epoch, 601);
  assert.equal(at(259200).nonce_epoch, 602);
  assert.equal(at(259200).nonce_epoch_first_slot, first + 2 * 432000);
  assert.equal(at(431999).nonce_epoch, 602);
});

test('the plan refuses inconsistent facts', () => {
  assert.throws(() => drawPlan({ ...MAINNET, slot: 10, epoch: 1, epochSlot: 432000 }), /inconsistent/);
  assert.throws(() => drawPlan({ ...MAINNET, slot: 10, epoch: 1, epochSlot: 11 }), /inconsistent/);
  assert.throws(() => drawPlan({ ...MAINNET, securityParam: 2160, activeSlotCoeff: '0.01', slot: 10, epoch: 1, epochSlot: 5 }), /not shorter than the epoch/);
});
