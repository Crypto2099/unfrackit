// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The source check's difference test: a line only on the other side must be
// created by a later transaction, a line only in the database must be an input
// a later transaction spends; pointer addresses recognized from CIP-19's test
// vectors (cardano-foundation/CIPs@befcdb75, CIP-0019, "Test vectors").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explained, isPointerAddress } from '../../src/source-check.mjs';

const T1 = 'aa'.repeat(32);
const T2 = 'bb'.repeat(32);
const T3 = 'cc'.repeat(32);

test('explained: both sides must trace to later transactions', () => {
  const later = [{ tx_hash: T2 }];
  // The database still has T1#0, which T2 spends; the other side has T2#0.
  assert.equal(explained({ onlyA: [`${T1}#0:5000000:`], onlyB: [`${T2}#0:4800000:`] }, later, new Set([`${T1}#0`])), true);
  // T1#1 is only in the database, but no later transaction spends it.
  assert.equal(explained({ onlyA: [`${T1}#1:5000000:`], onlyB: [] }, later, new Set([`${T1}#0`])), false);
  // A line only on the other side from a transaction that is not later.
  assert.equal(explained({ onlyA: [], onlyB: [`${T3}#0:1:`] }, later, new Set()), false);
  // No later transaction explains nothing; equal sets are not "explained".
  assert.equal(explained({ onlyA: [`${T1}#0:1:`], onlyB: [] }, [], new Set([`${T1}#0`])), false);
  assert.equal(explained({ onlyA: [], onlyB: [] }, later, new Set()), false);
});

test('pointer addresses are CIP-19 types 4 and 5 on both networks', () => {
  const v = {
    'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x': false,
    'addr1z8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gten0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs9yc0hh': false,
    'addr1gx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5pnz75xxcrzqf96k': true,
    'addr128phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtupnz75xxcrtw79hu': true,
    'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8': false,
    'addr_test1gz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5pnz75xxcrdw5vky': true,
    'addr_test12rphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtupnz75xxcryqrvmw': true,
    'addr_test1xrphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gt7r0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs4p04xh': false
  };
  for (const [a, want] of Object.entries(v)) assert.equal(isPointerAddress(a), want, a);
});
