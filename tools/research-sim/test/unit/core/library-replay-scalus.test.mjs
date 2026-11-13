// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Scalus's TxBuilder.complete (scalus-pool, methods/jvm.mjs), run in the JVM
// helper (helpers/jvm, scripts/build-helpers.mjs jvm) through the bridge: its
// own change (L/own) and UnFrack.It's layout change on the inputs it selected
// (L/layout). It is deterministic; L/own and L/layout select the same inputs;
// an input set that cannot fund the layout change fails with class
// change-minimum; a library failure is the library's under both; any other
// change policy is refused; a replayed spend's validity, required signers and
// metadata pass through the builder's steps; a Plutus mint and a script
// withdrawal build with their redeemers at the observed units and the
// collateral the library chooses, kept under the layout change; each part the
// builder cannot write is not replayable. The tests that run the helper skip,
// naming the build command, when it is not built.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scalusMethod, classOfScalusError } from '../../../src/methods/jvm.mjs';
import { helperBuild, BUILD_SCRIPT } from '../../../src/methods/helper.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { REPLAY_COVERAGE, REPLAY_PARTS } from '../../../src/methods/library.mjs';
import { NOT_REPLAYABLE, checkMethod, choosesOwnCollateral } from '../../../src/methods/contract.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { checkAndApply } from '../../../src/kit/apply.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { replay } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { constructState, policy, assetName, ADA } from '../../lib/construct.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { encUint, encArray, encMap, encBytes, encTag, decode, asUint } from '../../../src/history/cbor.mjs';
import { replayIntent, payTo as payToOf, zeroRedeemerIntents, EX_UNITS, V3_HASH } from '../../lib/script-intents.mjs';
import { treatment, skip as noTreatment } from '../../lib/treatment.mjs';

const P = SYNTHETIC_PARAMS;
const own = { changePolicy: 'default', seed: 1 };
const layout = { changePolicy: 'layout', seed: 1 };
const { problem } = helperBuild('jvm');
const noBuild = problem ? `scalus-pool: ${problem}` : false;
const skip = noTreatment || noBuild;

test('Scalus covers every replay part; without the build the method refuses to load, naming the command', () => {
  assert.deepEqual(REPLAY_COVERAGE.scalus, [...REPLAY_PARTS]);
  if (problem) {
    assert.ok(problem.includes(`node ${BUILD_SCRIPT} jvm`));
    assert.throws(() => scalusMethod(null), /scripts\/build-helpers\.mjs jvm/);
  }
});

test('scalus-pool is deterministic, chooses its own collateral, and names the helper build in its version', { skip: noBuild }, () => {
  const m = checkMethod(scalusMethod(null));
  assert.equal(m.name, 'scalus-pool');
  assert.deepEqual([m.deterministic, m.seeded, choosesOwnCollateral(m)], [true, true, true]);
  const { record } = helperBuild('jvm');
  assert.match(m.version, /^Scalus 1\.5\.0 \(5bf331b\) TxBuilder\.complete; helper jvm sha256 [0-9a-f]{16}$/);
  assert.ok(m.version.endsWith(record.sha256.slice(0, 16)));
});

test('the library\'s errors map to the failure classes', () => {
  assert.equal(classOfScalusError('InsufficientAdaException: Insufficient ADA at ShelleyAddress(...): need 2 lovelace, found only 1'), CLASSES.balance);
  assert.equal(classOfScalusError('InsufficientTokensException: Insufficient tokens at ShelleyAddress(...): need 1 of ab.cd, found only 0'), CLASSES.balance);
  assert.equal(classOfScalusError('RuntimeException: Max iterations exceeded while trying to balance transaction'), CLASSES.balance);
  assert.equal(classOfScalusError('IllegalStateException: complete returned output 1 holding a negative quantity -5 of ab.cd'), CLASSES.balance);
  assert.equal(classOfScalusError('LedgerValidationException: TooManyCollateralInputsException(...)'), CLASSES.collateral);
  assert.equal(classOfScalusError('BuildStepException: Build step error: something else'), CLASSES.other);
});

const T = skip ? null : await treatment();
const pay = (i, coin, extra) => payToOf(T, i, coin, extra);
const payment = (requested, t = 100, fixed = null) => replayIntent('p1', t, { type: 'T1', requested, fixed });
const field = (hex, k) => {
  const n = decode(Buffer.from(hex, 'hex'));
  const e = n.items[0].entries.find(([key]) => Number(key.value) === k);
  return e ? e[1] : null;
};

