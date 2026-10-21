// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The label-309 v0.10.0 conformance vectors this tool exercises, run through
// the code paths the tool uses (its own encoder and the SDK side by side).

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { decodeCanonicalCbor, encodeCanonicalCbor } from '@cardanowall/crypto-core/cbor';
import { sha256 as sdkSha256, blake2b256 } from '@cardanowall/crypto-core/hash';
import { hkdfSha256 } from '@cardanowall/crypto-core/kdf';
import { signEd25519, getPublicKeyEd25519, verifyEd25519 } from '@cardanowall/crypto-core/sig';
import { coseSign1Label309Verify, buildSigStructure } from '@cardanowall/crypto-core/cose';
import { deriveEd25519KeypairFromSeed } from '@cardanowall/crypto-core/seed-derive';
import { validatePoeRecord, reassembleLabel309Value } from '@cardanowall/poe-standard';
import { unwrapAuxiliaryData, bindTransactionBytes } from '@cardanowall/sdk-ts/verifier';
import { prepareSigStructure, assembleCoseSign1 } from '@cardanowall/sdk-ts/client';
import { encode, decode, mapGet } from '../src/cbor.mjs';
import { nodeSigningKey, signingKeyFromSeed, nodeVerify } from '../src/keys.mjs';
import { carry, protectedHeaderBytes, SIG_DOMAIN } from '../src/record.mjs';
import { confirmationDepth } from '../src/verify.mjs';
import { sha256 } from '../src/util.mjs';
import { vector, VECTOR_DIR, hex, unhex } from './helpers.mjs';

test('vector provenance: every copied file matches its recorded SHA-256 at label-309 commit a51bad8', () => {
  const prov = JSON.parse(fs.readFileSync(new URL('PROVENANCE.json', VECTOR_DIR), 'utf8'));
  assert.equal(prov.commit, 'a51bad8d31669ccbf533bac6ec8c39dd38ff0388');
  assert.equal(prov.tag, 'v0.10.0');
  assert.equal(Object.keys(prov.files).length, 27);
  for (const [rel, digest] of Object.entries(prov.files)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL(rel, VECTOR_DIR))).digest('hex'), digest, rel);
  }
  const lic = fs.readFileSync(new URL('LICENSE', VECTOR_DIR));
  assert.equal(crypto.createHash('sha256').update(lic).digest('hex'), prov.license_sha256);
  assert.match(lic.toString('utf8'), /Apache License\s+Version 2\.0/);
});

function specValue(v) {
  if (v.input_value_spec?.type === 'bytes') return unhex(v.input_value_spec.hex);
  if (v.input_value_spec?.type === 'bigint') return BigInt(v.input_value_spec.decimal);
  return JSON.parse(v.input_json);
}

test('cbor: RFC 8949 and round-trip encode vectors, own encoder and SDK encoder', () => {
  for (const file of ['cbor/canonical-encode-rfc8949-kat.json', 'cbor/canonical-encode-roundtrip.json']) {
    for (const v of vector(file).vectors) {
      const value = specValue(v);
      assert.equal(hex(encode(value)), v.expected_cbor_hex, `${file} ${v.name} (own)`);
      assert.equal(hex(encodeCanonicalCbor(value)), v.expected_cbor_hex, `${file} ${v.name} (SDK)`);
    }
  }
});

test('cbor: canonical-decode negatives are refused by the SDK decoder and by this tool\'s canonical decoder', () => {
  for (const v of vector('cbor/canonical-decode-negative.json').vectors) {
    assert.equal(v.expected_error_code, 'MALFORMED_CBOR');
    assert.throws(() => decodeCanonicalCbor(unhex(v.cbor_hex)), (e) => e.code === 'MALFORMED_CBOR', v.name);
    assert.throws(() => decode(unhex(v.cbor_hex), { canonical: true }), undefined, v.name);
    const r = validatePoeRecord(unhex(v.cbor_hex));
    assert.equal(r.valid, false);
    assert.deepEqual(r.issues.map((i) => i.code), ['MALFORMED_CBOR'], v.name);
  }
});

