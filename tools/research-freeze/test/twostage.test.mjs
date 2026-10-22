// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The two-stage freeze: the stage label, the final document's citation of the
// hypotheses record, the draw plan that `wait` and `verify` record, `drawkey`,
// and one final freeze on mainnet.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { checkStage, hashManifest, build } from '../src/build.mjs';
import { checkCitedHypotheses } from '../src/targets.mjs';
import { waitRun, verifyRun, drawKey, submitRun } from '../src/ops.mjs';
import { journal, journalEntry } from '../src/journal.mjs';
import { recordUri, MANIFEST_FORMAT } from '../src/manifest.mjs';
import { tempHome, tempDir } from './helpers.mjs';
import { testIdentity, fakeChain, fakeBlockfrost, fabricateRun, journalConfirmed, blockOf, hashedItems } from './fixtures.mjs';

const VALID = { verdict: 'valid', own: { verdict: 'valid' }, sdk: { verdict: 'valid' }, cli: { verdict: 'valid' } };
const NONCE = '8827df62e1c5f7909885b09cb156d6f1eca8b15eb793fa4758e95c8aa79a1d00';
const sdkValid = async () => ({ verdict: 'valid', issues: [], signers: [] });
const fakeCli = { json: () => ({ status: 0, json: { verdict: 'valid', profile: 'signed', issues: [], signatures: [], record: { items: [] } } }) };

test('stage rules: a freeze names its stage, the hypotheses stage is core-only, other kinds take none', () => {
  assert.throws(() => checkStage({ kind: 'freeze', coreOnly: true }), /needs --stage hypotheses or --stage final/);
  assert.throws(() => checkStage({ kind: 'freeze', stage: 'draft', coreOnly: true }), /must be hypotheses or final/);
  assert.throws(() => checkStage({ kind: 'freeze', stage: 'hypotheses', coreOnly: false }), /core-only/);
  assert.throws(() => checkStage({ kind: 'scripts', stage: 'final' }), /freeze records only/);
  assert.equal(checkStage({ kind: 'freeze', stage: 'final', coreOnly: false }), 'final');
  assert.equal(checkStage({ kind: 'retype' }), null);
});

async function home() {
  const store = new Store(tempHome());
  store.ensure();
  const identity = testIdentity(store, 'rehearsal');
  return { store, identity };
}

async function hypotheses(h, { confirmed = true, utxoTag = 'c' } = {}) {
  const run = await fabricateRun(h.store, { network: 'preprod', identity: h.identity, coreOnly: true, items: hashedItems([{ type: 'StudyRegistration', document: true, ids: [{ id: '10.5281/zenodo.1', id_type: 'DOI', relation: 'IsPartOf' }] }]), utxoTag, extra: confirmed ? { stage: 'hypotheses', confirmed: { confirmations: 15 }, verified: VALID } : { stage: 'hypotheses' } });
  if (confirmed) journalConfirmed(h.store, 'preprod', run, h.identity);
  return run;
}

function finalManifest(h, citeText) {
  const dir = tempDir();
  const doi = '10.5281/zenodo.1';
  fs.writeFileSync(path.join(dir, 'a.mjs'), 'one\n');
  const digest = '2c8b08da5ce60398e1f19af0e5dccc744df274b826abe585eaba68c525434806';
  fs.writeFileSync(path.join(dir, 'doc.md'), `DOI of this document: ${doi}\nSigning public key: ${h.identity.pub.signing_public_key}\n${citeText}\n${digest}  a.mjs\n`);
  const mpath = path.join(dir, 'm.json');
  fs.writeFileSync(mpath, JSON.stringify({ format: MANIFEST_FORMAT, kind: 'freeze', doi, items: [{ path: 'doc.md', type: 'StudyRegistration', document: true, ids: [{ id: doi, id_type: 'DOI', relation: 'IsPartOf' }] }, { path: 'a.mjs', type: 'Software' }] }));
  return mpath;
}

