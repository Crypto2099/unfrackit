// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Held outputs a replayed intent creates (state/state.mjs heldOutputRefs):
// an output at a script address carrying the wallet's stake credential, with
// a datum hash, as an order or a lock is, enters the state under its observed
// reference (the observed transaction's hash and the requested output's
// index), so that the events and intents that later consume it find it:
//   - a held-consumed event (heldConsumed 1, heldMissing 0), a later intent
//     spending it as a held fixed input (built by every method with the
//     validity checks on), a self-reorganization's heldConsumed and a
//     phase-2-invalid intent's invalid.heldConsumed each remove it;
//   - in an arm where the creating intent is infeasible it never enters, the
//     event counts it missing and the state is unchanged;
//   - in a chain, a held output in the second transaction is named as well;
//   - a held output matching no requested output keeps the built reference
//     and is counted in heldUnmatched;
//   - a requested output whose coin was raised: the later spend is built and
//     checked against the UTxO the arm holds (heldInputsFromState);
//   - an output in another encoding is matched by its content.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatment, skip } from '../../lib/treatment.mjs';
import { payTo } from '../../lib/script-intents.mjs';
import { replay } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { cjsMethod } from '../../../src/methods/cjs.mjs';
import { inspectTx, unspentOutputParts } from '../../../src/kit/inspect.mjs';
import { encodeOutput, decodeOutputBytes, unspentOutput } from '../../../src/history/output.mjs';
import { addressBytes, parseAddress } from '../../../src/history/address.mjs';
import { blake2b224, blake2b256 } from '../../../src/history/blake2b.mjs';
import { decode, asBytes } from '../../../src/history/cbor.mjs';
import { utxoFromOutput, addressTextOf } from '../../../src/state/utxo.mjs';
import { makeState, applyTx, heldOutputRefs, heldInputsFromState } from '../../../src/state/state.mjs';
import { ZERO_IMPLICIT } from '../../../src/state/intent.mjs';

const T = await treatment();
const ADA = 1000000n;
const DAY = 86400;
const H = (label) => blake2b256(Buffer.from(`held refs ${label}`)).toString('hex');

// A replay intent whose observed transaction's hash is its id.
function intentOf(label, t, { type = 'T1', requested = [], fixed = null, collateral = false, invalid = null } = {}) {
  return {
    id: H(label),
    source: 'replay',
    type,
    time: { slot: t, blockTime: t, blockIndex: 0, epoch: 0, block: t },
    requested,
    implicit: { ...ZERO_IMPLICIT },
    fixed,
    collateral: { required: collateral, observed: null },
    invalid,
    burst: null,
    observed: { tx: H(label), size: 0, fee: 300000n, epoch: 0, protocolMajor: null, minFeeA: 44n, minFeeB: 155381n, walletInputs: [], walletOutputs: [], walletWitnesses: [] },
    classes: {},
    derived: null,
    meta: null
  };
}

