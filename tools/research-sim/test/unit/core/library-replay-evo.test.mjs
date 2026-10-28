// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Evolution SDK's replay path: its coverage statement (every part but
// collateral), and, with the treatment, the synthetic streams' replays and
// constructed intents for the parts the streams do not carry. Each spend
// builds, fails with a class, is infeasible (by balance or for collateral), or
// is not replayable; the only class 'other' is a script spend's refusal, since
// the library chooses its own collateral. Every built transaction passes the
// kit's checks (the engine runs them) and its four negative controls are
// caught; its fixed inputs are present and never the selector's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPLAY_PARTS, REPLAY_COVERAGE, refuseUncovered } from '../../../src/methods/library.mjs';
import { ZERO_IMPLICIT } from '../../../src/state/intent.mjs';
import { treatment, skip } from '../../lib/treatment.mjs';
import { negativeControls, EXPECTED } from '../../lib/controls.mjs';
import { evoMethod, buildEvo, evoImplicit, evoRefusal } from '../../../src/methods/evo.mjs';
import { replay, fixedExtraWitnesses, setAside } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { fixedResolver } from '../../../src/kit/apply.mjs';
import { inspectTx, unspentOutputParts } from '../../../src/kit/inspect.mjs';
import { outputBytes } from '../../../src/kit/assemble.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { parseAddress, addressBytes } from '../../../src/history/address.mjs';
import { encodeOutput, unspentOutput } from '../../../src/history/output.mjs';
import { encUint, encInt, encBytes, encArray, encMap } from '../../../src/history/cbor.mjs';
import { blake2b224 } from '../../../src/history/blake2b.mjs';
import { recipientAddress } from '../../../src/battery/recipients.mjs';
import { shapeState } from '../../../src/shapes/shapes.mjs';
import { spendable, holdings } from '../../../src/state/state.mjs';

const REFUSAL = 'evo-lf: the replay path (fixed parts and collateral) is not built yet';
const out = (extra = {}) => ({ cbor: '00', address: 'x', coin: 2000000n, assets: [], datum: null, scriptRef: null, ...extra });
const bare = (over = {}) => ({ source: 'replay', requested: [out()], implicit: ZERO_IMPLICIT, fixed: null, collateral: { required: false, observed: null }, ...over });
const FIXED = { inputs: [], referenceInputs: [], body: { 4: '80' }, witnesses: {}, redeemers: [], auxiliaryData: null, scriptFee: 0n, fixedBytes: 1 };

test('the Evolution SDK covers every replay part but collateral, and refuses a script spend as before', () => {
  assert.deepEqual(REPLAY_COVERAGE.evo, ['fixed', 'implicit', 'outputData']);
  assert.deepEqual(REPLAY_PARTS.filter((p) => !REPLAY_COVERAGE.evo.includes(p)), ['collateral']);
  for (const it of [bare({ fixed: FIXED }), bare({ implicit: { ...ZERO_IMPLICIT, deposits: 1n } }), bare({ requested: [out({ datum: { kind: 'inline', cbor: 'd87980' } })] })]) assert.doesNotThrow(() => refuseUncovered('evo-lf', REPLAY_COVERAGE.evo, it));
  for (const it of [bare({ collateral: { required: true, observed: null } }), bare({ fixed: FIXED, collateral: { required: true, observed: null } })]) assert.throws(() => refuseUncovered('evo-lf', REPLAY_COVERAGE.evo, it), (e) => e.constructor === Error && e.message === REFUSAL);
});

const T = await treatment();
const ADA = 1000000n;

// The engine's replay of `source` by the Evolution SDK (or by `method`), every
// built transaction kept with the library's own fee and the final
// transaction's minimum.
async function replayEvo(source, { rule = 'ledger', method = evoMethod() } = {}) {
  const fees = [];
  const spy = { ...method, build: async (...a) => {
    const r = await method.build(...a);
    if (r.ok && r.library) fees.push({ ...r.library, type: a[1].type });
    return r;
  } };
  const r = await replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: spy, opts: { seed: 1, changePolicy: 'default', collateralRule: rule }, settleEvery: 25, keepTx: true });
  return { ...r, fees };
}

