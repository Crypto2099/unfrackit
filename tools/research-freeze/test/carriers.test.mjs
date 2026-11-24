// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Other carriers of a run's record (src/carriers.mjs): the study's
// chain-order rule as `wait`, `verify` and `drawkey` apply it, over fake
// Koios and Blockfrost label-309 listings. A stranger's copy of the record
// sits in an earlier block, in this run's block before or after its
// transaction, or in a later block; with and without the 674 line, with
// co-signatures; with listings that lag or disagree.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Store } from '../src/store.mjs';
import { waitRun, verifyRun, drawKey, carrierLowerBound } from '../src/ops.mjs';
import { journal, journalEntry } from '../src/journal.mjs';
import { checkCitedHypotheses } from '../src/targets.mjs';
import { buildTransaction } from '../src/tx.mjs';
import { deriveIdentity } from '../src/keys.mjs';
import { encode, decode } from '../src/cbor.mjs';
import { protectedHeaderBytes, SIG_DOMAIN } from '../src/record.mjs';
import { carrierOf, signedContentOf, blockfrostSignal, koiosSignal } from '../src/carriers.mjs';
import { concat, toHex, fromHex } from '../src/util.mjs';
import { tempHome } from './helpers.mjs';
import { testIdentity, seededMnemonic, fakeChain, fakeBlockfrost, fabricateRun, hashedItems, blockOf } from './fixtures.mjs';

const sdkValid = async () => ({ verdict: 'valid', issues: [], signers: [] });
const fakeCli = { json: () => ({ status: 0, json: { verdict: 'valid', profile: 'signed', issues: [], signatures: [], record: { items: [] } } }) };
const NONCE = '8827df62e1c5f7909885b09cb156d6f1eca8b15eb793fa4758e95c8aa79a1d00';
const H = 5319000;
const FIRST = 136598400; // first slot of preprod epoch 320
const T_INDEX = 2;
const noWait = { sleep: async () => {} };

const stranger = deriveIdentity(seededMnemonic('stranger signing'), seededMnemonic('stranger payment'));
const cosigner = deriveIdentity(seededMnemonic('cosigner signing'), seededMnemonic('cosigner payment'));

const split = (body, n) => {
  const out = [];
  for (let o = 0; o < body.length; o += n) out.push(body.slice(o, o + n));
  return out;
};

// A stranger's transaction carrying `chunks` under label 309 (byte strings,
// or text strings with `text`) and `lines` under label 674.
let tagSeq = 0;
function strangerTx({ chunks, text = false, lines, extra674 } = {}) {
  const md = CSL.GeneralTransactionMetadata.new();
  if (chunks) {
    const list = CSL.MetadataList.new();
    for (const c of chunks) list.add(text ? CSL.TransactionMetadatum.new_text(c) : CSL.TransactionMetadatum.new_bytes(c));
    md.insert(CSL.BigNum.from_str('309'), CSL.TransactionMetadatum.new_list(list));
  }
  if (lines) {
    const msg = CSL.MetadataList.new();
    for (const l of lines) msg.add(CSL.TransactionMetadatum.new_text(l));
    const map = CSL.MetadataMap.new();
    map.insert(CSL.TransactionMetadatum.new_text('msg'), CSL.TransactionMetadatum.new_list(msg));
    if (extra674) map.insert(CSL.TransactionMetadatum.new_text(extra674[0]), CSL.TransactionMetadatum.new_text(extra674[1]));
    md.insert(CSL.BigNum.from_str('674'), CSL.TransactionMetadatum.new_map(map));
  }
  const aux = CSL.AuxiliaryData.new();
  aux.set_metadata(md);
  const tag = (++tagSeq).toString(16).padStart(2, '0');
  const utxos = [{ txHash: tag.repeat(32), index: 0, coin: 20000000n, assets: [], datumBytes: null, datumHash: null, refScript: null }];
  const tx = buildTransaction({ utxos, outputAddress: stranger.payment.address('preprod'), signer: stranger.payment.privateKey, networkId: 0, params: { minFeeA: 44n, minFeeB: 155381n, maxTxSize: 16384, coinsPerUtxoByte: 4310n }, ttl: 999999999, aux });
  return { hash: tx.hash, cbor: toHex(tx.bytes) };
}

