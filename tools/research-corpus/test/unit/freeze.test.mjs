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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAll } from '../../src/sqlfile.mjs';
import { verifyFinalFreeze, drawKey, drawEpoch, stabilityWindow, reassemble, parseRecord, verifySignatures, logPrefixDigests, drawkeyFileErrors, ruleSnapshot } from '../../src/freeze.mjs';
import { decode } from '../../src/cbor.mjs';
import { sha, keypair, record, metadataBytes, chain } from '../lib/records.mjs';

const blocks = loadAll();

async function scenario(over = {}) {
  const key = keypair();
  const dir = mkdtempSync(join(tmpdir(), 'rc-freeze-'));
  const hypDoc = Buffer.from(`hypotheses text\nkey ${key.pub.toString('hex')}\n`);
  const hypDigest = sha(hypDoc);
  const code = [{ path: 'src/a.mjs', sha256: sha('a') }, { path: 'sql/b.sql', sha256: sha('b') }];
  const { db, add } = await chain();
  const hypTx = await add({ blockNo: 1000, slot: 50000, epoch: 10, epochSlot: 1000, body: metadataBytes(over.hypBody ? over.hypBody(key, hypDigest) : record([hypDigest], key)), msg: hypDigest });
  const finalDoc = Buffer.from(`final text\nkey ${key.pub.toString('hex')}\nhypotheses web+cardano://transaction/${over.citeTx || hypTx}/metadata/309\n${over.docExtra || ''}`);
  const finalDigest = sha(finalDoc);
  const items = over.items ? over.items(finalDigest, code) : [finalDigest, ...code.map((c) => c.sha256)];
  const signer = over.signer ? over.signer(key) : key;
  const body = over.body ? over.body(items, signer) : record(items, signer);
  // A copy of the record (or of the 674 line) in a transaction before the
  // final freeze: the record's body republished, as CIP-190 allows anyone to.
  let copyTx = null;
  if (over.copyBefore === 'body') copyTx = await add({ blockNo: 1500, slot: 75000, epoch: 11, epochSlot: 1000, body: metadataBytes(body, 50) });
  if (over.copyBefore === 'full') copyTx = await add({ blockNo: 1500, slot: 75000, epoch: 11, epochSlot: 1000, body: metadataBytes(body, 50), msg: finalDigest });
  if (over.copyBefore === 'msg') copyTx = await add({ blockNo: 1500, slot: 75000, epoch: 11, epochSlot: 1000, msg: ['see', finalDigest] });
  // A second final record by the key holder, for a byte-different document.
  if (over.secondFinal) {
    const otherDigest = sha(Buffer.concat([finalDoc, Buffer.from('\n')]));
    copyTx = await add({ blockNo: 1500, slot: 75000, epoch: 11, epochSlot: 1000, body: metadataBytes(record([otherDigest, ...code.map((c) => c.sha256)], key)), msg: otherDigest });
  }
  // A replay of the hypotheses record, a retype of it, and copies of both
  // records with a stranger's co-signature added, between the two.
  if (over.hypCopies) {
    await add({ blockNo: 1200, slot: 60000, epoch: 10, epochSlot: 9000, body: metadataBytes(record([hypDigest], key)) });
    await add({ blockNo: 1300, slot: 65000, epoch: 10, epochSlot: 9500, body: metadataBytes(record([hypDigest], key, { supersedes: hypTx })) });
    await add({ blockNo: 1350, slot: 66000, epoch: 10, epochSlot: 9600, body: metadataBytes(record([hypDigest], key, { cosigners: [keypair()] })) });
    await add({ blockNo: 1400, slot: 70000, epoch: 10, epochSlot: 9700, body: metadataBytes(record(items, signer, { cosigners: [keypair()] })) });
  }
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
    assert.ok(failed(v2).includes('document_cites_one_study_record'));
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
    [{ citeTx: 'cd'.repeat(32) }, 'document_cites_one_study_record'],
    [{ body: (items, key) => record(items, key, { supersedes: 'ef'.repeat(32) }) }, 'record_has_no_supersedes'],
    [{ copyBefore: 'full' }, 'first_carrier_of_the_record'],
    [{ secondFinal: true }, 'no_other_study_record']
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
  await db.query(`INSERT INTO public.epoch_param VALUES (320, decode($1, 'hex'), 11)`, ['11'.repeat(32)]);
  const koios = (n, g = {}) => ({
    genesis: async () => ({ securityparam: '2160', activeslotcoeff: '0.05', epochlength: '432000', ...g }),
    epochNonce: async () => ({ nonce: n, read_at: 'now' })
  });
  await assert.rejects(drawKey({ client: db, blocks, network: 'preprod', block, koios: koios(nonce) }), /epoch 322 has not started/);
  await db.query(`INSERT INTO public.epoch_param VALUES (322, decode($1, 'hex'), 11)`, [nonce]);
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

test('only records signed by the study key count: bare copies, replays, retypes and strangers\' 674 lines neither block the final nor stand in for it', async () => {
  for (const over of [{ copyAfter: true }, { copyBefore: 'body' }, { copyBefore: 'msg' }, { hypCopies: true }]) {
    const s = await scenario(over);
    try {
      assert.deepEqual(failed(await verifyFinalFreeze(s.args)), [], JSON.stringify(over));
    } finally {
      s.cleanup();
    }
  }
  // A complete copy (body and 674 line) before the final is the first carrier:
  // it passes, and the later transaction is refused.
  const s = await scenario({ copyBefore: 'full' });
  try {
    const v = await verifyFinalFreeze(s.args);
    assert.match(v.checks.find((c) => c.name === 'first_carrier_of_the_record').detail, new RegExp(s.copyTx));
    assert.deepEqual(failed(await verifyFinalFreeze({ ...s.args, freezeTx: s.copyTx })), []);
  } finally {
    s.cleanup();
  }
  // A second final for a byte-different document refuses the later one, and
  // the earlier one too: either could key the draw.
  const t = await scenario({ secondFinal: true });
  try {
    assert.match(failed(await verifyFinalFreeze(t.args)).join(), /no_other_study_record/);
  } finally {
    t.cleanup();
  }
});

test('the document cites exactly one record signed by the study key', async () => {
  const s = await scenario({ hypCopies: true });
  try {
    // Cite the hypotheses record and its replay: two study-signed records.
    const { readFileSync } = await import('node:fs');
    const rows = (await s.db.query(`SELECT encode(t.hash, 'hex') AS h FROM public.tx t JOIN public.block b ON b.id = t.block_id WHERE b.block_no = 1200`)).rows;
    writeFileSync(s.args.preregPath, readFileSync(s.args.preregPath, 'utf8') + `also web+cardano://transaction/${rows[0].h}/metadata/309\n`);
    assert.ok(failed(await verifyFinalFreeze(s.args)).includes('document_cites_one_study_record'));
  } finally {
    s.cleanup();
  }
});

test('run-time digests must be items named in the document; one frozen prefix of the check log, nothing earlier after it; live-fire follows the hypotheses', async () => {
  const lines = [JSON.stringify({ seq: 1, type: 'health', date: '2001-01-01T00:00:00Z' }), JSON.stringify({ seq: 2, type: 'live-fire-start', date: '2999-01-01T00:00:00Z' })];
  const frozenText = lines.join('\n') + '\n';
  const laterText = frozenText + JSON.stringify({ seq: 3, type: 'query-start', date: '2999-01-02T00:00:00Z' }) + '\n';
  const earlyTail = frozenText + JSON.stringify({ seq: 3, type: 'live-fire-start', date: '2001-02-01T00:00:00Z' }) + '\n';
  const frozenDigest = logPrefixDigests(frozenText).at(-1);
  const extra = 'e1'.repeat(32);
  const docExtra = `${extra}  code-manifest.txt\n${frozenDigest}  check-log.jsonl\n`;
  const s = await scenario({ docExtra, items: (d, code) => [d, ...code.map((c) => c.sha256), extra, frozenDigest] });
  try {
    assert.deepEqual(failed(await verifyFinalFreeze({ ...s.args, requiredItems: [{ name: 'code_manifest', sha256: extra }], checkLogText: laterText })), []);
    assert.deepEqual(failed(await verifyFinalFreeze({ ...s.args, requiredItems: [{ name: 'code_manifest', sha256: 'e2'.repeat(32) }] })), ['code_manifest_is_an_item', 'code_manifest_named_in_document']);
    assert.deepEqual(failed(await verifyFinalFreeze({ ...s.args, checkLogText: earlyTail })), ['check_log_tail_after_freeze']);
    const other = JSON.stringify({ seq: 1, type: 'live-fire-start', date: '2001-01-01T00:00:00Z' }) + '\n';
    assert.deepEqual(failed(await verifyFinalFreeze({ ...s.args, checkLogText: other })), ['check_log_frozen', 'check_log_tail_after_freeze', 'live_fire_after_hypotheses']);
  } finally {
    s.cleanup();
  }
  // An item the document does not name.
  const u = await scenario({ items: (d, code) => [d, ...code.map((c) => c.sha256), extra] });
  try {
    assert.deepEqual(failed(await verifyFinalFreeze({ ...u.args, requiredItems: [{ name: 'code_manifest', sha256: extra }] })), ['code_manifest_named_in_document']);
  } finally {
    u.cleanup();
  }
});

test('the snapshot by rule: the last block of epoch N - 1, deep enough in the database and in Koios', async () => {
  const { db, block } = await chain();
  await block({ blockNo: 100, slot: 1000, epoch: 9, epochSlot: 10 });
  const last = await block({ blockNo: 200, slot: 2000, epoch: 9, epochSlot: 900 });
  await block({ blockNo: 201, slot: 2100, epoch: 10, epochSlot: 0 });
  const koios = (hash, tip) => ({ lastBlockOfEpoch: async () => ({ hash, block_height: 200 }), tip: async () => ({ block_no: tip }) });
  const rs = await ruleSnapshot({ client: db, blocks, n: 10, koios: koios(last.hash, 3000), tipBlockNo: 2500 });
  assert.equal(rs.block.hash, last.hash);
  assert.equal(rs.confirmation.db_depth, 2300);
  await assert.rejects(ruleSnapshot({ client: db, blocks, n: 10, koios: koios(last.hash, 3000), tipBlockNo: 2000 }), /2160 deep/);
  await assert.rejects(ruleSnapshot({ client: db, blocks, n: 10, koios: koios('00'.repeat(32), 3000), tipBlockNo: 2500 }), /Koios names another/);
  await assert.rejects(ruleSnapshot({ client: db, blocks, n: 10, koios: koios(last.hash, 2300), tipBlockNo: 2500 }), /Koios's tip/);
  await assert.rejects(ruleSnapshot({ client: db, blocks, n: 11, koios: koios(last.hash, 3000), tipBlockNo: 2500 }), /does not yet hold epoch 11/);
});

test('the hypotheses URI is matched whole', async () => {
  const s = await scenario({ citeTx: null });
  try {
    const fake = s.args.preregPath;
    const { readFileSync, writeFileSync } = await import('node:fs');
    writeFileSync(fake, readFileSync(fake, 'utf8').replace('/metadata/309', '/metadata/3090'));
    const v = await verifyFinalFreeze(s.args);
    assert.ok(failed(v).includes('document_cites_one_study_record'));
  } finally {
    s.cleanup();
  }
});

test("the freeze tool's drawkey.json must agree on the network, the epoch and both readings", () => {
  const nonce = 'ab'.repeat(32);
  const doc = { format: 'research-freeze-drawkey-v1', network: 'mainnet', tx_hash: 'cd'.repeat(32), nonce_epoch: 600, nonce, readings: [{ source: 'koios', nonce }, { source: 'blockfrost', nonce }] };
  const want = { network: 'mainnet', txHash: 'cd'.repeat(32), n: 600, nonce };
  assert.deepEqual(drawkeyFileErrors(doc, want), []);
  assert.deepEqual(drawkeyFileErrors({ ...doc, nonce_epoch: 601 }, want), ['epoch 601']);
  assert.deepEqual(drawkeyFileErrors({ ...doc, readings: [{ source: 'koios', nonce }, { source: 'blockfrost', nonce: 'ef'.repeat(32) }] }, want), ['blockfrost reading differs']);
  assert.deepEqual(drawkeyFileErrors({ ...doc, readings: [{ source: 'koios', nonce }] }, want), ['no blockfrost reading']);
  // Written for another carrier of the same record: same epoch and nonce.
  assert.deepEqual(drawkeyFileErrors({ ...doc, tx_hash: 'ee'.repeat(32) }, want), []);
  assert.deepEqual(drawkeyFileErrors({ format: 'other' }, want), ['not a research-freeze drawkey.json']);
});
