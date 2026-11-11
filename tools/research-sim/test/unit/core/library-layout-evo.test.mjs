// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Evolution SDK with UnFrack.It's layout change (opts.changePolicy
// 'layout'): the library selects its inputs and its collateral as for its own
// change, and the simulator builds the layout change on them. L/own and
// L/layout select the same inputs on the same state and differ only in the
// change; a library failure is the library's; an input set that cannot fund
// the layout change fails with class change-minimum; 'single' and 'naive' stay
// refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatment, skip } from '../../lib/treatment.mjs';
import { negativeControls, EXPECTED } from '../../lib/controls.mjs';
import { evoMethod, buildEvo } from '../../../src/methods/evo.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { checkAndApply, fixedResolver } from '../../../src/kit/apply.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { replay, fixedExtraWitnesses } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { constructState, payIntent, policy, assetName, ADA } from '../../lib/construct.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { parseAddress, addressBytes } from '../../../src/history/address.mjs';
import { recipientAddress } from '../../../src/battery/recipients.mjs';
import { shapeState } from '../../../src/shapes/shapes.mjs';
import { encUint, encBytes, encArray, encMap } from '../../../src/history/cbor.mjs';
import { withoutLeftovers } from '../../../src/kit/replay.mjs';
import { replayIntent, payTo as payToOf } from '../../lib/script-intents.mjs';

const T = await treatment();
const P = SYNTHETIC_PARAMS;
const own = { changePolicy: 'default', seed: 1 };
const layout = { changePolicy: 'layout', seed: 1 };

test('evo-lf takes the treatment from the registry, and without it refuses the layout change', { skip }, async () => {
  const m = makeMethod(T, 'evo-lf');
  const s = constructState(T, [{ coin: 20n * ADA }, { coin: 8n * ADA }]);
  const it = payIntent(T, [{ coin: 3n * ADA }]);
  assert.equal((await m.build(s, it, P, layout)).ok, true);
  await assert.rejects(evoMethod().build(s, it, P, layout), /layout change needs the treatment/);
});

test('single and naive stay refused, as a failure of class other with the reason', { skip }, async () => {
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const it = payIntent(T, [{ coin: 3n * ADA }]);
  for (const changePolicy of ['single', 'naive']) {
    const r = await evoMethod({ T }).build(s, it, P, { changePolicy, seed: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.class, CLASSES.other);
    assert.match(r.detail, /its own change or the layout change only/);
  }
});

// Tokens: one unit each of `n` policies, spread over UTxOs.
const tokenSpecs = (n, perUtxo, coin) => {
  const specs = [];
  for (let i = 0; i < n; i += perUtxo) specs.push({ coin, assets: Array.from({ length: Math.min(perUtxo, n - i) }, (_, j) => ({ policy: policy(`p${i + j}`), name: assetName('t'), qty: 1n })) });
  return specs;
};

test('a battery spend: the same inputs under both changes, and the layout transaction passes the kit', { skip }, async () => {
  const s = constructState(T, [...tokenSpecs(12, 4, 5n * ADA), { coin: 40n * ADA, assets: tokenSpecs(12, 12, 0n)[0].assets }, { coin: 15n * ADA }]);
  const it = payIntent(T, [{ coin: 6n * ADA }]);
  const a = await buildEvo(s, it, P, own, { T });
  const b = await buildEvo(s, it, P, layout, { T });
  assert.equal(a.ok, true, a.detail);
  assert.equal(b.ok, true, b.detail);
  assert.deepEqual(b.txs[0].walletInputs, a.txs[0].walletInputs);
  const oa = inspectTx(a.txs[0].bytes).outputs;
  const ob = inspectTx(b.txs[0].bytes).outputs;
  // The library's change is one output; the layout change is one per policy
  // group plus the ADA.
  assert.notDeepEqual(ob.map((o) => o.assets.length), oa.map((o) => o.assets.length));
  assert.ok(ob.length > oa.length);
  for (const r of [a, b]) {
    const applied = checkAndApply(s, P, r.txs);
    assert.equal(applied.ok, true, applied.failure && applied.failure.detail);
  }
  assert.equal(inspectTx(b.txs[0].bytes).collateralInputs.length, 0);
});

test('inputs that cannot fund the layout change fail with change-minimum while the library builds its own', { skip }, async () => {
  // One UTxO of 10 ADA holding 40 policies: the library's single change output
  // fits; the layout change, with its outputs at their minimum, does not.
  const s = constructState(T, [{ coin: 10n * ADA, assets: Array.from({ length: 40 }, (_, i) => ({ policy: policy(`q${i}`), name: assetName('t'), qty: 1n })) }]);
  const it = payIntent(T, [{ coin: 2n * ADA }]);
  const a = await buildEvo(s, it, P, own, { T });
  assert.equal(a.ok, true, a.detail);
  const b = await buildEvo(s, it, P, layout, { T });
  assert.equal(b.ok, false);
  assert.equal(b.class, CLASSES.changeMinimum);
  assert.match(b.detail, /^layout change on the library's inputs: /);
});

test('a library failure under the layout change is the library\'s, as under its own', { skip }, async () => {
  const s = constructState(T, [{ coin: 3n * ADA }]);
  const it = payIntent(T, [{ coin: 50n * ADA }]);
  const a = await buildEvo(s, it, P, own, { T });
  const b = await buildEvo(s, it, P, layout, { T });
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(b.class, a.class);
  assert.equal(b.detail, a.detail);
});

// The engine's replay of `source` by evo-lf under a change policy, with each
// spend's built transaction kept.
async function replayEvo(source, changePolicy, rule = 'ledger') {
  return replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: evoMethod({ T }), opts: { seed: 1, changePolicy, collateralRule: rule }, settleEvery: 25, keepTx: true });
}

