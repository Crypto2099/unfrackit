// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Values, outputs, transactions and the ImmutableDB format, on constructed
// bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { decode, encUint, encBytes, encArray, encMap, encTag, head, NULL } from '../../../src/history/cbor.mjs';
import { encodeValue, valueSize, decodeValue, sortAssets, mergeAssets, canonicalLine } from '../../../src/history/value.mjs';
import { encodeOutput, decodeOutputBytes, withCoin, unspentOutput, autoForm } from '../../../src/history/output.mjs';
import { decodeTx, assembleTx, inputs, outputs, redeemers, vkeyWitnesses, withdrawals, certificates, mint, compareRewardAccounts } from '../../../src/history/tx.mjs';
import { ImmutableReader, LocalAccess, decodeBlock, parseSecondary, chunkName, ENTRY_SIZE } from '../../../src/history/immutable.mjs';
import { blake2b256, blake2b224 } from '../../../src/history/blake2b.mjs';

const P1 = '11'.repeat(28);
const P2 = '22'.repeat(28);
const addr = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(28, 0xaa), Buffer.alloc(28, 0xbb)]);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('value size equals the length of the ledger encoding, over random values', () => {
  const rnd = mulberry32(7);
  for (let k = 0; k < 300; k++) {
    const assets = [];
    const nPol = Math.floor(rnd() * 5);
    for (let p = 0; p < nPol; p++) {
      const policy = Buffer.alloc(28, Math.floor(rnd() * 256)).toString('hex');
      const nA = 1 + Math.floor(rnd() * 30);
      for (let a = 0; a < nA; a++) {
        const len = Math.floor(rnd() * 33);
        const name = Buffer.alloc(len, Math.floor(rnd() * 256));
        if (len) name[0] = a;
        assets.push({ policy, name: name.toString('hex'), qty: BigInt(Math.floor(rnd() * 2 ** 40)) + 1n });
      }
    }
    const merged = mergeAssets(assets);
    const coin = BigInt(Math.floor(rnd() * 2 ** 50));
    const enc = encodeValue(coin, merged);
    assert.equal(valueSize(coin, merged), enc.length);
    const back = decodeValue(decode(enc));
    assert.equal(back.coin, coin);
    assert.deepEqual(back.assets, sortAssets(merged));
  }
});

test('assets sort by policy bytes, then name bytes', () => {
  const s = sortAssets([
    { policy: P2, name: '00', qty: 1n },
    { policy: P1, name: 'ff', qty: 1n },
    { policy: P1, name: '0001', qty: 1n },
    { policy: P1, name: '01', qty: 1n }
  ]);
  assert.deepEqual(s.map((a) => `${a.policy.slice(0, 2)}.${a.name}`), ['11.0001', '11.01', '11.ff', '22.00']);
  assert.equal(canonicalLine('ab', 3, 5n, s.slice(0, 1)), `ab#3:5:${P1}.0001=1`);
});

test('outputs: both forms, datums and reference scripts round trip', () => {
  const assets = [{ policy: P1, name: '41', qty: 5n }];
  const a = encodeOutput({ address: addr, coin: 2000000n, assets, datum: { kind: 'hash', hash: 'cc'.repeat(32) } }, 'array');
  const da = decodeOutputBytes(a);
  assert.deepEqual([da.form, da.coin, da.datum.hash], ['array', 2000000n, 'cc'.repeat(32)]);
  const plutus = { lang: 2, script: '4e4d01000033222220051200120011' };
  const m = encodeOutput({ address: addr, coin: 3n, assets: [], datum: { kind: 'inline', cbor: 'd87980' }, scriptRef: plutus }, 'map');
  const dm = decodeOutputBytes(m);
  assert.deepEqual([dm.form, dm.datum.kind, dm.datum.cbor, dm.scriptRef.lang, dm.scriptRef.script, dm.scriptRef.size], ['map', 'inline', 'd87980', 2, plutus.script, plutus.script.length / 2]);
  const native = { lang: 0, script: '8200581c' + 'dd'.repeat(28) };
  const dn = decodeOutputBytes(encodeOutput({ address: addr, coin: 3n, assets: [], scriptRef: native }, 'map'));
  assert.deepEqual([dn.scriptRef.lang, dn.scriptRef.script, dn.scriptRef.size], [0, native.script, 32]);
  assert.equal(autoForm({ datum: { kind: 'hash' }, scriptRef: null }), 'array');
  assert.equal(autoForm({ datum: { kind: 'inline' }, scriptRef: null }), 'map');
  assert.throws(() => encodeOutput({ address: addr, coin: 1n, assets: [], scriptRef: native }, 'array'), /map form/);
});

