// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean


// The census row of one wallet (censusRow) on synthetic UTxO rows: counts,
// near-cap shares, locked and excess ADA, and the wallet's total lovelace.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { censusRow } from '../../../src/history/reports.mjs';
import { valueSize } from '../../../src/history/value.mjs';

const POLICY = 'aa'.repeat(28);
const tok = (name, qty = 1) => ({ policy: POLICY, name, qty: BigInt(qty) });
// Minimum ADA stand-in: 1,000,000 plus 100,000 per token.
const minAda = (r) => 1_000_000n + 100_000n * BigInt(r.assets.length);

test('the row sums the wallet\'s coin and splits locked from excess ADA', () => {
  const us = [
    { coin: 5_000_000n, assets: [] },
    { coin: 3_000_000n, assets: [tok('01'), tok('02')] },
    { coin: 1_100_000n, assets: [tok('03')] }
  ];
  const r = censusRow(7, us, null, minAda);
  assert.equal(r.wallet, 7);
  assert.equal(r.utxos, 3);
  assert.equal(r.tokenUtxos, 2);
  assert.equal(r.coin, 9_100_000n);
  assert.equal(r.lockedAda, 1_200_000n + 1_100_000n);
  assert.equal(r.excessAda, (3_000_000n - 1_200_000n) + 0n);
  assert.equal(r.largestValueBytes, valueSize(3_000_000n, us[1].assets));
  assert.deepEqual([r.nearCap50, r.nearCap80, r.nearCap90], [false, false, false]);
});

test('near-cap shares use the largest value against the limit; no limit is never near', () => {
  const us = [{ coin: 2_000_000n, assets: [tok('01'), tok('02'), tok('03')] }, { coin: 2_000_000n, assets: [] }];
  const big = valueSize(2_000_000n, us[0].assets);
  const at = (limit) => censusRow(1, us, limit, minAda);
  assert.deepEqual([at(big * 2 - 1).nearCap50, at(big * 2).nearCap50], [true, false]);
  const r = at(Math.floor(big * 100 / 85));
  assert.deepEqual([r.nearCap50, r.nearCap80, r.nearCap90], [true, true, false]);
  const n = at(null);
  assert.deepEqual([n.nearCap50, n.nearCap80, n.nearCap90], [false, false, false]);
});

test('a wallet with no UTxO has a zero row, and an ADA-only wallet locks nothing', () => {
  const z = censusRow(2, [], 1000, minAda);
  assert.deepEqual([z.utxos, z.tokenUtxos, z.largestValueBytes, z.coin, z.lockedAda, z.excessAda], [0, 0, 0, 0n, 0n, 0n]);
  const a = censusRow(3, [{ coin: 4_000_000n, assets: [] }, { coin: 6_000_000n, assets: [] }], 1000, minAda);
  assert.deepEqual([a.coin, a.lockedAda, a.excessAda, a.tokenUtxos], [10_000_000n, 0n, 0n, 0]);
});
