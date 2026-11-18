// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Cometa's transaction builder (cometa-lf, methods/cometa.mjs): its own
// change (L/own) and UnFrack.It's layout change on the inputs it selected
// (L/layout). The adapter covers every replay part; it is deterministic, and
// its large-first selection breaks ties by the order the UTxOs are given;
// L/own and L/layout select the same inputs; an input set that cannot fund the
// layout change fails with class change-minimum; a library failure is the
// library's under both; any other change policy is refused; a part the
// library has no operation for is written after the build; and each part the
// library cannot express makes the intent not replayable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatment, skip } from '../../lib/treatment.mjs';
import { cometaMethod, buildCometa, classOfCometaError, cometaPlan, spendDeposits, COMETA_VERSION, CARDANO_C_VERSION } from '../../../src/methods/cometa.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { REPLAY_PARTS, REPLAY_COVERAGE, inputOrder } from '../../../src/methods/library.mjs';
import { NOT_REPLAYABLE, choosesOwnCollateral, checkMethod } from '../../../src/methods/contract.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { checkAndApply } from '../../../src/kit/apply.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { withoutLeftovers } from '../../../src/kit/replay.mjs';
import { replay } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { constructState, payIntent, policy, assetName, ADA } from '../../lib/construct.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { executionFee } from '../../../src/history/params.mjs';
import { shapeState } from '../../../src/shapes/shapes.mjs';
import { addressBytes } from '../../../src/history/address.mjs';
import { encodeOutput } from '../../../src/history/output.mjs';
import { blake2b224, blake2b256 } from '../../../src/history/blake2b.mjs';
import { decode, raw, encUint, encInt, encBytes, encArray, encMap, encTag, encText } from '../../../src/history/cbor.mjs';
import { replayIntent, payTo as payToOf, EX_UNITS } from '../../lib/script-intents.mjs';

const P = SYNTHETIC_PARAMS;
const own = { changePolicy: 'default', seed: 1 };
const layout = { changePolicy: 'layout', seed: 1 };
const txid = (n) => n.toString(16).padStart(64, '0');

test('Cometa covers every replay part, is deterministic and is given the collateral set aside', () => {
  assert.deepEqual(REPLAY_COVERAGE.cometa, [...REPLAY_PARTS]);
  const m = checkMethod(cometaMethod(null));
  assert.equal(m.name, 'cometa-lf');
  assert.deepEqual([m.deterministic, m.seeded, choosesOwnCollateral(m)], [true, true, false]);
  assert.equal(COMETA_VERSION, '1.2.0');
  assert.equal(CARDANO_C_VERSION, '1.2.0');
});

test('the library\'s errors map to the failure classes', () => {
  const failed = (m, code) => new Error(`Transaction build failed: ${m} (${code})`);
  assert.equal(classOfCometaError(failed('', 'Insufficient balance')), CLASSES.balance);
  assert.equal(classOfCometaError(failed('', 'Insufficient balance'), { tokenChange: true }), CLASSES.changeMinimum);
  assert.equal(classOfCometaError(failed('', 'Invalid certificate type')), CLASSES.other);
  assert.equal(classOfCometaError(new Error('something else')), CLASSES.other);
});

const T = await treatment();

