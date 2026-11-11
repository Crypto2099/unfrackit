// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The final freeze and the draw key.
//
// The order of the study's records is decided by the chain alone (decided
// 2026-10-22). Under CIP-190 each transaction carrying a record is a record
// of its own: a rebroadcast of an identical body with another `sigs` set
// "creates a separate, independent record at its own block time"
// (CIPs@58b4dd1417, CIP-0190, "Signed payload and Sig_structure"), "all
// record identity comes from the on-chain transaction hash" ("Service
// independence"), and "the same signed body MAY be submitted in two
// transactions" ("Security and Privacy Considerations", "Signature replay").
// The study's rule counts signed content and its first carrier: every
// transaction carrying the same signed content (the body without `sigs`) is
// a carrier of one study record, and the first carrier in chain order is the
// one whose block counts, as for a replayed sealed item, the analogue there
// of a replayed body, "the earliest transaction carrying the item remains the
// one whose timestamp has evidentiary weight" (CIP-190, "Cross-record
// envelope replay"). Signatures are read per transaction, never merged across
// carriers. Reading every label-309 record that verifies under the study key,
// in transaction order:
//   - the hypotheses record is the study key's first record on chain;
//   - the final record is the first later record signed by the study key,
//     without `supersedes`, whose signed content differs from the hypotheses
//     record's; a record with `supersedes` retypes an earlier one (CIP-190,
//     "Supersedence") and is never the final;
//   - the final freeze transaction is the first transaction carrying the
//     final record's signed content with a label-674 message that is exactly
//     the SHA-256 of the final pre-registration given at run time (CIP-20,
//     "Specification": {"msg": [strings]}). A copy without that line does not
//     count, and a complete copy that lands first is the final freeze.
// Which transactions the operator names (--hypotheses-tx, --freeze-tx) or the
// document cites decides nothing: each must agree with the chain's. The
// document may cite any carrier of the hypotheses record's signed content
// that precedes the final freeze in chain order (block, then position in the
// block), so the citation is settled when the final freeze lands: a carrier
// landing after it never counts. On a test network, where one key
// signs many rehearsals, --from-block starts the scan later; mainnet refuses
// it, and on mainnet the study key is STUDY_KEY (src/params.mjs). So the
// study key signs nothing between the hypotheses record and the final
// freeze, and a broadcast hypotheses or final record is never abandoned and
// replaced by a newly signed one, but resubmitted with the same bytes: a
// broadcast body can be replayed later, and a replayed body would take the
// place of one of the two records, so that the intended final would not pass.
//
// The final freeze transaction must then carry the study's final record:
//   - its label-309 value is a CIP-190 record (CIPs@58b4dd1417, CIP-0190,
//     "Metadata label 309 and the chunk-array transport", "Canonical CBOR
//     (deterministic encoding)", "Record model") whose items include the
//     document's digest and the digest of every file of this code, and which
//     carries a signature by the study key that verifies (CIP-190,
//     "Record-level signatures (COSE_Sign1)": the signed bytes are
//     "cardano-poe-record-sig-v1" followed by the canonical record without
//     `sigs`, inside the RFC 9052 Sig_structure with the protected header as
//     published; the key is the 32-byte protected-header kid, path 1);
//   - the document names the study key and cites a transaction carrying the
//     chain's hypotheses record, earlier than the final freeze, by its
//     CIP-0107 URI (web+cardano://transaction/<hash>/metadata/309), and is
//     not an item of the hypotheses record;
//   - the document lists every other item of the record exactly once, as the
//     freeze tool requires, in lines of <64 lowercase hex><two spaces><name>;
//     every such line names an item, and the document does not list itself.
//     CIP-190 items carry no names ("Item entries"), so the list says which
//     item is which, and only one item of a record can be its document: two
//     documents would each have to contain the other's digest;
//   - the list names exactly one code manifest and exactly one check-log
//     prefix, by the names FREEZE_ITEM_NAMES gives; the code manifest given
//     at run time must be that item, and on mainnet that item must be a
//     prefix of the check log ending at a line (the log as it stood at the
//     final freeze; it only grows), after which every entry is dated after
//     the final freeze block, and whose first live-fire run, of this tool or
//     the simulator, postdates the hypotheses block;
//   - its block is at least security_k (2,160) blocks below the database tip.
//
// The draw key h is the epoch nonce of epoch N, where E is the epoch of the
// final freeze block: N = E + 1 if the block's slot is earlier than E's first
// slot plus the epoch length less the randomness stabilisation window, else
// N = E + 2. The window is 4k/f in every Praos era except Babbage, which uses
// 3k/f (IntersectMBO/ouroboros-consensus, ouroboros-consensus-cardano,
// Ouroboros/Consensus/Cardano/Node.hs, praosRandomnessStabilisationWindow and
// partialConsensusConfigBabbage); a freeze is only expected from Conway on
// (protocol_major 9 or more), so any earlier era is refused. k, f and the
// epoch length are the hashed constants of src/params.mjs, compared with
// Koios /genesis. The nonce is read from epoch_param.nonce and from Koios
// /epoch_params, and on mainnet from the freeze tool's drawkey.json, which
// records the readings of Koios and Blockfrost; the run refuses if N has not
// started or any reading differs.
// Its 32 bytes take the place of the block hash in the draw's byte encoding
// (the default reading of the setting x5_reward29): SHA-256("draw" || nonce ||
// 28-byte credential).
//
// The record body is the byte concatenation of the label-309 chunks db-sync
// stores in tx_metadata.bytes (db-sync re-encodes the outer metadata map; the
// byte strings it carries are as published, so the body is exact). The body
// is decoded strictly and must be canonical.

