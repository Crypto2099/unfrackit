// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The baselines' behaviors that the study's descriptions rest on, each on a
// constructed case: tie order among equal values (CSL's reverse of the order
// given on its first pass, a permuted order after it; the Evolution SDK's
// given order); CSL's input fee in the target, its random strategy without an
// improvement phase, and its change split only at the value-size limit with a
// pure-ADA change output only under prefer_pure_change; the Evolution SDK's
// lovelace-only order, its single change output over the limit, and its
// unimplemented strategy names; cardano-js-sdk's change bundle per requested
// output; C13's cases; and one constructed failure per class per adapter
// (the replay paths are tested in test/unit/core/library-replay.test.mjs for
// cardano-js-sdk, library-replay-csl.test.mjs for CSL and
// library-replay-evo.test.mjs for the Evolution SDK). Needs
// RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '@evolution-sdk/evolution';
import { makeTxBuilder } from '@evolution-sdk/evolution/sdk/builders/TransactionBuilder';
import { treatment, skip } from '../lib/treatment.mjs';
import { constructState, payIntent, order, policy, assetName, ADA } from '../lib/construct.mjs';
import { SYNTHETIC_PARAMS as P } from '../../src/kit/params.mjs';
import { checkAndApply } from '../../src/kit/apply.mjs';
import { inspectTx } from '../../src/kit/inspect.mjs';
import { minFee } from '../../src/kit/fee.mjs';
import { valueSize } from '../../src/history/value.mjs';
import { addressTextOf } from '../../src/state/utxo.mjs';
import { CLASSES } from '../../src/kit/check.mjs';
import { cslMethod } from '../../src/methods/csl.mjs';
import { cjsMethod } from '../../src/methods/cjs.mjs';
import { evoMethod, evoUtxo, evoProtocolParameters } from '../../src/methods/evo.mjs';
import { shapeState } from '../../src/shapes/shapes.mjs';
import { standardBattery, h10Battery, SHAPE_POOLS } from '../../src/battery/battery.mjs';
import { surveyFixture } from '../../src/survey/fixture.mjs';
import { makeState } from '../../src/state/state.mjs';

const T = await treatment();
const DEF = { changePolicy: 'default' };
const opts = (m, seed = 1) => (m.name === 'cjs-rrri' ? { ...DEF, seed } : DEF);
const built = async (m, state, intent, o = opts(m)) => {
  const r = await m.build(state, intent, P, o);
  if (!r.ok) return r;
  const k = checkAndApply(state, P, r.txs, { implicit: intent.implicit });
  return { ...r, kit: k, tx: inspectTx(r.txs[0].bytes) };
};
const inputsOf = (r) => r.txs[0].walletInputs;
const changeOf = (r, state) => r.tx.outputs.filter((o) => addressTextOf(o.address) === state.changeAddress);

test('tie order among equal values: CSL reverses the given order on its first pass, the Evolution SDK keeps it', { skip }, async () => {
  const csl = cslMethod(T, { strategy: 'lf' });
  const evo = evoMethod();
  const s = constructState(T, Array.from({ length: 10 }, (_, i) => ({ coin: 100n * ADA, txid: String(i + 1).padStart(64, '0') })));
  const ord = order(s);
  const pay = payIntent(T, [{ coin: 150n * ADA }]);
  const c = await built(csl, s, pay);
  const e = await built(evo, s, pay);
  assert.ok(c.kit.ok && e.kit.ok);
  assert.deepEqual(new Set(inputsOf(c)), new Set(ord.slice(-2)), 'CSL takes the last two given');
  assert.deepEqual(new Set(inputsOf(e)), new Set(ord.slice(0, 2)), 'Evolution takes the first two given');
});

test('CSL ties after an asset pass follow the order its swap_remove leaves, not the reverse of the given order', { skip }, async () => {
  // Five UTxOs of equal coin, the second (in state order) holding the only
  // unit of X. The asset pass takes it and swap_remove moves the last index
  // into its place, so the ADA pass walks [0, 4, 2, 3] from the end: 3, then 2.
  const X = { policy: policy('tie'), name: assetName('X'), qty: 1n };
  const specs = Array.from({ length: 5 }, (_, i) => ({ coin: 100n * ADA, txid: String(i + 1).padStart(64, '0'), assets: i === 1 ? [X] : [] }));
  const s = constructState(T, specs);
  const ord = order(s);
  assert.equal(s.utxos.get(ord[1]).assets.length, 1);
  const pay = payIntent(T, [{ coin: 250n * ADA, assets: [X] }]);
  const c = await built(cslMethod(T, { strategy: 'lf' }), s, pay);
  assert.ok(c.ok && c.kit.ok, c.detail);
  assert.deepEqual(new Set(inputsOf(c)), new Set([ord[1], ord[2], ord[3]]), 'the ADA pass takes 3 and 2');
  assert.notDeepEqual(new Set(inputsOf(c)), new Set([ord[1], ord[3], ord[4]]), 'not the reverse of the given order');
});

