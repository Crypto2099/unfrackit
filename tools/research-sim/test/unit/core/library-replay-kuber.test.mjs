// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Kuber's transaction runner (kuber-prune, methods/kuber.mjs), run in the
// Haskell helper (helpers/kuber, scripts/build-helpers.mjs kuber) through the
// bridge: its own change (L/own) and UnFrack.It's layout change on the inputs
// it selected (L/layout). It is deterministic: a build gives the same bytes
// every time, and L/own and L/layout select the same inputs; its selection
// prunes the sorted candidates from the front and adds one more when the
// change is short of its minimum; an input set that cannot fund the layout
// change fails with class change-minimum; a library failure is the library's
// under both; any other change policy is refused; a replayed spend's
// validity, required signers, metadata and Plutus mint pass through Kuber's
// operations, with the collateral the engine set aside; each part Kuber cannot
// write is not replayable. The source pins and the one change to Kuber's
// package description are checked without the build. The tests that run the
// helper skip, naming the build command, when it is not built.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kuberMethod, classOfKuberError } from '../../../src/methods/kuber.mjs';
import { KUBER_COMMIT, KUBER_PATHS, KUBER_CABAL_EDITED, KUBER_EXPOSED_MODULE, exposeTxFramework } from '../../../src/methods/kuber-source.mjs';
import { helperBuild, BUILD_SCRIPT } from '../../../src/methods/helper.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { REPLAY_COVERAGE } from '../../../src/methods/library.mjs';
import { NOT_REPLAYABLE, checkMethod, choosesOwnCollateral } from '../../../src/methods/contract.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { checkAndApply } from '../../../src/kit/apply.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { replay } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { constructState, policy, assetName, ADA } from '../../lib/construct.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { encUint, encArray, encMap, encBytes, encTag, encText, decode, asUint } from '../../../src/history/cbor.mjs';
import { replayIntent, payTo as payToOf, zeroRedeemerIntents } from '../../lib/script-intents.mjs';
import { treatment, skip as noTreatment } from '../../lib/treatment.mjs';

const P = SYNTHETIC_PARAMS;
const own = { changePolicy: 'default', seed: 1 };
const layout = { changePolicy: 'layout', seed: 1 };
const { problem } = helperBuild('kuber');
const noBuild = problem ? `kuber-prune: ${problem}` : false;
const skip = noTreatment || noBuild;

test('Kuber covers every replay part; without the build the method refuses to load, naming the command', () => {
  assert.deepEqual(REPLAY_COVERAGE.kuber, ['fixed', 'collateral', 'implicit', 'outputData']);
  if (problem) {
    assert.ok(problem.includes(`node ${BUILD_SCRIPT} kuber`));
    assert.throws(() => kuberMethod(null), /scripts\/build-helpers\.mjs kuber/);
  }
});

test('the one change moves the runner\'s module from other-modules to exposed-modules and nothing else', () => {
  assert.equal(KUBER_COMMIT, '2c559089e394ea7bc8a9bbde968bcdfb2ef7fac5');
  assert.deepEqual(Object.keys(KUBER_PATHS).sort(), ['CHANGELOG.md', 'LISENCE', 'kuber.cabal', 'src']);
  const before = ['library', '  exposed-modules:', '    Cardano.Kuber.Api', '    Cardano.Kuber.Http.Spec', '', '  other-modules:', '    Cardano.Kuber.Core.TxBuilder', `    ${KUBER_EXPOSED_MODULE}`, '    Cardano.Kuber.Core.KuberAPI', ''].join('\n');
  const after = exposeTxFramework(before);
  assert.equal(after, ['library', '  exposed-modules:', '    Cardano.Kuber.Api', '    Cardano.Kuber.Http.Spec', `    ${KUBER_EXPOSED_MODULE}`, '', '  other-modules:', '    Cardano.Kuber.Core.TxBuilder', '    Cardano.Kuber.Core.KuberAPI', ''].join('\n'));
  assert.equal(after.split('\n').sort().join('\n'), before.split('\n').sort().join('\n'));
  assert.throws(() => exposeTxFramework(after), /does not have the layout the change expects/);
  assert.throws(() => exposeTxFramework(before.replace(`    ${KUBER_EXPOSED_MODULE}\n`, '')), /exactly once/);
  assert.match(KUBER_CABAL_EDITED, /^[0-9a-f]{40}$/);
});

