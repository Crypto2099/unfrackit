// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The replay helpers every adapter shares (kit/replay.mjs): the list items of
// an intent part, its required signers, the keys of its fixed vkey witnesses,
// the wallet keys a replayed transaction is witnessed for, the scripts it
// holds and a redeemer's target as a key; the Evolution SDK's redeemer lookup
// through that key; and the fixed witnesses the engine adds to the keys the
// kit reads from a transaction (replay/engine.mjs fixedExtraWitnesses). No
// treatment needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listItems, requiredSigners, fixedWitnessKeys, replayWitnessKeys, intentScripts, redeemerKey, targetKey } from '../../../src/kit/replay.mjs';
import { fixedExtraWitnesses } from '../../../src/replay/engine.mjs';
import { redeemerFinder } from '../../../src/methods/evo.mjs';
import * as E from '@evolution-sdk/evolution';
import { encUint, encBytes, encArray, encMap, encTag } from '../../../src/history/cbor.mjs';
import { blake2b224 } from '../../../src/history/blake2b.mjs';
import { encodeOutput, unspentOutput } from '../../../src/history/output.mjs';

const h28 = (b) => Buffer.alloc(28, b).toString('hex');
const fixedOf = (over = {}) => ({ inputs: [], referenceInputs: [], body: {}, witnesses: {}, redeemers: [], auxiliaryData: null, scriptFee: 0n, fixedBytes: 0, ...over });

test('list items of a list and of a tag-258 set, each as its bytes', () => {
  const items = [encBytes(Buffer.alloc(28, 1)), encArray([encUint(1), encUint(2)])];
  for (const b of [encArray(items), encTag(258, encArray(items))]) {
    assert.deepEqual(listItems(b.toString('hex')).map((x) => x.toString('hex')), items.map((x) => x.toString('hex')));
    assert.deepEqual(listItems(b).map((x) => x.toString('hex')), items.map((x) => x.toString('hex')));
  }
  assert.throws(() => listItems(encMap([]).toString('hex')), /expected a list/);
});

// A vkey witness [vkey, signature] for a 32-byte key of byte b, and its key
// hash.
const vkeyOf = (b) => Buffer.alloc(32, b);
const keyOf = (b) => blake2b224(vkeyOf(b)).toString('hex');
const witnessOf = (b) => encArray([encBytes(vkeyOf(b)), encBytes(Buffer.alloc(64, 0x77))]);

test('required signers, the keys of the fixed witnesses, and the wallet keys a replayed transaction is witnessed for', () => {
  // Two required signers: the first split off (its witness was the wallet's,
  // which the history reader does not keep), the second another party's with
  // its witness among the fixed ones.
  const signers = encTag(258, encArray([encBytes(Buffer.from(keyOf(0xa1), 'hex')), encBytes(Buffer.from(keyOf(0xb2), 'hex'))])).toString('hex');
  const f = fixedOf({ inputs: [{ ref: 'aa#0', walletKey: h28(0xc3) }, { ref: 'bb#1', walletKey: null }], body: { 14: signers }, witnesses: { 0: encArray([witnessOf(0xb2)]).toString('hex') } });
  assert.deepEqual(requiredSigners(f), [keyOf(0xa1), keyOf(0xb2)]);
  assert.deepEqual(requiredSigners(fixedOf()), []);
  assert.deepEqual(requiredSigners(null), []);
  assert.deepEqual([...fixedWitnessKeys(f)], [keyOf(0xb2)]);
  assert.deepEqual([...fixedWitnessKeys(fixedOf({ witnesses: { 0: encTag(258, encArray([witnessOf(1), witnessOf(2)])).toString('hex') } }))], [keyOf(1), keyOf(2)]);
  assert.equal(fixedWitnessKeys(fixedOf()).size, 0);
  assert.equal(fixedWitnessKeys(null).size, 0);
  const inputs = [{ cred: h28(0x01) }, { cred: h28(0x01) }, { cred: h28(0x02) }];
  // The inputs' credentials once each, the held fixed input's wallet key and
  // the split-off signer, though no input is at its key; not the signer whose
  // witness is fixed.
  assert.deepEqual([...replayWitnessKeys(f, { inputs })].sort(), [h28(0x01), h28(0x02), h28(0xc3), keyOf(0xa1)].sort());
  // The collateral's credential.
  const keys = replayWitnessKeys(f, { inputs, collateral: [{ cred: h28(0x0c) }] });
  assert.deepEqual([...keys].sort(), [h28(0x01), h28(0x02), h28(0xc3), h28(0x0c), keyOf(0xa1)].sort());
  // A required signer that is an input's credential counts once.
  const g = fixedOf({ body: { 14: encArray([encBytes(Buffer.alloc(28, 0x01))]).toString('hex') } });
  assert.equal(replayWitnessKeys(g, { inputs }).size, 2);
  assert.equal(replayWitnessKeys(null, { inputs: [] }).size, 0);
});

