// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The records a new record points at (supersedes, research-related) must be
// confirmed records of this identity on the same network; without a run
// directory they are read from chain.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { checkTargets } from '../src/targets.mjs';
import { build } from '../src/build.mjs';
import { ownVerify } from '../src/verify.mjs';
import { recordUri, MANIFEST_FORMAT } from '../src/manifest.mjs';
import { tempHome, tempDir } from './helpers.mjs';
import { prepareRun } from '../src/build.mjs';
import { toHex } from '../src/util.mjs';
import { testIdentity, fakeChain, fakeBlockfrost, fabricateRun, hashedItems, journalConfirmed, blockOf } from './fixtures.mjs';

const VALID = { own: { verdict: 'valid' }, sdk: { verdict: 'valid' }, cli: { verdict: 'valid' } };
const ITEMS = hashedItems([{ type: 'StudyRegistration', document: true, ids: [{ id: '10.5281/zenodo.1', id_type: 'DOI', relation: 'IsPartOf' }] }, { type: 'Software' }]);

async function setup({ extra = { confirmed: { confirmations: 15 }, verified: VALID }, journaled = true, confirmations = 20, identityName = 'rehearsal' } = {}) {
  const store = new Store(tempHome());
  store.ensure();
  const identity = testIdentity(store, identityName);
  const target = await fabricateRun(store, { network: 'preprod', identity, items: ITEMS, extra });
  if (journaled) journalConfirmed(store, 'preprod', target, identity);
  const f = fakeChain('preprod', { txs: { [target.hash]: { cbor: target.cbor, confirmations } } });
  const koios = f.koios({ txHashes: [...store.knownTxHashes('preprod')] });
  return { store, identity, target, f, koios };
}

const retype = (target) => ({ kind: 'retype', supersedes: target.hash });
const check = (s, manifest, hashed = ITEMS, extra = {}) => checkTargets({ store: s.store, koios: s.koios, network: 'preprod', manifest, hashed, publicKeyHex: s.identity.pub.signing_public_key, paymentKeyHash: s.identity.pub.payment_key_hash, ...extra });

test('a confirmed, verified, journaled record of this identity is a valid target', async () => {
  const s = await setup();
  const [t] = await check(s, retype(s.target));
  assert.equal(t.tx_hash, s.target.hash);
  assert.equal(t.source, 'run directory and chain');
  assert.equal(t.confirmations, 20);
});

test('a target whose run records no wait to 15 confirmations is refused', async () => {
  const s = await setup({ extra: { verified: VALID } });
  await assert.rejects(check(s, retype(s.target)), /no wait to 15 confirmations/);
});

test('a target without a verify in which all three verifiers said valid is refused', async () => {
  const s = await setup({ extra: { confirmed: { confirmations: 15 }, verified: { ...VALID, cli: { verdict: 'pending' } } } });
  await assert.rejects(check(s, retype(s.target)), /all said valid/);
});

test('a target the journal does not record as confirmed is refused (built, never submitted)', async () => {
  const s = await setup({ journaled: false });
  await assert.rejects(check(s, retype(s.target)), /journal does not record it as confirmed/);
});

test('a target with fewer than 15 confirmations on Koios is refused', async () => {
  const s = await setup({ confirmations: 3 });
  await assert.rejects(check(s, retype(s.target)), /has 3 confirmations on Koios/);
});

test('a retype must carry the superseded record\'s items in order', async () => {
  const s = await setup();
  await assert.rejects(check(s, retype(s.target), [ITEMS[1], ITEMS[0]]), /carries every item/);
});

test('a research-related URI must name a confirmed record too: an unsubmitted build and an unknown hash are refused', async () => {
  const s = await setup();
  const unsubmitted = await fabricateRun(s.store, { network: 'preprod', identity: s.identity, items: ITEMS, utxoTag: 'b' });
  s.koios.allowTx(unsubmitted.hash);
  await assert.rejects(check(s, { kind: 'scripts', related: [{ uri: recordUri(unsubmitted.hash), relation: 'IsSupplementTo' }] }), /no wait to 15 confirmations/);
  await assert.rejects(check(s, { kind: 'scripts', related: [{ uri: recordUri('9f'.repeat(32)), relation: 'IsSupplementTo' }] }), /has no confirmations on Koios/);
  const [t] = await check(s, { kind: 'scripts', related: [{ uri: recordUri(s.target.hash), relation: 'IsSupplementTo' }] });
  assert.match(t.role, /research-related \(IsSupplementTo\)/);
});

