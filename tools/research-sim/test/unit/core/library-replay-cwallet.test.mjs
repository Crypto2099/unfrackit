// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// cardano-wallet's balancer (cwallet-rrri, methods/cwallet.mjs), run in the
// Haskell helper (helpers/cwallet, scripts/build-helpers.mjs cwallet)
// through the bridge: its own change (L/own) and UnFrack.It's layout change
// on the inputs it selected (L/layout). It is seeded: one seed gives the same
// bytes, another can select other inputs, and L/own and L/layout select the
// same inputs; an input set that cannot fund the layout change fails with
// class change-minimum; a library failure is the library's under both; any
// other change policy is refused; a payment carries the validity interval of
// the wallet's transaction construction; a replayed spend's required signers
// and metadata pass through; Plutus scripts are run by the library, which
// sets their units and chooses its own collateral; each part the library
// cannot express is not replayable; the intent's bootstrap witnesses are
// written after the build. The tests that run the helper skip, naming the
// build command, when it is not built.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cwalletMethod, classOfCwalletError } from '../../../src/methods/cwallet.mjs';
import { helperBuild, buildRequest, BUILD_SCRIPT } from '../../../src/methods/helper.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { REPLAY_COVERAGE, inputOrder } from '../../../src/methods/library.mjs';
import { NOT_REPLAYABLE, checkMethod, choosesOwnCollateral } from '../../../src/methods/contract.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { checkAndApply } from '../../../src/kit/apply.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { replay } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { constructState, policy, assetName, ADA } from '../../lib/construct.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { executionFee } from '../../../src/history/params.mjs';
import { addressBytes } from '../../../src/history/address.mjs';
import { blake2b224 } from '../../../src/history/blake2b.mjs';
import { encUint, encInt, encArray, encMap, encBytes, encTag, decode, asUint } from '../../../src/history/cbor.mjs';
import { replayIntent, payTo as payToOf, zeroRedeemerIntents } from '../../lib/script-intents.mjs';
import { treatment, skip as noTreatment } from '../../lib/treatment.mjs';

const P = SYNTHETIC_PARAMS;
const own = { changePolicy: 'default', seed: 1 };
const layout = { changePolicy: 'layout', seed: 1 };
const { problem } = helperBuild('cwallet');
const noBuild = problem ? `cwallet-rrri: ${problem}` : false;
const skip = noTreatment || noBuild;

test('cardano-wallet covers every replay part; without the build the method refuses to load, naming the command', () => {
  assert.deepEqual(REPLAY_COVERAGE.cwallet, ['fixed', 'collateral', 'implicit', 'outputData']);
  if (problem) {
    assert.ok(problem.includes(`node ${BUILD_SCRIPT} cwallet`));
    assert.throws(() => cwalletMethod(null), /scripts\/build-helpers\.mjs cwallet/);
  }
});

test('cwallet-rrri is seeded and not deterministic, chooses its own collateral, and names the helper build in its version', { skip: noBuild }, () => {
  const m = checkMethod(cwalletMethod(null));
  assert.equal(m.name, 'cwallet-rrri');
  assert.deepEqual([m.deterministic, m.seeded, choosesOwnCollateral(m)], [false, true, true]);
  const { record } = helperBuild('cwallet');
  assert.match(m.version, /^cardano-balance-tx 0\.1\.0 \(8975773\) over cardano-coin-selection 0\.1\.0\.0 \(1766110\), as cardano-wallet f293d92 pins them, balanceTx; helper cwallet sha256 [0-9a-f]{16}$/);
  assert.ok(m.version.endsWith(record.sha256.slice(0, 16)));
  assert.equal(record.modules['cardano-balance-tx'].commit, '897577325745729552495a9add56c713630c497e');
  assert.equal(record.modules['cardano-coin-selection'].commit, '176611048d5b9f33df19d106cd925d63a7858bb2');
});

test('the library\'s errors map to the failure classes', () => {
  const c = classOfCwalletError;
  assert.equal(c('ErrBalanceTxAssetsInsufficient: shortfall 47000000 lovelace and 0 assets'), CLASSES.balance);
  assert.equal(c('ErrBalanceTxUnableToCreateInput'), CLASSES.balance);
  assert.equal(c('ErrBalanceTxUnableToCreateChange: shortfall 1600397'), CLASSES.changeMinimum);
  assert.equal(c('ErrBalanceTxMaxSizeLimitExceeded: size 17000 over the limit 16384'), CLASSES.txSize);
  assert.equal(c('ErrBalanceTxInsufficientCollateral: minimum 2500000'), CLASSES.collateral);
  assert.equal(c('ErrBalanceTxAssignRedeemers: the script of the spend of aa#0 fails in the built transaction: CekError'), CLASSES.other);
  assert.equal(c('ErrBalanceTxOutputError: output 0: ErrBalanceTxOutputSizeExceedsLimit'), CLASSES.other);
  assert.equal(c('ErrBalanceTxInternalError: ErrUnderestimatedFee 10'), CLASSES.other);
});

