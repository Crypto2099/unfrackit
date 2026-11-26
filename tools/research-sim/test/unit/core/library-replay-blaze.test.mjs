// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Blaze's builder at its defaults (blaze-wd, methods/blaze.mjs): its own
// change (L/own) and UnFrack.It's layout change on the inputs it selected
// (L/layout). The adapter covers every replay part; it is deterministic, and
// ties go to the order the UTxOs are given; L/own and L/layout select the same
// inputs; an input set that cannot fund the layout change fails with class
// change-minimum; a library failure is the library's under both; any other
// change policy is refused; and each part the library cannot write makes the
// intent not replayable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '@blaze-cardano/sdk';
import { treatment, skip } from '../../lib/treatment.mjs';
import { blazeMethod, buildBlaze, classOfBlazeError, unpricedParts, BLAZE_TX_VERSION, BLAZE_SDK_VERSION } from '../../../src/methods/blaze.mjs';
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
import { shapeState } from '../../../src/shapes/shapes.mjs';
import { base58decode } from '../../../src/history/address.mjs';
import { encodeOutput, unspentOutput } from '../../../src/history/output.mjs';
import { encUint, encBytes, encArray, encMap } from '../../../src/history/cbor.mjs';
import { replayIntent, payTo as payToOf, zeroRedeemerIntents, EX_UNITS } from '../../lib/script-intents.mjs';

const P = SYNTHETIC_PARAMS;
const own = { changePolicy: 'default', seed: 1 };
const layout = { changePolicy: 'layout', seed: 1 };

test('Blaze covers every replay part, is deterministic and is given the collateral set aside', () => {
  assert.deepEqual(REPLAY_COVERAGE.blaze, [...REPLAY_PARTS]);
  const m = checkMethod(blazeMethod(null));
  assert.equal(m.name, 'blaze-wd');
  assert.deepEqual([m.deterministic, m.seeded, choosesOwnCollateral(m)], [true, true, false]);
  assert.deepEqual([BLAZE_TX_VERSION, BLAZE_SDK_VERSION], ['0.15.4', '0.3.3']);
});

test('the library\'s errors map to the failure classes', () => {
  const sel = (phase) => new Core.UTxOSelectionError(phase, new Core.Value(1n));
  assert.equal(classOfBlazeError(sel('wide')), CLASSES.balance);
  assert.equal(classOfBlazeError(sel('deep')), CLASSES.balance);
  assert.equal(classOfBlazeError(sel('final')), CLASSES.maxInputs);
  assert.equal(classOfBlazeError(new Error('No spare inputs available to add to the transaction')), CLASSES.balance);
  assert.equal(classOfBlazeError(new Error('A transaction must have at least one input, but there are no available spare inputs to add.')), CLASSES.balance);
  assert.equal(classOfBlazeError(new Error('checkOutputMinAda: Failed due to max value size!')), CLASSES.valueSize);
  assert.equal(classOfBlazeError(new Error('prepareCollateral: no inputs are sufficient to be used as collateral')), CLASSES.collateral);
  assert.equal(classOfBlazeError(new Error('checkOutputMinAda: collateral output does not have sufficient ADA to cover minUtxo value.')), CLASSES.collateral);
  assert.equal(classOfBlazeError(new Error('something else')), CLASSES.other);
});

const T = await treatment();

