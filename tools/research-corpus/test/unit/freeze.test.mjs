// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The final-freeze checks and the draw key, on synthetic records signed here
// with a fresh Ed25519 key and stored as db-sync stores them (the label-309
// chunk array inside a single-label metadata map). The records follow
// CIP-190 (CIPs@58b4dd1417, CIP-0190: "Record model", "Canonical CBOR",
// "Metadata label 309 and the chunk-array transport", "Signed payload and
// Sig_structure", "Signer-key identification", path 1). The order of the
// records is the chain's: the study key's first record is the hypotheses
// record, the first later one with other signed content is the final.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAll } from '../../src/sqlfile.mjs';
import { verifyFinalFreeze, drawKey, drawEpoch, stabilityWindow, reassemble, parseRecord, verifySignatures, logPrefixDigests, drawkeyFileErrors, ruleSnapshot, hashTable } from '../../src/freeze.mjs';
import { decode } from '../../src/cbor.mjs';
import { studyKeyFor } from '../../src/guards.mjs';
import { snapshotRuleHolds } from '../../src/cli.mjs';
import { STUDY_KEY } from '../../src/params.mjs';
import { sha, keypair, record, metadataBytes, chain } from '../lib/records.mjs';

const blocks = loadAll();
const code = [{ path: 'src/a.mjs', sha256: sha('a') }, { path: 'sql/b.sql', sha256: sha('b') }];
const MANIFEST = sha('the code manifest');
const LOG = sha('');

// The other items a final document lists, as the freeze tool writes them.
const listing = ({ manifest = MANIFEST, log = LOG } = {}) => [...code.map((c) => ({ sha256: c.sha256, name: c.path.split('/').pop() })), { sha256: manifest, name: 'code-manifest.txt' }, { sha256: log, name: 'check-log.jsonl' }];
const docText = (key, cite, listed, extra = '') => `final text\nkey ${key.pub.toString('hex')}\nhypotheses web+cardano://transaction/${cite}/metadata/309\n\n${listed.map((l) => `${l.sha256}  ${l.name}`).join('\n')}\n${extra}`;

