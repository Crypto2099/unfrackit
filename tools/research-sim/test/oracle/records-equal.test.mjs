// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Two runs of the oracle check (battery.test.mjs) on the same shapes, the
// earlier from an earlier build, give the same records outside the wall-clock
// fields, the unseeded methods' answers and the fields the later build added
// (test/lib/oracle-records.mjs): what a change that only records more must
// show. RESEARCH_SIM_ORACLE_COMPARE names the two record files,
// earlier,later (each an oracle-battery.jsonl); without it the check is
// skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareRecordFiles } from '../lib/oracle-records.mjs';

const files = process.env.RESEARCH_SIM_ORACLE_COMPARE ? process.env.RESEARCH_SIM_ORACLE_COMPARE.split(',') : null;
const skip = files ? false : 'set RESEARCH_SIM_ORACLE_COMPARE to earlier.jsonl,later.jsonl';

test('the later build\'s records equal the earlier build\'s outside the added and wall-clock fields', { skip }, (t) => {
  assert.equal(files.length, 2, 'RESEARCH_SIM_ORACLE_COMPARE: two files, earlier,later');
  const c = compareRecordFiles(files[0], files[1]);
  t.diagnostic(JSON.stringify({ earlier: files[0], later: files[1], compared: c.compared, identical: c.identical, missing: c.missing.length, extra: c.extra.length, errors: c.errors.length, differ: c.differ.length }));
  for (const d of c.differ.slice(0, 20)) t.diagnostic(`${d.key}: ${d.paths.slice(0, 12).join(', ')}`);
  assert.ok(c.compared > 0, 'no records compared');
  assert.deepEqual(c.missing, []);
  assert.deepEqual(c.extra, []);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.differ, []);
});