test('the fixed witnesses beyond the keys the kit reads: a required signer\'s and a fixed input\'s are not counted, a stake key\'s is', () => {
  // A non-wallet fixed input at key 0x4e with its witness, a required
  // signer's witness (0x5f) and a stake key's witness (0x6a).
  const net = 0;
  const inAddr = Buffer.concat([Buffer.from([net]), Buffer.from(keyOf(0x4e), 'hex'), Buffer.alloc(28, 0x99)]);
  const fixedIn = { ref: `${'ee'.repeat(32)}#0`, cbor: unspentOutput('ee'.repeat(32), 0, encodeOutput({ address: inAddr, coin: 2000000n, assets: [] }, 'array')).toString('hex'), walletKey: null };
  const witnesses = { 0: encArray([witnessOf(0x4e), witnessOf(0x5f), witnessOf(0x6a)]).toString('hex') };
  const intent = (body) => ({ fixed: fixedOf({ inputs: [fixedIn], body, witnesses }) });
  assert.deepEqual([...fixedExtraWitnesses(intent({ 14: encTag(258, encArray([encBytes(Buffer.from(keyOf(0x5f), 'hex'))])).toString('hex') }))], [keyOf(0x6a)]);
  // Without the required signer, its witness is one the kit's keys do not
  // account for.
  assert.deepEqual([...fixedExtraWitnesses(intent({}))].sort(), [keyOf(0x5f), keyOf(0x6a)].sort());
  // A split-off signer has no fixed witness, so nothing is taken off.
  assert.equal(fixedExtraWitnesses(intent({ 14: encArray([encBytes(Buffer.from(keyOf(0xa1), 'hex'))]).toString('hex') })).size, 2);
  assert.equal(fixedExtraWitnesses({ fixed: null }).size, 0);
});

test('the scripts an intent holds, by hash: the witness set\'s, then reference scripts', () => {
  const native = encArray([encUint(0), encBytes(Buffer.alloc(28, 0x6b))]);
  const plutus = Buffer.from('4e4d01000033222220051200120011', 'hex');
  const refScript = Buffer.from('46010000220011', 'hex');
  const out = encodeOutput({ address: Buffer.concat([Buffer.from([0x60]), Buffer.alloc(28, 0x11)]), coin: 2000000n, assets: [], scriptRef: { lang: 3, script: refScript.toString('hex') } }, 'map');
  const f = fixedOf({
    witnesses: { 1: encArray([native]).toString('hex'), 6: encTag(258, encArray([encBytes(plutus)])).toString('hex') },
    referenceInputs: [{ ref: `${'ee'.repeat(32)}#0`, cbor: unspentOutput('ee'.repeat(32), 0, out).toString('hex') }]
  });
  const m = intentScripts(f);
  const hash = (lang, b) => blake2b224(Buffer.concat([Buffer.from([lang]), b])).toString('hex');
  assert.deepEqual([...m.keys()], [hash(0, native), hash(2, plutus), hash(3, refScript)]);
  assert.equal(m.get(hash(0, native)).raw.toString('hex'), native.toString('hex'));
  assert.equal(m.get(hash(2, plutus)).raw.toString('hex'), encBytes(plutus).toString('hex'));
  assert.deepEqual(m.get(hash(3, refScript)).ref, { ref: `${'ee'.repeat(32)}#0`, size: refScript.length });
  assert.equal(m.get(hash(3, refScript)).witness, false);
});

test('a redeemer\'s target as a key, and the Evolution SDK\'s lookup through it', () => {
  const account = Buffer.concat([Buffer.from([0xf0]), Buffer.alloc(28, 0x5c)]);
  const voter = encArray([encUint(3), encBytes(Buffer.alloc(28, 0xd7))]).toString('hex');
  const targets = [
    { kind: 'input', ref: `${'ab'.repeat(32)}#3` },
    { kind: 'policy', policy: h28(0x70) },
    { kind: 'certificate', index: 1 },
    { kind: 'withdrawal', account: account.toString('hex') },
    { kind: 'voter', voter },
    { kind: 'proposal', index: 0 }
  ];
  assert.deepEqual(targets.map(targetKey), [`0:${'ab'.repeat(32)}#3`, `1:${h28(0x70)}`, '2:1', `3:${account.toString('hex')}`, `4:${voter}`, '5:0']);
  assert.throws(() => targetKey({ kind: 'nope' }), /unknown redeemer target/);
  const redeemers = targets.map((target, tag) => ({ tag, index: 0, data: encUint(tag).toString('hex'), exUnits: [1n, 1n], target }));
  assert.deepEqual(redeemers.map(redeemerKey), targets.map(targetKey));
  const red = redeemerFinder(fixedOf({ redeemers }));
  const data = (x) => (x.redeemer === undefined ? null : E.Data.toCBORHex(x.redeemer));
  // The withdrawal by the reward account the library reads from the body.
  const [[acct]] = [...E.Withdrawals.fromCBORHex(encMap([[encBytes(account), encUint(5)]]).toString('hex')).withdrawals];
  assert.equal(E.RewardAccount.toHex(acct), account.toString('hex'));
  assert.deepEqual([red.input(targets[0].ref), red.policy(h28(0x70)), red.certificate(1), red.withdrawal(E.RewardAccount.toHex(acct)), red.voter(h28(0xd7)), red.proposal(0)].map(data), redeemers.map((r) => r.data));
  assert.deepEqual(red.certificate(0), {});
  assert.deepEqual(red.withdrawal(Buffer.concat([Buffer.from([0xe0]), Buffer.alloc(28, 0x5c)]).toString('hex')), {});
});
