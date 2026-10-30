// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// CBOR, BLAKE2b, Bech32, addresses and CIP-67 labels.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decode, head, headSize, encUint, encInt, encBytes, encArray, encMap, encTag, setItems } from '../../../src/history/cbor.mjs';
import { blake2b, blake2b256, blake2b224 } from '../../../src/history/blake2b.mjs';
import { decode as bech32decode, encode as bech32encode } from '../../../src/history/bech32.mjs';
import { parseAddress, base58decode, rewardAddress } from '../../../src/history/address.mjs';
import { cip67Label, cip67Prefix, isFungible, crc8 } from '../../../src/history/cip67.mjs';

test('CBOR heads are shortest and their sizes match', () => {
  for (const n of [0n, 23n, 24n, 255n, 256n, 65535n, 65536n, 4294967295n, 4294967296n, (1n << 64n) - 1n]) {
    const h = head(0, n);
    assert.equal(h.length, headSize(n));
    assert.equal(decode(h).value, n);
  }
  assert.equal(decode(encInt(-1n)).value, -1n);
  assert.equal(decode(encInt(-500n)).value, -500n);
});

test('CBOR keeps every span, through indefinite lengths and tags', () => {
  // [_ 1, h'0102', {_ 2: "a"}, 258([3])]
  const b = Buffer.from('9f0142010 2bf0261 61ffd90102 8103ff'.replace(/ /g, ''), 'hex');
  const n = decode(b);
  assert.equal(n.indefinite, true);
  assert.equal(n.items.length, 4);
  assert.deepEqual(n.items[1].value, Buffer.from([1, 2]));
  assert.equal(n.items[2].indefinite, true);
  assert.equal(n.items[2].entries[0][1].value, 'a');
  assert.deepEqual(setItems(n.items[3]).map((x) => x.value), [3n]);
  assert.equal(b.subarray(n.items[3].s, n.items[3].e).toString('hex'), 'd901028103');
  assert.throws(() => decode(Buffer.from('0100', 'hex')), /trailing/);
  // An indefinite byte string's chunks are joined.
  assert.deepEqual(decode(Buffer.from('5f4101420203ff', 'hex')).value, Buffer.from([1, 2, 3]));
});

test('CBOR encoders', () => {
  assert.equal(encArray([encUint(1), encBytes(Buffer.alloc(0))]).toString('hex'), '820140');
  assert.equal(encMap([[encUint(0), encUint(1)]]).toString('hex'), 'a10001');
  assert.equal(encTag(24, encBytes(Buffer.from([0xa0]))).toString('hex'), 'd81841a0');
});

test('BLAKE2b against Node and known digests', () => {
  assert.equal(blake2b256(Buffer.alloc(0)).toString('hex'), '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8');
  assert.equal(blake2b256(Buffer.from('abc')).toString('hex'), 'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319');
  for (const len of [0, 1, 127, 128, 129, 255, 256, 1000, 16384]) {
    const data = Buffer.alloc(len, 0x5a);
    for (let i = 0; i < len; i++) data[i] = (i * 31 + 7) & 0xff;
    assert.equal(blake2b(data, 64).toString('hex'), createHash('blake2b512').update(data).digest('hex'), `length ${len}`);
  }
  assert.equal(blake2b224(Buffer.alloc(32)).length, 28);
});