import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decode, CborMap, withoutKeys, encodeBytes, encodeText } from './cbor.mjs';
import { q } from './db.mjs';
import { FIXED, GENESIS, FREEZE_ITEM_NAMES } from './params.mjs';
import { LIVE_FIRE_STARTS } from './checklog.mjs';

const HEX32 = /^[0-9a-f]{64}$/;
const SIG_DOMAIN = Buffer.from('cardano-poe-record-sig-v1', 'utf8');

export const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

// The label-309 value (db-sync's bytes for the key) to the record body.
export function reassemble(bytesHex) {
  const outer = decode(Buffer.from(bytesHex, 'hex'), { strict: false });
  if (!(outer instanceof CborMap) || outer.entries.length !== 1 || outer.entries[0].key !== 309) throw new Error('label 309: not a single-label metadata map');
  const chunks = outer.entries[0].value;
  if (!Array.isArray(chunks)) throw new Error('label 309: value is not a chunk array');
  for (const c of chunks) {
    if (!Buffer.isBuffer(c)) throw new Error('label 309: a chunk is not a byte string');
    if (c.length > 64) throw new Error('label 309: a chunk is longer than 64 bytes');
  }
  return Buffer.concat(chunks);
}

// The record body to its digests and signatures. Throws on anything outside
// what the study's freeze tool writes and CIP-190 admits for it.
export function parseRecord(body) {
  const rec = decode(body, { strict: true });
  if (!(rec instanceof CborMap)) throw new Error('record: not a map');
  if (rec.get('v') !== 1) throw new Error('record: v is not 1');
  for (const k of rec.keys()) {
    if (typeof k !== 'string') throw new Error('record: a key is not text');
    if (!['v', 'items', 'merkle', 'supersedes', 'sigs', 'crit'].includes(k) && !/^(x-.+|[a-z]+-.+)$/.test(k)) throw new Error(`record: unknown key ${k}`);
  }
  if (rec.has('crit')) throw new Error('record: carries crit');
  const items = rec.get('items');
  if (!Array.isArray(items) || items.length === 0) throw new Error('record: no items');
  const digests = items.map((it, i) => {
    const h = it instanceof CborMap ? it.get('hashes') : undefined;
    const d = h instanceof CborMap ? h.get('sha2-256') : undefined;
    if (!Buffer.isBuffer(d) || d.length !== 32) throw new Error(`record: item ${i} has no 32-byte sha2-256`);
    return d.toString('hex');
  });
  const sigs = rec.get('sigs');
  if (!Array.isArray(sigs) || sigs.length === 0) throw new Error('record: no sigs');
  // The signed content: the body without sigs. The study counts carriers of
  // the same signed content as one of its records, whatever co-signatures
  // were added (see the header).
  return { body, map: rec, digests, sigs, supersedes: rec.has('supersedes'), signed: withoutKeys(body, rec, ['sigs']) };
}

function edKey(raw) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

