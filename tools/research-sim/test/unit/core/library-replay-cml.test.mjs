// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Cardano Multiplatform Lib's two strategies as the study methods cml-lf and
// cml-ri (methods/cml.mjs): the synthetic streams' replayed spends (fixed
// inputs, a Plutus spend with its collateral, certificates, mints) under its
// own change and the layout change, each built transaction passing the kit's
// checks and its negative controls; constructed spends for a Plutus spend
// with its datum, a Plutus mint by reference script, a burn, a deregistration
// with a withdrawal and a donation; the same inputs under both changes and
// the same bytes on every build; a change-minimum failure under the layout
// change; RandomImproveMultiAsset's passes, which do not count an input an
// earlier pass took; a refused change policy; the parts it cannot replay; and
// the reference input on which CML aborts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatment, skip } from '../../lib/treatment.mjs';
import { negativeControls, EXPECTED } from '../../lib/controls.mjs';
import { cmlMethod, classOfCmlError, CML_VERSION } from '../../../src/methods/cml.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { REPLAY_PARTS, REPLAY_COVERAGE } from '../../../src/methods/library.mjs';
import { NOT_REPLAYABLE } from '../../../src/methods/contract.mjs';
import { replay, fixedExtraWitnesses } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { checkAndApply, fixedResolver } from '../../../src/kit/apply.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { outputBytes } from '../../../src/kit/assemble.mjs';
import { executionFee, refScriptFee } from '../../../src/kit/fee.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { withoutLeftovers } from '../../../src/kit/replay.mjs';
import { parseAddress, addressBytes } from '../../../src/history/address.mjs';
import { encUint, encInt, encBytes, encArray, encMap } from '../../../src/history/cbor.mjs';
import { encodeOutput, unspentOutput } from '../../../src/history/output.mjs';
import { blake2b224, blake2b256 } from '../../../src/history/blake2b.mjs';
import { addressTextOf, utxoFromOutput } from '../../../src/state/utxo.mjs';
import { recipientAddress } from '../../../src/kit/recipients.mjs';
import { shapeState } from '../../../src/shapes/shapes.mjs';
import { constructState, payIntent, policy, assetName, ADA } from '../../lib/construct.mjs';
import { replayIntent, payTo } from '../../lib/script-intents.mjs';

const T = await treatment();
const P = SYNTHETIC_PARAMS;

// A replayed payment of the given outputs ({ coin, assets? }).
const replayPay = (outputs, id = 'cml') => ({ ...replayIntent(id, 10, { type: 'T1' }), requested: payIntent(T, outputs).requested.map((o) => ({ ...o, datum: null, scriptRef: null, raised: null, wallet: false, scriptPayment: false, index: null, from: null, inflow: false })) });

// The engine's replay of `source` by one CML method, each built transaction
// kept with its library record.
async function replayCml(source, { name, rule = 'ledger', changePolicy = 'default' }) {
  const m = makeMethod(T, name);
  const libs = [];
  const spy = { ...m, build: (state, intent, params, opts) => {
    const r = m.build(state, intent, params, opts);
    if (r.ok) libs.push({ intent, library: r.library, tx: r.txs[0] });
    return r;
  } };
  const r = await replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: spy, opts: { seed: 1, changePolicy, collateralRule: rule }, settleEvery: 25, keepTx: true, validity: true });
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
      // A spend with no requested output can have none at all when CML burns
      // an ADA-only leftover under the change minimum into the fee; the fee
      // and value controls need an output.
      if (!inspectTx(t.bytes).outputs.length) continue;
      const c = negativeControls(s.built.before, source.params, t.bytes, { resolve, implicit: it.implicit, scriptFee: it.fixed ? it.fixed.scriptFee : 0n, extraWitnesses: fixedExtraWitnesses(it) });
      if (Object.entries(EXPECTED).some(([k, v]) => c[k] !== v)) bad.push({ type: s.type, c });
    }
  }
  return bad;
}

const OUTCOMES = new Set(['built', 'failed', 'not-replayable', 'infeasible', 'infeasible-collateral', 'forfeit']);
function tally(r, name) {
  const o = {};
  for (const s of r.spends) {
    assert.ok(OUTCOMES.has(s.outcome), s.outcome);
    if (s.outcome === 'failed') assert.notEqual(s.class, CLASSES.other, `${name} ${s.type}: ${s.detail}`);
    const k = `${s.type}:${s.outcome}${s.class && s.outcome !== 'not-replayable' ? `:${s.class}` : ''}`;
    o[k] = (o[k] || 0) + 1;
  }
  return o;
}

