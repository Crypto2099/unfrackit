// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Cardano Transaction Lib balancer (ctl-rrri, methods/ctl.mjs), built
// from CTL's package set by scripts/build-ctl.mjs: its own change (L/own) and
// UnFrack.It's layout change on the inputs it selected (L/layout). The adapter
// covers every replay part; one seed gives the same bytes and two seeds can
// differ, the draws coming through the Math.random the bundle was loaded with
// while Math.random itself is left alone; L/own and L/layout select the same
// inputs on one seed; an input set that cannot fund the layout change fails
// with class change-minimum; a library failure is the library's under both;
// any other change policy is refused; a certificate CTL's types cannot hold
// makes the intent not replayable. The tests that run the library skip, naming
// the build script, when the build is absent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ctlMethod, buildCtl, classOfCtlError, ctlRefusal, ctlBuildProblem, loadCtl, ctlRandom, ctlParams, unbalancedTx } from '../../../src/methods/ctl.mjs';
import { CTL_COMMIT, BUILD_SCRIPT } from '../../../src/methods/ctl-source.mjs';
import { parsePackageSet, importClosure } from '../../../scripts/build-ctl.mjs';
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
import { encUint, encBytes, encArray, encMap } from '../../../src/history/cbor.mjs';
import { replayIntent, payTo as payToOf } from '../../lib/script-intents.mjs';
import { treatment, skip as noTreatment } from '../../lib/treatment.mjs';

const P = SYNTHETIC_PARAMS;
const own = { changePolicy: 'default', seed: 1 };
const layout = { changePolicy: 'layout', seed: 1 };
const problem = ctlBuildProblem();
const noBuild = problem ? `ctl: ${problem}` : false;
const skip = noTreatment || noBuild;

test('CTL covers every replay part; without the build the method refuses to load, naming the build script', () => {
  assert.deepEqual(REPLAY_COVERAGE.ctl, [...REPLAY_PARTS]);
  if (problem) {
    assert.match(problem, new RegExp(BUILD_SCRIPT.replace(/[./]/g, '\\$&')));
    assert.throws(() => ctlMethod(null), /scripts\/build-ctl\.mjs/);
    assert.throws(() => loadCtl(), /scripts\/build-ctl\.mjs/);
  }
});