// Every signature entry, verified. Returns [{ kid, alg, valid, reason }].
export function verifySignatures(record) {
  const toSign = Buffer.concat([SIG_DOMAIN, withoutKeys(record.body, record.map, ['sigs'])]);
  return record.sigs.map((s) => {
    try {
      if (!(s instanceof CborMap) || !Buffer.isBuffer(s.get('cose_sign1'))) throw new Error('sig entry without cose_sign1');
      if (s.has('cose_key')) throw new Error('wallet-path signature (cose_key), not the study key path');
      const cose = decode(s.get('cose_sign1'), { strict: false });
      if (!Array.isArray(cose) || cose.length !== 4) throw new Error('COSE_Sign1 is not a 4-element array');
      const [protectedBytes, unprotected, payload, signature] = cose;
      if (!Buffer.isBuffer(protectedBytes) || !(unprotected instanceof CborMap) || payload !== null || !Buffer.isBuffer(signature)) throw new Error('COSE_Sign1 shape');
      if (unprotected.get('hashed') === true) throw new Error('hashed mode is not used by the study');
      const prot = decode(protectedBytes, { strict: false });
      if (!(prot instanceof CborMap)) throw new Error('protected header is not a map');
      const alg = prot.get(1);
      const kid = prot.get(4);
      if (alg !== -8 && alg !== -19) throw new Error(`unsupported alg ${alg}`);
      if (!Buffer.isBuffer(kid) || kid.length !== 32) throw new Error('no 32-byte protected kid');
      const sigStructure = Buffer.concat([Buffer.from([0x84]), encodeText('Signature1'), encodeBytes(protectedBytes), Buffer.from([0x40]), encodeBytes(toSign)]);
      const valid = signature.length === 64 && edVerify(null, sigStructure, edKey(kid), signature);
      return { kid: kid.toString('hex'), alg, valid, reason: valid ? null : 'signature does not verify' };
    } catch (e) {
      return { kid: null, alg: null, valid: false, reason: e.message };
    }
  });
}

// The label-674 message of a transaction's metadata rows: the msg array, or null.
export function msgOf(rows) {
  const r = rows.find((x) => Number(x.key) === 674);
  if (!r || !r.json) return null;
  const j = JSON.parse(r.json);
  return j && Array.isArray(j.msg) ? j.msg : null;
}

export async function readTx(client, blocks, txHash) {
  const b = (await q(client, blocks, 'block_of_tx', { tx_hash: { type: 'bytea', value: txHash } }))[0];
  if (!b) return null;
  const meta = await q(client, blocks, 'tx_metadata_of_tx', { tx_hash: { type: 'bytea', value: txHash } });
  const block = { tx_id: Number(b.tx_id), id: Number(b.id), block_no: Number(b.block_no), slot_no: Number(b.slot_no), epoch_no: Number(b.epoch_no), epoch_slot_no: Number(b.epoch_slot_no), time: b.time, hash: b.hash };
  let record = null;
  let recordError = null;
  const m309 = meta.find((x) => Number(x.key) === 309);
  if (m309) {
    try {
      record = parseRecord(reassemble(m309.bytes));
      record.signatures = verifySignatures(record);
    } catch (e) {
      recordError = e.message;
    }
  } else recordError = 'no label-309 metadata';
  return { tx: txHash, block, msg: msgOf(meta), record, recordError };
}

export const signedBy = (t, key) => !!(t.record && t.record.signatures.some((s) => s.valid && s.kid === key) && t.record.signatures.every((s) => s.valid));

// The SHA-256 of every prefix of the check log that ends at a line boundary,
// the empty prefix included.
export function logPrefixDigests(text) {
  const out = [sha256hex('')];
  let at = 0;
  for (;;) {
    const nl = text.indexOf('\n', at);
    if (nl < 0) break;
    at = nl + 1;
    out.push(sha256hex(text.slice(0, at)));
  }
  return out;
}

// A live-fire start entry is written only once the run's gate (connection,
// probes, the hypotheses record on mainnet) has passed, so a refused attempt
// does not count as a live-fire run. LIVE_FIRE_STARTS holds the start types
// of both tools, so the first live-fire run is the first of either.
const CITATION = /web\+cardano:\/\/transaction\/([0-9a-fA-F]{64})\/metadata\/309(?![0-9])/g;
const blockTime = (t) => Date.parse(`${String(t).replace(' ', 'T')}Z`);

