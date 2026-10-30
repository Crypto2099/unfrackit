// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The library adapters' replay coverage: each adapter's statement of the
// intent parts its replay path covers, and the refusal of a part it does not
// cover, with the message every adapter that covers none has always given;
// and, with the treatment, cardano-js-sdk's replay path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPLAY_PARTS, REPLAY_COVERAGE, partsOf, refuseUncovered } from '../../../src/methods/library.mjs';
import { ZERO_IMPLICIT } from '../../../src/state/intent.mjs';
import { treatment, skip } from '../../lib/treatment.mjs';
import { negativeControls, EXPECTED } from '../../lib/controls.mjs';
import { cjsMethod, cjsImplicitValue } from '../../../src/methods/cjs.mjs';
import { replay, fixedExtraWitnesses } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { fixedResolver } from '../../../src/kit/apply.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { outputBytes } from '../../../src/kit/assemble.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { parseAddress, addressBytes } from '../../../src/history/address.mjs';
import { encUint, encInt, encBytes, encArray, encMap } from '../../../src/history/cbor.mjs';
import { blake2b224 } from '../../../src/history/blake2b.mjs';
import { recipientAddress } from '../../../src/battery/recipients.mjs';
import { shapeState } from '../../../src/shapes/shapes.mjs';
import { spendable, holdings } from '../../../src/state/state.mjs';

const out = (extra = {}) => ({ cbor: '00', address: 'x', coin: 2000000n, assets: [], datum: null, scriptRef: null, ...extra });
const intent = (over = {}) => ({ source: 'replay', requested: [out()], implicit: ZERO_IMPLICIT, fixed: null, collateral: { required: false, observed: null }, ...over });
const FIXED = { inputs: [], referenceInputs: [], body: { 4: '80' }, witnesses: {}, redeemers: [], auxiliaryData: null, scriptFee: 0n, fixedBytes: 1 };
const TOKEN = { policy: 'cc'.repeat(28), name: '41', qty: 1n };

const MESSAGES = (name) => ({
  fixed: `${name}: the replay path (fixed parts and collateral) is not built yet`,
  implicit: `${name}: implicit values come only with fixed parts, whose path is not built yet`,
  outputData: `${name}: requested outputs with a datum or a script reference come only with replays, whose path is not built yet`
});

const CASES = {
  none: [intent(), null],
  fixed: [intent({ fixed: FIXED }), 'fixed'],
  collateral: [intent({ collateral: { required: true, observed: null } }), 'fixed'],
  withdrawals: [intent({ implicit: { ...ZERO_IMPLICIT, withdrawals: 1n } }), 'implicit'],
  refunds: [intent({ implicit: { ...ZERO_IMPLICIT, refunds: 1n } }), 'implicit'],
  deposits: [intent({ implicit: { ...ZERO_IMPLICIT, deposits: 1n } }), 'implicit'],
  donation: [intent({ implicit: { ...ZERO_IMPLICIT, donation: 1n } }), 'implicit'],
  mint: [intent({ implicit: { ...ZERO_IMPLICIT, mint: [TOKEN] } }), 'implicit'],
  burn: [intent({ implicit: { ...ZERO_IMPLICIT, burn: [TOKEN] } }), 'implicit'],
  datum: [intent({ requested: [out({ datum: { kind: 'inline', cbor: 'd87980' } })] }), 'outputData'],
  scriptRef: [intent({ requested: [out({ scriptRef: '00' })] }), 'outputData'],
  // The first uncovered part decides the message, in the order fixed parts
  // and collateral, implicit values, output data.
  fixedAndImplicit: [intent({ fixed: FIXED, implicit: { ...ZERO_IMPLICIT, deposits: 1n }, requested: [out({ datum: { kind: 'hash', hash: '00' } })] }), 'fixed'],
  implicitAndData: [intent({ implicit: { ...ZERO_IMPLICIT, mint: [TOKEN] }, requested: [out({ scriptRef: '00' })] }), 'implicit']
};

