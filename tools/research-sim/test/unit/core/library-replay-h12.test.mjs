// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// UnFrack.It's H-12 rule on replayed intents (methods/h12.mjs): its request
// carries every replay part, the rule takes each into its selection, size and
// fee (select2.mjs), and the treatment writes the whole transaction
// (select2-csl.mjs). The synthetic streams' T6 (a Plutus spend with a script
// input, datum, redeemer and collateral), T7 (a stake registration with its
// deposit), T8 (a mint into the wallet) and a T1 with a held fixed input, a
// validity interval and a message, under two collateral rules, absorption on
// and off; constructed intents for a burn, a deregistration with its refund
// and a reward withdrawal and no requested output, a treasury donation, and a
// body field the kit cannot write; a script spend the rule must chain; and a
// battery spend given as a replayed intent, which the treatment writes byte
// for byte as it builds the battery spend. Every built transaction passes the
// treatment's checks and the kit's (selectState and the engine run them), its
// four negative controls are caught, and its fee is the ledger's minimum for
// its size and script fee.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPLAY_PARTS, REPLAY_COVERAGE, refuseUncovered } from '../../../src/methods/library.mjs';
import { ZERO_IMPLICIT } from '../../../src/state/intent.mjs';
import { treatment, skip } from '../../lib/treatment.mjs';
import { negativeControls, EXPECTED } from '../../lib/controls.mjs';
import { h12Method, h12Request } from '../../../src/methods/h12.mjs';
import { replay, fixedExtraWitnesses } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { fixedResolver } from '../../../src/kit/apply.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { outputBytes } from '../../../src/kit/assemble.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { minFee } from '../../../src/kit/fee.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { parseAddress, addressBytes } from '../../../src/history/address.mjs';
import { encUint, encInt, encBytes, encArray, encMap } from '../../../src/history/cbor.mjs';
import { blake2b224 } from '../../../src/history/blake2b.mjs';
import { recipientAddress } from '../../../src/battery/recipients.mjs';
import { shapeState } from '../../../src/shapes/shapes.mjs';
import { standardBattery, h10Battery, SHAPE_POOLS } from '../../../src/battery/battery.mjs';
import { spendable, holdings } from '../../../src/state/state.mjs';
import { settle } from '../../../src/kit/heap.mjs';

const T = await treatment();
const ADA = 1000000n;
const P = SYNTHETIC_PARAMS;

test('the H-12 rule covers every replay part', () => {
  assert.deepEqual(REPLAY_COVERAGE.h12, REPLAY_PARTS);
  const intent = (over) => ({ source: 'replay', requested: [], implicit: ZERO_IMPLICIT, fixed: null, collateral: { required: false, observed: null }, ...over });
  for (const it of [intent({ fixed: { inputs: [], body: { 4: '80' } } }), intent({ implicit: { ...ZERO_IMPLICIT, burn: [{ policy: 'cc'.repeat(28), name: '', qty: 1n }] } }), intent({ requested: [{ datum: { kind: 'inline', cbor: 'd87980' } }] }), intent({ collateral: { required: true, observed: null } })]) {
    assert.doesNotThrow(() => refuseUncovered('unfrackit-h12', REPLAY_COVERAGE.h12, it));
  }
});

// The engine's replay of `source` by the rule, every built transaction kept,
// with the validity checks on.
const replayH12 = (source, { rule = 'ledger', absorb = true } = {}) => replay(T, source.params, source, { arm: 'observed', variant: absorb ? 'absorb-on' : 'absorb-off', repetition: 1, method: h12Method(T), opts: { seed: 1, changePolicy: 'default', collateralRule: rule, absorb }, settleEvery: 25, keepTx: true, validity: true });