const T = skip ? null : await treatment();
const pay = (i, coin, extra) => payToOf(T, i, coin, extra);
const payment = (requested, t = 100, fixed = null) => replayIntent('p1', t, { type: 'T1', requested, fixed });
const field = (hex, k) => {
  const n = decode(Buffer.from(hex, 'hex'));
  const e = n.items[0].entries.find(([key]) => Number(key.value) === k);
  return e ? e[1] : null;
};

test('cwallet-rrri is made by name and refuses a change policy other than its own and the layout change', { skip }, async () => {
  const m = makeMethod(T, 'cwallet-rrri');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const it = payment([pay(0, 3n * ADA)]);
  assert.equal((await m.build(s, it, P, own)).ok, true);
  const r = await m.build(s, it, P, { changePolicy: 'ladder', seed: 1 });
  assert.deepEqual([r.ok, r.class], [false, CLASSES.other]);
  assert.match(r.detail, /its own change or the layout change only/);
});

test('one seed gives the same bytes and another can select other inputs; L/own and L/layout select the same inputs; both pass the kit', { skip }, async () => {
  const m = makeMethod(T, 'cwallet-rrri');
  const s = constructState(T, [...Array.from({ length: 12 }, (_, i) => ({ coin: BigInt(2 + i) * ADA })), { coin: 3n * ADA, assets: [{ policy: policy('a'), name: assetName('x'), qty: 5n }] }]);
  const it = payment([pay(0, 9n * ADA)]);
  const q = (opts) => buildRequest({ sent: new Map() }, { library: 'cwallet', state: s, intent: it, params: P, opts, pool: inputOrder(s), collateral: null, seeded: true });
  assert.equal(q({ seed: 7 }).seed, '7');
  const inputs = new Set();
  for (const seed of [1, 2, 3, 4]) {
    const a = await m.build(s, it, P, { changePolicy: 'default', seed });
    const a2 = await m.build(s, it, P, { changePolicy: 'default', seed });
    const l = await m.build(s, it, P, { changePolicy: 'layout', seed });
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
    inputs.add(a.txs[0].walletInputs.slice().sort().join(' '));
  }
  assert.ok(inputs.size > 1, 'the seeds select alike');
});

test('a payment carries the validity interval of the wallet\'s construction; an intent\'s own validity fields take its place', { skip }, async () => {
  const m = makeMethod(T, 'cwallet-rrri');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const plain = await m.build(s, payment([pay(0, 3n * ADA)], 1000), P, own);
  assert.equal(plain.ok, true, plain.detail);
  assert.equal(asUint(field(plain.txs[0].bytes, 8)), 0n);
  assert.equal(asUint(field(plain.txs[0].bytes, 3)), 1000n + 7200n);
  const named = await m.build(s, payment([pay(0, 3n * ADA)], 1000, { body: { 3: encUint(9000).toString('hex') } }), P, own);
  assert.equal(named.ok, true, named.detail);
  assert.equal(asUint(field(named.txs[0].bytes, 8)), 0n);
  assert.equal(asUint(field(named.txs[0].bytes, 3)), 9000n);
});