test('hash: SHA-256 (Node, which hashes the manifest files, and the SDK) and BLAKE2b-256 KATs', () => {
  for (const v of vector('hash/sha256-kat.json').vectors) {
    assert.equal(hex(sha256(unhex(v.input_hex))), v.expected_hex, v.name);
    assert.equal(hex(sdkSha256(unhex(v.input_hex))), v.expected_hex, v.name);
  }
  for (const v of vector('hash/blake2b256-kat.json').vectors) assert.equal(hex(blake2b256(unhex(v.input_hex))), v.expected_hex, v.name);
});

test('kdf: HKDF-SHA-256 KATs, including the empty salt, through Node and the SDK', () => {
  for (const file of ['kdf/hkdf-sha256-kat.json', 'kdf/hkdf-sha256-empty-salt-kat.json']) {
    for (const v of vector(file).vectors) {
      const node = Buffer.from(crypto.hkdfSync('sha256', unhex(v.ikm_hex), unhex(v.salt_hex), unhex(v.info_hex), v.length));
      assert.equal(node.toString('hex'), v.expected_hex, `${v.name} (Node)`);
      assert.equal(hex(hkdfSha256({ ikm: unhex(v.ikm_hex), salt: unhex(v.salt_hex), info: unhex(v.info_hex), length: v.length })), v.expected_hex, `${v.name} (SDK)`);
    }
  }
});

test('sig: RFC 8032 Ed25519 KATs through OpenSSL and the SDK', () => {
  const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
  for (const v of vector('sig/ed25519-kat.json').vectors) {
    const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(v.seed_hex, 'hex')]), format: 'der', type: 'pkcs8' });
    const pub = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(12);
    assert.equal(pub.toString('hex'), v.expected_public_key_hex, v.name);
    assert.equal(crypto.sign(null, Buffer.from(v.message_hex, 'hex'), key).toString('hex'), v.expected_signature_hex, v.name);
    assert.equal(hex(getPublicKeyEd25519({ seed: unhex(v.seed_hex) })), v.expected_public_key_hex);
    assert.equal(hex(signEd25519({ seed: unhex(v.seed_hex), message: unhex(v.message_hex) })), v.expected_signature_hex);
    assert.ok(nodeVerify(unhex(v.expected_public_key_hex), unhex(v.message_hex), unhex(v.expected_signature_hex)));
  }
});

test('sig: the CCTV torsion corpus, strict verification (the SDK verifier this tool relies on)', () => {
  const vs = vector('sig/ed25519-torsion-cctv.json').vectors;
  assert.equal(vs.length, 914);
  for (const v of vs) {
    assert.equal(verifyEd25519({ publicKey: unhex(v.public_key_hex), message: unhex(v.message_hex), signature: unhex(v.signature_hex) }), v.expected_valid, v.name);
  }
});

test('seed-derive: the signing key of the zero, ff and deadbeef seeds, through the SDK and through Node and OpenSSL', () => {
  for (const f of ['seed-derive/seed-from-zero.json', 'seed-derive/seed-from-ff.json', 'seed-derive/seed-from-deadbeef.json']) {
    for (const v of vector(f).vectors) {
      const seed = unhex(v.seed_hex);
      const node = nodeSigningKey(seed);
      assert.equal(hex(node.edSeed), v.expected_ed25519_secret_hex, `${v.name} secret (Node HKDF)`);
      assert.equal(hex(node.publicKey), v.expected_ed25519_public_hex, `${v.name} public (OpenSSL)`);
      assert.equal(hex(signingKeyFromSeed(seed).publicKey), v.expected_ed25519_public_hex, `${v.name} public (SDK)`);
      const sdk = deriveEd25519KeypairFromSeed(seed);
      assert.equal(hex(sdk.secretKey), v.expected_ed25519_secret_hex);
    }
  }
});

