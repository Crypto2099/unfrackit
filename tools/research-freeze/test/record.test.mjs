// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCanonicalCbor, decodeCanonicalCbor } from '@cardanowall/crypto-core/cbor';
import { encodePoeRecord, validatePoeRecord } from '@cardanowall/poe-standard';
import { coseSign1Label309Verify } from '@cardanowall/crypto-core/cose';
import { encode, decode, mapGet } from '../src/cbor.mjs';
import { buildRecord, signRecord, topLevelKeys, carry, messageLines, expectedAuxiliaryBytes, detailedMetadataJson } from '../src/record.mjs';
import { signingKeyFromSeed } from '../src/keys.mjs';
import { parseManifest, recordUri, MANIFEST_FORMAT } from '../src/manifest.mjs';
import { hex, unhex } from './helpers.mjs';

const d = (n) => new Uint8Array(32).fill(n);
const item = (n, type, ids) => ({ digest: d(n), hex: hex(d(n)), name: `f${n}`, type, ids });
const TX_A = 'f1'.repeat(32);
const TX_B = 'f2'.repeat(32);

function freezeItems() {
  return [
    item(0x01, 'StudyRegistration', [{ id: '10.5281/zenodo.00000000', id_type: 'DOI', relation: 'IsPartOf' }]),
    item(0x02, 'Text'),
    ...[0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18].map((n) => item(n, 'Software'))
  ];
}

const KINDS = {
  freeze: { hashed: freezeItems() },
  scripts: { hashed: [item(0x21, 'Software'), item(0x22, 'Software'), item(0x23, 'Software')], related: [{ uri: recordUri(TX_A), relation: 'IsSupplementTo' }] },
  results: { hashed: [item(0x31, 'Dataset'), item(0x32, 'Text')], related: [{ uri: recordUri(TX_A), relation: 'IsDerivedFrom' }, { uri: recordUri(TX_B), relation: 'IsDerivedFrom' }] },
  retype: {
    hashed: freezeItems().map((h) => (h.digest[0] === 1 ? { ...h, ids: [...h.ids, { id: '10.17605/osf.io/abcde', id_type: 'DOI', relation: 'IsPartOf' }] } : h)),
    supersedes: TX_A
  },
  amend: { hashed: [item(0x41, 'StudyRegistration', [{ id: '10.5281/zenodo.00000001', id_type: 'DOI', relation: 'IsPartOf' }])], supersedes: TX_A }
};

const EXPECTED_KEYS = {
  freeze: ['v', 'sigs', 'items', 'research-items'],
  scripts: ['v', 'sigs', 'items', 'research-items', 'research-related'],
  results: ['v', 'sigs', 'items', 'research-items', 'research-related'],
  retype: ['v', 'sigs', 'items', 'supersedes', 'research-items'],
  amend: ['v', 'sigs', 'items', 'supersedes', 'research-items']
};

const signer = signingKeyFromSeed(new Uint8Array(32).fill(0xde));

for (const [kind, spec] of Object.entries(KINDS)) {
  test(`record: ${kind} builds, signs, round-trips canonically and validates`, async () => {
    const record = buildRecord({ kind, ...spec });
    const s = await signRecord(record, signer);
    assert.deepEqual(topLevelKeys(s.body), EXPECTED_KEYS[kind]);
    assert.equal(hex(encode(decode(s.body, { canonical: true }))), hex(s.body), 'own decode and re-encode');
    assert.equal(hex(encodeCanonicalCbor(decodeCanonicalCbor(s.body))), hex(s.body), 'SDK decode and re-encode');
    const v = validatePoeRecord(s.body);
    assert.ok(v.valid, JSON.stringify(v.issues));
    assert.equal((v.info || []).length, 0);
    const r = coseSign1Label309Verify({ message: s.coseSign1, detachedRecordBodyCbor: s.bodyNoSigs });
    assert.ok(r.ok);
    // research-items keys are the item digests, sorted bytewise as canonical CBOR requires
    const ri = mapGet(decode(s.body, { canonical: true }), 'research-items');
    assert.deepEqual([...ri.keys()].map(hex), spec.hashed.map((h) => h.hex).sort());
    assert.ok(!topLevelKeys(s.body).includes('crit'));
  });
}

test('record: core-only drops research-items and nothing else', async () => {
  const typed = buildRecord({ kind: 'freeze', ...KINDS.freeze });
  const core = buildRecord({ kind: 'freeze', ...KINDS.freeze, coreOnly: true });
  assert.deepEqual(Object.keys(core), ['v', 'items']);
  const { 'research-items': _ri, ...rest } = typed;
  assert.equal(hex(encode(rest)), hex(encode(core)));
  const s = await signRecord(core, signer);
  assert.deepEqual(topLevelKeys(s.body), ['v', 'sigs', 'items']);
  assert.ok(validatePoeRecord(s.body).valid);
  assert.throws(() => buildRecord({ kind: 'retype', ...KINDS.retype, coreOnly: true }), /--core-only does not apply/);
});