test('cometa-lf is made by name and refuses a change policy other than its own and the layout change', { skip }, async () => {
  const m = makeMethod(T, 'cometa-lf');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const it = payIntent(T, [{ coin: 3n * ADA }]);
  assert.equal((await m.build(s, it, P, own)).ok, true);
  const r = await m.build(s, it, P, { changePolicy: 'ladder', seed: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.class, CLASSES.other);
  assert.match(r.detail, /its own change or the layout change only/);
});

test('the same bytes on every build, the largest first with ties in the order given, and the same inputs under both changes', { skip }, async () => {
  // The state's order is the transaction ids'; the two 10 ADA UTxOs tie.
  const s = constructState(T, [{ txid: txid(1), coin: 5n * ADA }, { txid: txid(2), coin: 10n * ADA }, { txid: txid(3), coin: 10n * ADA }, { txid: txid(4), coin: 2n * ADA }]);
  const it = payIntent(T, [{ coin: 3n * ADA }]);
  const a = await buildCometa(T, s, it, P, own);
  const a2 = await buildCometa(T, s, it, P, own);
  const b = await buildCometa(T, s, it, P, layout);
  assert.equal(a.ok, true, a.detail);
  assert.equal(a.txs[0].bytes, a2.txs[0].bytes);
  // Sorted by lovelace, descending, with a stable sort: the first of the two
  // 10 ADA UTxOs in the order given covers the payment alone.
  assert.deepEqual(a.txs[0].walletInputs, [inputOrder(s)[1].ref]);
  assert.equal(b.ok, true, b.detail);
  assert.deepEqual(b.txs[0].walletInputs, a.txs[0].walletInputs);
  for (const r of [a, b]) {
    const applied = checkAndApply(s, P, r.txs);
    assert.equal(applied.ok, true, applied.failure && applied.failure.detail);
  }
  // One change output, in the map form; the library's fee covers its size.
  const outs = inspectTx(a.txs[0].bytes).outputs;
  assert.equal(outs.length, 2);
  assert.ok(a.library.fee >= a.library.finalMinFee);
  assert.equal(a.library.priced, 1);
});

test('inputs that cannot fund the layout change fail with change-minimum while the library builds its own', { skip }, async () => {
  const s = constructState(T, [{ coin: 10n * ADA, assets: Array.from({ length: 40 }, (_, i) => ({ policy: policy(`q${i}`), name: assetName('t'), qty: 1n })) }]);
  const it = payIntent(T, [{ coin: 2n * ADA }]);
  const a = await buildCometa(T, s, it, P, own);
  assert.equal(a.ok, true, a.detail);
  assert.equal(checkAndApply(s, P, a.txs).ok, true);
  const b = await buildCometa(T, s, it, P, layout);
  assert.equal(b.ok, false);
  assert.equal(b.class, CLASSES.changeMinimum);
  assert.match(b.detail, /^layout change on the library's inputs: /);
});

test('a library failure under the layout change is the library\'s, as under its own', { skip }, async () => {
  const short = constructState(T, [{ coin: 3n * ADA }]);
  const pay = payIntent(T, [{ coin: 50n * ADA }]);
  const a = await buildCometa(T, short, pay, P, own);
  const b = await buildCometa(T, short, pay, P, layout);
  assert.deepEqual([a.ok, a.class], [false, CLASSES.balance]);
  assert.match(a.detail, /\(Insufficient balance\)$/);
  assert.deepEqual([b.ok, b.class, b.detail], [a.ok, a.class, a.detail]);
  // A token left over whose change output the leftover ADA cannot pay: the
  // padding loop raises the target until the inputs fall short.
  const tokens = constructState(T, [{ coin: 1500000n, assets: [{ policy: policy('c'), name: assetName('t'), qty: 1n }] }]);
  const c = await buildCometa(T, tokens, payIntent(T, [{ coin: 1n * ADA }]), P, own);
  assert.deepEqual([c.ok, c.class], [false, CLASSES.changeMinimum], c.detail);
});

// The engine's replay of `source` by cometa-lf under a change policy, every
// built transaction kept, with the validity checks on.
const replayCometa = (source, changePolicy) => replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: makeMethod(T, 'cometa-lf'), opts: { seed: 1, changePolicy, collateralRule: 'ledger' }, settleEvery: 25, keepTx: true, validity: true });

const intentsOf = (source) => source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);

// The kit's failure of a requested output the library writes in the map form
// at the coin the intent gives, under its minimum in that form.
const requestedMinimum = /^kit: minimum: output \d+: coin \d+ under its minimum \d+/;