test('the final document must cite a record URI, in lowercase', async () => {
  const h = await home();
  const pk = h.identity.pub.signing_public_key;
  const none = hashManifest({ manifestPath: finalManifest(h, 'No citation here.'), signingPublicKeyHex: pk, stage: 'final' });
  assert.equal(none.doc.ok, false);
  assert.match(none.doc.errors.join(), /cites none/);
  const upper = hashManifest({ manifestPath: finalManifest(h, recordUri('ab'.repeat(32)).replace(/ab/g, 'AB')), signingPublicKeyHex: pk, stage: 'final' });
  assert.match(upper.doc.errors.join(), /uppercase hex/);
  const ok = hashManifest({ manifestPath: finalManifest(h, `Hypotheses record: ${recordUri('ab'.repeat(32))}.`), signingPublicKeyHex: pk, stage: 'final' });
  assert.equal(ok.doc.ok, true, ok.doc.errors.join());
  assert.deepEqual(ok.doc.cited, ['ab'.repeat(32)]);
  const hyp = hashManifest({ manifestPath: finalManifest(h, 'No citation here.'), signingPublicKeyHex: pk, stage: 'hypotheses' });
  assert.equal(hyp.doc.ok, true, 'only the final stage needs a citation');
});

test('the cited hypotheses record must exist, be confirmed and be signed by the same key; exactly one may be cited', async () => {
  const h = await home();
  const H = await hypotheses(h);
  const f = fakeChain('preprod', { txs: { [H.hash]: { cbor: H.cbor, confirmations: 30 } } });
  const koios = f.koios({ txHashes: [...h.store.knownTxHashes('preprod')] });
  const args = { store: h.store, koios, network: 'preprod', publicKeyHex: h.identity.pub.signing_public_key, paymentKeyHash: h.identity.pub.payment_key_hash };
  await assert.rejects(checkCitedHypotheses({ ...args, cited: ['9f'.repeat(32)] }), /cites no hypotheses-stage record/);
  const t = await checkCitedHypotheses({ ...args, cited: ['9f'.repeat(32), H.hash] });
  assert.equal(t.tx_hash, H.hash);
  assert.equal(t.stage, 'hypotheses');
  assert.deepEqual(t.other_cited, ['9f'.repeat(32)]);
  const unconfirmed = await hypotheses(h, { confirmed: false, utxoTag: 'd' });
  await assert.rejects(checkCitedHypotheses({ ...args, cited: [unconfirmed.hash] }), /no wait to 15 confirmations/);
  await assert.rejects(checkCitedHypotheses({ ...args, cited: [H.hash, unconfirmed.hash] }), /cites 2 hypotheses-stage records/);
  f.chain.txs[H.hash].confirmations = 5;
  await assert.rejects(checkCitedHypotheses({ ...args, cited: [H.hash] }), /has 5 confirmations/);
  f.chain.txs[H.hash].confirmations = 30;
  await assert.rejects(checkCitedHypotheses({ ...args, publicKeyHex: 'cd'.repeat(32), cited: [H.hash] }), /not by this identity/);
});

test('build of a final freeze refuses a document whose hypotheses record is unconfirmed, after the guard', async () => {
  const h = await home();
  const unconfirmed = await hypotheses(h, { confirmed: false });
  const f = fakeChain('preprod', { txs: { [unconfirmed.hash]: { cbor: unconfirmed.cbor, confirmations: 30 } } });
  const mpath = finalManifest(h, recordUri(unconfirmed.hash));
  await assert.rejects(build({ store: h.store, koios: f.koios({ txHashes: [...h.store.knownTxHashes('preprod')] }), cli: {}, manifestPath: mpath, network: 'preprod', identityName: 'rehearsal', stage: 'final' }), /no wait to 15 confirmations/);
  assert.equal(f.calls[0], '/genesis');
});

