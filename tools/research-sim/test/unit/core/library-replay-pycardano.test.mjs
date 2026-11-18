// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// PyCardano's transaction builder (pycardano-lf, methods/pycardano.mjs), run
// in the Python helper (helpers/pycardano, scripts/build-helpers.mjs
// pycardano) through the bridge: its own change (L/own) and UnFrack.It's
// layout change on the inputs it selected (L/layout). It is seeded: one seed
// gives the same bytes, and L/own and L/layout select the same inputs; an
// input set that cannot fund the layout change fails with class
// change-minimum; a library failure is the library's under both; any other
// change policy is refused; a replayed spend's validity, required signers,
// metadata, certificates and Plutus parts pass through the builder's
// operations, with the collateral the engine set aside; each part the builder
// cannot write is not replayable. The tests that run the helper skip, naming
// the build command, when it is not built.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pycardanoMethod, classOfPycardanoError, environmentHash, launcherText } from '../../../src/methods/pycardano.mjs';
import { helperBuild, buildRequest, spendTime, BUILD_SCRIPT } from '../../../src/methods/helper.mjs';
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
import { encUint, encArray, encMap, encBytes, encTag, decode, asUint } from '../../../src/history/cbor.mjs';
import { replayIntent, payTo as payToOf, zeroRedeemerIntents } from '../../lib/script-intents.mjs';
import { treatment, skip as noTreatment } from '../../lib/treatment.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const P = SYNTHETIC_PARAMS;
const own = { changePolicy: 'default', seed: 1 };
const layout = { changePolicy: 'layout', seed: 1 };
const { problem } = helperBuild('pycardano');
const noBuild = problem ? `pycardano-lf: ${problem}` : false;
const skip = noTreatment || noBuild;

test('PyCardano covers every replay part; without the build the method refuses to load, naming the command', () => {
  assert.deepEqual(REPLAY_COVERAGE.pycardano, ['fixed', 'collateral', 'implicit', 'outputData']);
  if (problem) {
    assert.ok(problem.includes(`node ${BUILD_SCRIPT} pycardano`));
    assert.throws(() => pycardanoMethod(null), /scripts\/build-helpers\.mjs pycardano/);
  }
});

test('pycardano-lf is seeded and not deterministic, does not choose its own collateral, and names the helper build in its version', { skip: noBuild }, () => {
  const m = checkMethod(pycardanoMethod(null));
  assert.equal(m.name, 'pycardano-lf');
  assert.deepEqual([m.deterministic, m.seeded, choosesOwnCollateral(m)], [false, true, false]);
  const { record } = helperBuild('pycardano');
  assert.match(m.version, /^PyCardano 0\.19\.2 \(0445f30\) LargestFirstSelector, RandomImproveMultiAsset fallback; helper pycardano sha256 [0-9a-f]{16}$/);
  assert.ok(m.version.endsWith(record.sha256.slice(0, 16)));
});

test('the environment hash leaves out compiled bytecode and RECORD files; the launcher names main.py and the environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pycardano-env-'));
  try {
    mkdirSync(join(dir, 'pkg', '__pycache__'), { recursive: true });
    mkdirSync(join(dir, 'pkg-1.0.dist-info'));
    writeFileSync(join(dir, 'pkg', 'a.py'), 'x = 1\n');
    writeFileSync(join(dir, 'pkg-1.0.dist-info', 'METADATA'), 'Name: pkg\n');
    const h = environmentHash(dir);
    assert.equal(h.files, 2);
    writeFileSync(join(dir, 'pkg', '__pycache__', 'a.cpython-312.pyc'), 'compiled');
    writeFileSync(join(dir, 'pkg-1.0.dist-info', 'RECORD'), '../../../bin/x,sha256=...\n');
    assert.deepEqual(environmentHash(dir), h);
    writeFileSync(join(dir, 'pkg', 'a.py'), 'x = 2\n');
    assert.notEqual(environmentHash(dir).hash, h.hash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const text = launcherText({ main: 'a'.repeat(64), environment: 'b'.repeat(64), python: 'CPython 3.12.3' });
  assert.ok(text.includes('a'.repeat(64)) && text.includes('b'.repeat(64)));
  assert.match(text, /exec env -i PYTHONHASHSEED=0 "\$d\/venv\/bin\/python" -P -s -B "\$d\/main\.py"/);
});

