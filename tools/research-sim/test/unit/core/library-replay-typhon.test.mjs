// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// typhonjs's paymentTransaction (typhon-lp, methods/typhon.mjs): its own
// change (L/own) and UnFrack.It's layout change on the inputs it selected
// (L/layout). The adapter covers every replay part; it is deterministic, and
// its selection is the shortest prefix of the order the UTxOs are given; the
// written-out sequence for fixed parts is paymentTransaction's; L/own and
// L/layout select the same inputs; an input set that cannot fund the layout
// change fails with class change-minimum; a library failure is the library's
// under both; any other change policy is refused; a part the library has no
// type for is written after the build; and each part the library cannot
// express makes the intent not replayable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatment, skip } from '../../lib/treatment.mjs';
import { typhonMethod, buildTyphon, classOfTyphonError, typhonPlan, TYPHON_VERSION } from '../../../src/methods/typhon.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { REPLAY_PARTS, REPLAY_COVERAGE, inputOrder } from '../../../src/methods/library.mjs';
import { NOT_REPLAYABLE, choosesOwnCollateral, checkMethod } from '../../../src/methods/contract.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { checkAndApply } from '../../../src/kit/apply.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { withoutLeftovers } from '../../../src/kit/replay.mjs';
import { replay } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { constructState, payIntent, policy, assetName, ADA } from '../../lib/construct.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { executionFee } from '../../../src/history/params.mjs';
import { shapeState } from '../../../src/shapes/shapes.mjs';
import { base58decode, addressBytes } from '../../../src/history/address.mjs';
import { encodeOutput, unspentOutput } from '../../../src/history/output.mjs';
import { blake2b224, blake2b256 } from '../../../src/history/blake2b.mjs';
import { decode, raw, encUint, encInt, encBytes, encArray, encMap, encTag, encText } from '../../../src/history/cbor.mjs';
import { replayIntent, payTo as payToOf, EX_UNITS } from '../../lib/script-intents.mjs';

const P = SYNTHETIC_PARAMS;
const own = { changePolicy: 'default', seed: 1 };
const layout = { changePolicy: 'layout', seed: 1 };
const txid = (n) => n.toString(16).padStart(64, '0');

test('typhonjs covers every replay part, is deterministic and is given the collateral set aside', () => {
  assert.deepEqual(REPLAY_COVERAGE.typhon, [...REPLAY_PARTS]);
  const m = checkMethod(typhonMethod(null));
  assert.equal(m.name, 'typhon-lp');
  assert.deepEqual([m.deterministic, m.seeded, choosesOwnCollateral(m)], [true, true, false]);
  assert.equal(TYPHON_VERSION, '4.0.0');
});

test('the library\'s errors map to the failure classes', () => {
  assert.equal(classOfTyphonError(new Error('Not enough ADA')), CLASSES.balance);
  assert.equal(classOfTyphonError(new Error('Not enough ADA'), { tokenChange: true }), CLASSES.changeMinimum);
  assert.equal(classOfTyphonError(new Error('Not enough tokens')), CLASSES.balance);
  assert.equal(classOfTyphonError(new Error('No inputs to spend')), CLASSES.balance);
  assert.equal(classOfTyphonError(new Error('Tx size limit reached, try spending lesser ADA/Tokens')), CLASSES.txSize);
  assert.equal(classOfTyphonError(new Error('Token does not fit in an output within maxValueSize')), CLASSES.valueSize);
  assert.equal(classOfTyphonError(new Error('Not enough collateral supplied')), CLASSES.collateral);
  assert.equal(classOfTyphonError(new Error('Tokens of the collateral don\'t fit in a collateral return')), CLASSES.collateral);
  assert.equal(classOfTyphonError(new Error('something else')), CLASSES.other);
});

const T = await treatment();

