// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The engine's comparison of every built transaction's redeemers with the
// intent's (kit/replay.mjs missingRedeemers, replay/engine.mjs buildOne): by
// tag and by what each redeems, a certificate by its kind and credential
// rather than its place; a method whose transaction lacks one of the intent's
// redeemers fails with "redeemers" named in its detail, whatever the class;
// every replaying method keeps them on script spends. Needs the treatment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatment, skip } from '../../lib/treatment.mjs';
import { replayIntent, payTo, zeroRedeemerIntents } from '../../lib/script-intents.mjs';
import { missingRedeemers, assembleReplayOnce } from '../../../src/kit/replay.mjs';
import { replay } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { decodeTx, assembleTx } from '../../../src/history/tx.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { shapeState } from '../../../src/shapes/shapes.mjs';
import { encUint, encBytes, encArray, head } from '../../../src/history/cbor.mjs';

const T = await treatment();

const sourceOf = (state, intents, params = SYNTHETIC_PARAMS) => ({ wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: state.stakeCred, changeAddress: state.changeAddress, changeAddressEnd: state.changeAddress, franken: new Set(), start: [...state.utxos.values()], events: intents.map((intent, i) => ({ kind: 'intent', txId: i + 1, intent })), arrival: new Map(), windowStart: 0, windowEnd: 1000, params });
const run = (source, method) => replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method, opts: { seed: 1, changePolicy: 'default', collateralRule: 'ledger' }, settleEvery: 25, keepTx: true });

// A delegation certificate (kind 2) of a script stake credential.
const scriptCred = (b) => encArray([encUint(1), encBytes(Buffer.alloc(28, b))]);
const delegation = (b) => encArray([encUint(2), scriptCred(b), encBytes(Buffer.alloc(28, 0x50))]);
const certRedeemer = (index) => encArray([encArray([encUint(2), encUint(index), Buffer.from('00', 'hex'), encArray([encUint(1000), encUint(1000)])])]).toString('hex');

test('the comparison matches redeemers by tag and target, a certificate by its kind and credential, not its place', { skip }, () => {
  const stand = { ref: `${'00'.repeat(32)}#0`, cred: '00'.repeat(28) };
  const certIntent = (order, index) => replayIntent('e1', 10, { type: 'T7', fixed: { body: { 4: encArray(order.map(delegation)).toString('hex') }, witnesses: { 5: certRedeemer(index) }, redeemers: [{ tag: 2, target: { kind: 'certificate', index }, data: '00', exUnits: [1000n, 1000n] }] } });
  const txOf = (it) => decodeTx(Buffer.from(assembleReplayOnce(T, { intent: it, inputs: [stand], change: [], collateral: null, fee: 200000n }).bytes, 'hex'));
  // The intent redeems its second certificate, credential 0xbb.
  const intent = certIntent([0xaa, 0xbb], 1);
  assert.equal(missingRedeemers(intent, txOf(intent)), 0);
  // The same certificates in the other order, the redeemer at 0xbb's place.
  assert.equal(missingRedeemers(intent, txOf(certIntent([0xbb, 0xaa], 0))), 0);
  // A redeemer at 0xaa's place redeems another certificate.
  assert.equal(missingRedeemers(intent, txOf(certIntent([0xbb, 0xaa], 1))), 1);
  // No redeemers at all.
  assert.equal(missingRedeemers(intent, txOf({ ...intent, fixed: { ...intent.fixed, witnesses: {}, redeemers: [] } })), 1);
  // An intent without redeemers lacks none.
  assert.equal(missingRedeemers({ ...intent, fixed: null }, txOf(intent)), 0);
});