test('an intent\'s replay parts', () => {
  assert.deepEqual(REPLAY_PARTS, ['fixed', 'collateral', 'implicit', 'outputData']);
  assert.deepEqual(partsOf(CASES.none[0]), []);
  assert.deepEqual(partsOf(CASES.collateral[0]), ['collateral']);
  assert.deepEqual(partsOf(CASES.fixedAndImplicit[0]), ['fixed', 'implicit', 'outputData']);
  assert.deepEqual(partsOf(intent({ fixed: FIXED, collateral: { required: true, observed: null } })), ['fixed', 'collateral']);
});

test('cardano-js-sdk covers every replay part', () => {
  assert.deepEqual(REPLAY_COVERAGE.cjs, REPLAY_PARTS);
  for (const [c, [it]] of Object.entries(CASES)) assert.doesNotThrow(() => refuseUncovered('cjs-rrri', REPLAY_COVERAGE.cjs, it), c);
});

test('Mesh covers no replay part and refuses each with the messages it has always given', () => {
  for (const [mod, name] of [['mesh', 'mesh-default']]) {
    assert.deepEqual(REPLAY_COVERAGE[mod], []);
    const msg = MESSAGES(name);
    for (const [c, [it, want]] of Object.entries(CASES)) {
      if (want === null) assert.doesNotThrow(() => refuseUncovered(name, REPLAY_COVERAGE[mod], it), c);
      else assert.throws(() => refuseUncovered(name, REPLAY_COVERAGE[mod], it), (e) => e.constructor === Error && e.message === msg[want], c);
    }
  }
});

test('an adapter refuses only the parts its statement leaves out', () => {
  const msg = MESSAGES('x');
  assert.doesNotThrow(() => refuseUncovered('x', REPLAY_PARTS, CASES.fixedAndImplicit[0]));
  assert.throws(() => refuseUncovered('x', ['fixed', 'collateral'], CASES.fixedAndImplicit[0]), { message: msg.implicit });
  assert.throws(() => refuseUncovered('x', ['fixed', 'collateral', 'implicit'], CASES.fixedAndImplicit[0]), { message: msg.outputData });
  assert.throws(() => refuseUncovered('x', ['fixed'], intent({ fixed: FIXED, collateral: { required: true, observed: null } })), { message: msg.fixed });
  assert.throws(() => refuseUncovered('x', ['mint'], CASES.none[0]), /unknown replay part mint/);
});

// cardano-js-sdk's replay path, with the treatment: the synthetic streams'
// T6 (a Plutus spend with a script input, datum, redeemer and collateral),
// T7 (a stake registration with its deposit), T8 (a mint into the wallet) and
// a T1 with a held fixed input, a validity interval and a message, under two
// collateral rules and every change option; and constructed T6, T7 and T8
// intents for the parts the streams do not carry: a burn, a deregistration
// with its refund and a reward withdrawal, a treasury donation, and a body
// field the kit cannot write. Each spend builds, fails with a class, is
// infeasible (by balance or for collateral), or is not replayable; every built
// one passes the kit's checks (the engine runs them) and its four negative
// controls are caught.

const T = await treatment();
const ADA = 1000000n;

// The engine's replay of `source` by cardano-js-sdk, every built transaction
// kept with the library's own fee and the final transaction's minimum.
async function replayCjs(source, { rule = 'ledger', changePolicy = 'default', seed = 1 } = {}) {
  const m = cjsMethod(T);
  const fees = [];
  const spy = { ...m, build: async (...a) => {
    const r = await m.build(...a);
    if (r.ok && r.library) fees.push(r.library);
    return r;
  } };
  const r = await replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: spy, opts: { seed, changePolicy, collateralRule: rule }, settleEvery: 25, keepTx: true });
  return { ...r, fees };
}

// Every built spend's negative controls, against the state it was built from.
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

