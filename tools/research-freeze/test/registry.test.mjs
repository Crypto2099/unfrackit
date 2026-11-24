// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dataciteCheck, doiPath, ZenodoSandbox } from '../src/registry.mjs';
import { Store } from '../src/store.mjs';
import { tempHome, tempDir } from './helpers.mjs';

const TX = 'ab'.repeat(32);
const URI = `web+cardano://transaction/${TX}/metadata/309`;
const res = (status, body) => ({ status, ok: status < 300, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('DataCite: the DOI path is percent-encoded per segment', () => {
  assert.equal(doiPath('10.5281/zenodo.123'), '10.5281/zenodo.123');
  assert.equal(doiPath('10.1000/a b#c'), '10.1000/a%20b%23c');
});

test('DataCite: a resolvable DOI with the back-link, a wrong relation, an uppercase variant, and a 404', async () => {
  const body = (rel) => ({ data: { attributes: { types: { resourceTypeGeneral: 'StudyRegistration' }, url: 'https://zenodo.org/records/1', relatedIdentifiers: rel } } });
  const ok = await dataciteCheck({ doi: '10.5281/zenodo.1', txHash: TX, fetchImpl: async () => res(200, body([{ relatedIdentifier: URI, relatedIdentifierType: 'URL', relationType: 'IsSupplementedBy' }])) });
  assert.ok(ok.resolvable && ok.backLinkOk);
  assert.equal(ok.resourceTypeGeneral, 'StudyRegistration');
  const wrongRel = await dataciteCheck({ doi: '10.5281/zenodo.1', txHash: TX, fetchImpl: async () => res(200, body([{ relatedIdentifier: URI, relatedIdentifierType: 'URL', relationType: 'References' }])) });
  assert.equal(wrongRel.backLinkOk, false);
  assert.equal(wrongRel.backLinks.length, 1);
  const upper = await dataciteCheck({ doi: '10.5281/zenodo.1', txHash: TX, fetchImpl: async () => res(200, body([{ relatedIdentifier: URI.toUpperCase(), relatedIdentifierType: 'URL', relationType: 'IsSupplementedBy' }])) });
  assert.equal(upper.backLinks.length, 1, 'registry values are lowercased before matching');
  assert.equal(upper.backLinkOk, false, 'but the freeze check wants the URI byte for byte');
  const missing = await dataciteCheck({ doi: '10.5281/zenodo.2', txHash: TX, fetchImpl: async () => res(404, '{"errors":[{"status":"404"}]}') });
  assert.equal(missing.resolvable, false);
});

test('Zenodo sandbox: request shapes, the reserved DOI, the MD5 check, and the token never logged', async () => {
  const store = new Store(tempHome());
  store.ensure();
  const token = 'SECRET-TOKEN-123';
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method, auth: init.headers.authorization, body: init.body });
    if (init.method === 'POST' && url.endsWith('/api/deposit/depositions')) return res(201, { id: 77, created: 'now', links: { bucket: 'https://sandbox.zenodo.org/api/files/bkt' }, metadata: { prereserve_doi: { doi: '10.5072/zenodo.77' } } });
    if (init.method === 'PUT' && url.startsWith('https://sandbox.zenodo.org/api/files/bkt/')) return res(201, { checksum: 'md5:5d41402abc4b2a76b9719d911017c592' });
    if (init.method === 'PUT' && url.endsWith('/api/deposit/depositions/77')) return res(200, { metadata: JSON.parse(init.body).metadata });
    if (init.method === 'POST' && url.endsWith('/actions/publish')) return res(202, { record_id: 77, doi: '10.5072/zenodo.77', state: 'done' });
    throw new Error(`unexpected ${init.method} ${url}`);
  };
  const z = new ZenodoSandbox({ token, store, fetchImpl });
  const created = await z.create();
  assert.equal(created.doi, '10.5072/zenodo.77');
  const f = path.join(tempDir(), 'doc.md');
  fs.writeFileSync(f, 'hello');
  const file = await z.upload(77, f);
  assert.equal(file.md5, '5d41402abc4b2a76b9719d911017c592');
  const future = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
  const link = await z.link(77, { txHash: TX, embargoDate: future });
  assert.deepEqual(link.accepted, [{ identifier: URI, relation: 'isSupplementedBy' }]);
  const meta = JSON.parse(seen.find((s) => s.method === 'PUT' && s.url.endsWith('/77')).body).metadata;
  assert.equal(meta.access_right, 'embargoed');
  assert.equal(meta.license, 'cc-by-4.0');
  assert.equal(meta.embargo_date, future);
  await assert.rejects(z.link(77, { txHash: TX, embargoDate: '2020-01-01' }), /future date/);
  await z.publish(77);
  assert.ok(seen.every((s) => s.auth === `Bearer ${token}`));
  const log = fs.readFileSync(z.logFile, 'utf8');
  assert.ok(!log.includes(token), 'the token never reaches the log');
  assert.match(log, /Bearer \[redacted\]/);
  assert.throws(() => new ZenodoSandbox({ token: null, store }), /no Zenodo sandbox token/);
});