// The document's hash table: lines of <64 lowercase hex><two spaces><name>.
export function hashTable(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line);
    if (m) out.push({ sha256: m[1], name: m[2] });
  }
  return out;
}
const baseName = (n) => n.split('/').pop();

// Every label-309 record signed by the study key from a transaction id on, in
// transaction order: [{ tx, tx_id, record, signed (hex) }]. A value that does
// not parse, or a record that does not verify under the key, is no record of
// the study.
export async function studyRecords(client, blocks, studyKey, loTxId = 0) {
  const rows = await q(client, blocks, 'label_309_from', { lo: { type: 'int', value: loTxId } });
  const out = [];
  for (const r of rows) {
    let rec;
    try {
      rec = parseRecord(reassemble(r.bytes));
      rec.signatures = verifySignatures(rec);
    } catch {
      continue;
    }
    if (!signedBy({ record: rec }, studyKey)) continue;
    out.push({ tx: r.tx, tx_id: Number(r.tx_id), record: rec, signed: rec.signed.toString('hex') });
  }
  return out;
}

// The chain's order of the study's records (see the header). Returns
// { hypotheses, hypothesesCarriers, final, finalTx, records } (any may be
// null or empty): hypothesesCarriers are every transaction carrying the
// hypotheses record's signed content, as { tx, tx_id } in chain order, the
// first carrier first.
export async function chainOrder({ client, blocks, studyKey, docDigest, loTxId = 0 }) {
  const recs = await studyRecords(client, blocks, studyKey, loTxId);
  const hypotheses = recs[0] || null;
  const hypothesesCarriers = hypotheses ? recs.filter((r) => r.signed === hypotheses.signed).map((r) => ({ tx: r.tx, tx_id: r.tx_id })) : [];
  const final = hypotheses ? recs.find((r) => r.tx_id > hypotheses.tx_id && !r.record.supersedes && r.signed !== hypotheses.signed) || null : null;
  let finalTx = null;
  if (final) {
    for (const r of recs.filter((x) => x.signed === final.signed)) {
      const meta = await q(client, blocks, 'tx_metadata_of_tx', { tx_hash: { type: 'bytea', value: r.tx } });
      const m = msgOf(meta);
      if (m && m.length === 1 && m[0] === docDigest) {
        finalTx = r.tx;
        break;
      }
    }
  }
  return { hypotheses, hypothesesCarriers, final, finalTx, records: recs.length };
}