test('kuber-prune is deterministic and seeded, does not choose its own collateral, and names the helper build in its version', { skip: noBuild }, () => {
  const m = checkMethod(kuberMethod(null));
  assert.equal(m.name, 'kuber-prune');
  assert.deepEqual([m.deterministic, m.seeded, choosesOwnCollateral(m)], [true, true, false]);
  const { record } = helperBuild('kuber');
  assert.match(m.version, /^Kuber 4\.2\.0 \(2c55908\) txWalletUtxos pruning selection; helper kuber sha256 [0-9a-f]{16}$/);
  assert.ok(m.version.endsWith(record.sha256.slice(0, 16)));
  assert.equal(record.modules.kuber.packageDescription.edited, KUBER_CABAL_EDITED);
  for (const [path, [, hash]] of Object.entries(KUBER_PATHS)) assert.equal(record.modules.kuber.paths[path], hash);
});

test('the library\'s errors map to the failure classes', () => {
  const c = classOfKuberError;
  assert.equal(c('InsufficientInput: Missing Balance :[(AdaAssetId,46829131)]'), CLASSES.balance);
  assert.equal(c('BalancingError: No utxo available for collateral'), CLASSES.collateral);
  assert.equal(c('LibraryError: TxBodyEmptyTxIns'), CLASSES.other);
  assert.equal(c('LibraryError: TxBodyEmptyTxInsCollateral'), CLASSES.other);
});

const T = skip ? null : await treatment();
const pay = (i, coin, extra) => payToOf(T, i, coin, extra);
const payment = (requested, t = 100, fixed = null) => replayIntent('p1', t, { type: 'T1', requested, fixed });
const field = (hex, k) => {
  const n = decode(Buffer.from(hex, 'hex'));
  const e = n.items[0].entries.find(([key]) => Number(key.value) === k);
  return e ? e[1] : null;
};

test('kuber-prune is made by name and refuses a change policy other than its own and the layout change', { skip }, async () => {
  const m = makeMethod(T, 'kuber-prune');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const it = payment([pay(0, 3n * ADA)]);
  assert.equal((await m.build(s, it, P, own)).ok, true);
  const r = await m.build(s, it, P, { changePolicy: 'ladder', seed: 1 });
  assert.deepEqual([r.ok, r.class], [false, CLASSES.other]);
  assert.match(r.detail, /its own change or the layout change only/);
});

test('a build gives the same bytes every time; L/own and L/layout select the same inputs; both pass the kit; Kuber prunes the sorted candidates and adds one for the change minimum', { skip }, async () => {
  const m = makeMethod(T, 'kuber-prune');
  // Sorted by lovelace ascending: 1, 2, 3, 10 ADA. Paying 12 ADA, the pruning
  // drops 1 and 2 ADA and keeps 3 and 10 ADA, whose change of about 0.8 ADA is
  // short of a change output's minimum; the first dropped UTxO whose lovelace
  // exceeds its own minimum by more than the shortfall, 2 ADA, comes back.
  const s = constructState(T, [{ coin: 10n * ADA }, { coin: 1n * ADA }, { coin: 3n * ADA }, { coin: 2n * ADA }]);
  const it = payment([pay(0, 12n * ADA)]);
  const a = await m.build(s, it, P, own);
  const a2 = await m.build(s, it, P, { ...own, seed: 2 });
  const l = await m.build(s, it, P, layout);
  assert.equal(a.ok, true, a.detail);
  assert.equal(l.ok, true, l.detail);
  assert.equal(a.txs[0].bytes, a2.txs[0].bytes);
  assert.deepEqual(l.txs[0].walletInputs, a.txs[0].walletInputs);
  assert.deepEqual(a.txs[0].walletInputs.map((r) => s.utxos.get(r).coin).sort((x, y) => (x < y ? -1 : 1)), [2n * ADA, 3n * ADA, 10n * ADA]);
  for (const r of [a, l]) {
    const applied = checkAndApply(s, P, r.txs);
    assert.equal(applied.ok, true, applied.failure && applied.failure.detail);
  }
  assert.ok(a.library.fee >= a.library.finalMinFee);
  assert.equal(inspectTx(a.txs[0].bytes).vkeys.length, a.txs[0].k);
  // One change output holding the whole remainder.
  assert.equal(inspectTx(a.txs[0].bytes).outputs.length, 2);
  // A token UTxO sorts first and the pruning drops it when the change covers it.
  const t = constructState(T, [...Array.from({ length: 12 }, (_, i) => ({ coin: BigInt(2 + i) * ADA })), { coin: 3n * ADA, assets: [{ policy: policy('a'), name: assetName('x'), qty: 5n }] }]);
  const b = await m.build(t, payment([pay(0, 9n * ADA)]), P, own);
  assert.equal(b.ok, true, b.detail);
  assert.deepEqual(b.txs[0].walletInputs.map((r) => t.utxos.get(r).coin), [13n * ADA]);
});