test('CSL largest-first counts each input\'s fee in its target', { skip }, async () => {
  // u0 alone covers the payment and the fee of a transaction without inputs,
  // but not the fee its own input adds, so CSL takes a second input.
  const s0 = constructState(T, [{ coin: 100n * ADA, txid: 'fee big' }, { coin: 5n * ADA, txid: 'fee small' }]);
  const C = T.CSL;
  const probe = payIntent(T, [{ coin: 1n * ADA }]);
  // The fee of the payment alone, as CSL's builder computes it.
  const { cslConfig } = await import('../../src/methods/csl.mjs');
  const free = [];
  const k = (o) => (free.push(o), o);
  const fee0 = (() => {
    const tb = k(C.TransactionBuilder.new(cslConfig(T, P, {}, { k })));
    tb.add_output(k(C.TransactionOutput.from_bytes(Buffer.from(probe.requested[0].cbor, 'hex'))));
    return BigInt(k(tb.min_fee()).to_str());
  })();
  for (const o of free.reverse()) o.free();
  const amount = 100n * ADA - fee0 - 1000n;
  const r = await built(cslMethod(T, { strategy: 'lf' }), s0, payIntent(T, [{ coin: amount }]));
  assert.ok(r.ok, r.detail);
  assert.equal(inputsOf(r).length, 2, 'the second input pays the first input\'s fee');
});

test('CSL\'s random multi-asset strategy never runs its improvement phase', { skip }, async () => {
  // 50 equal UTxOs of 10 ADA and a 50 ADA payment: random selection stops at
  // the first set covering the payment and the fees (6 UTxOs); an improvement
  // phase would grow it toward twice the payment.
  const s = constructState(T, Array.from({ length: 50 }, (_, i) => ({ coin: 10n * ADA, txid: `ri ${i}` })));
  const pay = payIntent(T, [{ coin: 50n * ADA }]);
  const ri = cslMethod(T, { strategy: 'ri' });
  const counts = new Set();
  const sets = new Set();
  for (let i = 0; i < 20; i++) {
    const r = await built(ri, s, pay);
    assert.ok(r.ok && r.kit.ok, r.detail);
    counts.add(inputsOf(r).length);
    sets.add(inputsOf(r).slice().sort().join(' '));
  }
  assert.deepEqual([...counts], [6]);
  assert.ok(sets.size > 1, 'the selection varies across runs');
});

test('CSL splits change only at the value-size limit, with a pure-ADA output only under prefer_pure_change; the Evolution SDK never splits (C13)', { skip }, async () => {
  const lf = cslMethod(T, { strategy: 'lf' });
  const pure = cslMethod(T, { strategy: 'lf', preferPureChange: true });
  const evo = evoMethod();
  const cjs = cjsMethod(T);
  const out = {};
  for (const k of [1, 2, 3, 4]) {
    const fx = surveyFixture(T, k, 'tokens');
    const r = { lf: await built(lf, fx.state, fx.intent), pure: await built(pure, fx.state, fx.intent), evo: await built(evo, fx.state, fx.intent), cjs: await built(cjs, fx.state, fx.intent) };
    out[k] = r;
    if (k <= 3) {
      const lfChange = changeOf(r.lf, fx.state);
      assert.ok(r.lf.kit.ok);
      assert.equal(lfChange.length, k, 'one token change output per near-cap input');
      assert.ok(lfChange.every((o) => o.assets.length && valueSize(o.coin, o.assets) <= P.maxValSize));
      const pc = changeOf(r.pure, fx.state);
      assert.equal(pc.filter((o) => !o.assets.length).length, 1, 'prefer_pure_change adds one pure-ADA output');
      assert.ok(r.cjs.kit.ok, 'cardano-js-sdk splits at the limit too');
      const ec = changeOf(r.evo, fx.state);
      assert.equal(ec.length, 1, 'Evolution: one change output');
      if (k === 1) assert.ok(r.evo.kit.ok);
      else {
        assert.equal(r.evo.kit.ok, false);
        assert.equal(r.evo.kit.failure.cls, CLASSES.valueSize, 'Evolution builds one change output over the limit, which the kit refuses');
      }
    }
  }
  // k = 3: about 94% of the size limit, with the change split in three.
  assert.ok(out[3].lf.tx.size > 0.9 * P.maxTxSize && out[3].lf.tx.size <= P.maxTxSize);
  // k = 4: unbuildable in one transaction by every library.
  assert.equal(out[4].lf.class, CLASSES.txSize);
  assert.equal(out[4].evo.class, CLASSES.txSize);
  assert.equal(out[4].cjs.class, CLASSES.maxInputs);
});