test('CML covers every replay part and both methods are registered with their strategy, determinism and seeding', { skip }, () => {
  assert.deepEqual(REPLAY_COVERAGE.cml, REPLAY_PARTS);
  assert.equal(CML_VERSION, '6.2.0');
  const lf = makeMethod(T, 'cml-lf');
  const ri = makeMethod(T, 'cml-ri');
  assert.equal(lf.version, '@dcspark/cardano-multiplatform-lib-nodejs 6.2.0 LargestFirstMultiAsset');
  assert.equal(ri.version, '@dcspark/cardano-multiplatform-lib-nodejs 6.2.0 RandomImproveMultiAsset');
  assert.deepEqual([lf.deterministic, lf.seeded], [true, true]);
  assert.deepEqual([ri.deterministic, ri.seeded], [false, false]);
  assert.throws(() => cmlMethod(T, { strategy: 'rrri' }), /unknown strategy/);
  assert.equal(classOfCmlError('Not enough ADA leftover to include non-ADA assets in a change address'), CLASSES.changeMinimum);
  assert.equal(classOfCmlError('UTxO Balance Insufficient. Inputs: Value { coin: 0 }'), CLASSES.balance);
  assert.equal(classOfCmlError('Missing input or output (possibly some native asset)'), CLASSES.balance);
  assert.equal(classOfCmlError('Asset arithmetic: PolicyId ScriptHash([48, 239]) doesn\'t exist'), CLASSES.balance);
  assert.equal(classOfCmlError('Max transaction size of 16384 exceeded. Found: 16390'), CLASSES.txSize);
  assert.equal(classOfCmlError('Max value size of 5000 exceeded. Found: 5004'), CLASSES.valueSize);
  assert.equal(classOfCmlError('NFTs too large for change output'), CLASSES.valueSize);
  assert.equal(classOfCmlError('Max collateral input count 3 exceeded'), CLASSES.collateral);
  assert.equal(classOfCmlError('Reference Script hash not found'), CLASSES.other);
});

test('cml-lf and cml-ri replay the synthetic streams\' script spends, certificates, mints and fixed inputs under their own change and the layout change', { skip, timeout: 5 * 60 * 1000 }, async (t) => {
  const seen = {};
  for (const name of ['S1', 'S7', 'S8', 'M1', 'M7']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    for (const method of ['cml-lf', 'cml-ri']) {
      for (const rule of ['ledger', 'token-bearing']) {
        for (const changePolicy of ['default', 'layout']) {
          const r = await replayCml(source, { name: method, rule, changePolicy });
          const o = tally(r, method);
          seen[`${name} ${method} ${rule} ${changePolicy}`] = o;
          assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.failures));
          assert.deepEqual(controlsOf(source, r), []);
          assert.deepEqual(r.spends.filter((s) => s.outcome === 'not-replayable').map((s) => `${s.type}: ${s.detail}`), []);
          for (const { intent, library, tx } of r.libs) {
            const d = inspectTx(tx.bytes);
            const ins = new Set(d.inputs.map((x) => x.ref));
            // Every fixed input is in the transaction and none is among the
            // wallet inputs; a script spend's collateral is the UTxO set
            // aside, never an input.
            for (const x of intent.fixed ? intent.fixed.inputs : []) {
              assert.ok(ins.has(x.ref), `${intent.type}: fixed input missing`);
              assert.ok(!tx.walletInputs.includes(x.ref));
            }
            if (intent.collateral.required) {
              assert.equal(d.collateralInputs.length, 1);
              assert.ok(!ins.has(d.collateralInputs[0].ref));
            } else assert.equal(d.collateralInputs.length, 0);
            // CML prices what it writes: its fee covers the final minimum.
            if (changePolicy === 'default') assert.ok(library.fee >= library.finalMinFee, `${intent.type}: ${library.fee} under ${library.finalMinFee}`);
          }
          if (method === 'cml-lf') for (const type of ['T6', 'T7', 'T8']) assert.ok(o[`${type}:built`] >= 1, `${name} ${rule} ${changePolicy}: no ${type} built`);
        }
      }
    }
  }
  t.diagnostic(JSON.stringify(seen));
});