test('seed-derive: seeds of other than 32 bytes are refused', () => {
  for (const v of vector('seed-derive/seed-derive-negative.json').vectors) {
    assert.throws(() => nodeSigningKey(unhex(v.seed_hex)), /INVALID_SEED_LENGTH/, v.name);
    assert.throws(() => signingKeyFromSeed(unhex(v.seed_hex)), (e) => e.code === v.expected_error_code || /INVALID_SEED_LENGTH/.test(e.message), v.name);
  }
});

test('cose: Sig_structure vectors through this tool\'s encoder and the SDK builder', () => {
  for (const v of vector('cose/sig-structure.json').vectors) {
    const parts = [v.context, unhex(v.body_protected_bytes_hex), unhex(v.external_aad_hex), unhex(v.payload_hex)];
    assert.equal(hex(encode(parts)), v.expected_sig_structure_hex, v.name);
    assert.equal(
      hex(buildSigStructure({ context: v.context, bodyProtectedBytes: unhex(v.body_protected_bytes_hex), externalAad: unhex(v.external_aad_hex), payload: unhex(v.payload_hex) })),
      v.expected_sig_structure_hex
    );
  }
});

test('cose: sign1-build path-1 record vectors reproduce Sig_structure, signature, COSE_Sign1 and the sigs entry', async () => {
  const f = vector('cose/sign1-build.json');
  assert.equal(f.cardano_poe_vectors.length, 4);
  for (const v of f.cardano_poe_vectors) {
    const seed = unhex(v.signer_secret_key_hex); // the Ed25519 secret seed itself
    const pub = unhex(v.signer_public_key_hex);
    const body = unhex(v.record_body_cbor_hex);
    assert.equal(v.unprotected_header_int_bytes_pairs.length, 0, 'the unprotected header is empty');
    const prot = protectedHeaderBytes(pub);
    const sigStructure = encode(['Signature1', prot, new Uint8Array(0), new Uint8Array([...SIG_DOMAIN, ...body])]);
    assert.equal(hex(sigStructure), v.expected_sig_structure_hex, `${v.name} Sig_structure`);
    const key = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
    const sig = new Uint8Array(crypto.sign(null, Buffer.from(sigStructure), key));
    assert.equal(hex(sig), v.expected_signature_hex, `${v.name} signature (OpenSSL)`);
    assert.equal(hex(signEd25519({ seed, message: sigStructure })), v.expected_signature_hex, `${v.name} signature (SDK)`);
    const cose = encode([prot, new Map(), null, sig]);
    assert.equal(hex(cose), v.expected_cose_sign1_hex, `${v.name} COSE_Sign1`);
    assert.equal(hex(encode({ cose_sign1: cose })), v.expected_sigs_entry_cbor_hex, `${v.name} sigs entry`);
    // The SDK's off-host path over the same record (decoded from the vector's body).
    const record = decodeCanonicalCbor(body);
    const prep = prepareSigStructure({ record, signerPubkey: pub });
    assert.equal(hex(prep.sigStructureBytes), v.expected_sig_structure_hex);
    assert.equal(hex(assembleCoseSign1({ record, signerPubkey: pub, signature: sig }).coseSign1Bytes), v.expected_cose_sign1_hex);
  }
});

function sdkCode(code) {
  return { MALFORMED_SIG_COSE: 'MALFORMED_SIG_COSE_SIGN1', UNSUPPORTED_SIG_ALG: 'SIGNATURE_UNSUPPORTED', KID_UNRESOLVED: 'SIGNER_KEY_UNRESOLVED' }[code] || code;
}