test('the Evolution SDK orders by lovelace alone and reaches a requested token only through that order', { skip }, async () => {
  const X = { policy: policy('evo'), name: assetName('X'), qty: 1n };
  const s = constructState(T, [{ coin: 1000n * ADA, txid: 'evo big' }, { coin: 3n * ADA, assets: [X], txid: 'evo token' }, { coin: 50n * ADA, txid: 'evo mid' }]);
  const big = [...s.utxos.values()].find((u) => u.coin === 1000n * ADA).ref;
  const mid = [...s.utxos.values()].find((u) => u.coin === 50n * ADA).ref;
  const pay = payIntent(T, [{ coin: 2n * ADA, assets: [X] }]);
  const e = await built(evoMethod(), s, pay);
  const c = await built(cslMethod(T, { strategy: 'lf' }), s, pay);
  assert.ok(e.ok && e.kit.ok && c.ok && c.kit.ok);
  assert.equal(inputsOf(e).length, 3, 'Evolution walks 1,000, then 50, then the token UTxO');
  assert.ok(inputsOf(e).includes(big) && inputsOf(e).includes(mid));
  assert.ok(!inputsOf(c).includes(mid), 'CSL\'s asset pass takes the token UTxO first');
});

test('the Evolution SDK\'s strategy names "random-improve" and "optimal" throw "not yet implemented"', { skip }, async () => {
  const s = constructState(T, [{ coin: 100n * ADA, txid: 'names' }]);
  for (const name of ['random-improve', 'optimal']) {
    const out = E.TxOut.fromCBORHex(payIntent(T, [{ coin: 2n * ADA }]).requested[0].cbor);
    // The resolver throws while the build runs, so the promise rejects rather
    // than resolving to a Left.
    let text;
    try {
      const r = await makeTxBuilder({ chain: E.mainnet }).payToAddress({ address: out.address, assets: out.assets }).buildEither({ changeAddress: E.Address.fromBech32(s.changeAddress), availableUtxos: [...s.utxos.values()].map(evoUtxo), protocolParameters: evoProtocolParameters(P), coinSelection: name });
      assert.equal(r._tag, 'Left');
      text = `${r.left.message} ${r.left.cause ? r.left.cause.message : ''}`;
    } catch (e) {
      text = String(e.message);
    }
    assert.match(text, new RegExp(`${name} algorithm not yet implemented`));
  }
});

test('cardano-js-sdk builds one change bundle per requested output', { skip }, async () => {
  const cjs = cjsMethod(T);
  // ADA payroll: ten outputs, change in ten bundles in proportion.
  const s = constructState(T, Array.from({ length: 3 }, (_, i) => ({ coin: 1000n * ADA, txid: `payroll ${i}` })));
  const ada = await built(cjs, s, payIntent(T, Array.from({ length: 10 }, () => ({ coin: 10n * ADA }))));
  assert.ok(ada.ok && ada.kit.ok, ada.detail);
  assert.equal(changeOf(ada, s).length, 10);
  // Token payroll: five outputs of 100 F from one UTxO of 1,000 F. Each bundle
  // gets the change times its output's quantity over the quantity selected
  // (change.ts:118-121), 500 * 100 / 1,000 = 50, and what that leaves, 250,
  // goes to the first bundle holding F (:191-201): 300, 50, 50, 50, 50.
  const F = { policy: policy('payroll'), name: assetName('F'), qty: 1000n };
  const s2 = constructState(T, [{ coin: 500n * ADA, assets: [F], txid: 'payroll F' }, { coin: 1000n * ADA, txid: 'payroll ada' }]);
  const tok = await built(cjs, s2, payIntent(T, Array.from({ length: 5 }, () => ({ coin: 2n * ADA, assets: [{ ...F, qty: 100n }] }))));
  assert.ok(tok.ok && tok.kit.ok, tok.detail);
  const tc = changeOf(tok, s2).filter((o) => o.assets.length);
  assert.equal(tc.length, 5);
  assert.deepEqual(tc.map((o) => o.assets[0].qty).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)), [50n, 50n, 50n, 50n, 300n]);
  // CSL returns the same 500 F in one change output.
  const c = await built(cslMethod(T, { strategy: 'lf' }), s2, payIntent(T, Array.from({ length: 5 }, () => ({ coin: 2n * ADA, assets: [{ ...F, qty: 100n }] }))));
  assert.equal(changeOf(c, s2).filter((o) => o.assets.length).length, 1);
});

