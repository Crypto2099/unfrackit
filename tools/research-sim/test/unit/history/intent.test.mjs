// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Intents of constructed transactions: requested outputs as observed, raised
// to the minimum, and from an inflow; fixed parts; the implicit values; the
// rebuild check; a self-reorganization, one with a reward withdrawal; and a
// phase-2-invalid transaction.
//
// cardano-serialization-lib comes only through the treatment's cslkit.mjs,
// so these tests run when RESEARCH_SIM_TREATMENT_DIR and
// RESEARCH_SIM_TREATMENT_PINS name the harness directory and its pinned
// digests, and are skipped otherwise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encUint, encBytes, encArray, encMap, encTag } from '../../../src/history/cbor.mjs';
import { encodeOutput } from '../../../src/history/output.mjs';
import { assembleTx, decodeTx } from '../../../src/history/tx.mjs';
import { spendEvent, IntentCheck, raiseToMinimum, atMinimum } from '../../../src/history/intent.mjs';
import { loadTreatmentCsl, minAdaForOutput } from '../../../src/history/csl.mjs';
import { settingsWith } from '../../../src/history/settings.mjs';
import { blake2b224 } from '../../../src/history/blake2b.mjs';
import { encode as bech32encode } from '../../../src/history/bech32.mjs';

const DIR = process.env.RESEARCH_SIM_TREATMENT_DIR;
const PINS = process.env.RESEARCH_SIM_TREATMENT_PINS;
const skip = !DIR || !PINS ? 'set RESEARCH_SIM_TREATMENT_DIR and RESEARCH_SIM_TREATMENT_PINS' : false;

const VK = Buffer.alloc(32, 0x41);
const K = blake2b224(VK).toString('hex');
const STAKE = Buffer.alloc(28, 0x51);
const OTHER = Buffer.alloc(28, 0x61);
const base = (pay, stake) => Buffer.concat([Buffer.from([0x00]), Buffer.from(pay, 'hex'), stake]);
const WALLET_ADDR = base(K, STAKE);
const OTHER_ADDR = base('77'.repeat(28), OTHER);
const NFT = { policy: '99'.repeat(28), name: '4e4654', qty: 1n };
const TXA = 'aa'.repeat(32);
const TXB = 'bb'.repeat(32);
const ep = { protocol_major: 9, min_fee_a: 44, min_fee_b: 155381, key_deposit: '2000000', pool_deposit: '500000000' };
const params = { coinsPerUtxoByte: '4310', priceMem: ['577', '10000'], priceStep: ['721', '10000000'], minFeeRefScriptCostPerByte: ['15', '1'] };

const row = (o) => ({ txOutId: 0, createdTx: 1, consumedTx: null, scriptPay: false, dataHash: null, inlineDatumId: null, refScriptId: null, assets: [], ...o, ref: `${o.txHash}#${o.index}` });

function bundle(tx, extra = {}) {
  const outs = new Map();
  const d = decodeTx(tx);
  return {
    id: 10,
    tx: d,
    row: { hash: d.hash, size: d.size, fee: String(extra.fee), deposit: String(extra.deposit ?? 0), treasury_donation: '0', slot_no: 100, time: 1000, block_index: 0, epoch_no: 300, block_no: 5 },
    consumed: extra.consumed,
    outputs: extra.outputs || outs,
    withdrawals: extra.withdrawals || [],
    mints: [],
    ep
  };
}

async function setup() {
  const CSL = await loadTreatmentCsl(DIR, readFileSync(PINS, 'utf8'));
  const resolved = new Map();
  const a = row({ txHash: TXA, index: 0, coin: 10000000n, address: bech32encode('addr_test', WALLET_ADDR), paymentCred: K, stakeAddressId: 1 });
  const b = row({ txHash: TXB, index: 3, coin: 1500000n, address: bech32encode('addr_test', OTHER_ADDR), paymentCred: '77'.repeat(28), stakeAddressId: 2, assets: [NFT] });
  resolved.set(a.ref, a);
  resolved.set(b.ref, b);
  const ctx = { CSL, settings: settingsWith(), params, resolved, datums: new Map(), scripts: new Map(), nativeRefs: new Map() };
  const w = { saId: 1, franken: new Set(), holdStart: new Map(), holdEnd: new Map(), holdBefore: () => new Map() };
  return { ctx, w, CSL };
}

const input = (h, i) => encArray([encBytes(Buffer.from(h, 'hex')), encUint(i)]);
const wits = (n = 1) => encMap([[encUint(0), encArray([...Array(n)].map((_, i) => encArray([encBytes(i ? Buffer.alloc(32, 0x42 + i) : VK), encBytes(Buffer.alloc(64, 7))])))]]);

