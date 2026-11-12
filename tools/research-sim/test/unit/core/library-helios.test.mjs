// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Helios through its own helper (helios-sf, methods/helios.mjs):
// WalletHelper.selectUtxos at its smallest-first default, then build with the
// wallet's UTxOs as spares; its own change (L/own) and UnFrack.It's layout
// change on the inputs it holds (L/layout). The adapter covers every replay
// part; it is deterministic; the selector takes the smallest first, more
// tokens first among UTxOs holding the asset, ties in the order given, and
// build draws spares from the end of the list; L/own and L/layout hold the
// same inputs; an input set that cannot fund the layout change fails with
// class change-minimum; a library failure is the library's under both; any
// other change policy is refused; script spends run in the library's machine
// with the observed units; and each part the library cannot hold makes the
// intent not replayable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeUplcProgramV2, makeUplcLambda, makeUplcConst, makeUplcInt } from '@helios-lang/uplc';
import { treatment, skip } from '../../lib/treatment.mjs';
import { heliosMethod, buildHelios, classOfHeliosError, requestedValue, HELIOS_TX_UTILS_VERSION, HELIOS_LEDGER_VERSION } from '../../../src/methods/helios.mjs';
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
import { base58decode, addressBytes } from '../../../src/history/address.mjs';
import { encodeOutput, unspentOutput } from '../../../src/history/output.mjs';
import { executionFee } from '../../../src/history/params.mjs';
import { encUint, encInt, encBytes, encArray, encMap, encTag, encText } from '../../../src/history/cbor.mjs';
import { replayIntent, payTo as payToOf, V3, EX_UNITS } from '../../lib/script-intents.mjs';

const P = SYNTHETIC_PARAMS;
const own = { changePolicy: 'default', seed: 1 };
const layout = { changePolicy: 'layout', seed: 1 };

test('Helios covers every replay part, is deterministic and is given the collateral set aside', () => {
  assert.deepEqual(REPLAY_COVERAGE.helios, [...REPLAY_PARTS]);
  const m = checkMethod(heliosMethod(null));
  assert.equal(m.name, 'helios-sf');
  assert.deepEqual([m.deterministic, m.seeded, choosesOwnCollateral(m)], [true, true, false]);
  assert.deepEqual([HELIOS_TX_UTILS_VERSION, HELIOS_LEDGER_VERSION], ['0.6.42', '0.7.24']);
});

test('the library\'s errors map to the failure classes', () => {
  const cases = [
    ['Insufficient funds error: need {...}', CLASSES.balance],
    ['wallet returned 0 utxos, set the helper getUtxosFallback callback to use an Api query layer instead', CLASSES.balance],
    ['not enough input assets', CLASSES.balance],
    ['UTxOs too fragmented (hint: set allowDirtySpareInputs==true to allow balancing with dirty UTXOs)', CLASSES.balance],
    ['need 5000000 lovelace, but only have 3000000', CLASSES.balance],
    ['tx not balanced, net lovelace not zero (5)', CLASSES.balance],
    ['Unable to balance transaction, not enough spare lovelace to create two change outputs to have at least one clean change output', CLASSES.changeMinimum],
    ['not enough lovelace in output (expected at least 1, got 0)', CLASSES.changeMinimum],
    ['tx too big', CLASSES.txSize],
    ['fee too small, expected at least 2, got 1', CLASSES.feeMinimum],
    ['unable to find enough collateral input', CLASSES.collateral],
    ['not enough collateral', CLASSES.collateral],
    ['collateral can only contain lovelace', CLASSES.collateral],
    ['too many collateral inputs', CLASSES.collateral],
    ['collateralReturn is 5 lovelace is too high', CLASSES.collateral],
    ['script validation error in input @0: no', CLASSES.other]
  ];
  for (const [m, cls] of cases) assert.equal(classOfHeliosError(new Error(m)), cls, m);
});

const T = await treatment();