test('cardano-js-sdk replays the synthetic streams\' script spends, certificates, mints and fixed inputs', { skip }, async (t) => {
  const seen = {};
  for (const name of ['S1', 'S7', 'S8', 'M1', 'M7']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const intents = source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
    for (const rule of ['ledger', 'token-bearing']) {
      for (const changePolicy of ['default', 'layout', 'single', 'naive']) {
        const r = await replayCjs(source, { rule, changePolicy });
        assert.equal(r.refused, undefined);
        const o = tally(r);
        seen[`${name} ${rule} ${changePolicy}`] = o;
        assert.deepEqual(controlsOf(source, r), []);
        for (const s of r.spends) {
          const it = intents[s.intent];
          if (s.outcome !== 'built' || !it.fixed) continue;
          const tx = inspectTx(s.built.txs[0].bytes);
          const ins = new Set(tx.inputs.map((x) => x.ref));
          // Every fixed input is in the transaction, and none is the
          // selector's.
          for (const x of it.fixed.inputs) {
            assert.ok(ins.has(x.ref), `${s.type}: fixed input missing`);
            assert.ok(!s.built.txs[0].walletInputs.includes(x.ref));
          }
          if (it.collateral.required) assert.equal(tx.collateralInputs.length, 1);
        }
        if (changePolicy === 'default') {
          // The library's fee is the final transaction's minimum: its
          // callbacks saw the fixed parts and the collateral.
          for (const f of r.fees) assert.equal(f.fee, f.finalMinFee);
          for (const type of ['T6', 'T7', 'T8']) assert.ok(o[`${type}:built`] >= 1, `${name} ${rule}: no ${type} built`);
        }
      }
    }
  }
  // Under the ledger rule the library would spend every pure-ADA UTxO of 5
  // ADA or more M7 holds; with the collateral set aside before selection, its
  // script spend builds.
  assert.equal(seen['M7 ledger default']['T6:built'], 1);
  t.diagnostic(JSON.stringify(seen));
});

// A replay intent of the given parts at time t.
function replayIntent(id, t, { type, requested = [], fixed = null, implicit = {}, collateral = false }) {
  return {
    id: id.padEnd(64, '0'),
    source: 'replay',
    type,
    time: { slot: t, blockTime: t, blockIndex: 0, epoch: 0, block: t },
    requested,
    implicit: { ...ZERO_IMPLICIT, ...implicit },
    fixed: fixed && { inputs: [], referenceInputs: [], body: {}, witnesses: {}, redeemers: [], auxiliaryData: null, scriptFee: 0n, fixedBytes: 0, refScriptBytes: 0, ...fixed },
    collateral: { required: collateral, observed: null },
    invalid: null,
    burst: null,
    observed: { tx: id, size: 0, fee: 300000n, epoch: 0, protocolMajor: null, minFeeA: 44n, minFeeB: 155381n, walletInputs: [], walletOutputs: [], walletWitnesses: [] },
    classes: {},
    derived: null,
    meta: null
  };
}

const payTo = (i, coin) => {
  const address = recipientAddress('synthetic', 300 + i);
  return { cbor: outputBytes(T, { address, coin, assets: [] }).toString('hex'), address, coin, assets: [], datum: null, scriptRef: null, raised: null, wallet: false, scriptPayment: false, index: null, from: null, inflow: false };
};

