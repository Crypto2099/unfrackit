// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The final-freeze checks and the draw key, on synthetic records signed here
// with a fresh Ed25519 key and stored as db-sync stores them (the label-309
// chunk array inside a single-label metadata map). The records follow
// CIP-190 (CIPs@58b4dd1417, CIP-0190: "Record model", "Canonical CBOR",
// "Metadata label 309 and the chunk-array transport", "Signed payload and
// Sig_structure", "Signer-key identification", path 1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { encode } from '../lib/cbor-encode.mjs';
import { loadAll } from '../../src/sqlfile.mjs';
import { verifyFinalFreeze, drawKey, drawEpoch, stabilityWindow, reassemble, parseRecord, verifySignatures, logPrefixDigests, drawkeyFileErrors } from '../../src/freeze.mjs';
import { decode } from '../../src/cbor.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const blocks = loadAll();

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, pub: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url') };
}

// A signed record body. `tamper` changes the body after signing.
function record(digests, key, { tamper = false, unsorted = false, supersedes = null } = {}) {
  const items = digests.map((d) => ({ hashes: { 'sha2-256': Buffer.from(d, 'hex') } }));
  const body0 = supersedes ? { v: 1, items, supersedes: Buffer.from(supersedes, 'hex') } : { v: 1, items };
  const toSign = Buffer.concat([Buffer.from('cardano-poe-record-sig-v1'), encode(body0)]);
  const prot = encode(new Map([[1, -8], [4, key.pub]]));
  const sig = sign(null, encode(['Signature1', prot, Buffer.alloc(0), toSign]), key.privateKey);
  const cose = encode([prot, {}, null, sig]);
  const signedItems = tamper ? [...items, { hashes: { 'sha2-256': Buffer.alloc(32, 7) } }] : items;
  return encode({ ...body0, items: signedItems, sigs: [{ cose_sign1: cose }] }, { sortKeys: !unsorted });
}

const metadataBytes = (body, size = 64) => {
  const chunks = [];
  for (let i = 0; i < body.length; i += size) chunks.push(body.subarray(i, i + size));
  return encode(new Map([[309, chunks]]));
};

async function chain() {
  const db = await PGlite.create();
  await db.exec(`
    CREATE TABLE block (id bigint PRIMARY KEY, block_no bigint, slot_no bigint, epoch_no int, epoch_slot_no int, time timestamp, hash bytea);
    CREATE TABLE tx (id bigint PRIMARY KEY, hash bytea, block_id bigint);
    CREATE TABLE tx_metadata (id serial PRIMARY KEY, key numeric, json jsonb, bytes bytea, tx_id bigint);
    CREATE TABLE epoch_param (epoch_no int PRIMARY KEY, nonce bytea, protocol_major int);
  `);
  let n = 0;
  const add = async ({ blockNo, slot, epoch, epochSlot, body, msg }) => {
    n++;
    const hash = sha(`tx ${n}`);
    await db.query(`INSERT INTO block VALUES ($1, $2, $3, $4, $5, now(), decode($6, 'hex'))`, [n, blockNo, slot, epoch, epochSlot, sha(`block ${n}`)]);
    await db.query(`INSERT INTO tx VALUES ($1, decode($2, 'hex'), $1)`, [n, hash]);
    if (body) await db.query(`INSERT INTO tx_metadata (key, json, bytes, tx_id) VALUES (309, NULL, $1, $2)`, [body, n]);
    if (msg) await db.query(`INSERT INTO tx_metadata (key, json, bytes, tx_id) VALUES (674, $1, '\\x00'::bytea, $2)`, [JSON.stringify({ msg: [msg] }), n]);
    return hash;
  };
  return { db, add };
}

