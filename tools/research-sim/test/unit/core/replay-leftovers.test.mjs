// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Builder leftovers: the network id (body field 15) and an auxiliary data
// holding no metadata and no script, with its hash (body field 7), are left
// out of every method's replayed intent (kit/replay.mjs withoutLeftovers,
// applied by the replay engine), while the history reader's rebuild check
// still rebuilds the observed transaction with them. Without the treatment:
// which auxiliary data is empty, in each of its three encodings, and what the
// intent loses. With it: a constructed observed transaction carrying both
// parts passes the reader's rebuild check with both in its intent; payments
// carrying them replay without them by test-largest-first, cardano-js-sdk,
// csl-lf and evo-lf, while an auxiliary data with metadata stays; and a method
// that writes its own empty auxiliary data keeps it and pays for it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptyAuxiliaryData, withoutLeftovers } from '../../../src/kit/replay.mjs';
import { ZERO_IMPLICIT } from '../../../src/state/intent.mjs';
import { encUint, encBytes, encArray, encMap, encTag, encText } from '../../../src/history/cbor.mjs';
import { treatment, skip } from '../../lib/treatment.mjs';

const hexOf = (b) => Buffer.from(b).toString('hex');
const NATIVE = encArray([encUint(0), encBytes(Buffer.alloc(28, 0x11))]);
const MESSAGE = encMap([[encUint(674), encMap([[encText('msg'), encArray([encText('hello')])]])]]);

test('an auxiliary data is empty when it holds no metadata entry and no script, in each encoding', () => {
  const empty = [
    encMap([]),
    encArray([encMap([]), encArray([])]),
    encTag(259, encMap([])),
    encTag(259, encMap([[encUint(0), encMap([])], [encUint(1), encArray([])], [encUint(2), encArray([])], [encUint(3), encArray([])], [encUint(4), encArray([])]]))
  ];
  const kept = [
    MESSAGE,
    encArray([MESSAGE, encArray([])]),
    encArray([encMap([]), encArray([NATIVE])]),
    encTag(259, encMap([[encUint(0), MESSAGE]])),
    encTag(259, encMap([[encUint(1), encArray([NATIVE])]])),
    encTag(259, encMap([[encUint(0), encMap([])], [encUint(3), encArray([encBytes(Buffer.alloc(10, 0x4d))])]]))
  ];
  for (const a of empty) assert.equal(emptyAuxiliaryData(hexOf(a)), true, hexOf(a));
  for (const a of kept) assert.equal(emptyAuxiliaryData(hexOf(a)), false, hexOf(a));
});

const bare = (fixed) => ({ id: 'x', source: 'replay', requested: [], implicit: ZERO_IMPLICIT, fixed: fixed && { inputs: [], referenceInputs: [], body: {}, witnesses: {}, redeemers: [], auxiliaryData: null, scriptFee: 0n, fixedBytes: 0, refScriptBytes: 0, ...fixed }, collateral: { required: false, observed: null } });

test('the intent loses the network id and an empty auxiliary data with their bytes, and keeps every other part', () => {
  const aux = hexOf(encTag(259, encMap([])));
  const it = bare({ body: { 3: '191388', 15: '00' }, auxiliaryData: aux, fixedBytes: 3 + 2 + 35 + 3 });
  const r = withoutLeftovers(it);
  assert.deepEqual(r.fixed.body, { 3: '191388' });
  assert.equal(r.fixed.auxiliaryData, null);
  // Field 15 (2 bytes), field 7 (35 bytes) and the auxiliary data less its
  // null (3 bytes): only the validity field's 3 bytes stay.
  assert.equal(r.fixed.fixedBytes, 3);
  // The intent itself is unchanged, and an intent without leftovers is
  // returned as it is.
  assert.equal(it.fixed.body[15], '00');
  assert.equal(it.fixed.auxiliaryData, aux);
  assert.equal(withoutLeftovers(it), r);
  const message = bare({ auxiliaryData: hexOf(MESSAGE), fixedBytes: 40 });
  assert.equal(withoutLeftovers(message), message);
  const none = bare(null);
  assert.equal(withoutLeftovers(none), none);
});

// The reader, on a constructed transaction (as test/unit/history/intent.test.mjs
// constructs them).
const DIR = process.env.RESEARCH_SIM_TREATMENT_DIR;
const PINS = process.env.RESEARCH_SIM_TREATMENT_PINS;
const readerSkip = !DIR || !PINS ? 'set RESEARCH_SIM_TREATMENT_DIR and RESEARCH_SIM_TREATMENT_PINS' : false;