// Checks the final freeze. Returns { ok, checks, freeze, hypotheses, document,
// freezeBlock }. Every check is listed with its outcome, so a refusal names
// each reason. freezeTx and hypothesesTx are optional: given, each must be the
// chain's. codeManifestSha256: the run's code manifest, which must be the one
// the document names. checkLogText: the check log of the network, or
// undefined to skip that check. fromBlock: test networks only, the block
// height the scan starts at.
export async function verifyFinalFreeze({ client, blocks, freezeTx, hypothesesTx, preregPath, studyKey, codeDigests, tipBlockNo, codeManifestSha256 = null, checkLogText, fromBlock = null }) {
  const checks = [];
  const check = (name, ok, detail = null) => checks.push({ name, ok: !!ok, detail });
  const lower = (x) => (typeof x === 'string' ? x.toLowerCase() : x);
  freezeTx = lower(freezeTx);
  hypothesesTx = lower(hypothesesTx);
  studyKey = lower(studyKey);
  check('arguments', HEX32.test(studyKey || '') && !!preregPath && (!freezeTx || HEX32.test(freezeTx)) && (!hypothesesTx || HEX32.test(hypothesesTx)), 'needs --study-key (64 hex) and --prereg; --freeze-tx and --hypotheses-tx are 64 hex when given');
  if (!checks[0].ok) return { ok: false, checks };
  const docBytes = readFileSync(preregPath);
  const docDigest = sha256hex(docBytes);
  const docText = docBytes.toString('utf8');
  const document = { sha256: docDigest };

  // The order, from the chain alone.
  let loTxId = 0;
  if (fromBlock !== null && fromBlock !== undefined) {
    const r = (await q(client, blocks, 'first_tx_from_block_no', { block_no: { type: 'int', value: Number(fromBlock) } }))[0];
    loTxId = r && r.tx_id !== null ? Number(r.tx_id) : Number.MAX_SAFE_INTEGER;
  }
  const order = await chainOrder({ client, blocks, studyKey, docDigest, loTxId });
  check('hypotheses_record_on_chain', !!order.hypotheses, order.hypotheses ? order.hypotheses.tx : 'no record signed by the study key');
  if (hypothesesTx) check('hypotheses_tx_is_the_chains', !!order.hypotheses && order.hypotheses.tx === hypothesesTx, order.hypotheses ? `the chain's hypotheses record is ${order.hypotheses.tx}` : null);
  check('final_record_on_chain', !!order.final, order.final ? order.final.tx : 'no later record signed by the study key with other content');
  check('final_tx_carries_the_document', !!order.finalTx, order.finalTx || 'no carrier of the final record has a label-674 message of exactly the document digest');
  if (freezeTx) check('freeze_tx_is_the_chains', !!order.finalTx && order.finalTx === freezeTx, order.finalTx ? `the chain's final freeze is ${order.finalTx}` : null);

  // The transaction the remaining checks read: the chain's final freeze, or
  // for a report on a refused one, the transaction named or the final
  // record's first carrier.
  const fTx = order.finalTx || freezeTx || (order.final && order.final.tx);
  const f = fTx ? await readTx(client, blocks, fTx) : null;
  check('freeze_tx_in_database', !!f, fTx);
  if (!f) return { ok: false, checks, document };
  const depth = tipBlockNo - f.block.block_no;
  check('freeze_block_depth', depth >= FIXED.security_k, `${depth} blocks below the tip, ${FIXED.security_k} required`);
  check('label_674_is_document_digest', !!f.msg && f.msg.length === 1 && f.msg[0] === docDigest, 'the 674 msg must be exactly the pre-registration digest');
  check('label_309_record', !!f.record, f.recordError);
  check('document_is_an_item', !!f.record && f.record.digests.includes(docDigest));
  check('signed_by_study_key', signedBy(f, studyKey), f.record ? f.record.signatures.map((s) => ({ kid: s.kid, valid: s.valid, reason: s.reason })) : null);
  check('record_has_no_supersedes', !!f.record && !f.record.supersedes, 'a record that supersedes another is not the final freeze');
  check('document_names_study_key', docText.includes(studyKey));
  const missing = f.record ? codeDigests.filter((d) => !f.record.digests.includes(d.sha256)).map((d) => d.path) : codeDigests.map((d) => d.path);
  check('code_files_are_items', missing.length === 0, missing.length ? `not in the record: ${missing.join(', ')}` : null);

  // The document's list of the other items (the freeze tool's rule).
  const table = hashTable(docText);
  const others = f.record ? f.record.digests.filter((d) => d !== docDigest) : [];
  const count = (d) => table.filter((t) => t.sha256 === d).length;
  const unlisted = others.filter((d) => count(d) !== 1);
  const strays = table.filter((t) => !others.includes(t.sha256));
  check('document_lists_every_other_item', !!f.record && unlisted.length === 0 && strays.length === 0, unlisted.length || strays.length ? `${unlisted.length} item(s) not listed exactly once; ${strays.length} listed line(s) not another item of the record` : null);
  const manifests = table.filter((t) => baseName(t.name) === FREEZE_ITEM_NAMES.code_manifest);
  const logs = table.filter((t) => baseName(t.name) === FREEZE_ITEM_NAMES.check_log);
  check('document_names_one_code_manifest', manifests.length === 1, `${manifests.length} line(s) named ${FREEZE_ITEM_NAMES.code_manifest}`);
  check('document_names_one_check_log', logs.length === 1, `${logs.length} line(s) named ${FREEZE_ITEM_NAMES.check_log}`);
  if (codeManifestSha256) check('code_manifest_is_the_named_one', manifests.length === 1 && manifests[0].sha256 === codeManifestSha256, codeManifestSha256);

  // The hypotheses record, as the chain orders it: h is its first carrier.
  // The document may cite any carrier of its signed content that precedes
  // the final freeze in chain order (transaction id: block, then position in
  // the block), so the citation is settled when the final freeze lands; a
  // carrier landing after it never counts, even one the document named in
  // advance. Whether the final document differs is read from the signed
  // content, never from a carrier's 674 line, which anyone copying the body
  // may leave out or write.
  const h = order.hypotheses ? await readTx(client, blocks, order.hypotheses.tx) : null;
  const cited = [...new Set([...docText.matchAll(CITATION)].map((m) => m[1].toLowerCase()))];
  const carriers = (order.hypothesesCarriers || []).filter((c) => c.tx_id < f.block.tx_id);
  const citedCarrier = carriers.find((c) => cited.includes(c.tx)) || null;
  check('document_cites_hypotheses_record', !!h && !!citedCarrier, h ? `web+cardano://transaction/${h.tx}/metadata/309, or another of the ${carriers.length} carrier(s) of its signed content earlier than the final freeze` : null);
  if (h) {
    check('hypotheses_block_earlier', h.block.block_no < f.block.block_no, `${h.block.block_no} < ${f.block.block_no}`);
    check('hypotheses_document_differs', !order.hypotheses.record.digests.includes(docDigest), 'the final pre-registration must not be an item of the hypotheses record');
    if (checkLogText !== undefined) {
      const text = checkLogText || '';
      const entries = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const at = logs.length === 1 ? logPrefixDigests(text).indexOf(logs[0].sha256) : -1;
      check('check_log_frozen', at >= 0, at >= 0 ? null : `the check-log item the document names is not a prefix of the ${checkLogText ? 'current' : 'empty'} log`);
      const freezeTime = blockTime(f.block.time);
      const early = at >= 0 ? entries.slice(at).filter((e) => !(Date.parse(e.date) > freezeTime)) : [];
      check('check_log_tail_after_freeze', at >= 0 && early.length === 0, early.length ? `entries after the frozen log dated before the final freeze: ${early.map((e) => e.seq).join(', ')}` : null);
      const first = entries.find((e) => LIVE_FIRE_STARTS.has(e.type));
      check('live_fire_after_hypotheses', !first || Date.parse(first.date) > blockTime(h.block.time), first ? `first live-fire run ${first.date} (${first.type}), hypotheses block ${h.block.time}` : 'no live-fire run');
    }
  }
  const ok = checks.every((c) => c.ok);
  const brief = (t) => (t ? { tx: t.tx, block_no: t.block.block_no, slot_no: t.block.slot_no, epoch_no: t.block.epoch_no, epoch_slot_no: t.block.epoch_slot_no, block_hash: t.block.hash, time: t.block.time, document_sha256: t.msg ? t.msg[0] : null, items: t.record ? t.record.digests.length : null } : null);
  // The hypotheses record as reported and published: its first carrier's
  // transaction and block, its items from the signed content, the carrier the
  // document cites, and as its document the item that carrier's 674 line
  // names. The first carrier may be anyone's copy of the body, with any 674
  // line or none; the cited carrier is the one the key holder's signed
  // document names, and its line counts only when it is exactly one item of
  // the record, so no 674 line can publish a digest the signed content
  // lacks.
  let hypotheses = null;
  if (h) {
    const items = order.hypotheses.record.digests;
    const line = !citedCarrier ? null : citedCarrier.tx === h.tx ? h.msg : msgOf(await q(client, blocks, 'tx_metadata_of_tx', { tx_hash: { type: 'bytea', value: citedCarrier.tx } }));
    hypotheses = { ...brief(h), document_sha256: line && line.length === 1 && items.includes(line[0]) ? line[0] : null, items_sha256: items, cited_tx: citedCarrier ? citedCarrier.tx : null };
  }
  return { ok, checks, document, freeze: brief(f), freezeBlock: f.block, hypotheses, scan: { from_block: fromBlock ?? null, records: order.records } };
}