test('typhon-lp is made by name and refuses a change policy other than its own and the layout change', { skip }, async () => {
  const m = makeMethod(T, 'typhon-lp');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const it = payIntent(T, [{ coin: 3n * ADA }]);
  assert.equal((await m.build(s, it, P, own)).ok, true);
  const r = await m.build(s, it, P, { changePolicy: 'ladder', seed: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.class, CLASSES.other);
  assert.match(r.detail, /its own change or the layout change only/);
});

test('the same bytes on every build, the shortest prefix of the order given, and the same inputs under both changes', { skip }, () => {
  // The state's order is the transaction ids'; the 1 ADA UTxOs come first.
  const s = constructState(T, [{ txid: txid(1), coin: 1n * ADA }, { txid: txid(2), coin: 1n * ADA }, { txid: txid(3), coin: 50n * ADA }, { txid: txid(4), coin: 50n * ADA }]);
  const it = payIntent(T, [{ coin: 3n * ADA }]);
  const a = buildTyphon(T, s, it, P, own);
  const a2 = buildTyphon(T, s, it, P, own);
  const b = buildTyphon(T, s, it, P, layout);
  assert.equal(a.ok, true, a.detail);
  assert.equal(a.txs[0].bytes, a2.txs[0].bytes);
  // The first is taken whatever it holds, then each next one while the inputs
  // fall short (transactionBuilder.ts:145-223): the first three, never the
  // fourth.
  assert.deepEqual(a.txs[0].walletInputs, inputOrder(s).slice(0, 3).map((u) => u.ref));
  assert.equal(b.ok, true, b.detail);
  assert.deepEqual(b.txs[0].walletInputs, a.txs[0].walletInputs);
  for (const r of [a, b]) {
    const applied = checkAndApply(s, P, r.txs);
    assert.equal(applied.ok, true, applied.failure && applied.failure.detail);
  }
  // One ADA-only change output; the library's fee covers its size.
  assert.equal(inspectTx(a.txs[0].bytes).outputs.length, 2);
  assert.ok(a.library.fee >= a.library.finalMinFee);
});

test('the written-out sequence an intent with fixed parts takes is paymentTransaction\'s', { skip }, () => {
  const s = constructState(T, [{ coin: 10n * ADA }, { coin: 20n * ADA }]);
  const pay = [payToOf(T, 0, 3n * ADA)];
  const plain = replayIntent('p1', 10, { type: 'T1', requested: pay });
  const empty = replayIntent('p1', 10, { type: 'T1', requested: pay, fixed: {} });
  assert.equal(typhonPlan(plain, P).plain, true);
  assert.equal(typhonPlan(empty, P).plain, false);
  const a = buildTyphon(T, s, plain, P, own);
  const b = buildTyphon(T, s, empty, P, own);
  assert.equal(a.ok, true, a.detail);
  assert.equal(b.txs[0].bytes, a.txs[0].bytes);
  // The intent's TTL reaches the library through setTTL in both.
  const ttl = replayIntent('p2', 10, { type: 'T1', requested: pay, fixed: { body: { 3: encUint(9000).toString('hex') } } });
  assert.equal(inspectTx(buildTyphon(T, s, ttl, P, own).txs[0].bytes).tx.body.fields.has(3), true);
});

test('inputs that cannot fund the layout change fail with change-minimum while the library builds its own', { skip }, () => {
  const s = constructState(T, [{ coin: 10n * ADA, assets: Array.from({ length: 40 }, (_, i) => ({ policy: policy(`q${i}`), name: assetName('t'), qty: 1n })) }]);
  const it = payIntent(T, [{ coin: 2n * ADA }]);
  const a = buildTyphon(T, s, it, P, own);
  assert.equal(a.ok, true, a.detail);
  assert.equal(checkAndApply(s, P, a.txs).ok, true);
  const b = buildTyphon(T, s, it, P, layout);
  assert.equal(b.ok, false);
  assert.equal(b.class, CLASSES.changeMinimum);
  assert.match(b.detail, /^layout change on the library's inputs: /);
});

test('a library failure under the layout change is the library\'s, as under its own', { skip }, () => {
  const short = constructState(T, [{ coin: 3n * ADA }]);
  const pay = payIntent(T, [{ coin: 50n * ADA }]);
  const a = buildTyphon(T, short, pay, P, own);
  const b = buildTyphon(T, short, pay, P, layout);
  assert.deepEqual([a.ok, a.class], [false, CLASSES.balance]);
  assert.deepEqual([b.ok, b.class, b.detail], [a.ok, a.class, a.detail]);
  // A token left over whose change output the leftover ADA cannot pay.
  const tokens = constructState(T, [{ coin: 1500000n, assets: [{ policy: policy('c'), name: assetName('t'), qty: 1n }] }]);
  const c = buildTyphon(T, tokens, payIntent(T, [{ coin: 1n * ADA }]), P, own);
  assert.deepEqual([c.ok, c.class], [false, CLASSES.changeMinimum], c.detail);
  assert.match(c.detail, /Not enough ADA/);
});

// The engine's replay of `source` by typhon-lp under a change policy, every
// built transaction kept, with the validity checks on.
const replayTyphon = (source, changePolicy) => replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: makeMethod(T, 'typhon-lp'), opts: { seed: 1, changePolicy, collateralRule: 'ledger' }, settleEvery: 25, keepTx: true, validity: true });

const intentsOf = (source) => source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);