test('replayed synthetic streams under both changes: no validity failure, fixed inputs kept, the same inputs', { skip, timeout: 5 * 60 * 1000 }, async (t) => {
  const seen = {};
  for (const name of ['S1', 'M1']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const intents = intentsOf(source);
    const runs = {};
    for (const cp of ['default', 'layout']) {
      const r = await replayCometa(source, cp);
      assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.details));
      for (const s of r.spends) {
        assert.notEqual(s.outcome, NOT_REPLAYABLE, `${name} ${cp} ${s.type}: ${s.detail}`);
        if (s.class === CLASSES.other) assert.match(s.detail, requestedMinimum, `${name} ${cp} ${s.type}`);
        // The legacy stake registration (kind 0) has no operation: written
        // after the build, its deposit unbalanced.
        if (s.class === CLASSES.balance) assert.match(s.detail, /parts the library did not price: certificates/);
      }
      runs[cp] = r;
    }
    // Every spend L/own fails builds under L/layout.
    for (const s of runs.default.spends.filter((x) => x.outcome === 'failed')) assert.equal(runs.layout.spends.find((x) => x.intent === s.intent).outcome, 'built');
    let built = 0;
    let fixed = 0;
    let scripts = 0;
    for (const sb of runs.layout.spends) {
      if (sb.outcome !== 'built') continue;
      built++;
      const intent = withoutLeftovers(intents[sb.intent]);
      if (intent.fixed) fixed++;
      const tx = inspectTx(sb.built.txs[0].bytes);
      for (const x of intent.fixed ? intent.fixed.inputs : []) assert.ok(tx.inputs.some((y) => y.ref === x.ref), `${sb.type}: fixed input missing`);
      // L/own on the same state selects the same wallet inputs.
      const a = await buildCometa(T, sb.built.before, intent, source.params, { ...own, ...(sb.collateralUsed ? { collateral: sb.built.before.utxos.get(tx.collateralInputs[0].ref) || null } : {}) });
      if (sb.collateralUsed) {
        scripts++;
        continue;
      }
      assert.equal(a.ok, true, `${name} ${sb.type}: ${a.detail}`);
      assert.deepEqual(sb.built.txs[0].walletInputs, a.txs[0].walletInputs, `${name} ${sb.type}: inputs`);
    }
    seen[name] = { built, fixed, scripts };
    assert.ok(built >= 1 && fixed >= 1);
  }
  t.diagnostic(JSON.stringify(seen));
});

// A Plutus V3 script, the policy and script stake credential it hashes to,
// and the integer 0 as redeemer data.
const V3 = Buffer.alloc(118, 0x5a);
const V3_HASH = blake2b224(Buffer.concat([Buffer.from([3]), V3])).toString('hex');
const zeroRedeemers = (pointers) => encArray(pointers.map(([tag, index]) => encArray([encUint(tag), encUint(index), Buffer.from('00', 'hex'), encArray([encUint(EX_UNITS[0]), encUint(EX_UNITS[1])])]))).toString('hex');

