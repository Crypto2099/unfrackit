// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// T16. The explain command on preprod, as it will run on mainnet before the
// hypotheses freeze: every statement over db-sync's tables alone planned with
// plain EXPLAIN at a stand-in snapshot (the tip), the rest listed by name with
// the reason, nothing created or changed in the database, the plans reduced to
// their shape in a private file, and a start and an end entry in the check
// log with the names and the sequential-scan flags only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { db, record } from './env.mjs';
import { explainCommand } from '../../src/explain.mjs';
import { checkLogPath, verifyLog } from '../../src/checklog.mjs';

test('T16 explain on preprod: plans, the statements not planned, nothing written, the log', { timeout: 3600 * 1000 }, async () => {
  const c = await db();
  try {
    const shape = async () => (await c.query(`SELECT c.relname, obj_description(c.oid, 'pg_class') AS mark FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'study' ORDER BY 1`)).rows;
    const before = await shape();
    const entries0 = verifyLog('preprod').entries;
    const r = await explainCommand({ expectNetwork: 'preprod', purpose: 'T16: plans before the hypotheses freeze' }, 'test T16 explain', { client: c });
    assert.deepEqual(await shape(), before, 'no study table created, dropped or re-marked');
    const names = r.planned.map((x) => x.name);
    for (const n of ['txo#2', 'label_309_from', 'order_check', 'cred#2', 'script_tx#2', 'unfrackit_tx#2', 'tip_block']) assert.ok(names.includes(n), `${n} planned`);
    assert.ok(r.planned.every((x) => !x.error), 'every plan made');
    assert.ok(r.not_planned.some((x) => x.name === 'scam_policy#3' && /reads study tables: scam_fp/.test(x.reason)));
    assert.ok(r.not_planned.some((x) => x.name === 'activity#2' && /reads study tables/.test(x.reason)));
    const file = JSON.parse(readFileSync(r.file, 'utf8'));
    assert.ok(!/"(Plan Rows|Total Cost|Startup Cost|Plan Width|Workers Planned|Planned Partitions|JIT)"/.test(JSON.stringify(file)), 'plan numbers stripped');
    const v = verifyLog('preprod');
    assert.equal(v.entries, entries0 + 2);
    const end = readFileSync(checkLogPath('preprod'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.deepEqual([end.type, end.name, end.outcome], ['query', 'explain', 'succeeded']);
    assert.deepEqual(end.planned, names);
    assert.ok(Object.values(end.seq_scan).every((x) => typeof x === 'boolean'));
    record('T16', { file: r.file, planned: r.planned.map((x) => ({ name: x.name, seq_scan: x.seq_scan, relations: x.seq_scan_relations })), not_planned: r.not_planned });
  } finally {
    await c.end();
  }
});
