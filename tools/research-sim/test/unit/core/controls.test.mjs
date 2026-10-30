// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The negative controls of src/kit/controls.mjs on constructed transactions:
// each is caught by its own check; a transaction with no outputs, whose
// leftover the fee absorbs, has neither a fee nor a value control. No CSL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { negativeControls, EXPECTED } from '../../../src/kit/controls.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { minFee } from '../../../src/kit/fee.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { parseAddress } from '../../../src/history/address.mjs';
import { tx, input, out, baseAddr, keyHash } from '../../lib/txcbor.mjs';

const P = SYNTHETIC_PARAMS;
const TXA = 'a1'.repeat(32);
const ADDR0 = baseAddr(keyHash(0));
const EXT = baseAddr('ee'.repeat(28), 'ef'.repeat(28));
const resolve = (coin) => (ref) => (ref === `${TXA}#0` ? { coin, assets: [], addr: parseAddress(ADDR0) } : undefined);
const state = { utxos: new Map() };

// A one-input transaction at its minimum fee: with an output taking the
// rest, or with none (the input is the fee).
function make(coin, withOutput) {
  let fee = 200000n;
  let bytes;
  for (let i = 0; i < 6; i++) {
    const outs = withOutput ? [out(EXT, coin - fee)] : [];
    bytes = tx({ inputs: [input(TXA, 0)], outputs: outs, fee: withOutput ? fee : coin, vkeys: 1 }).toString('hex');
    if (!withOutput) break;
    const need = minFee(P, inspectTx(bytes).size, 0n);
    if (need === fee) break;
    fee = need;
  }
  return bytes;
}

test('each control is caught by its own check on a transaction with an output', () => {
  const c = negativeControls(state, P, make(5000000n, true), { resolve: resolve(5000000n) });
  assert.deepEqual(c, EXPECTED);
});

test('a transaction with no outputs has no fee or value control, and the size and witness controls are caught', () => {
  const c = negativeControls(state, P, make(300000n, false), { resolve: resolve(300000n) });
  assert.equal(c.base, '');
  assert.equal(c.fee, null);
  assert.equal(c.value, null);
  assert.equal(c.size, EXPECTED.size);
  assert.equal(c.witnesses, EXPECTED.witnesses);
});
