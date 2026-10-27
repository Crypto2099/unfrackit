// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The ledger kit's checks on transactions constructed by hand: each check
// passes on a valid transaction and each failure is caught for its own reason
// and class; value conservation with every kind of implicit value. No CSL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTx, CLASSES, outputMinimum } from '../../../src/kit/check.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { minFee } from '../../../src/kit/fee.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { parseAddress } from '../../../src/history/address.mjs';
import { encUint, encBytes, encArray, encMap } from '../../../src/history/cbor.mjs';
import { valueSize } from '../../../src/history/value.mjs';
import { tx, input, out, baseAddr, scriptAddr, keyHash, withFee, withoutOneWitness, withBodyField } from '../../lib/txcbor.mjs';

const P = SYNTHETIC_PARAMS;
const TXA = 'a1'.repeat(32);
const TXB = 'b2'.repeat(32);
const POL = 'cc'.repeat(28);
const ADDR0 = baseAddr(keyHash(0));
const ADDR1 = baseAddr(keyHash(1));
const EXT = baseAddr('ee'.repeat(28), 'ef'.repeat(28));
const view = (address, coin, assets = []) => ({ coin, assets, addr: parseAddress(address) });

// A balanced transaction at its minimum fee: inputs [{ ref, address, coin,
// assets }], outputs [{ address, coin, assets }] with the last output taking
// the change.
function balanced({ ins, outs, implicit = {}, extra = {}, vkeys, aux = null, scriptFee = 0n }) {
  const coinIn = ins.reduce((s, x) => s + x.coin, 0n) + (implicit.withdrawals || 0n) + (implicit.refunds || 0n);
  const coinOutFixed = outs.slice(0, -1).reduce((s, o) => s + o.coin, 0n) + (implicit.deposits || 0n) + (implicit.donation || 0n);
  let fee = 200000n;
  let bytes;
  for (let i = 0; i < 6; i++) {
    const last = { ...outs[outs.length - 1], coin: coinIn - coinOutFixed - fee };
    const all = [...outs.slice(0, -1), last];
    bytes = tx({ inputs: ins.map((x) => input(...x.ref.split('#').map((v, j) => (j ? Number(v) : v)))), outputs: all.map((o) => out(o.address, o.coin, o.assets || [])), fee, vkeys: vkeys ?? new Set(ins.map((x) => x.address.toString('hex'))).size, extra, aux }).toString('hex');
    const need = minFee(P, inspectTx(bytes).size, scriptFee);
    if (need === fee) break;
    fee = need;
  }
  const resolve = (ref) => {
    const x = ins.find((i) => i.ref === ref);
    return x ? view(x.address, x.coin, x.assets || []) : undefined;
  };
  return { bytes, resolve, fee };
}

const simple = () => balanced({
  ins: [{ ref: `${TXA}#0`, address: ADDR0, coin: 10000000n }, { ref: `${TXB}#3`, address: ADDR1, coin: 5000000n, assets: [{ policy: POL, name: '4e4654', qty: 1n }] }],
  outs: [{ address: EXT, coin: 2000000n }, { address: ADDR0, coin: 0n, assets: [{ policy: POL, name: '4e4654', qty: 1n }] }]
});

test('a balanced transaction at its minimum fee passes every check', () => {
  const t = simple();
  const r = checkTx(t.bytes, { params: P, resolve: t.resolve });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.equal(r.facts.required, 2);
  assert.equal(r.facts.size, inspectTx(t.bytes).serializedSize - 1, 'the ledger size leaves out the validity flag');
  assert.equal(r.facts.minFee, P.minFeeA * BigInt(r.facts.size) + P.minFeeB);
});

test('the fee one lovelace short of the minimum, balance kept, fails the fee check only', () => {
  const t = simple();
  const bad = withFee(t.bytes, t.fee - 1n, 1);
  const r = checkTx(bad, { params: P, resolve: t.resolve });
  assert.deepEqual(r.failures.map((f) => [f.check, f.cls]), [['fee', CLASSES.balance]]);
});

test('one byte over the size limit fails the size check only', () => {
  const t = simple();
  const size = inspectTx(t.bytes).size;
  const r = checkTx(t.bytes, { params: { ...P, maxTxSize: size - 1 }, resolve: t.resolve });
  assert.deepEqual(r.failures.map((f) => [f.check, f.cls]), [['size', CLASSES.txSize]]);
  assert.equal(checkTx(t.bytes, { params: { ...P, maxTxSize: size }, resolve: t.resolve }).ok, true);
});

