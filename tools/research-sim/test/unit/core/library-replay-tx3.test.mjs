// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Tx3 (tx3-vd, methods/tx3.mjs), run in the Rust helper (helpers/tx3,
// scripts/build-helpers.mjs tx3) through the bridge: the many-input program
// generated per spend, resolved by tx3-resolver, with the program's change
// (L/own) and UnFrack.It's layout change on the inputs Tx3 selected
// (L/layout). It is deterministic; L/own and L/layout select the same inputs;
// the program's change is one output at the change address holding
// everything left; only the UTxOs at the change address are candidates; an input set that cannot fund the layout change fails with
// class change-minimum; a library failure is the library's under both; any
// other change policy is refused; a replayed spend's validity, required
// signers, metadata, fixed inputs, withdrawal, donation and native-script
// mint are written by the program; each part neither the program nor Tx3 can
// write is not replayable. The tests that run the helper skip, naming the
// build command, when it is not built.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx3Method, classOfTx3Error } from '../../../src/methods/tx3.mjs';
import { helperBuild, BUILD_SCRIPT } from '../../../src/methods/helper.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { REPLAY_COVERAGE, REPLAY_PARTS } from '../../../src/methods/library.mjs';
import { NOT_REPLAYABLE, checkMethod, choosesOwnCollateral } from '../../../src/methods/contract.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { checkAndApply } from '../../../src/kit/apply.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { replay } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { addressBytes } from '../../../src/history/address.mjs';
import { blake2b224 } from '../../../src/history/blake2b.mjs';
import { constructState, policy, assetName, ADA } from '../../lib/construct.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { encUint, encInt, encArray, encMap, encBytes, encTag, decode, asUint } from '../../../src/history/cbor.mjs';
import { replayIntent, payTo as payToOf, zeroRedeemerIntents } from '../../lib/script-intents.mjs';
import { treatment, skip as noTreatment } from '../../lib/treatment.mjs';

const P = SYNTHETIC_PARAMS;
const own = { changePolicy: 'default', seed: 1 };
const layout = { changePolicy: 'layout', seed: 1 };
const { problem } = helperBuild('tx3');
const noBuild = problem ? `tx3-vd: ${problem}` : false;
const skip = noTreatment || noBuild;

test('Tx3 covers every replay part; without the build the method refuses to load, naming the command', () => {
  assert.deepEqual(REPLAY_COVERAGE.tx3, [...REPLAY_PARTS]);
  if (problem) {
    assert.ok(problem.includes(`node ${BUILD_SCRIPT} tx3`));
    assert.throws(() => tx3Method(null), /scripts\/build-helpers\.mjs tx3/);
  }
});

test('tx3-vd is deterministic, does not choose its own collateral, and names the helper build in its version', { skip: noBuild }, () => {
  const m = checkMethod(tx3Method(null));
  assert.equal(m.name, 'tx3-vd');
  assert.deepEqual([m.deterministic, m.seeded, choosesOwnCollateral(m)], [true, true, false]);
  const { record } = helperBuild('tx3');
  assert.match(m.version, /^Tx3 tx3-resolver 0\.25\.0 \(f2cadfd\) many-input program; helper tx3 sha256 [0-9a-f]{16}$/);
  assert.ok(m.version.endsWith(record.sha256.slice(0, 16)));
});

test('the library\'s errors map to the failure classes', () => {
  assert.equal(classOfTx3Error('input not resolved: source'), CLASSES.balance);
  assert.equal(classOfTx3Error('input not resolved: fixed0'), CLASSES.other);
  assert.equal(classOfTx3Error('Tx3 panicked: called `Option::unwrap()` on a `None` value'), CLASSES.other);
});

const T = skip ? null : await treatment();
const pay = (i, coin, extra) => payToOf(T, i, coin, extra);
const payment = (requested, t = 100, fixed = null, implicit = {}) => replayIntent('p1', t, { type: 'T1', requested, fixed, implicit });
const field = (hex, k) => {
  const n = decode(Buffer.from(hex, 'hex'));
  const e = n.items[0].entries.find(([key]) => Number(key.value) === k);
  return e ? e[1] : null;
};

