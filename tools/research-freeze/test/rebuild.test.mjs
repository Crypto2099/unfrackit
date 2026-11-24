// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The rebuild of a mainnet hypotheses- or final-stage freeze whose record
// may have left this machine: `abandon` refuses it, and after its TTL a new
// transaction carries the same signed record and 674 line byte for byte,
// with new inputs, fee and TTL, in the journaled transaction's place.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Store } from '../src/store.mjs';
import { loadRun, prepareRebuild, rebuild } from '../src/build.mjs';
import { submitRun, abandonJournal } from '../src/ops.mjs';
import { journal, journalEntry, journalEntries, submitJournaled, abandon } from '../src/journal.mjs';
import { auxiliaryBytes, assertTransaction } from '../src/tx.mjs';
import { recordFromBytes } from '../src/verify.mjs';
import { Cardanowall } from '../src/cardanowall.mjs';
import { toHex } from '../src/util.mjs';
import { tempHome } from './helpers.mjs';
import { testIdentity, fakeChain, fakeBlockfrost, fabricateRun, fabricateRebuild, hashedItems, blockOf } from './fixtures.mjs';

const cli = Cardanowall.optional();
const noCli = cli ? false : 'the cardanowall CLI 0.12.0 is not installed (PATH or RESEARCH_FREEZE_CARDANOWALL); skipping the end-to-end rebuild';
if (noCli) process.stderr.write(`NOTICE: ${noCli}\n`);

function streams(answer) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.isTTY = true;
  stdout.isTTY = true;
  let shown = '';
  stdout.on('data', (b) => {
    shown += b.toString();
    if (answer !== undefined && /Type the first eight/.test(shown)) {
      const a = answer;
      answer = undefined;
      stdin.write(`${a}\n`);
    }
  });
  return { stdin, stdout, shown: () => shown };
}

const DOC = { type: 'StudyRegistration', document: true, ids: [{ id: '10.5281/zenodo.1', id_type: 'DOI', relation: 'IsPartOf' }] };

// A mainnet staged freeze built at slot 1000 (TTL 8200), journaled and sent:
// Koios accepted it with HTTP 202. It never landed.
async function sentFreeze({ stage = 'hypotheses', store: given, items, utxoTag = 'a' } = {}) {
  const store = given || new Store(tempHome());
  store.ensure();
  const identity = testIdentity(store, 'testfreeze');
  const run = await fabricateRun(store, { network: 'mainnet', identity, coreOnly: stage === 'hypotheses', items: items || (stage === 'hypotheses' ? hashedItems([DOC]) : undefined), extra: { stage }, utxoTag });
  const entry = journal(store, journalEntry({ network: 'mainnet', txHash: run.hash, cbor: run.cbor, ttl: run.p.ttl, inputs: run.p.tx.inputs, run: run.dir, kind: 'freeze', stage, identity: 'testfreeze', signingPublicKey: identity.pub.signing_public_key }));
  await submitJournaled({ koios: fakeChain('mainnet').koios({ txHashes: [run.hash] }), store, entry, address: run.report.payment_address });
  assert.equal(store.readJournal('mainnet').current.state, 'submitted');
  return { store, identity, run, input: run.p.tx.inputs[0] };
}

// Koios and Blockfrost at `slot`, past the TTL by default: the address holds
// the old transaction's input unless `utxos` says otherwise, and the
// providers know only the transactions in `known`/`bfKnown`.
function providers(s, { slot = 8300, utxos, known = {}, bfKnown = {}, history = [] } = {}) {
  const f = fakeChain('mainnet', { tip: { abs_slot: slot }, utxos: utxos || [{ txHash: s.input.txHash, index: s.input.index, coin: s.input.coin }], txs: known, history });
  const b = fakeBlockfrost('mainnet', { txs: bfKnown, history });
  const address = s.run.report.payment_address;
  return { f, b, koios: f.koios({ addresses: [address], txHashes: [...s.store.knownTxHashes('mainnet')] }), bf: b.bf({ addresses: [address] }) };
}