test('the reader\'s rebuild check rebuilds an observed transaction with its network id and empty auxiliary data, which the intent keeps', { skip: readerSkip }, async () => {
  const { encodeOutput } = await import('../../../src/history/output.mjs');
  const { assembleTx, decodeTx } = await import('../../../src/history/tx.mjs');
  const { spendEvent } = await import('../../../src/history/intent.mjs');
  const { loadTreatmentCsl } = await import('../../../src/history/csl.mjs');
  const { settingsWith } = await import('../../../src/history/settings.mjs');
  const { blake2b224, blake2b256 } = await import('../../../src/history/blake2b.mjs');
  const { encode: bech32encode } = await import('../../../src/history/bech32.mjs');
  const CSL = await loadTreatmentCsl(DIR, readFileSync(PINS, 'utf8'));
  const VK = Buffer.alloc(32, 0x41);
  const K = blake2b224(VK).toString('hex');
  const WALLET = Buffer.concat([Buffer.from([0x00]), Buffer.from(K, 'hex'), Buffer.alloc(28, 0x51)]);
  const OTHER = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(28, 0x77), Buffer.alloc(28, 0x61)]);
  const TXA = 'aa'.repeat(32);
  const row = (o) => ({ txOutId: 0, createdTx: 1, consumedTx: null, scriptPay: false, dataHash: null, inlineDatumId: null, refScriptId: null, assets: [], ...o, ref: `${o.txHash}#${o.index}` });
  const a = row({ txHash: TXA, index: 0, coin: 10000000n, address: bech32encode('addr_test', WALLET), paymentCred: K, stakeAddressId: 1 });
  const ctx = { CSL, settings: settingsWith(), params: { coinsPerUtxoByte: '4310', priceMem: ['577', '10000'], priceStep: ['721', '10000000'], minFeeRefScriptCostPerByte: ['15', '1'] }, resolved: new Map([[a.ref, a]]), datums: new Map(), scripts: new Map(), nativeRefs: new Map() };
  const w = { saId: 1, franken: new Set(), holdStart: new Map(), holdEnd: new Map(), holdBefore: () => new Map() };
  const aux = encTag(259, encMap([]));
  const fee = 200000n;
  const pay = encodeOutput({ address: OTHER, coin: 2000000n, assets: [] }, 'array');
  const change = encodeOutput({ address: WALLET, coin: 10000000n - 2000000n - fee, assets: [] }, 'array');
  const wits = encMap([[encUint(0), encArray([encArray([encBytes(VK), encBytes(Buffer.alloc(64, 7))])])]]);
  const txOf = (leftovers) => {
    const fields = [
      [encUint(0), encTag(258, encArray([encArray([encBytes(Buffer.from(TXA, 'hex')), encUint(0)])]))],
      [encUint(1), encArray([pay, change])],
      [encUint(2), encUint(fee)]
    ];
    if (leftovers) fields.push([encUint(7), encBytes(blake2b256(aux))], [encUint(15), encUint(0)]);
    return assembleTx({ body: encMap(fields), wits, aux: leftovers ? aux : null, isValid: true, alonzo: true });
  };
  const outputs = new Map([
    [0, row({ txHash: 'x', index: 0, coin: 2000000n, address: 'other', paymentCred: '77'.repeat(28), stakeAddressId: 2 })],
    [1, row({ txHash: 'x', index: 1, coin: 10000000n - 2000000n - fee, address: 'wallet', paymentCred: K, stakeAddressId: 1 })]
  ]);
  const eventOf = (tx) => {
    const d = decodeTx(tx);
    return spendEvent(ctx, w, { id: 10, tx: d, row: { hash: d.hash, size: d.size, fee: String(fee), deposit: '0', treasury_donation: '0', slot_no: 100, time: 1000, block_index: 0, epoch_no: 300, block_no: 5 }, consumed: [a.ref], outputs, withdrawals: [], mints: [], ep: { protocol_major: 9, min_fee_a: 44, min_fee_b: 155381, key_deposit: '2000000', pool_deposit: '500000000' } });
  };
  // Both transactions pass the rebuild check (spendEvent throws otherwise).
  const withParts = eventOf(txOf(true));
  const without = eventOf(txOf(false));
  assert.equal(withParts.kind, 'intent');
  const it = withParts.intent;
  assert.equal(it.fixed.body[15], '00');
  assert.equal(it.fixed.auxiliaryData, hexOf(aux));
  assert.equal(without.intent.fixed, null);
  // The observed transaction's 40 bytes of leftovers, which the replayed
  // intent loses with the parts.
  const sizeOf = (tx) => decodeTx(tx).size;
  assert.equal(sizeOf(txOf(true)) - sizeOf(txOf(false)), 40);
  assert.equal(it.fixed.fixedBytes, 40);
  const r = withoutLeftovers(it);
  assert.deepEqual([r.fixed.body, r.fixed.auxiliaryData, r.fixed.fixedBytes], [{}, null, 0]);
});

const T = await treatment();

