// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Mesh's default builder as the study method mesh-rrri (methods/mesh.mjs):
// replayed spends with fixed parts, collateral, implicit values and output
// data under its own change and the layout change, each built transaction
// passing the kit's checks and its negative controls; Mesh's own
// serialization of what it writes against the kit's; its empty auxiliary data;
// its one summed output against cardano-js-sdk's per-output change; the same
// inputs under both changes; seeding; a change-minimum failure under the
// layout change; a refused change policy; and the one part it cannot replay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatment, skip } from '../../lib/treatment.mjs';
import { negativeControls, EXPECTED } from '../../lib/controls.mjs';
import { meshStudyMethod, MESH_EMPTY_AUX } from '../../../src/methods/mesh.mjs';
import { cjsMethod } from '../../../src/methods/cjs.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { NOT_REPLAYABLE } from '../../../src/methods/contract.mjs';
import { replay, fixedExtraWitnesses } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { checkAndApply, fixedResolver } from '../../../src/kit/apply.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { encodeOutput } from '../../../src/history/output.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { withoutLeftovers } from '../../../src/kit/replay.mjs';
import { decodeTx } from '../../../src/history/tx.mjs';
import { parseAddress, addressBytes } from '../../../src/history/address.mjs';
import { encUint, encArray, encMap } from '../../../src/history/cbor.mjs';
import { recipientAddress } from '../../../src/kit/recipients.mjs';
import { shapeState } from '../../../src/shapes/shapes.mjs';
import { constructState, payIntent, policy, assetName, ADA } from '../../lib/construct.mjs';
import { replayIntent, payTo } from '../../lib/script-intents.mjs';

const T = await treatment();
const P = SYNTHETIC_PARAMS;

// A replayed payment of the given outputs ({ coin, assets?, to? }).
const replayPay = (outputs, id = 'mesh') => ({ ...replayIntent(id, 10, { type: 'T1' }), requested: payIntent(T, outputs).requested.map((o) => ({ ...o, index: null, from: null, inflow: false })) });

// The engine's replay of `source` by mesh-rrri, each built transaction kept
// and each build's library record collected.
async function replayMesh(source, { rule = 'ledger', changePolicy = 'default', seed = 1 } = {}) {
  const m = makeMethod(T, 'mesh-rrri');
  const libs = [];
  const spy = { ...m, build: async (state, intent, params, opts) => {
    const r = await m.build(state, intent, params, opts);
    if (r.ok) libs.push({ intent, library: r.library, tx: r.txs[0] });
    return r;
  } };
  const r = await replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: seed, method: spy, opts: { seed, changePolicy, collateralRule: rule }, settleEvery: 25, keepTx: true, validity: true });
  return { ...r, libs };
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

const OUTCOMES = new Set(['built', 'failed', 'not-replayable', 'infeasible', 'infeasible-collateral', 'forfeit']);
function tally(r) {
  const o = {};
  for (const s of r.spends) {
    assert.ok(OUTCOMES.has(s.outcome), s.outcome);
    if (s.outcome === 'failed') assert.notEqual(s.class, CLASSES.other, `${s.type}: ${s.detail}`);
    const k = `${s.type}:${s.outcome}${s.class ? `:${s.class}` : ''}`;
    o[k] = (o[k] || 0) + 1;
  }
  return o;
}

const auxOf = (bytes) => {
  const tx = decodeTx(Buffer.from(bytes, 'hex'));
  return tx.aux ? Buffer.from(tx.aux.raw).toString('hex') : null;
};

test('mesh-rrri replays the synthetic streams\' script spends, certificates, mints and fixed inputs under its own change and the layout change', { skip, timeout: 5 * 60 * 1000 }, async (t) => {
  const seen = {};
  for (const name of ['S1', 'S7', 'S8', 'M1', 'M7']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    for (const rule of ['ledger', 'token-bearing']) {
      for (const changePolicy of ['default', 'layout']) {
        const r = await replayMesh(source, { rule, changePolicy });
        const o = tally(r);
        seen[`${name} ${rule} ${changePolicy}`] = o;
        assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.failures));
        assert.deepEqual(controlsOf(source, r), []);
        for (const { intent, library, tx } of r.libs) {
          const d = inspectTx(tx.bytes);
          const ins = new Set(d.inputs.map((x) => x.ref));
          // Every fixed input is in the transaction and was Mesh's
          // preselected input; none is among the wallet inputs.
          for (const x of intent.fixed ? intent.fixed.inputs : []) {
            assert.ok(ins.has(x.ref), `${intent.type}: fixed input missing`);
            assert.ok(!tx.walletInputs.includes(x.ref));
          }
          assert.equal(library.preselected, intent.fixed ? intent.fixed.inputs.length : 0);
          if (intent.collateral.required) assert.equal(d.collateralInputs.length, 1);
          // Mesh's auxiliary data under its own change, where the intent has
          // none of its own; under the layout change only the intent's.
          const own = intent.fixed && intent.fixed.auxiliaryData;
          if (changePolicy === 'default') {
            assert.equal(auxOf(tx.bytes), own || MESH_EMPTY_AUX, intent.type);
            // The library's fee is the final transaction's minimum: its
            // callbacks priced what the kit wrote.
            assert.equal(library.fee, library.finalMinFee, intent.type);
          } else {
            assert.equal(auxOf(tx.bytes), own || null, intent.type);
          }
        }
        if (changePolicy === 'default') for (const type of ['T6', 'T7', 'T8']) assert.ok(o[`${type}:built`] >= 1, `${name} ${rule}: no ${type} built`);
      }
    }
  }
  t.diagnostic(JSON.stringify(seen));
});