test('with the run directory gone, the superseded record is read from chain, bound to its hash, and its signer checked', async () => {
  const s = await setup();
  fs.rmSync(s.target.dir, { recursive: true });
  const [t] = await check(s, retype(s.target));
  assert.equal(t.source, 'chain');
  await assert.rejects(check(s, retype(s.target), [ITEMS[0]]), /carries every item/, 'the items come from the chain record');
});

test('a target signed by another key is refused', async () => {
  const s = await setup();
  const other = testIdentity(new Store(tempHome()), 'rehearsal', 'another identity');
  await assert.rejects(checkTargets({ store: s.store, koios: s.koios, network: 'preprod', manifest: retype(s.target), hashed: ITEMS, publicKeyHex: other.pub.signing_public_key, paymentKeyHash: s.identity.pub.payment_key_hash }), /is signed by [0-9a-f]{64}, not by this identity/);
});

test('build refuses a retype whose superseded record is not confirmed, after the network guard and before any key is read', async () => {
  const s = await setup({ extra: {}, journaled: false });
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'doc.md'), 'x\n');
  const mpath = path.join(dir, 'm.json');
  fs.writeFileSync(mpath, JSON.stringify({ format: MANIFEST_FORMAT, kind: 'retype', doi: '10.5281/zenodo.1', supersedes: s.target.hash, items: [{ path: 'doc.md', type: 'StudyRegistration', document: true, ids: [{ id: '10.5281/zenodo.1', id_type: 'DOI', relation: 'IsPartOf' }] }] }));
  let read = false;
  const orig = s.store.readMnemonics.bind(s.store);
  s.store.readMnemonics = (n) => {
    read = true;
    return orig(n);
  };
  await assert.rejects(build({ store: s.store, koios: s.koios, cli: {}, manifestPath: mpath, network: 'preprod', identityName: 'rehearsal' }), /no wait to 15 confirmations/);
  assert.equal(read, false);
  assert.equal(s.f.calls[0], '/genesis');
});

