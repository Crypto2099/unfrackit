// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A chained answer measured as one spend (chainView), on a hand-built chain
// with known answers, and the count of spendable UTxOs each spend record
// carries (held ones left out).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unspentOutput, encodeOutput } from '../../../src/history/output.mjs';
import { utxoFromCbor, addressTextOf, utxoFromOutput } from '../../../src/state/utxo.mjs';
import { makeState } from '../../../src/state/state.mjs';
import { parseAddress, addressBytes } from '../../../src/history/address.mjs';
import { valueSize } from '../../../src/history/value.mjs';
import { blake2b256 } from '../../../src/history/blake2b.mjs';
import { spendMeasures, chainView } from '../../../src/replay/measure.mjs';
import { treatment, skip } from '../../lib/treatment.mjs';
import { replay } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { baseAddr, scriptAddr, keyHash, STAKE } from '../../lib/txcbor.mjs';

const ADA = 1000000n;
const P = { coinsPerUtxoByte: 4310n, minFeeA: 44n };
const A0 = baseAddr(keyHash(0));
const EXTERNAL = baseAddr(keyHash(7), '77'.repeat(28));
const POL = 'cc'.repeat(28);
const X = { policy: POL, name: '58', qty: 1n };
const Y = { policy: POL, name: '59', qty: 1n };

const utxo = (txid, i, address, coin, assets = []) => utxoFromCbor(unspentOutput(txid.repeat(32), i, encodeOutput({ address, coin, assets }, 'array')).toString('hex'), { origin: 'initial' });
const stateOf = (utxos) => makeState({ network: 'synthetic', stakeCred: STAKE, changeAddress: addressTextOf(A0), utxos });
const outputOf = (index, address, coin, assets = []) => ({ index, address, addr: parseAddress(address), coin, assets, raw: encodeOutput({ address, coin, assets }, 'array') });

test('a chain is measured over the UTxOs it consumes from the state before it and the change it leaves in the state after it', () => {
  // Before: A (10 ADA with X), B (5), C (3 with Y). Transaction 1 spends B and
  // C and makes D (6, with Y) and F (1.5). Transaction 2 spends A and D and
  // pays the requested 2 ADA with X outside the wallet; its change is E.
  const A = utxo('01', 0, A0, 10n * ADA, [X]);
  const B = utxo('02', 0, A0, 5n * ADA);
  const C = utxo('03', 0, A0, 3n * ADA, [Y]);
  const before = stateOf([A, B, C]);
  const h1 = 'd1'.repeat(32);
  const h2 = 'd2'.repeat(32);
  const D = outputOf(0, A0, 6n * ADA, [Y]);
  const F = outputOf(1, A0, 3n * ADA / 2n);
  const R = outputOf(0, EXTERNAL, 2n * ADA, [X]);
  const E = outputOf(1, A0, 14n * ADA - 2n * ADA);
  const tx1 = { hash: h1, outputs: [D, F] };
  const tx2 = { hash: h2, outputs: [R, E] };
  const txs = [{ walletInputs: [B.ref, C.ref] }, { walletInputs: [A.ref, `${h1}#0`] }];
  const after = stateOf([utxoFromOutput(h1, 1, F.raw, { origin: 'built' }), utxoFromOutput(h2, 1, E.raw, { origin: 'built' })]);
  const intent = { requested: [{ address: 'addr_test1external', coin: 2n * ADA, assets: [X], wallet: false }], implicit: { mint: [] }, fixed: null };
  // addressBytes of the requested address is not needed: the requested index is given.
  const view = chainView(before, after, txs, [tx1, tx2], new Set([0]));
  assert.deepEqual(view.walletInputs, [B.ref, C.ref, A.ref]);
  assert.deepEqual(view.change.map((o) => [o === F, o === E]), [[true, false], [false, true]]);
  const m = spendMeasures(before, intent, tx2, view.walletInputs, P, new Set([0]), view.change);
  assert.equal(m.inputs, 3);
  assert.equal(m.consumedWalletInputs, 3);
  assert.equal(m.keys, 1);
  assert.equal(m.dragged, 1, 'Y is in the consumed UTxOs and not requested');
  assert.equal(m.largestConsumedValueBytes, valueSize(10n * ADA, [X]));
  assert.equal(m.changeOutputs.count, 2);
  assert.equal(m.changeOutputs.bytes, F.raw.length + E.raw.length);
  assert.equal(m.changeOutputs.largestValueBytes, Math.max(valueSize(F.coin, []), valueSize(E.coin, [])));
  // Neither change output carries a token; X is sent away, Y is not (it stays
  // in the consumed UTxO C, whose minimum counts), and the chain's D (a Y
  // carrier tx 2 spent) is neither change nor consumed.
  assert.equal(m.changeTokenMinimum, 0n);
});

test('a single transaction measures as before', () => {
  const A = utxo('01', 0, A0, 10n * ADA, [X]);
  const before = stateOf([A]);
  const tx = { hash: 'e1'.repeat(32), outputs: [outputOf(0, EXTERNAL, 2n * ADA, [X]), outputOf(1, A0, 7n * ADA)] };
  const intent = { requested: [{ address: 'addr_test1external', coin: 2n * ADA, assets: [X], wallet: false }], implicit: { mint: [] }, fixed: null };
  const req = new Set([0]);
  const m = spendMeasures(before, intent, tx, [A.ref], P, req);
  const n = spendMeasures(before, intent, tx, [A.ref], P, req, tx.outputs.filter((o) => o.index === 1));
  assert.deepEqual(m, n);
  assert.equal(m.changeOutputs.count, 1);
});

const T = await treatment();
test('every spend record carries the count of spendable UTxOs of the state before it, held ones left out', { skip }, async () => {
  const src = loadSource(T, { kind: 'shape', name: 'S1', stream: 'synthetic' });
  const t6 = src.events.filter((e) => e.kind === 'intent').map((e) => e.intent).find((it) => it.type === 'T6' && !it.invalid);
  const address = src.changeAddress;
  const net = addressBytes(address)[0] & 0x0f;
  const pure = (i, coin) => utxoFromOutput(blake2b256(Buffer.from(`chain ${i}`)).toString('hex'), 0, encodeOutput({ address: addressBytes(address), coin, assets: [] }, 'array'), { origin: 'deposit' });
  const heldOne = utxoFromOutput(blake2b256(Buffer.from('chain held')).toString('hex'), 0, encodeOutput({ address: scriptAddr('ab'.repeat(28), src.stakeCred, net), coin: 3n * ADA, assets: [] }, 'array'), { origin: 'deposit' });
  assert.notEqual(heldOne.held, null);
  const start = [pure(1, 5n * ADA), pure(2, 4n * ADA), pure(3, 4n * ADA), heldOne];
  const source = { wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: src.stakeCred, changeAddress: address, changeAddressEnd: address, franken: new Set(), start, events: [{ kind: 'intent', txId: 1, intent: t6 }], windowStart: 0, windowEnd: 100 * 86400, params: src.params };
  const r = await replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: makeMethod(T, 'test-largest-first'), opts: { seed: 1, changePolicy: 'default', collateralRule: 'ledger' }, settleEvery: 25 });
  assert.equal(r.spends[0].outcome, 'built');
  assert.equal(r.spends[0].spendableUtxos, 3);
  assert.equal(r.summary.start.utxos, 4);
});
