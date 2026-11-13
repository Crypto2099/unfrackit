// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// AdaLite's planner (adalite-lp, methods/adalite.mjs), built from the
// wallet's source by scripts/build-adalite.mjs: its own change (L/own) and
// UnFrack.It's layout change on the inputs it selected (L/layout). The
// adapter covers every replay part; it is deterministic; the wallet's own
// order (addresses that are not base addresses first, ADA-only UTxOs first,
// transaction hash order within) and its shortest prefix decide the inputs,
// a prefix that would burn its change into the fee passed over; L/own and
// L/layout select the same inputs; an input set that cannot fund the layout
// change fails with class change-minimum; a wallet failure is the wallet's
// under both; any other change policy is refused; the validity is the
// wallet's, the other fixed parts are written after the build and named; the
// planner takes the whole request and, on a one-output request, gives
// getTxPlan's plan; and a requested output with a datum or a script
// reference, or a redeemer, is not replayable. The tests that run the wallet
// skip, naming the build script, when the build is absent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatment, skip as noTreatment } from '../../lib/treatment.mjs';
import { adaliteMethod, buildAdaLite, classOfAdaLiteFailure, adaliteRefusal, afterParts, adaliteBuildProblem, loadAdaLite, planTx, arrangeArgs } from '../../../src/methods/adalite.mjs';
import { ADALITE_COMMIT, BUILD_SCRIPT } from '../../../src/methods/adalite-source.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { REPLAY_PARTS, REPLAY_COVERAGE, inputOrder } from '../../../src/methods/library.mjs';
import { NOT_REPLAYABLE, choosesOwnCollateral, checkMethod } from '../../../src/methods/contract.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { checkAndApply } from '../../../src/kit/apply.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { replay } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { constructState, payIntent, policy, assetName, ADA } from '../../lib/construct.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { addressBytes, addressText } from '../../../src/history/address.mjs';
import { encUint, encBytes, encArray, encMap, encText } from '../../../src/history/cbor.mjs';
import { replayIntent, payTo, EX_UNITS } from '../../lib/script-intents.mjs';

const P = SYNTHETIC_PARAMS;
const own = { changePolicy: 'default', seed: 1 };
const layout = { changePolicy: 'layout', seed: 1 };
const txid = (n) => n.toString(16).padStart(64, '0');
const problem = adaliteBuildProblem();
const noBuild = problem ? `adalite: ${problem}` : false;
const T = await treatment();
const skip = noTreatment || noBuild;

test('without the build the method refuses to load, naming the build script', { skip: !noBuild && 'the build is present' }, () => {
  assert.match(problem, new RegExp(BUILD_SCRIPT.replace('.', '\\.')));
  assert.throws(() => loadAdaLite(), /scripts\/build-adalite\.mjs/);
});

test('AdaLite covers every replay part, is deterministic and chooses no collateral', { skip: noBuild }, () => {
  assert.deepEqual(REPLAY_COVERAGE.adalite, [...REPLAY_PARTS]);
  const m = checkMethod(adaliteMethod(null));
  assert.equal(m.name, 'adalite-lp');
  assert.deepEqual([m.deterministic, m.seeded, choosesOwnCollateral(m)], [true, true, false]);
  assert.match(m.version, new RegExp(ADALITE_COMMIT.slice(0, 7)));
});