export function stabilityWindow(k, f, coef) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(f));
  if (!m) throw new Error(`active slot coefficient ${f}`);
  const den = 10n ** BigInt((m[2] || '').length);
  const num = BigInt(m[1] + (m[2] || ''));
  const w = (BigInt(coef) * BigInt(k) * den) / num;
  if ((BigInt(coef) * BigInt(k) * den) % num !== 0n) throw new Error('stability window is not a whole number of slots');
  return Number(w);
}

// The epoch rule, from the freeze block's slot and epoch.
export function drawEpoch({ epochNo, slotNo, epochSlotNo, protocolMajor, genesis }) {
  if (!(protocolMajor >= 9)) throw new Error(`refusing: the freeze block is in protocol_major ${protocolMajor}; the epoch rule is stated for Conway and later Praos eras`);
  if (!(epochSlotNo >= 0 && epochSlotNo < genesis.epoch_length)) throw new Error('freeze block slot is outside its epoch');
  const window = stabilityWindow(genesis.k, genesis.f, 4);
  const firstSlot = slotNo - epochSlotNo;
  const cutoff = firstSlot + genesis.epoch_length - window;
  const n = slotNo < cutoff ? epochNo + 1 : epochNo + 2;
  return { e: epochNo, slot_no: slotNo, first_slot: firstSlot, epoch_length: genesis.epoch_length, k: genesis.k, f: genesis.f, window, cutoff, n };
}