test('scalus-pool is made by name and refuses a change policy other than its own and the layout change', { skip }, async () => {
  const m = makeMethod(T, 'scalus-pool');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const it = payment([pay(0, 3n * ADA)]);
  assert.equal((await m.build(s, it, P, own)).ok, true);
  const r = await m.build(s, it, P, { changePolicy: 'ladder', seed: 1 });
  assert.deepEqual([r.ok, r.class], [false, CLASSES.other]);
  assert.match(r.detail, /its own change or the layout change only/);
});

test('one state gives the same bytes; L/own and L/layout select the same inputs; both pass the kit', { skip }, async () => {
  const m = makeMethod(T, 'scalus-pool');
  const s = constructState(T, [...Array.from({ length: 12 }, (_, i) => ({ coin: BigInt(2 + i) * ADA })), { coin: 3n * ADA, assets: [{ policy: policy('a'), name: assetName('x'), qty: 5n }] }]);
  for (const it of [payment([pay(0, 9n * ADA)]), payment([pay(1, 4n * ADA, {})])]) {
    const a = await m.build(s, it, P, own);
    const a2 = await m.build(s, it, P, own);
    const l = await m.build(s, it, P, layout);
    assert.equal(a.ok, true, a.detail);
    assert.equal(l.ok, true, l.detail);
    assert.equal(a.txs[0].bytes, a2.txs[0].bytes);
    assert.deepEqual(l.txs[0].walletInputs, a.txs[0].walletInputs);
    for (const r of [a, l]) {
      const applied = checkAndApply(s, P, r.txs);
      assert.equal(applied.ok, true, applied.failure && applied.failure.detail);
    }
    assert.ok(a.library.fee >= a.library.finalMinFee);
    assert.equal(inspectTx(a.txs[0].bytes).vkeys.length, a.txs[0].k);
  }
});

test('only the UTxOs at the sponsor address are candidates', { skip }, async () => {
  const m = makeMethod(T, 'scalus-pool');
  const other = T.cslkit.baseAddress(1).to_bech32();
  const s = constructState(T, [{ coin: 3n * ADA }, { coin: 50n * ADA, address: other }]);
  const r = await m.build(s, payment([pay(0, 10n * ADA)]), P, own);
  assert.deepEqual([r.ok, r.class], [false, CLASSES.balance]);
  assert.match(r.detail, /^complete: InsufficientAdaException/);
});

