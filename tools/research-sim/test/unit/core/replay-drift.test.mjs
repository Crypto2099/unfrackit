// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The five state measures every trajectory point carries: a built spend and a
// forfeit record them after the event, and the summary's start holds the
// state the trajectory begins from.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatment, skip } from '../../lib/treatment.mjs';
import { replay } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { stateMeasures } from '../../../src/replay/measure.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { encodeOutput } from '../../../src/history/output.mjs';
import { addressBytes } from '../../../src/history/address.mjs';
import { blake2b256 } from '../../../src/history/blake2b.mjs';
import { utxoFromOutput } from '../../../src/state/utxo.mjs';
import { makeState } from '../../../src/state/state.mjs';

const T = await treatment();
const ADA = 1000000n;
const DAY = 86400;
const FIELDS = ['utxosAfter', 'largestValueBytesAfter', 'lockedAdaAfter', 'lockedAdaPerTokenAfter', 'tokensAfter'];

function fixture() {
  const src = loadSource(T, { kind: 'shape', name: 'S1', stream: 'synthetic' });
  const intents = src.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
  const t6 = intents.find((it) => it.type === 'T6' && !it.invalid);
  const invalid = intents.find((it) => it.type === 'T6' && it.invalid);
  const address = src.changeAddress;
  const pure = (i, coin) => utxoFromOutput(blake2b256(Buffer.from(`drift ${i}`)).toString('hex'), 0, encodeOutput({ address: addressBytes(address), coin, assets: [] }, 'array'), { origin: 'deposit' });
  const stateOf = (utxos) => makeState({ network: 'synthetic', stakeCred: src.stakeCred, changeAddress: address, utxos });
  const sourceOf = (utxos, list) => ({ wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: src.stakeCred, changeAddress: address, changeAddressEnd: address, franken: new Set(), start: utxos, events: list.map((intent, i) => ({ kind: 'intent', txId: i + 1, intent })), arrival: new Map(), windowStart: 0, windowEnd: 100 * DAY, params: src.params });
  return { src, t6, invalid, pure, stateOf, sourceOf, P: src.params };
}

const run = (source, arm = 'observed') => replay(T, source.params, source, { arm, variant: 'default', repetition: 1, method: makeMethod(T, 'test-largest-first'), opts: { seed: 1, changePolicy: 'default', collateralRule: 'ledger' }, settleEvery: 25 });
const fromMeasures = (m) => ({ utxosAfter: m.utxos, largestValueBytesAfter: m.largestValueBytes, lockedAdaAfter: m.lockedAda, lockedAdaPerTokenAfter: m.lockedAdaPerToken, tokensAfter: m.tokens });
const fieldsOf = (r) => Object.fromEntries(FIELDS.map((k) => [k, r[k]]));

test('the last built spend records the measures the summary ends with, and the start holds the window-start state', { skip }, async () => {
  const f = fixture();
  const utxos = [f.pure(1, 5n * ADA), f.pure(2, 4n * ADA), f.pure(3, 4n * ADA)];
  const r = await run(f.sourceOf(utxos, [f.t6]));
  const s = r.spends[0];
  assert.equal(s.outcome, 'built');
  assert.deepEqual(fieldsOf(s), fromMeasures(r.summary.end));
  assert.deepEqual(r.summary.start, { t: 0, ...stateMeasures(f.stateOf(utxos), f.P) });
  assert.equal(r.summary.trajectory.length, 2);
  assert.equal(r.summary.trajectory[0], r.summary.start.largestValueBytes);
});

test('a forfeit record carries the same five measures, and no token held gives a null per-token figure', { skip }, async () => {
  const f = fixture();
  const utxos = [f.pure(1, 20n * ADA), f.pure(2, 4n * ADA)];
  const r = await run(f.sourceOf(utxos, [f.invalid]));
  const s = r.spends[0];
  assert.equal(s.outcome, 'forfeit');
  assert.deepEqual(fieldsOf(s), fromMeasures(r.summary.end));
  assert.equal(s.lockedAdaPerTokenAfter, null);
  assert.equal(s.tokensAfter, 0);
  assert.equal(s.lockedAdaAfter, 0n);
  assert.equal(r.summary.start.lockedAdaPerToken, null);
  assert.equal(r.summary.trajectory.length, 2);
});

test('on a shape with tokens, the start is the window-start state and every built spend carries the fields', { skip }, async () => {
  const src = loadSource(T, { kind: 'shape', name: 'S8', stream: 'synthetic' });
  const r = await run(src);
  const state = makeState({ network: src.network, stakeCred: src.stakeCred, changeAddress: src.changeAddress, utxos: src.start });
  assert.deepEqual(r.summary.start, { t: 0, ...stateMeasures(state, src.params) });
  const pointed = r.spends.filter((x) => x.outcome === 'built' || x.outcome === 'forfeit');
  assert.ok(pointed.length > 0);
  assert.ok(r.summary.start.tokens > 0 && r.summary.start.lockedAdaPerToken !== null);
  for (const x of pointed) for (const k of FIELDS) assert.ok(k in x, `${x.outcome} lacks ${k}`);
  assert.equal(r.summary.trajectory.length, pointed.length + 1);
});