// Every built spend's negative controls, against the state it was built from.
function controlsOf(source, r) {
  const intents = source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
  const bad = [];
  for (const s of r.spends) {
    if (s.outcome !== 'built') continue;
    const it = intents[s.intent];
    const fixed = fixedResolver(it.fixed);
    const view = (u) => u && { coin: u.coin, assets: u.assets, addr: parseAddress(addressBytes(u.address)) };
    const resolve = (ref) => view(s.built.before.utxos.get(ref)) || fixed.get(ref);
    for (const t of s.built.txs) {
      const c = negativeControls(s.built.before, source.params, t.bytes, { resolve, implicit: it.implicit, scriptFee: it.fixed ? it.fixed.scriptFee : 0n, extraWitnesses: fixedExtraWitnesses(it) });
      if (Object.entries(EXPECTED).some(([k, v]) => c[k] !== v)) bad.push({ type: s.type, c });
    }
  }
  return bad;
}

const OUTCOMES = new Set(['built', 'failed', 'not-replayable', 'infeasible', 'infeasible-collateral', 'forfeit']);
function tally(source, r) {
  const intents = source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
  const o = {};
  for (const s of r.spends) {
    assert.ok(OUTCOMES.has(s.outcome), s.outcome);
    if (s.outcome === 'failed' && s.class === CLASSES.other) {
      // A script spend's refusal is the only class 'other'.
      assert.ok(intents[s.intent].collateral.required, `${s.type}: ${s.detail}`);
      assert.equal(s.detail, REFUSAL);
    }
    const k = `${s.type}:${s.outcome}${s.class ? `:${s.class}` : ''}`;
    o[k] = (o[k] || 0) + 1;
  }
  return o;
}

// Every built transaction's fixed inputs are present and none is the
// selector's; it carries no collateral; the library's fee is at least the
// final transaction's minimum unless a part was written after it priced it.
function checkBuilt(source, r) {
  const intents = source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
  for (const s of r.spends) {
    if (s.outcome !== 'built') continue;
    const it = intents[s.intent];
    const tx = inspectTx(s.built.txs[0].bytes);
    assert.equal(tx.collateralInputs.length, 0);
    if (!it.fixed) continue;
    const ins = new Set(tx.inputs.map((x) => x.ref));
    for (const x of it.fixed.inputs) {
      assert.ok(ins.has(x.ref), `${s.type}: fixed input missing`);
      assert.ok(!s.built.txs[0].walletInputs.includes(x.ref));
    }
  }
  for (const f of r.fees) if (!f.unpriced.length) assert.ok(f.fee >= f.finalMinFee, `${f.type}: fee ${f.fee} under the minimum ${f.finalMinFee}`);
}