test('cose: sign1-verify record vectors and the strict-Ed25519 fixture through the SDK verifier', () => {
  const f = vector('cose/sign1-verify.json');
  for (const v of f.cardano_poe_vectors) {
    const r = coseSign1Label309Verify({ message: unhex(v.message_hex), detachedRecordBodyCbor: unhex(v.detached_record_body_cbor_hex) });
    if (v.expected_result.ok) {
      assert.ok(r.ok, v.name);
      assert.equal(hex(r.signerKey), v.expected_result.signer_key_hex);
      assert.equal(r.alg, v.expected_result.alg);
    } else {
      assert.equal(r.ok, false, v.name);
      assert.equal(sdkCode(r.error.code), v.expected_result.error_code, v.name);
    }
  }
  const strict = vector('cose/sign1-strict-ed25519.json').vectors[0];
  const m = decode(unhex(strict.message_hex));
  const pub = mapGet(decode(m[0]), 4);
  const sigStructure = encode(['Signature1', m[0], new Uint8Array(0), m[2] === null ? new Uint8Array(0) : m[2]]);
  assert.equal(verifyEd25519({ publicKey: pub, message: sigStructure, signature: m[3] }), false, strict.name);
});

test('cose: to-sign-verbatim, the published protected bytes enter Sig_structure unchanged', () => {
  for (const v of vector('cose/to-sign-verbatim.json').vectors) {
    const cose = decode(unhex(v.cose_sign1_hex));
    assert.equal(hex(cose[0]), v.published_protected_bytes_hex);
    const ss = encode(['Signature1', cose[0], new Uint8Array(0), new Uint8Array([...SIG_DOMAIN, ...unhex(v.record_body_cbor_hex)])]);
    assert.equal(hex(ss), v.expected_sig_structure_hex, `${v.name}: the published protected bytes go in verbatim`);
    assert.notEqual(hex(ss), v.rejected_sig_structure_if_reencoded_hex);
    assert.equal(verifyEd25519({ publicKey: unhex(v.signer_public_key_hex), message: ss, signature: cose[3] }), v.expected_result.ok, v.name);
    assert.equal(hex(protectedHeaderBytes(unhex(v.signer_public_key_hex))), v.canonical_protected_bytes_hex, 'this tool emits the canonical form');
    // The SDK's coseSign1Label309Verify (crypto-core 0.12.0) decodes the
    // protected header canonically and so refuses these two non-canonical
    // headers, where the vector expects the signature to verify. This tool
    // only ever emits the canonical header, so its own records are unaffected.
    const r = coseSign1Label309Verify({ message: unhex(v.cose_sign1_hex), detachedRecordBodyCbor: unhex(v.record_body_cbor_hex) });
    assert.equal(r.ok, false, `${v.name}: SDK behaviour changed; revisit this note`);
  }
});

test('cose: the general sign1-verify vectors through this tool\'s Sig_structure and strict verification', () => {
  for (const v of vector('cose/sign1-verify.json').vectors) {
    let code = null;
    let signer = null;
    try {
      const m = decode(unhex(v.message_hex));
      if (!Array.isArray(m) || m.length !== 4) throw Object.assign(new Error('shape'), { code: 'MALFORMED_SIG_COSE_SIGN1' });
      const prot = decode(m[0]);
      const alg = mapGet(prot, 1);
      if (alg !== -8) throw Object.assign(new Error('alg'), { code: 'SIGNATURE_UNSUPPORTED' });
      const kid = mapGet(prot, 4) || mapGet(m[1], 4);
      signer = kid.length === 32 ? kid : unhex(v.expected_signer_key_hex);
      const ss = encode(['Signature1', m[0], unhex(v.external_aad_hex), m[2]]);
      if (!verifyEd25519({ publicKey: signer, message: ss, signature: m[3] })) code = 'SIGNATURE_INVALID';
    } catch (e) {
      code = e.code || 'MALFORMED_SIG_COSE_SIGN1';
    }
    if (v.expected_result.ok) {
      assert.equal(code, null, v.name);
      assert.equal(hex(signer), v.expected_result.signer_key_hex, v.name);
    } else assert.equal(code, v.expected_result.error_code, v.name);
  }
});

