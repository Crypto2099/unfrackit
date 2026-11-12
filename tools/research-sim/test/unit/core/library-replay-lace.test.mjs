// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Lace's transaction builder (lace-rrri, methods/lace.mjs), built from the
// wallet's source by scripts/build-lace.mjs: its own change (L/own) and
// UnFrack.It's layout change on the inputs it selected (L/layout). The
// adapter covers every replay part; one seed gives the same bytes and two
// seeds can differ; L/own and L/layout select the same inputs on one seed;
// the TTL is the spend's slot plus two hours whatever the clock reads; an
// input set that cannot fund the layout change fails with class
// change-minimum; a library failure is the library's under both; any other
// change policy is refused; each redeemer the library cannot attach makes the
// intent not replayable. The tests that run the library skip, naming the build
// script, when the build is absent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laceMethod, buildLace, classOfLaceError, laceRefusal, afterParts, laceBuildProblem, loadLace, laceSeed } from '../../../src/methods/lace.mjs';
import { LACE_COMMIT, BUILD_SCRIPT } from '../../../src/methods/lace-source.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { REPLAY_PARTS, REPLAY_COVERAGE } from '../../../src/methods/library.mjs';
import { NOT_REPLAYABLE, choosesOwnCollateral, checkMethod } from '../../../src/methods/contract.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { checkAndApply } from '../../../src/kit/apply.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { withoutLeftovers } from '../../../src/kit/replay.mjs';
import { replay } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { constructState, policy, assetName, ADA } from '../../lib/construct.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { shapeState } from '../../../src/shapes/shapes.mjs';
import { encUint, encBytes, encArray, encMap, decode, asUint } from '../../../src/history/cbor.mjs';
import { replayIntent, payTo as payToOf, EX_UNITS } from '../../lib/script-intents.mjs';
import { treatment, skip as noTreatment } from '../../lib/treatment.mjs';

const P = SYNTHETIC_PARAMS;
const own = { changePolicy: 'default', seed: 1 };
const layout = { changePolicy: 'layout', seed: 1 };
const problem = laceBuildProblem();
const noBuild = problem ? `lace: ${problem}` : false;
const skip = noTreatment || noBuild;

test('Lace covers every replay part; without the build the method refuses to load, naming the build script', () => {
  assert.deepEqual(REPLAY_COVERAGE.lace, [...REPLAY_PARTS]);
  if (problem) {
    assert.match(problem, new RegExp(BUILD_SCRIPT.replace(/[./]/g, '\\$&')));
    assert.throws(() => laceMethod(null), /scripts\/build-lace\.mjs/);
    assert.throws(() => loadLace(), /scripts\/build-lace\.mjs/);
  }
});

test('lace-rrri is random, seeded through the selector, and given the collateral set aside', { skip: noBuild }, () => {
  const m = checkMethod(laceMethod(null));
  assert.equal(m.name, 'lace-rrri');
  assert.deepEqual([m.deterministic, m.seeded, choosesOwnCollateral(m)], [false, true, false]);
  assert.match(m.version, new RegExp(`^lace ${LACE_COMMIT.slice(0, 7)} `));
  // The seed: two draws of the generator, high and low words.
  assert.equal(laceSeed({ random: () => 0.5 }, 'x'), (0x80000000n << 32n) | 0x80000000n);
  assert.equal(laceSeed({ seed: 3 }, 'x'), laceSeed({ seed: 3 }, 'x'));
  assert.notEqual(laceSeed({ seed: 3 }, 'x'), laceSeed({ seed: 4 }, 'x'));
  assert.throws(() => laceSeed({}, 'x'), /a seed is required/);
});

test('the library\'s errors map to the failure classes', { skip: noBuild }, () => {
  const L = loadLace();
  const F = L.lib.InputSelectionFailure;
  assert.equal(classOfLaceError(L, new L.lib.InputSelectionError(F.BalanceInsufficient, 'x')), CLASSES.balance);
  assert.equal(classOfLaceError(L, new L.lib.InputSelectionError(F.UtxoFullyDepleted, 'x')), CLASSES.changeMinimum);
  assert.equal(classOfLaceError(L, new L.lib.InsufficientCollateralError('x')), CLASSES.collateral);
  assert.equal(classOfLaceError(L, new L.lib.EvaluatedFeeShortfallError(2n, 1n, [])), CLASSES.feeMinimum);
  assert.equal(classOfLaceError(L, new Error('Change output is below the minimum UTxO value: holds 1 lovelace, requires 2')), CLASSES.changeMinimum);
  assert.equal(classOfLaceError(L, new Error('No available UTXOs to select from')), CLASSES.balance);
  assert.equal(classOfLaceError(L, new Error('Failed to balance transaction')), CLASSES.other);
});