// A constructed source on the S1 wallet: a required signer of the wallet and
// a validity interval, a Conway registration with a delegation, a donation, a
// Plutus mint and a zero-amount script withdrawal, each with its redeemer, a
// payment carrying an inline datum, and a payment to a datum hash whose datum
// the witness set carries, with no redeemer.
function constructedSource() {
  const state = shapeState(T, 'S1').state;
  const payTo = (i, coin, extra) => payToOf(T, i, coin, extra);
  const stakeCred = encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))]);
  const walletKey = [...state.utxos.values()].find((u) => u.held === null).cred;
  const pool = encBytes(Buffer.alloc(28, 0x50));
  const witness = (k) => encArray([encArray([encBytes(k), encBytes(Buffer.alloc(64, 0x77))])]).toString('hex');
  const net = addressBytes(state.changeAddress)[0] & 15;
  const account = Buffer.concat([Buffer.from([0xf0 | net]), Buffer.from(V3_HASH, 'hex')]).toString('hex');
  const scriptFee = executionFee(P, EX_UNITS[0], EX_UNITS[1]);
  const scripts = { 7: encArray([encBytes(V3)]).toString('hex') };
  // An inline datum: constructor 0 with an indefinite field list.
  const datum = Buffer.from('d8799f4100ff', 'hex');
  const recipient = payTo(2, 3n * ADA);
  const withDatum = encodeOutput({ address: addressBytes(recipient.address), coin: 3n * ADA, assets: [], datum: { kind: 'inline', cbor: datum.toString('hex') } }, 'map');
  // A datum hash, its datum in the witness set: a definite field list.
  const hashed = Buffer.from('d879824100a0', 'hex');
  const hashedHash = blake2b256(hashed).toString('hex');
  const recipient2 = payTo(3, 3n * ADA);
  const withHash = encodeOutput({ address: addressBytes(recipient2.address), coin: 3n * ADA, assets: [], datum: { kind: 'hash', hash: hashedHash } }, 'array');
  const intents = [
    replayIntent('c1', 10, { type: 'T5', requested: [payTo(0, 3n * ADA)], fixed: { body: { 14: encArray([encBytes(Buffer.from(walletKey, 'hex'))]).toString('hex'), 8: encUint(5).toString('hex'), 3: encUint(5000).toString('hex') } } }),
    replayIntent('c2', 20, { type: 'T7', fixed: { body: { 4: encArray([encArray([encUint(7), stakeCred, encUint(P.keyDeposit)]), encArray([encUint(2), stakeCred, pool])]).toString('hex') }, witnesses: { 0: witness(Buffer.alloc(32, 0x73)) } }, implicit: { deposits: P.keyDeposit } }),
    replayIntent('c3', 30, { type: 'T1', requested: [payTo(1, 3n * ADA)], fixed: { body: { 22: encUint(ADA).toString('hex') } }, implicit: { donation: ADA } }),
    replayIntent('c4', 40, {
      type: 'T6',
      requested: [payTo(10, 2n * ADA)],
      fixed: { body: { 9: encMap([[encBytes(Buffer.from(V3_HASH, 'hex')), encMap([[encBytes(Buffer.from('7a', 'hex')), encInt(1n)]])]]).toString('hex') }, witnesses: { ...scripts, 5: zeroRedeemers([[1, 0]]) }, redeemers: [{ tag: 1, target: { kind: 'policy', policy: V3_HASH }, data: '00', exUnits: EX_UNITS }], scriptFee },
      implicit: { mint: [{ policy: V3_HASH, name: '7a', qty: 1n }] },
      collateral: true
    }),
    replayIntent('c5', 50, {
      type: 'T6',
      requested: [payTo(11, 2n * ADA)],
      fixed: { body: { 5: encMap([[encBytes(Buffer.from(account, 'hex')), encUint(0)]]).toString('hex') }, witnesses: { ...scripts, 5: zeroRedeemers([[3, 0]]) }, redeemers: [{ tag: 3, target: { kind: 'withdrawal', account }, data: '00', exUnits: EX_UNITS }], scriptFee },
      collateral: true
    }),
    replayIntent('c6', 60, { type: 'T1', requested: [{ ...recipient, cbor: withDatum.toString('hex'), datum: { kind: 'inline', cbor: datum.toString('hex') } }] }),
    replayIntent('c7', 70, { type: 'T1', requested: [{ ...recipient2, cbor: withHash.toString('hex'), datum: { kind: 'hash', hash: hashedHash } }], fixed: { witnesses: { 4: encArray([hashed]).toString('hex') } } })
  ];
  return { wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: state.stakeCred, changeAddress: state.changeAddress, changeAddressEnd: state.changeAddress, franken: new Set(), start: [...state.utxos.values()], events: intents.map((intent, i) => ({ kind: 'intent', txId: i + 1, intent })), windowStart: 0, windowEnd: 1000, params: P };
}