// The draw key for a block (the final freeze block, or on a test network a
// stand-in's block): the rule, the database's nonce and Koios's, which must
// agree. koios needs genesis() and epochNonce(n).
// The freeze tool's drawkey.json (format research-freeze-drawkey-v1): the
// nonce of epoch N read from Koios and from Blockfrost for the final freeze.
// The file is matched on network, epoch and nonce: the readings corroborate
// the nonce of epoch N, whichever carrier of the final record the freeze tool
// wrote it for (its transaction is recorded with the readings).
export function drawkeyFileErrors(doc, { network, n, nonce }) {
  const errors = [];
  if (!doc || doc.format !== 'research-freeze-drawkey-v1') return ['not a research-freeze drawkey.json'];
  if (doc.network !== network) errors.push(`network ${doc.network}`);
  if (Number(doc.nonce_epoch) !== n) errors.push(`epoch ${doc.nonce_epoch}`);
  if (String(doc.nonce).toLowerCase() !== nonce) errors.push('nonce');
  const sources = new Map((doc.readings || []).map((r) => [r.source, String(r.nonce).toLowerCase()]));
  for (const src of ['koios', 'blockfrost']) {
    if (!sources.has(src)) errors.push(`no ${src} reading`);
    else if (sources.get(src) !== nonce) errors.push(`${src} reading differs`);
  }
  return errors;
}

export async function drawKey({ client, blocks, network, block, koios, txHash = null, drawkeyFile = null }) {
  const genesis = GENESIS[network];
  if (!genesis) throw new Error(`no genesis constants for ${network}`);
  const kg = await koios.genesis();
  if (Number(kg.securityparam) !== genesis.k || String(kg.activeslotcoeff) !== genesis.f || Number(kg.epochlength) !== genesis.epoch_length) {
    throw new Error(`refusing: Koios /genesis (k ${kg.securityparam}, f ${kg.activeslotcoeff}, epoch length ${kg.epochlength}) differs from the hashed constants for ${network}`);
  }
  const ep = (await q(client, blocks, 'epoch_nonce', { epoch_no: { type: 'int', value: block.epoch_no } }))[0];
  if (!ep) throw new Error(`no epoch_param row for the freeze block's epoch ${block.epoch_no}`);
  const rule = drawEpoch({ epochNo: block.epoch_no, slotNo: block.slot_no, epochSlotNo: block.epoch_slot_no, protocolMajor: Number(ep.protocol_major), genesis });
  const row = (await q(client, blocks, 'epoch_nonce', { epoch_no: { type: 'int', value: rule.n } }))[0];
  if (!row || !row.nonce) throw new Error(`refusing: epoch ${rule.n} has not started in the database (its nonce is the draw key)`);
  const k = await koios.epochNonce(rule.n);
  if (!k.nonce) throw new Error(`refusing: Koios has no nonce for epoch ${rule.n}`);
  if (k.nonce.toLowerCase() !== row.nonce) throw new Error(`refusing: epoch ${rule.n} nonce differs between the database and Koios`);
  const readings = { db: row.nonce, koios: k.nonce.toLowerCase(), koios_read_at: k.read_at };
  if (drawkeyFile) {
    const doc = JSON.parse(readFileSync(drawkeyFile, 'utf8'));
    const errs = drawkeyFileErrors(doc, { network, n: rule.n, nonce: row.nonce });
    if (errs.length) throw new Error(`refusing: the freeze tool's drawkey.json differs: ${errs.join(', ')}`);
    readings.freeze_tool = doc.readings.map((r) => ({ source: r.source, at: r.at, nonce: String(r.nonce).toLowerCase() }));
    readings.freeze_tool_tx = String(doc.tx_hash).toLowerCase();
    readings.freeze_tool_tx_is_freeze = !txHash || readings.freeze_tool_tx === txHash;
    readings.drawkey_sha256 = sha256hex(readFileSync(drawkeyFile));
  }
  return { ...rule, nonce: row.nonce, readings };
}

