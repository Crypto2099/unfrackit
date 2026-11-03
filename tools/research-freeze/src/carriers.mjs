// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Other carriers of a run's record, under the study's chain-order rule.
//
// A signed record body is portable: "the same signed body MAY be submitted in
// two transactions" (CIP-190, "Security and Privacy Considerations",
// "Signature replay"), and a rebroadcast "creates a separate, independent
// record at its own block time" (CIP-190, "Record-level signatures
// (COSE_Sign1)", "Signed payload and Sig_structure"). Anyone who sees this
// tool's transaction in a mempool can put its record on chain in a
// transaction of their own, and theirs may land first.
//
// The study orders its records by the chain alone, and the extraction tool
// that reads them from chain decides by this rule, restated here with the
// same record reader so that the two tools take every transaction alike:
//
// - a transaction carries a record's signed content when its label-309 chunk
//   array (byte strings of at most 64 bytes, joined in order) reassembles to
//   a body that decodes strictly as canonical CBOR (CIP-190, "Canonical CBOR
//   (deterministic encoding)"), has `v` 1, items and at least one signature
//   and no `crit`, whose map without `sigs` is byte for byte the record's,
//   and whose signatures all verify, one of them by the record's key.
//   Chunking, other metadata and co-signatures that verify leave it the same
//   record;
// - the hypotheses record's first carrier is the first such transaction in
//   chain order;
// - the final freeze is the first carrier of the final record whose label-674
//   value is a map whose `msg` is exactly one text string, the document's
//   SHA-256 in lowercase hex (CIP-20, "Specification"). A carrier without
//   that line neither counts nor blocks.
//
// Chain order is block height, then the transaction's index in its block.
//
// Finding the carriers. Koios lists label-309 transactions by block height
// (/tx_by_metalabel) and Blockfrost lists them newest first
// (/metadata/txs/labels/309/cbor). No carrier can sit at or below the lower
// bound: k blocks under the tip height when the record was signed, since a
// rollback reaches at most k blocks back. The scan covers every block above
// the anchor, the newest label-309 transaction at or below that bound in
// Koios's listing, whose block Blockfrost must place at the same height, up
// to and including this run's block, and the two listings must name the same
// transactions in that range. A listed transaction is ruled out only when
// both providers' metadata views show a label-309 value without this
// record's signed content; otherwise its bytes are read from both, compared
// and hash-bound, and decide, and a carrier's block and index must be the
// same on both. Absence counts only from a listing that includes this run's
// own transaction, which shows the provider has indexed its block and, the
// listing being in chain order, everything before it. Anything short of that
// leaves the scan undecided, and an undecided scan lets no step pass. A
// single provider's fault can therefore make the scan refuse or stay
// undecided, but not pass.

import { createPublicKey, verify as edVerify } from 'node:crypto';
import { blake2b256 } from '@cardanowall/crypto-core/hash';
import { arraySpans, mapSpans, majorAt, uintAt, bytesAt, textAt, tagAt, skipItem } from './cbor.mjs';
import { concat, equalBytes, fromHex, sleep as realSleep, toHex } from './util.mjs';

// The study's record reader. Strict mode is CIP-190's canonical decode
// (shortest heads, definite lengths, map keys in strictly increasing
// bytewise order, valid UTF-8, no tags, no floats, no simple values other
// than false, true and null); lenient mode, for a COSE_Sign1 as published,
// also accepts indefinite lengths, non-shortest heads and tags. Maps keep
// each entry's byte span, so the body without `sigs` is rebuilt from the
// published bytes.

class StudyMap {
  constructor() {
    this.entries = [];
  }
  get(key) {
    const e = this.entries.find((x) => x.key === key);
    return e ? e.value : undefined;
  }
  has(key) {
    return this.entries.some((x) => x.key === key);
  }
  keys() {
    return this.entries.map((x) => x.key);
  }
}