const T = noTreatment ? null : await treatment();
const pay = (i, coin, extra) => payToOf(T, i, coin, extra);
// The TTL (body field 3) of a transaction's bytes.
function ttlOf(hex) {
  const n = decode(Buffer.from(hex, 'hex'));
  const [k, v] = n.items[0].entries.find(([key]) => Number(key.value) === 3);
  return asUint(v, 'ttl');
}
const payment = (requested, t = 100) => replayIntent('p1', t, { type: 'T1', requested });

test('lace-rrri is made by name and refuses a change policy other than its own and the layout change', { skip }, async () => {
  const m = makeMethod(T, 'lace-rrri');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const it = payment([pay(0, 3n * ADA)]);
  assert.equal((await m.build(s, it, P, own)).ok, true);
  const r = await m.build(s, it, P, { changePolicy: 'ladder', seed: 1 });
  assert.deepEqual([r.ok, r.class], [false, CLASSES.other]);
  assert.match(r.detail, /its own change or the layout change only/);
});

test('one seed gives the same bytes, seeds can differ, and L/own and L/layout select the same inputs on one seed', { skip }, async () => {
  const s = constructState(T, Array.from({ length: 12 }, (_, i) => ({ coin: BigInt(2 + i) * ADA })));
  const it = payment([pay(0, 9n * ADA)]);
  const a = await buildLace(T, s, it, P, own);
  const a2 = await buildLace(T, s, it, P, own);
  assert.equal(a.ok, true, a.detail);
  assert.equal(a.txs[0].bytes, a2.txs[0].bytes);
  const picks = new Set();
  for (let seed = 1; seed <= 6; seed++) {
    const o = await buildLace(T, s, it, P, { ...own, seed });
    const l = await buildLace(T, s, it, P, { ...layout, seed });
    assert.equal(o.ok, true, o.detail);
    assert.equal(l.ok, true, l.detail);
    assert.deepEqual(l.txs[0].walletInputs, o.txs[0].walletInputs, `seed ${seed}`);
    for (const r of [o, l]) {
      const applied = checkAndApply(s, P, r.txs);
      assert.equal(applied.ok, true, applied.failure && applied.failure.detail);
    }
    assert.ok(o.library.fee >= o.library.finalMinFee);
    picks.add(o.txs[0].walletInputs.join());
  }
  assert.ok(picks.size > 1, 'different seeds can select differently');
  // One generator drawn in a replay: two draws per build.
  let n = 0;
  const r = await buildLace(T, s, it, P, { changePolicy: 'default', random: () => (n++ % 7) / 7 });
  assert.equal(r.ok, true, r.detail);
  assert.equal(n, 2);
});

test('the TTL is the spend\'s slot plus 7200 whatever the clock reads; the intent\'s own validity stands', { skip }, async () => {
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const now = Date.now;
  try {
    const ttls = [];
    for (const clock of [0, 2e12]) {
      Date.now = () => clock;
      const r = await buildLace(T, s, payment([pay(0, 3n * ADA)], 5000), P, own);
      assert.equal(r.ok, true, r.detail);
      ttls.push(ttlOf(r.txs[0].bytes));
    }
    Date.now = now;
    const r = await buildLace(T, s, payment([pay(0, 3n * ADA)], 5000), P, own);
    assert.deepEqual(ttls, [5000n + 7200n, 5000n + 7200n]);
    assert.equal(ttlOf(r.txs[0].bytes), 5000n + 7200n);
    const withOwn = replayIntent('v1', 5000, { type: 'T1', requested: [pay(0, 3n * ADA)], fixed: { body: { 3: encUint(9000).toString('hex'), 8: encUint(10).toString('hex') } } });
    const v = await buildLace(T, s, withOwn, P, own);
    assert.equal(v.ok, true, v.detail);
    assert.equal(ttlOf(v.txs[0].bytes), 9000n);
  } finally {
    Date.now = now;
  }
});