// The kit's failure of a requested output the library writes in the map form
// at the coin the intent gives, under its minimum in that form.
const requestedMinimum = /^kit: minimum: output \d+: coin \d+ under its minimum \d+/;

test('replayed synthetic streams under both changes: no validity failure, fixed inputs kept, the same inputs', { skip, timeout: 5 * 60 * 1000 }, async (t) => {
  const seen = {};
  for (const name of ['S1', 'M1']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const intents = intentsOf(source);
    const runs = {};
    for (const cp of ['default', 'layout']) {
      const r = await replayTyphon(source, cp);
      assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.details));
      for (const s of r.spends) {
        if (s.class === CLASSES.other) assert.match(s.detail, requestedMinimum, `${name} ${cp} ${s.type}`);
        // The shapes' synthetic Plutus script is not a CBOR byte string.
        if (s.outcome === NOT_REPLAYABLE) assert.match(s.detail, /a Plutus script whose bytes are not a CBOR byte string/);
      }
      runs[cp] = r;
    }
    // Every spend L/own fails on a requested output's minimum builds under
    // L/layout, which writes the output's own bytes.
    for (const s of runs.default.spends.filter((x) => x.class === CLASSES.other)) assert.equal(runs.layout.spends.find((x) => x.intent === s.intent).outcome, 'built');
    let built = 0;
    let fixed = 0;
    for (const sb of runs.layout.spends) {
      if (sb.outcome !== 'built') continue;
      built++;
      const intent = withoutLeftovers(intents[sb.intent]);
      if (intent.fixed) fixed++;
      const tx = inspectTx(sb.built.txs[0].bytes);
      for (const x of intent.fixed ? intent.fixed.inputs : []) assert.ok(tx.inputs.some((y) => y.ref === x.ref), `${sb.type}: fixed input missing`);
      // L/own on the same state selects the same wallet inputs.
      const a = buildTyphon(T, sb.built.before, intent, source.params, own);
      assert.equal(a.ok, true, `${name} ${sb.type}: ${a.detail}`);
      assert.deepEqual(sb.built.txs[0].walletInputs, a.txs[0].walletInputs, `${name} ${sb.type}: inputs`);
    }
    seen[name] = { built, fixed };
    assert.ok(built >= 1 && fixed >= 1);
  }
  t.diagnostic(JSON.stringify(seen));
});

// A Plutus V3 script whose bytes are a CBOR byte string, as every script on
// chain is (the library reads them so), the policy and script stake credential
// it hashes to, and the integer 0 as redeemer data.
const V3 = encBytes(Buffer.alloc(118, 0x5a));
const V3_HASH = blake2b224(Buffer.concat([Buffer.from([3]), V3])).toString('hex');
const zeroRedeemers = (pointers) => encArray(pointers.map(([tag, index]) => encArray([encUint(tag), encUint(index), Buffer.from('00', 'hex'), encArray([encUint(EX_UNITS[0]), encUint(EX_UNITS[1])])]))).toString('hex');

