// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// cardano-serialization-lib's replay path (methods/csl.mjs), with the
// treatment: the four CSL methods and one substituted change policy on the
// synthetic streams of S1, S7, S8, M1 and M7 (T7 a stake registration, T8 a
// mint into the wallet, T1 with a held fixed input, a validity interval and a
// message; the streams' T6 names a script whose hash its address does not
// carry, so CSL, which finds a script by its hash, cannot place it) under two
// collateral rules; and constructed intents for the parts the streams do not
// carry: a Plutus spend with its datum and redeemer, a Plutus mint whose
// script is a reference script, a burn, a deregistration with its refund and a
// reward withdrawal, a treasury donation, a deposit CSL counts differently,
// a network id with an empty auxiliary data, which the engine leaves out, and
// body field 6. Each spend builds, fails with a class other
// than 'other', is infeasible (by balance or for collateral), or is not
// replayable; every built one passes the kit's checks (the engine runs them)
// and its four negative controls are caught; its fixed inputs are present and
// none is the selector's; a script spend's collateral is the UTxO set aside
// and never an input. csl-ri draws from a generator no caller can seed, so its
// outcomes are asserted, not its bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPLAY_PARTS, REPLAY_COVERAGE, refuseUncovered } from '../../../src/methods/library.mjs';
import { ZERO_IMPLICIT } from '../../../src/state/intent.mjs';
import { treatment, skip } from '../../lib/treatment.mjs';
import { negativeControls, EXPECTED } from '../../lib/controls.mjs';
import { cslMethod } from '../../../src/methods/csl.mjs';
import { replay, fixedExtraWitnesses } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { fixedResolver } from '../../../src/kit/apply.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { outputBytes } from '../../../src/kit/assemble.mjs';
import { executionFee, refScriptFee } from '../../../src/kit/fee.mjs';
import { CLASSES, checkTx } from '../../../src/kit/check.mjs';
import { withoutOneWitness } from '../../lib/txcbor.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { parseAddress, addressBytes } from '../../../src/history/address.mjs';
import { encUint, encInt, encBytes, encArray, encMap } from '../../../src/history/cbor.mjs';
import { encodeOutput, unspentOutput } from '../../../src/history/output.mjs';
import { blake2b224, blake2b256 } from '../../../src/history/blake2b.mjs';
import { addressTextOf, utxoFromOutput } from '../../../src/state/utxo.mjs';
import { recipientAddress } from '../../../src/battery/recipients.mjs';
import { shapeState } from '../../../src/shapes/shapes.mjs';

const T = await treatment();
const ADA = 1000000n;
const VARIANTS = [
  ['lf', false],
  ['ri', false],
  ['lf', true],
  ['ri', true]
];

test('CSL covers every replay part', () => {
  assert.deepEqual(REPLAY_COVERAGE.csl, REPLAY_PARTS);
  const it = { source: 'replay', requested: [{ datum: { kind: 'hash', hash: '00' }, scriptRef: '00' }], implicit: { ...ZERO_IMPLICIT, deposits: 1n }, fixed: { body: {} }, collateral: { required: true, observed: null } };
  for (const name of ['csl-lf', 'csl-ri', 'csl-lf-pure', 'csl-ri-pure']) assert.doesNotThrow(() => refuseUncovered(name, REPLAY_COVERAGE.csl, it));
});

// The engine's replay of `source` by one CSL method, every built transaction
// kept with CSL's own fee and the final transaction's minimum.
async function replayCsl(source, { strategy, pure, rule = 'ledger', changePolicy = 'default' }) {
  const m = cslMethod(T, { strategy, preferPureChange: pure });
  const fees = [];
  const spy = {
    ...m,
    build: (...a) => {
      const r = m.build(...a);
      if (r.ok && r.library) fees.push(r.library);
      return r;
    }
  };
  const r = await replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: spy, opts: { seed: 1, changePolicy, collateralRule: rule }, settleEvery: 25, keepTx: true });
  return { ...r, fees, name: m.name };
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
      const ctx = { resolve, implicit: it.implicit, scriptFee: it.fixed ? it.fixed.scriptFee : 0n, extraWitnesses: fixedExtraWitnesses(it) };
      if (!inspectTx(t.bytes).outputs.length) {
        // CSL adds leftover ADA under an output's minimum to the fee
        // (tx_builder.rs:2151-2167), so a spend with no requested output can
        // have no output at all; the fee and value controls need one.
        const c = { params: source.params, ...ctx };
        const reasons = (x) => [...new Set(x.failures.map((f) => f.check))].join(',');
        const got = { base: reasons(checkTx(t.bytes, c)), size: reasons(checkTx(t.bytes, { ...c, params: { ...source.params, maxTxSize: inspectTx(t.bytes).size - 1 } })), witnesses: reasons(checkTx(withoutOneWitness(t.bytes), c)) };
        if (got.base !== '' || got.size !== 'size' || got.witnesses !== 'witnesses') bad.push({ type: s.type, c: got });
        continue;
      }
      const c = negativeControls(s.built.before, source.params, t.bytes, ctx);
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
    if (s.outcome === 'failed') assert.notEqual(s.class, CLASSES.other, `${r.name} ${s.type}: ${s.detail}`);
    const k = `${s.type}:${s.outcome}${s.class && s.outcome !== 'not-replayable' ? `:${s.class}` : ''}`;
    o[k] = (o[k] || 0) + 1;
  }
  return o;
}

