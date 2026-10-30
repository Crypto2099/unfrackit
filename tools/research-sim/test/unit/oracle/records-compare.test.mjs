// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The comparison of two oracle-check runs (test/lib/oracle-records.mjs): the
// later run may add the named fields and differ in wall-clock time, and in
// nothing else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareRecordFiles, departures } from '../../lib/oracle-records.mjs';

const rec = (over = {}) => ({ shape: 'S1', spend: 'ada-payment', policy: 'csl', seeded: { status: 'optimal', fee: '170000', ms: 12, work: { solves: 3, nodes: 1 }, detail: { mip: { rows: 9, solverMs: 4 } } }, unseededMethods: [{ name: 'csl-ri', fee: '171000' }], ...over });

test('records equal outside the added and wall-clock fields', () => {
  const a = rec();
  const b = rec({ unseededMethods: [{ name: 'csl-ri', fee: '175000' }], seeded: { status: 'optimal', fee: '170000', ms: 99, work: { solves: 3, nodes: 1, nnzSolves: 84 }, detail: { mip: { rows: 9, solverMs: 70, nnz: 25, rowsLast: 9 } } } });
  assert.deepEqual(departures(a, b), []);
  // A changed value, a lost field and a field that is not an added one.
  const c = rec({ seeded: { status: 'optimal', fee: '170001', ms: 12, work: { nodes: 1, extra: 1 }, detail: { mip: { rows: 9, solverMs: 4 } } } });
  assert.deepEqual(departures(a, c).sort(), ['seeded.fee', 'seeded.work.extra (not an added field)', 'seeded.work.solves (missing)']);
  // An array's length and its entries count.
  assert.deepEqual(departures({ x: [1, 2] }, { x: [1] }), ['x']);
  assert.deepEqual(departures({ x: [{ y: 1 }] }, { x: [{ y: 2 }] }), ['x[0].y']);
});

test('two record files: keys, errors and differences', () => {
  const d = mkdtempSync(join(tmpdir(), 'oracle-records-'));
  try {
    const write = (name, rs) => {
      writeFileSync(join(d, name), rs.map((r) => JSON.stringify(r)).join('\n') + '\n');
      return join(d, name);
    };
    const a = write('a.jsonl', [rec(), rec({ policy: 'cjs' }), rec({ policy: 'evo' })]);
    const b = write('b.jsonl', [rec({ policy: 'evo', seeded: { ...rec().seeded, fee: '1' } }), rec(), rec({ policy: 'layout' })]);
    const c = compareRecordFiles(a, b);
    assert.deepEqual({ ...c, differ: c.differ.map((x) => x.key) }, { compared: 2, identical: 1, missing: ['S1|ada-payment|cjs'], extra: ['S1|ada-payment|layout'], errors: [], differ: ['S1|ada-payment|evo'] });
    assert.throws(() => compareRecordFiles(write('dup.jsonl', [rec(), rec()]), a), /twice/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