// S1's wallet and its synthetic Plutus spend and forfeit. The held output is
// 10 ADA, with the script input's datum hash, at the hash of the spend's
// Plutus V2 script as payment credential and the wallet's stake credential
// (CIP-0019 header type 1), output 1 of the observed transaction `create`;
// `spend` consumes it as a held fixed input, its redeemer, script and datum
// the synthetic spend's.
function fixture({ coin = 10n * ADA, observedCoin = coin } = {}) {
  const src = loadSource(T, { kind: 'shape', name: 'S1', stream: 'synthetic' });
  const intents = src.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
  const t6 = intents.find((it) => it.type === 'T6' && !it.invalid);
  const forfeit = intents.find((it) => it.type === 'T6' && it.invalid);
  const address = src.changeAddress;
  assert.equal(parseAddress(addressBytes(address)).stakeKind, 'key');
  const net = addressBytes(address)[0] & 15;
  const scriptIn = unspentOutputParts(t6.fixed.inputs[0].cbor);
  const v2 = Buffer.from(t6.fixed.witnesses[6], 'hex');
  const script = asBytes(decode(v2).items[0], 'script');
  const scriptHash = blake2b224(Buffer.concat([Buffer.from([2]), script]));
  const heldAddress = Buffer.concat([Buffer.from([0x10 | net]), scriptHash, Buffer.from(src.stakeCred, 'hex')]);
  const heldBytes = (c, form = 'array') => encodeOutput({ address: heldAddress, coin: c, assets: [], datum: scriptIn.datum }, form);
  const requested = (c) => ({ cbor: heldBytes(c).toString('hex'), address: addressTextOf(heldAddress), coin: c, assets: [], datum: scriptIn.datum, scriptRef: null, raised: c === observedCoin ? null : { from: observedCoin, to: c, rule: 'test', original: heldBytes(observedCoin).toString('hex') }, wallet: true, scriptPayment: true, index: 1, from: null, inflow: false });
  const create = intentOf('create', 10 * DAY, { requested: [requested(coin)] });
  const ref = `${create.observed.tx}#1`;
  const spend = intentOf('spend', 20 * DAY, {
    type: 'T6',
    requested: t6.requested,
    fixed: { ...t6.fixed, inputs: [{ ref, cbor: unspentOutput(create.observed.tx, 1, heldBytes(observedCoin)).toString('hex'), held: 'script-payment' }], redeemers: t6.fixed.redeemers.map((r) => ({ ...r, target: { kind: 'input', ref } })) },
    collateral: true
  });
  const pay = intentOf('pay', 40 * DAY, { requested: [payTo(T, 1, 2n * ADA)] });
  const invalid = { ...intentOf('invalid', 20 * DAY, { type: 'T6', collateral: true }), invalid: { ...forfeit.invalid, heldConsumed: [ref] } };
  const pure = (i, c) => utxoFromOutput(H(`utxo ${i}`), 0, encodeOutput({ address: addressBytes(address), coin: c, assets: [] }, 'array'), { origin: 'deposit' });
  const utxos = [pure(1, 20n * ADA), pure(2, 30n * ADA), pure(3, 6n * ADA)];
  const events = (list) => list.map((e, i) => ({ txId: i + 1, ...e }));
  const sourceOf = (start, list) => ({ wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: src.stakeCred, changeAddress: address, changeAddressEnd: address, franken: new Set(), start, events: events(list), windowStart: 0, windowEnd: 60 * DAY, params: src.params });
  const at = (it) => ({ kind: 'intent', intent: it });
  const consumed = (refs, t) => ({ kind: 'held-consumed', tx: H('taker'), time: { blockTime: t }, refs });
  const reorg = (refs, t) => ({ kind: 'self-reorganization', tx: H('reorg'), time: { blockTime: t }, burst: null, heldConsumed: refs, withdrawal: 0n, valueChange: { coin: 0n, assets: [] }, walletOutputs: [] });
  return { src, P: src.params, address, heldAddress, heldBytes, requested, create, spend, pay, invalid, ref, utxos, pure, sourceOf, at, consumed, reorg };
}

const run = (source, method, { validity = true } = {}) => replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method, opts: { seed: 1, changePolicy: 'default', collateralRule: 'ledger' }, settleEvery: 25, keepTx: true, validity });
const heldIn = (state) => [...state.utxos.values()].filter((u) => u.held !== null).map((u) => u.ref);
const lf = () => makeMethod(T, 'test-largest-first');

test('a held output an intent creates enters the state under its observed reference', { skip }, async () => {
  const f = fixture();
  const r = await run(f.sourceOf(f.utxos, [f.at(f.create), f.at(f.pay)]), lf());
  const [c, p] = r.spends;
  assert.equal(c.outcome, 'built');
  assert.equal(p.outcome, 'built');
  const built = inspectTx(c.built.txs[0].bytes);
  // The kit writes the requested output first; the observed one was output 1.
  assert.equal(built.outputs[0].raw.toString('hex'), f.create.requested[0].cbor);
  assert.deepEqual(heldIn(p.built.before), [f.ref]);
  assert.ok(!p.built.before.utxos.has(`${built.hash}#0`));
  assert.equal(p.built.before.utxos.get(f.ref).held, 'script-payment');
  assert.equal(p.built.before.utxos.get(f.ref).origin, 'built');
  assert.equal(r.summary.counts.heldUnmatched, 0);
  assert.equal(r.summary.validity.failed, 0);
});

