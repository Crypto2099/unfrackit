// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseManifest, MANIFEST_FORMAT } from '../src/manifest.mjs';
import { hashItems, documentChecks, textFormProblems } from '../src/hashing.mjs';
import { tempDir } from './helpers.mjs';

const PUB = 'ab'.repeat(32);
const DOI = '10.5281/zenodo.12345678';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function setup({ doc, files = { 'a.mjs': 'one\n', 'b.mjs': 'two\n' }, extra = {} } = {}) {
  const dir = tempDir();
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
  const lines = Object.entries(files).map(([n, c]) => `${sha(c)}  ${n}`);
  fs.writeFileSync(path.join(dir, 'doc.md'), doc ?? `# Doc\n\nDOI: ${DOI}\nkey: ${PUB}\n\n${lines.join('\n')}\n`);
  const raw = {
    format: MANIFEST_FORMAT,
    kind: 'freeze',
    doi: DOI,
    items: [
      { path: 'doc.md', type: 'StudyRegistration', document: true, ids: [{ id: DOI, id_type: 'DOI', relation: 'IsPartOf' }] },
      ...Object.keys(files).map((n) => ({ path: n, type: 'Software' }))
    ],
    ...extra
  };
  const manifest = parseManifest(raw, dir);
  return { dir, manifest, raw };
}

test('hashing is SHA-256 over the exact file bytes', () => {
  const { manifest } = setup();
  const h = hashItems(manifest);
  assert.equal(h[1].hex, sha('one\n'));
  assert.equal(h[1].size, 4);
});

test('text items: a byte-order mark, a carriage return or invalid UTF-8 is refused; a binary item is hashed as is', () => {
  assert.deepEqual(textFormProblems(Buffer.from('fine\n')), []);
  assert.match(textFormProblems(Buffer.from('﻿text\n')).join(), /byte-order mark/);
  assert.match(textFormProblems(Buffer.from('a\r\nb\n')).join(), /carriage return/);
  assert.match(textFormProblems(Buffer.from([0x66, 0xff, 0x0a])).join(), /not valid UTF-8/);
  const { manifest } = setup({ files: { 'a.mjs': 'one\r\n' } });
  assert.throws(() => hashItems(manifest), /carriage return/);
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0xff, 0x0d, 0x00]));
  const m = parseManifest({ format: MANIFEST_FORMAT, kind: 'scripts', items: [{ path: 'blob.bin', type: 'Dataset', binary: true, message: true }], related: [{ uri: `web+cardano://transaction/${'f1'.repeat(32)}/metadata/309`, relation: 'IsSupplementTo' }] }, dir);
  assert.equal(hashItems(m)[0].hex, crypto.createHash('sha256').update(Buffer.from([0xff, 0x0d, 0x00])).digest('hex'));
});

test('document checks pass when the hash table, key and DOI are right', () => {
  const { manifest } = setup();
  const r = documentChecks(manifest, hashItems(manifest), PUB);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.hashLines, 2);
});