// The run's record body with a co-signature added (CIP-190 "Signed payload
// and Sig_structure": each signer signs the body without sigs), valid or not.
async function coSigned(run, { valid = true } = {}) {
  const prot = protectedHeaderBytes(cosigner.signing.publicKey);
  const sigStructure = encode(['Signature1', prot, new Uint8Array(0), concat(SIG_DOMAIN, run.p.signed.bodyNoSigs)]);
  const signature = Uint8Array.from(await cosigner.signing.sign(sigStructure));
  if (!valid) signature[5] ^= 1;
  const rec = decode(run.body, { canonical: true });
  rec.set('sigs', [...rec.get('sigs'), new Map([['cose_sign1', encode([prot, new Map(), null, signature])]])]);
  return encode(rec);
}

const blockAt = (height) => (height === H ? blockOf({ height, hash: 'bb'.repeat(32), slot: FIRST + 101600, epoch: 320, epochSlot: 101600 }) : blockOf({ height, hash: height.toString(16).padStart(64, '0'), slot: FIRST + 101600 + (height - H) * 20, epoch: 320, epochSlot: 101600 + (height - H) * 20 }));

// A staged run in block H at index 2, and `copies` on both fake providers:
// { tx, height, index, koios: {...}, blockfrost: {...} } (per-provider fields
// override the served entry: listed, koiosMetadata, listingMetadata, cbor).
async function setup({ stage = 'final', copies = [], own = {}, network = 'preprod', name = 'rehearsal', tipAtBuild } = {}) {
  const store = new Store(tempHome());
  store.ensure();
  const identity = testIdentity(store, name);
  const hyp = stage === 'hypotheses';
  const items = hyp ? hashedItems([{ type: 'StudyRegistration', document: true, ids: [{ id: '10.5281/zenodo.1', id_type: 'DOI', relation: 'IsPartOf' }] }]) : undefined;
  const run = await fabricateRun(store, { network, identity, coreOnly: hyp, items, extra: { stage } });
  if (tipAtBuild !== undefined) {
    const report = JSON.parse(fs.readFileSync(path.join(run.dir, 'report.json'), 'utf8'));
    store.updateRunFile(run.dir, 'report.json', JSON.stringify({ ...report, tip_at_build: { ...report.tip_at_build, height: tipAtBuild } }));
  }
  journal(store, journalEntry({ network, txHash: run.hash, cbor: run.cbor, ttl: run.p.ttl, inputs: run.p.tx.inputs, run: run.dir, kind: 'freeze', stage, identity: name, signingPublicKey: identity.pub.signing_public_key }));
  const b0 = blockAt(H);
  const ktxs = { [run.hash]: { cbor: run.cbor, confirmations: 15, block: b0.koios, index: T_INDEX, ...(own.koios || {}) } };
  const btxs = { [run.hash]: { cbor: run.cbor, block: b0.blockfrost, index: T_INDEX, ...(own.blockfrost || {}) } };
  for (const c of copies) {
    const b = blockAt(c.height);
    ktxs[c.tx.hash] = { cbor: c.tx.cbor, confirmations: 15, block: b.koios, index: c.index ?? 0, ...(c.koios || {}) };
    btxs[c.tx.hash] = { cbor: c.tx.cbor, block: b.blockfrost, index: c.index ?? 0, ...(c.blockfrost || {}) };
  }
  const k = fakeChain(network, { txs: ktxs, epochParams: { 321: { epoch_no: 321, nonce: NONCE, protocol_major: 11 } } });
  const bfake = fakeBlockfrost(network, { txs: btxs, epochParams: { 321: { epoch: 321, nonce: NONCE, protocol_major_ver: 11 } } });
  const koios = k.koios({ txHashes: [...store.knownTxHashes(network)], addresses: [run.report.payment_address] });
  const bf = bfake.bf({ txHashes: [run.hash] });
  return { store, identity, run, k, b: bfake, koios, bf, network };
}