// A final-stage run with its block on both fake providers.
async function finalRun({ epochSlot = 101600, blockfrostBlock, tip = {}, bfTip = {}, epochParams = {}, bfEpochParams = {}, bfGenesis = {}, bfBlockOverride, network = 'preprod', name = 'rehearsal' } = {}) {
  const store = new Store(tempHome());
  store.ensure();
  const identity = testIdentity(store, name);
  const run = await fabricateRun(store, { network, identity, extra: { stage: 'final' } });
  journal(store, journalEntry({ network, txHash: run.hash, cbor: run.cbor, ttl: run.p.ttl, inputs: run.p.tx.inputs, run: run.dir, kind: 'freeze', stage: 'final', identity: name, signingPublicKey: identity.pub.signing_public_key }));
  const first = 136598400; // first slot of preprod epoch 320
  const block = blockOf({ slot: first + epochSlot, epoch: 320, epochSlot });
  const k = fakeChain(network, { txs: { [run.hash]: { cbor: run.cbor, confirmations: 15, block: block.koios } }, tip, epochParams });
  const b = fakeBlockfrost(network, { txs: { [run.hash]: { cbor: run.cbor, block: (blockfrostBlock || block).blockfrost, blockOverride: bfBlockOverride } }, tip: bfTip, epochParams: bfEpochParams, genesis: bfGenesis });
  const koios = k.koios({ txHashes: [...store.knownTxHashes(network)], addresses: [run.report.payment_address] });
  const bf = b.bf({ txHashes: [run.hash] });
  return { store, identity, run, k, b, koios, bf, block, first };
}

const quick = { sleep: async () => {}, now: () => 0 };

test('wait records the draw plan of a final freeze: E, the slot, the cutoff and N, from Koios alone', async () => {
  const before = await finalRun({ epochSlot: 259199 });
  const r = await waitRun({ store: before.store, dir: before.run.dir, log: () => {}, koios: before.koios, waitOptions: quick });
  assert.equal(r.draw.block_epoch, 320);
  assert.equal(r.draw.cutoff_slot, before.first + 259200);
  assert.equal(r.draw.nonce_epoch, 321);
  assert.deepEqual(r.draw.sources, ['koios']);
  const report = JSON.parse(fs.readFileSync(path.join(before.run.dir, 'report.json'), 'utf8'));
  assert.equal(report.draw.nonce_epoch, 321);
  assert.equal(report.stage, 'final');
  const after = await finalRun({ epochSlot: 259200 });
  assert.equal((await waitRun({ store: after.store, dir: after.run.dir, log: () => {}, koios: after.koios, waitOptions: quick })).draw.nonce_epoch, 322);
});

test('verify of a final freeze: Koios and Blockfrost agree on the block and the plan, which equals the recorded one', async () => {
  const f = await finalRun();
  await waitRun({ store: f.store, dir: f.run.dir, log: () => {}, koios: f.koios, waitOptions: quick });
  f.k.chain.tip.block_height = f.block.koios.block_height + 20;
  const r = await verifyRun({ store: f.store, cli: fakeCli, arg: f.run.dir, network: 'preprod', log: () => {}, koios: f.koios, blockfrost: f.bf, sdkImpl: sdkValid });
  assert.equal(r.verdict, 'valid', r.issues.join('; '));
  assert.equal(r.crosscheck.ok, true);
  assert.equal(r.draw.nonce_epoch, 321);
  assert.equal(r.draw.cross_checked, true);
  assert.equal(r.stage, 'final');
});

test('verify fails when Blockfrost places the block elsewhere, or when the plan differs from the recorded one', async () => {
  const f = await finalRun({ blockfrostBlock: blockOf({ slot: 136598400 + 101600, epoch: 320, epochSlot: 101601 }) });
  await waitRun({ store: f.store, dir: f.run.dir, log: () => {}, koios: f.koios, waitOptions: quick });
  const r = await verifyRun({ store: f.store, cli: fakeCli, arg: f.run.dir, network: 'preprod', log: () => {}, koios: f.koios, blockfrost: f.bf, sdkImpl: sdkValid });
  assert.equal(r.verdict, 'failed');
  assert.match(r.issues.join('; '), /epoch_slot: Koios 101600, Blockfrost 101601/);

  const g = await finalRun();
  await waitRun({ store: g.store, dir: g.run.dir, log: () => {}, koios: g.koios, waitOptions: quick });
  const file = path.join(g.run.dir, 'report.json');
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  report.draw.cutoff_slot += 1;
  report.confirmed.block_hash = 'dd'.repeat(32);
  g.store.updateRunFile(g.run.dir, 'report.json', JSON.stringify(report));
  const s = await verifyRun({ store: g.store, cli: fakeCli, arg: g.run.dir, network: 'preprod', log: () => {}, koios: g.koios, blockfrost: g.bf, sdkImpl: sdkValid });
  assert.equal(s.verdict, 'failed');
  assert.match(s.issues.join('; '), /differ from those "wait" recorded/);
  assert.match(s.issues.join('; '), /differs from the one "wait" recorded/);
});