test('a purchase-like spend: a raised payment, an inflow, a fixed input', { skip }, async () => {
  const { ctx, w, CSL } = await setup();
  const pay = encodeOutput({ address: OTHER_ADDR, coin: 100000n, assets: [] }, 'array');
  const change = encodeOutput({ address: WALLET_ADDR, coin: 11000000n, assets: [NFT] }, 'array');
  const fee = 10000000n + 1500000n - 100000n - 11000000n;
  const body = encMap([
    [encUint(0), encTag(258, encArray([input(TXA, 0), input(TXB, 3)]))],
    [encUint(1), encArray([pay, change])],
    [encUint(2), encUint(fee)],
    [encUint(3), encUint(5000)]
  ]);
  const tx = assembleTx({ body, wits: wits(2), aux: null, isValid: true, alonzo: true });
  const outputs = new Map([
    [0, row({ txHash: 'x', index: 0, coin: 100000n, address: 'other', paymentCred: '77'.repeat(28), stakeAddressId: 2 })],
    [1, row({ txHash: 'x', index: 1, coin: 11000000n, address: 'wallet', paymentCred: K, stakeAddressId: 1, assets: [NFT] })]
  ]);
  const ev = spendEvent(ctx, w, bundle(tx, { fee, consumed: [`${TXA}#0`, `${TXB}#3`], outputs }));
  assert.equal(ev.kind, 'intent');
  const it = ev.intent;
  assert.equal(it.type, 'T1', 'only ADA is sent; the NFT is received');
  assert.equal(it.requested.length, 2);
  const [raised, inflow] = it.requested;
  assert.equal(raised.index, 0);
  assert.equal(raised.raised.from, 100000n);
  assert.equal(raised.raised.rule, 'babbage-conway');
  assert.equal(raised.coin, minAdaForOutput(Buffer.from(raised.cbor, 'hex'), '4310'));
  assert.deepEqual([inflow.inflow, inflow.from, inflow.index, inflow.assets.length], [true, 1, null, 1]);
  assert.equal(inflow.coin, minAdaForOutput(Buffer.from(inflow.cbor, 'hex'), '4310'));
  assert.deepEqual(it.fixed.inputs.map((x) => x.ref), [`${TXB}#3`]);
  assert.deepEqual(Object.keys(it.fixed.body), ['3']);
  assert.ok(it.fixed.witnesses[0], 'the other party\'s witness is a fixed part');
  assert.equal(it.observed.walletWitnesses.length, 1);
  assert.deepEqual(it.observed.walletInputs.map((x) => x.ref), [`${TXA}#0`]);
  assert.ok(it.fixed.fixedBytes > 0);
  assert.equal(it.collateral.required, false);
});

test('a self-reorganization, and the checks that stop on a wrong part', { skip }, async () => {
  const { ctx, w } = await setup();
  const o1 = encodeOutput({ address: WALLET_ADDR, coin: 4000000n, assets: [] }, 'map');
  const o2 = encodeOutput({ address: WALLET_ADDR, coin: 5800000n, assets: [] }, 'map');
  const fee = 200000n;
  const body = encMap([
    [encUint(0), encArray([input(TXA, 0)])],
    [encUint(1), encArray([o1, o2])],
    [encUint(2), encUint(fee)]
  ]);
  const tx = assembleTx({ body, wits: wits(1), aux: null, isValid: true, alonzo: true });
  const outputs = new Map([
    [0, row({ txHash: 'x', index: 0, coin: 4000000n, address: 'w', paymentCred: K, stakeAddressId: 1 })],
    [1, row({ txHash: 'x', index: 1, coin: 5800000n, address: 'w', paymentCred: K, stakeAddressId: 1 })]
  ]);
  const ev = spendEvent(ctx, w, bundle(tx, { fee, consumed: [`${TXA}#0`], outputs }));
  assert.equal(ev.kind, 'self-reorganization');
  assert.equal(ev.valueChange.coin, 0n);
  assert.throws(() => spendEvent(ctx, w, bundle(tx, { fee: fee + 1n, consumed: [`${TXA}#0`], outputs })), IntentCheck);
  assert.throws(() => spendEvent(ctx, w, bundle(tx, { fee, consumed: [`${TXB}#3`], outputs })), /consumed inputs differ/);
  assert.throws(() => spendEvent(ctx, w, bundle(tx, { fee, deposit: 1, consumed: [`${TXA}#0`], outputs })), /net deposit/);
});