test('inputs that cannot fund the layout change fail with change-minimum while the library builds its own', { skip }, async () => {
  const m = makeMethod(T, 'cwallet-rrri');
  const s = constructState(T, [{ coin: 10n * ADA, assets: Array.from({ length: 50 }, (_, i) => ({ policy: policy(`q${i}`), name: assetName('t'), qty: 1n })) }, { coin: 3n * ADA }]);
  const it = payment([pay(0, 4n * ADA)]);
  const a = await m.build(s, it, P, own);
  assert.equal(a.ok, true, a.detail);
  assert.equal(checkAndApply(s, P, a.txs).ok, true);
  const b = await m.build(s, it, P, layout);
  assert.deepEqual([b.ok, b.class], [false, CLASSES.changeMinimum]);
  assert.match(b.detail, /^layout change on the library's inputs: /);
});

test('a library failure under the layout change is the library\'s, as under its own', { skip }, async () => {
  const m = makeMethod(T, 'cwallet-rrri');
  for (const [utxos, coin, cls, detail] of [
    [[{ coin: 3n * ADA }], 50n * ADA, CLASSES.balance, 'balanceTx: ErrBalanceTxAssetsInsufficient: shortfall 47000000 lovelace and 0 assets'],
    [[{ coin: 6n * ADA, assets: Array.from({ length: 50 }, (_, i) => ({ policy: policy(`q${i}`), name: assetName('t'), qty: 1n })) }, { coin: 3n * ADA }], 2n * ADA, CLASSES.changeMinimum, /^balanceTx: ErrBalanceTxUnableToCreateChange: shortfall \d+$/]
  ]) {
    const s = constructState(T, utxos);
    const it = payment([pay(0, coin)]);
    const a = await m.build(s, it, P, own);
    const b = await m.build(s, it, P, layout);
    assert.deepEqual([a.ok, a.class], [false, cls]);
    if (typeof detail === 'string') assert.equal(a.detail, detail);
    else assert.match(a.detail, detail);
    assert.deepEqual([b.ok, b.class, b.detail], [a.ok, a.class, a.detail]);
  }
});

test('the intent\'s required signers and metadata pass through the library', { skip }, async () => {
  const m = makeMethod(T, 'cwallet-rrri');
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

// An always-succeeding Plutus V3 program, (program 1.1.0 (lam ctx (con unit
// ()))), its flat encoding 01 01 00 24 99 wrapped as a CBOR byte string, as
// the ledger holds a script's bytes.
const V3 = Buffer.from('450101002499', 'hex');
const V3_HASH = blake2b224(Buffer.concat([Buffer.from([3]), V3])).toString('hex');
const EX_UNITS = [107086n, 32858313n];
const zeroRedeemers = (pointers) => encArray(pointers.map(([tag, index]) => encArray([encUint(tag), encUint(index), Buffer.from('00', 'hex'), encArray([encUint(EX_UNITS[0]), encUint(EX_UNITS[1])])]))).toString('hex');

// A mint of one unit under the V3 program's policy and a withdrawal of zero
// from its stake credential, each with its redeemer the integer 0.
function runnableScriptIntents(state) {
  const net = addressBytes(state.changeAddress)[0] & 15;
  const account = Buffer.concat([Buffer.from([0xf0 | net]), Buffer.from(V3_HASH, 'hex')]).toString('hex');
  const scriptFee = executionFee(P, EX_UNITS[0], EX_UNITS[1]);
  const scripts = { 7: encArray([encBytes(V3)]).toString('hex') };
  return [
    replayIntent('e1', 10, {
      type: 'T6',
      requested: [pay(10, 2n * ADA)],
      fixed: { body: { 9: encMap([[encBytes(Buffer.from(V3_HASH, 'hex')), encMap([[encBytes(Buffer.from('7a', 'hex')), encInt(1n)]])]]).toString('hex') }, witnesses: { ...scripts, 5: zeroRedeemers([[1, 0]]) }, redeemers: [{ tag: 1, target: { kind: 'policy', policy: V3_HASH }, data: '00', exUnits: EX_UNITS }], scriptFee },
      implicit: { mint: [{ policy: V3_HASH, name: '7a', qty: 1n }] },
      collateral: true
    }),
    replayIntent('e2', 20, {
      type: 'T6',
      requested: [pay(11, 2n * ADA)],
      fixed: { body: { 5: encMap([[encBytes(Buffer.from(account, 'hex')), encUint(0)]]).toString('hex') }, witnesses: { ...scripts, 5: zeroRedeemers([[3, 0]]) }, redeemers: [{ tag: 3, target: { kind: 'withdrawal', account }, data: '00', exUnits: EX_UNITS }], scriptFee },
      collateral: true
    })
  ];
}

test('Plutus mints and withdrawals: the library runs their scripts, writes the units of the runs, and chooses its own ADA-only collateral', { skip }, async () => {
  const m = makeMethod(T, 'cwallet-rrri');
  const s = constructState(T, [{ coin: 20n * ADA }, { coin: 8n * ADA }, { coin: 5n * ADA, assets: [{ policy: policy('c'), name: assetName('y'), qty: 1n }] }]);
  for (const it of runnableScriptIntents(s)) {
    for (const opts of [own, layout]) {
      const r = await m.build(s, it, P, opts);
      assert.equal(r.ok, true, r.detail);
      const tx = inspectTx(r.txs[0].bytes);
      assert.equal(tx.collateralInputs.length, 1);
      assert.equal(s.utxos.get(tx.collateralInputs[0].ref).assets.length, 0, 'ADA-only collateral');
      assert.ok(field(r.txs[0].bytes, 11), 'script data hash');
      assert.equal(tx.redeemers.length, 1);
      assert.equal(tx.redeemers[0].data, '00');
      // validity from the client's transaction: none, as the balance
      // endpoint takes it
      assert.equal(field(r.txs[0].bytes, 3), null);
      if (opts === own) assert.notDeepEqual(tx.redeemers[0].exUnits.map(BigInt), EX_UNITS, 'the units of the library\'s own run');
      const applied = checkAndApply(s, P, r.txs, { fixed: it.fixed, implicit: it.implicit });
      assert.equal(applied.ok, true, applied.failure && applied.failure.detail);
    }
  }
});

test('each part the library cannot express is not replayable', { skip }, async () => {
  const m = makeMethod(T, 'cwallet-rrri');
  const s = constructState(T, [{ coin: 20n * ADA }, { coin: 8n * ADA }]);
  const redeemerOf = (tag, target) => payment([pay(0, 3n * ADA)], 100, { redeemers: [{ tag, target, data: '00', exUnits: [1n, 1n] }] });
  const cases = [
    [redeemerOf(2, { kind: 'certificate', index: 0 }), /^redeemers: a redeemer with tag 2 \(a certificate\)/],
    [redeemerOf(4, { kind: 'voter', voter: '8202581c' + '00'.repeat(28) }), /^redeemers: a redeemer with tag 4 \(a vote\)/],
    [redeemerOf(5, { kind: 'proposal', index: 0 }), /^redeemers: a redeemer with tag 5 \(a proposal\)/],
    [payment([pay(0, 3n * ADA)], 100, { body: { 15: '00' } }), /^body field 15: /],
    // The stand-in Plutus script of the synthetic streams is not a program.
    [zeroRedeemerIntents(T, s)[0], /^plutus scripts: the script of the mint under [0-9a-f]{56} is not a program the ledger's evaluator can decode/]
  ];
  for (const [it, re] of cases) {
    for (const opts of [own, layout]) {
      const r = await m.build(s, it, P, opts);
      assert.deepEqual([r.ok, r.class], [false, NOT_REPLAYABLE], r.detail);
      assert.match(r.detail, re);
    }
  }
});

test('the intent\'s bootstrap witnesses are written after the build, and named unpriced when its fee priced none', { skip }, async () => {
  const m = makeMethod(T, 'cwallet-rrri');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const boot = encArray([encBytes(Buffer.alloc(32, 1)), encBytes(Buffer.alloc(64, 2)), encBytes(Buffer.alloc(32, 3)), encBytes(Buffer.from([0xa0]))]);
  const it = payment([pay(0, 3n * ADA)], 100, { witnesses: { 2: encArray([boot]).toString('hex') } });
  const r = await m.build(s, it, P, own);
  assert.equal(r.ok, true, r.detail);
  const wits = decode(Buffer.from(r.txs[0].bytes, 'hex')).items[1];
  const two = wits.entries.find(([k]) => Number(k.value) === 2);
  assert.ok(two, 'bootstrap witnesses in the witness set');
  assert.deepEqual(r.library.unpriced, ['observed bootstrap witnesses']);
});

const replayCwallet = (source, changePolicy) => replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: makeMethod(T, 'cwallet-rrri'), opts: { seed: 1, changePolicy, collateralRule: 'ledger' }, settleEvery: 25, keepTx: true, validity: true });

test('replayed synthetic streams under both changes: no validity failure, fixed inputs kept, the stand-in script not replayable', { skip, timeout: 5 * 60 * 1000 }, async () => {
  for (const name of ['S1', 'M1', 'CL1']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const intents = source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
    let built = 0;
    for (const cp of ['default', 'layout']) {
      const r = await replayCwallet(source, cp);
      assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.failures));
      for (const sp of r.spends) {
        assert.notEqual(sp.class, CLASSES.other, `${name} ${cp}: ${sp.detail}`);
        if (sp.class === NOT_REPLAYABLE) assert.match(sp.detail, /^plutus scripts: /, `${name} ${cp}`);
        if (sp.outcome !== 'built') continue;
        built++;
        const intent = intents[sp.intent];
        const tx = inspectTx(sp.built.txs[0].bytes);
        for (const x of intent.fixed ? intent.fixed.inputs : []) assert.ok(tx.inputs.some((y) => y.ref === x.ref), `${name} ${sp.type}: fixed input missing`);
      }
    }
    assert.ok(built > 0, name);
  }
});
