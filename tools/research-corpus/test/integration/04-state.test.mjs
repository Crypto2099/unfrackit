// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// T3. Current state against the specification: counts 3, 95 and 3,005;
// lovelace per UTxO; assets per UTxO up to the bijection of policies; no
// datum, no reference script, no script payment credential. Also the seeder's
// verify exits 0. The state is the life table at the snapshot of the last T10
// run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, blocks, record, RUN_B, SHAPES, seederAddress, seederVerify, specOf, stakeOf, saIdOf } from './env.mjs';
import { q } from '../../src/db.mjs';
import { parseLine, matchSpec } from '../lib/spec.mjs';

const EXPECTED = { S1: 3, S3: 95, M2: 3005 };

test('T3 the shapes at the snapshot match their specification', async () => {
  const c = await db();
  const out = {};
  try {
    const snap = (await c.query(`SELECT value FROM study.param WHERE run_id = $1 AND key = 'snapshot'`, [RUN_B])).rows[0].value;
    for (const shape of SHAPES) {
      const sa = await saIdOf(c, stakeOf(seederAddress(shape)[0]));
      const rows = await q(c, blocks, 'lines_life', { sa_id: { type: 'int', value: sa }, t: { type: 'int', value: snap.t } });
      assert.equal(rows.length, EXPECTED[shape], `${shape}: count`);
      for (const r of rows) {
        assert.equal(r.has_datum, false);
        assert.equal(r.has_ref_script, false);
        assert.equal(r.script_pay, false);
      }
      const spec = (await specOf(shape)).utxos;
      const m = matchSpec(spec, rows.map((r) => parseLine(r.line)));
      assert.ok(m.ok, `${shape}: ${m.problems.join('; ')}`);
      const v = seederVerify(shape);
      assert.equal(v.code, 0, `${shape}: seeder verify\n${v.out}`);
      out[shape] = { utxos: rows.length, policies: m.policies, bijection: m.bijection, verify_exit: v.code, verify: v.out.trim() };
    }
    record('T3', { snapshot_block_no: snap.block_no, shapes: out });
  } finally {
    await c.end();
  }
});