test('inputs that cannot fund the layout change fail with change-minimum while the library builds its own', { skip }, async () => {
  const s = constructState(T, [{ coin: 10n * ADA, assets: Array.from({ length: 40 }, (_, i) => ({ policy: policy(`q${i}`), name: assetName('t'), qty: 1n })) }]);
  const it = payment([pay(0, 2n * ADA)]);
  const a = await buildLace(T, s, it, P, own);
  assert.equal(a.ok, true, a.detail);
  assert.equal(checkAndApply(s, P, a.txs).ok, true);
  const b = await buildLace(T, s, it, P, layout);
  assert.deepEqual([b.ok, b.class], [false, CLASSES.changeMinimum]);
  assert.match(b.detail, /^layout change on the library's inputs: /);
});

test('a library failure under the layout change is the library\'s, as under its own', { skip }, async () => {
  const s = constructState(T, [{ coin: 3n * ADA }]);
  const it = payment([pay(0, 50n * ADA)]);
  const a = await buildLace(T, s, it, P, own);
  const b = await buildLace(T, s, it, P, layout);
  assert.deepEqual([a.ok, a.class], [false, CLASSES.balance]);
  assert.deepEqual([b.ok, b.class, b.detail], [a.ok, a.class, a.detail]);
});

const replayLace = (source, changePolicy) => replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: makeMethod(T, 'lace-rrri'), opts: { seed: 1, changePolicy, collateralRule: 'ledger' }, settleEvery: 25, keepTx: true, validity: true });
const intentsOf = (source) => source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);

test('replayed synthetic streams under both changes: no validity failure, fixed inputs kept, the set-aside collateral, the parts written after the build named', { skip, timeout: 5 * 60 * 1000 }, async (t) => {
  const seen = {};
  for (const name of ['S1', 'M1']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const intents = intentsOf(source);
    const runs = {};
    for (const cp of ['default', 'layout']) {
      const r = await replayLace(source, cp);
      assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.details));
      for (const s of r.spends) assert.notEqual(s.class, CLASSES.other, `${name} ${cp} ${s.type}: ${s.detail}`);
      runs[cp] = r;
    }
    let built = 0;
    let scripts = 0;
    for (const cp of ['default', 'layout']) {
      for (const sb of runs[cp].spends) {
        if (sb.outcome !== 'built') continue;
        built++;
        const intent = withoutLeftovers(intents[sb.intent]);
        const tx = inspectTx(sb.built.txs[0].bytes);
        for (const x of intent.fixed ? intent.fixed.inputs : []) assert.ok(tx.inputs.some((y) => y.ref === x.ref), `${sb.type}: fixed input missing`);
        if (intent.collateral.required) {
          scripts++;
          assert.equal(sb.collateralUsed.chosen, 'set-aside');
          assert.equal(tx.collateralInputs.length, 1);
        }
      }
    }
    // The legacy registration has no operation: written after the build,
    // unpriced, its deposit unbalanced; the layout change writes and balances
    // it. The mint under a native script has none either: the library is not
    // given it, and fails short of the token it would mint.
    const reg = intents.findIndex((i) => i.fixed && i.fixed.body[4] !== undefined);
    assert.deepEqual(afterParts(loadLace(), intents[reg]), ['certificates']);
    const o = runs.default.spends.find((s) => s.intent === reg);
    assert.deepEqual([o.outcome, o.class], ['failed', CLASSES.balance]);
    assert.match(o.detail, /parts the library did not price: certificates/);
    assert.equal(runs.layout.spends.find((s) => s.intent === reg).outcome, 'built');
    const mint = intents.findIndex((i) => i.type === 'T8');
    assert.deepEqual(afterParts(loadLace(), intents[mint]), ['mint']);
    for (const cp of ['default', 'layout']) {
      const m = runs[cp].spends.find((s) => s.intent === mint);
      assert.deepEqual([m.outcome, m.class], ['failed', CLASSES.balance]);
      assert.match(m.detail, /parts the library did not price: mint/);
    }
    seen[name] = { built, scripts };
  }
  assert.ok(Object.values(seen).some((x) => x.scripts > 0), JSON.stringify(seen));
  t.diagnostic(JSON.stringify(seen));
});