const hash32 = (s) => blake2b256(Buffer.from(s)).toString('hex');
const requestedOf = (address, bytes, coin, assets, extra = {}) => ({ cbor: Buffer.from(bytes).toString('hex'), address, coin, assets, datum: null, scriptRef: null, raised: null, wallet: false, scriptPayment: false, index: null, from: null, inflow: false, ...extra });

test('CML replays a Plutus spend with its datum, a Plutus mint by reference script, a burn, a deregistration with a withdrawal and a donation, and refuses as not replayable what it cannot express', { skip, timeout: 5 * 60 * 1000 }, async (t) => {
  const state = shapeState(T, 'S8').state;
  const PR = { ...P, minFeeRefScriptCostPerByte: [15, 1] };
  const net = addressBytes(state.changeAddress)[0] & 15;
  const keyWitness = (k) => encArray([encBytes(k), encBytes(Buffer.alloc(64, 0x77))]);
  const witnesses = (...ks) => encArray(ks.map(keyWitness)).toString('hex');
  // A Plutus V2 spend: the script in the witness set, the input's datum by
  // hash, a redeemer at observed execution units, the payment back to the
  // script with an inline datum.
  const script = Buffer.alloc(300, 0x4d);
  const scriptHash = blake2b224(Buffer.concat([Buffer.from([2]), script]));
  const scriptAddr = Buffer.concat([Buffer.from([0x70 | net]), scriptHash]);
  const datum = Buffer.from('d87980', 'hex');
  const scriptTx = hash32('cml script input');
  const scriptIn = { ref: `${scriptTx}#0`, cbor: unspentOutput(scriptTx, 0, encodeOutput({ address: scriptAddr, coin: 10n * ADA, assets: [], datum: { kind: 'hash', hash: blake2b256(datum).toString('hex') } }, 'array')).toString('hex') };
  const back = encodeOutput({ address: scriptAddr, coin: 12n * ADA, assets: [], datum: { kind: 'inline', cbor: 'd87980' } }, 'map');
  const spendUnits = [200000n, 80000000n];
  const t6 = replayIntent('c1', 10, {
    type: 'T6',
    requested: [requestedOf(addressTextOf(scriptAddr), back, 12n * ADA, [], { datum: { kind: 'inline', cbor: 'd87980' }, scriptPayment: true })],
    fixed: {
      inputs: [scriptIn],
      witnesses: {
        4: encArray([datum]).toString('hex'),
        5: encArray([encArray([encUint(0), encUint(0), datum, encArray([encUint(spendUnits[0]), encUint(spendUnits[1])])])]).toString('hex'),
        6: encArray([encBytes(script)]).toString('hex')
      },
      redeemers: [{ tag: 0, target: { kind: 'input', ref: scriptIn.ref }, data: 'd87980', exUnits: spendUnits }],
      scriptFee: executionFee(PR, spendUnits[0], spendUnits[1])
    },
    collateral: true
  });
  // A Plutus V2 mint whose policy script is a reference script in a
  // reference input, into the wallet.
  const policyScript = Buffer.alloc(500, 0x5a);
  const mintPolicy = blake2b224(Buffer.concat([Buffer.from([2]), policyScript])).toString('hex');
  const refTx = hash32('cml reference script');
  const refOut = encodeOutput({ address: addressBytes(recipientAddress('synthetic', 450)), coin: 20n * ADA, assets: [], scriptRef: { lang: 2, script: policyScript.toString('hex') } }, 'map');
  const refIn = { ref: `${refTx}#0`, cbor: unspentOutput(refTx, 0, refOut).toString('hex') };
  const minted = [{ policy: mintPolicy, name: '4d', qty: 5n }];
  const mintUnits = [100000n, 40000000n];
  let coin = 0n;
  let mintOut;
  for (let i = 0; i < 4; i++) {
    mintOut = outputBytes(T, { address: state.changeAddress, coin, assets: minted });
    coin = PR.coinsPerUtxoByte * (160n + BigInt(mintOut.length));
  }
  mintOut = outputBytes(T, { address: state.changeAddress, coin, assets: minted });
  const t8mint = replayIntent('c2', 20, {
    type: 'T8',
    requested: [requestedOf(state.changeAddress, mintOut, coin, minted, { wallet: true, inflow: true })],
    fixed: {
      referenceInputs: [refIn],
      body: { 9: encMap([[encBytes(Buffer.from(mintPolicy, 'hex')), encMap([[encBytes(Buffer.from('4d', 'hex')), encUint(5)]])]]).toString('hex') },
      witnesses: { 5: encArray([encArray([encUint(1), encUint(0), datum, encArray([encUint(mintUnits[0]), encUint(mintUnits[1])])])]).toString('hex') },
      redeemers: [{ tag: 1, target: { kind: 'policy', policy: mintPolicy }, data: 'd87980', exUnits: mintUnits }],
      scriptFee: executionFee(PR, mintUnits[0], mintUnits[1]) + refScriptFee(PR, policyScript.length),
      refScriptBytes: policyScript.length
    },
    implicit: { mint: minted },
    collateral: true
  });
  // A burn of one unit of a token the wallet holds under a native policy,
  // with the policy key's witness.
  const mintKey = Buffer.alloc(32, 0x6b);
  const nativeScript = encArray([encUint(0), encBytes(blake2b224(mintKey))]);
  const burnPolicy = blake2b224(Buffer.concat([Buffer.from([0]), nativeScript])).toString('hex');
  const burnToken = { policy: burnPolicy, name: '42', qty: 3n };
  const tokenUtxo = utxoFromOutput(hash32('cml burn token'), 0, outputBytes(T, { address: state.changeAddress, coin: 2n * ADA, assets: [burnToken] }), { origin: 'deposit' });
  const burnIntent = replayIntent('c3', 30, {
    type: 'T8',
    requested: [payTo(T, 0, 2n * ADA)],
    fixed: { body: { 9: encMap([[encBytes(Buffer.from(burnPolicy, 'hex')), encMap([[encBytes(Buffer.from('42', 'hex')), encInt(-1n)]])]]).toString('hex') }, witnesses: { 0: witnesses(mintKey), 1: encArray([nativeScript]).toString('hex') } },
    implicit: { burn: [{ policy: burnPolicy, name: '42', qty: 1n }] }
  });
  // A stake deregistration with its refund and a reward withdrawal.
  const stakeKey = Buffer.alloc(32, 0x73);
  const rewardAccount = Buffer.concat([Buffer.from([0xe0 | net]), Buffer.from(state.stakeCred, 'hex')]);
  const dereg = replayIntent('c4', 40, {
    type: 'T7',
    fixed: { body: { 4: encArray([encArray([encUint(1), encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))])])]).toString('hex'), 5: encMap([[encBytes(rewardAccount), encUint(5n * ADA)]]).toString('hex') }, witnesses: { 0: witnesses(stakeKey) } },
    implicit: { refunds: PR.keyDeposit, withdrawals: 5n * ADA }
  });
  const donation = replayIntent('c5', 50, { type: 'T1', requested: [payTo(T, 1, 3n * ADA)], fixed: { body: { 22: encUint(ADA).toString('hex') } }, implicit: { donation: ADA } });
  // Not replayable: a stake registration whose deposit the transaction
  // states differently from CML's key deposit; body field 6; a native
  // script given only by reference.
  const reg = replayIntent('c6', 60, { type: 'T7', fixed: { body: { 4: encArray([encArray([encUint(0), encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))])])]).toString('hex') } }, implicit: { deposits: 3n * ADA } });
  const field6 = replayIntent('c7', 70, { type: 'T7', requested: [payTo(T, 2, 2n * ADA)], fixed: { body: { 6: encArray([encMap([]), encUint(0)]).toString('hex') } } });
  const nativeRefTx = hash32('cml native reference');
  const nativeRefIn = { ref: `${nativeRefTx}#0`, cbor: unspentOutput(nativeRefTx, 0, encodeOutput({ address: addressBytes(recipientAddress('synthetic', 451)), coin: 5n * ADA, assets: [], scriptRef: { lang: 0, script: nativeScript.toString('hex') } }, 'map')).toString('hex') };
  const nativeByRef = replayIntent('c8', 80, {
    type: 'T8',
    requested: [payTo(T, 3, 2n * ADA)],
    fixed: { referenceInputs: [nativeRefIn], body: { 9: encMap([[encBytes(Buffer.from(burnPolicy, 'hex')), encMap([[encBytes(Buffer.from('42', 'hex')), encInt(-1n)]])]]).toString('hex') }, witnesses: { 0: witnesses(mintKey) } },
    implicit: { burn: [{ policy: burnPolicy, name: '42', qty: 1n }] }
  });
  const intents = [t6, t8mint, burnIntent, dereg, donation, reg, field6, nativeByRef];
  const collateralUtxo = utxoFromOutput(hash32('cml collateral'), 0, outputBytes(T, { address: state.changeAddress, coin: 6n * ADA, assets: [] }), { origin: 'deposit' });
  const source = { wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: state.stakeCred, changeAddress: state.changeAddress, changeAddressEnd: state.changeAddress, franken: new Set(), start: [...state.utxos.values(), tokenUtxo, collateralUtxo], events: intents.map((intent, i) => ({ kind: 'intent', txId: i + 1, intent })), windowStart: 0, windowEnd: 90, params: PR };
  const out = {};
  for (const name of ['cml-lf', 'cml-ri']) {
    for (const changePolicy of ['default', 'layout']) {
      const r = await replayCml(source, { name, changePolicy });
      out[`${name} ${changePolicy}`] = tally(r, name);
      assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.failures));
      assert.deepEqual(controlsOf(source, r), []);
      const nr = Object.fromEntries(r.spends.filter((s) => s.outcome === 'not-replayable').map((s) => [s.intent, s.detail]));
      assert.deepEqual(Object.keys(nr).map(Number), [5, 6, 7], JSON.stringify(out));
      assert.match(nr[5], /CML counts 2000000 lovelace of deposits, the transaction 3000000/);
      assert.match(nr[6], /body field 6/);
      assert.match(nr[7], /native script .* is given only by reference/);
      const built = (i) => r.spends.find((s) => s.intent === i && s.outcome === 'built');
      if (name === 'cml-lf') for (const i of changePolicy === 'default' ? [0, 2, 3, 4] : [0, 1, 2, 3, 4]) assert.ok(built(i), `${name} ${changePolicy}: intent ${i}: ${r.spends[i].outcome} ${r.spends[i].class} ${r.spends[i].detail}`);
      const tx = (i) => built(i) && inspectTx(built(i).built.txs[0].bytes);
      if (tx(0)) {
        assert.equal(tx(0).redeemers.length, 1);
        // Body field 11: BLAKE2b-256 over the redeemers and datums as written.
        const d = tx(0).tx;
        const hash = blake2b256(Buffer.concat([d.wits.fields.get(5).raw, d.wits.fields.get(4).raw]));
        assert.deepEqual(Buffer.from(d.body.fields.get(11).raw).subarray(-32), hash);
      }
      if (tx(1)) {
        assert.deepEqual(tx(1).mint, [{ policy: mintPolicy, name: '4d', qty: 5n }]);
        assert.deepEqual(tx(1).referenceInputs.map((x) => x.ref), [refIn.ref]);
      }
      if (tx(2)) assert.deepEqual(tx(2).mint, [{ policy: burnPolicy, name: '42', qty: -1n }]);
      if (tx(3)) assert.equal(tx(3).withdrawals.reduce((s, w) => s + w.coin, 0n), 5n * ADA);
      if (tx(4)) assert.equal(tx(4).donation, ADA);
      // CML does not count a mint's reference script (only those locking a
      // spent input), so its own fee for the reference-script mint is under
      // the final minimum, and the record names the part.
      for (const { intent, library } of r.libs) {
        if (changePolicy !== 'default') continue;
        if (intent.id === t8mint.id) assert.deepEqual(library.unpriced, ['reference scripts']);
        else assert.ok(library.fee >= library.finalMinFee, `${intent.type}: ${library.fee} under ${library.finalMinFee}`);
      }
      if (changePolicy === 'default') {
        // cml-ri's draws can also leave it short, class balance.
        const m = r.spends[1];
        assert.ok(m.outcome !== 'built', 'the reference-script mint builds under its own change');
        if (name === 'cml-lf' || m.class === CLASSES.feeMinimum) {
          assert.equal(m.class, CLASSES.feeMinimum, m.detail);
          assert.match(m.detail, /parts the library did not price: reference scripts$/);
        } else assert.equal(m.class, CLASSES.balance, m.detail);
      }
    }
  }
  t.diagnostic(JSON.stringify(out));
});