class Reader {
  constructor(buf, strict) {
    this.b = buf;
    this.p = 0;
    this.strict = strict;
  }
  fail(msg) {
    throw new Error(`CBOR at byte ${this.p}: ${msg}`);
  }
  byte() {
    if (this.p >= this.b.length) this.fail('unexpected end');
    return this.b[this.p++];
  }
  take(n) {
    if (this.p + n > this.b.length) this.fail('unexpected end');
    const out = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return out;
  }
  arg(ai) {
    if (ai < 24) return BigInt(ai);
    let v;
    if (ai === 24) v = BigInt(this.byte());
    else if (ai === 25) v = BigInt(this.take(2).readUInt16BE(0));
    else if (ai === 26) v = BigInt(this.take(4).readUInt32BE(0));
    else if (ai === 27) v = this.take(8).readBigUInt64BE(0);
    else if (ai === 31) return null;
    else this.fail(`reserved additional information ${ai}`);
    if (this.strict) {
      const min = ai === 24 ? 24n : ai === 25 ? 0x100n : ai === 26 ? 0x10000n : 0x100000000n;
      if (v < min) this.fail('integer or length not in shortest form');
    }
    return v;
  }
  len(ai) {
    const v = this.arg(ai);
    if (v === null) {
      if (this.strict) this.fail('indefinite length');
      return null;
    }
    if (v > BigInt(this.b.length)) this.fail('length beyond input');
    return Number(v);
  }
  item() {
    const ib = this.byte();
    const mt = ib >> 5;
    const ai = ib & 31;
    switch (mt) {
      case 0: {
        const v = this.arg(ai);
        if (v === null) this.fail('indefinite integer');
        return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
      }
      case 1: {
        const v = this.arg(ai);
        if (v === null) this.fail('indefinite integer');
        const n = -1n - v;
        return n >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(n) : n;
      }
      case 2:
      case 3: {
        const n = this.len(ai);
        let bytes;
        if (n === null) {
          const parts = [];
          for (;;) {
            if (this.b[this.p] === 0xff) {
              this.p++;
              break;
            }
            const h = this.byte();
            if (h >> 5 !== mt || (h & 31) === 31) this.fail('bad chunk in indefinite string');
            parts.push(Buffer.from(this.take(this.len(h & 31))));
          }
          bytes = Buffer.concat(parts);
        } else bytes = Buffer.from(this.take(n));
        if (mt === 2) return bytes;
        try {
          return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          return this.fail('text string is not valid UTF-8');
        }
      }
      case 4: {
        const n = this.len(ai);
        const out = [];
        if (n === null) {
          while (this.b[this.p] !== 0xff) out.push(this.item());
          this.p++;
        } else for (let i = 0; i < n; i++) out.push(this.item());
        return out;
      }
      case 5: {
        const n = this.len(ai);
        const m = new StudyMap();
        let prevKey = null;
        const one = () => {
          const start = this.p;
          const key = this.item();
          const kEnd = this.p;
          const value = this.item();
          const kb = this.b.subarray(start, kEnd);
          if (this.strict && prevKey && Buffer.compare(prevKey, kb) >= 0) this.fail('map keys not in strictly increasing bytewise order');
          prevKey = kb;
          m.entries.push({ key, value, start, end: this.p });
        };
        if (n === null) {
          while (this.b[this.p] !== 0xff) one();
          this.p++;
        } else for (let i = 0; i < n; i++) one();
        return m;
      }
      case 6:
        if (this.strict) this.fail('tags are not allowed');
        this.arg(ai);
        return this.item();
      case 7:
        if (ai === 20) return false;
        if (ai === 21) return true;
        if (ai === 22) return null;
        return this.fail(`simple value or float ${ai} is not allowed`);
      default:
        return this.fail('unreachable');
    }
  }
}

function studyDecode(buf, { strict = true } = {}) {
  const r = new Reader(Buffer.from(buf), strict);
  const v = r.item();
  if (r.p !== r.b.length) throw new Error(`CBOR: ${r.b.length - r.p} trailing bytes`);
  return v;
}