const PARAMS = { epoch: 320, protocolMajor: 11, protocolMinor: 0, minFeeA: 44n, minFeeB: 155381n, maxTxSize: 16384, coinsPerUtxoByte: 4310n, tip: { slot: 8300, epoch: 320, height: 1, hash: '00', time: 1 } };
const pure = (txHash, index, coin) => ({ txHash, index, coin, assets: [], datumBytes: null, datumHash: null, refScript: null });

test('a rebuild carries the journaled record byte for byte: the label-309 value with its COSE_Sign1, and the 674 line; the inputs, fee and TTL are new', async () => {
  for (const stage of ['hypotheses', 'final']) {
    const s = await sentFreeze({ stage });
    const entry = s.store.readJournal('mainnet').current;
    const old = loadRun(s.run.dir);
    const more = pure('f1'.repeat(32), 1, 3000000n);
    const p = prepareRebuild({ run: old, sentCbor: entry.cbor, utxos: [pure(s.input.txHash, s.input.index, s.input.coin), more], payment: s.identity.id.payment, params: PARAMS, network: 'mainnet', ttl: 15500, paymentKeyHash: s.identity.pub.payment_key_hash, mustSpend: entry.inputs });
    assert.notEqual(p.tx.hash, s.run.hash);
    assert.deepEqual(auxiliaryBytes(p.tx.bytes), auxiliaryBytes(s.run.p.tx.bytes), 'the same auxiliary data, byte for byte');
    const was = recordFromBytes(s.run.hash, s.run.cbor);
    const now = recordFromBytes(p.tx.hash, toHex(p.tx.bytes));
    assert.equal(now.verdict, 'valid');
    assert.deepEqual(now.body, was.body, 'the same signed record body, so the same COSE_Sign1');
    assert.deepEqual(now.message, was.message);
    assert.deepEqual(now.signers, [s.identity.pub.signing_public_key]);
    assert.deepEqual(p.signed.coseSign1, old.coseSign1);
    assert.deepEqual([...p.signed.body], [...old.body]);
    assert.equal(p.ttl, 15500);
    assert.deepEqual(p.tx.inputs.map((u) => u.txHash).sort(), [s.input.txHash, more.txHash].sort(), 'every pure-ADA UTxO, the old transaction\'s input among them');
    assertTransaction(p.tx.bytes, p.txExpect);
  }
});

test('a rebuild refuses any other content: another signed body, another 674 line, record files that disagree, or an old input it cannot spend', async () => {
  const s = await sentFreeze({ stage: 'final' });
  const entry = s.store.readJournal('mainnet').current;
  const old = loadRun(s.run.dir);
  // Another record signed by the same key (different items).
  const other = loadRun((await fabricateRun(s.store, { network: 'mainnet', identity: s.identity, items: hashedItems([DOC, { type: 'Software', digest: new Uint8Array(32).fill(9) }]), extra: { stage: 'final' }, utxoTag: 'b' })).dir);
  const args = { sentCbor: entry.cbor, utxos: [pure(s.input.txHash, s.input.index, s.input.coin)], payment: s.identity.id.payment, params: PARAMS, network: 'mainnet', ttl: 15500, paymentKeyHash: s.identity.pub.payment_key_hash, mustSpend: entry.inputs };
  const refused = /does not hold the record its journaled transaction carries .*a rebuild carries that record unchanged, so it is refused/;
  assert.throws(() => prepareRebuild({ ...args, run: { ...old, body: other.body, bodyNoSigs: other.bodyNoSigs, sigStructure: other.sigStructure, coseSign1: other.coseSign1 } }), refused);
  assert.throws(() => prepareRebuild({ ...args, run: { ...old, report: { ...old.report, message: ['00'.repeat(32)] } } }), refused);
  assert.throws(() => prepareRebuild({ ...args, run: { ...old, coseSign1: other.coseSign1 } }), /do not agree with its body/);
  assert.throws(() => prepareRebuild({ ...args, run: { ...old, bodyNoSigs: other.bodyNoSigs } }), /do not agree with its body/);
  assert.throws(() => prepareRebuild({ ...args, run: old, utxos: [pure('f2'.repeat(32), 0, 9000000n)] }), /must spend every input of .* so that at most one of the two can land/);
});

