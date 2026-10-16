// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildTransaction, assertTransaction, selectInputs, feeFor, TTL_SLOTS } from '../src/tx.mjs';
import { buildRecord, signRecord, carry, messageLines, auxiliaryData } from '../src/record.mjs';
import { deriveIdentity, mnemonicFromEntropy } from '../src/keys.mjs';
import { containsMarker } from '../src/util.mjs';
import { hex } from './helpers.mjs';

const params = { minFeeA: 44n, minFeeB: 155381n, maxTxSize: 16384, coinsPerUtxoByte: 4310n };
const seeded = (label) => mnemonicFromEntropy(crypto.createHash('sha256').update(label).digest());
const id = deriveIdentity(seeded('tx test signing'), seeded('tx test payment'));
const d = (n) => new Uint8Array(32).fill(n);

async function fixture(nItems = 10, { network = 'preprod' } = {}) {
  const hashed = Array.from({ length: nItems }, (_, i) => ({ digest: d(i + 1), hex: hex(d(i + 1)), name: `f${i}`, type: i === 0 ? 'StudyRegistration' : 'Software', ids: i === 0 ? [{ id: '10.5281/zenodo.1', id_type: 'DOI', relation: 'IsPartOf' }] : undefined }));
  const s = await signRecord(buildRecord({ kind: 'freeze', hashed }), id.signing);
  const { chunks } = carry(s.body);
  const lines = messageLines(hashed, [0]);
  return { s, chunks, lines, aux: auxiliaryData(chunks, lines), network, networkId: network === 'mainnet' ? 1 : 0 };
}

const utxo = (n, coin, extra = {}) => ({ txHash: n.repeat(64).slice(0, 64), index: 0, address: '', coin, assets: [], datumBytes: null, datumHash: null, refScript: null, ...extra });

function expectFor(f, built, address) {
  return { txHash: built.hash, chunks: f.chunks, lines: f.lines, recordBody: f.s.body, maxTxSize: params.maxTxSize, networkId: f.networkId, ttl: built.ttl, params, inputs: built.inputs, outputAddress: address, paymentKeyHash: hex(id.payment.keyHash) };
}

for (const network of ['preprod', 'mainnet']) {
  test(`transaction (${network}): exact fee by fixed point, one change output, every post-build assertion`, async () => {
    const f = await fixture(10, { network });
    const address = id.payment.address(network);
    const utxos = [utxo('a', 3000000n), utxo('b', 2500000n), utxo('c', 5000000n, { assets: [{ policy_id: 'x' }] }), utxo('d', 4000000n, { datumHash: 'ff' }), utxo('e', 4000000n, { refScript: { hash: 'aa' } })];
    const built = buildTransaction({ utxos, outputAddress: address, signer: id.payment.privateKey, networkId: f.networkId, params, ttl: 1000 + TTL_SLOTS, aux: f.aux });
    assert.equal(built.inputs.length, 2, 'only the two pure-ADA UTxOs are spent');
    assert.equal(built.fee, feeFor(params, built.size));
    assert.equal(built.total, 5500000n);
    assert.equal(built.outCoin + built.fee, built.total);
    const r = assertTransaction(built.bytes, expectFor(f, built, address.to_bech32()));
    assert.equal(r.txHash, built.hash);
    assert.ok(r.checks.length >= 30);
    assert.ok(!containsMarker(built.bytes));
  });
}

test('transaction: a large record (60 items) still fits and settles', async () => {
  const f = await fixture(60);
  const address = id.payment.address('preprod');
  const built = buildTransaction({ utxos: [utxo('a', 10000000n)], outputAddress: address, signer: id.payment.privateKey, networkId: 0, params, ttl: 9000, aux: f.aux });
  assert.ok(built.size < params.maxTxSize);
  assertTransaction(built.bytes, expectFor(f, built, address.to_bech32()));
});

test('transaction: refuses with the shortfall when the change would fall below its minimum ADA', async () => {
  const f = await fixture(10);
  assert.throws(
    () => buildTransaction({ utxos: [utxo('a', 1000000n)], outputAddress: id.payment.address('preprod'), signer: id.payment.privateKey, networkId: 0, params, ttl: 9000, aux: f.aux }),
    /below its minimum of \d+; send at least \d+ more lovelace/
  );
  assert.throws(
    () => buildTransaction({ utxos: [utxo('c', 5000000n, { assets: [1] })], outputAddress: id.payment.address('preprod'), signer: id.payment.privateKey, networkId: 0, params, ttl: 9000, aux: f.aux }),
    /no pure-ADA UTxO/
  );
});

test('transaction: the assertions catch a wrong network, a wrong record and a wrong message', async () => {
  const f = await fixture(10);
  const address = id.payment.address('preprod');
  const built = buildTransaction({ utxos: [utxo('a', 9000000n)], outputAddress: address, signer: id.payment.privateKey, networkId: 0, params, ttl: 9000, aux: f.aux });
  const e = expectFor(f, built, address.to_bech32());
  assert.throws(() => assertTransaction(built.bytes, { ...e, networkId: 1 }), /network id/);
  assert.throws(() => assertTransaction(built.bytes, { ...e, recordBody: f.s.bodyNoSigs }), /reassembles/);
  assert.throws(() => assertTransaction(built.bytes, { ...e, lines: ['00'.repeat(32)] }), /exactly as expected|674/);
  assert.throws(() => assertTransaction(built.bytes, { ...e, maxTxSize: 100 }), /max_tx_size/);
  assert.throws(() => assertTransaction(built.bytes, { ...e, paymentKeyHash: '00'.repeat(28) }), /payment key/);
});

test('selectInputs leaves token, datum and reference-script UTxOs alone', () => {
  const { pure, skipped } = selectInputs([utxo('a', 1n), utxo('b', 1n, { assets: [1] }), utxo('c', 1n, { datumBytes: 'd8' }), utxo('d', 1n, { refScript: {} })]);
  assert.equal(pure.length, 1);
  assert.equal(skipped, 3);
});

test('the unfrack.it scanner matches every letter case and nothing else', () => {
  const enc = (s) => new TextEncoder().encode(s);
  for (const s of ['unfrack.it', 'UNFRACK.IT', 'UnFrack.It', 'xxunFRACK.itxx']) assert.ok(containsMarker(enc(s)), s);
  for (const s of ['unfrack it', 'unfrackit', 'unfrack.i', 'nfrack.it']) assert.ok(!containsMarker(enc(s)), s);
});
