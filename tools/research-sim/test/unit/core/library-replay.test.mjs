// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The library adapters' replay coverage: each adapter's statement of the
// intent parts its replay path covers, and the refusal of a part it does not
// cover, with the message every adapter that covers none has always given.
// No CSL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPLAY_PARTS, REPLAY_COVERAGE, partsOf, refuseUncovered } from '../../../src/methods/library.mjs';
import { ZERO_IMPLICIT } from '../../../src/state/intent.mjs';

const out = (extra = {}) => ({ cbor: '00', address: 'x', coin: 2000000n, assets: [], datum: null, scriptRef: null, ...extra });
const intent = (over = {}) => ({ source: 'replay', requested: [out()], implicit: ZERO_IMPLICIT, fixed: null, collateral: { required: false, observed: null }, ...over });
const FIXED = { inputs: [], referenceInputs: [], body: { 4: '80' }, witnesses: {}, redeemers: [], auxiliaryData: null, scriptFee: 0n, fixedBytes: 1 };
const TOKEN = { policy: 'cc'.repeat(28), name: '41', qty: 1n };

const MESSAGES = (name) => ({
  fixed: `${name}: the replay path (fixed parts and collateral) is not built yet`,
  implicit: `${name}: implicit values come only with fixed parts, whose path is not built yet`,
  outputData: `${name}: requested outputs with a datum or a script reference come only with replays, whose path is not built yet`
});

const CASES = {
  none: [intent(), null],
  fixed: [intent({ fixed: FIXED }), 'fixed'],
  collateral: [intent({ collateral: { required: true, observed: null } }), 'fixed'],
  withdrawals: [intent({ implicit: { ...ZERO_IMPLICIT, withdrawals: 1n } }), 'implicit'],
  refunds: [intent({ implicit: { ...ZERO_IMPLICIT, refunds: 1n } }), 'implicit'],
  deposits: [intent({ implicit: { ...ZERO_IMPLICIT, deposits: 1n } }), 'implicit'],
  donation: [intent({ implicit: { ...ZERO_IMPLICIT, donation: 1n } }), 'implicit'],
  mint: [intent({ implicit: { ...ZERO_IMPLICIT, mint: [TOKEN] } }), 'implicit'],
  burn: [intent({ implicit: { ...ZERO_IMPLICIT, burn: [TOKEN] } }), 'implicit'],
  datum: [intent({ requested: [out({ datum: { kind: 'inline', cbor: 'd87980' } })] }), 'outputData'],
  scriptRef: [intent({ requested: [out({ scriptRef: '00' })] }), 'outputData'],
  // The first uncovered part decides the message, in the order fixed parts
  // and collateral, implicit values, output data.
  fixedAndImplicit: [intent({ fixed: FIXED, implicit: { ...ZERO_IMPLICIT, deposits: 1n }, requested: [out({ datum: { kind: 'hash', hash: '00' } })] }), 'fixed'],
  implicitAndData: [intent({ implicit: { ...ZERO_IMPLICIT, mint: [TOKEN] }, requested: [out({ scriptRef: '00' })] }), 'implicit']
};

test('an intent\'s replay parts', () => {
  assert.deepEqual(REPLAY_PARTS, ['fixed', 'collateral', 'implicit', 'outputData']);
  assert.deepEqual(partsOf(CASES.none[0]), []);
  assert.deepEqual(partsOf(CASES.collateral[0]), ['collateral']);
  assert.deepEqual(partsOf(CASES.fixedAndImplicit[0]), ['fixed', 'implicit', 'outputData']);
  assert.deepEqual(partsOf(intent({ fixed: FIXED, collateral: { required: true, observed: null } })), ['fixed', 'collateral']);
});

test('CSL, the Evolution SDK and Mesh cover no replay part and refuse each with the messages they have always given', () => {
  for (const [mod, name] of [['csl', 'csl-lf'], ['csl', 'csl-ri-pure'], ['evo', 'evo-lf'], ['mesh', 'mesh-default']]) {
    assert.deepEqual(REPLAY_COVERAGE[mod], []);
    const msg = MESSAGES(name);
    for (const [c, [it, want]] of Object.entries(CASES)) {
      if (want === null) assert.doesNotThrow(() => refuseUncovered(name, REPLAY_COVERAGE[mod], it), c);
      else assert.throws(() => refuseUncovered(name, REPLAY_COVERAGE[mod], it), (e) => e.constructor === Error && e.message === msg[want], c);
    }
  }
});

test('an adapter refuses only the parts its statement leaves out', () => {
  const msg = MESSAGES('x');
  assert.doesNotThrow(() => refuseUncovered('x', REPLAY_PARTS, CASES.fixedAndImplicit[0]));
  assert.throws(() => refuseUncovered('x', ['fixed', 'collateral'], CASES.fixedAndImplicit[0]), { message: msg.implicit });
  assert.throws(() => refuseUncovered('x', ['fixed', 'collateral', 'implicit'], CASES.fixedAndImplicit[0]), { message: msg.outputData });
  assert.throws(() => refuseUncovered('x', ['fixed'], intent({ fixed: FIXED, collateral: { required: true, observed: null } })), { message: msg.fixed });
  assert.throws(() => refuseUncovered('x', ['mint'], CASES.none[0]), /unknown replay part mint/);
});