test('the build script reads a package set and follows a module\'s imports', async (t) => {
  const set = parsePackageSet(`{ pkgs }:
let
  inputs = {

    "a" = pkgs.stdenv.mkDerivation {
        name = "a";
        version = "v1.0.0";
        src = pkgs.fetchgit {
          url = "https://example.invalid/a.git";
          rev = "${'1'.repeat(40)}";
          sha256 = "x";
        };
      };
  };
in inputs`);
  assert.deepEqual(set, { a: { version: 'v1.0.0', url: 'https://example.invalid/a.git', rev: '1'.repeat(40) } });
  assert.throws(() => parsePackageSet('    "b" = pkgs.stdenv.mkDerivation {\n'), /1 entries, 0 read/);
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const d = mkdtempSync(join(tmpdir(), 'ctl-closure-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const f = (name, src) => {
    writeFileSync(join(d, name), src);
    return join(d, name);
  };
  const a = f('A.purs', 'module A where\nimport Prim.Row\nimport B (b)\n{-\nimport C\n-}\n');
  const b = f('B.purs', 'module B where\nimport A\n');
  const c = f('C.purs', 'module C where\n');
  assert.deepEqual(importClosure(a, new Map([['A', a], ['B', b], ['C', c]])), [a, b]);
  assert.throws(() => importClosure(b, new Map([['B', b]])), /imports A, which no package of the set holds/);
});

test('ctl-rrri is random, seeded through the Math.random its bundle holds, and given the collateral set aside', { skip: noBuild }, () => {
  const m = checkMethod(ctlMethod(null));
  assert.equal(m.name, 'ctl-rrri');
  assert.deepEqual([m.deterministic, m.seeded, choosesOwnCollateral(m)], [false, true, false]);
  assert.match(m.version, new RegExp(`^ctl v10\\.0\\.1 \\(${CTL_COMMIT.slice(0, 7)}\\) purescript-cardano-transaction-balancer v2\\.0\\.1 \\(70df801\\)`));
  const given = () => 0.5;
  assert.equal(ctlRandom({ random: given }, 'x'), given);
  const a = ctlRandom({ seed: 3 }, 'x');
  const b = ctlRandom({ seed: 3 }, 'x');
  assert.equal(a(), b());
  assert.throws(() => ctlRandom({}, 'x'), /a seed is required/);
});

test('the balancer\'s errors map to the failure classes', () => {
  assert.equal(classOfCtlError('BalanceInsufficientError'), CLASSES.balance);
  assert.equal(classOfCtlError('InsufficientUtxoBalanceToCoverAsset'), CLASSES.balance);
  for (const tag of ['InsufficientCollateralUtxos', 'CouldNotGetCollateral', 'CollateralReturnError', 'CollateralReturnMinAdaValueCalcError']) assert.equal(classOfCtlError(tag), CLASSES.collateral);
  for (const tag of ['ExUnitsEvaluationFailed', 'UtxoLookupFailedFor', 'NumericOverflowError', 'CouldNotGetUtxos']) assert.equal(classOfCtlError(tag), CLASSES.other);
});

test('a parameter the run does not state is asked for only when the spend has a part that reads it', () => {
  const plain = replayIntent('p', 1, { type: 'T1' });
  const p = ctlParams(P, plain, []);
  assert.deepEqual([p.txFeeFixed, p.txFeePerByte, p.coinsPerUtxoByte, p.stakeAddressDeposit], ['155381', 44, '4310', '2000000']);
  // The synthetic parameters state no reference-script price; nothing reads it here.
  assert.deepEqual(p.refScriptCoinsPerByte, { numerator: '0', denominator: '1' });
  const noDeposit = { ...P, keyDeposit: null };
  const cred = encArray([encUint(0), encBytes(Buffer.alloc(28, 1))]);
  const reg = replayIntent('r', 1, { type: 'T7', fixed: { body: { 4: encArray([encArray([encUint(0), cred])]).toString('hex') } } });
  assert.throws(() => ctlParams(noDeposit, reg, []), /keyDeposit is not stated/);
  assert.equal(ctlParams(noDeposit, plain, []).stakeAddressDeposit, '0');
});

const T = noTreatment ? null : await treatment();
const pay = (i, coin, extra) => payToOf(T, i, coin, extra);
const payment = (requested, t = 100) => replayIntent('p1', t, { type: 'T1', requested });

test('ctl-rrri is made by name and refuses a change policy other than its own and the layout change', { skip }, async () => {
  const m = makeMethod(T, 'ctl-rrri');
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
  const platform = Math.random;
  const a = await buildCtl(T, s, it, P, own);
  const a2 = await buildCtl(T, s, it, P, own);
  assert.equal(a.ok, true, a.detail);
  assert.equal(a.txs[0].bytes, a2.txs[0].bytes);
  assert.ok(a.library.draws > 0);
  assert.equal(Math.random, platform, 'Math.random is left alone');
  const picks = new Set();
  for (let seed = 1; seed <= 6; seed++) {
    const o = await buildCtl(T, s, it, P, { ...own, seed });
    const l = await buildCtl(T, s, it, P, { ...layout, seed });
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
  // One generator drawn in a replay: every draw of the build is the job's.
  let n = 0;
  const r = await buildCtl(T, s, it, P, { changePolicy: 'default', random: () => (n++ % 7) / 7 });
  assert.equal(r.ok, true, r.detail);
  assert.equal(n, r.library.draws);
  assert.ok(n > 0);
});

test('the balanced transaction carries the network id the change address names and no TTL', { skip }, async () => {
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const r = await buildCtl(T, s, payment([pay(0, 3n * ADA)]), P, own);
  assert.equal(r.ok, true, r.detail);
  const tx = inspectTx(r.txs[0].bytes);
  assert.ok(tx.bodyFields.includes(15));
  assert.ok(!tx.bodyFields.includes(3));
  // One change output for a payment to another address.
  assert.equal(tx.outputs.length, 2);
});

test('inputs that cannot fund the layout change fail with change-minimum while the library builds its own', { skip }, async () => {
  const s = constructState(T, [{ coin: 10n * ADA, assets: Array.from({ length: 40 }, (_, i) => ({ policy: policy(`q${i}`), name: assetName('t'), qty: 1n })) }]);
  const it = payment([pay(0, 2n * ADA)]);
  const a = await buildCtl(T, s, it, P, own);
  assert.equal(a.ok, true, a.detail);
  assert.equal(checkAndApply(s, P, a.txs).ok, true);
  const b = await buildCtl(T, s, it, P, layout);
  assert.deepEqual([b.ok, b.class], [false, CLASSES.changeMinimum]);
  assert.match(b.detail, /^layout change on the library's inputs: /);
});

test('a library failure under the layout change is the library\'s, as under its own', { skip }, async () => {
  const s = constructState(T, [{ coin: 3n * ADA }]);
  const it = payment([pay(0, 50n * ADA)]);
  const a = await buildCtl(T, s, it, P, own);
  const b = await buildCtl(T, s, it, P, layout);
  assert.deepEqual([a.ok, a.class], [false, CLASSES.balance]);
  assert.match(a.detail, /^balance: BalanceInsufficientError: /);
  assert.deepEqual([b.ok, b.class, b.detail], [a.ok, a.class, a.detail]);
});

const replayCtl = (source, changePolicy) => replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: makeMethod(T, 'ctl-rrri'), opts: { seed: 1, changePolicy, collateralRule: 'ledger' }, settleEvery: 25, keepTx: true, validity: true });
const intentsOf = (source) => source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);

