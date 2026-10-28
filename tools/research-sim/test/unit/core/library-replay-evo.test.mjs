// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Evolution SDK's replay path: its coverage statement (every part, its
// collateral as the library chooses it), and, with the treatment, the
// synthetic streams' replays and constructed intents for the parts the streams
// do not carry. Each spend builds, fails with a class other than 'other', is
// infeasible (by balance or for collateral), or is not replayable. Every built
// transaction passes the kit's checks (the engine runs them) and its four
// negative controls are caught; its fixed inputs are present and never the
// selector's; a script spend's collateral is the library's, recorded as
// library-chosen.

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
import { CLASSES } from '../../../src/kit/check.mjs';
import { NOT_REPLAYABLE, choosesOwnCollateral, checkMethod } from '../../../src/methods/contract.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { constructState, policy, assetName } from '../../lib/construct.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { parseAddress, addressBytes } from '../../../src/history/address.mjs';
import { encodeOutput, unspentOutput } from '../../../src/history/output.mjs';
import { encUint, encInt, encBytes, encArray, encMap } from '../../../src/history/cbor.mjs';
import { listItems } from '../../../src/kit/replay.mjs';
import { replayIntent, payTo as payToOf, zeroRedeemerIntents, EX_UNITS } from '../../lib/script-intents.mjs';
import { blake2b224 } from '../../../src/history/blake2b.mjs';
import { recipientAddress } from '../../../src/battery/recipients.mjs';
import { shapeState } from '../../../src/shapes/shapes.mjs';
import { spendable, holdings } from '../../../src/state/state.mjs';

const out = (extra = {}) => ({ cbor: '00', address: 'x', coin: 2000000n, assets: [], datum: null, scriptRef: null, ...extra });
const bare = (over = {}) => ({ source: 'replay', requested: [out()], implicit: ZERO_IMPLICIT, fixed: null, collateral: { required: false, observed: null }, ...over });
const FIXED = { inputs: [], referenceInputs: [], body: { 4: '80' }, witnesses: {}, redeemers: [], auxiliaryData: null, scriptFee: 0n, fixedBytes: 1 };

