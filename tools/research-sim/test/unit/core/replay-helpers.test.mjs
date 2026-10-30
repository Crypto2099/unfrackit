// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The replay helpers every adapter shares (kit/replay.mjs): the list items of
// an intent part, its required signers, the wallet keys a replayed transaction
// is witnessed for, the scripts it holds and a redeemer's target as a key; and
// the Evolution SDK's redeemer lookup through that key. No treatment needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listItems, requiredSigners, replayWitnessKeys, intentScripts, redeemerKey, targetKey } from '../../../src/kit/replay.mjs';
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

test('required signers, and the wallet keys a replayed transaction is witnessed for', () => {
  const signers = encTag(258, encArray([encBytes(Buffer.alloc(28, 0xa1)), encBytes(Buffer.alloc(28, 0xb2))])).toString('hex');
  const f = fixedOf({ inputs: [{ ref: 'aa#0', walletKey: h28(0xc3) }, { ref: 'bb#1', walletKey: null }], body: { 14: signers } });
  assert.deepEqual(requiredSigners(f), [h28(0xa1), h28(0xb2)]);
  assert.deepEqual(requiredSigners(fixedOf()), []);
  assert.deepEqual(requiredSigners(null), []);
  const inputs = [{ cred: h28(0x01) }, { cred: h28(0x01) }, { cred: h28(0x02) }];
  // The inputs' credentials once each and the held fixed input's wallet key.
  assert.deepEqual([...replayWitnessKeys(f, { inputs })].sort(), [h28(0x01), h28(0x02), h28(0xc3)].sort());
  // The collateral's credential, and only the required signers among the
  // wallet's credentials.
  const keys = replayWitnessKeys(f, { inputs, collateral: [{ cred: h28(0x0c) }], walletCreds: new Set([h28(0xa1), h28(0x01)]) });
  assert.deepEqual([...keys].sort(), [h28(0x01), h28(0x02), h28(0xc3), h28(0x0c), h28(0xa1)].sort());
  // A required signer that is an input's credential counts once.
  const g = fixedOf({ body: { 14: encArray([encBytes(Buffer.alloc(28, 0x01))]).toString('hex') } });
  assert.equal(replayWitnessKeys(g, { inputs, walletCreds: new Set([h28(0x01)]) }).size, 2);
  assert.equal(replayWitnessKeys(null, { inputs: [] }).size, 0);
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