test('submit of a rebuilt run: the old transaction is shown unable to land, then the new one takes its place in the journal and is sent', async () => {
  for (const stage of ['hypotheses', 'final']) {
    const s = await sentFreeze({ stage });
    const r = fabricateRebuild(s.store, { identity: s.identity, tipSlot: 8300 });
    assert.equal(r.report.replaces, s.run.hash);
    assert.equal(r.report.stage, stage);
    const p = providers(s);
    const term = streams(r.hash.slice(0, 8));
    const out = await submitRun({ store: s.store, dir: r.dir, log: () => {}, streams: term, koios: p.koios, blockfrost: p.bf });
    assert.equal(out.outcome, 'submitted');
    assert.match(term.shown(), new RegExp(`replaces:\\s+${s.run.hash} \\(the same signed record, in a new transaction\\)`));
    assert.deepEqual(p.f.chain.submitted, [r.hash], 'only the new transaction is sent');
    const [was, now] = journalEntries(s.store, 'mainnet');
    assert.deepEqual([was.txHash, was.state, was.replacedFrom, was.replacedBy], [s.run.hash, 'replaced', 'submitted', r.hash]);
    assert.deepEqual([now.txHash, now.state, now.replaces, now.stage], [r.hash, 'submitted', s.run.hash, stage]);
    for (const call of ['/tip', '/tx_status', '/tx_info', '/address_txs', '/address_utxos']) assert.ok(p.f.calls.includes(call), `Koios ${call} is asked`);
    assert.ok(p.b.calls.includes(`/txs/${s.run.hash}`), 'Blockfrost is asked too');
  }
});

test('one final freeze: the rebuilt final is not a second one, and still rules out another', async () => {
  const s = await sentFreeze({ stage: 'final' });
  const r = fabricateRebuild(s.store, { identity: s.identity, tipSlot: 8300 });
  const p = providers(s);
  await submitRun({ store: s.store, dir: r.dir, log: () => {}, streams: streams(r.hash.slice(0, 8)), koios: p.koios, blockfrost: p.bf });
  s.store.updateJournal('mainnet', (j) => {
    j.current.state = 'confirmed';
    j.history.push(j.current);
    j.current = null;
  });
  const other = await fabricateRun(s.store, { network: 'mainnet', identity: s.identity, extra: { stage: 'final' }, utxoTag: 'c' });
  const q = providers(s);
  await assert.rejects(submitRun({ store: s.store, dir: other.dir, log: () => {}, streams: streams(other.hash.slice(0, 8)), koios: q.koios, blockfrost: q.bf }), new RegExp(`a final-stage freeze is already journaled on mainnet \\(${r.hash}, state confirmed\\)`));
});

test('submit of a rebuilt run refuses a transaction carrying other content, inside the locked journal write; nothing is sent', async () => {
  const s = await sentFreeze({ stage: 'hypotheses' });
  // Another record of the same identity over the same input, posing as a rebuild.
  const other = await fabricateRun(s.store, { network: 'mainnet', identity: s.identity, coreOnly: true, items: hashedItems([{ ...DOC, digest: new Uint8Array(32).fill(7) }]), extra: { stage: 'hypotheses' } });
  const report = JSON.parse(fs.readFileSync(path.join(other.dir, 'report.json'), 'utf8'));
  s.store.updateRunFile(other.dir, 'report.json', JSON.stringify({ ...report, replaces: s.run.hash }));
  const p = providers(s);
  await assert.rejects(submitRun({ store: s.store, dir: other.dir, log: () => {}, streams: streams(other.hash.slice(0, 8)), koios: p.koios, blockfrost: p.bf }), new RegExp(`${other.hash} does not carry the record of ${s.run.hash} byte for byte .* so it is refused`));
  assert.deepEqual(p.f.chain.submitted, []);
  const j = s.store.readJournal('mainnet');
  assert.deepEqual([j.current.txHash, j.current.state, j.history.length], [s.run.hash, 'submitted', 0], 'the journal is as it was');
});

