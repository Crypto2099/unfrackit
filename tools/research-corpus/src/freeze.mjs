// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The final freeze and the draw key.
//
// A run on mainnet takes the final freeze transaction (A0) and checks, from
// the database, that it carries the study's final record:
//   - its label-674 message is the SHA-256 of the final pre-registration given
//     at run time (CIP-20, "Specification": {"msg": [strings]});
//   - its label-309 value is a CIP-190 record (CIPs@58b4dd1417, CIP-0190,
//     "Metadata label 309 and the chunk-array transport", "Canonical CBOR
//     (deterministic encoding)", "Record model") whose items include that
//     digest and the digest of every file of this code, and which carries a
//     signature by the study key that verifies (CIP-190, "Record-level
//     signatures (COSE_Sign1)": the signed bytes are "cardano-poe-record-sig-v1"
//     followed by the canonical record without `sigs`, inside the RFC 9052
//     Sig_structure with the protected header as published; the key is the
//     32-byte protected-header kid, path 1);
//   - the pre-registration names the study key, and cites the hypotheses
//     record by its CIP-0107 URI (web+cardano://transaction/<hash>/metadata/309),
//     a transaction in an earlier block whose own record is signed by the same
//     key and whose document is a different file. The hypotheses record is
//     therefore refused as the final one: its document cannot cite itself;
//   - its block is at least security_k (2,160) blocks below the snapshot.
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
// /epoch_params; the run refuses if N has not started or the readings differ.
// Its 32 bytes take the place of the block hash in the draw's byte encoding
// (X5): SHA-256("draw" || nonce || 28-byte credential).
//
// The record body is the byte concatenation of the label-309 chunks db-sync
// stores in tx_metadata.bytes (db-sync re-encodes the outer metadata map; the
// byte strings it carries are as published, so the body is exact). The body
// is decoded strictly and must be canonical.

import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decode, CborMap, withoutKeys, encodeBytes, encodeText } from './cbor.mjs';
import { q } from './db.mjs';
import { FIXED, GENESIS } from './params.mjs';

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
  return { body, map: rec, digests, sigs };
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

const signedBy = (t, key) => !!(t.record && t.record.signatures.some((s) => s.valid && s.kid === key) && t.record.signatures.every((s) => s.valid));

// Checks the final freeze. Returns { ok, checks, freeze, hypotheses, document }.
// Every check is listed with its outcome, so a refusal names each reason.
export async function verifyFinalFreeze({ client, blocks, freezeTx, hypothesesTx, preregPath, studyKey, codeDigests, tipBlockNo }) {
  const checks = [];
  const check = (name, ok, detail = null) => checks.push({ name, ok: !!ok, detail });
  const lower = (x) => (typeof x === 'string' ? x.toLowerCase() : x);
  freezeTx = lower(freezeTx);
  hypothesesTx = lower(hypothesesTx);
  studyKey = lower(studyKey);
  check('arguments', HEX32.test(freezeTx || '') && HEX32.test(hypothesesTx || '') && HEX32.test(studyKey || '') && !!preregPath, 'needs --freeze-tx, --hypotheses-tx, --study-key (64 hex each) and --prereg');
  if (!checks[0].ok) return { ok: false, checks };
  const docBytes = readFileSync(preregPath);
  const docDigest = sha256hex(docBytes);
  const docText = docBytes.toString('utf8');
  const document = { sha256: docDigest };

  const f = await readTx(client, blocks, freezeTx);
  check('freeze_tx_in_database', !!f, freezeTx);
  if (!f) return { ok: false, checks, document };
  const depth = tipBlockNo - f.block.block_no;
  check('freeze_block_depth', depth >= FIXED.security_k, `${depth} blocks below the snapshot, ${FIXED.security_k} required`);
  check('label_674_is_document_digest', !!f.msg && f.msg.length === 1 && f.msg[0] === docDigest, 'the 674 msg must be exactly the pre-registration digest');
  check('label_309_record', !!f.record, f.recordError);
  check('document_is_an_item', !!f.record && f.record.digests.includes(docDigest));
  check('signed_by_study_key', signedBy(f, studyKey), f.record ? f.record.signatures.map((s) => ({ kid: s.kid, valid: s.valid, reason: s.reason })) : null);
  check('document_names_study_key', docText.includes(studyKey));
  const missing = f.record ? codeDigests.filter((d) => !f.record.digests.includes(d.sha256)).map((d) => d.path) : codeDigests.map((d) => d.path);
  check('code_files_are_items', missing.length === 0, missing.length ? `not in the record: ${missing.join(', ')}` : null);

  const uri = new RegExp(`web\\+cardano://transaction/${hypothesesTx}/metadata/309`, 'i');
  check('document_cites_hypotheses_record', uri.test(docText), `web+cardano://transaction/${hypothesesTx}/metadata/309`);
  check('hypotheses_tx_differs', hypothesesTx !== freezeTx);
  const h = await readTx(client, blocks, hypothesesTx);
  check('hypotheses_tx_in_database', !!h, hypothesesTx);
  if (h) {
    check('hypotheses_block_earlier', h.block.block_no < f.block.block_no, `${h.block.block_no} < ${f.block.block_no}`);
    check('hypotheses_signed_by_study_key', signedBy(h, studyKey), h.recordError);
    check('hypotheses_document_differs', !!h.msg && h.msg[0] !== docDigest);
  }
  const ok = checks.every((c) => c.ok);
  const brief = (t) => (t ? { tx: t.tx, block_no: t.block.block_no, slot_no: t.block.slot_no, epoch_no: t.block.epoch_no, epoch_slot_no: t.block.epoch_slot_no, block_hash: t.block.hash, time: t.block.time, document_sha256: t.msg ? t.msg[0] : null, items: t.record ? t.record.digests.length : null } : null);
  return { ok, checks, document, freeze: brief(f), freezeBlock: f.block, hypotheses: brief(h) };
}

// k, f (a decimal string) and the window coefficient to slots: coef * k / f.
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
export async function drawKey({ client, blocks, network, block, koios }) {
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
  return { ...rule, nonce: row.nonce, readings: { db: row.nonce, koios: k.nonce.toLowerCase(), koios_read_at: k.read_at } };
}
