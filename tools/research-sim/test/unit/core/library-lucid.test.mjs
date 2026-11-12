// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Lucid Evolution (lucid-lf): its own selection and change at its defaults
// (L/own) and UnFrack.It's layout change on the inputs it selected
// (L/layout). The library sorts by lovelace, fewer units first among equal
// lovelace, the state's order after that; L/own and L/layout select the same
// inputs on the same state; an input set that cannot fund the layout change
// fails with class change-minimum; a library failure is the library's under
// both; any other change policy is refused; the method is deterministic, so
// any seed gives the same bytes; replayed spends with fixed parts and script
// spends build under both changes, with the collateral the library chooses;
// and each part the library cannot express is not replayable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatment, skip } from '../../lib/treatment.mjs';
import { negativeControls, EXPECTED } from '../../lib/controls.mjs';
import { lucidMethod, buildLucid, lucidRefusal } from '../../../src/methods/lucid.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { NOT_REPLAYABLE, choosesOwnCollateral } from '../../../src/methods/contract.mjs';
import { REPLAY_COVERAGE } from '../../../src/methods/library.mjs';
import { checkAndApply, fixedResolver } from '../../../src/kit/apply.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { replay, fixedExtraWitnesses } from '../../../src/replay/engine.mjs';
import { constructState, payIntent, policy, assetName, order, ADA } from '../../lib/construct.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { parseAddress, addressBytes } from '../../../src/history/address.mjs';
import { shapeState } from '../../../src/shapes/shapes.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { executionFee } from '../../../src/history/params.mjs';
import { encUint, encInt, encBytes, encText, encArray, encMap } from '../../../src/history/cbor.mjs';
import { blake2b224 } from '../../../src/history/blake2b.mjs';
import { withoutLeftovers } from '../../../src/kit/replay.mjs';
import { replayIntent, payTo as payToOf, EX_UNITS } from '../../lib/script-intents.mjs';

const T = await treatment();
const P = SYNTHETIC_PARAMS;
const own = { changePolicy: 'default', seed: 1 };
const layout = { changePolicy: 'layout', seed: 1 };
const lucid = (state, intent, opts, params = P) => buildLucid(state, intent, params, opts, { T });

test('lucid-lf is a deterministic study baseline that chooses its own collateral and covers every replay part', { skip }, async () => {
  const m = makeMethod(T, 'lucid-lf');
  assert.deepEqual([m.deterministic, m.seeded, choosesOwnCollateral(m)], [true, true, true]);
  assert.deepEqual([...REPLAY_COVERAGE.lucid], ['fixed', 'collateral', 'implicit', 'outputData']);
  const s = constructState(T, [{ coin: 20n * ADA }, { coin: 8n * ADA }]);
  const it = payIntent(T, [{ coin: 3n * ADA }]);
  assert.equal((await m.build(s, it, P, layout)).ok, true);
  await assert.rejects(lucidMethod().build(s, it, P, own), /the witnesses need the treatment/);
});

test('a change policy other than default and layout is refused, as a failure of class other with the reason', { skip }, async () => {
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const r = await lucid(s, payIntent(T, [{ coin: 3n * ADA }]), { changePolicy: 'ladder', seed: 1 });
  assert.deepEqual([r.ok, r.class], [false, CLASSES.other]);
  assert.match(r.detail, /its own change or the layout change only/);
});

test('the library sorts by lovelace, fewer units first among equal lovelace, then the state\'s order, and takes what covers the payment', { skip }, async () => {
  const tok = [{ policy: policy('a'), name: assetName('t'), qty: 1n }];
  // Equal lovelace: the token UTxO comes first in the state's order, the
  // pure one is taken.
  const s = constructState(T, [{ coin: 10n * ADA, assets: tok, txid: '00'.repeat(32) }, { coin: 10n * ADA, txid: 'ff'.repeat(32) }, { coin: 5n * ADA }]);
  const a = await lucid(s, payIntent(T, [{ coin: 3n * ADA }]), own);
  assert.equal(a.ok, true, a.detail);
  assert.deepEqual(a.txs[0].walletInputs, ['ff'.repeat(32) + '#0']);
  // Equal in both: the state's order decides.
  const t = constructState(T, [{ coin: 10n * ADA, txid: 'ff'.repeat(32) }, { coin: 10n * ADA, txid: '00'.repeat(32) }]);
  const b = await lucid(t, payIntent(T, [{ coin: 3n * ADA }]), own);
  assert.deepEqual(b.txs[0].walletInputs, [order(t)[0]]);
  assert.equal(order(t)[0], '00'.repeat(32) + '#0');
});