const verify = (s, scanOptions = noWait) => verifyRun({ store: s.store, cli: fakeCli, arg: s.run.dir, network: s.network, log: () => {}, koios: s.koios, blockfrost: s.bf, sdkImpl: sdkValid, scanOptions });
const wait = (s, opts = {}) => waitRun({ store: s.store, dir: s.run.dir, log: () => {}, koios: s.koios, blockfrost: s.bf, waitOptions: { sleep: async () => {}, now: () => 0, scanAttempts: 2, ...opts } });
const report = (s) => JSON.parse(fs.readFileSync(path.join(s.run.dir, 'report.json'), 'utf8'));
function started(s) {
  s.k.chain.tip = { ...s.k.chain.tip, epoch_no: 321, block_height: H + 2200 };
  s.b.state.tip = { ...s.b.state.tip, epoch: 321, height: H + 2200 };
}
const drawkey = (s) => drawKey({ store: s.store, dir: s.run.dir, log: () => {}, koios: s.koios, blockfrost: s.bf, scanOptions: noWait });

// The run's own record in a stranger's transaction: re-chunked (40-byte
// chunks), with `lines` under 674.
const copyOf = (run, lines, body = run.body) => strangerTx({ chunks: split(body, 40), lines });

// A copy of this run's record placed on both providers.
async function withCopy({ stage = 'final', make, height, index = 0, koios = {}, blockfrost = {}, more = [] }) {
  const s = await setup({ stage });
  const tx = await make(s.run);
  const b = blockAt(height);
  s.k.chain.txs[tx.hash] = { cbor: tx.cbor, confirmations: 15, block: b.koios, index, ...koios };
  s.b.state.txs[tx.hash] = { cbor: tx.cbor, block: b.blockfrost, index, ...blockfrost };
  for (const m of more) {
    const x = await m.make(s.run);
    const bb = blockAt(m.height);
    s.k.chain.txs[x.hash] = { cbor: x.cbor, confirmations: 15, block: bb.koios, index: m.index ?? 0, ...(m.koios || {}) };
    s.b.state.txs[x.hash] = { cbor: x.cbor, block: bb.blockfrost, index: m.index ?? 0, ...(m.blockfrost || {}) };
  }
  return { ...s, copy: tx };
}

test('no other carrier: verify is valid and reports the scan, bounded k blocks under the tip at build', async () => {
  const s = await setup();
  const r = await verify(s);
  assert.equal(r.verdict, 'valid', r.issues.join('; '));
  assert.equal(r.carriers.decided, true);
  assert.deepEqual(r.carriers.carriers, []);
  assert.equal(r.carriers.first_carrier, s.run.hash);
  assert.equal(r.carriers.lower_height, 0, 'tip height 1 at build, less k');
  assert.deepEqual(r.carriers.block, { height: H, hash: 'bb'.repeat(32), index: T_INDEX });
  assert.match(r.carriers.rule, /exactly the document digest/);
  assert.ok(s.k.calls.includes('/tx_by_metalabel'));
  assert.ok(s.b.calls.some((c) => c.startsWith('/metadata/txs/labels/309/cbor')));
});