test('withCoin replaces the coin and keeps every other byte', () => {
  const o = encodeOutput({ address: addr, coin: 10n, assets: [{ policy: P1, name: '', qty: 1n }] }, 'map');
  const p = withCoin(o, 1500000n);
  const d = decodeOutputBytes(p);
  assert.equal(d.coin, 1500000n);
  assert.equal(p.length, o.length + 4);
  const u = unspentOutput('ee'.repeat(32), 7, p);
  const n = decode(u);
  assert.equal(n.items[0].items[1].value, 7n);
  assert.deepEqual(u.subarray(n.items[1].s), p);
});

// A constructed Conway-era transaction: two inputs, an output, a fee, a TTL,
// a withdrawal, a certificate, a mint, a vkey witness and redeemers in map
// form.
function sampleTx({ alonzo = true, aux = true, mapRedeemers = true } = {}) {
  const input = (h, i) => encArray([encBytes(Buffer.alloc(32, h)), encUint(i)]);
  const out = encodeOutput({ address: addr, coin: 5000000n, assets: [] }, 'array');
  const body = encMap([
    [encUint(0), encTag(258, encArray([input(2, 1), input(1, 0)]))],
    [encUint(1), encArray([out])],
    [encUint(2), encUint(200000)],
    [encUint(3), encUint(1000)],
    [encUint(4), encArray([encArray([encUint(7), encArray([encUint(0), encBytes(Buffer.alloc(28, 3))]), encUint(2000000)])])],
    [encUint(5), encMap([[encBytes(Buffer.concat([Buffer.from([0xe0]), Buffer.alloc(28, 3)])), encUint(77)]])],
    [encUint(9), encMap([[encBytes(Buffer.alloc(28, 9)), encMap([[encBytes(Buffer.from('41', 'hex')), Buffer.from('20', 'hex')]])]])]
  ]);
  const vk = Buffer.alloc(32, 5);
  const red = mapRedeemers
    ? encMap([[encArray([encUint(0), encUint(1)]), encArray([Buffer.from('d87980', 'hex'), encArray([encUint(10), encUint(20)])])]])
    : encArray([encArray([encUint(1), encUint(0), Buffer.from('d87980', 'hex'), encArray([encUint(3), encUint(4)])])]);
  const wits = encMap([
    [encUint(0), encArray([encArray([encBytes(vk), encBytes(Buffer.alloc(64, 6))])])],
    [encUint(5), red]
  ]);
  const auxb = aux ? encMap([[encUint(674), encMap([[Buffer.from('636d7367', 'hex'), encArray([Buffer.from('6161', 'hex')])]])]]) : null;
  return { body, wits, aux: auxb, vk, bytes: assembleTx({ body, wits, aux: auxb, isValid: true, alonzo }) };
}

test('transactions: parts, size rule, hash, and reassembly from block parts', () => {
  const s = sampleTx();
  const tx = decodeTx(s.bytes);
  assert.equal(tx.alonzo, true);
  assert.equal(tx.hash, blake2b256(s.body).toString('hex'));
  assert.equal(tx.size, s.bytes.length - 1, 'the validity flag is not charged');
  assert.deepEqual(inputs(tx).map((x) => x.ref), [`${'02'.repeat(32)}#1`, `${'01'.repeat(32)}#0`]);
  assert.equal(outputs(tx).length, 1);
  assert.deepEqual(redeemers(tx), [{ tag: 0, index: 1, data: 'd87980', exUnits: [10n, 20n] }]);
  assert.equal(vkeyWitnesses(tx)[0].keyHash, blake2b224(s.vk).toString('hex'));
  assert.deepEqual(withdrawals(tx).map((w) => w.coin), [77n]);
  assert.deepEqual(certificates(tx).map((c) => c.type), [7]);
  assert.deepEqual(mint(tx).map((a) => a.qty), [-1n]);
  const mary = sampleTx({ alonzo: false, aux: false, mapRedeemers: false });
  const tm = decodeTx(mary.bytes);
  assert.equal(tm.size, mary.bytes.length);
  assert.equal(tm.aux, null);
  assert.deepEqual(redeemers(tm), [{ tag: 1, index: 0, data: 'd87980', exUnits: [3n, 4n] }]);
});

// One chunk holding two Conway blocks, with its secondary index.
function chunkFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'research-sim-imm-'));
  const a = sampleTx();
  const b = sampleTx({ aux: false });
  const header = encArray([encUint(0)]);
  const blockOf = (txs, invalid) =>
    encArray([
      encUint(7),
      encArray([
        header,
        encArray(txs.map((t) => t.body)),
        encArray(txs.map((t) => t.wits)),
        encMap(txs.map((t, i) => (t.aux ? [encUint(i), t.aux] : null)).filter(Boolean)),
        encArray(invalid.map((i) => encUint(i)))
      ])
    ]);
  const b1 = blockOf([a, b], [1]);
  const b2 = blockOf([b], []);
  const chunk = Buffer.concat([b1, b2]);
  const entry = (off, blk, slot) => {
    const e = Buffer.alloc(ENTRY_SIZE);
    e.writeBigUInt64BE(BigInt(off), 0);
    e.writeUInt16BE(2, 8);
    e.writeUInt16BE(1, 10);
    e.writeUInt32BE(crc32(blk) >>> 0, 12);
    blake2b256(blk).copy(e, 16);
    e.writeBigUInt64BE(BigInt(slot), 48);
    return e;
  };
  const sec = Buffer.concat([entry(0, b1, 43200 + 5), entry(b1.length, b2, 43200 + 9)]);
  writeFileSync(join(dir, chunkName(2, 'chunk')), chunk);
  writeFileSync(join(dir, chunkName(2, 'secondary')), sec);
  return { dir, a, b, b1, b2, hash1: blake2b256(b1).toString('hex'), hash2: blake2b256(b2).toString('hex') };
}