test('inputs that cannot fund the layout change fail with change-minimum while the library builds its own', { skip }, async () => {
  const m = makeMethod(T, 'kuber-prune');
  // One UTxO of 12 ADA and 60 tokens: Kuber keeps it and writes one change
  // output of all 60 tokens; UnFrack.It's layout spreads them over outputs
  // whose minimums take more ADA than the input has left.
  const s = constructState(T, [{ coin: 12n * ADA, assets: Array.from({ length: 60 }, (_, i) => ({ policy: policy(`q${i}`), name: assetName('t'), qty: 1n })) }]);
  const it = payment([pay(0, 1500000n)]);
  const a = await m.build(s, it, P, own);
  assert.equal(a.ok, true, a.detail);
  assert.equal(checkAndApply(s, P, a.txs).ok, true);
  const b = await m.build(s, it, P, layout);
  assert.deepEqual([b.ok, b.class], [false, CLASSES.changeMinimum], b.detail);
  assert.match(b.detail, /^layout change on the library's inputs: /);
});

test('a library failure under the layout change is the library\'s, as under its own', { skip }, async () => {
  const m = makeMethod(T, 'kuber-prune');
  const s = constructState(T, [{ coin: 3n * ADA }]);
  const it = payment([pay(0, 50n * ADA)]);
  const a = await m.build(s, it, P, own);
  const b = await m.build(s, it, P, layout);
  assert.deepEqual([a.ok, a.class], [false, CLASSES.balance]);
  assert.match(a.detail, /^build: InsufficientInput: Missing Balance/);
  assert.deepEqual([b.ok, b.class, b.detail], [a.ok, a.class, a.detail]);
});

test('the intent\'s validity, required signers and metadata pass through Kuber\'s operations', { skip }, async () => {
  const m = makeMethod(T, 'kuber-prune');
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

test('a Plutus mint carries its redeemer and the collateral the engine set aside; a withdrawal is not replayable', { skip }, async () => {
  const m = makeMethod(T, 'kuber-prune');
  const s = constructState(T, [{ coin: 20n * ADA }, { coin: 8n * ADA }]);
  const collateral = s.utxos.get([...s.utxos.keys()].find((r) => s.utxos.get(r).coin === 8n * ADA));
  const pool = constructState(T, [{ coin: 20n * ADA }]);
  const [mint, withdrawal] = zeroRedeemerIntents(T, s);
  for (const opts of [own, layout]) {
    const r = await m.build(pool, mint, P, { ...opts, collateral });
    assert.equal(r.ok, true, r.detail);
    assert.ok(field(r.txs[0].bytes, 13), 'collateral inputs');
    assert.ok(field(r.txs[0].bytes, 11), 'script data hash');
    assert.ok(field(r.txs[0].bytes, 9), 'mint');
    if (opts === own) assert.ok(r.library.fee >= r.library.finalMinFee, `${r.library.fee} ${r.library.finalMinFee}`);
    const w = await m.build(pool, withdrawal, P, { ...opts, collateral });
    assert.deepEqual([w.ok, w.class], [false, NOT_REPLAYABLE], w.detail);
    assert.match(w.detail, /^withdrawals: /);
  }
});

test('a vote and an info proposal pass through Kuber\'s JSON form as observed, the proposal\'s deposit counted', { skip }, async () => {
  const m = makeMethod(T, 'kuber-prune');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const account = Buffer.concat([Buffer.from([0xe0]), Buffer.alloc(28, 3)]);
  const anchor = encArray([encText('https://example.com/a'), encBytes(Buffer.alloc(32, 1))]);
  const info = encArray([encUint(ADA), encBytes(account), encArray([encUint(6)]), anchor]);
  const votes = encMap([[encArray([encUint(2), encBytes(Buffer.alloc(28, 9))]), encMap([[encArray([encBytes(Buffer.alloc(32, 4)), encUint(1)]), encArray([encUint(1), anchor])]])]]);
  const it = replayIntent('g1', 100, { type: 'T1', requested: [pay(0, 3n * ADA)], fixed: { body: { 19: votes.toString('hex'), 20: encArray([info]).toString('hex') } }, implicit: { deposits: ADA } });
  for (const opts of [own, layout]) {
    const r = await m.build(s, it, P, opts);
    assert.equal(r.ok, true, r.detail);
    const tx = r.txs[0].bytes;
    assert.ok(field(tx, 19), 'votes');
    assert.ok(field(tx, 20), 'proposals');
    const applied = checkAndApply(s, P, r.txs, { fixed: it.fixed, implicit: it.implicit });
    assert.equal(applied.ok, true, applied.failure && applied.failure.detail);
  }
});

test('each part Kuber cannot write is not replayable', { skip }, async () => {
  const m = makeMethod(T, 'kuber-prune');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const parts = (fixed) => payment([pay(0, 3n * ADA)], 100, fixed);
  const boot = parts({ witnesses: { 2: encArray([encArray([encBytes(Buffer.alloc(32)), encBytes(Buffer.alloc(64)), encBytes(Buffer.alloc(32)), encBytes(Buffer.from([0xa0]))])]).toString('hex') } });
  const account = Buffer.concat([Buffer.from([0xe0]), Buffer.alloc(28, 3)]);
  const withdrawals = parts({ body: { 5: encMap([[encBytes(account), encUint(5n * ADA)]]).toString('hex') } });
  const treasury = parts({ body: { 21: encUint(1000n).toString('hex') } });
  const donation = parts({ body: { 22: encUint(1000n).toString('hex') } });
  // An info action with a redeemer whose data is the integer 0.
  const anchor = encArray([encText('https://example.com/a'), encBytes(Buffer.alloc(32, 1))]);
  const info = encArray([encUint(100000n * ADA), encBytes(account), encArray([encUint(6)]), anchor]);
  const proposal = parts({ body: { 20: encTag(258, encArray([info])).toString('hex') }, redeemers: [{ tag: 5, target: { kind: 'proposal', index: 0 }, data: '00', exUnits: [1n, 1n] }] });
  const certificate = parts({ redeemers: [{ tag: 2, target: { kind: 'certificate', index: 0 }, data: '00', exUnits: [1n, 1n] }] });
  const vote = parts({ redeemers: [{ tag: 4, target: { kind: 'voter', voter: '00' }, data: '00', exUnits: [1n, 1n] }] });
  for (const [it, re] of [
    [boot, /^bootstrap witnesses: /],
    [withdrawals, /^withdrawals: Kuber's builder has no withdrawals/],
    [treasury, /^treasury value: /],
    [donation, /^donation: /],
    [proposal, /^plutus: a proposal's redeemer other than the unit/],
    [certificate, /^plutus: a certificate's redeemer/],
    [vote, /^plutus: a vote's redeemer/]
  ]) {
    for (const opts of [own, layout]) {
      const r = await m.build(s, it, P, opts);
      assert.deepEqual([r.ok, r.class], [false, NOT_REPLAYABLE], r.detail);
      assert.match(r.detail, re);
    }
  }
});

const replayKuber = (source, changePolicy) => replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: makeMethod(T, 'kuber-prune'), opts: { seed: 1, changePolicy, collateralRule: 'ledger' }, settleEvery: 25, keepTx: true, validity: true });

test('replayed synthetic streams under both changes: no validity failure, fixed inputs kept', { skip, timeout: 5 * 60 * 1000 }, async () => {
  for (const name of ['S1', 'M1', 'CL1']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const intents = source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
    let built = 0;
    for (const cp of ['default', 'layout']) {
      const r = await replayKuber(source, cp);
      assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.failures));
      for (const sp of r.spends) {
        assert.notEqual(sp.class, CLASSES.other, `${name} ${cp}: ${sp.detail}`);
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