test('payments carrying a network id and an empty auxiliary data replay without them by every method that replays, and a library\'s own auxiliary data stays', { skip, timeout: 10 * 60 * 1000 }, async () => {
  const { replay } = await import('../../../src/replay/engine.mjs');
  const { makeMethod } = await import('../../../src/methods/registry.mjs');
  const { cjsMethod } = await import('../../../src/methods/cjs.mjs');
  const { cslMethod } = await import('../../../src/methods/csl.mjs');
  const { evoMethod } = await import('../../../src/methods/evo.mjs');
  const { inspectTx } = await import('../../../src/kit/inspect.mjs');
  const { outputBytes } = await import('../../../src/kit/assemble.mjs');
  const { SYNTHETIC_PARAMS: P } = await import('../../../src/kit/params.mjs');
  const { recipientAddress } = await import('../../../src/battery/recipients.mjs');
  const { shapeState } = await import('../../../src/shapes/shapes.mjs');
  const ADA = 1000000n;
  const state = shapeState(T, 'S8').state;
  const payTo = (i, coin) => {
    const address = recipientAddress('synthetic', 500 + i);
    return { cbor: outputBytes(T, { address, coin, assets: [] }).toString('hex'), address, coin, assets: [], datum: null, scriptRef: null, raised: null, wallet: false, scriptPayment: false, index: null, from: null, inflow: false };
  };
  const intentOf = (id, t, fixed) => ({
    ...bare(fixed),
    id: id.padEnd(64, '0'),
    type: 'T1',
    time: { slot: t, blockTime: t, blockIndex: 0, epoch: 0, block: t },
    requested: [payTo(t, 2n * ADA)],
    invalid: null,
    burst: null,
    observed: { tx: id, size: 0, fee: 300000n, epoch: 0, protocolMajor: null, minFeeA: 44n, minFeeB: 155381n, walletInputs: [], walletOutputs: [], walletWitnesses: [] },
    classes: {},
    derived: null,
    meta: null
  });
  const EMPTY = [encTag(259, encMap([])), encMap([]), encArray([encMap([]), encArray([])])].map(hexOf);
  const intents = [
    intentOf('d1', 10, { body: { 15: '00' }, auxiliaryData: EMPTY[0], fixedBytes: 40 }),
    intentOf('d2', 20, { auxiliaryData: EMPTY[1], fixedBytes: 35 }),
    intentOf('d3', 30, { auxiliaryData: EMPTY[2], fixedBytes: 37 }),
    intentOf('d4', 40, { body: { 15: '00' }, fixedBytes: 2 }),
    intentOf('d5', 50, { body: { 15: '00' }, auxiliaryData: hexOf(MESSAGE), fixedBytes: 2 + 35 + MESSAGE.length - 1 })
  ];
  const source = { wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: state.stakeCred, changeAddress: state.changeAddress, changeAddressEnd: state.changeAddress, franken: new Set(), start: [...state.utxos.values()], events: intents.map((intent, i) => ({ kind: 'intent', txId: i + 1, intent })), arrival: new Map(), windowStart: 0, windowEnd: 100, params: P };
  const run = (method) => replay(T, P, source, { arm: 'observed', variant: 'default', repetition: 1, method, opts: { seed: 1, changePolicy: 'default', collateralRule: 'ledger' }, settleEvery: 25, keepTx: true });
  const tlf = makeMethod(T, 'test-largest-first');
  for (const method of [tlf, cjsMethod(T), cslMethod(T, { strategy: 'lf' }), evoMethod()]) {
    const r = await run(method);
    for (const s of r.spends) assert.equal(s.outcome, 'built', `${method.name} ${s.intent}: ${s.class} ${s.detail}`);
    const tx = (i) => inspectTx(r.spends[i].built.txs[0].bytes);
    for (const i of [0, 1, 2, 3]) {
      assert.ok(!tx(i).bodyFields.includes(15), `${method.name} ${i}: network id`);
      assert.ok(!tx(i).bodyFields.includes(7) && !tx(i).hasAux, `${method.name} ${i}: auxiliary data`);
    }
    // The message stays, in the library's encoding; the network id beside it
    // does not.
    assert.ok(tx(4).hasAux && tx(4).bodyFields.includes(7) && !tx(4).bodyFields.includes(15), method.name);
  }
  // The intents the source holds still carry the parts.
  assert.equal(intents[0].fixed.body[15], '00');
  assert.equal(intents[0].fixed.auxiliaryData, EMPTY[0]);

  // A method whose library writes an empty auxiliary data of its own keeps it,
  // and its fee pays for it.
  const own = {
    ...tlf,
    name: 'test-own-aux',
    build(s, intent, params, opts) {
      return tlf.build(s, { ...intent, fixed: { ...(intent.fixed || bare({}).fixed), auxiliaryData: EMPTY[0] } }, params, opts);
    }
  };
  const plain = await run(tlf);
  const mine = await run(own);
  for (const [i, s] of mine.spends.entries()) {
    assert.equal(s.outcome, 'built', `${s.intent}: ${s.detail}`);
    const t = inspectTx(s.built.txs[0].bytes);
    assert.ok(t.hasAux && t.bodyFields.includes(7));
    assert.equal(hexOf(t.tx.aux.raw), EMPTY[0]);
    if (i < 4) assert.ok(s.fee > plain.spends[i].fee, `${s.fee} against ${plain.spends[i].fee}`);
  }
});