test('helios-sf is made by name and refuses a change policy other than its own and the layout change', { skip }, async () => {
  const m = makeMethod(T, 'helios-sf');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const it = payIntent(T, [{ coin: 3n * ADA }]);
  assert.equal((await m.build(s, it, P, own)).ok, true);
  const r = await m.build(s, it, P, { changePolicy: 'ladder', seed: 1 });
  assert.deepEqual([r.ok, r.class], [false, CLASSES.other]);
  assert.match(r.detail, /its own change or the layout change only/);
});

test('the smallest first, ties in the order given, spares from the end of the list, the same bytes for any seed and the same inputs under both changes', { skip }, async () => {
  const s = constructState(T, [{ coin: 3n * ADA }, { coin: 3n * ADA }, { coin: 3n * ADA }, { coin: 9n * ADA }]);
  const it = payIntent(T, [{ coin: 1n * ADA }]);
  const a = await buildHelios(T, s, it, P, own);
  const a2 = await buildHelios(T, s, it, P, { ...own, seed: 2 });
  const b = await buildHelios(T, s, it, P, layout);
  assert.equal(a.ok, true, a.detail);
  assert.equal(a.txs[0].bytes, a2.txs[0].bytes);
  // The selector takes the first 3 ADA UTxO in the state's order
  // (extremumFirst.js:59-83, a stable sort); build, short of the largest fee
  // and the change minimum, takes the clean spares from the end of the list
  // (TxBuilder.js:2141-2170), the 9 ADA UTxO first.
  const order = inputOrder(s);
  const threes = order.filter((u) => u.coin === 3n * ADA);
  const nine = order.find((u) => u.coin === 9n * ADA);
  const lastClean = order.filter((u) => u.ref !== threes[0].ref).at(-1);
  assert.deepEqual(new Set(a.txs[0].walletInputs), new Set([threes[0].ref, lastClean.ref]));
  assert.ok([nine.ref, threes[2].ref].includes(lastClean.ref));
  assert.equal(b.ok, true, b.detail);
  assert.deepEqual(b.txs[0].walletInputs, a.txs[0].walletInputs);
  for (const r of [a, b]) {
    const applied = checkAndApply(s, P, r.txs);
    assert.equal(applied.ok, true, applied.failure && applied.failure.detail);
  }
  // One lovelace change output beside the payment.
  assert.equal(inspectTx(a.txs[0].bytes).outputs.length, 2);
});

test('among UTxOs holding a requested token, the one holding more tokens comes first', { skip }, async () => {
  const x = { policy: policy('x'), name: assetName('x') };
  const y = { policy: policy('y'), name: assetName('y') };
  const s = constructState(T, [{ coin: 5n * ADA, assets: [{ ...x, qty: 1n }] }, { coin: 5n * ADA, assets: [{ ...x, qty: 5n }, { ...y, qty: 1n }] }, { coin: 20n * ADA }]);
  const it = payIntent(T, [{ coin: 2n * ADA, assets: [{ ...x, qty: 1n }] }]);
  const r = await buildHelios(T, s, it, P, own);
  assert.equal(r.ok, true, r.detail);
  const two = [...s.utxos.values()].find((u) => u.assets.length === 2).ref;
  const one = [...s.utxos.values()].find((u) => u.assets.length === 1).ref;
  assert.ok(r.txs[0].walletInputs.includes(two));
  assert.ok(!r.txs[0].walletInputs.includes(one));
  assert.equal(checkAndApply(s, P, r.txs).ok, true);
});

test('the value asked of the selector is the request less what the transaction\'s own parts supply', () => {
  const pol = policy('m');
  const it = replayIntent('v1', 10, {
    type: 'T6',
    requested: [{ ...payToOf(T, 0, 3n * ADA), assets: [{ policy: pol, name: '61', qty: 2n }] }],
    implicit: { mint: [{ policy: pol, name: '61', qty: 2n }], withdrawals: 1n * ADA }
  });
  const v = requestedValue(it);
  assert.equal(v.lovelace, 2n * ADA);
  assert.ok(v.assets.isZero());
});