test('verify on mainnet refuses to run without a Blockfrost project id', async () => {
  const f = await finalRun({ network: 'mainnet', name: 'testfreeze' });
  await assert.rejects(verifyRun({ store: f.store, cli: fakeCli, arg: f.run.dir, network: 'mainnet', log: () => {}, koios: f.koios, sdkImpl: sdkValid }), /cross-checks every chain fact with Blockfrost/);
});

// N = 321 with the block 101,600 slots into epoch 320.
function started(f) {
  f.k.chain.tip = { ...f.k.chain.tip, epoch_no: 321, block_height: f.block.koios.block_height + 2200 };
  f.b.state.tip = { ...f.b.state.tip, epoch: 321, height: f.block.blockfrost.height + 2200 };
}

test('drawkey: once N has started and the block is k deep, both nonces agree and both readings are written with their times', async () => {
  const f = await finalRun({ epochParams: { 321: { epoch_no: 321, nonce: NONCE, protocol_major: 11 } }, bfEpochParams: { 321: { epoch: 321, nonce: NONCE, protocol_major_ver: 11 } } });
  await waitRun({ store: f.store, dir: f.run.dir, log: () => {}, koios: f.koios, waitOptions: quick });
  started(f);
  const r = await drawKey({ store: f.store, dir: f.run.dir, log: () => {}, koios: f.koios, blockfrost: f.bf });
  assert.equal(r.nonce_epoch, 321);
  assert.equal(r.nonce, NONCE);
  const written = JSON.parse(fs.readFileSync(path.join(f.run.dir, 'drawkey.json'), 'utf8'));
  assert.deepEqual(written.readings.map((x) => [x.source, x.nonce, x.epoch]), [['koios', NONCE, 321], ['blockfrost', NONCE, 321]]);
  assert.ok(written.readings.every((x) => /^\d{4}-\d\d-\d\dT/.test(x.at)));
  assert.ok(!JSON.stringify(written).includes('TESTprojectID'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.run.dir, 'report.json'), 'utf8')).drawkey.nonce, NONCE);
  // Run again: read again, never rewritten.
  const again = await drawKey({ store: f.store, dir: f.run.dir, log: () => {}, koios: f.koios, blockfrost: f.bf });
  assert.equal(again.nonce, NONCE);
  assert.equal(fs.readFileSync(path.join(f.run.dir, 'drawkey.json'), 'utf8'), JSON.stringify(written, null, 2) + '\n');
});

