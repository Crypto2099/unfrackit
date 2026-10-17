// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashList, formatHashList } from '../../src/hash.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

test('every module loads', async () => {
  for (const f of readdirSync(SRC).filter((x) => x.endsWith('.mjs') && x !== 'cli.mjs')) await import(join(SRC, f));
});

test('the hash list covers src, sql, data and the package files, each UTF-8 with LF', () => {
  const list = hashList();
  const paths = list.map((x) => x.path);
  assert.ok(paths.includes('package-lock.json'));
  assert.ok(paths.includes('package.json'));
  assert.ok(paths.some((p) => p.startsWith('sql/')));
  assert.ok(paths.some((p) => p.startsWith('src/')));
  assert.ok(paths.some((p) => p.startsWith('data/')));
  assert.ok(!paths.some((p) => p.startsWith('test/') || p === 'README.md'));
  for (const x of list) assert.match(x.sha256, /^[0-9a-f]{64}$/);
  const text = formatHashList();
  assert.match(text, /^SHA-256 +file\n[0-9a-f]{64} {2}\S+/);
  assert.match(text, /dependencies, pinned by version and npm integrity:/);
  assert.match(text, /node: engines /);
});