test('a held-consumed event removes it; where the creating intent is infeasible it is missing and the state unchanged', { skip }, async () => {
  const f = fixture();
  const r = await run(f.sourceOf(f.utxos, [f.at(f.create), f.consumed([f.ref], 15 * DAY), f.at(f.pay)]), lf());
  const c = r.summary.counts;
  assert.deepEqual([c.heldConsumed, c.heldMissing, c.heldUnmatched], [1, 0, 0]);
  assert.deepEqual(heldIn(r.spends[1].built.before), []);
  // The end state: the payment's change and the remaining UTxOs, nothing held.
  assert.equal(r.summary.end.utxos, r.spends[1].utxosAfter);

  // A wallet that cannot fund the 10 ADA output.
  const poor = [f.pure(4, 3n * ADA), f.pure(5, 4n * ADA)];
  const x = await run(f.sourceOf(poor, [f.at(f.create), f.consumed([f.ref], 15 * DAY)]), lf());
  assert.equal(x.spends[0].outcome, 'infeasible');
  const k = x.summary.counts;
  assert.deepEqual([k.heldConsumed, k.heldMissing, k.heldUnmatched], [0, 1, 0]);
  const { t, ...start } = x.summary.start;
  assert.equal(t, 0);
  assert.deepEqual(x.summary.end, start);
});

test('a later intent spends it as a held fixed input, by every method, with the validity checks on', { skip }, async () => {
  const f = fixture();
  const methods = [['test-largest-first', lf()], ['cjs-rrri', cjsMethod(T)], ['csl-lf', makeMethod(T, 'csl-lf')], ['evo-lf', makeMethod(T, 'evo-lf')]];
  for (const [name, m] of methods) {
    const r = await run(f.sourceOf(f.utxos, [f.at(f.create), f.at(f.spend), f.at(f.pay)]), m);
    const [c, s, p] = r.spends;
    assert.equal(c.outcome, 'built', `${name}: ${c.detail}`);
    assert.equal(s.outcome, 'built', `${name}: ${s.class} ${s.detail}`);
    assert.equal(p.outcome, 'built', `${name}: ${p.detail}`);
    assert.ok(inspectTx(s.built.txs[0].bytes).inputs.some((x) => x.ref === f.ref), name);
    assert.deepEqual(heldIn(s.built.before), [f.ref], name);
    assert.deepEqual(heldIn(p.built.before), [], name);
    assert.equal(r.summary.counts.failed, 0, name);
    assert.equal(r.summary.counts.heldUnmatched, 0, name);
    assert.equal(r.summary.validity.failed, 0, `${name}: ${JSON.stringify(r.summary.validity.failures)}`);
  }
});

test('a self-reorganization\'s and a phase-2-invalid intent\'s held UTxOs consumed remove it', { skip }, async () => {
  const f = fixture();
  const a = await run(f.sourceOf(f.utxos, [f.at(f.create), f.reorg([f.ref], 15 * DAY), f.at(f.pay)]), lf());
  assert.equal(a.summary.counts.selfReorganizations, 1);
  assert.deepEqual(heldIn(a.spends[1].built.before), []);
  const b = await run(f.sourceOf(f.utxos, [f.at(f.create), f.at(f.invalid), f.at(f.pay)]), lf());
  assert.equal(b.spends[1].outcome, 'forfeit');
  assert.deepEqual(heldIn(b.spends[2].built.before), []);
  assert.equal(b.summary.validity.failed, 0);
});