test('drawkey fails on a nonce disagreement or absence, before N starts, before depth k, and on a block disagreement', async () => {
  const cases = [
    [{ epochParams: { 321: { epoch_no: 321, nonce: NONCE, protocol_major: 11 } }, bfEpochParams: { 321: { epoch: 321, nonce: 'ff'.repeat(32), protocol_major_ver: 11 } } }, started, /nonce of epoch 321 differs/],
    [{ epochParams: { 321: null }, bfEpochParams: { 321: { epoch: 321, nonce: NONCE, protocol_major_ver: 11 } } }, started, /absent: Koios has none/],
    [{ epochParams: { 321: { epoch_no: 321, nonce: NONCE, protocol_major: 11 } }, bfEpochParams: { 321: null } }, started, /absent: Koios has it, Blockfrost has none/],
    [{}, (f) => { f.k.chain.tip.block_height = f.block.koios.block_height + 2200; f.b.state.tip.height = f.block.blockfrost.height + 2200; }, /epoch 321 has not started \(Koios is at epoch 320, Blockfrost at 320\); it starts at slot 137030400/],
    [{}, (f) => { started(f); f.b.state.tip.height = f.block.blockfrost.height + 100; }, /101 on Blockfrost; the draw key waits for depth k \+ 1 = 2161/],
    // Depth exactly k is not enough: a rollback reaches k blocks back.
    [{}, (f) => { started(f); f.k.chain.tip.block_height = f.block.koios.block_height + 2159; }, /2160 blocks deep on Koios/],
    [{}, (f) => { started(f); f.b.state.tip.height = f.block.blockfrost.height + 2159; }, /2160 on Blockfrost/],
    // The providers disagree on the genesis parameters.
    [{ bfGenesis: { security_param: 2161 } }, started, /genesis parameters differ: securityParam: Koios 2160, Blockfrost 2161/],
    // Blockfrost contradicts itself: /txs and /blocks place the transaction differently.
    [{ bfBlockOverride: { slot: 136598400 + 101601 } }, started, /Blockfrost contradicts itself/],
    // Koios answers with the parameters of another epoch.
    [{ epochParams: { 321: { epoch_no: 320, nonce: NONCE, protocol_major: 11 } }, bfEpochParams: { 321: { epoch: 321, nonce: NONCE, protocol_major_ver: 11 } } }, started, /parameters returned are for epoch 320 \(Koios\)/],
    // Blockfrost answers with the parameters of another epoch.
    [{ epochParams: { 321: { epoch_no: 321, nonce: NONCE, protocol_major: 11 } }, bfEpochParams: { 321: { epoch: 320, nonce: NONCE, protocol_major_ver: 11 } } }, started, /parameters returned are for epoch 321 \(Koios\) and 320 \(Blockfrost\)/],
    // The plan recomputed now differs from the one wait recorded.
    [{ epochParams: { 321: { epoch_no: 321, nonce: NONCE, protocol_major: 11 } }, bfEpochParams: { 321: { epoch: 321, nonce: NONCE, protocol_major_ver: 11 } } }, (f) => { started(f); const file = path.join(f.run.dir, 'report.json'); const r = JSON.parse(fs.readFileSync(file, 'utf8')); r.draw.cutoff_slot -= 1; f.store.updateRunFile(f.run.dir, 'report.json', JSON.stringify(r)); }, /draw plan differs from the recorded one: cutoff_slot/],
    [{ blockfrostBlock: blockOf({ hash: 'cc'.repeat(32), slot: 136598400 + 101600, epoch: 320, epochSlot: 101600 }) }, started, /freeze block differs: block_hash/]
  ];
  for (const [opts, prep, re] of cases) {
    const f = await finalRun(opts);
    await waitRun({ store: f.store, dir: f.run.dir, log: () => {}, koios: f.koios, waitOptions: quick });
    prep(f);
    await assert.rejects(drawKey({ store: f.store, dir: f.run.dir, log: () => {}, koios: f.koios, blockfrost: f.bf }), re);
    assert.equal(fs.existsSync(path.join(f.run.dir, 'drawkey.json')), false, String(re));
  }
});

test('drawkey runs on a final-stage freeze only, and needs a Blockfrost project id', async () => {
  const h = await home();
  const H = await hypotheses(h);
  await assert.rejects(drawKey({ store: h.store, dir: H.dir, log: () => {}, koios: fakeChain('preprod').koios(), blockfrost: null }), /final-stage freeze only; .* is stage hypotheses/);
  const f = await finalRun();
  await assert.rejects(drawKey({ store: f.store, dir: f.run.dir, log: () => {}, koios: f.koios, blockfrost: null }), /save the preprod project id/);
});

test('on mainnet a second final freeze is refused once one is journaled', async () => {
  const store = new Store(tempHome());
  store.ensure();
  const identity = testIdentity(store, 'testfreeze');
  const a = await fabricateRun(store, { network: 'mainnet', identity, extra: { stage: 'final' }, utxoTag: 'a' });
  journal(store, journalEntry({ network: 'mainnet', txHash: a.hash, cbor: a.cbor, ttl: a.p.ttl, inputs: a.p.tx.inputs, run: a.dir, kind: 'freeze', stage: 'final' }));
  store.updateJournal('mainnet', (j) => {
    j.current.state = 'confirmed';
    j.history = [j.current];
    j.current = null;
  });
  const b = await fabricateRun(store, { network: 'mainnet', identity, extra: { stage: 'final' }, utxoTag: 'b' });
  const f = fakeChain('mainnet');
  await assert.rejects(submitRun({ store, dir: b.dir, log: () => {}, koios: f.koios({ addresses: [b.report.payment_address] }) }), /a final-stage freeze is already journaled on mainnet/);
  assert.deepEqual(f.calls, [], 'refused before any request');
});