// Every built spend's negative controls, against the state it was built
// from, and its last transaction's fee against the ledger's minimum.
function checkBuilt(source, r) {
  const intents = source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
  const bad = [];
  for (const s of r.spends) {
    if (s.outcome !== 'built') continue;
    const it = intents[s.intent];
    const fixed = fixedResolver(it.fixed);
    const view = (u) => u && { coin: u.coin, assets: u.assets, addr: parseAddress(addressBytes(u.address)) };
    const last = s.built.txs[s.built.txs.length - 1];
    const resolve = (ref) => view(s.built.before.utxos.get(ref)) || fixed.get(ref);
    if (s.built.txs.length === 1) {
      const c = negativeControls(s.built.before, source.params, last.bytes, { resolve, implicit: it.implicit, scriptFee: it.fixed ? it.fixed.scriptFee : 0n, extraWitnesses: fixedExtraWitnesses(it) });
      if (Object.entries(EXPECTED).some(([k, v]) => c[k] !== v)) bad.push({ type: s.type, c });
    }
    const t = inspectTx(last.bytes);
    if (t.fee !== minFee(source.params, t.size, it.fixed ? it.fixed.scriptFee : 0n)) bad.push({ type: s.type, fee: t.fee, size: t.size });
  }
  return bad;
}

const OUTCOMES = new Set(['built', 'failed', 'not-replayable', 'infeasible', 'infeasible-collateral', 'forfeit']);
function tally(r) {
  const o = {};
  for (const s of r.spends) {
    assert.ok(OUTCOMES.has(s.outcome), s.outcome);
    const k = `${s.type}:${s.outcome}${s.class ? `:${s.class}` : ''}`;
    o[k] = (o[k] || 0) + 1;
  }
  return o;
}

test('the H-12 rule replays the synthetic streams\' script spends, certificates, mints and fixed inputs', { skip }, async (t) => {
  const seen = {};
  for (const name of ['S1', 'S7', 'S8', 'M1', 'M7']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const intents = source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
    for (const rule of ['ledger', 'token-bearing']) {
      for (const absorb of [true, false]) {
        const r = await replayH12(source, { rule, absorb });
        assert.equal(r.refused, undefined);
        const o = tally(r);
        seen[`${name} ${rule} ${absorb ? 'on' : 'off'}`] = o;
        assert.equal(r.summary.counts.failed, 0, JSON.stringify(o));
        assert.equal(r.summary.counts.notReplayable, 0);
        assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity));
        assert.deepEqual(checkBuilt(source, r), []);
        for (const type of ['T6', 'T7', 'T8']) assert.ok(o[`${type}:built`] >= 1, `${name} ${rule}: no ${type} built`);
        for (const s of r.spends) {
          const it = intents[s.intent];
          if (s.outcome !== 'built' || !it.fixed) continue;
          const last = s.built.txs[s.built.txs.length - 1];
          const tx = inspectTx(last.bytes);
          const ins = new Set(tx.inputs.map((x) => x.ref));
          // Every fixed input is in the transaction, and none is the rule's.
          for (const x of it.fixed.inputs) {
            assert.ok(ins.has(x.ref), `${s.type}: fixed input missing`);
            assert.ok(!last.walletInputs.includes(x.ref));
          }
          assert.equal(tx.collateralInputs.length, it.collateral.required ? 1 : 0);
          // The fixed body fields keep their bytes.
          for (const [k, v] of Object.entries(it.fixed.body)) if (k !== '15') assert.equal(Buffer.from(tx.tx.body.fields.get(Number(k)).raw).toString('hex'), v, `${s.type}: body field ${k}`);
        }
      }
    }
    await settle();
  }
  t.diagnostic(JSON.stringify(seen));
});