// The library's token change is one output for the 199 tokens left (its
// default maxAssetsPerChangeOutput, the largest token count of an input,
// TxBuilder.js:422-430); the layout change packs them into several outputs,
// each at its minimum, which 13 ADA does not fund.
test('inputs that cannot fund the layout change fail with change-minimum while the library builds its own', { skip }, async () => {
  const tokens = Array.from({ length: 200 }, (_, i) => ({ policy: policy('one'), name: assetName(`nft${String(i).padStart(3, '0')}`), qty: 1n }));
  const s = constructState(T, [{ coin: 13n * ADA, assets: tokens }]);
  const it = payIntent(T, [{ coin: 1n * ADA, assets: [{ ...tokens[0] }] }]);
  const a = await buildHelios(T, s, it, P, own);
  assert.equal(a.ok, true, a.detail);
  assert.equal(checkAndApply(s, P, a.txs).ok, true);
  const b = await buildHelios(T, s, it, P, layout);
  assert.deepEqual([b.ok, b.class], [false, CLASSES.changeMinimum], b.detail);
  assert.match(b.detail, /^layout change on the library's inputs: /);
});

test('a library failure under the layout change is the library\'s, as under its own', { skip }, async () => {
  const s = constructState(T, [{ coin: 3n * ADA }]);
  const it = payIntent(T, [{ coin: 50n * ADA }]);
  const a = await buildHelios(T, s, it, P, own);
  const b = await buildHelios(T, s, it, P, layout);
  assert.deepEqual([a.ok, a.class, a.detail], [false, CLASSES.balance, 'build: Insufficient funds error']);
  assert.deepEqual([b.ok, b.class, b.detail], [a.ok, a.class, a.detail]);
});

// The engine's replay of `source` by helios-sf under a change policy, every
// built transaction kept, with the validity checks on.
const replayHelios = (source, changePolicy) => replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: makeMethod(T, 'helios-sf'), opts: { seed: 1, changePolicy, collateralRule: 'ledger' }, settleEvery: 25, keepTx: true, validity: true });

const intentsOf = (source) => source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);

test('replayed synthetic streams under both changes: no validity failure, fixed inputs kept, the same inputs', { skip, timeout: 5 * 60 * 1000 }, async () => {
  for (const name of ['S1', 'M1']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const intents = intentsOf(source);
    const runs = {};
    for (const cp of ['default', 'layout']) {
      const r = await replayHelios(source, cp);
      assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.details));
      for (const s of r.spends) assert.notEqual(s.class, CLASSES.other, `${name} ${cp} ${s.type}: ${s.detail}`);
      runs[cp] = r;
    }
    let built = 0;
    for (const sb of runs.layout.spends) {
      if (sb.outcome !== 'built') continue;
      built++;
      const intent = withoutLeftovers(intents[sb.intent]);
      const tx = inspectTx(sb.built.txs[0].bytes);
      for (const x of intent.fixed ? intent.fixed.inputs : []) assert.ok(tx.inputs.some((y) => y.ref === x.ref), `${sb.type}: fixed input missing`);
      // L/own on the same state holds the same wallet inputs.
      const a = await buildHelios(T, sb.built.before, intent, source.params, own);
      assert.equal(a.ok, true, `${name} ${sb.type}: ${a.detail}`);
      assert.deepEqual(sb.built.txs[0].walletInputs, a.txs[0].walletInputs, `${name} ${sb.type}: inputs`);
    }
    assert.ok(built >= 1);
    // The shapes' Plutus test script is not a program the library can read.
    const nr = runs.default.spends.filter((s) => s.outcome === NOT_REPLAYABLE);
    assert.ok(nr.length >= 1 && nr.every((s) => /^a witness-set script the library cannot read/.test(s.detail)), JSON.stringify(nr.map((s) => s.detail)));
  }
});

// A program the library runs: two arguments and a constant result, so a
// Plutus V2 minting policy or stake validator that always succeeds, with the
// policy, the script stake credential and the reward account it hashes to.
const PROGRAM = makeUplcProgramV2(makeUplcLambda({ body: makeUplcLambda({ body: makeUplcConst({ value: makeUplcInt(0) }) }) }));
const PROGRAM_BYTES = Buffer.from(PROGRAM.toCbor());
const PROGRAM_HASH = Buffer.from(PROGRAM.hash()).toString('hex');