test('the Evolution SDK covers every replay part, its collateral as the library chooses it, and only its methods choose their own', () => {
  assert.deepEqual(REPLAY_COVERAGE.evo, [...REPLAY_PARTS]);
  for (const it of [bare({ fixed: FIXED }), bare({ implicit: { ...ZERO_IMPLICIT, deposits: 1n } }), bare({ requested: [out({ datum: { kind: 'inline', cbor: 'd87980' } })] }), bare({ collateral: { required: true, observed: null } }), bare({ fixed: FIXED, collateral: { required: true, observed: null } })]) assert.doesNotThrow(() => refuseUncovered('evo-lf', REPLAY_COVERAGE.evo, it));
  for (const m of [evoMethod(), evoMethod({ unfrack: {} })]) {
    assert.equal(choosesOwnCollateral(m), true, m.name);
    assert.doesNotThrow(() => checkMethod(m));
  }
  const renamed = { ...evoMethod(), name: 'csl-lf' };
  assert.equal(choosesOwnCollateral(renamed), false);
  assert.throws(() => checkMethod(renamed), /only the Evolution SDK's methods choose their own collateral/);
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
    assert.notEqual(s.class, CLASSES.other, `${s.type}: ${s.detail}`);
    const k = `${s.type}:${s.outcome}${s.class ? `:${s.class}` : ''}`;
    o[k] = (o[k] || 0) + 1;
  }
  return o;
}

// Every built transaction's fixed inputs are present and none is the
// selector's; a script spend's collateral is the library's, recorded as
// library-chosen, and no other spend carries collateral; the library's fee is
// at least the final transaction's minimum unless a part was written after it
// priced it.
function checkBuilt(source, r) {
  const intents = source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
  for (const s of r.spends) {
    if (s.outcome !== 'built') continue;
    const it = intents[s.intent];
    const tx = inspectTx(s.built.txs[0].bytes);
    if (it.collateral.required) {
      assert.ok(tx.collateralInputs.length >= 1);
      assert.equal(s.collateralUsed.chosen, 'library');
    } else assert.equal(tx.collateralInputs.length, 0);
    if (!it.fixed) continue;
    const ins = new Set(tx.inputs.map((x) => x.ref));
    for (const x of it.fixed.inputs) {
      assert.ok(ins.has(x.ref), `${s.type}: fixed input missing`);
      assert.ok(!s.built.txs[0].walletInputs.includes(x.ref));
    }
  }
  for (const f of r.fees) if (!f.unpriced.length) assert.ok(f.fee >= f.finalMinFee, `${f.type}: fee ${f.fee} under the minimum ${f.finalMinFee}`);
}

test('the Evolution SDK replays the synthetic streams\' mints, fixed inputs and datum-hash script spends, and miscounts a legacy registration\'s deposit', { skip }, async (t) => {
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
      // The script spend reaches the library, which chooses its own
      // collateral. Its script input holds a datum hash: the library takes
      // the datum through collectFrom, writes it in the witness set with its
      // observed bytes and prices it, so the spend builds with nothing
      // unpriced. The phase-2-invalid one is a forfeit.
      assert.equal(o['T6:built'], 1);
      const t6 = r.spends.find((s) => s.type === 'T6' && s.outcome === 'built');
      const t6tx = inspectTx(t6.built.txs[0].bytes);
      assert.ok(t6tx.witnessKeys.includes(4) && t6tx.bodyFields.includes(11));
      assert.equal(Buffer.from(inspectTx(t6.built.txs[0].bytes).tx.wits.fields.get(4).raw).toString('hex').endsWith('d87980'), true);
      assert.ok(r.fees.some((f) => f.type === 'T6' && !f.unpriced.length && f.fee >= f.finalMinFee));
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

const payTo = (i, coin, extra = {}) => payToOf(T, i, coin, extra);

const sourceOf = (state, intents, params = SYNTHETIC_PARAMS) => ({ wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: state.stakeCred, changeAddress: state.changeAddress, changeAddressEnd: state.changeAddress, franken: new Set(), start: [...state.utxos.values()], events: intents.map((intent, i) => ({ kind: 'intent', txId: i + 1, intent })), arrival: new Map(), windowStart: 0, windowEnd: 1000, params });

test('the Evolution SDK replays a burn, Conway certificates with a withdrawal, a datum output, a required signer and payments without their network id and empty auxiliary data, writes the parts it cannot price on its transaction and names them when it fails, and refuses a body field 6', { skip }, async (t) => {
  const shape = shapeState(T, 'S8');
  const state = shape.state;
  const P = SYNTHETIC_PARAMS;
  const held = holdings(spendable(state));
  const burnt = [...held.assets.values()].sort((a, b) => (a.policy + a.name < b.policy + b.name ? -1 : 1))[0];
  const stakeKey = Buffer.alloc(32, 0x73);
  const coldKey = Buffer.alloc(32, 0x63);
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
    // A network id and an auxiliary data without metadata or scripts, which
    // the engine leaves out of the intent the library receives.
    replayIntent('b8', 80, { type: 'T1', requested: [payTo(5, 2n * ADA)], fixed: { body: { 15: encUint(0).toString('hex') } } }),
    replayIntent('b9', 90, { type: 'T1', requested: [payTo(6, 2n * ADA)], fixed: { auxiliaryData: 'd90103a0' } }),
    // Parts the library's builder can neither write nor price, written on the
    // transaction it built: a witness-set datum; and a legacy registration of
    // a script stake credential with no redeemer, which the stake operations
    // refuse.
    replayIntent('c0', 100, { type: 'T1', requested: [payTo(7, 2n * ADA)], fixed: { witnesses: { 4: encArray([Buffer.from('d87980', 'hex')]).toString('hex') } } }),
    replayIntent('c1', 110, { type: 'T7', requested: [payTo(8, 2n * ADA)], fixed: { body: { 4: encArray([encArray([encUint(0), encArray([encUint(1), encBytes(Buffer.alloc(28, 0x5c))])])]).toString('hex') } }, implicit: { deposits: P.keyDeposit } }),
    // A committee hot-key authorization with the cold key's witness, which
    // the library does not count.
    replayIntent('c2', 120, { type: 'T7', requested: [payTo(9, 2n * ADA)], fixed: { body: { 4: encArray([encArray([encUint(14), encArray([encUint(0), encBytes(blake2b224(coldKey))]), encArray([encUint(0), encBytes(Buffer.alloc(28, 0x68))])])]).toString('hex') }, witnesses: { 0: witness(coldKey) } } })
  ];
  const source = sourceOf(state, intents);
  const r = await replayEvo(source);
  const o = tally(source, r);
  assert.deepEqual(controlsOf(source, r), []);
  checkBuilt(source, r);
  const at = (id) => r.spends[intents.findIndex((i) => i.id.startsWith(id))];
  for (const id of ['b1', 'b2', 'b3', 'b5', 'b8', 'b9']) assert.equal(at(id).outcome, 'built', `${id}: ${at(id).detail}`);
  for (const id of ['b8', 'b9']) {
    const built = inspectTx(at(id).built.txs[0].bytes);
    assert.ok(!built.bodyFields.includes(15) && !built.bodyFields.includes(7), id);
    assert.equal(built.hasAux, false, id);
    // Given the intent directly, the adapter finds the part not replayable.
    const direct = await buildEvo(state, intents.find((i) => i.id.startsWith(id)), P, { changePolicy: 'default', seed: 1 });
    assert.equal(direct.class, NOT_REPLAYABLE, id);
  }
  assert.equal(at('b4').outcome, 'failed');
  assert.equal(at('b4').class, CLASSES.balance);
  assert.deepEqual(evoImplicit(intents[3], P), { deposits: 0n, refunds: 0n });
  assert.equal(at('b7').outcome, 'not-replayable');
  assert.match(at('b7').detail, /body field 6/);
  assert.equal(r.summary.counts.notReplayable, 1);
  // The unpriced parts are on the transaction: a donation or a deposit the
  // library did not balance fails conservation, and a part it did not price
  // leaves its fee under the minimum.
  // Each failure names the part the library did not price.
  for (const [id, cls, part] of [['b6', CLASSES.balance, 'treasury donation'], ['c1', CLASSES.balance, 'certificates'], ['c0', CLASSES.feeMinimum, 'witness-set datums'], ['c2', CLASSES.feeMinimum, 'observed vkey witnesses']]) {
    assert.equal(at(id).outcome, 'failed', `${id}: ${at(id).outcome}`);
    assert.equal(at(id).class, cls, `${id}: ${at(id).detail}`);
    assert.ok(at(id).detail.startsWith('kit: ') && at(id).detail.endsWith(`; parts the library did not price: ${part}`), `${id}: ${at(id).detail}`);
  }
  const unpriced = {};
  for (const [id, part, field] of [['b6', 'treasury donation', 22], ['c0', 'witness-set datums', 11], ['c1', 'certificates', 4], ['c2', 'observed vkey witnesses', 4]]) {
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

test('the library chooses its own collateral from the whole pool, recorded as library-chosen, and the guard refuses a foreign collateral for every other method', { skip }, async () => {
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
  const P = SYNTHETIC_PARAMS;
  const runOf = async (state, method = evoMethod(), rule = 'ledger') => (await replayEvo(sourceOf(state, [intent]), { method, rule })).spends[0];

  // S1 holds three pure-ADA UTxOs of 50 ADA. Nothing is set aside: the
  // library takes the first of them in the order it was given, a total of
  // 5 ADA whatever the fee, and its largest-first selection spends the same
  // UTxO, which the ledger allows.
  const state = shapeState(T, 'S1').state;
  const s = await runOf(state);
  assert.equal(s.outcome, 'built', s.detail);
  const tx = inspectTx(s.built.txs[0].bytes);
  assert.deepEqual(tx.redeemers.map((r) => r.exUnits), [t6.fixed.redeemers[0].exUnits]);
  assert.ok(tx.bodyFields.includes(11));
  const first = spendable(state)[0];
  assert.deepEqual(tx.collateralInputs.map((c) => c.ref), [first.ref]);
  assert.ok(tx.inputs.some((i) => i.ref === first.ref));
  assert.deepEqual(s.collateralUsed, { inputs: 1, total: 5n * ADA, returned: true, chosen: 'library' });
  // The adapter takes no UTxO set aside.
  const aside = setAside(T, P, state, intent, 'ledger');
  assert.ok(aside.ok);
  await assert.rejects(buildEvo(aside.pool, intent, P, { changePolicy: 'default', seed: 1, collateral: aside.collateral }), /chooses its own collateral/);

  // One UTxO of 20 ADA: every other method would set it aside and could not
  // pay without it; the library spends it as input and collateral both.
  const tlf = makeMethod(T, 'test-largest-first');
  const one = constructState(T, [{ coin: 20n * ADA }]);
  assert.deepEqual([(await runOf(one, tlf)).outcome, (await runOf(one, tlf)).reason], ['infeasible-collateral', 'payment']);
  const s1 = await runOf(one);
  assert.equal(s1.outcome, 'built', s1.detail);
  const tx1 = inspectTx(s1.built.txs[0].bytes);
  assert.ok(tx1.inputs.some((i) => i.ref === tx1.collateralInputs[0].ref));

  // No UTxO the rule would set aside (twenty of 1.5 ADA): infeasible for
  // collateral for this library as for every method.
  const small = constructState(T, Array.from({ length: 20 }, () => ({ coin: 1500000n })));
  for (const m of [tlf, evoMethod()]) {
    const r = await runOf(small, m);
    assert.deepEqual([r.outcome, r.reason], ['infeasible-collateral', 'none-eligible'], m.name);
  }

  // A collateral the library cannot make is its own failure, class
  // collateral: under the token-bearing rule the 3 ADA token UTxO is
  // eligible, but the library, pure ADA first, reaches 4.5 ADA of its 5.
  const tok = constructState(T, [{ coin: 3n * ADA, assets: [{ policy: policy('p'), name: assetName('t'), qty: 1n }] }, { coin: 1500000n }]);
  const failed = await runOf(tok, evoMethod(), 'token-bearing');
  assert.deepEqual([failed.outcome, failed.class], ['failed', CLASSES.collateral]);
  assert.match(failed.detail, /Insufficient collateral available/);

  // Under any other method's name the engine sets a UTxO aside, and the
  // library's own choice is a foreign collateral: the method's defect.
  for (const name of ['test-largest-first', 'cjs-rrri', 'csl-lf', 'unfrackit-h12', 'evo-other']) {
    const other = { ...evoMethod(), name, build: (st, it, params, opts) => buildEvo(st, it, params, { ...opts, collateral: undefined }) };
    const r = await runOf(state, other);
    assert.deepEqual([r.outcome, r.class], ['failed', CLASSES.other], name);
    assert.match(r.detail, /collateral is not the UTxO set aside/);
  }
});

test('a replay repeats byte for byte', { skip }, async () => {
  const source = loadSource(T, { kind: 'shape', name: 'S8', stream: 'synthetic' });
  const bytes = (r) => r.spends.filter((s) => s.outcome === 'built').map((s) => s.built.txs[0].bytes);
  assert.deepEqual(bytes(await replayEvo(source)), bytes(await replayEvo(source)));
});

test('the Evolution SDK builds a mint and a zero-amount script withdrawal whose redeemers are the integer 0, and prices a datum-hash spend\'s witness datum', { skip }, async () => {
  const state = shapeState(T, 'S1').state;
  const P = SYNTHETIC_PARAMS;
  const intents = zeroRedeemerIntents(T, state, P);
  const source = sourceOf(state, intents);
  const r = await replayEvo(source);
  assert.deepEqual(controlsOf(source, r), []);
  checkBuilt(source, r);
  for (const [i, tag] of [[0, 1], [1, 3]]) {
    const s = r.spends[i];
    assert.equal(s.outcome, 'built', `${intents[i].id.slice(0, 2)}: ${s.detail}`);
    const tx = inspectTx(s.built.txs[0].bytes);
    assert.deepEqual(tx.redeemers.map((x) => [x.tag, x.index, x.data, x.exUnits]), [[tag, 0, '00', EX_UNITS]]);
    assert.ok(tx.bodyFields.includes(11) && tx.collateralInputs.length === 1);
  }
  assert.equal(inspectTx(r.spends[1].built.txs[0].bytes).withdrawals[0].coin, 0n);
  for (const f of r.fees) assert.deepEqual(f.unpriced, []);

  // A datum-hash spend: the stream's script input holds the hash of d87980.
  // The library takes the datum through collectFrom and writes it with its
  // observed bytes; its fee covers it, and nothing is unpriced. A datum no
  // spent input needs is the library's to refuse, so it goes on the
  // transaction after the build, unpriced, with every observed datum.
  const stream = loadSource(T, { kind: 'shape', name: 'S1', stream: 'synthetic' });
  const t6 = stream.events.filter((e) => e.kind === 'intent').map((e) => e.intent).find((i) => i.type === 'T6' && i.fixed);
  assert.equal(unspentOutputParts(t6.fixed.inputs[0].cbor).datum.kind, 'hash');
  const spend = await buildEvo(state, t6, P, { changePolicy: 'default', seed: 1 });
  assert.equal(spend.ok, true, spend.detail);
  assert.deepEqual(spend.library.unpriced, []);
  assert.ok(spend.library.fee >= spend.library.finalMinFee);
  const datumsOf = (bytes) => listItems(Buffer.from(inspectTx(bytes).tx.wits.fields.get(4).raw)).map((b) => b.toString('hex'));
  assert.deepEqual(datumsOf(spend.txs[0].bytes), ['d87980']);
  const extra = { ...t6, fixed: { ...t6.fixed, witnesses: { ...t6.fixed.witnesses, 4: encArray([Buffer.from('d87980', 'hex'), Buffer.from('d87a80', 'hex')]).toString('hex') } } };
  const mixed = await buildEvo(state, extra, P, { changePolicy: 'default', seed: 1 });
  assert.equal(mixed.ok, true, mixed.detail);
  assert.deepEqual(mixed.library.unpriced, ['witness-set datums']);
  assert.deepEqual(datumsOf(mixed.txs[0].bytes), ['d87980', 'd87a80']);
  assert.ok(mixed.library.fee < mixed.library.finalMinFee);
});
