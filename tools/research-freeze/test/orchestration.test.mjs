// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The order of the steps inside `submit`, `sweep` and `build`, against a fake
// Koios: the network guard, the mainnet prompt and its facts, the journal,
// the TTL and the submission.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Store } from '../src/store.mjs';
import { submitRun, sweep, buildSweep } from '../src/ops.mjs';
import { journalEntries } from '../src/journal.mjs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { toHex } from '../src/util.mjs';
import { encode as encodeCbor } from '../src/cbor.mjs';
import { blake2b256 } from '@cardanowall/crypto-core/hash';
import { build, prepareRun } from '../src/build.mjs';
import { MANIFEST_FORMAT } from '../src/manifest.mjs';
import { tempHome, tempDir } from './helpers.mjs';
import { testIdentity, fakeChain, fakeBlockfrost, fabricateRun, journalConfirmed, hashedItems } from './fixtures.mjs';

// A terminal. When the prompt appears, `onPrompt` runs (to change the world
// while the operator reads), and then `answer` is typed.
function streams(tty, answer, onPrompt = async () => {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.isTTY = tty;
  stdout.isTTY = tty;
  let shown = '';
  stdout.on('data', (b) => {
    shown += b.toString();
    if (answer !== undefined && /Type the first eight/.test(shown)) {
      const a = answer;
      answer = undefined;
      onPrompt().then(() => stdin.write(`${a}\n`));
    }
  });
  return { stdin, stdout, shown: () => shown };
}

async function mainnetRun({ stage = 'final', label = 'testfreeze', store: given, utxoTag = 'a' } = {}) {
  const store = given || new Store(tempHome());
  store.ensure();
  const identity = testIdentity(store, 'testfreeze', label);
  const run = await fabricateRun(store, { network: 'mainnet', identity, extra: { stage }, utxoTag });
  const utxo = { txHash: run.p.tx.inputs[0].txHash, index: 0, coin: run.p.tx.inputs[0].coin };
  return { store, identity, run, utxo };
}

// Koios and Blockfrost for a mainnet final submit, with the address history
// both report.
function providers(run, { history = [], txs = {}, bfHistory = history, bfTxs = txs, tip = {} } = {}) {
  const f = fakeChain('mainnet', { history, txs, tip });
  const b = fakeBlockfrost('mainnet', { history: bfHistory, txs: bfTxs });
  return { f, b, koios: f.koios({ addresses: [run.report.payment_address] }), bf: b.bf({ addresses: [run.report.payment_address] }) };
}

test('mainnet submit without a terminal: the guard and the chain scan run, then the refusal; nothing is journaled or sent', async () => {
  const { store, run } = await mainnetRun();
  const p = providers(run);
  await assert.rejects(submitRun({ store, dir: run.dir, log: () => {}, streams: streams(false), koios: p.koios, blockfrost: p.bf }), /interactive terminal/);
  assert.deepEqual(p.f.calls, ['/genesis', '/address_txs']);
  assert.equal(store.readJournal('mainnet').current, null);
});

test('mainnet submit: the prompt shows the facts of the record; wrong digits send nothing', async () => {
  const { store, run } = await mainnetRun();
  const p = providers(run);
  const s = streams(true, '00000000');
  await assert.rejects(submitRun({ store, dir: run.dir, log: () => {}, streams: s, koios: p.koios, blockfrost: p.bf }), /did not match/);
  for (const label of ['network:', 'record kind:', 'stage:', 'research-items:', 'items:', 'CIP-20 line:', 'signing key:', 'fee:', 'inputs:', 'change:', 'TTL:']) assert.ok(s.shown().includes(label), label);
  assert.match(s.shown(), /stage:\s+final/);
  assert.match(s.shown(), new RegExp(run.report.message[0]));
  assert.deepEqual(p.f.calls, ['/genesis', '/address_txs']);
  assert.equal(store.readJournal('mainnet').current, null);
});

test('mainnet submit: guard, chain scan, prompt, journal, TTL check, submission, in that order', async () => {
  const { store, run } = await mainnetRun();
  let journaledAtTip = null;
  const p = providers(run, { tip: { abs_slot: 1000 } });
  const koios = fakeChain('mainnet', {
    tip: { abs_slot: 1000 },
    onCall: (path) => {
      if (path === '/tip') journaledAtTip = store.readJournal('mainnet').current?.txHash ?? null;
    }
  });
  const s = streams(true, run.hash.slice(0, 8));
  const r = await submitRun({ store, dir: run.dir, log: () => {}, streams: s, koios: koios.koios({ addresses: [run.report.payment_address] }), blockfrost: p.bf });
  assert.equal(r.outcome, 'submitted');
  assert.deepEqual(koios.calls, ['/genesis', '/address_txs', '/tip', '/submittx']);
  assert.equal(journaledAtTip, run.hash, 'the journal entry exists before the TTL check and the submission');
  const entry = store.readJournal('mainnet').current;
  assert.equal(entry.stage, 'final');
  assert.equal(entry.kind, 'freeze');
});

test('a run whose TTL has passed is not submitted', async () => {
  const { store, run } = await mainnetRun();
  const p = providers(run, { tip: { abs_slot: run.p.ttl + 1 } });
  await assert.rejects(submitRun({ store, dir: run.dir, log: () => {}, streams: streams(true, run.hash.slice(0, 8)), koios: p.koios, blockfrost: p.bf }), /TTL .* has passed/);
  assert.ok(!p.f.calls.includes('/submittx'));
});

// The re-review's interleaving: submit B passes the early check and waits at
// the prompt; meanwhile A is submitted and waited to 15 confirmations, which
// retires it as confirmed; then the operator types B's digits.
test('a second mainnet final is refused at the moment of sending, even when the first was journaled while the prompt was open', async () => {
  const store = new Store(tempHome());
  const a = await mainnetRun({ store, label: 'testfreeze' });
  const b = await fabricateRun(store, { network: 'mainnet', identity: a.identity, extra: { stage: 'final' }, utxoTag: 'b' });
  const p = providers(b, { tip: { abs_slot: 1000 } });
  const confirmA = async () => journalConfirmed(store, 'mainnet', a.run, a.identity);
  const s = streams(true, b.hash.slice(0, 8), confirmA);
  await assert.rejects(submitRun({ store, dir: b.dir, log: () => {}, streams: s, koios: p.koios, blockfrost: p.bf }), /a final-stage freeze is already journaled on mainnet/);
  assert.ok(!p.f.calls.includes('/submittx'), 'B is never sent');
  assert.deepEqual(journalEntries(store, 'mainnet').map((e) => [e.txHash, e.state]), [[a.run.hash, 'confirmed']]);
});

test('an abandoned mainnet final does not block the next one', async () => {
  const store = new Store(tempHome());
  const a = await mainnetRun({ store, label: 'testfreeze' });
  journalConfirmed(store, 'mainnet', a.run, a.identity);
  store.updateJournal('mainnet', (j) => {
    j.history[0].state = 'abandoned';
  });
  const b = await fabricateRun(store, { network: 'mainnet', identity: a.identity, extra: { stage: 'final' }, utxoTag: 'b' });
  const p = providers(b, { tip: { abs_slot: 1000 } });
  const r = await submitRun({ store, dir: b.dir, log: () => {}, streams: streams(true, b.hash.slice(0, 8)), koios: p.koios, blockfrost: p.bf });
  assert.equal(r.outcome, 'submitted');
});

test('a mainnet final is refused when the address history holds a record of this identity the journal does not know', async () => {
  // A final freeze sent from a lost home: same keys, a run this home never saw.
  const lost = new Store(tempHome());
  const earlier = await mainnetRun({ store: lost, label: 'testfreeze', utxoTag: 'f' });
  const { store, run } = await mainnetRun({ label: 'testfreeze' });
  const known = { [earlier.run.hash]: { cbor: earlier.run.cbor, confirmations: 40 } };
  const p = providers(run, { history: [earlier.run.hash], txs: known });
  await assert.rejects(submitRun({ store, dir: run.dir, log: () => {}, streams: streams(true, run.hash.slice(0, 8)), koios: p.koios, blockfrost: p.bf }), new RegExp(`${earlier.run.hash}: this identity paid for it`));
  assert.ok(!p.f.calls.includes('/submittx'));
  // Blockfrost alone listing it is enough.
  const q = providers(run, { history: [], bfHistory: [earlier.run.hash], txs: known });
  await assert.rejects(submitRun({ store, dir: run.dir, log: () => {}, streams: streams(true, run.hash.slice(0, 8)), koios: q.koios, blockfrost: q.bf }), /this identity paid for it/);
  // A transaction neither provider returns cannot be ruled out.
  const r = providers(run, { history: ['9f'.repeat(32)] });
  await assert.rejects(submitRun({ store, dir: run.dir, log: () => {}, streams: streams(true, run.hash.slice(0, 8)), koios: r.koios, blockfrost: r.bf }), /neither provider returns its CBOR/);
});

test('the chain scan ignores the cited hypotheses record, funding transactions and replays paid by others', async () => {
  const { store, identity, run } = await mainnetRun();
  const other = testIdentity(new Store(tempHome()), 'testfreeze', 'someone else');
  // A replay: this identity's signed body in a transaction someone else paid.
  const params = { epoch: 320, protocolMajor: 11, protocolMinor: 0, minFeeA: 44n, minFeeB: 155381n, maxTxSize: 16384, coinsPerUtxoByte: 4310n, tip: { slot: 1000 } };
  const hashed = hashedItems([{ type: 'StudyRegistration', document: true, ids: [{ id: '10.5281/zenodo.1', id_type: 'DOI', relation: 'IsPartOf' }] }]);
  const replay = await prepareRun({ manifest: { kind: 'freeze', messageItems: [0] }, hashed, coreOnly: true, id: { signing: identity.id.signing, payment: other.id.payment }, utxos: [{ txHash: 'cc'.repeat(32), index: 0, coin: 9000000n, assets: [] }], params, network: 'mainnet', ttl: 9000, paymentKeyHash: other.pub.payment_key_hash });
  // A funding transaction: no metadata at all (a sweep-shaped transaction).
  const funding = buildSweep({ utxos: [{ txHash: 'dd'.repeat(32), index: 0, coin: 9000000n, assets: [] }], target: CSL.Address.from_bech32(run.report.payment_address), signer: other.id.payment.privateKey, networkId: 1, params, ttl: 9000 });
  const hyp = await fabricateRun(new Store(tempHome()), { network: 'mainnet', identity: testIdentity(new Store(tempHome()), 'testfreeze', 'testfreeze'), coreOnly: true, utxoTag: 'e', items: hashed });
  const report = JSON.parse(fs.readFileSync(path.join(run.dir, 'report.json'), 'utf8'));
  store.updateRunFile(run.dir, 'report.json', JSON.stringify({ ...report, hypotheses_record: hyp.hash }));
  const txs = { [replay.tx.hash]: { cbor: toHex(replay.tx.bytes) }, [funding.hash]: { cbor: toHex(funding.bytes) }, [hyp.hash]: { cbor: hyp.cbor } };
  const p = providers(run, { history: [funding.hash, hyp.hash, replay.tx.hash], txs, tip: { abs_slot: 1000 } });
  const logs = [];
  const r = await submitRun({ store, dir: run.dir, log: (m) => logs.push(m), streams: streams(true, run.hash.slice(0, 8)), koios: p.koios, blockfrost: p.bf });
  assert.equal(r.outcome, 'submitted');
  assert.ok(logs.some((m) => /2 transaction\(s\) in the payment address's history were not paid by this identity/.test(m)), 'the funding transaction and the replay were skipped unread');
});

test('a mainnet final is not submitted without a Blockfrost project id', async () => {
  const { store, run } = await mainnetRun();
  await assert.rejects(submitRun({ store, dir: run.dir, log: () => {}, streams: streams(true, run.hash.slice(0, 8)), koios: fakeChain('mainnet').koios({ addresses: [run.report.payment_address] }) }), /save the mainnet project id/);
});

test('mainnet sweep: assertions and the guard first, then the refusal without a terminal; nothing journaled or sent', async () => {
  const store = new Store(tempHome());
  store.ensure();
  const identity = testIdentity(store, 'testfreeze');
  const f = fakeChain('mainnet', { utxos: [{ txHash: 'ab'.repeat(32), index: 0, coin: 5000000n }] });
  const to = identity.id.payment.address('mainnet').to_bech32();
  await assert.rejects(sweep({ store, network: 'mainnet', identityName: 'testfreeze', to, log: () => {}, streams: streams(false), koios: f.koios({ addresses: [identity.pub.addresses.mainnet] }) }), /interactive terminal/);
  assert.ok(!f.calls.includes('/submittx'));
  assert.equal(store.readJournal('mainnet').current, null);
});

test('build: the identity-network refusal comes first, and the network guard runs before any mnemonic is read', async () => {
  const store = new Store(tempHome());
  store.ensure();
  const { pub } = testIdentity(store, 'rehearsal');
  const dir = tempDir();
  const doi = '10.5072/test.1';
  fs.writeFileSync(path.join(dir, 'doc.md'), `DOI of this document: ${doi}\nSigning public key: ${pub.signing_public_key}\n`);
  const mpath = path.join(dir, 'm.json');
  fs.writeFileSync(mpath, JSON.stringify({ format: MANIFEST_FORMAT, kind: 'freeze', doi, items: [{ path: 'doc.md', type: 'StudyRegistration', document: true, ids: [{ id: doi, id_type: 'DOI', relation: 'IsPartOf' }] }] }));
  const cli = {};
  await assert.rejects(build({ store, koios: fakeChain('mainnet').koios(), cli, manifestPath: mpath, network: 'mainnet', identityName: 'rehearsal', stage: 'hypotheses', coreOnly: true }), /preprod records only/);
  // A guard failure: the endpoint reports mainnet for a preprod build.
  let mnemonicsRead = false;
  const orig = store.readMnemonics.bind(store);
  store.readMnemonics = (n) => {
    mnemonicsRead = true;
    return orig(n);
  };
  const wrong = fakeChain('mainnet');
  const koios = wrong.koios();
  koios.network = { ...koios.network, name: 'preprod', magic: 1, koiosName: 'Testnet' };
  await assert.rejects(build({ store, koios, cli, manifestPath: mpath, network: 'preprod', identityName: 'rehearsal', coreOnly: true, stage: 'hypotheses' }), /refusing to run/);
  assert.equal(mnemonicsRead, false);
});

test('temporary secrets of a process that is gone are removed at startup; a live process\'s are kept', () => {
  const store = new Store(tempHome());
  store.ensure();
  const dead = store.path('tmp', 'secret-999999999-1-aa');
  const live = store.path('tmp', `secret-${process.pid}-2-bb`);
  const other = store.path('tmp', 'notes');
  for (const f of [dead, live, other]) fs.writeFileSync(f, 'x', { mode: 0o600 });
  const idDir = store.path('identities', 'rehearsal');
  fs.mkdirSync(idDir, { recursive: true, mode: 0o700 });
  const strayDead = path.join(idDir, '.signing-mnemonic.restore-999999999');
  const strayLive = path.join(idDir, `.payment-mnemonic.restore-${process.pid}`);
  for (const f of [strayDead, strayLive]) fs.writeFileSync(f, 'x', { mode: 0o600 });
  assert.deepEqual(store.cleanTmp(), ['tmp/secret-999999999-1-aa', 'identities/rehearsal/.signing-mnemonic.restore-999999999']);
  assert.equal(fs.existsSync(strayDead), false);
  assert.equal(fs.existsSync(strayLive), true);
  assert.equal(fs.existsSync(dead), false);
  assert.equal(fs.existsSync(live), true);
  assert.equal(fs.existsSync(other), true);
});

// A stranger's payment to the identity's address, built with CSL: the
// stranger's input, one output to the address, optional label-309 metadata,
// the stranger's witness.
function strangerPayment(stranger, to, { label309 } = {}) {
  const ins = CSL.TransactionInputs.new();
  ins.add(CSL.TransactionInput.new(CSL.TransactionHash.from_hex('77'.repeat(32)), 0));
  const outs = CSL.TransactionOutputs.new();
  outs.add(CSL.TransactionOutput.new(CSL.Address.from_bech32(to), CSL.Value.new(CSL.BigNum.from_str('1500000'))));
  const body = CSL.TransactionBody.new_tx_body(ins, outs, CSL.BigNum.from_str('200000'));
  let aux;
  if (label309) {
    const md = CSL.GeneralTransactionMetadata.new();
    const list = CSL.MetadataList.new();
    list.add(CSL.TransactionMetadatum.new_bytes(label309));
    md.insert(CSL.BigNum.from_str('309'), CSL.TransactionMetadatum.new_list(list));
    aux = CSL.AuxiliaryData.new();
    aux.set_metadata(md);
    body.set_auxiliary_data_hash(CSL.hash_auxiliary_data(aux));
  }
  const hash = CSL.FixedTransaction.new_from_body_bytes(body.to_bytes()).transaction_hash();
  const vkeys = CSL.Vkeywitnesses.new();
  vkeys.add(CSL.make_vkey_witness(hash, stranger.id.payment.privateKey));
  const ws = CSL.TransactionWitnessSet.new();
  ws.set_vkeys(vkeys);
  const tx = aux ? CSL.Transaction.new(body, ws, aux) : CSL.Transaction.new(body, ws);
  return { hash: toHex(hash.to_bytes()), cbor: toHex(tx.to_bytes()) };
}

// A payment with an indefinite-length inputs array (valid on chain; the
// strict slicer refuses it), written byte by byte.
function indefinitePayment(stranger, to) {
  const addr = CSL.Address.from_bech32(to).to_bytes();
  const input = encodeCbor([new Uint8Array(32).fill(0x78), 0]);
  const body = new Uint8Array([0xa3, 0x00, 0x9f, ...input, 0xff, 0x01, ...encodeCbor([[new Uint8Array(addr), 1500000]]), 0x02, ...encodeCbor(200000)]);
  const bodyHash = blake2b256(body);
  const sig = stranger.id.payment.privateKey.sign(bodyHash).to_bytes();
  const vk = stranger.id.payment.publicKey;
  const ws = encodeCbor(new Map([[0, [[vk, new Uint8Array(sig)]]]]));
  const tx = new Uint8Array([0x84, ...body, ...ws, 0xf5, 0xf6]);
  return { hash: toHex(bodyHash), cbor: toHex(tx) };
}

test('third-party transactions in the history cannot stop a mainnet final: malformed label-309 metadata and indefinite-length encodings are skipped unread', async () => {
  const { store, run } = await mainnetRun();
  const stranger = testIdentity(new Store(tempHome()), 'testfreeze', 'a stranger');
  const vOne = strangerPayment(stranger, run.report.payment_address, { label309: new Uint8Array([0xa1, 0x61, 0x76, 0x01]) }); // {"v": 1}
  const indefinite = indefinitePayment(stranger, run.report.payment_address);
  const txs = { [vOne.hash]: { cbor: vOne.cbor }, [indefinite.hash]: { cbor: indefinite.cbor } };
  const p = providers(run, { history: [vOne.hash, indefinite.hash], txs, tip: { abs_slot: 1000 } });
  const logs = [];
  const r = await submitRun({ store, dir: run.dir, log: (m) => logs.push(m), streams: streams(true, run.hash.slice(0, 8)), koios: p.koios, blockfrost: p.bf });
  assert.equal(r.outcome, 'submitted');
  assert.ok(logs.some((m) => /2 transaction\(s\) .* were not paid by this identity/.test(m)));
});

test('the chain scan stops on provider faults and on this identity\'s own unparseable or unknown records, and skips a forged witness', async () => {
  const lost = new Store(tempHome());
  const earlier = await mainnetRun({ store: lost, label: 'testfreeze', utxoTag: 'f' });
  const { store, run } = await mainnetRun({ label: 'testfreeze' });
  const submit = (p) => submitRun({ store, dir: run.dir, log: () => {}, streams: streams(true, run.hash.slice(0, 8)), koios: p.koios, blockfrost: p.bf });
  const h = earlier.run.hash;
  // The providers return different bytes.
  await assert.rejects(submit(providers(run, { history: [h], txs: { [h]: { cbor: earlier.run.cbor } }, bfTxs: { [h]: { cbor: earlier.run.cbor.replace(/..$/, '00') } } })), /CBOR differs between Koios and Blockfrost/);
  // Only Blockfrost returns the bytes: they are read and judged.
  await assert.rejects(submit(providers(run, { history: [h], txs: {}, bfTxs: { [h]: { cbor: earlier.run.cbor } } })), /this identity paid for it, and it carries a label-309 record/);
  // Bytes that are not the transaction with that hash.
  await assert.rejects(submit(providers(run, { history: ['9e'.repeat(32)], txs: { ['9e'.repeat(32)]: { cbor: earlier.run.cbor } } })), /not this transaction: its body hashes to/);
  // A forged witness: the identity's real record with its signature bytes flipped is not paid by it.
  const wsHex = toHex(CSL.FixedTransaction.from_bytes(Buffer.from(earlier.run.cbor, 'hex')).raw_witness_set());
  const sigAt = earlier.run.cbor.indexOf(wsHex) + wsHex.length - 128; // the witness set ends with the 64-byte signature
  const forged = earlier.run.cbor.slice(0, sigAt) + (earlier.run.cbor.slice(sigAt, sigAt + 2) === '00' ? '01' : '00') + earlier.run.cbor.slice(sigAt + 2);
  const r = await submit(providers(run, { history: [h], txs: { [h]: { cbor: forged } }, tip: { abs_slot: 1000 } }));
  assert.equal(r.outcome, 'submitted', 'a witness that does not verify does not make the identity the payer');
});

test('the run\'s own transaction in the history does not count, and an abandoned final that landed does', async () => {
  const { store, identity, run } = await mainnetRun();
  const own = providers(run, { history: [run.hash], txs: { [run.hash]: { cbor: run.cbor } }, tip: { abs_slot: 1000 } });
  // First an abandoned final A that is in fact on chain.
  const a = await fabricateRun(store, { network: 'mainnet', identity, extra: { stage: 'final' }, utxoTag: 'b' });
  journalConfirmed(store, 'mainnet', a, identity);
  store.updateJournal('mainnet', (j) => {
    j.history[0].state = 'abandoned';
  });
  const landed = providers(run, { history: [a.hash], txs: { [a.hash]: { cbor: a.cbor } } });
  await assert.rejects(submitRun({ store, dir: run.dir, log: () => {}, streams: streams(true, run.hash.slice(0, 8)), koios: landed.koios, blockfrost: landed.bf }), new RegExp(`${a.hash}: this identity paid for it`));
  const r = await submitRun({ store, dir: run.dir, log: () => {}, streams: streams(true, run.hash.slice(0, 8)), koios: own.koios, blockfrost: own.bf });
  assert.equal(r.outcome, 'submitted');
});

test('abandon on mainnet refuses to run without a Blockfrost project id', async () => {
  const { abandonJournal } = await import('../src/ops.mjs');
  const { store, identity } = await mainnetRun();
  await assert.rejects(abandonJournal({ store, network: 'mainnet', identityName: 'testfreeze', koios: fakeChain('mainnet').koios({ addresses: [identity.pub.addresses.mainnet] }) }), /abandon on mainnet asks Blockfrost too/);
});
