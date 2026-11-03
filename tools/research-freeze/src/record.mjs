// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The label-309 record: built, signed, encoded and carried. Every step is
// done by the SDK and again by this tool's own encoder, and the two byte
// strings must be identical.

import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import {
  encodePoeRecord,
  encodeRecordBodyForSigning,
  validatePoeRecord,
  chunkRecordBody,
  encodeLabel309Value,
  reassembleLabel309Value,
  TRANSPORT_CHUNK_MAX_BYTES
} from '@cardanowall/poe-standard';
import { prepareSigStructure, assembleCoseSign1 } from '@cardanowall/sdk-ts/client';
import { coseSign1Label309Verify, CARDANO_POE_SIG_DOMAIN_PREFIX_BYTES } from '@cardanowall/crypto-core/cose';
import { encode, decode } from './cbor.mjs';
import { RECORD_URI_RE } from './manifest.mjs';
import { nodeVerify } from './keys.mjs';
import { concat, equalBytes, fromHex, toHex, UserError } from './util.mjs';

// CIP-190, "Signed payload and Sig_structure": the 25 ASCII bytes prepended to
// the canonical body without `sigs`.
export const SIG_DOMAIN = new TextEncoder().encode('cardano-poe-record-sig-v1');
if (SIG_DOMAIN.length !== 25 || !equalBytes(SIG_DOMAIN, CARDANO_POE_SIG_DOMAIN_PREFIX_BYTES)) throw new Error('signature domain prefix mismatch');

export const LABEL_POE = 309;
export const LABEL_MSG = 674;

function same(a, b, what) {
  if (!equalBytes(a, b)) throw new Error(`${what}: the SDK and this tool's encoder disagree (${toHex(a).slice(0, 64)}... vs ${toHex(b).slice(0, 64)}...)`);
  return a;
}

// The record body without `sigs`, as a JS value both encoders accept.
//
// - `items` follow the manifest's order, each `{ "hashes": { "sha2-256": d } }`
//   (CIP-190 "Item entries", "Hash algorithms").
// - `research-items` maps each item's 32-byte digest (the same bytes as in
//   items[i].hashes) to a closed `{ type, ? ids }` map; omitted with coreOnly.
//   It is a companion-namespace extension key (CIP-190 "Forward compatibility
//   and critical extensions": `^[a-z]+-.+`), and no key is ever listed in
//   `crit`: this tool never writes `crit`.
// - `supersedes` is the 32-byte transaction hash ("Supersedence").
// - `research-related` entries carry a record URI, matched exactly.
export function buildRecord({ kind, hashed, coreOnly = false, supersedes, related }) {
  if (coreOnly && kind === 'retype') throw new UserError('a retype record exists to carry typing; --core-only does not apply');
  const seen = new Set();
  for (const h of hashed) {
    if (h.digest.length !== 32) throw new Error('digest must be 32 bytes');
    if (seen.has(h.hex)) throw new UserError(`two items have the same SHA-256 (${h.hex}); research-items could not type them separately`);
    seen.add(h.hex);
  }
  const record = { v: 1, items: hashed.map((h) => ({ hashes: { 'sha2-256': h.digest } })) };
  if (supersedes !== undefined) record.supersedes = fromHex(supersedes, { lower: true, length: 32 });
  if (!coreOnly) {
    const untyped = hashed.filter((h) => !h.type).map((h) => h.name);
    if (untyped.length) throw new UserError(`a typed record types every item; no type for ${untyped.join(', ')} (or build with --core-only)`);
    record['research-items'] = new Map(
      hashed.map((h) => {
        const typing = { type: h.type };
        if (h.ids) typing.ids = h.ids.map((x) => ({ ...x }));
        return [h.digest, typing];
      })
    );
  }
  if (related !== undefined) {
    for (const r of related) {
      if (!RECORD_URI_RE.test(r.uri)) throw new UserError(`research-related uri must match ^web\\+cardano://transaction/[0-9a-f]{64}/metadata/309$ exactly: ${r.uri}`);
    }
    record['research-related'] = related.map((r) => ({ ...r }));
  }
  if ('crit' in record) throw new Error('unreachable: crit is never written');
  return record;
}

export function protectedHeaderBytes(publicKey) {
  // `{1: -8, 4: <32-byte key>}` encodes as a2 01 27 04 58 20 || key (CIP-190
  // "Signer-key identification", path 1).
  const bytes = encode(new Map([[1, -8], [4, publicKey]]));
  if (toHex(bytes.subarray(0, 6)) !== 'a20127045820' || bytes.length !== 38) throw new Error('unexpected protected header encoding');
  return bytes;
}