// The snapshot fixed by rule (decided 2026-10-21, refined 2026-10-22): the
// last block of epoch N - 1 whose slot is earlier than N - 1's randomness
// stabilisation cutoff (its first slot plus the epoch length less 4k/f), N
// being the draw epoch. A block updates the candidate nonce, which becomes
// epoch N's nonce, only while its slot plus the window is before the first
// slot of the next epoch, so N's nonce is fixed at that cutoff and readable
// from any node from then on (IntersectMBO/ouroboros-consensus@d94473e212,
// ouroboros-consensus-protocol, Ouroboros/Consensus/Protocol/PolyPraos.hs,
// praosStateCandidateNonce in the block update and the epoch-boundary tick).
// The frames are therefore fixed no later than the draw key becomes known.
// The database must hold the first block of epoch N at least security_k
// blocks below its tip, and Koios must name the same snapshot block and the
// same first block of N, that one at least security_k below Koios's tip: a
// rollback can then reach neither the snapshot nor any block that could come
// before the cutoff after it. koios needs snapshotBlock(epoch, cutoff),
// firstBlockOfEpoch(epoch) and tip().
export async function ruleSnapshot({ client, blocks, network, n, koios, tipBlockNo }) {
  const genesis = GENESIS[network];
  if (!genesis) throw new Error(`no genesis constants for ${network}`);
  const epoch = n - 1;
  const anyBlock = (await q(client, blocks, 'first_block_of_epoch', { epoch_no: { type: 'int', value: epoch } }))[0];
  const next = (await q(client, blocks, 'first_block_of_epoch', { epoch_no: { type: 'int', value: n } }))[0];
  if (!anyBlock || !next) throw new Error(`refusing: the snapshot is in epoch ${epoch}, and the database does not yet hold epoch ${n}`);
  const window = stabilityWindow(genesis.k, genesis.f, 4);
  const firstSlot = Number(anyBlock.slot_no) - Number(anyBlock.epoch_slot_no);
  const cutoff = firstSlot + genesis.epoch_length - window;
  const snap = (await q(client, blocks, 'last_block_before_slot', { epoch_no: { type: 'int', value: epoch }, slot_no: { type: 'int', value: cutoff } }))[0];
  if (!snap) throw new Error(`refusing: epoch ${epoch} has no block before its cutoff slot ${cutoff}`);
  const depth = tipBlockNo - Number(next.block_no);
  if (depth < FIXED.security_k) throw new Error(`refusing: the first block of epoch ${n} is ${depth} blocks below the database tip; it must be ${FIXED.security_k} deep`);
  const kb = await koios.snapshotBlock(epoch, cutoff);
  const kn = await koios.firstBlockOfEpoch(n);
  const kt = await koios.tip();
  if (!kb || String(kb.hash).toLowerCase() !== snap.hash) throw new Error(`refusing: Koios names another last block of epoch ${epoch} before slot ${cutoff}`);
  if (!kn) throw new Error(`refusing: Koios has no block of epoch ${n}`);
  if (String(kn.hash).toLowerCase() !== next.hash) throw new Error(`refusing: Koios names another first block of epoch ${n}`);
  const kDepth = Number(kt.block_no) - Number(kn.block_height);
  if (kDepth < FIXED.security_k) throw new Error(`refusing: the first block of epoch ${n} is ${kDepth} blocks below Koios's tip; it must be ${FIXED.security_k} deep`);
  return {
    block: snap,
    rule: { epoch, n, first_slot: firstSlot, window, cutoff_slot: cutoff },
    confirmation: {
      first_block_of_n: { block_no: Number(next.block_no), hash: next.hash },
      db_depth: depth,
      koios: { hash: String(kb.hash).toLowerCase(), first_block_of_n: { block_height: Number(kn.block_height), hash: String(kn.hash).toLowerCase() }, tip_block_no: Number(kt.block_no), depth: kDepth, read_at: new Date().toISOString() }
    }
  };
}
