// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A collateral a library that chooses its own wrote (methods/library.mjs
// libraryCollateral) may be one of the replayed intent's fixed inputs: the
// observed transaction's own collateral is often another party's input of the
// same transaction. It is taken with the output the intent holds, adds no
// second witness for the key the input already needs, and the kit's checks
// decide the rest: a key at a script address is refused as a collateral, and
// an input at a key address with no witness for that key among the intent's
// is a collateral failure of the library. A reference that is neither in the
// state nor one of the intent's fixed inputs stays an error.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { libraryCollateral, txRecord } from '../../../src/methods/library.mjs';
import { buildWithChange } from '../../../src/methods/change.mjs';
import { checkAndApply } from '../../../src/kit/apply.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { replayWitnessKeys } from '../../../src/kit/replay.mjs';
import { fixedExtraWitnesses } from '../../../src/replay/engine.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { addressBytes } from '../../../src/history/address.mjs';
import { blake2b224 } from '../../../src/history/blake2b.mjs';
import { encodeOutput, unspentOutput } from '../../../src/history/output.mjs';
import { encArray, encBytes } from '../../../src/history/cbor.mjs';
import { constructState, ADA } from '../../lib/construct.mjs';
import { zeroRedeemerIntents } from '../../lib/script-intents.mjs';
import { treatment, skip } from '../../lib/treatment.mjs';

const T = await treatment();
const P = SYNTHETIC_PARAMS;
const TXID = 'ab'.repeat(32);
const REF = `${TXID}#0`;

// A script spend whose one fixed input is `coin` at an address of the given
// kind, with one vkey witness for `witnessed` (the key of that address when it
// is a key address, by default).
function setup({ kind = 'key', witnessKey = Buffer.alloc(32, 7), witnessed = witnessKey, coin = 30n * ADA } = {}) {
  const state = constructState(T, [{ coin: 20n * ADA }, { coin: 8n * ADA }]);
  const net = addressBytes(state.changeAddress)[0] & 15;
  const hash = blake2b224(witnessKey);
  const address = Buffer.concat([Buffer.from([(kind === 'key' ? 0x60 : 0x70) | net]), hash]);
  const cbor = unspentOutput(TXID, 0, encodeOutput({ address, coin, assets: [] }, 'array')).toString('hex');
  const base = zeroRedeemerIntents(T, state)[0];
  const sig = Buffer.alloc(64, 1);
  const witnesses = { ...base.fixed.witnesses, 0: encArray([encArray([encBytes(witnessed), encBytes(sig)])]).toString('hex') };
  const intent = { ...base, fixed: { ...base.fixed, inputs: [{ ref: REF, cbor }], witnesses } };
  return { state, intent };
}

// The build of a library that wrote the fixed input as its collateral, with
// the layout change on the wallet's inputs it selected.
function build({ state, intent }, refs = [REF]) {
  const c = libraryCollateral(state, intent, refs, 'stub');
  if (!c.ok) return { ok: false, class: c.class, detail: c.detail };
  const inputs = [...state.utxos.values()].slice(0, 1);
  const collateral = { utxos: c.utxos, total: null, returnBytes: null };
  const r = buildWithChange(T, { state, params: P, inputs, intent, policy: 'layout', collateralFor: () => ({ ok: true, collateral }) });
  if (!r.ok) return r;
  return { ok: true, kind: 'single', txs: [txRecord(r.bytes, inputs.map((u) => u.ref), r.fee, r.size, r.k)] };
}

const kit = ({ state, intent }, r) => checkAndApply(state, P, r.txs, { implicit: intent.implicit, fixed: intent.fixed, extraWitnesses: fixedExtraWitnesses(intent) });

test('a fixed input at another party\'s key is accepted as the library\'s collateral and passes the kit', { skip }, () => {
  const s = setup();
  const c = libraryCollateral(s.state, s.intent, [REF], 'stub');
  assert.equal(c.ok, true);
  assert.equal(c.utxos[0].ref, REF);
  assert.equal(c.utxos[0].coin, 30n * ADA);
  const r = build(s);
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(inspectTx(r.txs[0].bytes).collateralInputs.map((x) => x.ref), [REF]);
  const applied = kit(s, r);
  assert.equal(applied.ok, true, applied.failure && applied.failure.detail);
});

test('the fixed collateral adds no witness for the key its input already has', { skip }, () => {
  const s = setup();
  const c = libraryCollateral(s.state, s.intent, [REF], 'stub');
  const inputs = [...s.state.utxos.values()].slice(0, 1);
  const without = replayWitnessKeys(s.intent.fixed, { inputs, collateral: [] });
  const withIt = replayWitnessKeys(s.intent.fixed, { inputs, collateral: c.utxos });
  assert.deepEqual([...withIt], [...without]);
  // A collateral that is a UTxO of the state still adds its key.
  const own = [...s.state.utxos.values()][1];
  assert.equal(replayWitnessKeys(s.intent.fixed, { inputs, collateral: [own] }).size, without.size + (without.has(own.cred) ? 0 : 1));
});

test('a fixed input at a key address with no witness for its key is a collateral failure of the library', { skip }, () => {
  const s = setup({ witnessed: Buffer.alloc(32, 9) });
  const c = libraryCollateral(s.state, s.intent, [REF], 'stub');
  assert.equal(c.ok, false);
  assert.equal(c.class, CLASSES.collateral);
  assert.match(c.detail, /holds no witness for/);
  const r = build(s);
  assert.deepEqual([r.ok, r.class], [false, CLASSES.collateral]);
});

test('a fixed input at a script address is accepted by the lookup and refused by the kit as a collateral', { skip }, () => {
  const s = setup({ kind: 'script' });
  const c = libraryCollateral(s.state, s.intent, [REF], 'stub');
  assert.equal(c.ok, true);
  const r = build(s);
  assert.equal(r.ok, true, r.detail);
  const applied = kit(s, r);
  assert.equal(applied.ok, false);
  assert.equal(applied.failure.cls, CLASSES.collateral);
  assert.match(applied.failure.detail, /not at a key address/);
});

test('a fixed input too small for the percentage is refused by the kit as a collateral', { skip }, () => {
  const s = setup({ coin: ADA / 5n });
  const r = build(s);
  assert.equal(r.ok, true, r.detail);
  const applied = kit(s, r);
  assert.equal(applied.ok, false);
  assert.equal(applied.failure.cls, CLASSES.collateral);
  assert.match(applied.failure.detail, /under \d+% of the fee/);
});

test('a reference that is neither in the state nor a fixed input stays an error; a state UTxO resolves as before', { skip }, () => {
  const s = setup();
  assert.throws(() => libraryCollateral(s.state, s.intent, [`${'cd'.repeat(32)}#3`], 'stub'), /neither in the state nor one of the intent's fixed inputs/);
  const u = [...s.state.utxos.values()][0];
  const c = libraryCollateral(s.state, s.intent, [u.ref], 'stub');
  assert.deepEqual([c.ok, c.utxos[0]], [true, u]);
  const noFixed = libraryCollateral(s.state, { ...s.intent, fixed: null }, [u.ref], 'stub');
  assert.equal(noFixed.ok, true);
});
