// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll, splitStatements, fill, literal, placeholders, SQL_DIR } from '../../src/sqlfile.mjs';
import { sqlParams, defaultSettings } from '../../src/params.mjs';

test('statement splitter respects quotes, dollar quotes and comments', () => {
  const s = splitStatements("SELECT 'a;b'; -- c;d\nSELECT $$x;y$$; SELECT $f$ ; $f$; /* ; */ SELECT \"q;\"");
  assert.deepEqual(s, ["SELECT 'a;b'", "-- c;d\nSELECT $$x;y$$", 'SELECT $f$ ; $f$', '/* ; */ SELECT "q;"']);
});

test('literals are typed and refuse bad values', () => {
  assert.equal(literal('a', { type: 'int', value: 12n }), '12');
  assert.equal(literal('a', { type: 'bytea', value: 'AbCd' }), "'\\xabcd'::bytea");
  assert.equal(literal('a', { type: 'text', value: "it's" }), "'it''s'");
  assert.equal(literal('a', { type: 'intarr', value: [1, 2] }), 'ARRAY[1,2]::bigint[]');
  assert.throws(() => literal('a', { type: 'int', value: '1; DROP' }));
  assert.throws(() => literal('a', { type: 'bytea', value: 'xyz' }));
  assert.throws(() => literal('a', { type: 'ident', value: 'a b' }));
  assert.throws(() => fill('SELECT {{nope}}', {}));
});

test('every SQL file parses, is UTF-8 with LF and no BOM, and every placeholder is a run parameter', () => {
  const blocks = loadAll();
  assert.ok(blocks.size > 30);
  const run = {
    network: 'preprod',
    settings: defaultSettings(),
    snapshot: { id: 10, t: 20 },
    h: '00'.repeat(32),
    windows: {
      recent: { lo: 1, hi: 2, t_start: 0, first_epoch: 1, last_epoch: 2 },
      peak: { lo: 1, hi: 2, t_start: 0, first_epoch: 1, last_epoch: 2 }
    }
  };
  const params = sqlParams(run);
  const callTime = new Set(['block_hash', 'block_id', 'tx_hash', 'sa_ids', 't', 'sa_id', 'snap_hash', 'view']);
  for (const [name, b] of blocks) {
    for (const st of b.statements) {
      for (const p of placeholders(st)) assert.ok(p in params || callTime.has(p), `${name}: unknown parameter ${p}`);
    }
  }
  for (const f of readdirSync(SQL_DIR)) {
    const buf = readFileSync(join(SQL_DIR, f));
    assert.notEqual(buf[0], 0xef, `${f}: BOM`);
    assert.ok(!buf.includes(0x0d), `${f}: CR`);
  }
});