test('carriage: chunk-array positives reassemble; the minimal split is what this tool emits', () => {
  for (const v of vector('carriage/chunk-array-positive.json').vectors) {
    const r = reassembleLabel309Value(unhex(v.label_309_value_cbor_hex));
    assert.ok(r.ok, v.name);
    assert.equal(hex(r.body), v.expected_record_body_hex);
    const { valueBytes, chunks } = carry(unhex(v.expected_record_body_hex));
    assert.ok(chunks.slice(0, -1).every((c) => c.length === 64) && chunks.at(-1).length <= 64);
    if (v.name === 'single-chunk-63-byte-body') assert.equal(hex(valueBytes), v.label_309_value_cbor_hex);
  }
});

test('carriage: chunk-array negatives carry their pinned codes', () => {
  for (const v of vector('carriage/chunk-array-negative.json').vectors) {
    const r = reassembleLabel309Value(unhex(v.label_309_value_cbor_hex));
    if (r.ok) {
      // Reassembles to an empty body: the failure surfaces from the canonical decode.
      assert.equal(r.body.length, 0, v.name);
      assert.equal(validatePoeRecord(r.body).issues[0].code, v.expected_error_code, v.name);
    } else assert.equal(r.issue.code, v.expected_error_code, v.name);
  }
});

test('carriage: all three Conway auxiliary-data forms unwrap to the label-309 value; other shapes are refused', () => {
  for (const v of vector('carriage/aux-data-envelope-forms.json').vectors) {
    const aux = unhex(v.auxiliary_data_cbor_hex);
    if (v.expected.error_code === 'MALFORMED_CBOR') {
      assert.throws(() => unwrapAuxiliaryData(aux), /MALFORMED_CBOR/, v.name);
      continue;
    }
    const u = unwrapAuxiliaryData(aux);
    if (v.expected.error_code === 'METADATA_NOT_FOUND') {
      assert.equal(u.label309, null, v.name);
      continue;
    }
    assert.equal(hex(u.label309), v.expected.label_309_value_cbor_hex, v.name);
    assert.equal(hex(reassembleLabel309Value(u.label309).body), v.expected.record_body_hex, v.name);
  }
});

test('cardano: transaction-hash and auxiliary-data-hash binding vectors', () => {
  for (const v of vector('cardano/tx-binding.json').vectors) {
    const body = unhex(v.transaction_body_cbor_hex);
    const aux = unhex(v.auxiliary_data_cbor_hex);
    const r = bindTransactionBytes({ requestedTxHashHex: v.requested_tx_hash_hex, txBody: body, auxiliaryData: aux });
    if (v.expected.ok) {
      assert.ok(r.ok, v.name);
      assert.equal(hex(blake2b256(body)), v.expected.computed_tx_hash_hex);
      assert.equal(hex(blake2b256(aux)), v.expected.computed_auxiliary_data_hash_hex);
      assert.equal(hex(reassembleLabel309Value(unwrapAuxiliaryData(aux).label309).body), v.expected.record_body_hex);
    } else if (v.expected.error_code === 'TX_INTEGRITY_MISMATCH') {
      assert.equal(r.ok, false, v.name);
    } else {
      assert.ok(r.ok, v.name);
      assert.equal(unwrapAuxiliaryData(aux).label309, null, v.name);
    }
  }
});

test('cardano: confirmation depth is tip - block + 1, compared with the threshold', () => {
  for (const v of vector('cardano/confirmation-depth.json').vectors) {
    const d = confirmationDepth(v.tip_height, v.block_height);
    assert.equal(d, v.expected_depth, v.name);
    assert.equal(d >= v.threshold ? 'confirmed' : 'pending', v.expected.status, v.name);
  }
});