test('document checks fail on a wrong digest, a missing or repeated item, a self-listing, or a missing key or DOI', () => {
  const lines = (a, b) => `${a}  a.mjs\n${b}  b.mjs\n`;
  const cases = [
    [`DOI ${DOI} ${PUB}\n${lines(sha('one\n'), sha('other\n'))}`, /the file's SHA-256 is/],
    [`DOI ${DOI} ${PUB}\n${sha('one\n')}  a.mjs\n`, /b\.mjs appears 0 times/],
    [`DOI ${DOI} ${PUB}\n${lines(sha('one\n'), sha('two\n'))}${sha('two\n')}  b.mjs\n`, /b\.mjs appears 2 times/],
    [`DOI ${DOI} ${PUB}\n${lines(sha('one\n'), sha('two\n'))}${'00'.repeat(32)}  doc.md\n`, /cannot list its own hash/],
    [`DOI ${DOI}\n${lines(sha('one\n'), sha('two\n'))}`, /signing public key/],
    [`${PUB}\n${lines(sha('one\n'), sha('two\n'))}`, /does not carry the DOI/],
    [`DOI ${DOI} ${PUB}\n${sha('one\n').toUpperCase()}  a.mjs\n${sha('two\n')}  b.mjs\n`, /exact form/],
    [`DOI ${DOI} ${PUB}\n${lines(sha('one\n'), sha('two\n'))}${sha('x')}  c.mjs\n`, /not an item of the manifest/]
  ];
  for (const [doc, re] of cases) {
    const { manifest } = setup({ doc });
    const r = documentChecks(manifest, hashItems(manifest), PUB);
    assert.equal(r.ok, false, String(re));
    assert.match(r.errors.join('\n'), re);
  }
});

test('manifest rules: kinds, the document, DOIs, supersedes and related', () => {
  const { raw, dir } = setup();
  const bad = (patch, re) => assert.throws(() => parseManifest({ ...raw, ...patch }, dir), re);
  bad({ format: 'x' }, /format/);
  bad({ kind: 'other' }, /kind/);
  bad({ doi: '10.5281/ZENODO.1' }, /lowercase/);
  bad({ doi: 'https://doi.org/10.5281/zenodo.1' }, /bare DOI/);
  bad({ supersedes: 'ab'.repeat(32) }, /carries no supersedes/);
  bad({ related: [{ uri: `web+cardano://transaction/${'ab'.repeat(32)}/metadata/309`, relation: 'IsSupplementTo' }] }, /no research-related/);
  bad({ items: raw.items.map((x) => ({ ...x, document: false })) }, /exactly one item as the document/);
  bad({ items: [{ ...raw.items[0], type: 'Registration' }, ...raw.items.slice(1)] }, /resourceTypeGeneral/);
  bad({ items: [{ ...raw.items[0], ids: [{ id: DOI, id_type: 'DOI', relation: 'PartOf' }] }, ...raw.items.slice(1)] }, /relationType/);
  bad({ items: [{ ...raw.items[0], ids: [{ id: DOI, id_type: 'DOI', relation: 'IsPartOf', note: 'x' }] }, ...raw.items.slice(1)] }, /unknown field/);
  bad({ items: [raw.items[0], raw.items[1], { ...raw.items[1] }] }, /share the file name/);
  bad({ items: [{ ...raw.items[0], ids: [{ id: '10.5281/zenodo.99', id_type: 'DOI', relation: 'IsPartOf' }] }, ...raw.items.slice(1)] }, /must carry the manifest DOI/);
  assert.throws(() => parseManifest({ ...raw, kind: 'retype' }, dir), /needs "supersedes"/);
  assert.throws(() => parseManifest({ format: MANIFEST_FORMAT, kind: 'scripts', items: [{ path: 'a.mjs', type: 'Software', message: true }] }, dir), /relates to the freeze/);
  assert.throws(() => parseManifest({ format: MANIFEST_FORMAT, kind: 'scripts', items: [{ path: 'a.mjs', type: 'Software' }], related: [{ uri: `web+cardano://transaction/${'ab'.repeat(32)}/metadata/309`, relation: 'IsSupplementTo' }] }, dir), /flagged "message"/);
  const ok = parseManifest(raw, dir);
  assert.deepEqual(ok.messageItems, [0]);
});

test('the DOI must appear as a whole token: a DOI with one digit dropped does not match a longer one', async () => {
  const { mentionsDoi, mentionsHexToken } = await import('../src/hashing.mjs');
  assert.ok(mentionsDoi('DOI of this document: 10.5281/zenodo.17000001\n', '10.5281/zenodo.17000001'));
  assert.ok(mentionsDoi('(https://doi.org/10.5281/zenodo.1700000).', '10.5281/zenodo.1700000'));
  assert.ok(mentionsDoi('doi:10.5281/zenodo.1700000, then', '10.5281/zenodo.1700000'));
  assert.ok(mentionsDoi('ends with 10.5281/zenodo.1700000.', '10.5281/zenodo.1700000'));
  assert.ok(!mentionsDoi('DOI of this document: 10.5281/zenodo.17000001\n', '10.5281/zenodo.1700000'));
  assert.ok(!mentionsDoi('see 10.5281/zenodo.1700000.5 and', '10.5281/zenodo.1700000'));
  assert.ok(!mentionsDoi('x110.5281/zenodo.1700000', '10.5281/zenodo.1700000'));
  assert.ok(!mentionsDoi('10.5281/zenodo.1700000-v2', '10.5281/zenodo.1700000'));
  assert.ok(mentionsHexToken(`key: ${PUB}\n`, PUB));
  assert.ok(!mentionsHexToken(`key: ${PUB}0\n`, PUB));
  assert.ok(!mentionsHexToken(`key: f${PUB}\n`, PUB));
  const short = '10.5281/zenodo.1234567';
  const files = { 'a.mjs': 'one\n' };
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.mjs'), files['a.mjs']);
  fs.writeFileSync(path.join(dir, 'doc.md'), `DOI of this document: ${short}8\nkey ${PUB}\n${sha('one\n')}  a.mjs\n`);
  const m = parseManifest({ format: MANIFEST_FORMAT, kind: 'freeze', doi: short, items: [{ path: 'doc.md', type: 'StudyRegistration', document: true, ids: [{ id: short, id_type: 'DOI', relation: 'IsPartOf' }] }, { path: 'a.mjs', type: 'Software' }] }, dir);
  const r = documentChecks(m, hashItems(m), PUB);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /does not carry the DOI 10\.5281\/zenodo\.1234567 as a whole token/);
});