test('a replayed signer, validity, Conway certificates, a donation, a mint and a withdrawal with redeemers, and datums build under both changes', { skip }, async () => {
  const source = constructedSource();
  for (const cp of ['default', 'layout']) {
    const r = await replayCometa(source, cp);
    assert.equal(r.summary.validity.failed, 0, JSON.stringify(r.summary.validity.details));
    for (const s of r.spends) assert.equal(s.outcome, 'built', `${cp} ${s.type}: ${s.class} ${s.detail}`);
    const txs = r.spends.map((s) => inspectTx(s.built.txs[0].bytes));
    assert.equal(txs[2].donation, ADA);
    // Every script spend carries the set-aside UTxO as its one collateral;
    // the datum-only spend carries none.
    for (const s of r.spends.slice(3, 5)) assert.equal(s.collateralUsed.chosen, 'set-aside');
    assert.equal(txs[6].collateralInputs.length, 0);
    assert.equal(txs[5].outputs[0].datum.cbor, 'd8799f4100ff');
    if (cp === 'default') {
      // The certificates are the library's operations' own, in order.
      assert.deepEqual(txs[1].tx.body.fields.has(4), true);
      assert.deepEqual(r.spends.map((s) => s.built.library ? s.built.library.unpriced : []).flat(), []);
    }
  }
});

// Parts the library has no operation for, written after its build, each on
// a payment from the S1 wallet.
test('a part the library has no operation for is written on its transaction after the build, unpriced', { skip }, async () => {
  const state = shapeState(T, 'S1').state;
  const pay = [payToOf(T, 0, 2n * ADA)];
  // A legacy registration (kind 0) and a delegation: every certificate goes
  // after.
  const stakeCred = encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))]);
  const certs = encArray([encArray([encUint(0), stakeCred]), encArray([encUint(2), stakeCred, encBytes(Buffer.alloc(28, 0x50))])]);
  const a = await buildCometa(T, state, replayIntent('a1', 10, { type: 'T7', requested: pay, fixed: { body: { 4: certs.toString('hex') } }, implicit: { deposits: P.keyDeposit } }), P, own);
  assert.equal(a.ok, true, a.detail);
  assert.deepEqual(a.library.unpriced, ['certificates']);
  assert.equal(Buffer.from(inspectTx(a.txs[0].bytes).tx.body.fields.get(4).raw).toString('hex'), certs.toString('hex'));
  // Auxiliary data carrying a native script: the observed bytes and their
  // hash replace the library's.
  const native = encArray([encUint(0), encBytes(Buffer.alloc(28, 0x52))]);
  const aux = encTag(259, encMap([[encUint(0), encMap([[encUint(674), encText('x')]])], [encUint(1), encArray([native])]]));
  const b = await buildCometa(T, state, replayIntent('a2', 10, { type: 'T1', requested: pay, fixed: { auxiliaryData: aux.toString('hex') } }), P, own);
  assert.equal(b.ok, true, b.detail);
  assert.deepEqual(b.library.unpriced, ['auxiliary data']);
  const n = decode(Buffer.from(b.txs[0].bytes, 'hex'));
  const buf = Buffer.from(b.txs[0].bytes, 'hex');
  assert.equal(raw(buf, n.items[3]).toString('hex'), aux.toString('hex'));
  const hash = n.items[0].entries.find(([k]) => Number(k.value) === 7)[1];
  assert.equal(hash.value.toString('hex'), blake2b256(aux).toString('hex'));
  // A metadatum with a byte string, which the library's JSON cannot carry.
  const bytesMeta = encMap([[encUint(674), encBytes(Buffer.from('00ff', 'hex'))]]);
  const c = await buildCometa(T, state, replayIntent('a3', 10, { type: 'T1', requested: pay, fixed: { auxiliaryData: bytesMeta.toString('hex') } }), P, own);
  assert.deepEqual(c.library.unpriced, ['auxiliary data']);
  // Metadata of text, integers, lists and text-keyed maps is the library's
  // own to write, through setMetadata.
  const meta = encMap([[encUint(674), encMap([[encText('msg'), encArray([encText('héllo'), encInt(-5n)])]])]]);
  const d = await buildCometa(T, state, replayIntent('a4', 10, { type: 'T1', requested: pay, fixed: { auxiliaryData: meta.toString('hex') } }), P, own);
  assert.equal(d.ok, true, d.detail);
  assert.deepEqual(d.library.unpriced, []);
  const dn = decode(Buffer.from(d.txs[0].bytes, 'hex'));
  const md = dn.items[3].mt === 6 ? dn.items[3].item.entries.find(([k]) => Number(k.value) === 0)[1] : dn.items[3];
  const [label, value] = md.entries[0];
  assert.equal(label.value, 674n);
  assert.equal(value.entries[0][1].items[0].value, 'héllo');
  assert.equal(value.entries[0][1].items[1].value, -5n);
});