test('the wallet\'s outcomes map to the failure classes', { skip: noBuild }, () => {
  const L = loadAdaLite();
  const plan = (code) => ({ success: false, error: { code } });
  const tok = { policy: policy('m'), name: assetName('t'), qty: 1n };
  const ada = { pool: [{ assets: [] }], intent: { requested: [{ assets: [] }] } };
  const over = { pool: [{ assets: [tok] }], intent: { requested: [{ assets: [] }] } };
  const short = { pool: [{ assets: [] }], intent: { requested: [{ assets: [tok] }] } };
  assert.equal(classOfAdaLiteFailure(L, plan('CannotConstructTxPlan'), ada), CLASSES.balance);
  assert.equal(classOfAdaLiteFailure(L, plan('CannotConstructTxPlan'), over), CLASSES.changeMinimum);
  assert.equal(classOfAdaLiteFailure(L, plan('CannotConstructTxPlan'), short), CLASSES.balance);
  assert.equal(classOfAdaLiteFailure(L, plan('ChangeOutputTooSmall')), CLASSES.changeMinimum);
  assert.equal(classOfAdaLiteFailure(L, plan('OutputTooBig')), CLASSES.valueSize);
  assert.equal(classOfAdaLiteFailure(L, plan('OutputTooSmall')), CLASSES.other);
  assert.equal(classOfAdaLiteFailure(L, plan('CoinAmountError')), CLASSES.other);
  assert.equal(classOfAdaLiteFailure(L, plan(null)), CLASSES.other);
  const big = new Error('too big');
  big.name = 'TxTooBig';
  assert.equal(classOfAdaLiteFailure(L, big), CLASSES.txSize);
  assert.equal(classOfAdaLiteFailure(L, new Error('something else')), CLASSES.other);
});

test('adalite-lp is made by name and refuses a change policy other than its own and the layout change', { skip }, async () => {
  const m = makeMethod(T, 'adalite-lp');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const it = payIntent(T, [{ coin: 3n * ADA }]);
  assert.equal((await m.build(s, it, P, own)).ok, true);
  const r = await m.build(s, it, P, { changePolicy: 'ladder', seed: 1 });
  assert.deepEqual([r.ok, r.class], [false, CLASSES.other]);
  assert.match(r.detail, /its own change or the layout change only/);
});

// An enterprise address on the base address's payment key.
const enterpriseOf = (base) => {
  const b = addressBytes(base);
  const out = Buffer.concat([Buffer.from([0x60 | (b[0] & 0x0f)]), b.subarray(1, 29)]);
  return addressText(out, base.startsWith('addr_test') ? 'preprod' : 'mainnet');
};

test('the wallet\'s order and shortest prefix, a prefix that burns its change passed over, the same bytes for any seed and the same inputs under both changes', { skip }, () => {
  const base = T.cslkit.baseAddress(0).to_bech32();
  const tok = { policy: policy('o'), name: assetName('t'), qty: 1n };
  // The state's order is the transaction ids'.
  const s = constructState(T, [
    { txid: txid(1), coin: 5n * ADA, assets: [tok] },
    { txid: txid(2), coin: 3n * ADA },
    { txid: txid(3), coin: 2n * ADA, address: enterpriseOf(base) },
    { txid: txid(4), coin: 4n * ADA }
  ]);
  const [u1, u2, u3, u4] = inputOrder(s).map((u) => u.ref);
  const it = payIntent(T, [{ coin: 4n * ADA }]);
  const a = buildAdaLite(T, s, it, P, own);
  const a2 = buildAdaLite(T, s, it, P, { changePolicy: 'default', seed: 2 });
  const b = buildAdaLite(T, s, it, P, layout);
  assert.equal(a.ok, true, a.detail);
  assert.equal(a2.txs[0].bytes, a.txs[0].bytes);
  // The order is u3 (not a base address), then the base addresses' ADA-only
  // UTxOs u2 and u4, then u1 (a token). u3 and u2 pay 4 ADA and the fee but
  // leave change under the wallet's minimum, which that plan burns into the
  // fee (computeTxPlan.ts:141-162); selectMinimalTxPlan passes it over
  // (shelley-transaction-planner.ts:214-217) and takes u4 as well.
  assert.deepEqual(a.txs[0].walletInputs, [u3, u2, u4]);
  assert.equal(b.ok, true, b.detail);
  assert.deepEqual(b.txs[0].walletInputs, a.txs[0].walletInputs);
  for (const r of [a, b]) {
    const applied = checkAndApply(s, P, r.txs);
    assert.equal(applied.ok, true, applied.failure && applied.failure.detail);
  }
  // One ADA-only change output; the wallet's fee covers the size.
  assert.equal(inspectTx(a.txs[0].bytes).outputs.length, 2);
  assert.ok(a.library.fee >= a.library.finalMinFee);
  assert.deepEqual(a.library.unpriced, []);
});