// A constructed source on the S1 wallet: a required signer of the wallet with
// a validity interval and label 674 metadata; a legacy stake registration; a
// mint under the program with its redeemer; a zero withdrawal from the
// program's stake credential with its redeemer; and a withdrawal of rewards.
function constructedSource() {
  const state = shapeState(T, 'S1').state;
  const payTo = (i, coin) => payToOf(T, i, coin);
  const stakeCred = encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))]);
  const walletKey = [...state.utxos.values()].find((u) => u.held === null).cred;
  const net = addressBytes(state.changeAddress)[0] & 15;
  const scriptAccount = Buffer.concat([Buffer.from([0xf0 | net]), Buffer.from(PROGRAM_HASH, 'hex')]).toString('hex');
  const keyAccount = Buffer.concat([Buffer.from([0xe0 | net]), Buffer.from(state.stakeCred, 'hex')]).toString('hex');
  const scriptFee = executionFee(P, EX_UNITS[0], EX_UNITS[1]);
  const scripts = { 6: encArray([PROGRAM_BYTES]).toString('hex') };
  const reds = (tag, index) => encArray([encArray([encUint(tag), encUint(index), Buffer.from('00', 'hex'), encArray([encUint(EX_UNITS[0]), encUint(EX_UNITS[1])])])]).toString('hex');
  const metadata = encMap([[encUint(674), encMap([[encText('msg'), encArray([encText('helios')])]])]]).toString('hex');
  const intents = [
    replayIntent('h1', 10, { type: 'T5', requested: [payTo(0, 3n * ADA)], fixed: { body: { 14: encArray([encBytes(Buffer.from(walletKey, 'hex'))]).toString('hex'), 8: encUint(5).toString('hex'), 3: encUint(5000).toString('hex') }, auxiliaryData: metadata } }),
    replayIntent('h2', 20, { type: 'T7', fixed: { body: { 4: encArray([encArray([encUint(0), stakeCred])]).toString('hex') } }, implicit: { deposits: P.keyDeposit } }),
    replayIntent('h3', 30, {
      type: 'T6',
      requested: [payTo(1, 2n * ADA)],
      fixed: { body: { 9: encMap([[encBytes(Buffer.from(PROGRAM_HASH, 'hex')), encMap([[encBytes(Buffer.from('7a', 'hex')), encInt(1n)]])]]).toString('hex') }, witnesses: { ...scripts, 5: reds(1, 0) }, redeemers: [{ tag: 1, target: { kind: 'policy', policy: PROGRAM_HASH }, data: '00', exUnits: EX_UNITS }], scriptFee },
      implicit: { mint: [{ policy: PROGRAM_HASH, name: '7a', qty: 1n }] },
      collateral: true
    }),
    replayIntent('h4', 40, {
      type: 'T6',
      requested: [payTo(2, 2n * ADA)],
      fixed: { body: { 5: encMap([[encBytes(Buffer.from(scriptAccount, 'hex')), encUint(0)]]).toString('hex') }, witnesses: { ...scripts, 5: reds(3, 0) }, redeemers: [{ tag: 3, target: { kind: 'withdrawal', account: scriptAccount }, data: '00', exUnits: EX_UNITS }], scriptFee },
      collateral: true
    }),
    replayIntent('h5', 50, { type: 'T1', requested: [payTo(3, 2n * ADA)], fixed: { body: { 5: encMap([[encBytes(Buffer.from(keyAccount, 'hex')), encUint(3n * ADA)]]).toString('hex') } }, implicit: { withdrawals: 3n * ADA } })
  ];
  return { wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: state.stakeCred, changeAddress: state.changeAddress, changeAddressEnd: state.changeAddress, franken: new Set(), start: [...state.utxos.values()], events: intents.map((intent, i) => ({ kind: 'intent', txId: i + 1, intent })), windowStart: 0, windowEnd: 1000, params: P };
}