test('submit of a rebuilt run refuses while the old transaction may still land: before its TTL, known to either provider, or its inputs spent', async () => {
  const s = await sentFreeze({ stage: 'final' });
  const r = fabricateRebuild(s.store, { identity: s.identity, tipSlot: 8300 });
  const submit = (p) => submitRun({ store: s.store, dir: r.dir, log: () => {}, streams: streams(r.hash.slice(0, 8)), koios: p.koios, blockfrost: p.bf });
  await assert.rejects(submit(providers(s, { slot: 8200 })), /the TTL of .* \(slot 8200\) has not passed \(tip slot 8200\)/);
  await assert.rejects(submit(providers(s, { known: { [s.run.hash]: { cbor: s.run.cbor, confirmations: 0 } } })), /is known to Koios \/tx_status; it cannot be rebuilt/);
  await assert.rejects(submit(providers(s, { bfKnown: { [s.run.hash]: { cbor: s.run.cbor, block: blockOf().blockfrost } } })), /is known to Blockfrost; it cannot be rebuilt/);
  await assert.rejects(submit(providers(s, { utxos: [{ txHash: 'f3'.repeat(32), index: 0, coin: 5000000n }] })), /are not all unspent; it cannot be rebuilt/);
  assert.equal(s.store.readJournal('mainnet').current.txHash, s.run.hash, 'the old entry keeps its place');
});

test('a rebuilt entry that was never sent keeps the record: abandon refuses it, and its own rebuild checks every earlier transaction carrying the record', async () => {
  const s = await sentFreeze({ stage: 'hypotheses' });
  const r1 = fabricateRebuild(s.store, { identity: s.identity, tipSlot: 8300 });
  // Submitted only after its own TTL (15500) has passed: journaled, never sent.
  await assert.rejects(submitRun({ store: s.store, dir: r1.dir, log: () => {}, streams: streams(r1.hash.slice(0, 8)), koios: providers(s, { slot: 16000 }).koios, blockfrost: providers(s, { slot: 16000 }).bf }), new RegExp(`its record cannot be abandoned; run "build --rebuild ${r1.hash} --network mainnet"`));
  const current = s.store.readJournal('mainnet').current;
  assert.deepEqual([current.txHash, current.state, current.sentAt, current.replaces], [r1.hash, 'unsubmitted', undefined, s.run.hash]);
  // abandon refuses it, before any request and before asking for Blockfrost.
  const f = fakeChain('mainnet');
  await assert.rejects(abandonJournal({ store: s.store, network: 'mainnet', identityName: 'testfreeze', koios: f.koios({ addresses: [s.run.report.payment_address] }) }), new RegExp(`${r1.hash} carries a hypotheses-stage freeze record that may have left this machine \\(sent in ${s.run.hash}\\)`));
  assert.deepEqual(f.calls, []);
  await assert.rejects(abandon({ koios: providers(s, { slot: 16000 }).koios, store: s.store, network: 'mainnet', address: s.run.report.payment_address, bf: providers(s).bf }), /never abandoned for a newly signed one/);
  // The second rebuild: the first transaction, now replaced, must be unknown as well.
  const r2 = fabricateRebuild(s.store, { identity: s.identity, tipSlot: 16000 });
  const submit = (p) => submitRun({ store: s.store, dir: r2.dir, log: () => {}, streams: streams(r2.hash.slice(0, 8)), koios: p.koios, blockfrost: p.bf });
  await assert.rejects(submit(providers(s, { slot: 16000, known: { [s.run.hash]: { cbor: s.run.cbor, confirmations: 3 } } })), new RegExp(`${s.run.hash} is known to Koios /tx_status; ${r1.hash} cannot be rebuilt`));
  await assert.rejects(submit(providers(s, { slot: 16000, history: [s.run.hash] })), new RegExp(`${s.run.hash} is in the payment address's transaction history; ${r1.hash} cannot be rebuilt`));
  const p = providers(s, { slot: 16000 });
  assert.equal((await submit(p)).outcome, 'submitted');
  assert.deepEqual(journalEntries(s.store, 'mainnet').map((e) => [e.txHash, e.state, e.replaces || null]), [[s.run.hash, 'replaced', null], [r1.hash, 'replaced', s.run.hash], [r2.hash, 'submitted', r1.hash]]);
  assert.deepEqual([...auxiliaryBytes(r2.p.tx.bytes)], [...auxiliaryBytes(s.run.p.tx.bytes)]);
});