test('a Value one byte over the limit fails the value-size check only', () => {
  // Names of 32 bytes until the change output's Value is over 200 bytes.
  const assets = Array.from({ length: 6 }, (_, i) => ({ policy: POL, name: Buffer.alloc(32, i + 1).toString('hex'), qty: 1n }));
  const t = balanced({ ins: [{ ref: `${TXA}#1`, address: ADDR0, coin: 20000000n, assets }], outs: [{ address: ADDR0, coin: 0n, assets }] });
  const o = inspectTx(t.bytes).outputs[0];
  const vb = valueSize(o.coin, o.assets);
  assert.equal(checkTx(t.bytes, { params: { ...P, maxValSize: vb }, resolve: t.resolve }).ok, true);
  const r = checkTx(t.bytes, { params: { ...P, maxValSize: vb - 1 }, resolve: t.resolve });
  assert.deepEqual(r.failures.map((f) => [f.check, f.cls]), [['value-size', CLASSES.valueSize]]);
});

test('one vkey witness short fails the witness check only', () => {
  const t = simple();
  const bad = withoutOneWitness(t.bytes);
  const r = checkTx(bad, { params: P, resolve: t.resolve });
  assert.deepEqual(r.failures.map((f) => [f.check, f.cls]), [['witnesses', CLASSES.other]]);
  // Two inputs at one key need one witness.
  const one = balanced({ ins: [{ ref: `${TXA}#0`, address: ADDR0, coin: 3000000n }, { ref: `${TXA}#1`, address: ADDR0, coin: 3000000n }], outs: [{ address: ADDR0, coin: 0n }], vkeys: 1 });
  assert.equal(checkTx(one.bytes, { params: P, resolve: one.resolve }).facts.required, 1);
});

test('an output under its minimum is change-minimum, or other for a requested output', () => {
  const t = balanced({ ins: [{ ref: `${TXA}#0`, address: ADDR0, coin: 1500000n }], outs: [{ address: EXT, coin: 500000n }, { address: ADDR0, coin: 0n }] });
  const r = checkTx(t.bytes, { params: P, resolve: t.resolve });
  const f = r.failures.find((x) => x.check === 'minimum');
  assert.equal(f.cls, CLASSES.changeMinimum);
  assert.equal(checkTx(t.bytes, { params: P, resolve: t.resolve, requested: new Set([0]) }).failures.find((x) => x.check === 'minimum').cls, CLASSES.other);
  const o = inspectTx(t.bytes).outputs[0];
  assert.equal(outputMinimum(P, o.raw.length), 4310n * BigInt(160 + o.raw.length));
});

test('value conservation with withdrawals, refunds, deposits, a donation, a mint and a burn', () => {
  const minted = { policy: 'dd'.repeat(28), name: '4d', qty: 7n };
  const burned = { policy: POL, name: '42', qty: 2n };
  const account = Buffer.concat([Buffer.from([0xe1]), Buffer.from('5a'.repeat(28), 'hex')]);
  const implicit = { withdrawals: 3000000n, refunds: 2000000n, deposits: 500000n, donation: 1000000n, mint: [minted], burn: [burned] };
  const mintField = encMap([
    [encBytes(Buffer.from(POL, 'hex')), encMap([[encBytes(Buffer.from('42', 'hex')), Buffer.from([0x21])]])],
    [encBytes(Buffer.from(minted.policy, 'hex')), encMap([[encBytes(Buffer.from('4d', 'hex')), encUint(7)]])]
  ]);
  const extra = { 5: encMap([[encBytes(account), encUint(3000000)]]), 9: mintField, 22: encUint(1000000) };
  const t = balanced({
    ins: [{ ref: `${TXA}#2`, address: ADDR0, coin: 9000000n, assets: [{ ...burned, qty: 5n }] }],
    outs: [{ address: ADDR0, coin: 0n, assets: [{ ...burned, qty: 3n }, minted] }],
    implicit,
    extra
  });
  const ok = checkTx(t.bytes, { params: P, resolve: t.resolve, implicit });
  assert.equal(ok.ok, true, JSON.stringify(ok.failures));
  for (const [k, v] of [['refunds', 2000001n], ['deposits', 499999n]]) {
    const r = checkTx(t.bytes, { params: P, resolve: t.resolve, implicit: { ...implicit, [k]: v } });
    assert.deepEqual(r.failures.map((f) => [f.check, f.cls]), [['conservation', CLASSES.balance]], k);
  }
  for (const [k, v] of [['withdrawals', 2999999n], ['donation', 1000001n], ['mint', [{ ...minted, qty: 8n }]], ['burn', [{ ...burned, qty: 1n }]]]) {
    const r = checkTx(t.bytes, { params: P, resolve: t.resolve, implicit: { ...implicit, [k]: v } });
    assert.ok(r.failures.length >= 1 && r.failures.every((f) => f.check === 'conservation' && f.cls === CLASSES.balance), k);
  }
});