test('a replayed signer, validity, metadata, a registration and script spends build under both changes; a reward withdrawal is the library\'s balance failure', { skip }, async () => {
  const source = constructedSource();
  for (const cp of ['default', 'layout']) {
    const r = await replayHelios(source, cp);
    assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.details));
    for (const s of r.spends.slice(0, 4)) assert.equal(s.outcome, 'built', `${cp} ${s.type}: ${s.class} ${s.detail}`);
    // Every script spend carries the set-aside UTxO as its one collateral.
    for (const s of r.spends.slice(2, 4)) {
      assert.equal(s.collateralUsed.chosen, 'set-aside');
      assert.equal(inspectTx(s.built.txs[0].bytes).collateralInputs.length, 1);
    }
    const w = r.spends[4];
    if (cp === 'default') {
      // build counts no withdrawal (TxBuilder.js:2070-2224), so the change
      // misses it and the kit's conservation check fails.
      assert.deepEqual([w.outcome, w.class], ['failed', CLASSES.balance], w.detail);
      assert.match(w.detail, /conservation/);
    } else assert.equal(w.outcome, 'built', w.detail);
  }
  const t = inspectTx((await replayHelios(source, 'default')).spends[0].built.txs[0].bytes);
  assert.equal(t.hasAux, true);
});

// Parts the library cannot hold, each on a payment from the S1 wallet.
test('each part the library cannot hold makes the intent not replayable, under both changes', { skip }, async () => {
  const state = shapeState(T, 'S1').state;
  const pay = [payToOf(T, 0, 2n * ADA)];
  const byron = base58decode('37btjrVyb4KDXBNC4haBVPCrro8AQPHwvCMp3RFhhSVWwfFmZ6wwzSK6JK1hY6wHNmtrpTf1kdbva8TCneM2YsiXT7mrzT21EacHnPpz5YyUdj64na');
  const byronIn = { ref: `${'b'.repeat(64)}#0`, cbor: unspentOutput('b'.repeat(64), 0, encodeOutput({ address: byron, coin: 5n * ADA, assets: [] }, 'array')).toString('hex') };
  const keyCred = encArray([encUint(0), encBytes(Buffer.alloc(28, 0x5c))]);
  const external = addressBytes(pay[0].address);
  const nativeRef = { ref: `${'c'.repeat(64)}#0`, cbor: unspentOutput('c'.repeat(64), 0, encodeOutput({ address: external, coin: 5n * ADA, assets: [], scriptRef: { lang: 0, script: encArray([encUint(1), encArray([])]).toString('hex') } }, 'map')).toString('hex') };
  const cases = [
    [{ body: { 6: encArray([encMap([]), encUint(0)]).toString('hex') } }, /^body field 6/],
    [{ body: { 19: encMap([]).toString('hex') } }, /^body field 19/],
    [{ body: { 20: encArray([]).toString('hex') } }, /^body field 20/],
    [{ body: { 21: encUint(5).toString('hex') } }, /^body field 21/],
    [{ body: { 22: encUint(ADA).toString('hex') } }, /^body field 22/],
    [{ body: { 4: encArray([encArray([encUint(7), keyCred, encUint(P.keyDeposit)])]).toString('hex') } }, /^a certificate of kind 7/],
    [{ inputs: [byronIn] }, /^a Byron address on b{64}#0/],
    [{ witnesses: { 2: encArray([]).toString('hex') } }, /^bootstrap witnesses/],
    [{ referenceInputs: [nativeRef] }, /^a native reference script/],
    [{ auxiliaryData: encTag(259, encMap([[encUint(0), encMap([[encUint(1), encUint(1)]])], [encUint(1), encArray([encArray([encUint(1), encArray([])])])]])).toString('hex') }, /^auxiliary data the library's metadata cannot hold/],
    [{ witnesses: { 4: encArray([encInt(7n)]).toString('hex') } }, /^a witness-set datum that no spent script input takes/],
    [{ witnesses: { 7: encArray([encBytes(V3)]).toString('hex') } }, /^a witness-set script the library cannot read/]
  ];
  const m = makeMethod(T, 'helios-sf');
  for (const [fixed, why] of cases) {
    const it = replayIntent('n1', 10, { type: 'T1', requested: pay, fixed });
    for (const opts of [own, layout]) {
      const r = await m.build(state, it, P, opts);
      assert.deepEqual([r.ok, r.class], [false, NOT_REPLAYABLE], `${why}: ${r.detail}`);
      assert.match(r.detail, why);
    }
  }
});