test('tx3-vd is made by name and refuses a change policy other than its program\'s and the layout change', { skip }, async () => {
  const m = makeMethod(T, 'tx3-vd');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const it = payment([pay(0, 3n * ADA)]);
  assert.equal((await m.build(s, it, P, own)).ok, true);
  const r = await m.build(s, it, P, { changePolicy: 'ladder', seed: 1 });
  assert.deepEqual([r.ok, r.class], [false, CLASSES.other]);
  assert.match(r.detail, /its program's change or the layout change only/);
});

test('one state gives the same bytes; L/own and L/layout select the same inputs; both pass the kit', { skip }, async () => {
  const m = makeMethod(T, 'tx3-vd');
  const s = constructState(T, [...Array.from({ length: 12 }, (_, i) => ({ coin: BigInt(2 + i) * ADA })), { coin: 3n * ADA, assets: [{ policy: policy('a'), name: assetName('x'), qty: 5n }] }]);
  for (const it of [payment([pay(0, 9n * ADA)]), payment([pay(1, 4n * ADA)])]) {
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

test('the program\'s change is one output at the change address holding everything the inputs leave', { skip }, async () => {
  const m = makeMethod(T, 'tx3-vd');
  const tokens = [{ policy: policy('a'), name: assetName('x'), qty: 5n }, { policy: policy('b'), name: '', qty: 7n }];
  const s = constructState(T, [{ coin: 20n * ADA, assets: tokens }]);
  const r = await m.build(s, payment([pay(0, 3n * ADA)]), P, own);
  assert.equal(r.ok, true, r.detail);
  const tx = inspectTx(r.txs[0].bytes);
  assert.equal(tx.outputs.length, 2);
  const change = tx.outputs[1];
  assert.equal(change.address.toString('hex'), addressBytes(s.changeAddress).toString('hex'));
  assert.deepEqual(change.assets.map((a) => [a.policy, a.name, a.qty]).sort(), tokens.map((a) => [a.policy, a.name, a.qty]).sort());
  assert.equal(change.coin, 20n * ADA - 3n * ADA - tx.fee);
});

test('only the UTxOs at the change address are candidates', { skip }, async () => {
  const m = makeMethod(T, 'tx3-vd');
  const other = T.cslkit.baseAddress(1).to_bech32();
  const s = constructState(T, [{ coin: 3n * ADA }, { coin: 50n * ADA, address: other }]);
  const r = await m.build(s, payment([pay(0, 10n * ADA)]), P, own);
  assert.deepEqual([r.ok, r.class, r.detail], [false, CLASSES.balance, 'resolve: input not resolved: source']);
  const s2 = constructState(T, [{ coin: 30n * ADA }, { coin: 50n * ADA, address: other }]);
  const r2 = await m.build(s2, payment([pay(0, 10n * ADA)]), P, own);
  assert.equal(r2.ok, true, r2.detail);
  assert.deepEqual(r2.txs[0].walletInputs.map((x) => s2.utxos.get(x).address), [s2.changeAddress]);
});

test('inputs that cannot fund the layout change fail with change-minimum while the program builds its own', { skip }, async () => {
  const m = makeMethod(T, 'tx3-vd');
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
  const m = makeMethod(T, 'tx3-vd');
  const s = constructState(T, [{ coin: 3n * ADA }]);
  const it = payment([pay(0, 50n * ADA)]);
  const a = await m.build(s, it, P, own);
  const b = await m.build(s, it, P, layout);
  assert.deepEqual([a.ok, a.class, a.detail], [false, CLASSES.balance, 'resolve: input not resolved: source']);
  assert.deepEqual([b.ok, b.class, b.detail], [a.ok, a.class, a.detail]);
});

test('the intent\'s validity, required signers and metadata are written by the program', { skip }, async () => {
  const m = makeMethod(T, 'tx3-vd');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const signer = Buffer.alloc(28, 7);
  const metadata = encMap([[encUint(674), Buffer.from([0x62, 0x68, 0x69])], [encUint(1), encUint(5)]]);
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

test('a fixed input, a withdrawal, a donation and a native-script mint are written by the program and pass the kit', { skip }, async () => {
  const m = makeMethod(T, 'tx3-vd');
  const whole = constructState(T, [{ coin: 30n * ADA, txid: 'pool' }, { coin: 6n * ADA, txid: 'fixed' }]);
  const fixed = [...whole.utxos.values()].find((u) => u.coin === 6n * ADA);
  const pool = { ...whole, utxos: new Map([...whole.utxos].filter(([ref]) => ref !== fixed.ref)) };
  const net = addressBytes(whole.changeAddress)[0] & 15;
  const account = Buffer.concat([Buffer.from([0xe0 | net]), Buffer.from(whole.stakeCred, 'hex')]);
  const script = encArray([encUint(1), encArray([])]);
  const pid = blake2b224(Buffer.concat([Buffer.from([0]), script])).toString('hex');
  const it = payment([pay(0, 12n * ADA)], 100, {
    inputs: [{ ref: fixed.ref, cbor: fixed.cbor, walletKey: fixed.cred, held: null }],
    body: {
      5: encMap([[encBytes(account), encUint(ADA)]]).toString('hex'),
      9: encMap([[encBytes(Buffer.from(pid, 'hex')), encMap([[encBytes(Buffer.from('7a', 'hex')), encInt(5n)]])]]).toString('hex'),
      22: encUint(ADA).toString('hex')
    },
    witnesses: { 1: encArray([script]).toString('hex') }
  }, { withdrawals: ADA, donation: ADA, mint: [{ policy: pid, name: '7a', qty: 5n }] });
  for (const opts of [own, layout]) {
    const r = await m.build(pool, it, P, opts);
    assert.equal(r.ok, true, r.detail);
    const tx = inspectTx(r.txs[0].bytes);
    assert.ok(tx.inputs.some((x) => x.ref === fixed.ref));
    assert.deepEqual(r.txs[0].walletInputs.includes(fixed.ref), false);
    assert.equal(tx.donation, ADA);
    assert.deepEqual(tx.withdrawals.map((w) => w.coin), [ADA]);
    assert.deepEqual(tx.mint.map((a) => [a.policy, a.name, a.qty]), [[pid, '7a', 5n]]);
    const applied = checkAndApply(whole, P, r.txs, { implicit: it.implicit, fixed: it.fixed, heldInputs: [fixed.ref] });
    assert.equal(applied.ok, true, applied.failure && applied.failure.detail);
  }
});

test('each part neither the program nor Tx3 can write is not replayable', { skip }, async () => {
  const m = makeMethod(T, 'tx3-vd');
  const whole = constructState(T, [{ coin: 30n * ADA, txid: 'pool' }, { coin: 5n * ADA, txid: 'collateral' }]);
  const coll = [...whole.utxos.values()].find((u) => u.coin === 5n * ADA);
  const s = { ...whole, utxos: new Map([...whole.utxos].filter(([ref]) => ref !== coll.ref)) };
  const p = (fixed, extra = {}) => payment([pay(0, 3n * ADA)], 100, fixed, extra);
  const recipient = pay(0, 3n * ADA).address;
  const datumHashOut = { ...pay(0, 3n * ADA), cbor: Buffer.concat([Buffer.from([0x83]), encBytes(addressBytes(recipient)), encUint(3n * ADA), encBytes(Buffer.alloc(32, 1))]).toString('hex'), datum: { hash: '01'.repeat(32) } };
  const stakeReg = encTag(258, encArray([encArray([encUint(0), encArray([encUint(0), encBytes(Buffer.alloc(28, 3))])])]));
  const abstain = encTag(258, encArray([encArray([encUint(9), encArray([encUint(0), encBytes(Buffer.alloc(28, 3))]), encArray([encUint(2)])])]));
  const cases = [
    [p({ witnesses: { 2: encArray([encArray([encBytes(Buffer.alloc(32)), encBytes(Buffer.alloc(64)), encBytes(Buffer.alloc(32)), encBytes(Buffer.from([0xa0]))])]).toString('hex') } }), /^bootstrap witnesses: /],
    [p({ witnesses: { 4: encArray([encUint(1)]).toString('hex') } }), /^witness datums: /],
    [p({ auxiliaryData: encTag(259, encMap([[encUint(0), encMap([[encUint(1), encUint(1)]])], [encUint(1), encArray([encArray([encUint(1), encArray([])])])]])).toString('hex') }), /^auxiliary scripts: /],
    [p({ auxiliaryData: encMap([[encUint(674), encMap([[Buffer.from([0x63, 0x6d, 0x73, 0x67]), encArray([Buffer.from([0x62, 0x68, 0x69])])]])]]).toString('hex') }), /^metadata: /],
    [p({ body: { 4: stakeReg.toString('hex') } }, { deposits: 2n * ADA }), /^certificates: /],
    [p({ body: { 4: abstain.toString('hex') } }), /^certificates: /],
    [p({ body: { 19: encMap([]).toString('hex') } }), /^votes: /],
    [p({ body: { 20: encArray([]).toString('hex') } }), /^proposals: /],
    [p({ body: { 21: encUint(1).toString('hex') } }), /^current treasury value: /],
    [payment([datumHashOut], 100, {}), /^output datum hash: /]
  ];
  for (const [it, re] of cases) {
    for (const opts of [own, layout]) {
      const r = await m.build(s, it, P, opts);
      assert.deepEqual([r.ok, r.class], [false, NOT_REPLAYABLE], r.detail);
      assert.match(r.detail, re);
    }
  }
  // A redeemer: Tx3 writes fixed execution units and prices none.
  for (const it of zeroRedeemerIntents(T, s)) {
    for (const opts of [own, layout]) {
      const r = await m.build(s, it, P, { ...opts, collateral: coll });
      assert.deepEqual([r.ok, r.class], [false, NOT_REPLAYABLE], r.detail);
      assert.match(r.detail, /^execution units: /);
    }
  }
});

const replayTx3 = (source, changePolicy) => replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: makeMethod(T, 'tx3-vd'), opts: { seed: 1, changePolicy, collateralRule: 'ledger' }, settleEvery: 25, keepTx: true, validity: true });

test('replayed synthetic streams under both changes: no validity failure, class other only for a requested output under its minimum as Tx3 writes it, fixed inputs kept', { skip, timeout: 5 * 60 * 1000 }, async () => {
  for (const name of ['S1', 'M1', 'CL1']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const intents = source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
    let built = 0;
    for (const cp of ['default', 'layout']) {
      const r = await replayTx3(source, cp);
      assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.details));
      for (const sp of r.spends) {
        if (sp.class === CLASSES.other) assert.match(sp.detail, /^kit: minimum: output \d+: coin \d+ under its minimum \d+/, `${name} ${cp} ${sp.type}`);
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