test('cml-lf selects the same inputs under both changes and gives the same bytes on every build', { skip }, async () => {
  const state = shapeState(T, 'S6').state;
  const tokens = [];
  for (const u of state.utxos.values()) for (const a of u.assets) if (tokens.length < 1 && u.held === null) tokens.push({ ...a, qty: 1n });
  const it = replayPay([{ coin: 40n * ADA }, { coin: 2n * ADA, assets: tokens }]);
  const m = makeMethod(T, 'cml-lf');
  const a = m.build(state, it, P, { changePolicy: 'default', seed: 1 });
  const b = m.build(state, it, P, { changePolicy: 'layout', seed: 1 });
  assert.equal(a.ok, true, a.detail);
  assert.equal(b.ok, true, b.detail);
  assert.deepEqual([...b.txs[0].walletInputs].sort(), [...a.txs[0].walletInputs].sort());
  assert.notEqual(a.txs[0].bytes, b.txs[0].bytes);
  for (const r of [a, b]) {
    const applied = checkAndApply(state, P, r.txs);
    assert.equal(applied.ok, true, applied.failure && applied.failure.detail);
  }
  // Other seeds and other builds in between change nothing.
  for (let seed = 2; seed <= 4; seed++) {
    makeMethod(T, 'cml-ri').build(state, it, P, { changePolicy: 'default', seed });
    assert.equal(m.build(state, it, P, { changePolicy: 'default', seed }).txs[0].bytes, a.txs[0].bytes);
  }
});