// CIP-19 test vectors (CIPs at 4fa39658c9c0e95a13e2957a88afd353b48b5452,
// CIP-0019/README.md, "Test Vectors"): every vector uses one payment key,
// one stake key and one script, so the parts must agree across types, and
// the type-14 vector is the stake key's reward address.
test('CIP-19 addresses parse into their parts', () => {
  const p = (a) => parseAddress(bech32decode(a).bytes);
  const t0 = p('addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae');
  const t1 = p('addr1z8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gten0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs9yc0hh');
  const t2 = p('addr1yx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerkr0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs2z78ve');
  const t3 = p('addr1x8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gt7r0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shskhj42g');
  const t4 = p('addr1gx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5pnz75xxcrzqf96k');
  const t6 = p('addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8');
  const t7 = p('addr1w8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtcyjy7wx');
  assert.deepEqual([t0.type, t0.network, t0.paymentKind, t0.stakeKind], [0, 0, 'key', 'key']);
  assert.deepEqual([t1.type, t1.network, t1.paymentKind, t1.stakeKind], [1, 1, 'script', 'key']);
  assert.deepEqual([t2.paymentKind, t2.stakeKind, t3.paymentKind, t3.stakeKind], ['key', 'script', 'script', 'script']);
  assert.deepEqual([t4.type, t4.stakeKind, t6.type, t6.stakeKind, t7.paymentKind], [4, 'pointer', 6, null, 'script']);
  const pay = t0.payment;
  const script = t1.payment;
  for (const x of [t2, t4, t6]) assert.equal(x.payment, pay);
  for (const x of [t3, t7]) assert.equal(x.payment, script);
  assert.equal(t2.stake, script);
  assert.equal(t1.stake, t0.stake);
  assert.equal(bech32encode('stake_test', rewardAddress('key', t0.stake, 0)), 'stake_test1uqehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gssrtvn');
  assert.equal(bech32encode('stake', rewardAddress('script', script, 1)), 'stake178phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtcccycj5');
});

test('Base58 decodes a Byron address to CBOR', () => {
  // The Byron example of CIP-19, "User-facing Encoding".
  const b = base58decode('37btjrVyb4KDXBNC4haBVPCrro8AQPHwvCMp3RFhhSVWwfFmZ6wwzSK6JK1hY6wHNmtrpTf1kdbva8TCneM2YsiXT7mrzT21EacHnPpz5YyUdj64na');
  assert.equal(b[0] >> 4, 8);
  assert.equal(parseAddress(b).type, 8);
  assert.equal(decode(b).mt, 4);
});

// CIP-67 test vectors (CIP-0067/README.md, "Test Vectors") and the registry
// prefixes (CIP-0067/registry.json; CIP-68 "Labels").
const VECTORS = { 0: '00000000', 1: '00001070', 23: '00017650', 99: '000632e0', 533: '00215410', 2000: '007d0550', 4567: '011d7690', 11111: '02b670b0', 49328: '0c0b0f40', 65535: '0ffff240' };
const REGISTRY = { 100: '000643b0', 222: '000de140', 333: '0014df10', 444: '001bc280', 500: '001f4d70' };

test('CIP-67: the ten test vectors and the five registry prefixes', () => {
  for (const [label, hex] of Object.entries({ ...VECTORS, ...REGISTRY })) {
    assert.equal(cip67Prefix(Number(label)), hex, `prefix of ${label}`);
    assert.equal(cip67Label(hex), Number(label), `label of ${hex}`);
    assert.equal(cip67Label(hex + '47656e546f6b656e'), Number(label), `label of ${hex} with content`);
  }
  assert.equal(crc8([0x00, 0xde]), 0x14);
  assert.equal(cip67Label('000de1'), null, 'shorter than four bytes');
  assert.equal(cip67Label('100de140'), null, 'bracket nibble');
  assert.equal(cip67Label('000de141'), null, 'closing nibble');
  assert.equal(cip67Label('000de150'), null, 'checksum');
});

test('the classification rule', () => {
  const n = (label, rest = '01') => cip67Prefix(label) + rest;
  assert.equal(isFungible(n(333), 1n), true);
  assert.equal(isFungible(n(444), 1n), true);
  for (const l of [100, 222, 500]) {
    assert.equal(isFungible(n(l), 1n), false);
    assert.equal(isFungible(n(l), 2n), true);
  }
  assert.equal(isFungible(n(600), 1n), false, 'a label outside the five falls to the quantity rule');
  assert.equal(isFungible(n(7), 5n), true);
  assert.equal(isFungible('', 1n), false);
  assert.equal(isFungible('414243', 2n), true);
});