// A method that builds with `inner` and then takes the redeemers off its
// transaction (and, with bumpFee, raises the fee by one lovelace, which no
// longer balances).
function dropping(inner, { bumpFee = false } = {}) {
  return {
    ...inner,
    async build(state, intent, params, opts) {
      const r = await inner.build(state, intent, params, opts);
      if (!r.ok) return r;
      const t = r.txs[r.txs.length - 1];
      const tx = decodeTx(Buffer.from(t.bytes, 'hex'));
      const keep = tx.wits.order.filter((k) => k !== 5);
      const wits = Buffer.concat([head(5, keep.length), ...keep.flatMap((k) => [encUint(k), tx.wits.fields.get(k).raw])]);
      let body = tx.body.raw;
      if (bumpFee) {
        const ks = tx.body.order;
        body = Buffer.concat([head(5, ks.length), ...ks.flatMap((k) => [encUint(k), k === 2 ? encUint(t.fee + 1n) : tx.body.fields.get(k).raw])]);
      }
      const bytes = assembleTx({ body, wits, aux: tx.aux ? tx.aux.raw : null, isValid: tx.isValid, alonzo: tx.alonzo }).toString('hex');
      return { ...r, txs: [...r.txs.slice(0, -1), { ...t, bytes, fee: bumpFee ? t.fee + 1n : t.fee }] };
    }
  };
}

const NAMED = /; parts the library did not price: (.*, )?redeemers$/;

test('a method whose transaction lacks one of the intent\'s redeemers fails, its detail naming redeemers, whatever the class; every replaying method keeps them', { skip }, async () => {
  const state = shapeState(T, 'S1').state;
  const stream = loadSource(T, { kind: 'shape', name: 'S1', stream: 'synthetic' });
  const t6 = stream.events.filter((e) => e.kind === 'intent').map((e) => e.intent).find((i) => i.type === 'T6' && i.fixed);
  const intents = [t6, ...zeroRedeemerIntents(T, state), replayIntent('e2', 30, { type: 'T1', requested: [payTo(T, 12, 2000000n)] })];
  const source = sourceOf(state, intents);

  // Every replaying method builds the script spends with all their
  // redeemers, and no detail names redeemers.
  for (const name of ['test-largest-first', 'cjs-rrri', 'csl-lf', 'csl-ri', 'csl-lf-pure', 'csl-ri-pure', 'evo-lf']) {
    const r = await run(source, makeMethod(T, name));
    for (const [i, s] of r.spends.entries()) {
      assert.ok(!/redeemers/.test(s.detail || ''), `${name} ${i}: ${s.detail}`);
      if (s.outcome === 'built') assert.equal(missingRedeemers(intents[i], inspectTx(s.built.txs[0].bytes).tx), 0, `${name} ${i}`);
    }
    // The stream's script hash is not its script's, which CSL refuses.
    assert.ok(r.spends.slice(name.startsWith('csl') ? 1 : 0, 3).every((s) => s.outcome === 'built'), `${name}: ${r.spends.map((s) => s.detail).join(' | ')}`);
  }

  // Taking the redeemers off: the kit's checks otherwise pass, so the
  // failure is class other with the comparison's own detail; with the fee
  // raised too, the kit fails conservation first, class balance, and the
  // detail still names redeemers. A spend without redeemers is unaffected.
  for (const name of ['test-largest-first', 'evo-lf']) {
    const quiet = await run(source, dropping(makeMethod(T, name)));
    for (const s of quiet.spends.slice(0, 3)) {
      assert.deepEqual([s.outcome, s.class], ['failed', CLASSES.other], `${name}: ${s.detail}`);
      assert.match(s.detail, /^kit: redeemers: the transaction lacks 1 of the intent's 1 redeemers; parts the library did not price: redeemers$/);
    }
    assert.equal(quiet.spends[3].outcome, 'built');
    const loud = await run(source, dropping(makeMethod(T, name), { bumpFee: true }));
    for (const s of loud.spends.slice(0, 3)) {
      assert.deepEqual([s.outcome, s.class], ['failed', CLASSES.balance], `${name}: ${s.detail}`);
      assert.match(s.detail, /^kit: conservation: /);
      assert.match(s.detail, NAMED);
    }
    assert.equal(loud.spends[3].outcome, 'failed');
    assert.ok(!/redeemers/.test(loud.spends[3].detail), loud.spends[3].detail);
  }
});