test('a chain whose second transaction creates the held output names it the same way', { skip }, async () => {
  const f = fixture();
  const base = lf();
  // The first transaction moves 15 ADA to the change address; the second
  // pays the intent from that output alone.
  const chain = {
    name: 'test-chain',
    version: '1',
    deterministic: true,
    seeded: true,
    build(state, intent, params, opts) {
      const move = intentOf('move', intent.time.blockTime, { requested: [{ ...payTo(T, 2, 15n * ADA), cbor: encodeOutput({ address: addressBytes(f.address), coin: 15n * ADA, assets: [] }, 'array').toString('hex'), address: f.address }] });
      const one = base.build(state, move, params, opts);
      if (!one.ok) return one;
      const { state: s1, hash } = applyTx(state, { bytes: one.txs[0].bytes, walletInputs: one.txs[0].walletInputs });
      const moved = makeState({ network: s1.network, stakeCred: s1.stakeCred, changeAddress: s1.changeAddress, utxos: [s1.utxos.get(`${hash}#0`)] });
      const two = base.build(moved, intent, params, opts);
      if (!two.ok) return two;
      return { ok: true, kind: 'chain', txs: [one.txs[0], two.txs[0]] };
    }
  };
  const r = await run(f.sourceOf(f.utxos, [f.at(f.create), f.consumed([f.ref], 15 * DAY), f.at(f.pay)]), chain);
  const c = r.spends[0];
  assert.equal(c.outcome, 'built', c.detail);
  assert.equal(c.txs, 2);
  assert.ok(inspectTx(c.built.txs[1].bytes).outputs.some((o) => o.raw.toString('hex') === f.create.requested[0].cbor));
  const k = r.summary.counts;
  assert.deepEqual([k.heldConsumed, k.heldMissing, k.heldUnmatched], [1, 0, 0]);
  assert.equal(r.summary.validity.failed, 0);
});

test('a held output that matches no requested output keeps the built reference and is counted', { skip }, async () => {
  const f = fixture();
  const base = lf();
  // A method that pays 11 ADA where the intent requests 10.
  const altered = {
    name: 'test-altered',
    version: '1',
    deterministic: true,
    seeded: true,
    build: (state, intent, params, opts) => base.build(state, intent.id === f.create.id ? { ...intent, requested: [f.requested(11n * ADA)] } : intent, params, opts)
  };
  const r = await run(f.sourceOf(f.utxos, [f.at(f.create), f.consumed([f.ref], 15 * DAY), f.at(f.pay)]), altered);
  const k = r.summary.counts;
  assert.equal(r.spends[0].outcome, 'built');
  assert.deepEqual([k.heldConsumed, k.heldMissing, k.heldUnmatched], [0, 1, 1]);
  const hash = inspectTx(r.spends[0].built.txs[0].bytes).hash;
  assert.deepEqual(heldIn(r.spends[1].built.before), [`${hash}#0`]);
});

test('a raised held output is spent as the arm holds it', { skip }, async () => {
  // The observed output held 9 ADA; the reader raised the requested output to
  // 10 ADA, which the arm built. The later spend's fixed input says 9 ADA.
  const f = fixture({ coin: 10n * ADA, observedCoin: 9n * ADA });
  for (const [name, m] of [['test-largest-first', lf()], ['cjs-rrri', cjsMethod(T)], ['csl-lf', makeMethod(T, 'csl-lf')]]) {
    const r = await run(f.sourceOf(f.utxos, [f.at(f.create), f.at(f.spend), f.at(f.pay)]), m);
    const s = r.spends[1];
    assert.equal(s.outcome, 'built', `${name}: ${s.class} ${s.detail}`);
    assert.deepEqual(heldIn(r.spends[2].built.before), [], name);
    assert.equal(r.summary.validity.failed, 0, name);
    // The intent as the method received it.
    const given = heldInputsFromState(s.built.before, f.spend);
    assert.equal(unspentOutputParts(given.fixed.inputs[0].cbor).coin, 10n * ADA);
  }
  // A state that does not hold it, or holds it as observed, leaves the intent
  // as it is.
  const g = fixture();
  const state = makeState({ network: 'synthetic', stakeCred: g.src.stakeCred, changeAddress: g.address, utxos: g.utxos });
  assert.equal(heldInputsFromState(state, g.spend), g.spend);
});

test('an output in another encoding is matched by its content', { skip }, () => {
  const f = fixture();
  const out = (bytes) => ({ raw: bytes, ...decodeOutputBytes(bytes) });
  const names = heldOutputRefs(f.create);
  // The map form of the same output.
  assert.equal(names.ref(out(f.heldBytes(10n * ADA, 'map'))), f.ref);
  // A second output finds no requested output left.
  assert.equal(names.ref(out(f.heldBytes(10n * ADA))), null);
  assert.equal(names.unmatched, 1);
  // A battery's intent has no observed output to name.
  const battery = { ...f.create, observed: null };
  const b = heldOutputRefs(battery);
  assert.equal(b.ref(out(f.heldBytes(10n * ADA))), null);
  assert.equal(b.unmatched, 0);
});