// The plan's parts as plain values, for comparing two plans.
const planView = (r) => (r.success ? { success: true, inputs: r.txPlan.inputs.map((u) => `${u.txHash}#${u.outputIndex}`), outputs: r.txPlan.outputs.map(outView), change: r.txPlan.change.map(outView), fee: r.txPlan.fee.toFixed(), baseFee: r.txPlan.baseFee.toFixed(), burned: r.txPlan.fee !== r.txPlan.baseFee } : { success: false, code: r.error ? r.error.code : null });
const outView = (o) => ({ address: o.address, coins: o.coins.toFixed(), tokens: o.tokenBundle.map((t) => `${t.policyId}.${t.assetName}:${t.quantity.toFixed()}`) });

test('on a one-output request the planner loop gives getTxPlan\'s plan', { skip }, () => {
  const L = loadAdaLite();
  const base = T.cslkit.baseAddress(0).to_bech32();
  const tok = { policy: policy('e'), name: assetName('t'), qty: 7n };
  const other = { policy: policy('e2'), name: assetName('u'), qty: 1n };
  const s = constructState(T, [
    { txid: txid(1), coin: 5n * ADA, assets: [{ ...tok, qty: 10n }] },
    { txid: txid(2), coin: 3n * ADA },
    { txid: txid(3), coin: 2n * ADA, address: enterpriseOf(base) },
    { txid: txid(4), coin: 4n * ADA, assets: [other] },
    { txid: txid(5), coin: 1500000n },
    { txid: txid(6), coin: 40n * ADA }
  ]);
  const utxos = () => inputOrder(s).map((u) => ({ txHash: u.ref.slice(0, 64), outputIndex: Number(u.ref.slice(65)), address: u.address, coins: new L.BigNumber(u.coin.toString()), tokenBundle: u.assets.map((a) => ({ policyId: a.policy, assetName: a.name, quantity: new L.BigNumber(a.qty.toString()) })) }));
  const to = payIntent(T, [{ coin: 1n * ADA }]).requested[0].address;
  const token = { policyId: tok.policy, assetName: tok.name, quantity: new L.BigNumber(7) };
  const min = BigInt(L.A.computeMinUtxoLovelaceAmount(to, [token]).toFixed());
  const { TxType, AssetFamily } = L.A;
  const cases = [
    [[{ coin: 4n * ADA }], { assetFamily: AssetFamily.ADA, fieldValue: '', coins: new L.BigNumber(4e6) }],
    [[{ coin: 1n * ADA }], { assetFamily: AssetFamily.ADA, fieldValue: '', coins: new L.BigNumber(1e6) }],
    [[{ coin: 9n * ADA }], { assetFamily: AssetFamily.ADA, fieldValue: '', coins: new L.BigNumber(9e6) }],
    [[{ coin: 50n * ADA }], { assetFamily: AssetFamily.ADA, fieldValue: '', coins: new L.BigNumber(50e6) }],
    [[{ coin: 54n * ADA }], { assetFamily: AssetFamily.ADA, fieldValue: '', coins: new L.BigNumber(54e6) }],
    [[{ coin: 900000n }], { assetFamily: AssetFamily.ADA, fieldValue: '', coins: new L.BigNumber(9e5) }],
    [[{ coin: min, assets: [tok] }], { assetFamily: AssetFamily.TOKEN, fieldValue: '', token }]
  ];
  const seen = new Set();
  for (const [outs, sendAmount] of cases) {
    const it = payIntent(T, outs);
    const got = planView(planTx(L, it, utxos(), s.changeAddress));
    const want = planView(L.account.getTxPlan(s.changeAddress, { txType: TxType.SEND_ADA, address: it.requested[0].address, sendAmount }, utxos()));
    assert.deepEqual(got, want, JSON.stringify(outs, (_, v) => (typeof v === 'bigint' ? `${v}` : v)));
    seen.add(got.success ? (got.burned ? 'burned' : got.change.length ? 'change' : 'exact') : got.code);
  }
  // The cases reach a plan with change, the failure of a short wallet and
  // that of an output under the wallet's minimum.
  for (const k of ['change', 'CannotConstructTxPlan', 'OutputTooSmall']) assert.ok(seen.has(k), k);
});