// Tokens: one unit each of `n` policies, spread over UTxOs.
const tokenSpecs = (n, perUtxo, coin) => {
  const specs = [];
  for (let i = 0; i < n; i += perUtxo) specs.push({ coin, assets: Array.from({ length: Math.min(perUtxo, n - i) }, (_, j) => ({ policy: policy(`p${i + j}`), name: assetName('t'), qty: 1n })) });
  return specs;
};

test('a battery spend: the same inputs under both changes, both pass the kit, and any seed gives the same bytes', { skip }, async () => {
  const s = constructState(T, [...tokenSpecs(12, 4, 5n * ADA), { coin: 4n * ADA, assets: tokenSpecs(12, 12, 0n)[0].assets }, { coin: 3n * ADA }]);
  const it = payIntent(T, [{ coin: 14n * ADA }]);
  const a = await lucid(s, it, own);
  const b = await lucid(s, it, layout);
  assert.equal(a.ok, true, a.detail);
  assert.equal(b.ok, true, b.detail);
  assert.deepEqual(b.txs[0].walletInputs, a.txs[0].walletInputs);
  assert.ok(inspectTx(b.txs[0].bytes).outputs.length > inspectTx(a.txs[0].bytes).outputs.length);
  for (const r of [a, b]) {
    const applied = checkAndApply(s, P, r.txs);
    assert.equal(applied.ok, true, applied.failure && applied.failure.detail);
  }
  const again = await lucid(s, it, { ...own, seed: 2 });
  assert.equal(again.txs[0].bytes, a.txs[0].bytes);
});