// Fixed inputs present and none the selector's; a script spend's only
// collateral the UTxO set aside, never an input.
function checkParts(source, r) {
  const intents = source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
  for (const s of r.spends) {
    if (s.outcome !== 'built') continue;
    const it = intents[s.intent];
    const t = s.built.txs[0];
    const tx = inspectTx(t.bytes);
    const ins = new Set(tx.inputs.map((x) => x.ref));
    if (it.fixed) for (const x of it.fixed.inputs) {
      assert.ok(ins.has(x.ref), `${r.name} ${s.type}: fixed input missing`);
      assert.ok(!t.walletInputs.includes(x.ref), `${r.name} ${s.type}: a fixed input among the selector's`);
    }
    if (it.collateral.required) {
      assert.equal(tx.collateralInputs.length, 1, `${r.name} ${s.type}: collateral`);
      const c = tx.collateralInputs[0].ref;
      assert.ok(!ins.has(c), `${r.name} ${s.type}: the collateral is an input`);
      assert.ok(s.built.before.utxos.has(c), `${r.name} ${s.type}: the collateral is not the wallet's`);
      assert.ok(!t.walletInputs.includes(c));
    } else assert.equal(tx.collateralInputs.length, 0);
  }
}

test('CSL replays the synthetic streams\' certificates, mints and fixed inputs, by every CSL method and a substituted change', { skip, timeout: 10 * 60 * 1000 }, async (t) => {
  const seen = {};
  for (const name of ['S1', 'S7', 'S8', 'M1', 'M7']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    for (const [strategy, pure] of VARIANTS) {
      for (const rule of ['ledger', 'token-bearing']) {
        for (const changePolicy of ['default', 'layout']) {
          const r = await replayCsl(source, { strategy, pure, rule, changePolicy });
          assert.equal(r.refused, undefined);
          const o = tally(r);
          seen[`${name} ${r.name} ${rule} ${changePolicy}`] = o;
          assert.deepEqual(controlsOf(source, r), [], `${name} ${r.name}`);
          checkParts(source, r);
          // The streams' Plutus spend names a script whose hash is not its
          // input's: not replayable for CSL, by that reason only.
          const nr = r.spends.filter((s) => s.outcome === 'not-replayable');
          assert.deepEqual(nr.map((s) => s.type), ['T6']);
          assert.match(nr[0].detail, /no script with hash/);
          for (const f of r.fees) assert.ok(f.fee >= f.finalMinFee);
          if (strategy === 'lf') for (const type of ['T7', 'T8']) assert.ok(o[`${type}:built`] >= 1, `${name} ${r.name} ${rule} ${changePolicy}: no ${type} built`);
        }
      }
    }
  }
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

const requestedOf = (address, bytes, coin, assets, extra = {}) => ({ cbor: Buffer.from(bytes).toString('hex'), address, coin, assets, datum: null, scriptRef: null, raised: null, wallet: false, scriptPayment: false, index: null, from: null, inflow: false, ...extra });
const payTo = (i, coin) => {
  const address = recipientAddress('synthetic', 400 + i);
  return requestedOf(address, outputBytes(T, { address, coin, assets: [] }), coin, []);
};
const hash32 = (s) => blake2b256(Buffer.from(s)).toString('hex');

test('CSL replays a Plutus spend and a Plutus mint by reference script, a burn, a deregistration with a withdrawal, a donation, and a payment without its network id and empty auxiliary data, and refuses what it cannot express as not replayable', { skip, timeout: 10 * 60 * 1000 }, async (t) => {
  const shape = shapeState(T, 'S8');
  const state = shape.state;
  // The synthetic parameters with a reference-script price, which the
  // reference-script mint needs.
  const P = { ...SYNTHETIC_PARAMS, minFeeRefScriptCostPerByte: [15, 1] };
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
  const scriptTx = hash32('csl script input');
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
      scriptFee: executionFee(P, spendUnits[0], spendUnits[1])
    },
    collateral: true
  });

  // A Plutus V2 mint whose policy script is a reference script in a reference
  // input, into the wallet.
  const policyScript = Buffer.alloc(500, 0x5a);
  const policy = blake2b224(Buffer.concat([Buffer.from([2]), policyScript])).toString('hex');
  const refTx = hash32('csl reference script');
  const refOut = encodeOutput({ address: addressBytes(recipientAddress('synthetic', 450)), coin: 20n * ADA, assets: [], scriptRef: { lang: 2, script: policyScript.toString('hex') } }, 'map');
  const refIn = { ref: `${refTx}#0`, cbor: unspentOutput(refTx, 0, refOut).toString('hex') };
  const minted = [{ policy, name: '4d', qty: 5n }];
  const mintUnits = [100000n, 40000000n];
  let coin = 0n;
  let mintOut;
  for (let i = 0; i < 4; i++) {
    mintOut = outputBytes(T, { address: state.changeAddress, coin, assets: minted });
    coin = P.coinsPerUtxoByte * (160n + BigInt(mintOut.length));
  }
  mintOut = outputBytes(T, { address: state.changeAddress, coin, assets: minted });
  const t8mint = replayIntent('c2', 20, {
    type: 'T8',
    requested: [requestedOf(state.changeAddress, mintOut, coin, minted, { wallet: true, inflow: true })],
    fixed: {
      referenceInputs: [refIn],
      body: { 9: encMap([[encBytes(Buffer.from(policy, 'hex')), encMap([[encBytes(Buffer.from('4d', 'hex')), encUint(5)]])]]).toString('hex') },
      witnesses: { 5: encArray([encArray([encUint(1), encUint(0), datum, encArray([encUint(mintUnits[0]), encUint(mintUnits[1])])])]).toString('hex') },
      redeemers: [{ tag: 1, target: { kind: 'policy', policy }, data: 'd87980', exUnits: mintUnits }],
      scriptFee: executionFee(P, mintUnits[0], mintUnits[1]) + refScriptFee(P, policyScript.length),
      refScriptBytes: policyScript.length
    },
    implicit: { mint: minted },
    collateral: true
  });

  // A burn of one unit of a token the wallet holds under a native script
  // policy, with the policy key's witness.
  const mintKey = Buffer.alloc(32, 0x6b);
  const nativeScript = encArray([encUint(0), encBytes(blake2b224(mintKey))]);
  const burnPolicy = blake2b224(Buffer.concat([Buffer.from([0]), nativeScript])).toString('hex');
  const burnTx = hash32('csl burn token');
  const burnToken = { policy: burnPolicy, name: '42', qty: 3n };
  const tokenUtxo = utxoFromOutput(burnTx, 0, outputBytes(T, { address: state.changeAddress, coin: 2n * ADA, assets: [burnToken] }), { origin: 'deposit' });
  const burnIntent = replayIntent('c3', 30, {
    type: 'T8',
    requested: [payTo(0, 2n * ADA)],
    fixed: { body: { 9: encMap([[encBytes(Buffer.from(burnPolicy, 'hex')), encMap([[encBytes(Buffer.from('42', 'hex')), encInt(-1n)]])]]).toString('hex') }, witnesses: { 0: witnesses(mintKey), 1: encArray([nativeScript]).toString('hex') } },
    implicit: { burn: [{ policy: burnPolicy, name: '42', qty: 1n }] }
  });

  // A stake deregistration with its refund and a reward withdrawal, with the
  // stake key's witness.
  const stakeKey = Buffer.alloc(32, 0x73);
  const rewardAccount = Buffer.concat([Buffer.from([0xe0 | net]), Buffer.from(state.stakeCred, 'hex')]);
  const dereg = replayIntent('c4', 40, {
    type: 'T7',
    fixed: { body: { 4: encArray([encArray([encUint(1), encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))])])]).toString('hex'), 5: encMap([[encBytes(rewardAccount), encUint(5n * ADA)]]).toString('hex') }, witnesses: { 0: witnesses(stakeKey) } },
    implicit: { refunds: P.keyDeposit, withdrawals: 5n * ADA }
  });
  const donation = replayIntent('c5', 50, { type: 'T1', requested: [payTo(1, 3n * ADA)], fixed: { body: { 22: encUint(ADA).toString('hex') } }, implicit: { donation: ADA } });
  // A stake registration whose deposit the transaction states differently from
  // CSL's key deposit.
  const reg = replayIntent('c6', 60, { type: 'T7', fixed: { body: { 4: encArray([encArray([encUint(0), encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))])])]).toString('hex') } }, implicit: { deposits: 3n * ADA } });
  const field6 = replayIntent('c7', 70, { type: 'T7', requested: [payTo(2, 2n * ADA)], fixed: { body: { 6: encArray([encMap([]), encUint(0)]).toString('hex') } } });
  const field15 = replayIntent('c8', 80, { type: 'T1', requested: [payTo(3, 2n * ADA)], fixed: { body: { 15: encUint(0).toString('hex') }, auxiliaryData: 'd90103a0' } });
  const intents = [t6, t8mint, burnIntent, dereg, donation, reg, field6, field15];
  // A pure-ADA UTxO eligible as collateral under the ledger rule.
  const collateralUtxo = utxoFromOutput(hash32('csl collateral'), 0, outputBytes(T, { address: state.changeAddress, coin: 6n * ADA, assets: [] }), { origin: 'deposit' });
  const source = { wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: state.stakeCred, changeAddress: state.changeAddress, changeAddressEnd: state.changeAddress, franken: new Set(), start: [...state.utxos.values(), tokenUtxo, collateralUtxo], events: intents.map((intent, i) => ({ kind: 'intent', txId: i + 1, intent })), arrival: new Map(), windowStart: 0, windowEnd: 90, params: P };
  const out = {};
  for (const [strategy, pure] of VARIANTS) {
    for (const changePolicy of ['default', 'layout']) {
      const r = await replayCsl(source, { strategy, pure, changePolicy });
      const o = tally(r);
      out[`${r.name} ${changePolicy}`] = o;
      for (const x of r.spends) if (x.outcome === 'failed') out[`${r.name} ${changePolicy} ${x.intent}`] = x.detail;
      assert.deepEqual(controlsOf(source, r), []);
      checkParts(source, r);
      const nr = Object.fromEntries(r.spends.filter((s) => s.outcome === 'not-replayable').map((s) => [s.intent, s.detail]));
      assert.deepEqual(Object.keys(nr).map(Number), [5, 6], JSON.stringify(o));
      assert.match(nr[5], /CSL counts 2000000 lovelace of deposits, the transaction 3000000/);
      assert.match(nr[6], /body field 6/);
      assert.equal(r.summary.counts.notReplayable, 2);
      const built = (i) => r.spends.find((s) => s.intent === i && s.outcome === 'built');
      if (strategy === 'lf') for (const i of [0, 1, 2, 3, 4, 7]) assert.ok(built(i), `${r.name} ${changePolicy}: intent ${i}: ${r.spends[i].outcome} ${r.spends[i].class} ${r.spends[i].detail}`);
      const tx = (i) => built(i) && inspectTx(built(i).built.txs[0].bytes);
      if (tx(0)) {
        assert.equal(tx(0).redeemers.length, 1);
        // Body field 11: BLAKE2b-256 over the redeemers and datums as written.
        const d = tx(0).tx;
        const hash = blake2b256(Buffer.concat([d.wits.fields.get(5).raw, d.wits.fields.get(4).raw]));
        assert.deepEqual(Buffer.from(d.body.fields.get(11).raw).subarray(-32), hash);
      }
      if (tx(1)) {
        assert.deepEqual(tx(1).mint, [{ policy, name: '4d', qty: 5n }]);
        assert.deepEqual(tx(1).referenceInputs.map((x) => x.ref), [refIn.ref]);
      }
      if (tx(2)) assert.deepEqual(tx(2).mint, [{ policy: burnPolicy, name: '42', qty: -1n }]);
      if (tx(3)) assert.equal(tx(3).withdrawals.reduce((s, w) => s + w.coin, 0n), 5n * ADA);
      if (tx(4)) assert.equal(tx(4).donation, ADA);
      // The engine left the network id and the empty auxiliary data out.
      if (tx(7)) {
        assert.ok(!tx(7).bodyFields.includes(15) && !tx(7).bodyFields.includes(7));
        assert.equal(tx(7).hasAux, false);
      }
      // CSL prices the script fee itself: its fee covers the final minimum,
      // execution and reference-script terms included.
      for (const f of r.fees) assert.ok(f.fee >= f.finalMinFee, `${f.fee} under ${f.finalMinFee}`);
    }
  }
  t.diagnostic(JSON.stringify(out));
});