test('the library\'s errors map to the failure classes', () => {
  const c = classOfPycardanoError;
  assert.equal(c('UTxOSelectionException: All UTxO selectors failed.'), CLASSES.balance);
  assert.equal(c('InvalidTransactionException: The input UTxOs cannot cover the transaction outputs and tx fee.'), CLASSES.balance);
  assert.equal(c('InsufficientUTxOBalanceException: Not enough ADA left for change: 400000 but needs 969750'), CLASSES.changeMinimum);
  assert.equal(c('InsufficientUTxOBalanceException: Not enough ADA left to cover non-ADA assets in a change address'), CLASSES.changeMinimum);
  assert.equal(c('InvalidTransactionException: Transaction size (17000) exceeds the max limit (16384). Please try reducing the number of inputs or outputs.'), CLASSES.txSize);
  assert.equal(c('ValueError: Minimum collateral amount 3823990 is greater than total provided collateral inputs {}'), CLASSES.collateral);
  assert.equal(c('ValueError: Minimum lovelace amount for collateral return 969750 is greater than collateral change 500000. Please provide more collateral inputs.'), CLASSES.collateral);
  assert.equal(c('InvalidArgumentException: Cannot find a valid script to fulfill the input UTxO'), CLASSES.other);
});

test('the request carries the spend\'s own slot and block time, else the state\'s', () => {
  const state = { at: { slot: null, time: 5 } };
  assert.deepEqual(spendTime(state, { time: { slot: 120, blockTime: 1700 } }), { slot: 120, time: 1700 });
  assert.deepEqual(spendTime(state, {}), { slot: null, time: 5 });
  assert.deepEqual(spendTime({}, {}), { slot: null, time: null });
});

const T = skip ? null : await treatment();
const pay = (i, coin, extra) => payToOf(T, i, coin, extra);
const payment = (requested, t = 100, fixed = null) => replayIntent('p1', t, { type: 'T1', requested, fixed });
const field = (hex, k) => {
  const n = decode(Buffer.from(hex, 'hex'));
  const e = n.items[0].entries.find(([key]) => Number(key.value) === k);
  return e ? e[1] : null;
};

test('pycardano-lf is made by name and refuses a change policy other than its own and the layout change', { skip }, async () => {
  const m = makeMethod(T, 'pycardano-lf');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const it = payment([pay(0, 3n * ADA)]);
  assert.equal((await m.build(s, it, P, own)).ok, true);
  const r = await m.build(s, it, P, { changePolicy: 'ladder', seed: 1 });
  assert.deepEqual([r.ok, r.class], [false, CLASSES.other]);
  assert.match(r.detail, /its own change or the layout change only/);
});

test('one seed gives the same bytes; L/own and L/layout select the same inputs; both pass the kit; largest lovelace first', { skip }, async () => {
  const m = makeMethod(T, 'pycardano-lf');
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
    // The largest UTxO by lovelace covers each payment and its change.
    assert.deepEqual(a.txs[0].walletInputs.map((r) => s.utxos.get(r).coin), [13n * ADA]);
  }
});

test('the request carries the repetition\'s seed; when largest-first exhausts the pool the random fallback runs, and one seed gives the same outcome', { skip }, async () => {
  const s = constructState(T, [{ coin: 10n * ADA, assets: Array.from({ length: 90 }, (_, i) => ({ policy: policy(`q${i}`), name: assetName('t'), qty: 1n })) }, ...Array.from({ length: 3 }, () => ({ coin: 2n * ADA }))]);
  const it = payment([pay(0, 4n * ADA)]);
  const q = (opts) => buildRequest({ sent: new Map() }, { library: 'pycardano', state: s, intent: it, params: P, opts, pool: inputOrder(s), collateral: null, seeded: true });
  assert.equal(q({ seed: 7 }).seed, '7');
  assert.notEqual(q({ seed: 1 }).seed, q({ seed: 2 }).seed);
  const m = makeMethod(T, 'pycardano-lf');
  // Largest-first takes the 10 ADA UTxO, whose 90 tokens need more change
  // than the three 2 ADA UTxOs can add, and raises; the random fallback then
  // takes every UTxO, and the change still falls short of its minimum.
  for (const seed of [1, 2]) {
    const a = await m.build(s, it, P, { changePolicy: 'default', seed });
    const b = await m.build(s, it, P, { changePolicy: 'default', seed });
    assert.deepEqual([a.ok, a.class, a.detail], [false, CLASSES.changeMinimum, 'build: InsufficientUTxOBalanceException: Not enough ADA left to cover non-ADA assets in a change address']);
    assert.deepEqual(b, a);
  }
});