test('Mesh\'s own serialization of the parts it writes is the kit\'s, but for the witnesses', { skip }, async () => {
  let compared = 0;
  for (const name of ['S1', 'S6', 'M1', 'CL1']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const r = await replayMesh(source);
    for (const { intent, library, tx } of r.libs) {
      if (intent.fixed) continue;
      const mesh = decodeTx(Buffer.from(library.meshTx, 'hex'));
      const kit = decodeTx(Buffer.from(tx.bytes, 'hex'));
      // The body, field for field, and the auxiliary data; Mesh's unsigned
      // transaction has no witnesses, the kit's its synthetic ones.
      assert.deepEqual(mesh.body.order, kit.body.order, intent.type);
      for (const k of mesh.body.order) assert.ok(mesh.body.fields.get(k).raw.equals(kit.body.fields.get(k).raw), `${name} ${intent.type} field ${k}`);
      assert.ok(mesh.body.raw.equals(kit.body.raw));
      assert.ok(mesh.aux.raw.equals(kit.aux.raw));
      assert.equal(mesh.wits.order.length, 0);
      compared++;
    }
  }
  assert.ok(compared >= 20, `${compared} spends compared`);
});

test('Mesh sums the requested outputs into one before selecting, so it writes one change where cardano-js-sdk writes one per output', { skip }, async () => {
  const s = constructState(T, Array.from({ length: 12 }, (_, i) => ({ coin: BigInt(20 + i) * ADA })));
  const it = replayPay([{ coin: 30n * ADA }, { coin: 25n * ADA }]);
  const opts = { changePolicy: 'default', seed: 4 };
  const mesh = await meshStudyMethod(T).build(s, it, P, opts);
  const cjs = await cjsMethod(T).build(s, it, P, opts);
  assert.equal(mesh.ok, true, mesh.detail);
  assert.equal(cjs.ok, true, cjs.detail);
  // The builder hands its selector both outputs; the selector sums them.
  assert.equal(mesh.library.outputs, 2);
  assert.equal(mesh.library.change, 1);
  assert.equal(cjs.library.change, 2);
  for (const r of [mesh, cjs]) assert.equal(checkAndApply(s, P, r.txs).ok, true);
  // With one requested output the two run the same code on the same draws:
  // the same inputs and the same change outputs, Mesh's fee higher by its
  // auxiliary data's 38 bytes.
  const one = replayPay([{ coin: 30n * ADA }]);
  const m1 = await meshStudyMethod(T).build(s, one, P, opts);
  const c1 = await cjsMethod(T).build(s, one, P, opts);
  assert.deepEqual(m1.txs[0].walletInputs, c1.txs[0].walletInputs);
  assert.equal(m1.txs[0].size - c1.txs[0].size, 38);
  assert.equal(m1.txs[0].fee - c1.txs[0].fee, 38n * P.minFeeA);
  assert.equal(inspectTx(m1.txs[0].bytes).outputs.length, inspectTx(c1.txs[0].bytes).outputs.length);
});

test('L/own and L/layout select the same inputs on the same state and seed, and differ only in the change', { skip }, async () => {
  const state = shapeState(T, 'S6').state;
  const tokens = [];
  for (const u of state.utxos.values()) for (const a of u.assets) if (tokens.length < 1 && u.held === null) tokens.push({ ...a, qty: 1n });
  const it = replayPay([{ coin: 40n * ADA }, { coin: 2n * ADA, assets: tokens }]);
  const m = meshStudyMethod(T);
  let differs = 0;
  for (let seed = 1; seed <= 5; seed++) {
    const a = await m.build(state, it, P, { changePolicy: 'default', seed });
    const b = await m.build(state, it, P, { changePolicy: 'layout', seed });
    assert.equal(a.ok, true, a.detail);
    assert.equal(b.ok, true, b.detail);
    assert.deepEqual(b.txs[0].walletInputs, a.txs[0].walletInputs, `seed ${seed}`);
    assert.equal(b.library.draws, a.library.draws);
    for (const r of [a, b]) {
      const applied = checkAndApply(state, P, r.txs);
      assert.equal(applied.ok, true, applied.failure && applied.failure.detail);
    }
    if (a.txs[0].bytes !== b.txs[0].bytes) differs++;
  }
  assert.equal(differs, 5);
});