function head(mt, n) {
  const t = mt << 5;
  if (n < 24) return Buffer.from([t | n]);
  if (n < 0x100) return Buffer.from([t | 24, n]);
  if (n < 0x10000) return Buffer.from([t | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = t | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

const encodeBytes = (b) => Buffer.concat([head(2, b.length), b]);
const encodeText = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([head(3, b.length), b]);
};

function withoutKeys(buf, map, drop) {
  const kept = map.entries.filter((e) => !drop.includes(e.key));
  return Buffer.concat([head(5, kept.length), ...kept.map((e) => buf.subarray(e.start, e.end))]);
}

const SIG_DOMAIN = Buffer.from('cardano-poe-record-sig-v1', 'utf8');
const KNOWN_KEYS = ['v', 'items', 'merkle', 'supersedes', 'sigs', 'crit'];

// A record body to its digests and signatures; throws on anything the rule
// does not take as a record.
function studyRecord(body) {
  const rec = studyDecode(body, { strict: true });
  if (!(rec instanceof StudyMap)) throw new Error('record: not a map');
  if (rec.get('v') !== 1) throw new Error('record: v is not 1');
  for (const k of rec.keys()) {
    if (typeof k !== 'string') throw new Error('record: a key is not text');
    if (!KNOWN_KEYS.includes(k) && !/^(x-.+|[a-z]+-.+)$/.test(k)) throw new Error(`record: unknown key ${k}`);
  }
  if (rec.has('crit')) throw new Error('record: carries crit');
  const items = rec.get('items');
  if (!Array.isArray(items) || items.length === 0) throw new Error('record: no items');
  items.forEach((it, i) => {
    const h = it instanceof StudyMap ? it.get('hashes') : undefined;
    const d = h instanceof StudyMap ? h.get('sha2-256') : undefined;
    if (!Buffer.isBuffer(d) || d.length !== 32) throw new Error(`record: item ${i} has no 32-byte sha2-256`);
  });
  const sigs = rec.get('sigs');
  if (!Array.isArray(sigs) || sigs.length === 0) throw new Error('record: no sigs');
  return { body, map: rec, sigs, signed: withoutKeys(body, rec, ['sigs']) };
}

function edKey(raw) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

// Every signature entry, verified: [{ kid, valid }]. The protected header is
// placed in the Sig_structure as published (CIP-190, "Signed payload and
// Sig_structure"); the key is the 32-byte protected kid (path 1,
// "Signer-key identification"); a wallet-path entry (cose_key) and hashed
// mode do not verify under the rule.
function studySignatures(record) {
  const toSign = Buffer.concat([SIG_DOMAIN, record.signed]);
  return record.sigs.map((s) => {
    try {
      if (!(s instanceof StudyMap) || !Buffer.isBuffer(s.get('cose_sign1'))) throw new Error('sig entry without cose_sign1');
      if (s.has('cose_key')) throw new Error('wallet-path signature');
      const cose = studyDecode(s.get('cose_sign1'), { strict: false });
      if (!Array.isArray(cose) || cose.length !== 4) throw new Error('COSE_Sign1 is not a 4-element array');
      const [protectedBytes, unprotected, payload, signature] = cose;
      if (!Buffer.isBuffer(protectedBytes) || !(unprotected instanceof StudyMap) || payload !== null || !Buffer.isBuffer(signature)) throw new Error('COSE_Sign1 shape');
      if (unprotected.get('hashed') === true) throw new Error('hashed mode');
      const prot = studyDecode(protectedBytes, { strict: false });
      if (!(prot instanceof StudyMap)) throw new Error('protected header is not a map');
      const alg = prot.get(1);
      const kid = prot.get(4);
      if (alg !== -8 && alg !== -19) throw new Error(`unsupported alg ${alg}`);
      if (!Buffer.isBuffer(kid) || kid.length !== 32) throw new Error('no 32-byte protected kid');
      const sigStructure = Buffer.concat([Buffer.from([0x84]), encodeText('Signature1'), encodeBytes(protectedBytes), Buffer.from([0x40]), encodeBytes(toSign)]);
      const valid = signature.length === 64 && edVerify(null, sigStructure, edKey(kid), signature);
      return { kid: kid.toString('hex'), valid };
    } catch {
      return { kid: null, valid: false };
    }
  });
}

// Every signature valid, one of them by `key`.
const signedByKey = (signatures, key) => signatures.some((s) => s.valid && s.kid === key) && signatures.every((s) => s.valid);

// The signed content of a record body: its canonical map without `sigs`.
export function signedContentOf(body) {
  return new Uint8Array(studyRecord(Buffer.from(body)).signed);
}

// The same, rebuilt from the walker's spans without decoding the values, to
// compare cheaply before the full reading; null when the body is not a single
// map.
const SIGS_KEY = encodeText('sigs');
function quickSignedContent(body) {
  try {
    if (!body.length || majorAt(body, 0) !== 5 || skipItem(body, 0) !== body.length) return null;
    const kept = mapSpans(body, 0).filter((e) => !Buffer.from(body.subarray(e.key[0], e.key[1])).equals(SIGS_KEY));
    return concat(head(5, kept.length), ...kept.map((e) => body.subarray(e.key[0], e.value[1])));
  } catch {
    return null;
  }
}

// A label-309 value at `pos` to the record body: an array whose elements are
// byte strings of at most 64 bytes, joined; null for anything else.
function chunksAt(bytes, pos) {
  try {
    if (majorAt(bytes, pos) !== 4) return null;
    const chunks = [];
    for (const [s] of arraySpans(bytes, pos)) {
      const c = bytesAt(bytes, s);
      if (!c || c.length > 64) return null;
      chunks.push(c);
    }
    return concat(...chunks);
  } catch {
    return null;
  }
}

// The signers of the record at `pos` when it has the signed content `signed`
// under the rule, or null.
function recordAt(bytes, pos, signed, key) {
  const body = chunksAt(bytes, pos);
  if (!body) return null;
  const quick = quickSignedContent(body);
  if (!quick || !equalBytes(quick, signed)) return null;
  try {
    const rec = studyRecord(Buffer.from(body));
    if (!equalBytes(rec.signed, signed)) return null;
    const sigs = studySignatures(rec);
    return signedByKey(sigs, key) ? sigs.map((s) => s.kid) : null;
  } catch {
    return null;
  }
}

// Whether the label-674 value at `pos` is a map whose `msg` is exactly
// [line]. Any `msg` entry counts, so a map with two of them is never read
// more narrowly than an indexer that keeps one.
function msgIs(bytes, pos, line) {
  try {
    if (majorAt(bytes, pos) !== 5) return false;
    return mapSpans(bytes, pos).some((e) => {
      if (textAt(bytes, e.key[0]) !== 'msg' || majorAt(bytes, e.value[0]) !== 4) return false;
      const els = arraySpans(bytes, e.value[0]);
      return els.length === 1 && textAt(bytes, els[0][0]) === line;
    });
  } catch {
    return false;
  }
}

// The metadata entries of a transaction, read with the walker after both
// bindings: the body hashes to the transaction hash, and the raw auxiliary
// data to the body's auxiliary_data_hash (CIP-190, "Structural validation,
// verifier roles, and error codes", Part B, "Pipeline", step 2). The three
// auxiliary-data forms are told apart by type and tag alone (CIP-190,
// "Auxiliary-data envelope forms"). Throws on bytes that are not a
// well-formed transaction.
export function boundMetadata(bytes, txHash) {
  const top = arraySpans(bytes, 0);
  if (top.length < 2 || top[top.length - 1][1] !== bytes.length) throw new Error('not a transaction: a top-level array of at least two items covering every byte');
  const bodyHash = toHex(blake2b256(bytes.subarray(top[0][0], top[0][1])));
  if (bodyHash !== txHash) return { bound: false, reason: `its body hashes to ${bodyHash}, not to ${txHash}` };
  const auxSpan = top.length >= 4 ? top[3] : top.length === 3 ? top[2] : null;
  const hasAux = auxSpan !== null && majorAt(bytes, auxSpan[0]) !== 7;
  if (majorAt(bytes, top[0][0]) !== 5) return { bound: false, reason: 'its body is not a map' };
  const committed = mapSpans(bytes, top[0][0]).find((e) => uintAt(bytes, e.key[0]) === 7n);
  if (!hasAux) return committed ? { bound: false, reason: 'its body commits to auxiliary data it does not carry' } : { bound: true, entries: [] };
  const digest = committed ? bytesAt(bytes, committed.value[0]) : null;
  if (!digest || !equalBytes(digest, blake2b256(bytes.subarray(auxSpan[0], auxSpan[1])))) return { bound: false, reason: 'its auxiliary data does not hash to the body\'s auxiliary_data_hash' };
  let p = auxSpan[0];
  let metadata = null;
  const tag = tagAt(bytes, p);
  if (tag !== null) {
    if (tag !== 259n) return { bound: true, entries: [] };
    p = skipTagHead(bytes, p);
    if (majorAt(bytes, p) !== 5) return { bound: true, entries: [] };
    const zero = mapSpans(bytes, p).find((e) => uintAt(bytes, e.key[0]) === 0n);
    metadata = zero ? zero.value[0] : null;
  } else if (majorAt(bytes, p) === 4) {
    const items = arraySpans(bytes, p);
    metadata = items.length ? items[0][0] : null;
  } else if (majorAt(bytes, p) === 5) metadata = p;
  if (metadata === null || majorAt(bytes, metadata) !== 5) return { bound: true, entries: [] };
  return { bound: true, entries: mapSpans(bytes, metadata).map((e) => ({ label: uintAt(bytes, e.key[0]), value: e.value })) };
}

// The position just past one tag head.
function skipTagHead(bytes, pos) {
  const ai = bytes[pos] & 0x1f;
  return pos + 1 + (ai < 24 ? 0 : 1 << (ai - 24));
}

// What a transaction's bytes say under the rule: whether it carries the
// record whose signed content is `signed`, signed by `key`, and whether its
// label-674 msg is exactly `line`.
export function carrierOf(bytes, txHash, { signed, key, line }) {
  const m = boundMetadata(bytes, txHash);
  if (!m.bound) return { bound: false, reason: m.reason };
  const signers = new Set();
  let carries = false;
  for (const e of m.entries.filter((x) => x.label === 309n)) {
    const kids = recordAt(bytes, e.value[0], signed, key);
    if (kids) {
      carries = true;
      for (const k of kids) signers.add(k);
    }
  }
  const exact = typeof line === 'string' && m.entries.filter((x) => x.label === 674n).some((x) => msgIs(bytes, x.value[0], line));
  return { bound: true, carries, label_674_exact: exact, signers: [...signers] };
}

// What a provider's metadata view shows of a listed transaction's label-309
// value: 'match' when it reassembles to a body with this signed content,
// 'other' when it plainly does not, 'unreadable' when it cannot be told.
//
// Blockfrost's listing gives the label's metadata as CBOR: the single-entry
// map {309: value} that db-sync stores.
export function blockfrostSignal(metadataHex, signed) {
  let b;
  try {
    b = fromHex(String(metadataHex));
    if (!b.length || skipItem(b, 0) !== b.length || majorAt(b, 0) !== 5) return 'unreadable';
  } catch {
    return 'unreadable';
  }
  const es = mapSpans(b, 0).filter((e) => uintAt(b, e.key[0]) === 309n);
  if (es.length !== 1) return 'unreadable';
  const body = chunksAt(b, es[0].value[0]);
  if (!body) return 'other';
  const q = quickSignedContent(body);
  return q && equalBytes(q, signed) ? 'match' : 'other';
}

// Koios gives the label's metadata as db-sync's JSON, where a byte string is
// "0x" followed by its hex. That view cannot tell bytes from a text string
// that looks the same, which is why a 'match' from either view sends the
// transaction to be read from its bytes.
export function koiosSignal(json, signed) {
  if (json === undefined || json === null) return 'unreadable';
  if (!Array.isArray(json) || !json.every((c) => typeof c === 'string')) return 'other';
  if (!json.every((c) => /^0x([0-9a-fA-F]{2})*$/.test(c))) return 'unreadable';
  const chunks = json.map((c) => fromHex(c.slice(2)));
  if (chunks.some((c) => c.length > 64)) return 'other';
  const q = quickSignedContent(concat(...chunks));
  return q && equalBytes(q, signed) ? 'match' : 'other';
}

export const FIRST_ANCHOR_WINDOW = 2160; // blocks below the lower bound searched first for the anchor
const KOIOS_ROWS = 1000;
const BLOCKFROST_ROWS = 100;
const MAX_BLOCKFROST_PAGES = 2000;

export function ruleFor(stage) {
  const carrier = "a transaction carries this record when its label-309 record has this record's signed content (the body without sigs), every signature valid and one by its key; chain order is block height, then index in the block";
  return stage === 'final'
    ? `the final freeze is the first carrier whose label-674 msg is exactly the document digest (${carrier})`
    : `the hypotheses record's first carrier is the first carrier (${carrier})`;
}

// Bytes of a transaction from both providers: identical, or an issue.
async function bothBytes(koios, bf, h) {
  const kc = await koios.txCbor(h);
  const bc = await bf.txCbor(h);
  if (!kc || !bc) return { issue: kc || bc ? `only ${kc ? 'Koios' : 'Blockfrost'} returns the bytes of ${h}` : `neither provider returns the bytes of ${h}` };
  if (String(kc).toLowerCase() !== String(bc).toLowerCase()) return { issue: `the bytes of ${h} differ between Koios and Blockfrost` };
  try {
    return { bytes: fromHex(String(kc).toLowerCase()) };
  } catch {
    return { issue: `the bytes the providers return for ${h} are not hex` };
  }
}

// The block and in-block index of a transaction from both providers.
async function placed(koios, bf, h) {
  const ki = await koios.txInfo(h);
  const bi = await bf.tx(h);
  if (!ki?.block_hash || !bi?.block) return { issue: `${ki?.block_hash ? 'Blockfrost' : 'Koios'} gives no block for ${h}` };
  const k = { block_hash: ki.block_hash, block_height: Number(ki.block_height), index: Number(ki.tx_block_index) };
  const b = { block_hash: bi.block, block_height: Number(bi.block_height), index: Number(bi.index) };
  for (const f of ['block_height', 'index']) {
    if (!Number.isSafeInteger(k[f]) || k[f] < 0 || !Number.isSafeInteger(b[f]) || b[f] < 0) return { issue: `the ${f === 'index' ? 'index in its block' : 'block height'} of ${h} is missing: Koios ${ki[f === 'index' ? 'tx_block_index' : 'block_height']}, Blockfrost ${bi[f]}` };
  }
  const diff = ['block_hash', 'block_height', 'index'].filter((f) => String(k[f]) !== String(b[f]));
  if (diff.length) return { issue: `Koios and Blockfrost place ${h} differently: ${diff.map((f) => `${f} ${k[f]} vs ${b[f]}`).join(', ')}` };
  return k;
}

// One pass of the scan; see the header. `lowerHeight`: a block height at or
// before the tip when the record was signed, so no carrier can sit at or
// below it.
async function scanOnce({ koios, bf, txHash, signed, key, line, stage, lowerHeight }) {
  const issues = [];
  const out = { ran: true, decided: false, issues, at: new Date().toISOString(), stage, rule: ruleFor(stage), lower_height: lowerHeight };
  koios.allowTx(txHash);
  bf.allowTx(txHash);

  // This run's own transaction must carry its record under the rule, and for
  // a final its line, or the rule is not the one this tool applies.
  const own = await bothBytes(koios, bf, txHash);
  if (own.issue) return { ...out, issues: [own.issue] };
  const self = carrierOf(own.bytes, txHash, { signed, key, line });
  if (!self.bound || !self.carries || (stage === 'final' && !self.label_674_exact)) {
    return { ...out, issues: [`this run's transaction ${txHash} does not carry its own record under the rule (${self.reason || (self.carries ? 'its label-674 msg is not exactly the document digest' : 'no label-309 record with its signed content and signatures')})`] };
  }
  const T = await placed(koios, bf, txHash);
  if (T.issue) return { ...out, issues: [T.issue] };
  const H = T.block_height;
  out.block = { height: H, hash: T.block_hash, index: T.index };
  if (!(Number.isSafeInteger(lowerHeight) && lowerHeight >= 0 && lowerHeight < H)) return { ...out, issues: [`the lower bound ${lowerHeight} is not below this run's block ${H}`] };

  // The anchor: the newest label-309 transaction at or below the lower bound,
  // as Koios lists them, searched in widening windows.
  let anchor = null;
  for (let w = FIRST_ANCHOR_WINDOW; ; w *= 4) {
    const from = Math.max(0, lowerHeight - w);
    const rows = await koios.label309Txs({ from, upTo: lowerHeight, order: 'desc', limit: 1 });
    const row = rows.find((r) => r.blockHeight >= from && r.blockHeight <= lowerHeight);
    if (row) {
      anchor = row;
      break;
    }
    if (from === 0) break;
  }
  const floor = anchor ? anchor.blockHeight : -1;
  out.anchor = anchor ? { tx_hash: anchor.txHash, block_height: anchor.blockHeight, block_hash: anchor.blockHash } : null;
  // Blockfrost must place the anchor in the same block, at the same height:
  // its listing is read down to the anchor, so the anchor's height bounds
  // what that listing covers.
  if (anchor) {
    if (!/^[0-9a-f]{64}$/.test(String(anchor.blockHash))) return { ...out, issues: [`Koios lists the anchor ${anchor.txHash} without a block hash`] };
    bf.allowAnchorBlock(anchor.blockHash);
    const blk = await bf.block(anchor.blockHash);
    if (!blk || Number(blk.height) !== anchor.blockHeight) return { ...out, issues: [`Koios lists the anchor ${anchor.txHash} in block ${anchor.blockHash} at height ${anchor.blockHeight}; Blockfrost ${blk ? `places that block at height ${blk.height}` : 'does not know that block'}`] };
    if (!(await bf.blockTxs(anchor.blockHash)).includes(anchor.txHash)) return { ...out, issues: [`Koios lists the anchor ${anchor.txHash} in block ${anchor.blockHash}; Blockfrost's block holds no such transaction`] };
  }

  // Koios: every label-309 transaction from the anchor's block up to and
  // including this run's. A response holds every row below the height of its
  // last row, so the next request starts at that height.
  const K = new Map();
  for (let start = Math.max(0, floor); ; ) {
    const rows = await koios.label309Txs({ from: start, upTo: H, order: 'asc', limit: KOIOS_ROWS });
    for (const r of rows) {
      if (r.blockHeight < start || r.blockHeight > H) issues.push(`Koios's listing of blocks ${start} to ${H} returned ${r.txHash} in block ${r.blockHeight}`);
      else if (K.has(r.txHash) && K.get(r.txHash) !== r.blockHeight) issues.push(`Koios lists ${r.txHash} in blocks ${K.get(r.txHash)} and ${r.blockHeight}`);
      else K.set(r.txHash, r.blockHeight);
    }
    if (rows.length < KOIOS_ROWS) break;
    const last = rows[rows.length - 1].blockHeight;
    if (!(last > start)) {
      issues.push(`Koios lists ${KOIOS_ROWS} or more label-309 transactions in block ${start}`);
      break;
    }
    start = last;
  }
  if (issues.length) return out;
  if (!K.has(txHash)) return { ...out, issues: [`Koios's label-309 listing does not include this run's transaction yet (it has not indexed block ${H}, or does not list it)`] };
  if (K.get(txHash) !== H) return { ...out, issues: [`Koios's label-309 listing puts this run's transaction in block ${K.get(txHash)}, not ${H}`] };

  // Blockfrost: newest first, until its listing passes this run's
  // transaction and reaches the anchor's block.
  const seq = [];
  const meta = new Map();
  let stop = -1;
  let ended = false;
  let lagging = false;
  for (let page = 1; stop < 0 && !ended && !lagging; page++) {
    if (page > MAX_BLOCKFROST_PAGES) {
      issues.push(`Blockfrost's label-309 listing is longer than ${MAX_BLOCKFROST_PAGES} pages above the anchor`);
      return out;
    }
    const rows = await bf.label309Page(page);
    for (const r of rows) {
      if (meta.has(r.txHash)) continue; // the listing moved between pages
      meta.set(r.txHash, r.metadata);
      seq.push(r.txHash);
      const kh = K.get(r.txHash);
      if (!meta.has(txHash) && kh !== undefined && kh < H) {
        // An older transaction first: this run's is not listed, or not yet.
        lagging = { tx: r.txHash, height: kh };
        break;
      }
      if (meta.has(txHash) && anchor && r.txHash === anchor.txHash) {
        stop = seq.length - 1;
        break;
      }
    }
    if (rows.length < BLOCKFROST_ROWS) ended = true;
  }
  if (!meta.has(txHash)) {
    const where = lagging ? ` before ${lagging.tx}, which Koios lists in block ${lagging.height}` : '';
    return { ...out, issues: [`Blockfrost's label-309 listing does not include this run's transaction${where} (it has not indexed block ${H} yet, or the listings disagree)`] };
  }
  if (anchor && stop < 0) return { ...out, issues: [`Blockfrost's label-309 listing ends without reaching the anchor ${anchor.txHash} (block ${floor}), which Koios lists`] };
  const tPos = seq.indexOf(txHash);
  const after = seq.slice(tPos + 1, stop < 0 ? seq.length : stop);
  const afterSet = new Set(after);

  // The two listings must name the same transactions in the range (those
  // in the anchor's own block are at or below the lower bound).
  for (const h of after) {
    if (!K.has(h)) issues.push(`Blockfrost lists ${h} between this run's transaction and the anchor; Koios does not list it in blocks ${Math.max(0, floor)} to ${H}`);
  }
  for (const [h, kh] of K) {
    if (h === txHash || kh <= floor) continue;
    if (kh < H && !afterSet.has(h)) issues.push(`Koios lists ${h} in block ${kh}; Blockfrost's listing does not place it before this run's transaction`);
    else if (kh === H && !meta.has(h)) issues.push(`Koios lists ${h} in this run's block ${H}; Blockfrost's listing does not include it`);
  }
  if (issues.length) return out;

  // What each provider shows of every other listed transaction in the range.
  const candidates = [...K.keys()].filter((h) => h !== txHash && K.get(h) > floor);
  const km = candidates.length ? await koios.txMetadata(candidates) : new Map();
  const examined = [];
  const toRead = [];
  for (const h of candidates) {
    const b = blockfrostSignal(meta.get(h), signed);
    const kMeta = km.get(h);
    const k = koiosSignal(kMeta && typeof kMeta === 'object' ? kMeta['309'] : undefined, signed);
    examined.push({ tx_hash: h, block_height: K.get(h), blockfrost: b, koios: k });
    if (b !== 'other' || k !== 'other') toRead.push(h);
  }

  // Each one either view does not rule out is read from both providers.
  const carriers = [];
  const lookAlikes = [];
  for (const h of toRead) {
    koios.allowCarrier(h);
    bf.allowCarrier(h);
    const got = await bothBytes(koios, bf, h);
    if (got.issue) {
      issues.push(got.issue);
      continue;
    }
    let facts;
    try {
      facts = carrierOf(got.bytes, h, { signed, key, line });
    } catch (e) {
      issues.push(`the bytes the providers return for ${h} are not a well-formed transaction: ${e.message}`);
      continue;
    }
    if (!facts.bound) {
      issues.push(`the bytes the providers return for ${h} are not that transaction: ${facts.reason}`);
      continue;
    }
    if (!facts.carries) {
      lookAlikes.push(h);
      continue;
    }
    const p = await placed(koios, bf, h);
    if (p.issue) {
      issues.push(p.issue);
      continue;
    }
    if (p.block_height !== K.get(h)) issues.push(`Koios lists ${h} in block ${K.get(h)} but places it in block ${p.block_height}`);
    if (p.block_height === H && p.block_hash !== T.block_hash) issues.push(`${h} is placed in block ${p.block_hash} at this run's height ${H}, which is block ${T.block_hash}`);
    const precedes = p.block_height < H || (p.block_height === H && p.index < T.index);
    carriers.push({ tx_hash: h, block_height: p.block_height, block_hash: p.block_hash, index: p.index, label_674_exact: facts.label_674_exact, signers: facts.signers, precedes });
  }
  if (issues.length) return out;

  const counting = carriers.filter((c) => stage !== 'final' || c.label_674_exact);
  const earlier = counting.filter((c) => c.precedes).sort((a, b) => a.block_height - b.block_height || a.index - b.index);
  return {
    ...out,
    decided: true,
    listed: [...K.values()].filter((kh) => kh > floor).length,
    examined: examined.length,
    read: toRead,
    look_alikes: lookAlikes,
    carriers,
    earlier,
    first_carrier: earlier.length ? earlier[0].tx_hash : txHash
  };
}

// The scan, tried `attempts` times `pollMs` apart until it is decided.
export async function scanCarriers({ attempts = 3, pollMs = 20000, sleep = realSleep, log = () => {}, ...args }) {
  for (let i = 1; ; i++) {
    const r = await scanOnce(args);
    r.attempts = i;
    if (r.decided || i >= attempts) return r;
    log(`the scan for other carriers of ${args.txHash} is undecided (${r.issues.join('; ')}); trying again in ${Math.round(pollMs / 1000)} s`);
    await sleep(pollMs);
  }
}

// The refusal a decided scan of a final-stage record calls for, or null.
export function earlierFinalIssue(scan, txHash) {
  const c = scan.earlier?.[0];
  if (!c) return null;
  const more = scan.earlier.length > 1 ? ` (${scan.earlier.length} such transactions come before it: ${scan.earlier.map((x) => x.tx_hash).join(', ')})` : '';
  return (
    `${c.tx_hash} (block ${c.block_height}, index ${c.index}) carries this run's final record with its label-674 line and comes before ${txHash} (block ${scan.block.height}, index ${scan.block.index}) in chain order${more}; ` +
    'under the study\'s chain-order rule the first such transaction is the final freeze, so the draw is keyed to its block, not to this run\'s transaction'
  );
}

// What an undecided scan means for the step that ran it.
export function undecidedIssue(scan) {
  return `the scan for other carriers of this record is undecided: ${scan.issues.join('; ')}; run it again once both providers have indexed this run's block and agree`;
}