test('cml-ri draws from a generator no caller can seed; its passes do not count an input an earlier pass took', { skip }, () => {
  // One UTxO holding both requested tokens: the first token's pass takes it,
  // and the second token's pass, which counts only its own draws toward each
  // output, finds no other UTxO holding that token (tx_builder.rs:658-697).
  // Largest-first counts every input taken so far and builds.
  const x = { policy: policy('x'), name: assetName('x'), qty: 2n };
  const y = { policy: policy('y'), name: assetName('y'), qty: 2n };
  const s = constructState(T, [{ coin: 10n * ADA, assets: [x, y] }, { coin: 30n * ADA }]);
  const it = replayPay([{ coin: 2n * ADA, assets: [{ ...x, qty: 1n }, { ...y, qty: 1n }] }]);
  const lf = makeMethod(T, 'cml-lf').build(s, it, P, { changePolicy: 'default', seed: 1 });
  assert.equal(lf.ok, true, lf.detail);
  for (const changePolicy of ['default', 'layout']) {
    const ri = makeMethod(T, 'cml-ri').build(s, it, P, { changePolicy, seed: 1 });
    assert.equal(ri.ok, false);
    assert.equal(ri.class, CLASSES.balance);
    assert.match(ri.detail, /^select_utxos: UTxO Balance Insufficient/);
  }
  // Its draws differ from build to build whatever the seed: over many builds
  // of one state, more than one input set.
  const many = constructState(T, Array.from({ length: 30 }, (_, i) => ({ coin: BigInt(5 + i) * ADA })));
  const pay = replayPay([{ coin: 20n * ADA }]);
  const sets = new Set();
  for (let i = 0; i < 20; i++) {
    const r = makeMethod(T, 'cml-ri').build(many, pay, P, { changePolicy: 'default', seed: 1 });
    assert.equal(r.ok, true, r.detail);
    assert.equal(checkAndApply(many, P, r.txs).ok, true);
    sets.add([...r.txs[0].walletInputs].sort().join());
  }
  assert.ok(sets.size > 1);
});