test('seeded: the same seed gives the same bytes, other seeds can differ, and the draws go through Math.random for one build only', { skip }, async () => {
  const state = shapeState(T, 'S6').state;
  const it = replayPay([{ coin: 60n * ADA }]);
  const m = makeMethod(T, 'mesh-rrri');
  assert.deepEqual([m.deterministic, m.seeded], [false, true]);
  const before = Math.random;
  const bytes = [];
  for (const seed of [1, 1, 2, 3, 4, 5, 6]) {
    const r = await m.build(state, it, P, { changePolicy: 'default', seed });
    assert.equal(r.ok, true, r.detail);
    assert.ok(r.library.draws > 0);
    bytes.push(r.txs[0].bytes);
  }
  assert.equal(Math.random, before);
  assert.equal(bytes[0], bytes[1]);
  assert.ok(new Set(bytes).size > 1);
  // A replay's own generator, when given, is the one drawn from.
  let n = 0;
  const r = await m.build(state, it, P, { changePolicy: 'default', seed: 1, random: () => { n++; return 0.5; } });
  assert.equal(r.ok, true);
  assert.equal(n, r.library.draws);
  await assert.rejects(m.build(state, it, P, { changePolicy: 'default' }), /a seed is required/);
});

test('inputs that cannot fund the layout change fail with change-minimum while Mesh builds its own', { skip }, async () => {
  // One UTxO of 10 ADA holding 40 policies: Mesh's one change output fits;
  // the layout change, with its outputs at their minimum, does not.
  const s = constructState(T, [{ coin: 10n * ADA, assets: Array.from({ length: 40 }, (_, i) => ({ policy: policy(`q${i}`), name: assetName('t'), qty: 1n })) }]);
  const it = replayPay([{ coin: 2n * ADA }]);
  const m = meshStudyMethod(T);
  const a = await m.build(s, it, P, { changePolicy: 'default', seed: 1 });
  assert.equal(a.ok, true, a.detail);
  const b = await m.build(s, it, P, { changePolicy: 'layout', seed: 1 });
  assert.equal(b.ok, false);
  assert.equal(b.class, CLASSES.changeMinimum);
  assert.match(b.detail, /^layout change on the library's inputs: /);
  // A library failure is the library's under either change.
  const short = replayPay([{ coin: 50n * ADA }]);
  const c = await m.build(s, short, P, { changePolicy: 'default', seed: 1 });
  const d = await m.build(s, short, P, { changePolicy: 'layout', seed: 1 });
  assert.equal(c.class, CLASSES.balance);
  assert.deepEqual([d.class, d.detail], [c.class, c.detail]);
});

test('a change policy other than default and layout is refused, and only what the kit cannot write is not replayable', { skip }, async () => {
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const m = meshStudyMethod(T);
  const r = await m.build(s, replayPay([{ coin: 3n * ADA }]), P, { changePolicy: 'ladder', seed: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.class, CLASSES.other);
  assert.match(r.detail, /its own change or the layout change only/);
  // Body field 6 (protocol parameter updates): under either change.
  const it = replayIntent('m6', 10, { type: 'T7', requested: [payTo(T, 2, 2n * ADA)], fixed: { body: { 6: encArray([encMap([]), encUint(0)]).toString('hex') } } });
  for (const changePolicy of ['default', 'layout']) {
    const x = await m.build(s, withoutLeftovers(it), P, { changePolicy, seed: 1 });
    assert.equal(x.class, NOT_REPLAYABLE, changePolicy);
    assert.match(x.detail, /body field 6/);
  }
  // A battery intent is not a replayed one.
  await assert.rejects(m.build(s, payIntent(T, [{ coin: 3n * ADA }]), P, { changePolicy: 'default', seed: 1 }), /builds replayed intents only/);
});

test('a requested output\'s own bytes pass through: a payment to a recipient with an inline datum', { skip }, async () => {
  const s = constructState(T, [{ coin: 20n * ADA }, { coin: 9n * ADA }]);
  const address = recipientAddress('synthetic', 301);
  const datum = { kind: 'inline', cbor: 'd87980' };
  const cbor = encodeOutput({ address: addressBytes(address), coin: 3n * ADA, assets: [], datum }, 'map').toString('hex');
  const it = { ...replayPay([{ coin: 3n * ADA }]), requested: [payTo(T, 1, 3n * ADA, { cbor, address, datum })] };
  for (const changePolicy of ['default', 'layout']) {
    const r = await meshStudyMethod(T).build(s, it, P, { changePolicy, seed: 1 });
    assert.equal(r.ok, true, r.detail);
    assert.equal(inspectTx(r.txs[0].bytes).outputs[0].raw.toString('hex'), cbor);
  }
});