test('inputs that cannot fund the layout change fail with change-minimum while the library builds its own', { skip }, async () => {
  const s = constructState(T, [{ coin: 10n * ADA, assets: Array.from({ length: 40 }, (_, i) => ({ policy: policy(`q${i}`), name: assetName('t'), qty: 1n })) }]);
  const it = payIntent(T, [{ coin: 2n * ADA }]);
  const a = await lucid(s, it, own);
  assert.equal(a.ok, true, a.detail);
  const b = await lucid(s, it, layout);
  assert.deepEqual([b.ok, b.class], [false, CLASSES.changeMinimum]);
  assert.match(b.detail, /^layout change on the library's inputs: /);
});

test('a library failure under the layout change is the library\'s, as under its own', { skip }, async () => {
  const s = constructState(T, [{ coin: 3n * ADA }]);
  const it = payIntent(T, [{ coin: 50n * ADA }]);
  const a = await lucid(s, it, own);
  const b = await lucid(s, it, layout);
  assert.deepEqual([a.ok, a.class], [false, CLASSES.balance]);
  assert.match(a.detail, /Your wallet does not have enough funds to cover the required assets/);
  assert.deepEqual([b.class, b.detail], [a.class, a.detail]);
});

// A Plutus V3 script whose bytes are a CBOR byte string, as a compiled
// script's are on chain, so the library's Script form keeps its hash.
const V3 = encBytes(Buffer.alloc(120, 0x5a));
const V3_HASH = blake2b224(Buffer.concat([Buffer.from([3]), V3])).toString('hex');
const zeroRedeemers = (pointers) => encArray(pointers.map(([tag, index]) => encArray([encUint(tag), encUint(index), Buffer.from('00', 'hex'), encArray([encUint(EX_UNITS[0]), encUint(EX_UNITS[1])])]))).toString('hex');

// A mint and a zero withdrawal under the V3 script, each run by its redeemer.
function scriptIntents(state) {
  const net = addressBytes(state.changeAddress)[0] & 15;
  const account = Buffer.concat([Buffer.from([0xf0 | net]), Buffer.from(V3_HASH, 'hex')]).toString('hex');
  const scriptFee = executionFee(P, EX_UNITS[0], EX_UNITS[1]);
  const scripts = { 7: encArray([encBytes(V3)]).toString('hex') };
  return [
    replayIntent('c1', 10, {
      type: 'T6',
      requested: [payToOf(T, 10, 2n * ADA)],
      fixed: { body: { 9: encMap([[encBytes(Buffer.from(V3_HASH, 'hex')), encMap([[encBytes(Buffer.from('7a', 'hex')), encInt(1n)]])]]).toString('hex') }, witnesses: { ...scripts, 5: zeroRedeemers([[1, 0]]) }, redeemers: [{ tag: 1, target: { kind: 'policy', policy: V3_HASH }, data: '00', exUnits: EX_UNITS }], scriptFee },
      implicit: { mint: [{ policy: V3_HASH, name: '7a', qty: 1n }] },
      collateral: true
    }),
    replayIntent('c2', 20, {
      type: 'T6',
      requested: [payToOf(T, 11, 2n * ADA)],
      fixed: { body: { 5: encMap([[encBytes(Buffer.from(account, 'hex')), encUint(0)]]).toString('hex') }, witnesses: { ...scripts, 5: zeroRedeemers([[3, 0]]) }, redeemers: [{ tag: 3, target: { kind: 'withdrawal', account }, data: '00', exUnits: EX_UNITS }], scriptFee },
      collateral: true
    })
  ];
}

// Fixed parts without scripts: a required signer at a wallet key, a legacy
// registration and a delegation of the wallet's stake key, validity, label
// 674 metadata, and a donation with the current treasury value.
function fixedIntents(state) {
  const stakeCred = encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))]);
  const walletKey = [...state.utxos.values()].find((u) => u.held === null).cred;
  const pool = encBytes(Buffer.alloc(28, 0x50));
  const aux = encMap([[encUint(674), encMap([[encText('msg'), encArray([encText('lucid replay')])]])]]).toString('hex');
  return [
    replayIntent('f1', 10, { type: 'T5', requested: [payToOf(T, 0, 3n * ADA)], fixed: { body: { 14: encArray([encBytes(Buffer.from(walletKey, 'hex'))]).toString('hex'), 3: encUint(5000).toString('hex'), 8: encUint(5).toString('hex') }, auxiliaryData: aux } }),
    replayIntent('f2', 20, { type: 'T7', fixed: { body: { 4: encArray([encArray([encUint(0), stakeCred]), encArray([encUint(2), stakeCred, pool])]).toString('hex') } }, implicit: { deposits: P.keyDeposit } }),
    replayIntent('f3', 30, { type: 'T1', requested: [payToOf(T, 1, 3n * ADA)], fixed: { body: { 21: encUint(1000n * ADA).toString('hex'), 22: encUint(ADA).toString('hex') } }, implicit: { donation: ADA } })
  ];
}

const sourceOf = (state, intents) => ({ wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: state.stakeCred, changeAddress: state.changeAddress, changeAddressEnd: state.changeAddress, franken: new Set(), start: [...state.utxos.values()], events: intents.map((intent, i) => ({ kind: 'intent', txId: i + 1, intent })), windowStart: 0, windowEnd: 1000, params: P });

const replayLucid = (source, changePolicy) => replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: lucidMethod({ T }), opts: { seed: 1, changePolicy, collateralRule: 'ledger' }, settleEvery: 25, keepTx: true, validity: true });

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

test('replayed spends with fixed parts and script spends: built under both changes, the same inputs and the library\'s collateral, and the validity checks pass', { skip, timeout: 5 * 60 * 1000 }, async () => {
  // The fixed parts on S8, the script spends on S1, which holds collateral.
  for (const [state, intents] of [[shapeState(T, 'S8').state, null], [shapeState(T, 'S1').state, 'scripts']].map(([st, k]) => [st, k ? scriptIntents(st) : fixedIntents(st)])) await bothChanges(state, intents);
});