test('inputs that cannot fund the layout change fail with change-minimum while CML builds its own', { skip }, () => {
  // One UTxO of 10 ADA holding 40 policies: CML's change fits in one output;
  // the layout change, with its outputs at their minimum, does not.
  const s = constructState(T, [{ coin: 10n * ADA, assets: Array.from({ length: 40 }, (_, i) => ({ policy: policy(`q${i}`), name: assetName('t'), qty: 1n })) }]);
  const it = replayPay([{ coin: 2n * ADA }]);
  const m = makeMethod(T, 'cml-lf');
  const a = m.build(s, it, P, { changePolicy: 'default', seed: 1 });
  assert.equal(a.ok, true, a.detail);
  assert.equal(checkAndApply(s, P, a.txs).ok, true);
  const b = m.build(s, it, P, { changePolicy: 'layout', seed: 1 });
  assert.equal(b.ok, false);
  assert.equal(b.class, CLASSES.changeMinimum);
  assert.match(b.detail, /^layout change on the library's inputs: /);
  // A failure of the selection is the library's under either change.
  const short = replayPay([{ coin: 50n * ADA }]);
  const c = m.build(s, short, P, { changePolicy: 'default', seed: 1 });
  const d = m.build(s, short, P, { changePolicy: 'layout', seed: 1 });
  assert.equal(c.class, CLASSES.balance);
  assert.deepEqual([d.class, d.detail], [c.class, c.detail]);
  // CML's own change failure: leftover ADA that cannot fund the token change.
  const tight = constructState(T, [{ coin: 3n * ADA, assets: Array.from({ length: 30 }, (_, i) => ({ policy: policy(`r${i}`), name: assetName('t'), qty: 1n })) }]);
  const e = m.build(tight, replayPay([{ coin: 1500000n }]), P, { changePolicy: 'default', seed: 1 });
  assert.equal(e.ok, false);
  assert.equal(e.class, CLASSES.changeMinimum);
  assert.match(e.detail, /^build: Not enough ADA leftover/);
});

test('a change policy other than default and layout is refused, a battery intent is not a replayed one, and CML\'s abort on a native reference script is the library\'s failure under its own change', { skip }, () => {
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const m = makeMethod(T, 'cml-lf');
  const r = m.build(s, replayPay([{ coin: 3n * ADA }]), P, { changePolicy: 'ladder', seed: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.class, CLASSES.other);
  assert.match(r.detail, /its own change or the layout change only/);
  assert.throws(() => m.build(s, payIntent(T, [{ coin: 3n * ADA }]), P, { changePolicy: 'default', seed: 1 }), /builds replayed intents only/);
  // Body field 6 under either change.
  const it = replayIntent('m6', 10, { type: 'T7', requested: [payTo(T, 2, 2n * ADA)], fixed: { body: { 6: encArray([encMap([]), encUint(0)]).toString('hex') } } });
  for (const changePolicy of ['default', 'layout']) {
    const x = m.build(s, withoutLeftovers(it), P, { changePolicy, seed: 1 });
    assert.equal(x.class, NOT_REPLAYABLE, changePolicy);
    assert.match(x.detail, /body field 6/);
  }
  // A reference input carrying a native script reference: CML's
  // min_fee(true) would abort, so L/own records the library's failure
  // without the call; L/layout never prices with it and builds.
  const nativeScript = encArray([encUint(0), encBytes(Buffer.alloc(28, 0x11))]);
  const refTx = hash32('cml native script reference');
  const refIn = { ref: `${refTx}#0`, cbor: unspentOutput(refTx, 0, encodeOutput({ address: addressBytes(recipientAddress('synthetic', 452)), coin: 5n * ADA, assets: [], scriptRef: { lang: 0, script: nativeScript.toString('hex') } }, 'map')).toString('hex') };
  const read = replayIntent('m7', 10, { type: 'T1', requested: [payTo(T, 4, 3n * ADA)], fixed: { referenceInputs: [refIn] } });
  const own = m.build(s, read, P, { changePolicy: 'default', seed: 1 });
  assert.deepEqual([own.ok, own.class], [false, CLASSES.other]);
  assert.match(own.detail, /aborts on a reference input carrying a native script reference/);
  const layout = m.build(s, read, P, { changePolicy: 'layout', seed: 1 });
  assert.equal(layout.ok, true, layout.detail);
});

test('a requested output\'s own bytes pass through: a payment with an inline datum', { skip }, () => {
  const s = constructState(T, [{ coin: 20n * ADA }, { coin: 9n * ADA }]);
  const address = recipientAddress('synthetic', 301);
  const datum = { kind: 'inline', cbor: 'd87980' };
  const cbor = encodeOutput({ address: addressBytes(address), coin: 3n * ADA, assets: [], datum }, 'map').toString('hex');
  const it = { ...replayPay([{ coin: 3n * ADA }]), requested: [payTo(T, 1, 3n * ADA, { cbor, address, datum })] };
  for (const name of ['cml-lf', 'cml-ri']) {
    for (const changePolicy of ['default', 'layout']) {
      const r = makeMethod(T, name).build(s, it, P, { changePolicy, seed: 1 });
      assert.equal(r.ok, true, r.detail);
      assert.equal(inspectTx(r.txs[0].bytes).outputs[0].raw.toString('hex'), cbor);
      assert.equal(checkAndApply(s, P, r.txs).ok, true);
    }
  }
});