// A replay intent of the given parts at time t.
function replayIntent(id, t, { type, requested = [], fixed = null, implicit = {}, collateral = false }) {
  return {
    id: id.padEnd(64, '0'),
    source: 'replay',
    type,
    time: { slot: t, blockTime: t, blockIndex: 0, epoch: 0, block: t },
    requested,
    implicit: { ...ZERO_IMPLICIT, ...implicit },
    fixed: fixed && { inputs: [], referenceInputs: [], body: {}, witnesses: {}, redeemers: [], auxiliaryData: null, scriptFee: 0n, fixedBytes: 0, refScriptBytes: 0, ...fixed },
    collateral: { required: collateral, observed: null },
    invalid: null,
    burst: null,
    observed: { tx: id, size: 0, fee: 300000n, epoch: 0, protocolMajor: null, minFeeA: 44n, minFeeB: 155381n, walletInputs: [], walletOutputs: [], walletWitnesses: [] },
    classes: {},
    derived: null,
    meta: null
  };
}

const payTo = (i, coin) => {
  const address = recipientAddress('synthetic', 300 + i);
  return { cbor: outputBytes(T, { address, coin, assets: [] }).toString('hex'), address, coin, assets: [], datum: null, scriptRef: null, raised: null, wallet: false, scriptPayment: false, index: null, from: null, inflow: false };
};
const sourceOf = (state, events, end = 50) => ({ wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: state.stakeCred, changeAddress: state.changeAddress, changeAddressEnd: state.changeAddress, franken: new Set(), start: [...state.utxos.values()], events: events.map((intent, i) => ({ kind: 'intent', txId: i + 1, intent })), arrival: new Map(), windowStart: 0, windowEnd: end, params: P });

test('the H-12 rule replays a burn, a deregistration with a withdrawal and no requested output, and a donation, and finds a body field the kit cannot write not replayable', { skip }, async () => {
  const state = shapeState(T, 'S8').state;
  const held = holdings(spendable(state));
  const burnt = [...held.assets.values()].sort((a, b) => (a.policy + a.name < b.policy + b.name ? -1 : 1))[0];
  const stakeKey = Buffer.alloc(32, 0x73);
  const witness = (k) => encArray([encArray([encBytes(k), encBytes(Buffer.alloc(64, 0x77))])]).toString('hex');
  const mintKey = Buffer.alloc(32, 0x6b);
  const nativeScript = encArray([encUint(0), encBytes(blake2b224(mintKey))]);
  const net = addressBytes(state.changeAddress)[0] & 15;
  const rewardAccount = Buffer.concat([Buffer.from([0xe0 | net]), Buffer.from(state.stakeCred, 'hex')]);
  const intents = [
    replayIntent('b1', 10, {
      type: 'T8',
      requested: [payTo(0, 2n * ADA)],
      fixed: { body: { 9: encMap([[encBytes(Buffer.from(burnt.policy, 'hex')), encMap([[encBytes(Buffer.from(burnt.name, 'hex')), encInt(-1n)]])]]).toString('hex') }, witnesses: { 0: witness(mintKey), 1: encArray([nativeScript]).toString('hex') } },
      implicit: { burn: [{ policy: burnt.policy, name: burnt.name, qty: 1n }] }
    }),
    // No requested output and no fixed input: the refund and the withdrawal
    // fund the fee, and the rule still takes one input, since the ledger
    // refuses a transaction without one.
    replayIntent('b2', 20, {
      type: 'T7',
      fixed: { body: { 4: encArray([encArray([encUint(1), encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))])])]).toString('hex'), 5: encMap([[encBytes(rewardAccount), encUint(5n * ADA)]]).toString('hex') }, witnesses: { 0: witness(stakeKey) } },
      implicit: { refunds: P.keyDeposit, withdrawals: 5n * ADA }
    }),
    replayIntent('b3', 30, { type: 'T1', requested: [payTo(1, 3n * ADA)], fixed: { body: { 22: encUint(ADA).toString('hex') } }, implicit: { donation: ADA } }),
    replayIntent('b4', 40, { type: 'T7', requested: [payTo(2, 2n * ADA)], fixed: { body: { 6: encArray([encMap([]), encUint(0)]).toString('hex') } } })
  ];
  const source = sourceOf(state, intents);
  for (const absorb of [true, false]) {
    const r = await replayH12(source, { absorb });
    const o = tally(r);
    assert.deepEqual(checkBuilt(source, r), []);
    assert.equal(r.summary.validity.failed, 0);
    assert.equal(o['T8:built'], 1, JSON.stringify(o));
    assert.equal(o['T7:built'], 1, JSON.stringify(o));
    assert.equal(o['T1:built'], 1, JSON.stringify(o));
    assert.equal(o['T7:not-replayable:not-replayable'], 1, JSON.stringify(o));
    assert.match(r.spends.find((s) => s.outcome === 'not-replayable').detail, /body field 6/);
    const tx = (type) => inspectTx(r.spends.find((s) => s.type === type && s.outcome === 'built').built.txs[0].bytes);
    assert.deepEqual(tx('T8').mint, [{ policy: burnt.policy, name: burnt.name, qty: -1n }]);
    assert.equal(tx('T7').withdrawals.reduce((s, w) => s + w.coin, 0n), 5n * ADA);
    assert.equal(tx('T7').inputs.length, 1);
    assert.equal(tx('T1').donation, ADA);
  }
});