test('record: a bytes-keyed research-items map encodes canonically whatever its insertion order', () => {
  const a = new Map([[d(2), { type: 'Text' }], [d(1), { type: 'Text' }]]);
  const b = new Map([[d(1), { type: 'Text' }], [d(2), { type: 'Text' }]]);
  const ra = { v: 1, items: [{ hashes: { 'sha2-256': d(1) } }, { hashes: { 'sha2-256': d(2) } }], 'research-items': a };
  const rb = { ...ra, 'research-items': b };
  assert.equal(hex(encodePoeRecord(ra)), hex(encodePoeRecord(rb)));
  assert.equal(hex(encode(ra)), hex(encodePoeRecord(rb)));
  const decoded = decodeCanonicalCbor(encodePoeRecord(ra));
  assert.ok(decoded['research-items'] instanceof Map);
  assert.ok(validatePoeRecord(encodePoeRecord(ra)).valid);
});

test('negative control: a research- key listed in crit fails with EXTENSION_UNSUPPORTED_CRITICAL', () => {
  const record = buildRecord({ kind: 'freeze', ...KINDS.freeze });
  const bad = encode({ ...record, crit: ['research-items'] });
  const v = validatePoeRecord(bad);
  assert.equal(v.valid, false);
  assert.deepEqual(v.issues.map((i) => i.code), ['EXTENSION_UNSUPPORTED_CRITICAL']);
});

test('negative control: a misspelled base key fails with SCHEMA_UNKNOWN_FIELD', () => {
  const record = buildRecord({ kind: 'freeze', ...KINDS.freeze });
  for (const typo of ['itemz', 'Sigs', 'supersedess']) {
    const v = validatePoeRecord(encode({ ...record, [typo]: 1 }));
    assert.equal(v.valid, false, typo);
    assert.deepEqual(v.issues.map((i) => i.code), ['SCHEMA_UNKNOWN_FIELD'], typo);
  }
});

test('negative control: an uppercase hex digit in a research-related URI is refused by the builder and the manifest', () => {
  const upper = `web+cardano://transaction/${'F1'.repeat(32)}/metadata/309`;
  assert.throws(() => buildRecord({ kind: 'scripts', hashed: KINDS.scripts.hashed, related: [{ uri: upper, relation: 'IsSupplementTo' }] }), /exactly/);
  for (const uri of [upper, `WEB+CARDANO://transaction/${TX_A}/metadata/309`, `web+cardano://transaction/${TX_A}/metadata/674`, `web+cardano://transaction/${TX_A}/metadata`, `web+cardano://transaction/self/metadata/309`]) {
    assert.throws(
      () => parseManifest({ format: MANIFEST_FORMAT, kind: 'scripts', items: [{ path: '/x/a.mjs', type: 'Software', message: true }], related: [{ uri, relation: 'IsSupplementTo' }] }, '/'),
      /must match/,
      uri
    );
  }
  assert.throws(() => recordUri('F1'.repeat(32)), /lowercase/);
});

test('record: duplicate digests are refused (research-items could not type them apart)', () => {
  assert.throws(() => buildRecord({ kind: 'freeze', hashed: [item(1, 'Text'), item(1, 'Text')] }), /same SHA-256/);
});

test('carriage and message: minimal chunk split, the 674 line, the expected auxiliary bytes and the detailed JSON', async () => {
  const s = await signRecord(buildRecord({ kind: 'freeze', ...KINDS.freeze }), signer);
  const { chunks, valueBytes } = carry(s.body);
  assert.equal(chunks.length, Math.ceil(s.body.length / 64));
  assert.ok(chunks.slice(0, -1).every((c) => c.length === 64));
  assert.equal(hex(Buffer.concat(chunks)), hex(s.body));
  assert.equal(valueBytes[0] >> 5, 4, 'a definite-length array');
  const lines = messageLines(KINDS.freeze.hashed, [0]);
  assert.deepEqual(lines, ['01'.repeat(32)]);
  const aux = expectedAuxiliaryBytes(chunks, lines);
  assert.equal(aux[0] >> 5, 5, 'an untagged map');
  const m = decode(aux);
  assert.deepEqual([...m.keys()], [309, 674]);
  const j = detailedMetadataJson(chunks, lines);
  assert.equal(j[309].list.length, chunks.length);
  assert.equal(j[674].map[0].v.list[0].string, lines[0]);
});

test('a short body still travels as a one-element chunk array', () => {
  const tiny = unhex('a2617601656974656d7381a166686173686573a168736861322d32353658201111111111111111111111111111111111111111111111111111111111111111');
  const { chunks, valueBytes } = carry(tiny);
  assert.equal(chunks.length, 1);
  assert.equal(hex(valueBytes).slice(0, 4), '8158');
});

test('record: each research-items typing sits under its own item\'s digest', async () => {
  const hashed = [
    item(0x05, 'StudyRegistration', [{ id: '10.5281/zenodo.00000000', id_type: 'DOI', relation: 'IsPartOf' }]),
    item(0x03, 'Text'),
    item(0x09, 'Dataset'),
    item(0x01, 'Software')
  ];
  const s = await signRecord(buildRecord({ kind: 'freeze', hashed }), signer);
  const ri = mapGet(decode(s.body, { canonical: true }), 'research-items');
  for (const h of hashed) {
    const typing = [...ri.entries()].find(([k]) => hex(k) === h.hex)[1];
    assert.equal(mapGet(typing, 'type'), h.type, h.name);
    const ids = mapGet(typing, 'ids');
    if (h.ids) assert.deepEqual(ids.map((x) => mapGet(x, 'id')), h.ids.map((x) => x.id), h.name);
    else assert.equal(ids, undefined, h.name);
  }
});