test('the Evolution SDK replays the synthetic streams\' mints and fixed inputs, refuses their script spends, and miscounts a legacy registration\'s deposit', { skip }, async (t) => {
  const seen = {};
  for (const name of ['S1', 'S7', 'S8', 'M1', 'M7']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const intents = source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
    for (const rule of ['ledger', 'token-bearing']) {
      const r = await replayEvo(source, { rule });
      assert.equal(r.refused, undefined);
      const o = tally(source, r);
      seen[`${name} ${rule}`] = o;
      assert.deepEqual(controlsOf(source, r), []);
      checkBuilt(source, r);
      // The T8 (a native-script mint) and the T1 with a held fixed input, a
      // validity interval and a message build.
      assert.equal(o['T8:built'], 1);
      const t1 = r.spends.find((s) => s.type === 'T1' && intents[s.intent].fixed && intents[s.intent].fixed.inputs.some((x) => x.held));
      assert.equal(t1.outcome, 'built');
      // The script spend is refused; the phase-2-invalid one is a forfeit.
      assert.equal(o['T6:failed:other'], 1);
      assert.equal(o['T6:forfeit'], 1);
      // The T7 is a legacy stake registration (certificate kind 0): the
      // library counts no deposit for it, so its change keeps the deposit and
      // the kit finds the value not conserved.
      const t7 = intents.find((i) => i.type === 'T7');
      assert.equal(t7.implicit.deposits, 2n * ADA);
      assert.deepEqual(evoImplicit(t7, source.params), { deposits: 0n, refunds: 0n });
      assert.equal(o['T7:failed:balance'], 1);
      assert.match(r.spends.find((s) => s.type === 'T7').detail, /conservation/);
    }
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

const payTo = (i, coin, extra = {}) => {
  const address = recipientAddress('synthetic', 300 + i);
  return { cbor: outputBytes(T, { address, coin, assets: [] }).toString('hex'), address, coin, assets: [], datum: null, scriptRef: null, raised: null, wallet: false, scriptPayment: false, index: null, from: null, inflow: false, ...extra };
};

const sourceOf = (state, intents, params = SYNTHETIC_PARAMS) => ({ wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: state.stakeCred, changeAddress: state.changeAddress, changeAddressEnd: state.changeAddress, franken: new Set(), start: [...state.utxos.values()], events: intents.map((intent, i) => ({ kind: 'intent', txId: i + 1, intent })), arrival: new Map(), windowStart: 0, windowEnd: 1000, params });

test('the Evolution SDK replays a burn, Conway certificates with a withdrawal, a datum output and a required signer, writes the parts it cannot price on its transaction, and refuses a body field 6', { skip }, async (t) => {
  const shape = shapeState(T, 'S8');
  const state = shape.state;
  const P = SYNTHETIC_PARAMS;
  const held = holdings(spendable(state));
  const burnt = [...held.assets.values()].sort((a, b) => (a.policy + a.name < b.policy + b.name ? -1 : 1))[0];
  const stakeKey = Buffer.alloc(32, 0x73);
  const witness = (k) => encArray([encArray([encBytes(k), encBytes(Buffer.alloc(64, 0x77))])]).toString('hex');
  const mintKey = Buffer.alloc(32, 0x6b);
  const nativeScript = encArray([encUint(0), encBytes(blake2b224(mintKey))]);
  const net = addressBytes(state.changeAddress)[0] & 15;
  const stakeCred = encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))]);
  const rewardAccount = Buffer.concat([Buffer.from([0xe0 | net]), Buffer.from(state.stakeCred, 'hex')]);
  const pool = encBytes(Buffer.alloc(28, 0x50));
  const walletKey = [...state.utxos.values()].find((u) => u.held === null).cred;
  const intents = [
    // T8: a burn of one unit the wallet holds, with a native script and its
    // key's witness.
    replayIntent('b1', 10, {
      type: 'T8',
      requested: [payTo(0, 2n * ADA)],
      fixed: { body: { 9: encMap([[encBytes(Buffer.from(burnt.policy, 'hex')), encMap([[encBytes(Buffer.from(burnt.name, 'hex')), encInt(-1n)]])]]).toString('hex') }, witnesses: { 0: witness(mintKey), 1: encArray([nativeScript]).toString('hex') } },
      implicit: { burn: [{ policy: burnt.policy, name: burnt.name, qty: 1n }] }
    }),
    // T7: a Conway registration (kind 7) with its deposit and a delegation,
    // with the stake key's witness.
    replayIntent('b2', 20, {
      type: 'T7',
      fixed: { body: { 4: encArray([encArray([encUint(7), stakeCred, encUint(P.keyDeposit)]), encArray([encUint(2), stakeCred, pool])]).toString('hex') }, witnesses: { 0: witness(stakeKey) } },
      implicit: { deposits: P.keyDeposit }
    }),
    // T7: a Conway deregistration (kind 8) with its refund and a reward
    // withdrawal, and no requested output.
    replayIntent('b3', 30, {
      type: 'T7',
      fixed: { body: { 4: encArray([encArray([encUint(8), stakeCred, encUint(P.keyDeposit)])]).toString('hex'), 5: encMap([[encBytes(rewardAccount), encUint(5n * ADA)]]).toString('hex') }, witnesses: { 0: witness(stakeKey) } },
      implicit: { refunds: P.keyDeposit, withdrawals: 5n * ADA }
    }),
    // T7: a legacy deregistration (kind 1): the library counts no refund.
    replayIntent('b4', 40, {
      type: 'T7',
      requested: [payTo(1, 2n * ADA)],
      fixed: { body: { 4: encArray([encArray([encUint(1), stakeCred])]).toString('hex') }, witnesses: { 0: witness(stakeKey) } },
      implicit: { refunds: P.keyDeposit }
    }),
    // T5: an output with an inline datum, a required signer that is one of
    // the wallet's keys, and a validity interval.
    replayIntent('b5', 50, {
      type: 'T5',
      requested: [payTo(2, 3n * ADA, { cbor: encodeOutput({ address: addressBytes(recipientAddress('synthetic', 302)), coin: 3n * ADA, assets: [], datum: { kind: 'inline', cbor: 'd87980' } }, 'map').toString('hex'), datum: { kind: 'inline', cbor: 'd87980' } })],
      fixed: { body: { 3: encUint(5000).toString('hex'), 8: encUint(100).toString('hex'), 14: encArray([encBytes(Buffer.from(walletKey, 'hex'))]).toString('hex') } }
    }),
    // A payment with a treasury donation, which no operation writes: it goes
    // on the built transaction, which the library balanced without it.
    replayIntent('b6', 60, { type: 'T1', requested: [payTo(3, 3n * ADA)], fixed: { body: { 22: encUint(ADA).toString('hex') } }, implicit: { donation: ADA } }),
    // A body field 6 (protocol parameter updates): no Conway transaction
    // carries it.
    replayIntent('b7', 70, { type: 'T7', requested: [payTo(4, 2n * ADA)], fixed: { body: { 6: encArray([encMap([]), encUint(0)]).toString('hex') } } }),
    // Parts the library's builder can neither write nor price, written on the
    // transaction it built: a network id, auxiliary data without metadata, a
    // witness-set datum; and a legacy registration of a script stake
    // credential with no redeemer, which the stake operations refuse.
    replayIntent('b8', 80, { type: 'T1', requested: [payTo(5, 2n * ADA)], fixed: { body: { 15: encUint(0).toString('hex') } } }),
    replayIntent('b9', 90, { type: 'T1', requested: [payTo(6, 2n * ADA)], fixed: { auxiliaryData: 'd90103a0' } }),
    replayIntent('c0', 100, { type: 'T1', requested: [payTo(7, 2n * ADA)], fixed: { witnesses: { 4: encArray([Buffer.from('d87980', 'hex')]).toString('hex') } } }),
    replayIntent('c1', 110, { type: 'T7', requested: [payTo(8, 2n * ADA)], fixed: { body: { 4: encArray([encArray([encUint(0), encArray([encUint(1), encBytes(Buffer.alloc(28, 0x5c))])])]).toString('hex') } }, implicit: { deposits: P.keyDeposit } })
  ];
  const source = sourceOf(state, intents);
  const r = await replayEvo(source);
  const o = tally(source, r);
  assert.deepEqual(controlsOf(source, r), []);
  checkBuilt(source, r);
  const at = (id) => r.spends[intents.findIndex((i) => i.id.startsWith(id))];
  for (const id of ['b1', 'b2', 'b3', 'b5']) assert.equal(at(id).outcome, 'built', `${id}: ${at(id).detail}`);
  assert.equal(at('b4').outcome, 'failed');
  assert.equal(at('b4').class, CLASSES.balance);
  assert.deepEqual(evoImplicit(intents[3], P), { deposits: 0n, refunds: 0n });
  assert.equal(at('b7').outcome, 'not-replayable');
  assert.match(at('b7').detail, /body field 6/);
  assert.equal(r.summary.counts.notReplayable, 1);
  // The unpriced parts are on the transaction: a donation or a deposit the
  // library did not balance fails conservation, and a part it did not price
  // leaves its fee under the minimum.
  for (const [id, cls] of [['b6', CLASSES.balance], ['c1', CLASSES.balance], ['b8', CLASSES.feeMinimum], ['b9', CLASSES.feeMinimum], ['c0', CLASSES.feeMinimum]]) {
    assert.equal(at(id).outcome, 'failed', `${id}: ${at(id).outcome}`);
    assert.equal(at(id).class, cls, `${id}: ${at(id).detail}`);
  }
  const unpriced = {};
  for (const [id, part, field] of [['b6', 'treasury donation', 22], ['b8', 'network id', 15], ['b9', 'auxiliary data', 7], ['c0', 'witness-set datums', 11], ['c1', 'certificates', 4]]) {
    const it = intents.find((i) => i.id.startsWith(id));
    const built = await buildEvo(state, it, P, { changePolicy: 'default', seed: 1 });
    assert.equal(built.ok, true, built.detail);
    assert.deepEqual(built.library.unpriced, [part]);
    assert.ok(inspectTx(built.txs[0].bytes).bodyFields.includes(field), `${id}: body field ${field}`);
    unpriced[id] = built.library.fee - built.library.finalMinFee;
  }
  t.diagnostic(JSON.stringify(unpriced, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  const tx = (id) => inspectTx(at(id).built.txs[0].bytes);
  assert.deepEqual(tx('b1').mint, [{ policy: burnt.policy, name: burnt.name, qty: -1n }]);
  assert.equal(tx('b3').withdrawals.reduce((s, w) => s + w.coin, 0n), 5n * ADA);
  assert.deepEqual(tx('b5').outputs[0].datum, { kind: 'inline', cbor: 'd87980' });
  assert.ok(tx('b5').bodyFields.includes(3) && tx('b5').bodyFields.includes(8) && tx('b5').bodyFields.includes(14));
  assert.deepEqual(evoImplicit(intents[1], P), { deposits: P.keyDeposit, refunds: 0n });
  assert.deepEqual(evoImplicit(intents[2], P), { deposits: 0n, refunds: P.keyDeposit });
  t.diagnostic(JSON.stringify(o));
});

test('the library chooses its own collateral, so a script spend cannot carry the UTxO set aside', { skip }, async () => {
  // The synthetic streams' script spend, its script input locked by an
  // inline datum so that no witness-set datum is needed.
  const stream = loadSource(T, { kind: 'shape', name: 'S1', stream: 'synthetic' });
  const t6 = stream.events.filter((e) => e.kind === 'intent').map((e) => e.intent).find((i) => i.type === 'T6' && i.fixed);
  const x = t6.fixed.inputs[0];
  const p = unspentOutputParts(x.cbor);
  const scriptIn = { ref: x.ref, cbor: unspentOutput(p.txid, p.index, encodeOutput({ address: p.address, coin: p.coin, assets: [], datum: { kind: 'inline', cbor: 'd87980' } }, 'map')).toString('hex') };
  const witnesses = { ...t6.fixed.witnesses };
  delete witnesses[4];
  const intent = { ...replayIntent('c1', 10, { type: 'T6', requested: t6.requested, collateral: true }), fixed: { ...t6.fixed, inputs: [scriptIn], witnesses } };
  assert.equal(evoRefusal(intent), null);
  const state = shapeState(T, 'S1').state;
  const P = SYNTHETIC_PARAMS;
  const aside = setAside(T, P, state, intent, 'ledger');
  assert.ok(aside.ok);
  // Built without the coverage refusal, the library's transaction carries
  // the observed execution units and its own collateral: the largest
  // pure-ADA UTxO it was given, a total of 5 ADA, never the UTxO set aside.
  const r = await buildEvo(aside.pool, intent, P, { changePolicy: 'default', seed: 1, collateral: aside.collateral });
  assert.equal(r.ok, true, r.detail);
  const tx = inspectTx(r.txs[0].bytes);
  assert.deepEqual(tx.redeemers.map((x) => x.exUnits), [t6.fixed.redeemers[0].exUnits]);
  assert.ok(tx.bodyFields.includes(11));
  assert.equal(tx.collateralInputs.length, 1);
  assert.notEqual(tx.collateralInputs[0].ref, aside.collateral.ref);
  const pure = spendable(aside.pool).filter((u) => !u.assets.length).sort((a, b) => (a.coin > b.coin ? -1 : a.coin < b.coin ? 1 : 0));
  assert.equal(tx.collateralInputs[0].ref, pure[0].ref);
  assert.equal(tx.totalCollateral, 5n * ADA);
  // Through the engine, that collateral is the method's defect.
  const unrefused = { ...evoMethod(), build: (s, it, params, opts) => buildEvo(s, it, params, opts) };
  const rr = await replayEvo(sourceOf(state, [intent]), { method: unrefused });
  assert.equal(rr.spends[0].outcome, 'failed');
  assert.equal(rr.spends[0].class, CLASSES.other);
  assert.match(rr.spends[0].detail, /collateral is not the UTxO set aside/);
});

test('a replay repeats byte for byte', { skip }, async () => {
  const source = loadSource(T, { kind: 'shape', name: 'S8', stream: 'synthetic' });
  const bytes = (r) => r.spends.filter((s) => s.outcome === 'built').map((s) => s.built.txs[0].bytes);
  assert.deepEqual(bytes(await replayEvo(source)), bytes(await replayEvo(source)));
});