test('blaze-wd is made by name and refuses a change policy other than its own and the layout change', { skip }, async () => {
  const m = makeMethod(T, 'blaze-wd');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const it = payIntent(T, [{ coin: 3n * ADA }]);
  assert.equal((await m.build(s, it, P, own)).ok, true);
  const r = await m.build(s, it, P, { changePolicy: 'ladder', seed: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.class, CLASSES.other);
  assert.match(r.detail, /its own change or the layout change only/);
});

test('the same bytes on every build, the first of equal UTxOs in the order given, and the same inputs under both changes', { skip }, async () => {
  const s = constructState(T, [{ coin: 10n * ADA }, { coin: 10n * ADA }, { coin: 5n * ADA }]);
  const it = payIntent(T, [{ coin: 3n * ADA }]);
  const a = await buildBlaze(T, s, it, P, own);
  const a2 = await buildBlaze(T, s, it, P, own);
  const b = await buildBlaze(T, s, it, P, layout);
  assert.equal(a.ok, true, a.detail);
  assert.equal(a.txs[0].bytes, a2.txs[0].bytes);
  // The deep phase rates each UTxO by its lovelace and keeps the first of
  // equal ratings (micahsSelector.ts:91, strict >).
  const firstTen = inputOrder(s).find((u) => u.coin === 10n * ADA).ref;
  assert.deepEqual(a.txs[0].walletInputs, [firstTen]);
  assert.equal(b.ok, true, b.detail);
  assert.deepEqual(b.txs[0].walletInputs, a.txs[0].walletInputs);
  for (const r of [a, b]) {
    const applied = checkAndApply(s, P, r.txs);
    assert.equal(applied.ok, true, applied.failure && applied.failure.detail);
  }
  // The library's change is one output; with its fee it covers its size.
  assert.equal(inspectTx(a.txs[0].bytes).outputs.length, 2);
  assert.ok(a.library.fee >= a.library.finalMinFee);
});

test('inputs that cannot fund the layout change fail with change-minimum while the library builds its own', { skip }, async () => {
  const s = constructState(T, [{ coin: 10n * ADA, assets: Array.from({ length: 40 }, (_, i) => ({ policy: policy(`q${i}`), name: assetName('t'), qty: 1n })) }]);
  const it = payIntent(T, [{ coin: 2n * ADA }]);
  const a = await buildBlaze(T, s, it, P, own);
  assert.equal(a.ok, true, a.detail);
  assert.equal(checkAndApply(s, P, a.txs).ok, true);
  const b = await buildBlaze(T, s, it, P, layout);
  assert.equal(b.ok, false);
  assert.equal(b.class, CLASSES.changeMinimum);
  assert.match(b.detail, /^layout change on the library's inputs: /);
});

test('a library failure under the layout change is the library\'s, as under its own', { skip }, async () => {
  const s = constructState(T, [{ coin: 3n * ADA }]);
  const it = payIntent(T, [{ coin: 50n * ADA }]);
  const a = await buildBlaze(T, s, it, P, own);
  const b = await buildBlaze(T, s, it, P, layout);
  assert.equal(a.ok, false);
  assert.equal(a.class, CLASSES.balance);
  assert.deepEqual([b.ok, b.class, b.detail], [a.ok, a.class, a.detail]);
});

// The engine's replay of `source` by blaze-wd under a change policy, every
// built transaction kept, with the validity checks on.
const replayBlaze = (source, changePolicy) => replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: makeMethod(T, 'blaze-wd'), opts: { seed: 1, changePolicy, collateralRule: 'ledger' }, settleEvery: 25, keepTx: true, validity: true });

const intentsOf = (source) => source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);

test('replayed synthetic streams under both changes: no validity failure, fixed inputs kept, the same inputs, the set-aside collateral', { skip, timeout: 5 * 60 * 1000 }, async (t) => {
  const seen = {};
  for (const name of ['S1', 'M1']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const intents = intentsOf(source);
    const runs = {};
    for (const cp of ['default', 'layout']) {
      const r = await replayBlaze(source, cp);
      assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.details));
      for (const s of r.spends) assert.notEqual(s.class, CLASSES.other, `${name} ${cp} ${s.type}: ${s.detail}`);
      runs[cp] = r;
    }
    let built = 0;
    let scripts = 0;
    for (const sb of runs.layout.spends) {
      if (sb.outcome !== 'built') continue;
      built++;
      const intent = withoutLeftovers(intents[sb.intent]);
      const tx = inspectTx(sb.built.txs[0].bytes);
      for (const x of intent.fixed ? intent.fixed.inputs : []) assert.ok(tx.inputs.some((y) => y.ref === x.ref), `${sb.type}: fixed input missing`);
      // L/own on the same state selects the same wallet inputs.
      const collateral = intent.collateral.required ? tx.collateralInputs.map((x) => sb.built.before.utxos.get(x.ref))[0] : null;
      const pool = collateral ? { ...sb.built.before, utxos: new Map([...sb.built.before.utxos].filter(([k]) => k !== collateral.ref)) } : sb.built.before;
      const a = await buildBlaze(T, pool, intent, source.params, { ...own, ...(collateral ? { collateral } : {}) });
      assert.equal(a.ok, true, `${name} ${sb.type}: ${a.detail}`);
      assert.deepEqual(sb.built.txs[0].walletInputs, a.txs[0].walletInputs, `${name} ${sb.type}: inputs`);
      if (collateral) {
        scripts++;
        assert.equal(sb.collateralUsed.chosen, 'set-aside');
        assert.deepEqual(inspectTx(a.txs[0].bytes).collateralInputs.map((x) => x.ref), [collateral.ref]);
      }
    }
    // The legacy registration has no operation: the library builds without
    // it, the certificate goes on its transaction unpriced, and its deposit
    // stays unbalanced; the layout change writes and balances it.
    const reg = intents.findIndex((i) => i.fixed && i.fixed.body[4] !== undefined);
    assert.deepEqual(unpricedParts(intents[reg]), ['certificates']);
    const o = runs.default.spends.find((s) => s.intent === reg);
    assert.deepEqual([o.outcome, o.class], ['failed', CLASSES.balance]);
    assert.match(o.detail, /parts the library did not price: certificates/);
    assert.equal(runs.layout.spends.find((s) => s.intent === reg).outcome, 'built');
    seen[name] = { built, scripts };
    assert.ok(built >= 1);
  }
  assert.ok(Object.values(seen).some((x) => x.scripts > 0), JSON.stringify(seen));
  t.diagnostic(JSON.stringify(seen));
});