test('the planner takes the whole request: several outputs, several tokens and the requested coin; a datum or a script reference is not replayable', { skip }, () => {
  const tok = { policy: policy('w'), name: assetName('t'), qty: 3n };
  const tok2 = { policy: policy('w2'), name: assetName('u'), qty: 1n };
  const s = constructState(T, [{ coin: 30n * ADA }, { coin: 5n * ADA, assets: [{ ...tok, qty: 5n }, tok2] }, { coin: 8n * ADA }]);
  for (const outs of [
    [{ coin: 2n * ADA }, { coin: 3n * ADA }],
    [{ coin: 2n * ADA, assets: [tok, tok2] }],
    [{ coin: 3n * ADA, assets: [tok] }, { coin: 4n * ADA }]
  ]) {
    const it = payIntent(T, outs);
    for (const opts of [own, layout]) {
      const r = buildAdaLite(T, s, it, P, opts);
      assert.equal(r.ok, true, r.detail);
      assert.equal(checkAndApply(s, P, r.txs).ok, true);
      // Every requested output is in the transaction as asked.
      const d = inspectTx(r.txs[0].bytes);
      for (const o of outs) assert.ok(d.outputs.some((x) => x.coin === o.coin && x.assets.length === (o.assets || []).length), `${opts.changePolicy}: an output of ${o.coin}`);
    }
  }
  // No requested output: the plan pays the fee from the first UTxO in the
  // wallet's order and returns the rest as change.
  const none = replayIntent('none', 10, { type: 'T1', requested: [], fixed: {} });
  const z = buildAdaLite(T, s, none, P, own);
  assert.equal(z.ok, true, z.detail);
  assert.equal(z.txs[0].walletInputs.length, 1);
  const datum = replayIntent('datum', 10, { type: 'T1', requested: [payTo(T, 0, 3n * ADA), payTo(T, 1, 3n * ADA, { datum: { kind: 'inline', cbor: '00' } })].map((o, i) => (i ? { ...o, cbor: datumOutput(o) } : o)) });
  for (const opts of [own, layout]) {
    const r = buildAdaLite(T, s, datum, P, opts);
    assert.deepEqual([r.ok, r.class], [false, NOT_REPLAYABLE], r.detail);
    assert.match(r.detail, /requested output 1 has a datum or a script reference/);
  }
});

test('the arrangement is a token send\'s when the request holds one token, an ADA send\'s otherwise', { skip }, () => {
  const L = loadAdaLite();
  const tok = { policy: policy('a'), name: assetName('t'), qty: 1n };
  const tok2 = { policy: policy('a2'), name: assetName('u'), qty: 1n };
  const one = arrangeArgs(L, payIntent(T, [{ coin: 2n * ADA, assets: [tok] }, { coin: 2n * ADA, assets: [{ ...tok, qty: 2n }] }]));
  assert.deepEqual([one.sendAmount.assetFamily, one.sendAmount.token.policyId], [L.A.AssetFamily.TOKEN, tok.policy]);
  assert.equal(arrangeArgs(L, payIntent(T, [{ coin: 2n * ADA, assets: [tok, tok2] }])).sendAmount.assetFamily, L.A.AssetFamily.ADA);
  assert.equal(arrangeArgs(L, payIntent(T, [{ coin: 2n * ADA }])).sendAmount.assetFamily, L.A.AssetFamily.ADA);
  // With one requested token, its holder is the first input.
  const s = constructState(T, [{ coin: 20n * ADA }, { coin: 5n * ADA, assets: [{ ...tok, qty: 10n }] }]);
  const a = buildAdaLite(T, s, payIntent(T, [{ coin: 3n * ADA, assets: [tok] }]), P, own);
  assert.equal(a.ok, true, a.detail);
  assert.equal(a.txs[0].walletInputs[0], inputOrder(s).find((u) => u.assets.length).ref);
});