test('a replayed signer and validity, a Conway registration with delegation and a withdrawal build under both changes', { skip }, async () => {
  const state = shapeState(T, 'S1').state;
  const stakeCred = encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))]);
  const walletKey = [...state.utxos.values()].find((u) => u.held === null).cred;
  const pool = encBytes(Buffer.alloc(28, 0x50));
  const account = Buffer.concat([Buffer.from([0xe1]), Buffer.from(state.stakeCred, 'hex')]);
  const intents = [
    replayIntent('c1', 10, { type: 'T5', requested: [pay(0, 3n * ADA)], fixed: { body: { 14: encArray([encBytes(Buffer.from(walletKey, 'hex'))]).toString('hex'), 8: encUint(5).toString('hex'), 3: encUint(5000).toString('hex') } } }),
    replayIntent('c2', 20, { type: 'T7', fixed: { body: { 4: encArray([encArray([encUint(7), stakeCred, encUint(P.keyDeposit)]), encArray([encUint(2), stakeCred, pool])]).toString('hex') } }, implicit: { deposits: P.keyDeposit } }),
    replayIntent('c3', 30, { type: 'T1', requested: [pay(1, 3n * ADA)], fixed: { body: { 5: encMap([[encBytes(account), encUint(2n * ADA)]]).toString('hex') } }, implicit: { withdrawals: 2n * ADA } })
  ];
  const source = { wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: state.stakeCred, changeAddress: state.changeAddress, changeAddressEnd: state.changeAddress, franken: new Set(), start: [...state.utxos.values()], events: intents.map((intent, i) => ({ kind: 'intent', txId: i + 1, intent })), windowStart: 0, windowEnd: 1000, params: P };
  for (const cp of ['default', 'layout']) {
    const r = await replayLace(source, cp);
    assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.details));
    for (const s of r.spends) assert.equal(s.outcome, 'built', `${cp} ${s.type}: ${s.class} ${s.detail}`);
  }
});

test('each redeemer the library cannot attach makes the intent not replayable, under both changes', { skip }, async () => {
  const state = shapeState(T, 'S1').state;
  const requested = [pay(0, 2n * ADA)];
  const scriptCred = encArray([encUint(1), encBytes(Buffer.alloc(28, 0x5c))]);
  const red = (tag, target) => ({ tag, target, data: '00', exUnits: EX_UNITS });
  const voter = encArray([encUint(3), encBytes(Buffer.alloc(28, 0x5d))]).toString('hex');
  const nativePolicy = policy('native');
  const plutusPolicy = policy('plutus');
  const cases = [
    [{ body: { 6: encArray([encMap([]), encUint(0)]).toString('hex') } }, {}, /^body field 6/],
    [{ redeemers: [red(4, { kind: 'voter', voter })] }, {}, /^a vote redeemer/],
    [{ redeemers: [red(5, { kind: 'proposal', index: 0 })] }, {}, /^a proposal redeemer/],
    [{ body: { 4: encArray([encArray([encUint(8), scriptCred, encUint(P.keyDeposit)])]).toString('hex') }, redeemers: [red(2, { kind: 'certificate', index: 0 })] }, {}, /^a redeemer on a kind 8 certificate/],
    [{ body: { 4: encArray([encArray([encUint(0), scriptCred]), encArray([encUint(7), scriptCred, encUint(P.keyDeposit)])]).toString('hex') }, redeemers: [red(2, { kind: 'certificate', index: 1 })] }, {}, /^a certificate redeemer on certificates written after the build/],
    [{ body: { 9: '00' }, redeemers: [red(1, { kind: 'policy', policy: plutusPolicy })] }, { mint: [{ policy: nativePolicy, name: '01', qty: 1n }, { policy: plutusPolicy, name: '01', qty: 1n }] }, /^a mint redeemer on a mint written after the build/]
  ];
  const m = makeMethod(T, 'lace-rrri');
  for (const [fixed, implicit, why] of cases) {
    const it = replayIntent('n1', 10, { type: 'T1', requested, fixed, implicit });
    assert.match(laceRefusal(it), why);
    for (const opts of [own, layout]) {
      const r = await m.build(state, it, P, opts);
      assert.deepEqual([r.ok, r.class], [false, NOT_REPLAYABLE], r.detail);
      assert.match(r.detail, why);
    }
  }
});