// A constructed source on the S1 wallet: a required signer of the wallet and
// a validity interval, a Conway registration with a delegation, a donation, a
// Plutus mint and a zero-amount script withdrawal, each with its redeemer, and
// a payment carrying an inline datum.
function constructedSource() {
  const state = shapeState(T, 'S1').state;
  const payTo = (i, coin, extra) => payToOf(T, i, coin, extra);
  const stakeCred = encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))]);
  const walletKey = [...state.utxos.values()].find((u) => u.held === null).cred;
  const pool = encBytes(Buffer.alloc(28, 0x50));
  const witness = (k) => encArray([encArray([encBytes(k), encBytes(Buffer.alloc(64, 0x77))])]).toString('hex');
  const net = addressBytes(state.changeAddress)[0] & 15;
  const account = Buffer.concat([Buffer.from([0xf0 | net]), Buffer.from(V3_HASH, 'hex')]).toString('hex');
  const scriptFee = executionFee(P, EX_UNITS[0], EX_UNITS[1]);
  const scripts = { 7: encArray([encBytes(V3)]).toString('hex') };
  // An inline datum in the library's own encoding: constructor 0 with an
  // indefinite field list.
  const datum = Buffer.from('d8799f4100ff', 'hex');
  const recipient = payTo(2, 3n * ADA);
  const withDatum = encodeOutput({ address: addressBytes(recipient.address), coin: 3n * ADA, assets: [], datum: { kind: 'inline', cbor: datum.toString('hex') } }, 'map');
  const intents = [
    replayIntent('c1', 10, { type: 'T5', requested: [payTo(0, 3n * ADA)], fixed: { body: { 14: encArray([encBytes(Buffer.from(walletKey, 'hex'))]).toString('hex'), 8: encUint(5).toString('hex'), 3: encUint(5000).toString('hex') } } }),
    replayIntent('c2', 20, { type: 'T7', fixed: { body: { 4: encArray([encArray([encUint(7), stakeCred, encUint(P.keyDeposit)]), encArray([encUint(2), stakeCred, pool])]).toString('hex') }, witnesses: { 0: witness(Buffer.alloc(32, 0x73)) } }, implicit: { deposits: P.keyDeposit } }),
    replayIntent('c3', 30, { type: 'T1', requested: [payTo(1, 3n * ADA)], fixed: { body: { 22: encUint(ADA).toString('hex') } }, implicit: { donation: ADA } }),
    replayIntent('c4', 40, {
      type: 'T6',
      requested: [payTo(10, 2n * ADA)],
      fixed: { body: { 9: encMap([[encBytes(Buffer.from(V3_HASH, 'hex')), encMap([[encBytes(Buffer.from('7a', 'hex')), encInt(1n)]])]]).toString('hex') }, witnesses: { ...scripts, 5: zeroRedeemers([[1, 0]]) }, redeemers: [{ tag: 1, target: { kind: 'policy', policy: V3_HASH }, data: '00', exUnits: EX_UNITS }], scriptFee },
      implicit: { mint: [{ policy: V3_HASH, name: '7a', qty: 1n }] },
      collateral: true
    }),
    replayIntent('c5', 50, {
      type: 'T6',
      requested: [payTo(11, 2n * ADA)],
      fixed: { body: { 5: encMap([[encBytes(Buffer.from(account, 'hex')), encUint(0)]]).toString('hex') }, witnesses: { ...scripts, 5: zeroRedeemers([[3, 0]]) }, redeemers: [{ tag: 3, target: { kind: 'withdrawal', account }, data: '00', exUnits: EX_UNITS }], scriptFee },
      collateral: true
    }),
    replayIntent('c6', 60, { type: 'T1', requested: [{ ...recipient, cbor: withDatum.toString('hex'), datum: { kind: 'inline', cbor: datum.toString('hex') } }] })
  ];
  return { wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: state.stakeCred, changeAddress: state.changeAddress, changeAddressEnd: state.changeAddress, franken: new Set(), start: [...state.utxos.values()], events: intents.map((intent, i) => ({ kind: 'intent', txId: i + 1, intent })), windowStart: 0, windowEnd: 1000, params: P };
}

test('a replayed signer, validity, Conway certificates, a donation, a mint and a withdrawal with redeemers, and an inline datum build under both changes', { skip }, async () => {
  const source = constructedSource();
  for (const cp of ['default', 'layout']) {
    const r = await replayTyphon(source, cp);
    assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.details));
    for (const s of r.spends) assert.equal(s.outcome, 'built', `${cp} ${s.type}: ${s.class} ${s.detail}`);
    const txs = r.spends.map((s) => inspectTx(s.built.txs[0].bytes));
    assert.equal(txs[2].donation, ADA);
    // Every script spend carries the set-aside UTxO as its one collateral.
    for (const s of r.spends.slice(3, 5)) assert.equal(s.collateralUsed.chosen, 'set-aside');
    assert.equal(txs[5].outputs[0].datum.cbor, 'd8799f4100ff');
  }
});

// Parts the library has no type for, written after its build, each on a
// payment from the S1 wallet.
test('a part the library has no type for is written on its transaction after the build, unpriced', { skip }, () => {
  const state = shapeState(T, 'S1').state;
  const pay = [payToOf(T, 0, 2n * ADA)];
  // A pool retirement (kind 4) and a delegation: every certificate goes after.
  const certs = encArray([encArray([encUint(4), encBytes(Buffer.alloc(28, 0x51)), encUint(400)]), encArray([encUint(2), encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))]), encBytes(Buffer.alloc(28, 0x50))])]);
  const a = buildTyphon(T, state, replayIntent('a1', 10, { type: 'T7', requested: pay, fixed: { body: { 4: certs.toString('hex') } } }), P, own);
  assert.equal(a.ok, true, a.detail);
  assert.deepEqual(a.library.unpriced, ['certificates']);
  assert.equal(Buffer.from(inspectTx(a.txs[0].bytes).tx.body.fields.get(4).raw).toString('hex'), certs.toString('hex'));
  // Auxiliary data carrying a native script: the observed bytes and their
  // hash replace the library's.
  const native = encArray([encUint(0), encBytes(Buffer.alloc(28, 0x52))]);
  const aux = encTag(259, encMap([[encUint(0), encMap([[encUint(674), encText('x')]])], [encUint(1), encArray([native])]]));
  const b = buildTyphon(T, state, replayIntent('a2', 10, { type: 'T1', requested: pay, fixed: { auxiliaryData: aux.toString('hex') } }), P, own);
  assert.equal(b.ok, true, b.detail);
  assert.deepEqual(b.library.unpriced, ['auxiliary data']);
  const n = decode(Buffer.from(b.txs[0].bytes, 'hex'));
  const buf = Buffer.from(b.txs[0].bytes, 'hex');
  assert.equal(raw(buf, n.items[3]).toString('hex'), aux.toString('hex'));
  const hash = n.items[0].entries.find(([k]) => Number(k.value) === 7)[1];
  assert.equal(hash.value.toString('hex'), blake2b256(aux).toString('hex'));
  // Metadata alone is the library's own to write, in its Conway form.
  const meta = encMap([[encUint(674), encText('x')]]);
  const c = buildTyphon(T, state, replayIntent('a3', 10, { type: 'T1', requested: pay, fixed: { auxiliaryData: meta.toString('hex') } }), P, own);
  assert.deepEqual(c.library.unpriced, []);
  assert.equal(decode(Buffer.from(c.txs[0].bytes, 'hex')).items[3].tag, 259n);
});