// A requested output's bytes with an inline datum (the integer 0), in the map
// form.
function datumOutput(o) {
  return encMap([[encUint(0), encBytes(addressBytes(o.address))], [encUint(1), encUint(o.coin)], [encUint(2), encArray([encUint(1), Buffer.concat([Buffer.from([0xd8, 0x18]), encBytes(Buffer.from('00', 'hex'))])])]]).toString('hex');
}

test('inputs that cannot fund the layout change fail with change-minimum while the wallet builds its own', { skip }, () => {
  const s = constructState(T, [{ coin: 10n * ADA, assets: Array.from({ length: 40 }, (_, i) => ({ policy: policy(`q${i}`), name: assetName('t'), qty: 1n })) }]);
  const it = payIntent(T, [{ coin: 2n * ADA }]);
  const a = buildAdaLite(T, s, it, P, own);
  assert.equal(a.ok, true, a.detail);
  assert.equal(checkAndApply(s, P, a.txs).ok, true);
  const b = buildAdaLite(T, s, it, P, layout);
  assert.deepEqual([b.ok, b.class], [false, CLASSES.changeMinimum]);
  assert.match(b.detail, /^layout change on the library's inputs: /);
});

test('a wallet failure under the layout change is the wallet\'s, as under its own', { skip }, () => {
  const short = constructState(T, [{ coin: 3n * ADA }]);
  const pay = payIntent(T, [{ coin: 50n * ADA }]);
  const a = buildAdaLite(T, short, pay, P, own);
  const b = buildAdaLite(T, short, pay, P, layout);
  assert.deepEqual([a.ok, a.class], [false, CLASSES.balance]);
  assert.deepEqual([b.ok, b.class, b.detail], [a.ok, a.class, a.detail]);
  assert.match(a.detail, /CannotConstructTxPlan/);
  // A token left over whose change output the leftover ADA cannot pay.
  const tokens = constructState(T, [{ coin: 1500000n, assets: [{ policy: policy('c'), name: assetName('t'), qty: 1n }] }]);
  const c = buildAdaLite(T, tokens, payIntent(T, [{ coin: 1n * ADA }]), P, own);
  assert.deepEqual([c.ok, c.class], [false, CLASSES.changeMinimum], c.detail);
  // A requested output under the wallet's own minimum.
  const d = buildAdaLite(T, constructState(T, [{ coin: 20n * ADA }]), payIntent(T, [{ coin: 900000n }]), P, own);
  assert.deepEqual([d.ok, d.class], [false, CLASSES.other], d.detail);
  assert.match(d.detail, /OutputTooSmall/);
});

test('a replayed spend: the wallet writes the validity, the other fixed parts go on after the build, named, and L/layout builds what L/own cannot balance', { skip }, () => {
  const s = constructState(T, [{ coin: 10n * ADA }, { coin: 20n * ADA }]);
  const signer = Buffer.alloc(28, 0x33);
  const meta = encMap([[encUint(674), encMap([[encText('msg'), encArray([encText('hello')])]])]]);
  const fixed = {
    body: { 3: encUint(9000).toString('hex'), 8: encUint(100).toString('hex'), 14: encArray([encBytes(signer)]).toString('hex') },
    auxiliaryData: meta.toString('hex')
  };
  const it = replayIntent('fx', 10, { type: 'T1', requested: [payTo(T, 0, 3n * ADA)], fixed });
  assert.equal(adaliteRefusal(loadAdaLite(), it), null);
  assert.deepEqual(afterParts(it).unpriced, ['required signers', 'auxiliary data']);
  const a = buildAdaLite(T, s, it, P, own);
  assert.equal(a.ok, true, a.detail);
  const f = inspectTx(a.txs[0].bytes).tx.body.fields;
  for (const k of [3, 7, 8, 14]) assert.equal(f.has(k), true, `body field ${k}`);
  assert.deepEqual(a.library.unpriced, ['required signers', 'auxiliary data']);
  // The wallet's key and the required signer, each witnessed.
  assert.equal(a.txs[0].k, 2);
  const b = buildAdaLite(T, s, it, P, layout);
  assert.equal(b.ok, true, b.detail);
  assert.deepEqual(b.txs[0].walletInputs, a.txs[0].walletInputs);
  // A withdrawal the wallet cannot balance: L/own leaves it out of the
  // balance, so the kit's conservation check fails; L/layout builds it.
  const acct = Buffer.concat([Buffer.from([0xe1]), Buffer.alloc(28, 0x44)]);
  const w = replayIntent('wd', 10, { type: 'T1', requested: [payTo(T, 0, 3n * ADA)], fixed: { body: { 5: encMap([[encBytes(acct), encUint(2n * ADA)]]).toString('hex') } }, implicit: { withdrawals: 2n * ADA } });
  const c = buildAdaLite(T, s, w, P, own);
  assert.equal(c.ok, true, c.detail);
  assert.deepEqual(c.library.unpriced, ['withdrawals']);
  const applied = checkAndApply(s, P, c.txs, { implicit: w.implicit, fixed: w.fixed });
  assert.equal(applied.ok, false);
  assert.equal(applied.failure.cls, CLASSES.balance);
  const d = buildAdaLite(T, s, w, P, layout);
  assert.equal(d.ok, true, d.detail);
  assert.equal(checkAndApply(s, P, d.txs, { implicit: w.implicit, fixed: w.fixed }).ok, true);
});

test('a redeemer, and so a script spend\'s collateral, is not replayable', { skip }, () => {
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const red = encArray([encArray([encUint(1), encUint(0), Buffer.from('00', 'hex'), encArray([encUint(EX_UNITS[0]), encUint(EX_UNITS[1])])])]).toString('hex');
  const it = replayIntent('rd', 10, { type: 'T1', requested: [payTo(T, 0, 3n * ADA)], fixed: { witnesses: { 5: red }, redeemers: [{ tag: 1, index: 0, target: { kind: 'policy', policy: policy('r') }, data: '00', exUnits: EX_UNITS }] } });
  for (const opts of [own, layout]) {
    const r = buildAdaLite(T, s, it, P, opts);
    assert.deepEqual([r.ok, r.class], [false, NOT_REPLAYABLE]);
    assert.match(r.detail, /redeemer/);
  }
  const col = replayIntent('cl', 10, { type: 'T1', requested: [payTo(T, 0, 3n * ADA)], collateral: true });
  assert.match(buildAdaLite(T, s, col, P, { ...own, collateral: inputOrder(s)[0] }).detail, /collateral/);
});

test('the S1 and M1 streams under both changes with validity on: no validity failure, every failure names a part written after the build or is the wallet\'s own output minimum, and L/layout builds what L/own\'s kit check refused', { skip }, async () => {
  const m = makeMethod(T, 'adalite-lp');
  for (const name of ['S1', 'M1']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const runs = {};
    for (const cp of ['default', 'layout']) {
      runs[cp] = await replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: m, opts: { seed: 1, changePolicy: cp, collateralRule: 'ledger' }, settleEvery: 25, validity: true });
      assert.equal(runs[cp].summary.validity.failed, 0, `${name} ${cp}`);
      assert.ok(runs[cp].spends.some((x) => x.outcome === 'built'), `${name} ${cp}: something built`);
    }
    // Every failure names a part written after the build, or is the wallet's
    // own minimum on a requested output.
    for (const cp of ['default', 'layout']) for (const x of runs[cp].spends.filter((y) => y.outcome === 'failed')) assert.match(x.detail, /parts the library did not price|OutputTooSmall/, `${name} ${cp}: ${x.detail}`);
    // L/layout builds every spend whose L/own failure follows a part written
    // after the build and the planner's plan.
    for (const [i, x] of runs.default.spends.entries()) if (x.outcome === 'failed' && /^kit: /.test(x.detail)) assert.equal(runs.layout.spends[i].outcome, 'built', `${name} spend ${i}: ${x.detail}`);
  }
});