// H at block 1000 (epoch 10), F at block 2000 (epoch 11, early: N = 12).
// over: before(ctx) adds records before H (its result is ctx.before);
// between(ctx) between H and F; listed(default) the document's list;
// items(docDigest, listed) the record's items; body(items, key), signer(key),
// msg, chunk, citeTx (a hash, or a function of ctx), copyAfter, tip, extra
// (document text after the list).
async function scenario(over = {}) {
  const key = keypair();
  const dir = mkdtempSync(join(tmpdir(), 'rc-freeze-'));
  const { db, add } = await chain();
  const hypDoc = Buffer.from(`hypotheses text\nkey ${key.pub.toString('hex')}\n`);
  const hypDigest = sha(hypDoc);
  const ctx = { key, add, hypDigest };
  if (over.before) ctx.before = await over.before(ctx);
  const hypTx = await add({ blockNo: 1000, slot: 50000, epoch: 10, epochSlot: 1000, body: metadataBytes(over.hypBody ? over.hypBody(key, hypDigest) : record([hypDigest], key)), msg: hypDigest });
  ctx.hypTx = hypTx;
  const listed = over.listed ? over.listed(listing()) : listing();
  const cite = typeof over.citeTx === 'function' ? over.citeTx(ctx) : over.citeTx;
  const text = docText(key, cite || hypTx, listed, over.extra || '');
  const finalDigest = sha(Buffer.from(text));
  const items = over.items ? over.items(finalDigest, listed) : [finalDigest, ...listed.map((l) => l.sha256)];
  const signer = over.signer ? over.signer(key) : key;
  const body = over.body ? over.body(items, signer) : record(items, signer);
  Object.assign(ctx, { finalDigest, items, body, listed });
  if (over.between) ctx.between = await over.between(ctx);
  const freezeTx = await add({ blockNo: 2000, slot: 4800000, epoch: 11, epochSlot: 5000, body: metadataBytes(body, over.chunk || 64), msg: over.msg || finalDigest });
  if (over.copyAfter) await add({ blockNo: 2500, slot: 4820000, epoch: 11, epochSlot: 25000, body: metadataBytes(body), msg: finalDigest });
  writeFileSync(join(dir, 'final.md'), text);
  writeFileSync(join(dir, 'hyp.md'), hypDoc);
  const args = { client: db, blocks, freezeTx, hypothesesTx: hypTx, preregPath: join(dir, 'final.md'), studyKey: key.pub.toString('hex'), codeDigests: code, tipBlockNo: over.tip || 5000 };
  return { db, dir, key, hypTx, freezeTx, ctx, finalDigest, items, args, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const failed = (v) => v.checks.filter((c) => !c.ok).map((c) => c.name);
const detail = (v, name) => v.checks.find((c) => c.name === name).detail;

test('a final freeze record passes every check, with the transactions named or found on chain', async () => {
  const s = await scenario();
  try {
    const v = await verifyFinalFreeze(s.args);
    assert.deepEqual(failed(v), []);
    assert.equal(v.freeze.tx, s.freezeTx);
    assert.equal(v.hypotheses.tx, s.hypTx);
    assert.deepEqual([v.hypotheses.cited_tx, v.hypotheses.document_sha256, v.hypotheses.items_sha256], [s.hypTx, s.ctx.hypDigest, [s.ctx.hypDigest]]);
    const found = await verifyFinalFreeze({ ...s.args, freezeTx: null, hypothesesTx: null });
    assert.deepEqual(failed(found), []);
    assert.equal(found.freeze.tx, s.freezeTx);
    assert.deepEqual(hashTable(readFileSync(s.args.preregPath, 'utf8')).map((t) => t.name), ['a.mjs', 'b.sql', 'code-manifest.txt', 'check-log.jsonl']);
  } finally {
    s.cleanup();
  }
});

test('the hypotheses record is refused as the final one, with either document', async () => {
  const s = await scenario();
  try {
    const v1 = await verifyFinalFreeze({ ...s.args, freezeTx: s.hypTx });
    assert.ok(failed(v1).includes('freeze_tx_is_the_chains'));
    const v2 = await verifyFinalFreeze({ ...s.args, freezeTx: s.hypTx, preregPath: join(s.dir, 'hyp.md') });
    for (const n of ['final_tx_carries_the_document', 'freeze_tx_is_the_chains', 'document_cites_hypotheses_record', 'hypotheses_document_differs']) assert.ok(failed(v2).includes(n), n);
  } finally {
    s.cleanup();
  }
});

test('refusals: another signer, a body changed after signing, a non-canonical record, an oversized chunk, a superseding record, missing code, a shallow block, another 674 line or citation, the list of items', async () => {
  const cases = [
    [{ signer: () => keypair() }, 'final_record_on_chain'],
    [{ body: (items, key) => record(items, key, { tamper: true }) }, 'final_record_on_chain'],
    [{ body: (items, key) => record(items, key, { unsorted: true }) }, 'final_record_on_chain'],
    [{ chunk: 65 }, 'final_record_on_chain'],
    [{ body: (items, key) => record(items, key, { supersedes: 'ef'.repeat(32) }) }, 'final_record_on_chain'],
    [{ items: (d, listed) => [d, ...listed.filter((l) => l.name !== 'b.sql').map((l) => l.sha256)] }, 'code_files_are_items'],
    [{ items: (d, listed) => [d, ...listed.filter((l) => l.name !== 'b.sql').map((l) => l.sha256)] }, 'document_lists_every_other_item'],
    [{ tip: 2100 }, 'freeze_block_depth'],
    [{ msg: 'ab'.repeat(32) }, 'final_tx_carries_the_document'],
    [{ citeTx: 'cd'.repeat(32) }, 'document_cites_hypotheses_record'],
    // An item the document does not list, and a listed line that is no item.
    [{ items: (d, listed) => [d, ...listed.map((l) => l.sha256), sha('unlisted')] }, 'document_lists_every_other_item'],
    [{ listed: (l) => [...l, { sha256: sha('not an item'), name: 'extra.txt' }], items: (d, listed) => [d, ...listed.filter((x) => x.name !== 'extra.txt').map((x) => x.sha256)] }, 'document_lists_every_other_item'],
    // An item listed twice, though the record carries it once.
    [{ listed: (l) => [...l, l[0]], items: (d, listed) => [d, ...new Set(listed.map((x) => x.sha256))] }, 'document_lists_every_other_item'],
    // Two code manifests, or none; no check-log prefix.
    [{ listed: (l) => [...l, { sha256: sha('another manifest'), name: 'code-manifest.txt' }] }, 'document_names_one_code_manifest'],
    [{ listed: (l) => l.filter((x) => x.name !== 'code-manifest.txt') }, 'document_names_one_code_manifest'],
    [{ listed: (l) => l.filter((x) => x.name !== 'check-log.jsonl') }, 'document_names_one_check_log']
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

test('copies neither block the final nor stand in for it: replays, retypes, co-signed copies, copies without the 674 line, strangers\' 674 lines', async () => {
  const betweens = [
    // The final record's body without its 674 line, and a stranger's line
    // naming the document's digest.
    async (c) => c.add({ blockNo: 1500, slot: 4790000, epoch: 11, epochSlot: 1000, body: metadataBytes(c.body, 50) }),
    async (c) => c.add({ blockNo: 1500, slot: 4790000, epoch: 11, epochSlot: 1000, msg: ['see', c.finalDigest] }),
    // Carriers of the final record whose 674 line holds the digest among other
    // lines: not exactly the document's digest, so not the final freeze.
    async (c) => c.add({ blockNo: 1500, slot: 4790000, epoch: 11, epochSlot: 1000, body: metadataBytes(c.body, 50), msg: [c.finalDigest, 'x'] }),
    async (c) => c.add({ blockNo: 1500, slot: 4790000, epoch: 11, epochSlot: 1000, body: metadataBytes(c.body, 50), msg: ['x', c.finalDigest] }),
    // A replay of the hypotheses record, a retype of it, both records
    // co-signed by a stranger (the final's without its 674 line).
    async (c) => {
      await c.add({ blockNo: 1200, slot: 60000, epoch: 10, epochSlot: 9000, body: metadataBytes(record([c.hypDigest], c.key)) });
      await c.add({ blockNo: 1300, slot: 65000, epoch: 10, epochSlot: 9500, body: metadataBytes(record([c.hypDigest], c.key, { supersedes: c.hypTx })) });
      await c.add({ blockNo: 1350, slot: 66000, epoch: 10, epochSlot: 9600, body: metadataBytes(record([c.hypDigest], c.key, { cosigners: [keypair()] })) });
      await c.add({ blockNo: 1400, slot: 70000, epoch: 10, epochSlot: 9700, body: metadataBytes(record(c.items, c.key, { cosigners: [keypair()] })) });
    }
  ];
  for (const between of betweens) {
    const s = await scenario({ between });
    try {
      assert.deepEqual(failed(await verifyFinalFreeze(s.args)), []);
    } finally {
      s.cleanup();
    }
  }
  const later = await scenario({ copyAfter: true });
  try {
    assert.deepEqual(failed(await verifyFinalFreeze(later.args)), []);
  } finally {
    later.cleanup();
  }
  // A complete copy (the signed content with exactly the document's 674
  // line) that lands first is the final freeze, and the later one is refused,
  // naming it.
  const s = await scenario({ between: async (c) => c.add({ blockNo: 1500, slot: 4790000, epoch: 11, epochSlot: 1000, body: metadataBytes(c.body, 50), msg: c.finalDigest }) });
  try {
    const v = await verifyFinalFreeze(s.args);
    assert.deepEqual(failed(v), ['freeze_tx_is_the_chains']);
    assert.match(detail(v, 'freeze_tx_is_the_chains'), new RegExp(s.ctx.between));
    assert.deepEqual(failed(await verifyFinalFreeze({ ...s.args, freezeTx: s.ctx.between })), []);
  } finally {
    s.cleanup();
  }
});

test('a bare copy of the hypotheses record landing first blocks no final: the document may cite any carrier of its signed content', async () => {
  // A stranger's copy of H's body, without H's 674 line, one block ahead of
  // the key holder's H: the copy is the hypotheses record's first carrier.
  const before = async (c) => c.add({ blockNo: 999, slot: 49000, epoch: 10, epochSlot: 900, body: metadataBytes(record([c.hypDigest], c.key), 40) });
  for (const cite of ['the copy', "the key holder's own"]) {
    const s = await scenario({ before, citeTx: cite === 'the copy' ? (c) => c.before : undefined });
    try {
      const v = await verifyFinalFreeze({ ...s.args, hypothesesTx: null });
      assert.deepEqual(failed(v), [], `the document cites ${cite}`);
      assert.equal(v.hypotheses.tx, s.ctx.before);
      assert.equal(v.freeze.tx, s.freezeTx);
      // --hypotheses-tx must name the chain's first carrier.
      assert.deepEqual(failed(await verifyFinalFreeze(s.args)), ['hypotheses_tx_is_the_chains']);
      assert.deepEqual(failed(await verifyFinalFreeze({ ...s.args, hypothesesTx: s.ctx.before })), []);
    } finally {
      s.cleanup();
    }
  }
});

// Copies of the hypotheses record landing ahead of the key holder's, with a
// stranger's 674 line, a stranger's valid co-signature, or both: each is the
// first carrier and blocks no final, whichever carrier the document cites.
// The record is reported from its signed content: its items, the carrier the
// document cites, and as its document the item that carrier's 674 line names,
// so the stranger's line is never published as the document's digest.
test("front-run copies with a stranger's 674 line or co-signature block no final, and the hypotheses record is reported from its signed content", async () => {
  const stranger = keypair();
  const forged = sha('a document a stranger names');
  const copies = {
    "a stranger's 674 line": (c) => ({ body: metadataBytes(record([c.hypDigest], c.key), 40), msg: forged }),
    "a stranger's co-signature": (c) => ({ body: metadataBytes(record([c.hypDigest], c.key, { cosigners: [stranger] })) }),
    'both': (c) => ({ body: metadataBytes(record([c.hypDigest], c.key, { cosigners: [stranger] })), msg: forged })
  };
  for (const [what, copy] of Object.entries(copies)) {
    for (const citesCopy of [false, true]) {
      const s = await scenario({ before: (c) => c.add({ blockNo: 999, slot: 49000, epoch: 10, epochSlot: 900, ...copy(c) }), citeTx: citesCopy ? (c) => c.before : undefined });
      const label = `${what}, the document citing ${citesCopy ? 'the copy' : "the key holder's own"}`;
      try {
        const v = await verifyFinalFreeze({ ...s.args, hypothesesTx: null });
        assert.deepEqual(failed(v), [], label);
        assert.equal(v.freeze.tx, s.freezeTx, label);
        assert.equal(v.freezeBlock.block_no, 2000, label);
        assert.equal(v.hypotheses.tx, s.ctx.before, `${label}: the copy is the first carrier`);
        assert.deepEqual(v.hypotheses.items_sha256, [s.ctx.hypDigest], label);
        assert.equal(v.hypotheses.cited_tx, citesCopy ? s.ctx.before : s.hypTx, label);
        // The key holder's line names the document; a copy's line, the
        // stranger's digest, is no item of the record and is not published.
        assert.equal(v.hypotheses.document_sha256, citesCopy ? null : s.ctx.hypDigest, label);
        assert.notEqual(v.hypotheses.document_sha256, forged, label);
      } finally {
        s.cleanup();
      }
    }
  }
});

// The document cites a carrier of the hypotheses record's signed content that
// lands after the final freeze: later in the same epoch, after the draw key is
// fixed (epoch 12's nonce is fixed at epoch 11's cutoff), or never. None of
// them makes the final freeze pass, and the draw block stays the final's.
test('a carrier of the hypotheses record landing after the final freeze never makes it pass, even after the draw key is fixed', async () => {
  for (const [when, at] of [
    ['later in epoch 11', { blockNo: 2500, slot: 4820000, epoch: 11, epochSlot: 25000 }],
    ['in epoch 12, after the draw key is fixed', { blockNo: 4000, slot: 5184100, epoch: 12, epochSlot: 100 }],
    ['never', null]
  ]) {
    // H is the chain's transaction 1 and F its transaction 2, so the carrier
    // the document names in advance is transaction 3.
    const s = await scenario({ citeTx: sha('tx 3') });
    try {
      if (at) assert.equal(await s.ctx.add({ ...at, body: metadataBytes(record([s.ctx.hypDigest], s.key), 40) }), sha('tx 3'));
      const v = await verifyFinalFreeze(s.args);
      assert.deepEqual(failed(v), ['document_cites_hypotheses_record'], when);
      assert.equal(v.freeze.tx, s.freezeTx, when);
      assert.equal(v.freezeBlock.block_no, 2000, when);
      assert.equal(v.hypotheses.cited_tx, null, when);
      assert.equal((await verifyFinalFreeze({ ...s.args, freezeTx: null, hypothesesTx: null })).ok, false, when);
    } finally {
      s.cleanup();
    }
  }
});

test('records in the same block are ordered by transaction', async () => {
  const at = (blockNo, epoch, epochSlot) => ({ blockNo, slot: epoch * 432000 + epochSlot, epoch, epochSlot });
  const run = async (build) => {
    const key = keypair();
    const dir = mkdtempSync(join(tmpdir(), 'rc-block-'));
    const { db, add, block, tx } = await chain();
    const hypDigest = sha('hypotheses, in a shared block');
    const hBody = metadataBytes(record([hypDigest], key));
    // The final document citing tx, and its record body.
    const final = (cite) => {
      const text = docText(key, cite, listing());
      writeFileSync(join(dir, 'final.md'), text);
      const d = sha(Buffer.from(text));
      return { d, raw: record([d, ...listing().map((l) => l.sha256)], key) };
    };
    try {
      const r = await build({ key, add, block, tx, hBody, hypDigest, final });
      const v = await verifyFinalFreeze({ client: db, blocks, preregPath: join(dir, 'final.md'), studyKey: key.pub.toString('hex'), codeDigests: code, tipBlockNo: 9000 });
      return { v, ...r };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  // H and F in one block, H first: F is the chain's final freeze, but not in a
  // later block than the hypotheses record.
  let r = await run(async (c) => {
    const b = await c.block(at(1000, 10, 1000));
    const h = await c.tx(b, { body: c.hBody, msg: c.hypDigest });
    const f = c.final(h);
    return { F: await c.tx(b, { body: metadataBytes(f.raw), msg: f.d }) };
  });
  assert.deepEqual(failed(r.v), ['hypotheses_block_earlier']);
  assert.equal(r.v.freeze.tx, r.F);
  // A bare copy of H ahead of the key holder's H in its block: the copy is the
  // first carrier, and the document citing the key holder's H passes.
  r = await run(async (c) => {
    const b = await c.block(at(1000, 10, 1000));
    const copy = await c.tx(b, { body: metadataBytes(record([c.hypDigest], c.key), 40) });
    const h = await c.tx(b, { body: c.hBody, msg: c.hypDigest });
    const f = c.final(h);
    await c.add({ ...at(2000, 11, 5000), body: metadataBytes(f.raw), msg: f.d });
    return { copy };
  });
  assert.deepEqual(failed(r.v), []);
  assert.equal(r.v.hypotheses.tx, r.copy);
  // A carrier of H in F's block, cited by the document: ahead of F it
  // precedes the final freeze and counts; after F it does not.
  for (const ahead of [true, false]) {
    r = await run(async (c) => {
      await c.add({ ...at(1000, 10, 1000), body: c.hBody, msg: c.hypDigest });
      // H is transaction 1; the copy and F are transactions 2 and 3.
      const copyTx = sha(ahead ? 'tx 2' : 'tx 3');
      const f = c.final(copyTx);
      const b = await c.block(at(2000, 11, 5000));
      const copy = { body: metadataBytes(record([c.hypDigest], c.key), 40) };
      const freeze = { body: metadataBytes(f.raw), msg: f.d };
      for (const t of ahead ? [copy, freeze] : [freeze, copy]) await c.tx(b, t);
      return { copyTx };
    });
    assert.deepEqual(failed(r.v), ahead ? [] : ['document_cites_hypotheses_record'], ahead ? 'the cited carrier ahead of F' : 'the cited carrier after F');
    assert.equal(r.v.hypotheses.cited_tx, ahead ? r.copyTx : null);
  }
  // A complete copy of F in F's block: ahead of F it is the final freeze,
  // after F it is not.
  for (const ahead of [true, false]) {
    r = await run(async (c) => {
      const h = await c.add({ ...at(1000, 10, 1000), body: c.hBody, msg: c.hypDigest });
      const f = c.final(h);
      const b = await c.block(at(2000, 11, 5000));
      const carriers = [{ body: metadataBytes(f.raw, 40), msg: f.d }, { body: metadataBytes(f.raw), msg: f.d }];
      if (!ahead) carriers.reverse();
      const first = await c.tx(b, carriers[0]);
      const second = await c.tx(b, carriers[1]);
      return { first, second };
    });
    assert.deepEqual(failed(r.v), [], ahead ? 'the copy ahead' : 'the copy after');
    assert.equal(r.v.freeze.tx, r.first, 'the first carrier in the block is the final freeze');
  }
});

test('the chain decides the order: a second final, a second hypotheses record, a replayed one, a stray record of the key', async () => {
  // The key holder's other final before this one: it is the chain's final.
  const other = await scenario({
    between: async (c) => {
      const d = sha('another document');
      return c.add({ blockNo: 1500, slot: 4790000, epoch: 11, epochSlot: 1000, body: metadataBytes(record([d, ...c.items.slice(1)], c.key)), msg: d });
    }
  });
  try {
    const v = await verifyFinalFreeze(other.args);
    assert.ok(failed(v).includes('final_tx_carries_the_document') && failed(v).includes('freeze_tx_is_the_chains'), failed(v).join());
  } finally {
    other.cleanup();
  }
  // A body the key signed (a draft, a record never landed) republished
  // between H and F, with no 674 line: it is the chain's final record, and
  // nothing passes.
  const stray = await scenario({ between: async (c) => c.add({ blockNo: 1500, slot: 4790000, epoch: 11, epochSlot: 1000, body: metadataBytes(record([sha('a draft the key signed')], c.key)) }) });
  try {
    assert.ok(failed(await verifyFinalFreeze(stray.args)).includes('final_tx_carries_the_document'));
    assert.equal((await verifyFinalFreeze({ ...stray.args, freezeTx: null })).ok, false);
  } finally {
    stray.cleanup();
  }
  // A hypotheses body the key signed, broadcast and abandoned before the
  // hypotheses record, replayed by anyone ahead of it: it is the chain's
  // hypotheses record, the key holder's hypotheses record is the chain's final
  // record, and nothing passes.
  const abandoned = await scenario({ before: async (c) => c.add({ blockNo: 999, slot: 49000, epoch: 10, epochSlot: 900, body: metadataBytes(record([sha('an abandoned first hypotheses body')], c.key)) }) });
  try {
    const v = await verifyFinalFreeze({ ...abandoned.args, hypothesesTx: null });
    for (const n of ['final_tx_carries_the_document', 'freeze_tx_is_the_chains', 'document_cites_hypotheses_record']) assert.ok(failed(v).includes(n), n);
    assert.equal(v.hypotheses.tx, abandoned.ctx.before);
    assert.equal((await verifyFinalFreeze({ ...abandoned.args, freezeTx: null, hypothesesTx: null })).ok, false);
  } finally {
    abandoned.cleanup();
  }
  // After a passing final F1 (citing Ha), a second hypotheses record Hb, or a
  // replay of Ha, and a final F2 citing it: F2 is never the chain's final.
  for (const replay of [false, true]) {
    const s = await scenario();
    try {
      const hb = replay ? metadataBytes(record([s.ctx.hypDigest], s.key)) : metadataBytes(record([sha('hypotheses, again')], s.key));
      const Hb = await s.ctx.add({ blockNo: 3000, slot: 4900000, epoch: 11, epochSlot: 105000, body: hb, msg: replay ? s.ctx.hypDigest : sha('hypotheses, again') });
      const text2 = docText(s.key, Hb, listing());
      const d2 = sha(Buffer.from(text2));
      const F2 = await s.ctx.add({ blockNo: 4000, slot: 5300000, epoch: 12, epochSlot: 300000, body: metadataBytes(record([d2, ...listing().map((l) => l.sha256)], s.key)), msg: d2 });
      writeFileSync(join(s.dir, 'final2.md'), text2);
      assert.deepEqual(failed(await verifyFinalFreeze({ ...s.args, tipBlockNo: 9000 })), [], 'F1 stays the final');
      const v2 = await verifyFinalFreeze({ ...s.args, tipBlockNo: 9000, freezeTx: F2, hypothesesTx: Hb, preregPath: join(s.dir, 'final2.md') });
      // A replay of Ha is a carrier of the hypotheses record, so F2 may cite
      // it; F2 is refused on the order either way.
      const want = ['hypotheses_tx_is_the_chains', 'final_tx_carries_the_document', 'freeze_tx_is_the_chains', ...(replay ? [] : ['document_cites_hypotheses_record'])];
      for (const n of want) assert.ok(failed(v2).includes(n), `${replay ? 'replay' : 'second record'}: ${n}`);
      if (replay) assert.ok(!failed(v2).includes('document_cites_hypotheses_record'));
    } finally {
      s.cleanup();
    }
  }
});

test('one record carrying two document digests yields no final: each document must list the other items', async () => {
  // D1 and D2 list the code and the run-time items; the record carries both
  // digests, published once with each 674 line.
  const s = await scenario({ items: (d, listed) => [d, sha('the second document'), ...listed.map((l) => l.sha256)] });
  try {
    const v = await verifyFinalFreeze(s.args);
    assert.ok(failed(v).includes('document_lists_every_other_item'), failed(v).join());
  } finally {
    s.cleanup();
  }
});

test('two freeze identities on one chain: mainnet reads the pinned key only, so the second final is no final; test networks take the flag', async () => {
  assert.equal(STUDY_KEY, '8e050bfd8d687a27025f9bd5805a13501329dac58092f1c702ff626dc0780cfe');
  assert.equal(studyKeyFor('mainnet'), STUDY_KEY);
  assert.equal(studyKeyFor('mainnet', STUDY_KEY.toUpperCase()), STUDY_KEY);
  assert.throws(() => studyKeyFor('mainnet', 'cc'.repeat(32)), /pinned freeze identity/);
  assert.equal(studyKeyFor('preprod'), null);
  // K1 and K2 each publish a hypotheses record and a final freeze, and both
  // documents name both keys. The tests cannot sign with STUDY_KEY, so K1
  // stands in for it as the pin.
  const k1 = keypair();
  const k2 = keypair();
  const hex = (k) => k.pub.toString('hex');
  const dir = mkdtempSync(join(tmpdir(), 'rc-keys-'));
  const { db, add } = await chain();
  try {
    const both = `keys ${hex(k1)} ${hex(k2)}`;
    const h1 = await add({ blockNo: 1000, slot: 50000, epoch: 10, epochSlot: 1000, body: metadataBytes(record([sha('hyp1')], k1)), msg: sha('hyp1') });
    const h2 = await add({ blockNo: 1001, slot: 50020, epoch: 10, epochSlot: 1020, body: metadataBytes(record([sha('hyp2')], k2)), msg: sha('hyp2') });
    const doc = (cite, tag) => `final ${tag}\n${both}\nweb+cardano://transaction/${cite}/metadata/309\n\n${listing().map((l) => `${l.sha256}  ${l.name}`).join('\n')}\n`;
    const t1 = doc(h1, 'one');
    const t2 = doc(h2, 'two');
    writeFileSync(join(dir, 'd1.md'), t1);
    writeFileSync(join(dir, 'd2.md'), t2);
    const d1 = sha(Buffer.from(t1));
    const d2 = sha(Buffer.from(t2));
    // F1 early in epoch 11 (N = 12), F2 after epoch 11's cutoff (N = 13).
    const f1 = await add({ blockNo: 2000, slot: 4800000, epoch: 11, epochSlot: 5000, body: metadataBytes(record([d1, ...listing().map((l) => l.sha256)], k1)), msg: d1 });
    const f2 = await add({ blockNo: 2600, slot: 5100000, epoch: 11, epochSlot: 300000, body: metadataBytes(record([d2, ...listing().map((l) => l.sha256)], k2)), msg: d2 });
    const verify = (studyKey, freezeTx, file) => verifyFinalFreeze({ client: db, blocks, freezeTx, preregPath: join(dir, file), studyKey, codeDigests: code, tipBlockNo: 9000 });
    // A test network: the flag decides, and each identity has a valid final.
    assert.deepEqual(failed(await verify(studyKeyFor('preprod', hex(k1)), f1, 'd1.md')), []);
    assert.deepEqual(failed(await verify(studyKeyFor('preprod', hex(k2)), f2, 'd2.md')), []);
    // Mainnet: the second key is refused before anything is read, and under
    // the pinned key F2 is no record of the study.
    assert.throws(() => studyKeyFor('mainnet', hex(k2), hex(k1)), /pinned freeze identity/);
    const pinned = studyKeyFor('mainnet', undefined, hex(k1));
    assert.equal(pinned, hex(k1));
    assert.deepEqual(failed(await verify(pinned, f1, 'd1.md')), []);
    const second = await verify(pinned, f2, 'd2.md');
    for (const n of ['final_tx_carries_the_document', 'freeze_tx_is_the_chains', 'signed_by_study_key']) assert.ok(failed(second).includes(n), n);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--from-block starts the scan after earlier records of the key (test networks)', async () => {
  const s = await scenario({ before: async (c) => c.add({ blockNo: 500, slot: 20000, epoch: 9, epochSlot: 20000, body: metadataBytes(record([sha('an earlier rehearsal')], c.key)), msg: sha('an earlier rehearsal') }) });
  try {
    assert.ok(failed(await verifyFinalFreeze(s.args)).includes('hypotheses_tx_is_the_chains'));
    assert.deepEqual(failed(await verifyFinalFreeze({ ...s.args, fromBlock: 1000 })), []);
    assert.equal((await verifyFinalFreeze({ ...s.args, fromBlock: 1001 })).ok, false);
  } finally {
    s.cleanup();
  }
});

test('the code manifest and the check-log prefix are the ones the document names; nothing earlier follows the prefix; live-fire follows the hypotheses', async () => {
  const lines = [JSON.stringify({ seq: 1, type: 'health', date: '2001-01-01T00:00:00Z' }), JSON.stringify({ seq: 2, type: 'live-fire-start', date: '2999-01-01T00:00:00Z' })];
  const frozenText = lines.join('\n') + '\n';
  const laterText = frozenText + JSON.stringify({ seq: 3, type: 'query-start', date: '2999-01-02T00:00:00Z' }) + '\n';
  const earlyTail = frozenText + JSON.stringify({ seq: 3, type: 'live-fire-start', date: '2001-02-01T00:00:00Z' }) + '\n';
  const frozenDigest = logPrefixDigests(frozenText).at(-1);
  const s = await scenario({ listed: () => listing({ log: frozenDigest }) });
  try {
    assert.deepEqual(failed(await verifyFinalFreeze({ ...s.args, codeManifestSha256: MANIFEST, checkLogText: laterText })), []);
    assert.deepEqual(failed(await verifyFinalFreeze({ ...s.args, codeManifestSha256: sha('another manifest') })), ['code_manifest_is_the_named_one']);
    assert.deepEqual(failed(await verifyFinalFreeze({ ...s.args, checkLogText: earlyTail })), ['check_log_tail_after_freeze']);
    const other = JSON.stringify({ seq: 1, type: 'live-fire-start', date: '2001-01-01T00:00:00Z' }) + '\n';
    assert.deepEqual(failed(await verifyFinalFreeze({ ...s.args, checkLogText: other })), ['check_log_frozen', 'check_log_tail_after_freeze', 'live_fire_after_hypotheses']);
  } finally {
    s.cleanup();
  }
});

test('the snapshot by rule: the last block of epoch N - 1 before its cutoff, with the first block of N deep enough in the database and in Koios', async () => {
  const { db, block } = await chain();
  const E = 432000;
  // Epoch 9: cutoff 259,200 slots in (4k/f = 172,800 on preprod).
  await block({ blockNo: 100, slot: 9 * E + 10, epoch: 9, epochSlot: 10 });
  const snap = await block({ blockNo: 200, slot: 9 * E + 259199, epoch: 9, epochSlot: 259199 });
  await block({ blockNo: 201, slot: 9 * E + 259200, epoch: 9, epochSlot: 259200 });
  await block({ blockNo: 300, slot: 9 * E + 431999, epoch: 9, epochSlot: 431999 });
  const first = await block({ blockNo: 301, slot: 10 * E + 5, epoch: 10, epochSlot: 5 });
  const koios = (hash, tip, firstHeight = 301) => ({ snapshotBlock: async (e, cutoff) => (e === 9 && cutoff === 9 * E + 259200 ? { hash, block_height: 200 } : null), firstBlockOfEpoch: async () => ({ hash: first.hash, block_height: firstHeight }), tip: async () => ({ block_no: tip }) });
  const rs = await ruleSnapshot({ client: db, blocks, network: 'preprod', n: 10, koios: koios(snap.hash, 3000), tipBlockNo: 2461 });
  assert.equal(rs.block.hash, snap.hash, 'the last block before the cutoff, not the last of the epoch');
  assert.equal(rs.rule.cutoff_slot, 9 * E + 259200);
  assert.equal(rs.confirmation.db_depth, 2160);
  // Depth counts from the first block of epoch N.
  await assert.rejects(ruleSnapshot({ client: db, blocks, network: 'preprod', n: 10, koios: koios(snap.hash, 3000), tipBlockNo: 2460 }), /first block of epoch 10 is 2159 blocks below the database tip/);
  await assert.rejects(ruleSnapshot({ client: db, blocks, network: 'preprod', n: 10, koios: koios('00'.repeat(32), 3000), tipBlockNo: 2461 }), /Koios names another/);
  await assert.rejects(ruleSnapshot({ client: db, blocks, network: 'preprod', n: 10, koios: koios(snap.hash, 2460), tipBlockNo: 2461 }), /Koios's tip/);
  // Koios's first block of epoch N is compared by hash, not only by height.
  const otherFirst = { ...koios(snap.hash, 3000), firstBlockOfEpoch: async () => ({ hash: 'ee'.repeat(32), block_height: 301 }) };
  await assert.rejects(ruleSnapshot({ client: db, blocks, network: 'preprod', n: 10, koios: otherFirst, tipBlockNo: 2461 }), /Koios names another first block of epoch 10/);
  await assert.rejects(ruleSnapshot({ client: db, blocks, network: 'preprod', n: 11, koios: koios(snap.hash, 3000), tipBlockNo: 2461 }), /does not yet hold epoch 11/);
  // confirm-snapshot: the rule names the recorded block (exit 0), names
  // another (exit 2), or cannot confirm it yet (exit 3). Koios naming another
  // first block of epoch N leaves the snapshot unconfirmed, not replaced.
  const holds = async (k, tipBlockNo = 2461, hash = snap.hash, n = 10) => {
    try {
      return snapshotRuleHolds(await ruleSnapshot({ client: db, blocks, network: 'preprod', n, koios: k, tipBlockNo }), null, hash);
    } catch (e) {
      return snapshotRuleHolds(null, e.message, hash);
    }
  };
  assert.equal(await holds(koios(snap.hash, 3000)), true);
  assert.equal(await holds(koios(snap.hash, 3000), 2461, 'ff'.repeat(32)), false, 'the rule names another block');
  assert.equal(await holds(koios('00'.repeat(32), 3000)), false, 'Koios names another last block before the cutoff');
  assert.equal(await holds(otherFirst), null, 'Koios names another first block of epoch N');
  assert.equal(await holds(koios(snap.hash, 3000), 2460), null, 'too soon');
  assert.equal(await holds(koios(snap.hash, 2460)), null, "too soon in Koios");
  assert.equal(await holds(koios(snap.hash, 3000), 2461, snap.hash, 11), null, 'epoch N not yet in the database');
});

test('the hypotheses URI is matched whole', async () => {
  const s = await scenario();
  try {
    writeFileSync(s.args.preregPath, readFileSync(s.args.preregPath, 'utf8').replace('/metadata/309', '/metadata/3090'));
    // The document changed, so it is no longer the record's: refused on the
    // citation among the rest.
    assert.ok(failed(await verifyFinalFreeze(s.args)).includes('document_cites_hypotheses_record'));
  } finally {
    s.cleanup();
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