test('the script fee raises the minimum', () => {
  const t = simple();
  assert.equal(checkTx(t.bytes, { params: P, resolve: t.resolve, scriptFee: 0n }).ok, true);
  const r = checkTx(t.bytes, { params: P, resolve: t.resolve, scriptFee: 1n });
  assert.deepEqual(r.failures.map((f) => f.check), ['fee']);
});

test('an unresolved input, auxiliary data without its hash, and an undecodable transaction', () => {
  const t = simple();
  const r = checkTx(t.bytes, { params: P, resolve: (ref) => (ref.startsWith(TXB) ? undefined : t.resolve(ref)) });
  assert.ok(r.failures.some((f) => f.check === 'inputs' && f.cls === CLASSES.other));
  const noHash = withBodyField(tx({ inputs: [input(TXA, 0)], outputs: [out(ADDR0, 1000000n)], fee: 200000n, aux: Buffer.from([0xa0]) }).toString('hex'), 7, null);
  assert.ok(checkTx(noHash, { params: P, resolve: () => view(ADDR0, 1200000n) }).failures.some((f) => f.check === 'aux-hash'));
  assert.equal(checkTx('00', { params: P, resolve: () => undefined }).failures[0].check, 'decode');
});

test('collateral: count, key address, ADA-only balance, percentage and total', () => {
  const redeemers = encArray([encArray([encUint(0), encUint(0), encUint(0), encArray([encUint(1000), encUint(1000)])])]);
  const collRef = `${TXB}#1`;
  const mk = ({ coll = [collRef], ret = null, total = null }) => {
    const extra = { 13: encArray(coll.map((r) => input(TXB, Number(r.split('#')[1])))) };
    if (ret) extra[16] = ret;
    if (total !== null) extra[17] = encUint(total);
    return tx({ inputs: [input(TXA, 0)], outputs: [out(ADDR0, 9000000n)], fee: 1000000n, extra, witnessExtra: [[5, redeemers]] }).toString('hex');
  };
  const resolveWith = (c) => (ref) => (ref === `${TXA}#0` ? view(ADDR0, 10000000n) : c[ref]);
  const ok = checkTx(mk({}), { params: P, resolve: resolveWith({ [collRef]: view(ADDR0, 5000000n) }) });
  assert.deepEqual(ok.failures.filter((f) => f.check === 'collateral'), []);
  const low = checkTx(mk({}), { params: P, resolve: resolveWith({ [collRef]: view(ADDR0, 1499999n) }) });
  assert.ok(low.failures.some((f) => f.check === 'collateral' && f.cls === CLASSES.collateral && /under 150%/.test(f.detail)));
  const script = checkTx(mk({}), { params: P, resolve: resolveWith({ [collRef]: view(scriptAddr('ab'.repeat(28)), 5000000n) }) });
  assert.ok(script.failures.some((f) => /not at a key address/.test(f.detail)));
  const tok = [{ policy: POL, name: '01', qty: 1n }];
  const withTok = checkTx(mk({}), { params: P, resolve: resolveWith({ [collRef]: view(ADDR0, 5000000n, tok) }) });
  assert.ok(withTok.failures.some((f) => /native assets/.test(f.detail)));
  const returned = checkTx(mk({ ret: out(ADDR0, 2000000n, tok), total: 3000000n }), { params: P, resolve: resolveWith({ [collRef]: view(ADDR0, 5000000n, tok) }) });
  assert.deepEqual(returned.failures.filter((f) => f.check === 'collateral'), []);
  const wrongTotal = checkTx(mk({ ret: out(ADDR0, 2000000n, tok), total: 2999999n }), { params: P, resolve: resolveWith({ [collRef]: view(ADDR0, 5000000n, tok) }) });
  assert.ok(wrongTotal.failures.some((f) => /total collateral/.test(f.detail)));
  const four = ['#1', '#2', '#3', '#4'].map((s) => TXB + s);
  const many = checkTx(mk({ coll: four }), { params: P, resolve: resolveWith(Object.fromEntries(four.map((r) => [r, view(ADDR0, 2000000n)]))) });
  assert.ok(many.failures.some((f) => /4 collateral inputs, limit 3/.test(f.detail)));
  const none = checkTx(tx({ inputs: [input(TXA, 0)], outputs: [out(ADDR0, 9000000n)], fee: 1000000n, witnessExtra: [[5, redeemers]] }).toString('hex'), { params: P, resolve: resolveWith({}) });
  assert.ok(none.failures.some((f) => f.detail === 'no collateral input'));
});