test('reward accounts in the ledger\'s order: network, a script credential before a key, then the hash', () => {
  // Header 0xe0 | network: a key credential; 0xf0 | network: a script one.
  const acct = (header, byte) => Buffer.concat([Buffer.from([header]), Buffer.alloc(28, byte)]);
  const keyMain = acct(0xe1, 0x01);
  const scriptMain = acct(0xf1, 0xff);
  const keyTest = acct(0xe0, 0xff);
  const scriptTest = acct(0xf0, 0x02);
  const scriptTestLow = acct(0xf0, 0x01);
  const sorted = [keyMain, scriptMain, keyTest, scriptTest, scriptTestLow].sort(compareRewardAccounts);
  assert.deepEqual(sorted.map((b) => b.toString('hex')), [scriptTestLow, scriptTest, keyTest, scriptMain, keyMain].map((b) => b.toString('hex')));
  assert.equal(compareRewardAccounts(keyMain, Buffer.from(keyMain)), 0);
});

test('ImmutableDB: secondary index entries, block decoding, transaction reassembly', async () => {
  const f = chunkFixture();
  const entries = parseSecondary(readFileSync(join(f.dir, chunkName(2, 'secondary'))));
  assert.deepEqual(entries.map((e) => [e.blockOffset, e.slotOrEpoch, e.hash]), [[0, 43205, f.hash1], [f.b1.length, 43209, f.hash2]]);
  assert.throws(() => parseSecondary(Buffer.alloc(57)), /whole number/);
  const dec = decodeBlock(f.b1);
  assert.deepEqual([dec.era, dec.alonzo, dec.txs.length, dec.txs[1].isValid, dec.txs[1].aux], ['conway', true, 2, false, null]);
  const r = new ImmutableReader(new LocalAccess(f.dir));
  const got = await r.readTxs([
    { txId: 1, blockHash: f.hash1, slot: 43205, blockIndex: 0 },
    { txId: 2, blockHash: f.hash1, slot: 43205, blockIndex: 1 },
    { txId: 3, blockHash: f.hash2, slot: 43209, blockIndex: 0 }
  ]);
  assert.deepEqual(got.get(1), f.a.bytes);
  assert.equal(decodeTx(got.get(2)).isValid, false);
  assert.deepEqual(decodeTx(got.get(3)).body.raw, f.b.body);
  await assert.rejects(r.readTxs([{ txId: 4, blockHash: 'ff'.repeat(32), slot: 43205, blockIndex: 0 }]), /not in chunk 2/);
  await assert.rejects(r.readTxs([{ txId: 5, blockHash: f.hash1, slot: 43206, blockIndex: 0 }]), /index gives slot/);
});

test('ImmutableDB: a block whose CRC-32 differs from its index entry is refused', async () => {
  const f = chunkFixture();
  const sec = Buffer.from(readFileSync(join(f.dir, chunkName(2, 'secondary'))));
  sec.writeUInt32BE((sec.readUInt32BE(12) ^ 1) >>> 0, 12);
  writeFileSync(join(f.dir, chunkName(2, 'secondary')), sec);
  const r = new ImmutableReader(new LocalAccess(f.dir));
  await assert.rejects(r.readTxs([{ txId: 1, blockHash: f.hash1, slot: 43205, blockIndex: 0 }]), /CRC-32/);
});

test('the CBOR null and heads used for reassembly', () => {
  assert.equal(NULL.toString('hex'), 'f6');
  assert.equal(head(4, 3).toString('hex'), '83');
});

test('a zero quantity in a multi-asset is not part of the value', () => {
  // { policy: { "": 1, "A": 0 } }, as some pre-Conway outputs carry.
  const v = encArray([encUint(2000000), encMap([[encBytes(Buffer.from(P1, 'hex')), encMap([[encBytes(Buffer.alloc(0)), encUint(1)], [encBytes(Buffer.from('41', 'hex')), encUint(0)]])]])]);
  assert.deepEqual(decodeValue(decode(v)).assets, [{ policy: P1, name: '', qty: 1n }]);
});