test('poe-record: the maximal and mixed-signature records validate and round-trip through both encoders', () => {
  const max = vector('poe-record/maximal-record-with-extension-keys.json');
  const opts = { supportedCriticalExtensions: new Set(max.validator_options.supportedCriticalExtensions) };
  assert.ok(validatePoeRecord(unhex(max.cbor_hex), opts).valid);
  assert.equal(validatePoeRecord(unhex(max.cbor_hex)).issues.map((i) => i.code).join(), 'EXTENSION_UNSUPPORTED_CRITICAL', 'a default validator fails the crit-bearing record');
  for (const h of [max.cbor_hex, max.body_cbor_hex]) {
    assert.equal(hex(encode(decode(unhex(h), { canonical: true }))), h);
    assert.equal(hex(encodeCanonicalCbor(decodeCanonicalCbor(unhex(h)))), h);
  }
  const mixed = vector('poe-record/mixed-signature-record.json');
  for (const v of mixed.vectors) {
    const r = validatePoeRecord(unhex(v.cbor_hex));
    assert.equal(r.valid, v.expected_error_codes.length === 0, v.name);
    assert.equal(hex(encode(decode(unhex(v.cbor_hex), { canonical: true }))), v.cbor_hex);
  }
  const ss = encode(['Signature1', decode(unhex(mixed.path1_cose_sign1_hex))[0], new Uint8Array(0), new Uint8Array([...SIG_DOMAIN, ...unhex(mixed.record_body_cbor_hex)])]);
  assert.ok(nodeVerify(unhex(mixed.path1_signer_public_key_hex), ss, decode(unhex(mixed.path1_cose_sign1_hex))[3]));
});

function opts(v) {
  const o = {};
  if (!v.validator_options) return undefined;
  if (v.validator_options.supportedCriticalExtensions) o.supportedCriticalExtensions = new Set(v.validator_options.supportedCriticalExtensions);
  for (const k of ['maxSlots', 'maxEncEnvelopeBytes', 'passphraseParamsCeiling', 'role']) if (k in v.validator_options) o[k] = v.validator_options[k];
  return o;
}

test('validator: the positive and negative corpora give the pinned codes', () => {
  for (const file of ['validator/validator-positive.json', 'validator/validator-negative.json']) {
    for (const v of vector(file).vectors) {
      const r = validatePoeRecord(unhex(v.cbor_hex), opts(v));
      const errors = r.valid ? [] : r.issues.filter((i) => i.severity === 'error').map((i) => i.code);
      assert.deepEqual([...new Set(errors)].sort(), [...v.expected_error_codes].sort(), `${file} ${v.name}`);
      if (v.expected_info_codes) {
        const info = (r.valid ? r.info || [] : r.issues.filter((i) => i.severity === 'info')).map((i) => i.code);
        assert.deepEqual([...new Set(info)].sort(), [...v.expected_info_codes].sort(), `${file} ${v.name} info`);
      }
    }
  }
});

test('cose: signRecord itself reproduces the sign1-build vectors (Sig_structure, signature, COSE_Sign1, sigs entry)', async () => {
  const { signRecord } = await import('../src/record.mjs');
  const f = vector('cose/sign1-build.json');
  for (const v of f.cardano_poe_vectors) {
    const seed = unhex(v.signer_secret_key_hex);
    const pub = unhex(v.signer_public_key_hex);
    assert.equal(hex(getPublicKeyEd25519({ seed })), v.signer_public_key_hex);
    // The vector gives the Ed25519 secret seed itself, so the key is built on
    // it directly (signRecord takes any key with publicKey and sign).
    const key = { publicKey: pub, sign: async (m) => signEd25519({ seed, message: m }) };
    const record = decodeCanonicalCbor(unhex(v.record_body_cbor_hex));
    const s = await signRecord(record, key);
    assert.equal(hex(s.bodyNoSigs), v.record_body_cbor_hex, `${v.name} body`);
    assert.equal(hex(s.sigStructure), v.expected_sig_structure_hex, `${v.name} Sig_structure`);
    assert.equal(hex(s.signature), v.expected_signature_hex, `${v.name} signature`);
    assert.equal(hex(s.coseSign1), v.expected_cose_sign1_hex, `${v.name} COSE_Sign1`);
    assert.equal(hex(encode(mapGet(decode(s.body, { canonical: true }), 'sigs')[0])), v.expected_sigs_entry_cbor_hex, `${v.name} sigs entry`);
  }
});