test('inputs that cannot fund the layout change fail with change-minimum while the library builds its own', { skip }, async () => {
  const m = makeMethod(T, 'scalus-pool');
  const s = constructState(T, [{ coin: 10n * ADA, assets: Array.from({ length: 40 }, (_, i) => ({ policy: policy(`q${i}`), name: assetName('t'), qty: 1n })) }]);
  const it = payment([pay(0, 2n * ADA)]);
  const a = await m.build(s, it, P, own);
  assert.equal(a.ok, true, a.detail);
  assert.equal(checkAndApply(s, P, a.txs).ok, true);
  const b = await m.build(s, it, P, layout);
  assert.deepEqual([b.ok, b.class], [false, CLASSES.changeMinimum]);
  assert.match(b.detail, /^layout change on the library's inputs: /);
});

test('a library failure under the layout change is the library\'s, as under its own', { skip }, async () => {
  const m = makeMethod(T, 'scalus-pool');
  const s = constructState(T, [{ coin: 3n * ADA }]);
  const it = payment([pay(0, 50n * ADA)]);
  const a = await m.build(s, it, P, own);
  const b = await m.build(s, it, P, layout);
  assert.deepEqual([a.ok, a.class], [false, CLASSES.balance]);
  assert.match(a.detail, /^complete: InsufficientAdaException/);
  assert.deepEqual([b.ok, b.class, b.detail], [a.ok, a.class, a.detail]);
});

test('the intent\'s validity, required signers and metadata pass through the builder\'s steps', { skip }, async () => {
  const m = makeMethod(T, 'scalus-pool');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const signer = Buffer.alloc(28, 7);
  const metadata = encMap([[encUint(674), encMap([[Buffer.from([0x63, 0x6d, 0x73, 0x67]), encArray([Buffer.from([0x62, 0x68, 0x69])])]])]]);
  const it = payment([pay(0, 3n * ADA)], 100, {
    body: { 3: encUint(9000).toString('hex'), 8: encUint(10).toString('hex'), 14: encTag(258, encArray([encBytes(signer)])).toString('hex') },
    auxiliaryData: metadata.toString('hex')
  });
  for (const opts of [own, layout]) {
    const r = await m.build(s, it, P, opts);
    assert.equal(r.ok, true, r.detail);
    const tx = r.txs[0].bytes;
    assert.equal(asUint(field(tx, 3)), 9000n);
    assert.equal(asUint(field(tx, 8)), 10n);
    assert.deepEqual(inspectTx(tx).requiredSigners, [signer.toString('hex')]);
    assert.equal(inspectTx(tx).hasAux, true);
    const applied = checkAndApply(s, P, r.txs, { fixed: it.fixed });
    assert.equal(applied.ok, true, applied.failure && applied.failure.detail);
  }
});

test('each part the builder cannot write is not replayable', { skip }, async () => {
  const m = makeMethod(T, 'scalus-pool');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const boot = payment([pay(0, 3n * ADA)], 100, { witnesses: { 2: encArray([encArray([encBytes(Buffer.alloc(32)), encBytes(Buffer.alloc(64)), encBytes(Buffer.alloc(32)), encBytes(Buffer.from([0xa0]))])]).toString('hex') } });
  const networkId = payment([pay(0, 3n * ADA)], 100, { body: { 15: encUint(1).toString('hex') } });
  // A script output with no datum, spent with a redeemer.
  const txid = 'ab'.repeat(32);
  const scriptAddress = Buffer.concat([Buffer.from([0x71]), Buffer.from(V3_HASH, 'hex')]);
  const utxo = encArray([encArray([encBytes(Buffer.from(txid, 'hex')), encUint(0)]), encArray([encBytes(scriptAddress), encUint(5n * ADA)])]).toString('hex');
  const noDatum = {
    ...payment([pay(0, 3n * ADA)], 100, { inputs: [{ ref: `${txid}#0`, cbor: utxo }], redeemers: [{ tag: 0, target: { kind: 'input', ref: `${txid}#0` }, data: '00', exUnits: EX_UNITS }] }),
    collateral: { required: true, observed: null }
  };
  for (const [it, re] of [[boot, /^bootstrap witnesses: /], [networkId, /^body field 15: /], [noDatum, /^script input without a datum: /]]) {
    for (const opts of [own, layout]) {
      const r = await m.build(s, it, P, opts);
      assert.deepEqual([r.ok, r.class], [false, NOT_REPLAYABLE], r.detail);
      assert.match(r.detail, re);
    }
  }
});

test('a Plutus mint and a script withdrawal build with their redeemers at the observed units and the library\'s collateral, kept under the layout change', { skip }, async () => {
  const m = makeMethod(T, 'scalus-pool');
  const s = constructState(T, [{ coin: 30n * ADA, txid: 'pool' }, { coin: 6n * ADA, txid: 'collateral' }]);
  for (const it of zeroRedeemerIntents(T, s)) {
    const refs = [];
    for (const opts of [own, layout]) {
      const r = await m.build(s, it, P, opts);
      assert.equal(r.ok, true, r.detail);
      const tx = inspectTx(r.txs[0].bytes);
      assert.equal(tx.collateralInputs.length, 1);
      refs.push(tx.collateralInputs[0].ref);
      assert.equal(tx.redeemers.length, 1);
      assert.deepEqual(tx.redeemers[0].exUnits.map(BigInt), EX_UNITS.map(BigInt));
      const applied = checkAndApply(s, P, r.txs, { implicit: it.implicit, scriptFee: it.fixed.scriptFee, fixed: it.fixed });
      assert.equal(applied.ok, true, applied.failure && applied.failure.detail);
    }
    assert.equal(refs[1], refs[0]);
  }
});

const replayScalus = (source, changePolicy) => replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: makeMethod(T, 'scalus-pool'), opts: { seed: 1, changePolicy, collateralRule: 'ledger' }, settleEvery: 25, keepTx: true, validity: true });

test('replayed synthetic streams under both changes: no validity failure and no class other, fixed inputs kept, the library\'s collateral on script spends', { skip, timeout: 5 * 60 * 1000 }, async () => {
  for (const name of ['S1', 'M1', 'CL1']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const intents = source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
    let built = 0;
    for (const cp of ['default', 'layout']) {
      const r = await replayScalus(source, cp);
      assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.details));
      for (const sp of r.spends) {
        assert.notEqual(sp.class, CLASSES.other, `${name} ${cp} ${sp.type}: ${sp.detail}`);
        if (sp.outcome !== 'built') continue;
        built++;
        const intent = intents[sp.intent];
        const tx = inspectTx(sp.built.txs[0].bytes);
        if (intent.collateral.required) assert.equal(sp.collateralUsed.chosen, 'library');
        for (const x of intent.fixed ? intent.fixed.inputs : []) assert.ok(tx.inputs.some((y) => y.ref === x.ref), `${name} ${sp.type}: fixed input missing`);
      }
    }
    assert.ok(built > 0, name);
  }
});