test('the deposits a spend carries are the library\'s parameters for that spend', () => {
  const stakeCred = encArray([encUint(0), encBytes(Buffer.alloc(28, 0x11))]);
  const certs = (d) => encArray([encArray([encUint(7), stakeCred, encUint(d)])]).toString('hex');
  assert.deepEqual(spendDeposits({ body: { 4: certs(P.keyDeposit) } }, P), {});
  assert.deepEqual(spendDeposits({ body: { 4: certs(3000000n) } }, P), { keyDeposit: 3000000n });
  const two = encArray([encArray([encUint(7), stakeCred, encUint(3000000n)]), encArray([encUint(8), stakeCred, encUint(4000000n)])]).toString('hex');
  assert.deepEqual(spendDeposits({ body: { 4: two } }, P), {});
  assert.deepEqual(spendDeposits(null, P), {});
});

// Parts the library cannot express, each on a payment from the S1 wallet.
test('each part the library cannot express makes the intent not replayable, under both changes', { skip }, async () => {
  const state = shapeState(T, 'S1').state;
  const pay = [payToOf(T, 0, 2n * ADA)];
  const red = (tag, target) => ({ tag, target, data: '00', exUnits: EX_UNITS });
  const stakeCred = encArray([encUint(0), encBytes(Buffer.from(state.stakeCred, 'hex'))]);
  const legacy = encArray([encArray([encUint(0), stakeCred])]);
  // A native script with an indefinite list, which the library writes
  // definite: another script hash.
  const indefinite = Buffer.from('82019fff', 'hex');
  const cases = [
    [{ body: { 6: encArray([encMap([]), encUint(0)]).toString('hex') } }, pay, {}, /^body field 6/],
    [{ body: { 15: encUint(0).toString('hex') } }, pay, {}, /^body field 15/],
    [{ body: { 4: legacy.toString('hex') }, redeemers: [red(2, { kind: 'certificate', index: 0 })] }, pay, {}, /^a certificate no operation of the builder writes/],
    [{ witnesses: { 1: encArray([indefinite]).toString('hex') } }, pay, {}, /^witness-set script [0-9a-f]{56}: the library's script does not keep its hash/],
    [{ redeemers: [red(0, { kind: 'input', ref: `${'c'.repeat(64)}#0` })] }, pay, {}, /^a redeemer whose part the library does not take \(tag 0\)/]
  ];
  const m = makeMethod(T, 'cometa-lf');
  for (const [fixed, requested, implicit, why] of cases) {
    const it = replayIntent('n1', 10, { type: 'T1', requested, fixed, implicit });
    assert.match(cometaPlan(it, P, 'synthetic').refusal, why);
    for (const opts of [own, layout]) {
      const r = await m.build(state, it, P, opts);
      assert.deepEqual([r.ok, r.class], [false, NOT_REPLAYABLE], r.detail);
      assert.match(r.detail, why);
    }
  }
});