// Sign the record (CIP-190 "Record-level signatures (COSE_Sign1)"):
//   to_sign       = "cardano-poe-record-sig-v1" || canonical(record without sigs)
//   Sig_structure = ["Signature1", protected, h'', to_sign]
//   COSE_Sign1    = [protected, {}, null, signature], untagged
//
// CIP-8 makes a `version` and a `hashed` entry mandatory in the unprotected
// header ("Version", "Payload encoding"). CIP-190 treats an absent `hashed` as
// false ("Signing algorithm", the CIP-8 `hashed` mode paragraph), its
// conformance vectors pin an empty unprotected map
// (conformance/cose/sign1-build.json), and the vectors are authoritative in
// any byte-level dispute ("Conventions and terminology"). The unprotected
// header is therefore the empty map, and hashed mode is not used.
export async function signRecord(record, signingKey) {
  const pub = signingKey.publicKey;
  const bodyNoSigs = same(encodeRecordBodyForSigning(record), encode(record), 'record body without sigs');
  const protectedBytes = protectedHeaderBytes(pub);
  const toSign = concat(SIG_DOMAIN, bodyNoSigs);
  const ownSigStructure = encode(['Signature1', protectedBytes, new Uint8Array(0), toSign]);
  if (toHex(ownSigStructure.subarray(0, 12)) !== '846a5369676e617475726531') throw new Error('Sig_structure does not begin 84 6a "Signature1"');
  const prep = prepareSigStructure({ record, signerPubkey: pub });
  same(prep.protectedHeaderBytes, protectedBytes, 'protected header');
  same(prep.sigStructureBytes, ownSigStructure, 'Sig_structure');

  const signature = await signingKey.sign(ownSigStructure);
  const asm = assembleCoseSign1({ record, signerPubkey: pub, signature });
  const coseSign1 = same(asm.coseSign1Bytes, encode([protectedBytes, new Map(), null, signature]), 'COSE_Sign1');

  const signed = { ...record, sigs: [asm.sigEntry] };
  const body = same(encodePoeRecord(signed), encode({ ...record, sigs: [{ cose_sign1: coseSign1 }] }), 'record body');

  const v = coseSign1Label309Verify({ message: coseSign1, detachedRecordBodyCbor: bodyNoSigs });
  if (!v.ok || !equalBytes(v.signerKey, pub)) throw new Error(`the SDK does not verify the signature just made: ${JSON.stringify(v.error || {})}`);
  if (!nodeVerify(pub, ownSigStructure, signature)) throw new Error('OpenSSL does not verify the signature just made');

  return { record: signed, body, bodyNoSigs, sigStructure: ownSigStructure, coseSign1, signature };
}

// The record's top-level keys in wire order (canonical CBOR sorts them by
// their encoding, so for this tool's records: v, sigs, items, supersedes,
// research-items, research-related).
export function topLevelKeys(body) {
  return [...decode(body, { canonical: true }).keys()];
}

// Chunk-array transport (CIP-190 "Metadata label 309 and the chunk-array
// transport"): a definite-length array of definite-length byte strings, the
// minimal split (every chunk 64 bytes except the last), even for a short body.
export function carry(body) {
  const sdk = chunkRecordBody(body);
  const own = [];
  for (let o = 0; o < body.length; o += 64) own.push(body.slice(o, Math.min(o + 64, body.length)));
  if (sdk.length !== own.length || sdk.some((c, i) => !equalBytes(c, own[i]))) throw new Error('chunking: the SDK and this tool disagree');
  if (TRANSPORT_CHUNK_MAX_BYTES !== 64) throw new Error('unexpected transport chunk size');
  const valueBytes = same(encodeLabel309Value(body), encode(own), 'label-309 value');
  const back = reassembleLabel309Value(valueBytes);
  if (!back.ok || !equalBytes(back.body, body)) throw new Error('the label-309 value does not reassemble to the record body');
  return { chunks: own, valueBytes };
}

// CIP-20 "Specification": `{ "msg": [ line, ... ] }`, each line at most 64
// bytes. The lines are SHA-256 digests in lowercase hex, 64 bytes each.
export function messageLines(hashed, messageIndexes) {
  const lines = messageIndexes.map((i) => hashed[i].hex);
  for (const l of lines) if (!/^[0-9a-f]{64}$/.test(l) || Buffer.byteLength(l) > 64) throw new Error('bad message line');
  return lines;
}

export function auxiliaryData(chunks, lines) {
  const md = CSL.GeneralTransactionMetadata.new();
  const list = CSL.MetadataList.new();
  for (const c of chunks) list.add(CSL.TransactionMetadatum.new_bytes(c));
  md.insert(CSL.BigNum.from_str(String(LABEL_POE)), CSL.TransactionMetadatum.new_list(list));
  const msg = CSL.MetadataList.new();
  for (const l of lines) msg.add(CSL.TransactionMetadatum.new_text(l));
  const map = CSL.MetadataMap.new();
  map.insert(CSL.TransactionMetadatum.new_text('msg'), CSL.TransactionMetadatum.new_list(msg));
  md.insert(CSL.BigNum.from_str(String(LABEL_MSG)), CSL.TransactionMetadatum.new_map(map));
  const aux = CSL.AuxiliaryData.new();
  aux.set_metadata(md);
  return aux;
}

// The auxiliary data as this tool expects it on the wire: an untagged map,
// the metadata map itself (CIP-190 "Auxiliary-data envelope forms").
export function expectedAuxiliaryBytes(chunks, lines) {
  return encode(new Map([[LABEL_POE, chunks], [LABEL_MSG, new Map([['msg', lines]])]]));
}

// The metadata in cardano-api's detailed JSON schema, for reading only.
export function detailedMetadataJson(chunks, lines) {
  return {
    [LABEL_POE]: { list: chunks.map((c) => ({ bytes: toHex(c) })) },
    [LABEL_MSG]: { map: [{ k: { string: 'msg' }, v: { list: lines.map((l) => ({ string: l })) } }] }
  };
}

export function validate(body) {
  const r = validatePoeRecord(body);
  return r.valid ? { ok: true, info: r.info || [], warnings: r.warnings || [] } : { ok: false, issues: r.issues };
}
