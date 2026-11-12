// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The wallets `replay --shapes` takes: `all` is the 21
// fixed shapes; a list names fixed shapes and heavy wallets H<k>E<e>
// (src/shapes/heavy.mjs). A name the generator does not make, or a heavy
// name longer than a record's wallet field can carry, is refused before the
// treatment is loaded. No treatment and no CSL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeNamesOf, cmdReplay } from '../../../src/replay/commands.mjs';
import { SHAPE_NAMES } from '../../../src/shapes/shapes.mjs';
import { recordKey } from '../../../src/out/records.mjs';

const key = (wallet) => ({ wallet, window: 'synthetic', arm: 'observed', variant: 'default', method: 'csl-lf', change: 'default', collateral: 'ledger', repetition: 1 });

test('--shapes all is the 21 fixed shapes; a list takes fixed shapes and heavy wallets', () => {
  assert.deepEqual(shapeNamesOf('all'), [...SHAPE_NAMES]);
  assert.equal(shapeNamesOf('all').length, 21);
  assert.deepEqual(shapeNamesOf('S1,H20E05,M2,H3E6,H20E01,H1E05,H30E1'), ['S1', 'H20E05', 'M2', 'H3E6', 'H20E01', 'H1E05', 'H30E1']);
  // Each heavy name it accepts is one a record can carry.
  for (const n of ['H20E05', 'H3E6', 'H20E01', 'H30E99']) assert.doesNotThrow(() => recordKey(key(shapeNamesOf(n)[0])), n);
});

test('a name the generator does not make, or one too long for a record, is refused', () => {
  for (const n of ['X1', 'H0E1', 'H31E1', 'H20E0', 'H2E0009', 'H20', 'h20e05', 'S1 ']) assert.throws(() => shapeNamesOf(n), /^Error: unknown shape .*: --shapes takes all, a fixed shape or a heavy wallet H<k>E<e>/, n);
  // H20E005 (50 events) and H20E001 (10) are wallets the generator makes, in
  // seven characters.
  assert.throws(() => shapeNamesOf('S1,H20E005'), /heavy wallet H20E005: a record names a shape in at most six characters/);
  assert.throws(() => shapeNamesOf('H20E001'), /heavy wallet H20E001: a record names a shape in at most six characters/);
  assert.throws(() => recordKey(key('H20E005')), /is not a shape name/);
});

test('the commands refuse a bad name before they load the treatment', async () => {
  await assert.rejects(cmdReplay({ treatment: '/nonexistent', plan: 'test', shapes: 'H20E005' }), /a record names a shape in at most six characters/);
  await assert.rejects(cmdReplay({ treatment: '/nonexistent', plan: 'test', shapes: 'S1,H99E1' }), /unknown shape H99E1/);
});