test('a reward withdrawal whose outputs are only the wallet\'s change is a self-reorganization carrying its withdrawal', { skip }, async () => {
  const { ctx, w } = await setup();
  const account = Buffer.concat([Buffer.from([0xe0]), STAKE]);
  const withdrawn = 3000000n;
  const fee = 200000n;
  const o1 = encodeOutput({ address: WALLET_ADDR, coin: 10000000n + withdrawn - fee, assets: [] }, 'array');
  const body = encMap([
    [encUint(0), encArray([input(TXA, 0)])],
    [encUint(1), encArray([o1])],
    [encUint(2), encUint(fee)],
    [encUint(5), encMap([[encBytes(account), encUint(withdrawn)]])]
  ]);
  const tx = assembleTx({ body, wits: wits(1), aux: null, isValid: true, alonzo: true });
  const outputs = new Map([[0, row({ txHash: 'x', index: 0, coin: 10000000n + withdrawn - fee, address: 'w', paymentCred: K, stakeAddressId: 1 })]]);
  const withdrawals = [{ account: account.toString('hex'), coin: withdrawn }];
  const ev = spendEvent(ctx, w, bundle(tx, { fee, consumed: [`${TXA}#0`], outputs, withdrawals }));
  assert.equal(ev.kind, 'self-reorganization');
  assert.equal(ev.withdrawal, withdrawn);
  assert.equal(ev.implicit.withdrawals, withdrawn);
  // The withdrawal is replayed apart, so it is not value the self-
  // reorganization brought in unreplayed.
  assert.equal(ev.valueChange.coin, 0n);
  assert.deepEqual(ev.observed.walletOutputs.map((o) => o.index), [0]);
  assert.throws(() => spendEvent(ctx, w, bundle(tx, { fee, consumed: [`${TXA}#0`], outputs, withdrawals: [] })), /withdrawals differ/);
});

test('a phase-2-invalid spend forfeits its collateral', { skip }, async () => {
  const { ctx, w } = await setup();
  const ret = encodeOutput({ address: WALLET_ADDR, coin: 7000000n, assets: [] }, 'map');
  const body = encMap([
    [encUint(0), encArray([input(TXB, 3)])],
    [encUint(1), encArray([encodeOutput({ address: OTHER_ADDR, coin: 1000000n, assets: [] }, 'map')])],
    [encUint(2), encUint(300000)],
    [encUint(13), encArray([input(TXA, 0)])],
    [encUint(16), ret],
    [encUint(17), encUint(3000000)]
  ]);
  const tx = assembleTx({ body, wits: wits(1), aux: null, isValid: false, alonzo: true });
  const outputs = new Map([[1, row({ txHash: 'x', index: 1, coin: 7000000n, address: 'w', paymentCred: K, stakeAddressId: 1 })]]);
  const ev = spendEvent(ctx, w, bundle(tx, { fee: 3000000n, consumed: [`${TXA}#0`], outputs }));
  const it = ev.intent;
  assert.deepEqual([it.type, it.requested.length, it.fixed, it.collateral.required, it.invalid.forfeit], ['T6', 0, null, true, 3000000n]);
  assert.deepEqual(it.observed.walletOutputs.map((o) => o.index), [1]);
  assert.deepEqual(it.observed.walletInputs.map((x) => x.ref), [`${TXA}#0`]);
});

test('the minimum is measured on the bytes as written, not on CSL\'s re-encoding', { skip }, async () => {
  const { CSL } = await setup();
  const written = encodeOutput({ address: WALLET_ADDR, coin: 2000000n, assets: [NFT] }, 'map');
  const asCsl = (() => {
    const o = CSL.TransactionOutput.from_bytes(Uint8Array.from(written));
    const back = o.to_bytes().length;
    const dc = CSL.DataCost.new_coins_per_byte(CSL.BigNum.from_str('4310'));
    const m = BigInt(CSL.min_ada_for_output(o, dc).to_str());
    return { back, m };
  })();
  assert.equal(asCsl.back, written.length - 2, 'CSL writes the map-form output back as an array, 2 bytes shorter');
  assert.equal(minAdaForOutput(written, '4310'), 4310n * (160n + BigInt(written.length)));
  assert.equal(minAdaForOutput(written, '4310') - asCsl.m, 2n * 4310n);
  const r = raiseToMinimum(written, 100000n, '4310');
  assert.equal(r.coin, minAdaForOutput(r.bytes, '4310'));
  const a = atMinimum({ address: WALLET_ADDR, assets: [NFT] }, 'map', '4310');
  assert.equal(a.coin, minAdaForOutput(a.bytes, '4310'));
});