test('one constructed failure per class per adapter', { skip, timeout: 30 * 60 * 1000 }, async (t) => {
  const adapters = [cslMethod(T, { strategy: 'lf' }), cslMethod(T, { strategy: 'ri' }), cjsMethod(T), evoMethod()];
  const seen = {};
  const note = (m, label, r) => {
    const cls = r.ok ? (r.kit.ok ? 'built' : `kit:${r.kit.failure.cls}`) : r.class;
    (seen[m.name] = seen[m.name] || {})[label] = cls;
    return cls;
  };
  // change-minimum: M7's ADA payment.
  const m7 = shapeState(T, 'M7').state;
  const m7pay = standardBattery(T, m7, P, { pools: SHAPE_POOLS }).find((x) => x.id === 'ada-payment');
  for (const m of adapters) assert.equal(note(m, 'M7 ada-payment', await built(m, m7, m7pay)), CLASSES.changeMinimum);
  // tx-size or max-inputs: M2's payrolls and its smallest H-10 payment.
  const m2 = shapeState(T, 'M2').state;
  const m2b = [...standardBattery(T, m2, P, { pools: SHAPE_POOLS }), ...h10Battery(T, m2, P)];
  for (const id of ['payroll-10', 'payroll-100', 'h10-0.25']) {
    const it = m2b.find((x) => x.id === id);
    for (const m of adapters) note(m, `M2 ${id}`, await built(m, m2, it));
  }
  for (const m of adapters) assert.ok(Object.entries(seen[m.name]).some(([l, c]) => l.startsWith('M2') && (c === CLASSES.txSize || c === CLASSES.maxInputs)), `${m.name}: a size or input-count failure on M2`);
  // value-size: C13 with two near-cap inputs (only a library that does not
  // split at the limit can reach it).
  const c13 = surveyFixture(T, 2, 'tokens');
  for (const m of adapters) note(m, 'C13 k=2', await built(m, c13.state, c13.intent));
  assert.equal(seen['evo-lf']['C13 k=2'], `kit:${CLASSES.valueSize}`);
  // balance: an empty wallet.
  const empty = makeState({ network: 'synthetic', stakeCred: m7.stakeCred, changeAddress: m7.changeAddress, utxos: [], at: { slot: 0, time: 0 } });
  const pay = payIntent(T, [{ coin: 5n * ADA }]);
  for (const m of adapters) assert.equal(note(m, 'empty wallet', await built(m, empty, pay)), CLASSES.balance);
  t.diagnostic(JSON.stringify(seen));
});

test('CSL pays a few bytes above the ledger minimum; cardano-js-sdk through the kit pays the minimum', { skip }, async () => {
  const s = constructState(T, [{ coin: 100n * ADA, txid: 'fee gap' }]);
  const pay = payIntent(T, [{ coin: 2n * ADA }]);
  const c = await built(cslMethod(T, { strategy: 'lf' }), s, pay);
  const j = await built(cjsMethod(T), s, pay);
  const e = await built(evoMethod(), s, pay);
  const gap = (r) => r.txs[0].fee - minFee(P, r.tx.size);
  assert.equal(gap(c), 5n * P.minFeeA, 'CSL: its fee field priced at 9 bytes and the validity flag');
  assert.equal(gap(e), 1n * P.minFeeA, 'Evolution: the validity flag');
  assert.equal(gap(j), 0n);
});