test('a complete copy of the final record in an earlier block: verify, wait and drawkey refuse, naming it', async () => {
  const u = await withCopy({ make: (run) => copyOf(run, run.p.lines), height: H - 5 });
  const c = u.copy;
  const r = await verify(u);
  assert.equal(r.verdict, 'failed');
  const msg = r.issues.join('; ');
  assert.match(msg, new RegExp(`${c.hash} \\(block ${H - 5}, index 0\\) carries this run's final record with its label-674 line and comes before ${u.run.hash} \\(block ${H}, index ${T_INDEX}\\)`));
  assert.match(msg, /chain-order rule the first such transaction is the final freeze, so the draw is keyed to its block, not to this run's transaction/);
  assert.equal(r.carriers.earlier[0].tx_hash, c.hash);
  // wait keeps the confirmation and records no plan.
  await assert.rejects(wait(u), new RegExp(`the draw plan is not recorded: ${c.hash}`));
  assert.equal(report(u).confirmed.confirmations, 15);
  assert.equal(report(u).draw, undefined);
  // drawkey refuses, writing nothing.
  started(u);
  await assert.rejects(drawkey(u), new RegExp(`drawkey: ${c.hash} .* comes before ${u.run.hash}`));
  assert.equal(fs.existsSync(path.join(u.run.dir, 'drawkey.json')), false);
});

test('in this run\'s block, a complete copy before its transaction refuses and one after it does not', async () => {
  const before = await withCopy({ make: (run) => copyOf(run, run.p.lines), height: H, index: T_INDEX - 1 });
  const r = await verify(before);
  assert.equal(r.verdict, 'failed');
  assert.match(r.issues.join('; '), new RegExp(`${before.copy.hash} \\(block ${H}, index ${T_INDEX - 1}\\) carries this run's final record`));
  const after = await withCopy({ make: (run) => copyOf(run, run.p.lines), height: H, index: T_INDEX + 1 });
  const v = await verify(after);
  assert.equal(v.verdict, 'valid', v.issues.join('; '));
  assert.deepEqual(v.carriers.carriers.map((c) => [c.tx_hash, c.precedes, c.label_674_exact]), [[after.copy.hash, false, true]]);
  assert.equal(v.carriers.first_carrier, after.run.hash);
  // wait records the plan when the only copy comes after.
  const w = await wait(after);
  assert.equal(w.draw.nonce_epoch, 321);
  assert.equal(w.draw.carrier_scan.decided, true);
});

test('a complete copy in a later block does not refuse, and is not read', async () => {
  const s = await withCopy({ make: (run) => copyOf(run, run.p.lines), height: H + 3 });
  const r = await verify(s);
  assert.equal(r.verdict, 'valid', r.issues.join('; '));
  assert.deepEqual(r.carriers.carriers, []);
  assert.deepEqual(r.carriers.read, []);
  started(s);
  const d = await drawkey(s);
  assert.equal(d.nonce, NONCE);
  assert.equal(d.carrier_scan.decided, true);
});

test('earlier copies the rule does not count do not refuse: no 674 line, other 674 lines, co-signed without the line, a co-signature that does not verify, no signature, a line without the record', async () => {
  const cases = [
    ['no 674 line', (run) => copyOf(run, null)],
    ['the digest among other lines', (run) => copyOf(run, [run.p.lines[0], 'x'])],
    ['another line first', (run) => copyOf(run, ['x', run.p.lines[0]])],
    ['co-signed, without the 674 line', async (run) => copyOf(run, null, await coSigned(run))],
    ['a co-signature that does not verify', async (run) => copyOf(run, run.p.lines, await coSigned(run, { valid: false }))],
    ['the record without its signature', (run) => strangerTx({ chunks: split(run.p.signed.bodyNoSigs, 64), lines: run.p.lines })],
    ['the line without the record', (run) => strangerTx({ lines: run.p.lines })]
  ];
  for (const [what, make] of cases) {
    const s = await withCopy({ make, height: H - 2 });
    const r = await verify(s);
    assert.equal(r.verdict, 'valid', `${what}: ${r.issues.join('; ')}`);
    assert.deepEqual(r.carriers.earlier, [], what);
    const counted = r.carriers.carriers.map((c) => c.label_674_exact);
    if (what === 'the line without the record') {
      assert.deepEqual([counted, r.carriers.examined], [[], 0], `${what}: not in either label-309 listing`);
    } else if (what === 'a co-signature that does not verify' || what === 'the record without its signature') {
      assert.deepEqual(counted, [], `${what}: not a carrier`);
      assert.deepEqual(r.carriers.look_alikes, [s.copy.hash], what);
    } else assert.deepEqual(counted, [false], `${what}: a carrier without the exact line`);
  }
});

test('a co-signed complete copy is the same record, and refuses when earlier', async () => {
  const s = await withCopy({ make: async (run) => copyOf(run, run.p.lines, await coSigned(run)), height: H - 1, index: 4 });
  const r = await verify(s);
  assert.equal(r.verdict, 'failed');
  assert.equal(r.carriers.earlier[0].tx_hash, s.copy.hash);
  assert.deepEqual(r.carriers.earlier[0].signers, [s.identity.pub.signing_public_key, toHex(cosigner.signing.publicKey)]);
});

test('a lagging listing leaves the scan undecided until both providers list this run\'s transaction', async () => {
  // Koios has not indexed the block yet.
  const k = await setup({ own: { koios: { listed: false } } });
  const r = await verify(k);
  assert.equal(r.verdict, 'failed');
  assert.match(r.issues.join('; '), /undecided: Koios's label-309 listing does not include this run's transaction yet/);
  assert.equal(r.carriers.attempts, 3);
  k.k.chain.txs[k.run.hash].listed = true;
  assert.equal((await verify(k)).verdict, 'valid');
  // Blockfrost lags behind an earlier label-309 transaction both list.
  const b = await withCopy({ make: (run) => copyOf(run, null), height: H - 4, blockfrost: {} });
  b.b.state.txs[b.run.hash].listed = false;
  const v = await verify(b);
  assert.match(v.issues.join('; '), new RegExp(`Blockfrost's label-309 listing does not include this run's transaction before ${b.copy.hash}, which Koios lists in block ${H - 4}`));
  // wait tries again until the listing catches up, then records the plan.
  const w = await setup({ own: { blockfrost: { listed: false } } });
  let tries = 0;
  const facts = await wait(w, {
    scanAttempts: 5,
    sleep: async () => {
      tries++;
      if (tries === 2) w.b.state.txs[w.run.hash].listed = true;
    }
  });
  assert.equal(facts.draw.carrier_scan.attempts, 3);
  assert.equal(facts.draw.nonce_epoch, 321);
  // and gives up, recording no plan, when it never does.
  const never = await setup({ own: { blockfrost: { listed: false } } });
  await assert.rejects(wait(never), /the draw plan is not recorded: the scan for other carriers of this record is undecided/);
  assert.equal(report(never).draw, undefined);
});

test('provider disagreement leaves the scan undecided: listings, a carrier\'s bytes, its place', async () => {
  const bfOnly = await withCopy({ make: (run) => copyOf(run, null), height: H - 3, koios: { listed: false } });
  assert.match((await verify(bfOnly)).issues.join('; '), new RegExp(`Blockfrost lists ${bfOnly.copy.hash} between this run's transaction and the anchor; Koios does not list it`));
  const kOnly = await withCopy({ make: (run) => copyOf(run, null), height: H - 3, blockfrost: { listed: false } });
  assert.match((await verify(kOnly)).issues.join('; '), new RegExp(`Koios lists ${kOnly.copy.hash} in block ${H - 3}; Blockfrost's listing does not place it before`));
  const kOnlySame = await withCopy({ make: (run) => copyOf(run, null), height: H, index: 5, blockfrost: { listed: false } });
  assert.match((await verify(kOnlySame)).issues.join('; '), new RegExp(`Koios lists ${kOnlySame.copy.hash} in this run's block ${H}; Blockfrost's listing does not include it`));
  const bytes = await withCopy({ make: (run) => copyOf(run, run.p.lines), height: H - 3, blockfrost: { servedCbor: null } });
  bytes.b.state.txs[bytes.copy.hash].servedCbor = bytes.run.cbor;
  assert.match((await verify(bytes)).issues.join('; '), new RegExp(`the bytes of ${bytes.copy.hash} differ between Koios and Blockfrost`));
  const one = await withCopy({ make: (run) => copyOf(run, run.p.lines), height: H - 3, blockfrost: { servedCbor: null } });
  assert.match((await verify(one)).issues.join('; '), new RegExp(`only Koios returns the bytes of ${one.copy.hash}`));
  const wrong = await withCopy({ make: (run) => copyOf(run, run.p.lines), height: H - 3 });
  wrong.k.chain.txs[wrong.copy.hash].servedCbor = wrong.run.cbor;
  wrong.b.state.txs[wrong.copy.hash].servedCbor = wrong.run.cbor;
  assert.match((await verify(wrong)).issues.join('; '), new RegExp(`the bytes the providers return for ${wrong.copy.hash} are not that transaction: its body hashes to ${wrong.run.hash}`));
  const place = await withCopy({ make: (run) => copyOf(run, run.p.lines), height: H - 3, index: 1, blockfrost: { index: 7 } });
  assert.match((await verify(place)).issues.join('; '), new RegExp(`Koios and Blockfrost place ${place.copy.hash} differently: index 1 vs 7`));
});

test('one provider\'s metadata view never rules out a carrier alone: the bytes are read from both and decide', async () => {
  // Blockfrost's listing shows another value for a complete earlier copy;
  // Koios's JSON shows the record. The bytes decide: it is the final freeze.
  const hidden = await withCopy({ make: (run) => copyOf(run, run.p.lines), height: H - 6, blockfrost: { listingMetadata: 'a11901358140' } });
  const r = await verify(hidden);
  assert.equal(r.verdict, 'failed');
  assert.deepEqual(r.carriers.read, [hidden.copy.hash]);
  assert.equal(r.carriers.earlier[0].tx_hash, hidden.copy.hash);
  // And the other way round.
  const hiddenK = await withCopy({ make: (run) => copyOf(run, run.p.lines), height: H - 6, koios: { koiosMetadata: { 309: ['0x00'] } } });
  assert.equal((await verify(hiddenK)).carriers.earlier[0].tx_hash, hiddenK.copy.hash);
  // A label-309 value of text strings that read like the record's chunks in
  // db-sync's JSON: Koios's view matches, the bytes are read, and it is no
  // carrier.
  const mimic = await withCopy({ make: (run) => strangerTx({ chunks: split(run.body, 31).map((c) => `0x${toHex(c)}`), text: true, lines: run.p.lines }), height: H - 6 });
  const m = await verify(mimic);
  assert.equal(m.verdict, 'valid', m.issues.join('; '));
  assert.deepEqual(m.carriers.read, [mimic.copy.hash]);
  assert.deepEqual(m.carriers.look_alikes, [mimic.copy.hash]);
  assert.deepEqual(m.carriers.carriers, []);
});

test('the hypotheses record: an earlier copy is the chain\'s first carrier, which verify reports without refusing', async () => {
  const s = await withCopy({ stage: 'hypotheses', make: (run) => copyOf(run, null), height: H - 2 });
  const r = await verify(s);
  assert.equal(r.verdict, 'valid', r.issues.join('; '));
  assert.equal(r.carriers.first_carrier, s.copy.hash);
  assert.deepEqual(r.carriers.earlier.map((c) => [c.tx_hash, c.label_674_exact]), [[s.copy.hash, false]]);
  assert.match(r.carriers.rule, /hypotheses record's first carrier/);
  const cosigned = await withCopy({ stage: 'hypotheses', make: async (run) => copyOf(run, run.p.lines, await coSigned(run)), height: H, index: 0 });
  assert.equal((await verify(cosigned)).carriers.first_carrier, cosigned.copy.hash, 'a co-signed copy ahead in the same block');
  const later = await withCopy({ stage: 'hypotheses', make: (run) => copyOf(run, null), height: H + 1 });
  assert.equal((await verify(later)).carriers.first_carrier, later.run.hash);
  // An undecided scan of a hypotheses record lets verify pass no more than a final's.
  const lag = await setup({ stage: 'hypotheses', own: { koios: { listed: false } } });
  assert.equal((await verify(lag)).verdict, 'failed');
});

test('the anchor bounds the scan: both listings agree from the newest label-309 transaction at or below the lower bound', async () => {
  const lower = H - 100 - 2160;
  const s = await setup({ tipAtBuild: H - 100 });
  const anchor = strangerTx({ chunks: [new Uint8Array([0xa0])] });
  const older = strangerTx({ chunks: [new Uint8Array([0xa1])] });
  const inRange = strangerTx({ chunks: [new Uint8Array([0xa2])] });
  for (const [x, height] of [[anchor, lower - 50], [older, lower - 5000], [inRange, lower + 10]]) {
    const b = blockAt(height);
    s.k.chain.txs[x.hash] = { cbor: x.cbor, confirmations: 15, block: b.koios, index: 0 };
    s.b.state.txs[x.hash] = { cbor: x.cbor, block: b.blockfrost, index: 0 };
  }
  const r = await verify(s);
  assert.equal(r.verdict, 'valid', r.issues.join('; '));
  assert.equal(r.carriers.lower_height, lower);
  assert.deepEqual(r.carriers.anchor, { tx_hash: anchor.hash, block_height: lower - 50, block_hash: blockAt(lower - 50).koios.block_hash });
  assert.equal(r.carriers.examined, 1, 'only the transaction between the anchor and this run is examined');
  assert.deepEqual(r.carriers.read, []);
  assert.equal(r.carriers.listed, 2, 'this run and the one in range');
  // Blockfrost must place the anchor's block at the same height and hold the
  // anchor in it, since its listing is read down to the anchor.
  const b = s.b.state.txs[anchor.hash].block;
  s.b.state.txs[anchor.hash].block = { ...b, height: lower + 30 };
  assert.match((await verify(s)).issues.join('; '), new RegExp(`Koios lists the anchor ${anchor.hash} in block ${b.hash} at height ${lower - 50}; Blockfrost places that block at height ${lower + 30}`));
  s.b.state.txs[anchor.hash].block = b;
  // A Blockfrost listing that ends before the anchor disagrees with Koios.
  s.b.state.txs[anchor.hash].listed = false;
  s.b.state.txs[older.hash].listed = false;
  assert.match((await verify(s)).issues.join('; '), new RegExp(`Blockfrost's label-309 listing ends without reaching the anchor ${anchor.hash}`));
  // Koios naming an anchor Blockfrost's block does not hold.
  delete s.b.state.txs[anchor.hash];
  s.b.state.txs[older.hash] = { ...s.b.state.txs[older.hash], block: b, listed: true };
  assert.match((await verify(s)).issues.join('; '), new RegExp(`Koios lists the anchor ${anchor.hash} in block ${b.hash}; Blockfrost's block holds no such transaction`));
});

test('the lower bound follows a rebuilt record to the run that signed it, and refuses without that run', async () => {
  const s = await setup();
  const a = report(s);
  const store = s.store;
  const b = await fabricateRun(store, { network: 'preprod', identity: s.identity, extra: { stage: 'final' }, utxoTag: 'e' });
  const rb = JSON.parse(fs.readFileSync(path.join(b.dir, 'report.json'), 'utf8'));
  const rebuilt = { ...rb, tip_at_build: { ...rb.tip_at_build, height: 9000 }, replaces: a.tx_hash };
  store.updateRunFile(s.run.dir, 'report.json', JSON.stringify({ ...a, tip_at_build: { ...a.tip_at_build, height: 7000 } }));
  assert.equal(carrierLowerBound(store, 'preprod', rebuilt, 2160), 7000 - 2160);
  assert.equal(carrierLowerBound(store, 'preprod', { ...rebuilt, replaces: undefined }, 2160), 9000 - 2160);
  assert.throws(() => carrierLowerBound(store, 'preprod', { ...rebuilt, replaces: 'ef'.repeat(32) }, 2160), new RegExp(`the run directory of ${'ef'.repeat(32)}, whose record .* carries, is missing`));
  assert.throws(() => carrierLowerBound(store, 'preprod', { ...rebuilt, tip_at_build: undefined }, 2160), /records no tip height at build/);
});

test('on mainnet wait refuses a final freeze without Blockfrost, before any request', async () => {
  const s = await setup({ network: 'mainnet', name: 'testfreeze' });
  await assert.rejects(waitRun({ store: s.store, dir: s.run.dir, log: () => {}, koios: s.koios, waitOptions: { sleep: async () => {} } }), /wait records the draw plan of a mainnet final freeze only after Koios and Blockfrost list no earlier carrier/);
  assert.deepEqual(s.k.calls, []);
});

test('the clients read in full only the listed transactions the scan marks', async () => {
  const s = await withCopy({ make: (run) => copyOf(run, null), height: H - 2 });
  const stray = 'ab'.repeat(32);
  await assert.rejects(s.koios.txMetadata([stray]), /no label-309 listing returned it/);
  assert.throws(() => s.koios.allowCarrier(stray), /no label-309 listing returned it/);
  assert.throws(() => s.bf.allowCarrier(stray), /no label-309 listing returned it/);
  await s.koios.label309Txs({ from: 0, upTo: H, order: 'asc', limit: 1000 });
  await assert.rejects(s.koios.txCbor(s.copy.hash), /not one of this tool's own transactions/);
  await s.bf.label309Page(1);
  await assert.rejects(s.bf.txCbor(s.copy.hash), /not one of this tool's own transactions/);
  s.koios.allowCarrier(s.copy.hash);
  s.bf.allowCarrier(s.copy.hash);
  assert.equal(await s.koios.txCbor(s.copy.hash), s.copy.cbor);
  assert.equal(await s.bf.txCbor(s.copy.hash), s.copy.cbor);
});

test('the rule on transaction bytes: chunking and other metadata leave the record, a wallet-path or missing signature does not carry it', async () => {
  const s = await setup();
  const run = s.run;
  const signed = signedContentOf(run.body);
  assert.equal(toHex(signed), toHex(run.p.signed.bodyNoSigs));
  const ours = { signed, key: s.identity.pub.signing_public_key, line: run.p.lines[0] };
  const facts = (tx) => carrierOf(fromHex(tx.cbor), tx.hash, ours);
  assert.deepEqual(facts({ hash: run.hash, cbor: run.cbor }), { bound: true, carries: true, label_674_exact: true, signers: [ours.key] });
  assert.equal(facts(strangerTx({ chunks: split(run.body, 1), lines: run.p.lines })).carries, true, 'one-byte chunks');
  assert.equal(facts(strangerTx({ chunks: split(run.body, 64), lines: run.p.lines, extra674: ['note', 'copy'] })).label_674_exact, true, 'another key in the 674 map');
  // A wallet-path entry beside the signature: not every signature verifies under the rule.
  const rec = decode(run.body, { canonical: true });
  rec.set('sigs', [new Map([['cose_key', new Uint8Array([0xa0])], ['cose_sign1', run.p.signed.coseSign1]])]);
  assert.equal(facts(strangerTx({ chunks: split(encode(rec), 64), lines: run.p.lines })).carries, false);
  rec.set('sigs', []);
  assert.equal(facts(strangerTx({ chunks: split(encode(rec), 64), lines: run.p.lines })).carries, false, 'no signature');
  // Bytes that are not the transaction asked for.
  assert.equal(carrierOf(fromHex(run.cbor), 'cd'.repeat(32), ours).bound, false);
  // The metadata views.
  assert.equal(blockfrostSignal(null, signed), 'unreadable');
  assert.equal(blockfrostSignal(toHex(concat(Uint8Array.of(0xa1, 0x19, 0x01, 0x35), encode(split(run.body, 64)))), signed), 'match');
  assert.equal(koiosSignal(split(run.body, 64).map((c) => `0x${toHex(c)}`), signed), 'match');
  assert.equal(koiosSignal(['hello'], signed), 'unreadable');
  assert.equal(koiosSignal({ v: 1 }, signed), 'other');
  assert.equal(koiosSignal(undefined, signed), 'unreadable');
});

test('a final build keeps citing this home\'s hypotheses transaction when a copy came first, and reports the copy', async () => {
  const h = await withCopy({ stage: 'hypotheses', make: (run) => copyOf(run, null), height: H - 2 });
  const v = await verify(h);
  assert.equal(v.carriers.first_carrier, h.copy.hash);
  journal(h.store, journalEntry({ network: 'preprod', txHash: h.run.hash, cbor: h.run.cbor, ttl: 1, inputs: h.run.p.tx.inputs, run: h.run.dir, kind: 'freeze', stage: 'hypotheses' }));
  h.store.updateJournal('preprod', (j) => {
    j.current.state = 'confirmed';
    j.history = [...(j.history || []), j.current];
    j.current = null;
  });
  const r = report(h);
  h.store.updateRunFile(h.run.dir, 'report.json', JSON.stringify({ ...r, confirmed: { confirmations: 15 } }));
  const t = await checkCitedHypotheses({ store: h.store, koios: h.koios, network: 'preprod', cited: [h.run.hash], publicKeyHex: h.identity.pub.signing_public_key, paymentKeyHash: h.identity.pub.payment_key_hash });
  assert.equal(t.tx_hash, h.run.hash, 'the document cites this home\'s own transaction');
  assert.equal(t.chain_first_carrier, h.copy.hash);
});