function controlsOf(source, r) {
  const intents = source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
  const bad = [];
  for (const s of r.spends) {
    if (s.outcome !== 'built') continue;
    const it = intents[s.intent];
    const fixed = fixedResolver(it.fixed);
    const view = (u) => u && { coin: u.coin, assets: u.assets, addr: parseAddress(addressBytes(u.address)) };
    const resolve = (ref) => view(s.built.before.utxos.get(ref)) || fixed.get(ref);
    for (const t of s.built.txs) {
      const c = negativeControls(s.built.before, source.params, t.bytes, { resolve, implicit: it.implicit, scriptFee: it.fixed ? it.fixed.scriptFee : 0n, extraWitnesses: fixedExtraWitnesses(it) });
      if (Object.entries(EXPECTED).some(([k, v]) => c[k] !== v)) bad.push({ type: s.type, c });
    }
  }
  return bad;
}

// Each spend the layout arm built is rebuilt under the library's own change on
// the state the layout arm built it from: same inputs, same collateral.
test('replayed synthetic streams: fixed parts and the library\'s collateral under the layout change, the same inputs and the same collateral as under its own', { skip, timeout: 10 * 60 * 1000 }, async (t) => {
  const seen = {};
  for (const name of ['S1', 'S8', 'M7']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const b = await replayEvo(source, 'layout');
    assert.deepEqual(controlsOf(source, b), []);
    assert.equal(b.refused, undefined);
    const intents = source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
    let built = 0;
    let scripts = 0;
    for (const sb of b.spends) {
      assert.notEqual(sb.class, CLASSES.other, `${name} ${sb.type}: ${sb.detail}`);
      if (sb.outcome !== 'built') continue;
      built++;
      const intent = intents[sb.intent];
      const tx = inspectTx(sb.built.txs[0].bytes);
      for (const x of intent.fixed ? intent.fixed.inputs : []) assert.ok(tx.inputs.some((y) => y.ref === x.ref), `${sb.type}: fixed input missing`);
      const a = await buildEvo(sb.built.before, withoutLeftovers(intent), source.params, own, { T });
      assert.equal(a.ok, true, `${name} ${sb.type}: ${a.detail}`);
      assert.deepEqual(sb.built.txs[0].walletInputs, a.txs[0].walletInputs, `${name} ${sb.type}: inputs`);
      const ta = inspectTx(a.txs[0].bytes);
      assert.deepEqual(tx.collateralInputs.map((x) => x.ref), ta.collateralInputs.map((x) => x.ref), `${name} ${sb.type}: collateral inputs`);
      assert.equal(tx.totalCollateral, ta.totalCollateral);
      assert.deepEqual(tx.collateralReturn && tx.collateralReturn.raw, ta.collateralReturn && ta.collateralReturn.raw);
      if (intent.collateral.required) {
        scripts++;
        assert.ok(tx.collateralInputs.length >= 1);
        assert.equal(sb.collateralUsed.chosen, 'library');
      } else assert.equal(tx.collateralInputs.length, 0);
    }
    seen[name] = { built, scripts };
    assert.ok(built >= 1);
  }
  assert.ok(Object.values(seen).some((x) => x.scripts > 0), JSON.stringify(seen));
  t.diagnostic(JSON.stringify(seen));
});

test('a replayed spend with a required signer, a Conway certificate and a donation build under the layout change on the library\'s inputs', { skip }, async () => {
  const shape = shapeState(T, 'S8');
  const state = shape.state;
  const payTo = (i, coin) => payToOf(T, i, coin);
  const stakeCred = encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))]);
  const walletKey = [...state.utxos.values()].find((u) => u.held === null).cred;
  const pool = encBytes(Buffer.alloc(28, 0x50));
  const stakeKey = Buffer.alloc(32, 0x73);
  const witness = (k) => encArray([encArray([encBytes(k), encBytes(Buffer.alloc(64, 0x77))])]).toString('hex');
  const intents = [
    replayIntent('d1', 10, { type: 'T5', requested: [payTo(0, 3n * ADA)], fixed: { body: { 14: encArray([encBytes(Buffer.from(walletKey, 'hex'))]).toString('hex') } } }),
    replayIntent('d2', 20, { type: 'T7', fixed: { body: { 4: encArray([encArray([encUint(7), stakeCred, encUint(P.keyDeposit)]), encArray([encUint(2), stakeCred, pool])]).toString('hex') }, witnesses: { 0: witness(stakeKey) } }, implicit: { deposits: P.keyDeposit } }),
    replayIntent('d3', 30, { type: 'T1', requested: [payTo(1, 3n * ADA)], fixed: { body: { 22: encUint(ADA).toString('hex') } }, implicit: { donation: ADA } })
  ];
  const source = { wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: state.stakeCred, changeAddress: state.changeAddress, changeAddressEnd: state.changeAddress, franken: new Set(), start: [...state.utxos.values()], events: intents.map((intent, i) => ({ kind: 'intent', txId: i + 1, intent })), arrival: new Map(), windowStart: 0, windowEnd: 1000, params: P };
  const b = await replayEvo(source, 'layout');
  assert.deepEqual(controlsOf(source, b), []);
  for (const s of b.spends) assert.equal(s.outcome, 'built', `${s.type}: ${s.class} ${s.detail}`);
  // The donation is written by the kit's assembly, priced and balanced.
  assert.equal(inspectTx(b.spends[2].built.txs[0].bytes).donation, ADA);
});