async function scenario(over = {}) {
  const key = keypair();
  const dir = mkdtempSync(join(tmpdir(), 'rc-freeze-'));
  const hypDoc = Buffer.from(`hypotheses text\nkey ${key.pub.toString('hex')}\n`);
  const hypDigest = sha(hypDoc);
  const code = [{ path: 'src/a.mjs', sha256: sha('a') }, { path: 'sql/b.sql', sha256: sha('b') }];
  const { db, add } = await chain();
  const hypTx = await add({ blockNo: 1000, slot: 50000, epoch: 10, epochSlot: 1000, body: metadataBytes(over.hypBody ? over.hypBody(key, hypDigest) : record([hypDigest], key)), msg: hypDigest });
  const finalDoc = Buffer.from(`final text\nkey ${key.pub.toString('hex')}\nhypotheses web+cardano://transaction/${over.citeTx || hypTx}/metadata/309\n`);
  const finalDigest = sha(finalDoc);
  const items = over.items ? over.items(finalDigest, code) : [finalDigest, ...code.map((c) => c.sha256)];
  const signer = over.signer ? over.signer(key) : key;
  const body = over.body ? over.body(items, signer) : record(items, signer);
  // A copy of the record (or of the 674 line) in a transaction before the
  // final freeze: the record's body republished, as CIP-190 allows anyone to.
  let copyTx = null;
  if (over.copyBefore === 'body') copyTx = await add({ blockNo: 1500, slot: 75000, epoch: 11, epochSlot: 1000, body: metadataBytes(body, 50) });
  if (over.copyBefore === 'msg') copyTx = await add({ blockNo: 1500, slot: 75000, epoch: 11, epochSlot: 1000, msg: finalDigest });
  const freezeTx = await add({ blockNo: 2000, slot: 100000, epoch: 11, epochSlot: 5000, body: metadataBytes(body, over.chunk || 64), msg: over.msg || finalDigest });
  if (over.copyAfter) await add({ blockNo: 2500, slot: 120000, epoch: 11, epochSlot: 9000, body: metadataBytes(body), msg: finalDigest });
  writeFileSync(join(dir, 'final.md'), finalDoc);
  writeFileSync(join(dir, 'hyp.md'), hypDoc);
  const args = { client: db, blocks, freezeTx, hypothesesTx: hypTx, preregPath: join(dir, 'final.md'), studyKey: key.pub.toString('hex'), codeDigests: code, tipBlockNo: over.tip || 5000 };
  return { db, dir, key, hypTx, freezeTx, copyTx, finalDigest, items, args, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const failed = (v) => v.checks.filter((c) => !c.ok).map((c) => c.name);

test('a final freeze record passes every check', async () => {
  const s = await scenario();
  try {
    const v = await verifyFinalFreeze(s.args);
    assert.deepEqual(failed(v), []);
    assert.equal(v.ok, true);
    assert.equal(v.freeze.tx, s.freezeTx);
    assert.equal(v.hypotheses.tx, s.hypTx);
  } finally {
    s.cleanup();
  }
});

test('the hypotheses record is refused as the final one, with either document', async () => {
  const s = await scenario();
  try {
    const v1 = await verifyFinalFreeze({ ...s.args, freezeTx: s.hypTx });
    assert.equal(v1.ok, false);
    for (const n of ['label_674_is_document_digest', 'document_is_an_item', 'hypotheses_tx_differs', 'code_files_are_items']) assert.ok(failed(v1).includes(n), n);
    const v2 = await verifyFinalFreeze({ ...s.args, freezeTx: s.hypTx, preregPath: join(s.dir, 'hyp.md') });
    assert.equal(v2.ok, false);
    assert.ok(failed(v2).includes('document_cites_hypotheses_record'));
  } finally {
    s.cleanup();
  }
});

test('refusals: another signer, a body changed after signing, missing code digests, a shallow block, a non-canonical record, an oversized chunk', async () => {
  const cases = [
    [{ signer: () => keypair() }, 'signed_by_study_key'],
    [{ body: (items, key) => record(items, key, { tamper: true }) }, 'signed_by_study_key'],
    [{ items: (d, code) => [d, code[0].sha256] }, 'code_files_are_items'],
    [{ tip: 2100 }, 'freeze_block_depth'],
    [{ body: (items, key) => record(items, key, { unsorted: true }) }, 'label_309_record'],
    [{ chunk: 65 }, 'label_309_record'],
    [{ msg: 'ab'.repeat(32) }, 'label_674_is_document_digest'],
    [{ citeTx: 'cd'.repeat(32) }, 'document_cites_hypotheses_record'],
    [{ body: (items, key) => record(items, key, { supersedes: 'ef'.repeat(32) }) }, 'record_has_no_supersedes'],
    [{ copyBefore: 'body' }, 'first_carrier_of_the_record'],
    [{ copyBefore: 'msg' }, 'first_carrier_of_the_record']
  ];
  for (const [over, name] of cases) {
    const s = await scenario(over);
    try {
      const v = await verifyFinalFreeze(s.args);
      assert.equal(v.ok, false, name);
      assert.ok(failed(v).includes(name), `${name}: failed ${failed(v).join(', ')}`);
    } finally {
      s.cleanup();
    }
  }
});

test('the record is read from the chunks as stored, and its signature covers the body without sigs', () => {
  const key = keypair();
  const body = record([sha('x'), sha('y')], key);
  const rec = parseRecord(reassemble(metadataBytes(body).toString('hex')));
  assert.deepEqual(rec.digests, [sha('x'), sha('y')]);
  const sigs = verifySignatures(rec);
  assert.deepEqual(sigs.map((x) => [x.kid, x.valid]), [[key.pub.toString('hex'), true]]);
  assert.throws(() => decode(Buffer.from([0xa2, 0x61, 0x62, 0x01, 0x61, 0x61, 0x02])), /strictly increasing/);
  assert.throws(() => decode(Buffer.from([0x18, 0x05])), /shortest form/);
  assert.throws(() => decode(Buffer.from([0x9f, 0xff])), /indefinite/);
});

test('the epoch rule: the stabilisation window from k and f, N = E+1 before the cutoff and E+2 from it', () => {
  assert.equal(stabilityWindow(2160, '0.05', 4), 172800);
  assert.equal(stabilityWindow(2160, '0.05', 3), 129600);
  assert.equal(stabilityWindow(432, '0.05', 4), 34560);
  const genesis = { k: 2160, f: '0.05', epoch_length: 432000 };
  const first = 1000 * 432000;
  assert.equal(drawEpoch({ epochNo: 500, slotNo: first + 259199, epochSlotNo: 259199, protocolMajor: 10, genesis }).n, 501);
  assert.equal(drawEpoch({ epochNo: 500, slotNo: first + 259200, epochSlotNo: 259200, protocolMajor: 10, genesis }).n, 502);
  assert.equal(drawEpoch({ epochNo: 500, slotNo: first, epochSlotNo: 0, protocolMajor: 11, genesis }).cutoff, first + 259200);
  assert.throws(() => drawEpoch({ epochNo: 500, slotNo: first, epochSlotNo: 0, protocolMajor: 8, genesis }), /protocol_major 8/);
});

test('the draw key: the database nonce of epoch N, cross-checked with Koios; refused before N starts or on any difference', async () => {
  const { db } = await chain();
  const nonce = 'ab'.repeat(32);
  const block = { epoch_no: 320, slot_no: 136144536, epoch_slot_no: 410136 };
  await db.query(`INSERT INTO epoch_param VALUES (320, decode($1, 'hex'), 11)`, ['11'.repeat(32)]);
  const koios = (n, g = {}) => ({
    genesis: async () => ({ securityparam: '2160', activeslotcoeff: '0.05', epochlength: '432000', ...g }),
    epochNonce: async () => ({ nonce: n, read_at: 'now' })
  });
  await assert.rejects(drawKey({ client: db, blocks, network: 'preprod', block, koios: koios(nonce) }), /epoch 322 has not started/);
  await db.query(`INSERT INTO epoch_param VALUES (322, decode($1, 'hex'), 11)`, [nonce]);
  const dk = await drawKey({ client: db, blocks, network: 'preprod', block, koios: koios(nonce) });
  assert.equal(dk.n, 322);
  assert.equal(dk.nonce, nonce);
  await assert.rejects(drawKey({ client: db, blocks, network: 'preprod', block, koios: koios('cd'.repeat(32)) }), /differs between the database and Koios/);
  await assert.rejects(drawKey({ client: db, blocks, network: 'preprod', block, koios: koios(null) }), /no nonce/);
  await assert.rejects(drawKey({ client: db, blocks, network: 'preprod', block, koios: koios(nonce, { securityparam: '432' }) }), /genesis/);
  const dir = mkdtempSync(join(tmpdir(), 'rc-drawkey-'));
  try {
    const file = join(dir, 'drawkey.json');
    const doc = { format: 'research-freeze-drawkey-v1', network: 'preprod', tx_hash: 'cd'.repeat(32), nonce_epoch: 322, nonce, readings: [{ source: 'koios', at: 't1', nonce }, { source: 'blockfrost', at: 't2', nonce }] };
    writeFileSync(file, JSON.stringify(doc));
    const withFile = await drawKey({ client: db, blocks, network: 'preprod', block, koios: koios(nonce), txHash: 'cd'.repeat(32), drawkeyFile: file });
    assert.deepEqual(withFile.readings.freeze_tool.map((r) => r.source), ['koios', 'blockfrost']);
    writeFileSync(file, JSON.stringify({ ...doc, readings: [doc.readings[0], { ...doc.readings[1], nonce: 'ef'.repeat(32) }] }));
    await assert.rejects(drawKey({ client: db, blocks, network: 'preprod', block, koios: koios(nonce), txHash: 'cd'.repeat(32), drawkeyFile: file }), /drawkey\.json differs: blockfrost reading differs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the first carrier passes; copies after it do not matter; a copy before it is the first carrier', async () => {
  const later = await scenario({ copyAfter: true });
  try {
    assert.deepEqual(failed(await verifyFinalFreeze(later.args)), []);
  } finally {
    later.cleanup();
  }
  const s = await scenario({ copyBefore: 'body' });
  try {
    const v = await verifyFinalFreeze(s.args);
    assert.match(v.checks.find((c) => c.name === 'first_carrier_of_the_record').detail, new RegExp(s.copyTx));
    // The copy itself, with the same 674 line absent, is the first carrier of
    // the record but has no 674 line: refused on that.
    const v2 = await verifyFinalFreeze({ ...s.args, freezeTx: s.copyTx });
    assert.deepEqual(failed(v2), ['label_674_is_document_digest']);
  } finally {
    s.cleanup();
  }
});

test('run-time digests must be items, a prefix of the check log must be frozen, and live-fire follows the hypotheses', async () => {
  const lines = [JSON.stringify({ seq: 1, type: 'health', date: '2001-01-01T00:00:00Z' }), JSON.stringify({ seq: 2, type: 'live-fire-start', date: '2999-01-01T00:00:00Z' })];
  const frozenText = lines.join('\n') + '\n';
  const laterText = frozenText + JSON.stringify({ seq: 3, type: 'query-start', date: '2999-01-02T00:00:00Z' }) + '\n';
  const frozenDigest = logPrefixDigests(frozenText).at(-1);
  const extra = 'e1'.repeat(32);
  const s = await scenario({ items: (d, code) => [d, ...code.map((c) => c.sha256), extra, frozenDigest] });
  try {
    assert.deepEqual(failed(await verifyFinalFreeze({ ...s.args, requiredItems: [{ name: 'code_manifest', sha256: extra }], checkLogText: laterText })), []);
    assert.deepEqual(failed(await verifyFinalFreeze({ ...s.args, requiredItems: [{ name: 'consented_commitment', sha256: 'e2'.repeat(32) }] })), ['consented_commitment_is_an_item']);
    const other = JSON.stringify({ seq: 1, type: 'live-fire-start', date: '2001-01-01T00:00:00Z' }) + '\n';
    assert.deepEqual(failed(await verifyFinalFreeze({ ...s.args, checkLogText: other })), ['check_log_frozen', 'live_fire_after_hypotheses']);
  } finally {
    s.cleanup();
  }
});

test('the hypotheses URI is matched whole', async () => {
  const s = await scenario({ citeTx: null });
  try {
    const fake = s.args.preregPath;
    const { readFileSync, writeFileSync } = await import('node:fs');
    writeFileSync(fake, readFileSync(fake, 'utf8').replace('/metadata/309', '/metadata/3090'));
    const v = await verifyFinalFreeze(s.args);
    assert.ok(failed(v).includes('document_cites_hypotheses_record'));
  } finally {
    s.cleanup();
  }
});

test("the freeze tool's drawkey.json must agree on the transaction, the epoch and both readings", () => {
  const nonce = 'ab'.repeat(32);
  const doc = { format: 'research-freeze-drawkey-v1', network: 'mainnet', tx_hash: 'cd'.repeat(32), nonce_epoch: 600, nonce, readings: [{ source: 'koios', nonce }, { source: 'blockfrost', nonce }] };
  const want = { network: 'mainnet', txHash: 'cd'.repeat(32), n: 600, nonce };
  assert.deepEqual(drawkeyFileErrors(doc, want), []);
  assert.deepEqual(drawkeyFileErrors({ ...doc, nonce_epoch: 601 }, want), ['epoch 601']);
  assert.deepEqual(drawkeyFileErrors({ ...doc, readings: [{ source: 'koios', nonce }, { source: 'blockfrost', nonce: 'ef'.repeat(32) }] }, want), ['blockfrost reading differs']);
  assert.deepEqual(drawkeyFileErrors({ ...doc, readings: [{ source: 'koios', nonce }] }, want), ['no blockfrost reading']);
  assert.deepEqual(drawkeyFileErrors({ ...doc, tx_hash: 'ee'.repeat(32) }, want), [`transaction ${'ee'.repeat(32)}`]);
  assert.deepEqual(drawkeyFileErrors({ format: 'other' }, want), ['not a research-freeze drawkey.json']);
});