test('replayed synthetic streams under both changes: no validity failure, no class other, fixed inputs kept, the set-aside collateral', { skip, timeout: 5 * 60 * 1000 }, async (t) => {
  const seen = {};
  for (const name of ['S1', 'CL1']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const intents = intentsOf(source);
    let built = 0;
    let scripts = 0;
    for (const cp of ['default', 'layout']) {
      const r = await replayCtl(source, cp);
      assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.details));
      for (const s of r.spends) assert.notEqual(s.class, CLASSES.other, `${name} ${cp} ${s.type}: ${s.detail}`);
      for (const sb of r.spends) {
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
    seen[name] = { built, scripts };
  }
  assert.ok(Object.values(seen).some((x) => x.scripts > 0), JSON.stringify(seen));
  t.diagnostic(JSON.stringify(seen));
});

test('a replayed signer and validity, a registration with delegation and a withdrawal build under both changes', { skip }, async () => {
  const state = shapeState(T, 'S1').state;
  const stakeCred = encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))]);
  const walletKey = [...state.utxos.values()].find((u) => u.held === null).cred;
  const pool = encBytes(Buffer.alloc(28, 0x50));
  const account = Buffer.concat([Buffer.from([0xe1]), Buffer.from(state.stakeCred, 'hex')]);
  const intents = [
    replayIntent('c1', 10, { type: 'T5', requested: [pay(0, 3n * ADA)], fixed: { body: { 14: encArray([encBytes(Buffer.from(walletKey, 'hex'))]).toString('hex'), 8: encUint(5).toString('hex'), 3: encUint(5000).toString('hex') } } }),
    replayIntent('c2', 20, { type: 'T7', fixed: { body: { 4: encArray([encArray([encUint(11), stakeCred, pool, encUint(P.keyDeposit)])]).toString('hex') } }, implicit: { deposits: P.keyDeposit } }),
    replayIntent('c3', 30, { type: 'T1', requested: [pay(1, 3n * ADA)], fixed: { body: { 5: encMap([[encBytes(account), encUint(2n * ADA)]]).toString('hex') } }, implicit: { withdrawals: 2n * ADA } })
  ];
  const source = { wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: state.stakeCred, changeAddress: state.changeAddress, changeAddressEnd: state.changeAddress, franken: new Set(), start: [...state.utxos.values()], events: intents.map((intent, i) => ({ kind: 'intent', txId: i + 1, intent })), windowStart: 0, windowEnd: 1000, params: P };
  for (const cp of ['default', 'layout']) {
    const r = await replayCtl(source, cp);
    assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.details));
    for (const s of r.spends) assert.equal(s.outcome, 'built', `${cp} ${s.type}: ${s.class} ${s.detail}`);
  }
});

test('a certificate CTL\'s types cannot hold makes the intent not replayable, under both changes; the library would fail on it', { skip }, async () => {
  const state = shapeState(T, 'S1').state;
  const requested = [pay(0, 2n * ADA)];
  const cred = encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))]);
  const cases = [
    [{ body: { 6: encArray([encMap([]), encUint(0)]).toString('hex') } }, /^body field 6/],
    [{ body: { 4: encArray([encArray([encUint(7), cred, encUint(P.keyDeposit)])]).toString('hex') } }, /^a kind 7 certificate/],
    [{ body: { 4: encArray([encArray([encUint(8), cred, encUint(P.keyDeposit)])]).toString('hex') } }, /^a kind 8 certificate/]
  ];
  const m = makeMethod(T, 'ctl-rrri');
  for (const [fixed, why] of cases) {
    const it = replayIntent('n1', 10, { type: 'T1', requested, fixed });
    assert.match(ctlRefusal(it), why);
    for (const opts of [own, layout]) {
      const r = await m.build(state, it, P, opts);
      assert.deepEqual([r.ok, r.class], [false, NOT_REPLAYABLE], r.detail);
      assert.match(r.detail, why);
    }
  }
  // What the refusal spares: CTL's types cannot decode a kind 7 certificate.
  const C = loadCtl();
  const it = replayIntent('n2', 10, { type: 'T1', requested, fixed: cases[1][0] });
  const request = { tx: unbalancedTx(it), walletUtxos: [], extraUtxos: [], collateral: [], ownAddresses: [state.changeAddress], changeAddress: state.changeAddress, mainnet: true, pparams: ctlParams(P, it, []), evaluate: () => [] };
  await assert.rejects(async () => C.lib.balance(request)());
});