test('inputs that cannot fund the layout change fail with change-minimum while the library builds its own', { skip }, async () => {
  const m = makeMethod(T, 'pycardano-lf');
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
  const m = makeMethod(T, 'pycardano-lf');
  const s = constructState(T, [{ coin: 3n * ADA }]);
  const it = payment([pay(0, 50n * ADA)]);
  const a = await m.build(s, it, P, own);
  const b = await m.build(s, it, P, layout);
  assert.deepEqual([a.ok, a.class], [false, CLASSES.balance]);
  assert.equal(a.detail, 'build: UTxOSelectionException: All UTxO selectors failed.');
  assert.deepEqual([b.ok, b.class, b.detail], [a.ok, a.class, a.detail]);
});

test('the intent\'s validity, required signers and metadata pass through the builder', { skip }, async () => {
  const m = makeMethod(T, 'pycardano-lf');
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

test('Plutus mints and withdrawals carry their redeemers and the collateral the engine set aside', { skip }, async () => {
  const m = makeMethod(T, 'pycardano-lf');
  const s = constructState(T, [{ coin: 20n * ADA }, { coin: 8n * ADA }]);
  const collateral = s.utxos.get([...s.utxos.keys()].find((r) => s.utxos.get(r).coin === 8n * ADA));
  const pool = constructState(T, [{ coin: 20n * ADA }]);
  for (const it of zeroRedeemerIntents(T, s)) {
    const r = await m.build(pool, it, P, { ...own, collateral });
    assert.equal(r.ok, true, r.detail);
    const tx = inspectTx(r.txs[0].bytes);
    assert.ok(field(r.txs[0].bytes, 13), 'collateral inputs');
    assert.ok(field(r.txs[0].bytes, 11), 'script data hash');
    assert.ok(r.library.fee >= r.library.finalMinFee, `${r.library.fee} ${r.library.finalMinFee}`);
    assert.equal(tx.inputs.length, 1);
  }
});

test('each part the builder cannot write is not replayable', { skip }, async () => {
  const m = makeMethod(T, 'pycardano-lf');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const boot = payment([pay(0, 3n * ADA)], 100, { witnesses: { 2: encArray([encArray([encBytes(Buffer.alloc(32)), encBytes(Buffer.alloc(64)), encBytes(Buffer.alloc(32)), encBytes(Buffer.from([0xa0]))])]).toString('hex') } });
  const plutusWitness = payment([pay(0, 3n * ADA)], 100, { witnesses: { 7: encArray([encBytes(Buffer.alloc(40, 0x5a))]).toString('hex') } });
  const proposal = payment([pay(0, 3n * ADA)], 100, { redeemers: [{ tag: 5, target: { kind: 'proposal', index: 0 }, data: '00', exUnits: [1n, 1n] }] });
  for (const [it, re] of [[boot, /^bootstrap witnesses: /], [plutusWitness, /^plutus: a Plutus script of the witness set that no redeemer uses/], [proposal, /^plutus: a redeemer with tag 5/]]) {
    for (const opts of [own, layout]) {
      const r = await m.build(s, it, P, opts);
      assert.deepEqual([r.ok, r.class], [false, NOT_REPLAYABLE], r.detail);
      assert.match(r.detail, re);
    }
  }
});

const replayPycardano = (source, changePolicy) => replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: makeMethod(T, 'pycardano-lf'), opts: { seed: 1, changePolicy, collateralRule: 'ledger' }, settleEvery: 25, keepTx: true, validity: true });

test('replayed synthetic streams under both changes: no validity failure, fixed inputs kept', { skip, timeout: 5 * 60 * 1000 }, async () => {
  for (const name of ['S1', 'M1', 'CL1']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const intents = source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
    let built = 0;
    for (const cp of ['default', 'layout']) {
      const r = await replayPycardano(source, cp);
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