test('cardano-js-sdk replays a burn, a deregistration with a withdrawal and a donation, and refuses what the kit cannot write as not replayable', { skip }, async (t) => {
  const shape = shapeState(T, 'S8');
  const state = shape.state;
  const P = SYNTHETIC_PARAMS;
  const held = holdings(spendable(state));
  const burnt = [...held.assets.values()].sort((a, b) => (a.policy + a.name < b.policy + b.name ? -1 : 1))[0];
  const stakeKey = Buffer.alloc(32, 0x73);
  const witness = (k) => encArray([encArray([encBytes(k), encBytes(Buffer.alloc(64, 0x77))])]).toString('hex');
  const mintKey = Buffer.alloc(32, 0x6b);
  const nativeScript = encArray([encUint(0), encBytes(blake2b224(mintKey))]);
  const net = addressBytes(state.changeAddress)[0] & 15;
  const rewardAccount = Buffer.concat([Buffer.from([0xe0 | net]), Buffer.from(state.stakeCred, 'hex')]);
  const intents = [
    // T8: a burn of one unit the wallet holds, with a native script and its
    // key's witness.
    replayIntent('b1', 10, {
      type: 'T8',
      requested: [payTo(0, 2n * ADA)],
      fixed: { body: { 9: encMap([[encBytes(Buffer.from(burnt.policy, 'hex')), encMap([[encBytes(Buffer.from(burnt.name, 'hex')), encInt(-1n)]])]]).toString('hex') }, witnesses: { 0: witness(mintKey), 1: encArray([nativeScript]).toString('hex') } },
      implicit: { burn: [{ policy: burnt.policy, name: burnt.name, qty: 1n }] }
    }),
    // T7: a stake deregistration with its refund and a reward withdrawal,
    // with the stake key's witness, and no requested output.
    replayIntent('b2', 20, {
      type: 'T7',
      fixed: { body: { 4: encArray([encArray([encUint(1), encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))])])]).toString('hex'), 5: encMap([[encBytes(rewardAccount), encUint(5n * ADA)]]).toString('hex') }, witnesses: { 0: witness(stakeKey) } },
      implicit: { refunds: P.keyDeposit, withdrawals: 5n * ADA }
    }),
    // A payment with a treasury donation.
    replayIntent('b3', 30, { type: 'T1', requested: [payTo(1, 3n * ADA)], fixed: { body: { 22: encUint(ADA).toString('hex') } }, implicit: { donation: ADA } }),
    // A body field 6 (protocol parameter updates): the kit cannot write it.
    replayIntent('b4', 40, { type: 'T7', requested: [payTo(2, 2n * ADA)], fixed: { body: { 6: encArray([encMap([]), encUint(0)]).toString('hex') } } })
  ];
  for (const it of intents) if (it.fixed) it.fixed.fixedBytes = 0;
  const source = { wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: state.stakeCred, changeAddress: state.changeAddress, changeAddressEnd: state.changeAddress, franken: new Set(), start: [...state.utxos.values()], events: intents.map((intent, i) => ({ kind: 'intent', txId: i + 1, intent })), arrival: new Map(), windowStart: 0, windowEnd: 50, params: P };
  const out = {};
  for (const changePolicy of ['default', 'layout', 'single', 'naive']) {
    const r = await replayCjs(source, { changePolicy });
    const o = tally(r);
    out[changePolicy] = o;
    assert.deepEqual(controlsOf(source, r), []);
    assert.equal(o['T8:built'], 1, JSON.stringify(o));
    assert.equal(o['T7:built'], 1, JSON.stringify(o));
    assert.equal(o['T1:built'], 1, JSON.stringify(o));
    assert.equal(o['T7:not-replayable:not-replayable'], 1, JSON.stringify(o));
    const nr = r.spends.find((s) => s.outcome === 'not-replayable');
    assert.match(nr.detail, /body field 6/);
    assert.equal(r.summary.counts.notReplayable, 1);
    const tx = (type) => inspectTx(r.spends.find((s) => s.type === type && s.outcome === 'built').built.txs[0].bytes);
    assert.deepEqual(tx('T8').mint, [{ policy: burnt.policy, name: burnt.name, qty: -1n }]);
    assert.equal(tx('T7').withdrawals.reduce((s, w) => s + w.coin, 0n), 5n * ADA);
    assert.equal(tx('T1').donation, ADA);
    if (changePolicy === 'default') for (const f of r.fees) assert.equal(f.fee, f.finalMinFee);
  }
  // The library's ImplicitValue for these parts.
  assert.deepEqual(cjsImplicitValue({ ...ZERO_IMPLICIT, withdrawals: 5n, refunds: 2n, deposits: 3n, donation: 1n, mint: [{ policy: 'aa', name: '01', qty: 4n }], burn: [{ policy: 'bb', name: '', qty: 6n }] }), { coin: { withdrawals: 5n, reclaimDeposit: 2n, input: 7n, deposit: 4n }, mint: new Map([['aa01', 4n], ['bb', -6n]]) });
  t.diagnostic(JSON.stringify(out));
});

test('a seed repeats a replay byte for byte', { skip }, async () => {
  const source = loadSource(T, { kind: 'shape', name: 'S8', stream: 'synthetic' });
  const bytes = (r) => r.spends.filter((s) => s.outcome === 'built').map((s) => s.built.txs[0].bytes);
  const a = await replayCjs(source, { seed: 7 });
  const b = await replayCjs(source, { seed: 7 });
  assert.deepEqual(bytes(a), bytes(b));
});