async function bothChanges(state, intents) {
  const source = sourceOf(state, intents);
  const a = await replayLucid(source, 'default');
  const b = await replayLucid(source, 'layout');
  for (const r of [a, b]) {
    for (const s of r.spends) assert.equal(s.outcome, 'built', `${s.type}: ${s.class} ${s.detail}`);
    assert.deepEqual(controlsOf(source, r), []);
    assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.details));
  }
  for (const [i, sa] of a.spends.entries()) {
    const sb = b.spends[i];
    // The layout arm's state at each spend is its own; rebuild L/own there.
    const again = await lucid(sb.built.before, withoutLeftovers(intents[i]), own);
    assert.equal(again.ok, true, again.detail);
    assert.deepEqual(sb.built.txs[0].walletInputs, again.txs[0].walletInputs, `${sa.type} inputs`);
    const ta = inspectTx(again.txs[0].bytes);
    const tb = inspectTx(sb.built.txs[0].bytes);
    assert.deepEqual(tb.collateralInputs.map((x) => x.ref), ta.collateralInputs.map((x) => x.ref));
    if (intents[i].collateral.required) {
      assert.ok(tb.collateralInputs.length >= 1);
      assert.equal(sb.collateralUsed.chosen, 'library');
    }
  }
  if (intents[0].type === 'T5') {
    assert.equal(inspectTx(a.spends[0].built.txs[0].bytes).requiredSigners.length, 1);
    assert.equal(inspectTx(a.spends[2].built.txs[0].bytes).donation, ADA);
  }
}

test('the synthetic streams replay with no validity failure; a script the library hashes otherwise is not replayable', { skip, timeout: 5 * 60 * 1000 }, async () => {
  for (const name of ['S1', 'M1', 'CL1']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    for (const cp of ['default', 'layout']) {
      const r = await replayLucid(source, cp);
      assert.equal(r.summary.validity.failed, 0, `${name} ${cp}`);
      assert.ok(r.spends.some((s) => s.outcome === 'built'));
      for (const s of r.spends) assert.notEqual(s.class, CLASSES.other, `${name} ${cp} ${s.type}: ${s.detail}`);
      const nr = r.spends.filter((s) => s.outcome === NOT_REPLAYABLE);
      for (const s of nr) assert.match(s.detail, /the library reads it to another hash/);
    }
  }
});

test('each part the library cannot express is not replayable, before it builds', { skip }, async () => {
  const state = shapeState(T, 'S8').state;
  const stakeCred = encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))]);
  const certs = (...cs) => ({ body: { 4: encArray(cs).toString('hex') } });
  const datum = encInt(7n);
  const cases = [
    [{ body: { 6: 'a0' } }, /body field 6/],
    [{ body: { 15: '00' } }, /network id/],
    [certs(encArray([encUint(1), stakeCred])), /legacy stake deregistration/],
    [certs(encArray([encUint(7), stakeCred, encUint(P.keyDeposit)])), /Conway stake registration without a redeemer/],
    [certs(encArray([encUint(8), stakeCred, encUint(P.keyDeposit + 1n)])), /deposit or refund of 2000001/],
    [certs(encArray([encUint(5), encBytes(Buffer.alloc(28, 1)), encBytes(Buffer.alloc(28, 2)), encBytes(Buffer.alloc(32, 3))])), /genesis-delegation or MIR/],
    [certs(encArray([encUint(3), encBytes(Buffer.alloc(28, 1))])), /pool registration/],
    [{ body: { 22: encUint(ADA).toString('hex') } }, /donation or a current treasury value without the other/],
    [{ witnesses: { 4: encArray([datum]).toString('hex') } }, /witness-set datum .* that no spent input or requested output takes/],
    [{ witnesses: { 7: encArray([encBytes(Buffer.alloc(120, 0x5a))]).toString('hex') } }, /the library reads it to another hash/]
  ];
  for (const [fixed, re] of cases) {
    const intent = replayIntent('n1', 10, { type: 'T1', requested: [payToOf(T, 0, 3n * ADA)], fixed });
    assert.match(lucidRefusal(intent, P), re);
    const r = await lucid(state, intent, own);
    assert.deepEqual([r.ok, r.class], [false, NOT_REPLAYABLE], String(re));
    assert.match(r.detail, re);
  }
});