test('drawkey accepts a freeze block exactly k + 1 deep on both providers', async () => {
  const f = await finalRun({ epochParams: { 321: { epoch_no: 321, nonce: NONCE, protocol_major: 11 } }, bfEpochParams: { 321: { epoch: 321, nonce: NONCE, protocol_major_ver: 11 } } });
  await waitRun({ store: f.store, dir: f.run.dir, log: () => {}, koios: f.koios, waitOptions: quick });
  started(f);
  f.k.chain.tip.block_height = f.block.koios.block_height + 2160;
  f.b.state.tip.height = f.block.blockfrost.height + 2160;
  const r = await drawKey({ store: f.store, dir: f.run.dir, log: () => {}, koios: f.koios, blockfrost: f.bf });
  assert.deepEqual(r.depth, { koios: 2161, blockfrost: 2161 });
});

test('verify of a final freeze fails when the providers disagree on the genesis parameters', async () => {
  const f = await finalRun({ bfGenesis: { security_param: 2161 } });
  await waitRun({ store: f.store, dir: f.run.dir, log: () => {}, koios: f.koios, waitOptions: quick });
  const r = await verifyRun({ store: f.store, cli: fakeCli, arg: f.run.dir, network: 'preprod', log: () => {}, koios: f.koios, blockfrost: f.bf, sdkImpl: sdkValid });
  assert.equal(r.verdict, 'failed');
  assert.match(r.issues.join('; '), /genesis parameters differ: securityParam: Koios 2160, Blockfrost 2161/);
});

test('wait never replaces what it recorded: other facts are refused, equal ones leave the record as it was', async () => {
  const f = await finalRun();
  await waitRun({ store: f.store, dir: f.run.dir, log: () => {}, koios: f.koios, waitOptions: quick });
  const file = path.join(f.run.dir, 'report.json');
  const first = fs.readFileSync(file, 'utf8');
  await waitRun({ store: f.store, dir: f.run.dir, log: () => {}, koios: f.koios, waitOptions: { ...quick, now: () => 99999 } });
  assert.equal(fs.readFileSync(file, 'utf8'), first, 'a second wait with the same facts changes nothing');
  f.k.chain.txs[f.run.hash].block = { ...f.k.chain.txs[f.run.hash].block, block_hash: 'dd'.repeat(32) };
  await assert.rejects(waitRun({ store: f.store, dir: f.run.dir, log: () => {}, koios: f.koios, waitOptions: quick }), /already recorded other block facts .* block_hash/);
  assert.equal(fs.readFileSync(file, 'utf8'), first);
});

test('wait refuses to replace a recorded draw plan that differs', async () => {
  const f = await finalRun();
  await waitRun({ store: f.store, dir: f.run.dir, log: () => {}, koios: f.koios, waitOptions: quick });
  const file = path.join(f.run.dir, 'report.json');
  const first = fs.readFileSync(file, 'utf8');
  // Same block, but a genesis that gives another window, so another plan.
  const other = fakeChain('preprod', { txs: f.k.chain.txs, genesis: { securityparam: '2000' } });
  await assert.rejects(waitRun({ store: f.store, dir: f.run.dir, log: () => {}, koios: other.koios({ txHashes: [f.run.hash], addresses: [f.run.report.payment_address] }), waitOptions: quick }), /already recorded another draw plan .* stabilisation_window/);
  assert.equal(fs.readFileSync(file, 'utf8'), first);
});

test('wait keeps the confirmation even when the draw plan cannot be computed', async () => {
  const f = await finalRun({ epochParams: { 320: { epoch_no: 320, protocol_major: 12, protocol_minor: 0 } } });
  await assert.rejects(waitRun({ store: f.store, dir: f.run.dir, log: () => {}, koios: f.koios, waitOptions: quick }), /protocol version 12/);
  const report = JSON.parse(fs.readFileSync(path.join(f.run.dir, 'report.json'), 'utf8'));
  assert.equal(report.confirmed.confirmations, 15);
  assert.equal(report.draw, undefined);
});