// Parts the library cannot express, each on a payment from the S1 wallet.
test('each part the library cannot express makes the intent not replayable, under both changes', { skip }, async () => {
  const state = shapeState(T, 'S1').state;
  const pay = [payToOf(T, 0, 2n * ADA)];
  const byron = base58decode('37btjrVyb4KDXBNC4haBVPCrro8AQPHwvCMp3RFhhSVWwfFmZ6wwzSK6JK1hY6wHNmtrpTf1kdbva8TCneM2YsiXT7mrzT21EacHnPpz5YyUdj64na');
  const byronIn = { ref: `${'b'.repeat(64)}#0`, cbor: unspentOutput('b'.repeat(64), 0, encodeOutput({ address: byron, coin: 5n * ADA, assets: [] }, 'array')).toString('hex') };
  const red = (tag, target) => ({ tag, target, data: '00', exUnits: EX_UNITS });
  const poolRetirement = encArray([encArray([encUint(4), encBytes(Buffer.alloc(28, 0x51)), encUint(400)])]);
  // A datum with a definite-length field list, which the library writes
  // indefinite.
  const definite = Buffer.from('d879814100', 'hex');
  const recipient = pay[0];
  const withDatum = { ...recipient, cbor: encodeOutput({ address: addressBytes(recipient.address), coin: recipient.coin, assets: [], datum: { kind: 'inline', cbor: definite.toString('hex') } }, 'map').toString('hex'), datum: { kind: 'inline', cbor: definite.toString('hex') } };
  // A Plutus script whose bytes are not a CBOR byte string, minting.
  const bad = Buffer.alloc(30, 0x5a);
  const badPolicy = blake2b224(Buffer.concat([Buffer.from([3]), bad])).toString('hex');
  const badMint = { body: { 9: encMap([[encBytes(Buffer.from(badPolicy, 'hex')), encMap([[encBytes(Buffer.from('7a', 'hex')), encInt(1n)]])]]).toString('hex') }, witnesses: { 7: encArray([encBytes(bad)]).toString('hex') } };
  const cases = [
    [{ body: { 6: encArray([encMap([]), encUint(0)]).toString('hex') } }, pay, {}, /^body field 6/],
    [{ body: { 15: encUint(0).toString('hex') } }, pay, {}, /^body field 15/],
    [{ inputs: [byronIn] }, pay, {}, /^a Byron address on b{64}#0/],
    [{ body: { 4: poolRetirement.toString('hex') }, redeemers: [red(2, { kind: 'certificate', index: 0 })] }, pay, {}, /^a certificate of a kind the library has no type for/],
    [null, [withDatum], {}, /^requested output 0's inline datum: the library's Plutus data encoding does not reproduce its bytes/],
    [badMint, pay, { mint: [{ policy: badPolicy, name: '7a', qty: 1n }] }, /a Plutus script whose bytes are not a CBOR byte string/]
  ];
  const m = makeMethod(T, 'typhon-lp');
  for (const [fixed, requested, implicit, why] of cases) {
    const it = replayIntent('n1', 10, { type: 'T1', requested, fixed, implicit });
    for (const opts of [own, layout]) {
      const r = await m.build(state, it, P, opts);
      assert.deepEqual([r.ok, r.class], [false, NOT_REPLAYABLE], r.detail);
      assert.match(r.detail, why);
    }
  }
});