test('ownVerify: valid at depth 15, pending below it, failed on another body or another signer, unverifiable when unknown', async () => {
  const s = await setup();
  const block = { block_height: 1000, block_hash: 'bb'.repeat(32), absolute_slot: 5000, epoch_no: 320, epoch_slot: 100, tx_timestamp: 1792000000 };
  s.f.chain.txs[s.target.hash].block = block;
  const key = s.identity.pub.signing_public_key;
  s.f.chain.tip.block_height = 1014;
  assert.equal((await ownVerify({ koios: s.koios, txHash: s.target.hash, expectedBody: s.target.body, expectedSigner: key })).verdict, 'valid');
  s.f.chain.tip.block_height = 1013;
  assert.equal((await ownVerify({ koios: s.koios, txHash: s.target.hash, expectedBody: s.target.body, expectedSigner: key })).verdict, 'pending');
  s.f.chain.tip.block_height = 1014;
  const other = await ownVerify({ koios: s.koios, txHash: s.target.hash, expectedBody: new Uint8Array([0xa0]), expectedSigner: key });
  assert.equal(other.verdict, 'failed');
  assert.match(other.issues.join(), /differs from the run directory/);
  // A bare hash: no body to compare, but the signer must be this home's key.
  const foreignKey = 'cd'.repeat(32);
  const signer = await ownVerify({ koios: s.koios, txHash: s.target.hash, expectedSigner: foreignKey });
  assert.equal(signer.verdict, 'failed');
  assert.match(signer.issues.join(), /not by this home's identity/);
  s.koios.allowTx('9f'.repeat(32));
  assert.equal((await ownVerify({ koios: s.koios, txHash: '9f'.repeat(32), expectedSigner: key })).verdict, 'unverifiable');
});

test('a chain-only target must have been paid by this identity: a replay of its signed body in another\'s transaction is refused', async () => {
  const s = await setup();
  const other = testIdentity(new Store(tempHome()), 'rehearsal', 'replayer');
  // This identity's signed body, carried and paid for by someone else.
  const params = { epoch: 320, protocolMajor: 11, protocolMinor: 0, minFeeA: 44n, minFeeB: 155381n, maxTxSize: 16384, coinsPerUtxoByte: 4310n, tip: { slot: 1000 } };
  const replay = await prepareRun({ manifest: { kind: 'freeze', messageItems: [0] }, hashed: ITEMS, coreOnly: false, id: { signing: s.identity.id.signing, payment: other.id.payment }, utxos: [{ txHash: 'cc'.repeat(32), index: 0, coin: 9000000n, assets: [] }], params, network: 'preprod', ttl: 9000, paymentKeyHash: other.pub.payment_key_hash });
  assert.equal(toHex(replay.signed.body), toHex(s.target.body), 'the same signed body');
  s.f.chain.txs[replay.tx.hash] = { cbor: toHex(replay.tx.bytes), confirmations: 50 };
  await assert.rejects(check(s, retype({ hash: replay.tx.hash })), /was not paid by this identity: its witness is from the key with hash/);
});

test('on mainnet a target needs Blockfrost: its depth there and byte-identical CBOR, and a verify that cross-checked', async () => {
  const store = new Store(tempHome());
  store.ensure();
  const identity = testIdentity(store, 'testfreeze');
  const xcheck = { ...VALID, crosscheck: { ran: true, ok: true } };
  const target = await fabricateRun(store, { network: 'mainnet', identity, items: ITEMS, extra: { confirmed: { confirmations: 15 }, verified: xcheck } });
  journalConfirmed(store, 'mainnet', target, identity);
  const f = fakeChain('mainnet', { txs: { [target.hash]: { cbor: target.cbor, confirmations: 20 } } });
  const koios = f.koios({ txHashes: [target.hash] });
  const block = blockOf({ height: 1000 });
  const args = { store, koios, network: 'mainnet', manifest: retype(target), hashed: ITEMS, publicKeyHex: identity.pub.signing_public_key, paymentKeyHash: identity.pub.payment_key_hash };
  await assert.rejects(checkTargets({ ...args, bf: null }), /cross-checked with Blockfrost/);
  const deep = fakeBlockfrost('mainnet', { txs: { [target.hash]: { cbor: target.cbor, block: block.blockfrost } }, tip: { height: 1014 } });
  const [t] = await checkTargets({ ...args, bf: deep.bf() });
  assert.equal(t.blockfrost_depth, 15);
  const shallow = fakeBlockfrost('mainnet', { txs: { [target.hash]: { cbor: target.cbor, block: block.blockfrost } }, tip: { height: 1013 } });
  await assert.rejects(checkTargets({ ...args, bf: shallow.bf() }), /14 blocks deep on Blockfrost/);
  const differs = fakeBlockfrost('mainnet', { txs: { [target.hash]: { cbor: target.cbor.replace(/.{2}$/, '00'), block: block.blockfrost } }, tip: { height: 1014 } });
  await assert.rejects(checkTargets({ ...args, bf: differs.bf() }), /CBOR differs between Koios and Blockfrost/);
  // A mainnet target whose verify did not cross-check is refused.
  const report = JSON.parse(fs.readFileSync(path.join(target.dir, 'report.json'), 'utf8'));
  store.updateRunFile(target.dir, 'report.json', JSON.stringify({ ...report, verified: VALID }));
  await assert.rejects(checkTargets({ ...args, bf: deep.bf() }), /did not cross-check the chain facts with Blockfrost/);
  store.updateRunFile(target.dir, 'report.json', JSON.stringify({ ...report, verified: { ...VALID, crosscheck: { ran: true, ok: false, issues: ['x'] } } }));
  await assert.rejects(checkTargets({ ...args, bf: deep.bf() }), /Koios and Blockfrost in disagreement/);
});