// A final freeze stays buildable after a home loss: --hypotheses names the
// hypotheses record, which is read from chain.
// A final freeze stays buildable after a home loss: --hypotheses names the
// hypotheses record, which is read from chain, and its document shows it is
// the hypotheses stage.
test('--hypotheses: the named record must be cited, on chain, paid and signed by this identity, a core-only freeze, and shown to be the hypotheses stage', async () => {
  const lost = await home();
  const dir = tempDir();
  const docItem = (text) => {
    const digest = new Uint8Array(crypto.createHash('sha256').update(text).digest());
    return hashedItems([{ type: 'StudyRegistration', document: true, ids: [{ id: '10.5281/zenodo.1', id_type: 'DOI', relation: 'IsPartOf' }], digest }]);
  };
  const hText = 'Hypotheses, frozen before the checks.\n';
  fs.writeFileSync(path.join(dir, 'h.md'), hText);
  const H = await fabricateRun(lost.store, { network: 'preprod', identity: lost.identity, coreOnly: true, items: docItem(hText), utxoTag: 'c' });
  // A core-only final freeze: same shape, and its document cites H.
  const fText = `Final. Hypotheses record: ${recordUri(H.hash)}\n`;
  fs.writeFileSync(path.join(dir, 'f.md'), fText);
  const F = await fabricateRun(lost.store, { network: 'preprod', identity: lost.identity, coreOnly: true, items: docItem(fText), utxoTag: 'd' });
  const typed = await fabricateRun(lost.store, { network: 'preprod', identity: lost.identity, utxoTag: 'e' });
  // A hypotheses document may cite records of others: only this identity's count.
  const h2Text = `Hypotheses. Prior art on chain: ${recordUri('5a'.repeat(32))}\n`;
  fs.writeFileSync(path.join(dir, 'h2.md'), h2Text);
  const H2 = await fabricateRun(lost.store, { network: 'preprod', identity: lost.identity, coreOnly: true, items: docItem(h2Text), utxoTag: '9' });
  // A fresh home with the same keys and no run directory or journal entry.
  const h = await home();
  const txs = { [H.hash]: { cbor: H.cbor, confirmations: 30 }, [F.hash]: { cbor: F.cbor, confirmations: 30 }, [typed.hash]: { cbor: typed.cbor, confirmations: 30 }, [H2.hash]: { cbor: H2.cbor, confirmations: 30 } };
  const f = fakeChain('preprod', { txs, history: [H.hash, F.hash, typed.hash, H2.hash] });
  const address = h.identity.pub.addresses.preprod;
  const args = { store: h.store, koios: f.koios(), network: 'preprod', publicKeyHex: h.identity.pub.signing_public_key, paymentKeyHash: h.identity.pub.payment_key_hash, address };
  await assert.rejects(checkCitedHypotheses({ ...args, cited: [H.hash] }), /cites no hypotheses-stage record .* --hypotheses <hash>/);
  await assert.rejects(checkCitedHypotheses({ ...args, cited: [H.hash], hypothesesHash: H.hash }), /stage is unknown; pass its document with --hypotheses-document/);
  const t = await checkCitedHypotheses({ ...args, cited: [H.hash], hypothesesHash: H.hash, hypothesesDocument: path.join(dir, 'h.md') });
  assert.equal(t.source, 'chain');
  assert.equal(t.document_check.sha256, crypto.createHash('sha256').update(hText).digest('hex'));
  const t2 = await checkCitedHypotheses({ ...args, cited: [H2.hash], hypothesesHash: H2.hash, hypothesesDocument: path.join(dir, 'h2.md') });
  assert.equal(t2.tx_hash, H2.hash, 'a cited record of someone else does not count');
  // The core-only final has the right shape, but its document cites H.
  await assert.rejects(checkCitedHypotheses({ ...args, cited: [F.hash], hypothesesHash: F.hash, hypothesesDocument: path.join(dir, 'f.md') }), new RegExp(`cites ${H.hash}, a transaction of this identity, so it is a later stage's document`));
  await assert.rejects(checkCitedHypotheses({ ...args, cited: [F.hash], hypothesesHash: F.hash, hypothesesDocument: path.join(dir, 'h.md') }), /h\.md has SHA-256 .* but the record .* carries the document digest/);
  await assert.rejects(checkCitedHypotheses({ ...args, cited: ['9f'.repeat(32)], hypothesesHash: H.hash, hypothesesDocument: path.join(dir, 'h.md') }), /does not cite the hypotheses record/);
  await assert.rejects(checkCitedHypotheses({ ...args, cited: ['AB'.repeat(32)], hypothesesHash: 'AB'.repeat(32) }), /64-digit lowercase transaction hash/);
  await assert.rejects(checkCitedHypotheses({ ...args, cited: [typed.hash], hypothesesHash: typed.hash, hypothesesDocument: path.join(dir, 'h.md') }), /not a core-only freeze record/);
  await assert.rejects(checkCitedHypotheses({ ...args, paymentKeyHash: 'ab'.repeat(28), cited: [H.hash], hypothesesHash: H.hash, hypothesesDocument: path.join(dir, 'h.md') }), /was not paid by this identity/);
  // A journal entry of another stage settles it without a document.
  journal(h.store, journalEntry({ network: 'preprod', txHash: F.hash, cbor: F.cbor, ttl: 1, inputs: F.p.tx.inputs, run: '/gone', kind: 'freeze', stage: 'final' }));
  await assert.rejects(checkCitedHypotheses({ ...args, cited: [F.hash], hypothesesHash: F.hash }), /is a final-stage journal entry of this home, not the hypotheses record/);
  // A hypotheses-stage journal entry settles it, and a document passed anyway is reported as unused.
  h.store.updateJournal('preprod', (j) => {
    j.current.state = 'confirmed';
    j.history = [...(j.history || []), j.current];
    j.current = null;
  });
  journal(h.store, journalEntry({ network: 'preprod', txHash: H.hash, cbor: H.cbor, ttl: 1, inputs: H.p.tx.inputs, run: '/gone', kind: 'freeze', stage: 'hypotheses' }));
  const notes = [];
  await checkCitedHypotheses({ ...args, cited: [H.hash], hypothesesHash: H.hash, hypothesesDocument: path.join(dir, 'f.md'), log: (m) => notes.push(m) });
  assert.match(notes.join('\n'), /--hypotheses-document .*f\.md is not used: this home's journal entry for [0-9a-f]{64} already shows its stage/);
  // In the home that has the runs, --hypotheses cannot name a run of another stage.
  const report = JSON.parse(fs.readFileSync(path.join(typed.dir, 'report.json'), 'utf8'));
  lost.store.updateRunFile(typed.dir, 'report.json', JSON.stringify({ ...report, stage: 'final' }));
  await assert.rejects(checkCitedHypotheses({ store: lost.store, koios: fakeChain('preprod', { txs }).koios(), network: 'preprod', publicKeyHex: lost.identity.pub.signing_public_key, paymentKeyHash: lost.identity.pub.payment_key_hash, address, cited: [typed.hash], hypothesesHash: typed.hash }), /final-stage run of this home, not the hypotheses record/);
});

test('--hypotheses applies to a final build only, and --hypotheses-document goes with it', async () => {
  const h = await home();
  const f = fakeChain('preprod');
  await assert.rejects(build({ store: h.store, koios: f.koios(), cli: {}, manifestPath: '/nowhere.json', network: 'preprod', identityName: 'rehearsal', stage: 'hypotheses', coreOnly: true, hypothesesHash: 'ab'.repeat(32) }), /applies to a final-stage freeze only/);
  await assert.rejects(build({ store: h.store, koios: f.koios(), cli: {}, manifestPath: '/nowhere.json', network: 'preprod', identityName: 'rehearsal', stage: 'final', hypothesesDocument: '/x.md' }), /goes with --hypotheses/);
  assert.deepEqual(f.calls, []);
});

test('build refuses a mainnet final while another final is journaled, before any request', async () => {
  const store = new Store(tempHome());
  store.ensure();
  const identity = testIdentity(store, 'testfreeze');
  const a = await fabricateRun(store, { network: 'mainnet', identity, extra: { stage: 'final' } });
  journalConfirmed(store, 'mainnet', a, identity);
  const f = fakeChain('mainnet');
  await assert.rejects(build({ store, koios: f.koios(), cli: {}, manifestPath: '/nowhere.json', network: 'mainnet', identityName: 'testfreeze', stage: 'final' }), /already journaled on mainnet/);
  assert.deepEqual(f.calls, []);
});