// A constructed source on the S1 wallet: a required signer of the wallet and
// a validity interval, a Conway registration with a delegation, a donation, a
// Plutus mint and a zero-amount script withdrawal, each with its redeemer.
function constructedSource() {
  const state = shapeState(T, 'S1').state;
  const payTo = (i, coin) => payToOf(T, i, coin);
  const stakeCred = encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))]);
  const walletKey = [...state.utxos.values()].find((u) => u.held === null).cred;
  const pool = encBytes(Buffer.alloc(28, 0x50));
  const witness = (k) => encArray([encArray([encBytes(k), encBytes(Buffer.alloc(64, 0x77))])]).toString('hex');
  const intents = [
    replayIntent('c1', 10, { type: 'T5', requested: [payTo(0, 3n * ADA)], fixed: { body: { 14: encArray([encBytes(Buffer.from(walletKey, 'hex'))]).toString('hex'), 8: encUint(5).toString('hex'), 3: encUint(5000).toString('hex') } } }),
    replayIntent('c2', 20, { type: 'T7', fixed: { body: { 4: encArray([encArray([encUint(7), stakeCred, encUint(P.keyDeposit)]), encArray([encUint(2), stakeCred, pool])]).toString('hex') }, witnesses: { 0: witness(Buffer.alloc(32, 0x73)) } }, implicit: { deposits: P.keyDeposit } }),
    replayIntent('c3', 30, { type: 'T1', requested: [payTo(1, 3n * ADA)], fixed: { body: { 22: encUint(ADA).toString('hex') } }, implicit: { donation: ADA } }),
    ...zeroRedeemerIntents(T, state).map((i, n) => ({ ...i, time: { ...i.time, slot: 40 + n, blockTime: 40 + n } }))
  ];
  return { wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: state.stakeCred, changeAddress: state.changeAddress, changeAddressEnd: state.changeAddress, franken: new Set(), start: [...state.utxos.values()], events: intents.map((intent, i) => ({ kind: 'intent', txId: i + 1, intent })), windowStart: 0, windowEnd: 1000, params: P };
}

test('a replayed signer, validity, Conway certificates, a donation, a mint and a withdrawal with redeemers build under both changes', { skip }, async () => {
  const source = constructedSource();
  for (const cp of ['default', 'layout']) {
    const r = await replayBlaze(source, cp);
    assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.details));
    for (const s of r.spends) assert.equal(s.outcome, 'built', `${cp} ${s.type}: ${s.class} ${s.detail}`);
    const txs = r.spends.map((s) => inspectTx(s.built.txs[0].bytes));
    assert.equal(txs[2].donation, ADA);
    // Every script spend carries the set-aside UTxO as its one collateral.
    for (const s of r.spends.slice(3)) assert.equal(s.collateralUsed.chosen, 'set-aside');
  }
});

// Parts the library cannot write, each on a payment from the S1 wallet.
test('each part the library cannot write makes the intent not replayable, under both changes', { skip }, async () => {
  const state = shapeState(T, 'S1').state;
  const pay = [payToOf(T, 0, 2n * ADA)];
  const byron = base58decode('37btjrVyb4KDXBNC4haBVPCrro8AQPHwvCMp3RFhhSVWwfFmZ6wwzSK6JK1hY6wHNmtrpTf1kdbva8TCneM2YsiXT7mrzT21EacHnPpz5YyUdj64na');
  const byronIn = { ref: `${'b'.repeat(64)}#0`, cbor: unspentOutput('b'.repeat(64), 0, encodeOutput({ address: byron, coin: 5n * ADA, assets: [] }, 'array')).toString('hex') };
  const scriptCred = encArray([encUint(1), encBytes(Buffer.alloc(28, 0x5c))]);
  const red = (tag, target) => ({ tag, target, data: '00', exUnits: EX_UNITS });
  const cases = [
    [{ body: { 6: encArray([encMap([]), encUint(0)]).toString('hex') } }, /^body field 6/],
    [{ body: { 15: encUint(0).toString('hex') } }, /^body field 15/],
    [{ inputs: [byronIn] }, /^a Byron address on b{64}#0/],
    [{ body: { 4: encArray([encArray([encUint(8), scriptCred, encUint(P.keyDeposit)])]).toString('hex') }, redeemers: [red(2, { kind: 'certificate', index: 0 })] }, /^a certificate no operation writes/],
    [{ redeemers: [red(4, { kind: 'voter', voter: encArray([encUint(1), encBytes(Buffer.alloc(28, 0x5d))]).toString('hex') })] }, /^a vote redeemer for a voter other than a script DRep/]
  ];
  const m = makeMethod(T, 'blaze-wd');
  for (const [fixed, why] of cases) {
    const it = replayIntent('n1', 10, { type: 'T1', requested: pay, fixed });
    for (const opts of [own, layout]) {
      const r = await m.build(state, it, P, opts);
      assert.deepEqual([r.ok, r.class], [false, NOT_REPLAYABLE], r.detail);
      assert.match(r.detail, why);
    }
  }
});