test('relation Other needs relation_info, in research-items identifiers and research-related entries', () => {
  const { raw, dir } = setup();
  const otherId = { ...raw.items[0], ids: [{ id: DOI, id_type: 'DOI', relation: 'IsPartOf' }, { id: 'https://example.org/x', id_type: 'URL', relation: 'Other' }] };
  assert.throws(() => parseManifest({ ...raw, items: [otherId, ...raw.items.slice(1)] }, dir), /Other, which needs relation_info/);
  otherId.ids[1].relation_info = 'archived copy';
  assert.doesNotThrow(() => parseManifest({ ...raw, items: [otherId, ...raw.items.slice(1)] }, dir));
  const uri = `web+cardano://transaction/${'ab'.repeat(32)}/metadata/309`;
  const scripts = { format: MANIFEST_FORMAT, kind: 'scripts', items: [{ path: 'a.mjs', type: 'Software', message: true }] };
  assert.throws(() => parseManifest({ ...scripts, related: [{ uri, relation: 'Other' }] }, dir), /Other, which needs relation_info/);
  assert.doesNotThrow(() => parseManifest({ ...scripts, related: [{ uri, relation: 'Other', relation_info: 'shares the sample' }] }, dir));
});

test('an amendment runs the document checks, and one that amends a study registration needs its DOI', async () => {
  const { hashManifest } = await import('../src/build.mjs');
  const { raw, dir } = setup();
  const amend = { ...raw, kind: 'amend', supersedes: 'ab'.repeat(32) };
  // A stale hash row in the amended document is caught, as for a freeze.
  fs.writeFileSync(path.join(dir, 'b.mjs'), 'two, changed\n');
  const mpath = path.join(dir, 'amend.json');
  fs.writeFileSync(mpath, JSON.stringify(amend));
  const r = hashManifest({ manifestPath: mpath, signingPublicKeyHex: PUB });
  assert.equal(r.doc.ok, false);
  assert.match(r.doc.errors.join('\n'), /b\.mjs, the file's SHA-256 is/);
  const missingKey = hashManifest({ manifestPath: mpath, signingPublicKeyHex: 'cd'.repeat(32) });
  assert.match(missingKey.doc.errors.join('\n'), /signing public key/);
  const { doi: _doi, ...noDoi } = amend;
  assert.throws(() => parseManifest(noDoi, dir), /StudyRegistration needs the new version's DOI/);
  const textDoc = { ...noDoi, items: [{ ...raw.items[0], type: 'Text', ids: undefined }, ...raw.items.slice(1)] };
  assert.doesNotThrow(() => parseManifest(textDoc, dir), 'an amendment of a Text document needs no DOI');
});