test('the H-12 rule chains a script spend it cannot pay in one transaction: the planner\'s transactions carry no collateral, the payment carries every fixed part', { skip }, async () => {
  const s1 = loadSource(T, { kind: 'shape', name: 'S1', stream: 'synthetic' });
  const t6 = s1.events.find((e) => e.kind === 'intent' && e.intent.type === 'T6' && !e.intent.invalid).intent;
  const m5 = shapeState(T, 'M5').state;
  const pay = h10Battery(T, m5, P).find((x) => x.id === 'h10-0.9');
  const intent = { ...t6, id: 'c1'.padEnd(64, '0'), time: { slot: 10, blockTime: 10, blockIndex: 0, epoch: 0, block: 10 }, requested: [...t6.requested, ...pay.requested.map((o) => ({ ...o, index: null, from: null, inflow: false }))] };
  const source = sourceOf(m5, [intent], 20);
  for (const absorb of [true, false]) {
    const r = await replayH12(source, { absorb });
    const s = r.spends[0];
    assert.equal(s.outcome, 'built', s.detail);
    assert.ok(s.txs > 1, 'a chain');
    assert.equal(r.summary.validity.failed, 0);
    const txs = s.built.txs.map((x) => inspectTx(x.bytes));
    for (const x of txs.slice(0, -1)) assert.deepEqual([x.collateralInputs.length, x.redeemers.length], [0, 0]);
    const last = txs[txs.length - 1];
    assert.equal(last.collateralInputs.length, 1);
    assert.equal(last.redeemers.length, t6.fixed.redeemers.length);
    for (const x of t6.fixed.inputs) assert.ok(last.inputs.some((i) => i.ref === x.ref));
    assert.equal(last.fee, minFee(P, last.size, t6.fixed.scriptFee));
  }
  await settle();
});

test('a battery spend given as a replayed intent is written byte for byte as the battery spend', { skip }, async () => {
  const s3 = shapeState(T, 'S3').state;
  const m = h12Method(T);
  for (const it of standardBattery(T, s3, P, { pools: SHAPE_POOLS }).slice(0, 6)) {
    const plain = m.build(s3, it, P, { changePolicy: 'default', absorb: true });
    const replayed = m.build(s3, { ...it, source: 'replay' }, P, { changePolicy: 'default', absorb: true });
    assert.equal(replayed.ok, plain.ok, it.id);
    if (!plain.ok) continue;
    assert.deepEqual(replayed.txs.map((x) => x.bytes), plain.txs.map((x) => x.bytes), it.id);
    assert.ok(h12Request({ ...it, source: 'replay' }).outputs.every((o) => typeof o.cbor === 'string'));
  }
  await settle();
});