test('build --rebuild: refused before any request unless the hash is the journal\'s unresolved staged freeze', async () => {
  const s = await sentFreeze({ stage: 'final' });
  const f = fakeChain('mainnet');
  const args = { store: s.store, koios: f.koios(), bf: fakeBlockfrost('mainnet').bf(), cli: {}, network: 'mainnet', identityName: 'testfreeze' };
  await assert.rejects(rebuild({ ...args, replaces: 'ab'.repeat(32) }), new RegExp(`is not the unresolved mainnet transaction of the journal \\(that is ${s.run.hash}\\)`));
  await assert.rejects(rebuild({ ...args, bf: null, replaces: s.run.hash }), /a rebuild on mainnet asks Blockfrost too/);
  const sweep = new Store(tempHome());
  sweep.ensure();
  testIdentity(sweep, 'testfreeze');
  journal(sweep, journalEntry({ network: 'mainnet', txHash: 'cd'.repeat(32), cbor: '00', ttl: 1, inputs: [], run: '/x', kind: 'sweep', identity: 'testfreeze' }));
  await assert.rejects(rebuild({ ...args, store: sweep, replaces: 'cd'.repeat(32) }), /a sweep transaction; only a hypotheses- or final-stage freeze is rebuilt/);
  assert.deepEqual(f.calls, []);
});

test('build --rebuild end to end: the guard, the checks of the old transaction, the offline checks, and a run directory naming the one it replaces', { skip: noCli }, async () => {
  const s = await sentFreeze({ stage: 'final' });
  const p = providers(s);
  await assert.rejects(rebuild({ store: s.store, koios: providers(s, { slot: 8000 }).koios, bf: p.bf, cli, network: 'mainnet', identityName: 'testfreeze', replaces: s.run.hash }), /has not passed/);
  const r = await rebuild({ store: s.store, koios: p.koios, bf: p.bf, cli, network: 'mainnet', identityName: 'testfreeze', replaces: s.run.hash });
  assert.equal(p.f.calls[0], '/genesis');
  assert.ok(r.report.checks.length > 30 && r.report.checks.every((c) => c.ok), 'every offline check passed');
  assert.ok(r.report.checks.some((c) => /cardanowall verify --record/.test(c.name)));
  assert.equal(r.report.replaces, s.run.hash);
  assert.equal(r.report.stage, 'final');
  assert.equal(r.report.ttl, 8300 + 7200);
  for (const f of ['body.cbor', 'body-without-sigs.cbor', 'sig-structure.cbor', 'cose-sign1.cbor', 'label-309-value.cbor', 'metadata.json']) {
    assert.deepEqual(fs.readFileSync(path.join(r.dir, f)), fs.readFileSync(path.join(s.run.dir, f)), `${f} is the old run's`);
  }
  assert.deepEqual(r.report.message, s.run.report.message);
  assert.equal(s.store.readJournal('mainnet').current.txHash, s.run.hash, 'build submits nothing and leaves the journal alone');
});
