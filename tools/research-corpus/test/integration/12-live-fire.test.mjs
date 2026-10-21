// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// T14. The live-fire mode end to end on preprod, as it will run on mainnet
// before the final freeze: a stated test h (refused when it is a real epoch
// nonce or block hash), no row count in what the run prints or writes, no
// report, manifest or raw list, plain EXPLAIN plans with their numbers
// stripped, one check-log entry per run with the functional outcome only, the
// run's study tables dropped at the end, or kept for debugging and then
// dropped by `cleanup`, which logs when. This test runs last: the live-fire
// runs replace the study tables the earlier tests read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { db, record, TAG } from './env.mjs';
import { runPipeline, cleanupRun } from '../../src/pipeline.mjs';
import { checkLogPath, verifyLog } from '../../src/checklog.mjs';
import { runDir } from '../../src/paths.mjs';
import { mark } from '../../src/runner.mjs';

const STRATA = new URL('../fixtures/strata-preprod.json', import.meta.url).pathname;
const TEST_H = createHash('sha256').update(`live-fire test h ${TAG}`).digest('hex');

async function markedTables(c, runId) {
  const r = await c.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname = 'study' AND obj_description(c.oid, 'pg_class') = $1`, [mark(runId)]);
  return r.rows.map((x) => x.relname);
}

test('T14 live-fire runs: no counts, check log, tables dropped or kept and cleaned up', { timeout: 4 * 3600 * 1000 }, async () => {
  const c = await db();
  const lines = [];
  const common = { expectNetwork: 'preprod', snapshot: 'tip', strataList: STRATA, set: ['guard=1000'], log: (s) => lines.push(s) };
  try {
    // Refused: a real epoch nonce or block hash as the test h.
    const nonce = (await c.query(`SELECT encode(nonce, 'hex') AS n FROM epoch_param WHERE nonce IS NOT NULL ORDER BY epoch_no DESC LIMIT 1`)).rows[0].n;
    await assert.rejects(runPipeline({ ...common, runId: `${TAG}-lf0`, liveFire: { testH: nonce, purpose: 'refusal check' } }), /epoch nonce or block hash/);
    const before = verifyLog('preprod').entries;

    // Kept for debugging, with plans.
    const kept = await runPipeline({ ...common, runId: `${TAG}-lf1`, explain: true, command: 'test T14 kept', liveFire: { testH: TEST_H, purpose: 'T14: kept for debugging', keep: true } });
    const e1 = kept.entry;
    assert.equal(e1.outcome, 'succeeded', e1.error);
    assert.equal(e1.type, 'live-fire');
    assert.equal(e1.test_h, TEST_H);
    assert.equal(e1.wallet_level_output, 'kept for debugging');
    assert.ok(e1.steps.length >= 25 && e1.steps.every((s) => s.ok && typeof s.ms === 'number' && !('rows' in s)));
    for (const v of Object.values(e1.checks)) assert.equal(typeof v, 'boolean');
    for (const v of Object.values(e1.parse)) assert.ok(v === null || (v >= 0 && v <= 1));
    assert.ok((await markedTables(c, `${TAG}-lf1`)).length > 20, 'study tables kept');
    const dir1 = runDir('preprod', `${TAG}-lf1`);
    assert.deepEqual(readdirSync(dir1).sort(), ['live-fire.json', 'plans.json']);
    const plans = JSON.parse(readFileSync(join(dir1, 'plans.json'), 'utf8'));
    const planText = JSON.stringify(plans);
    assert.ok(planText.includes('Node Type'));
    assert.ok(!/"(Plan Rows|Actual Rows|Total Cost|Startup Cost|Plan Width)"/.test(planText), 'plan numbers stripped');
    const stepRows = (await c.query(`SELECT count(*) FILTER (WHERE rows IS NOT NULL) AS n FROM study.step WHERE run_id = $1`, [`${TAG}-lf1`])).rows[0];
    assert.equal(Number(stepRows.n), 0, 'no step row count stored');
    assert.ok(!lines.some((l) => /\d+ rows|\d+ wallets|\d+\/\d+/.test(l)), 'no count printed');

    // cleanup drops the kept tables and logs when.
    const ce = await cleanupRun({ runId: `${TAG}-lf1`, command: 'test T14 cleanup' });
    assert.equal(ce.type, 'cleanup');
    assert.equal(ce.outcome, 'succeeded');
    assert.deepEqual(await markedTables(c, `${TAG}-lf1`), []);
    assert.equal((await c.query('SELECT count(*) AS n FROM study.run WHERE run_id = $1', [`${TAG}-lf1`])).rows[0].n, '0');

    // Not kept: dropped at the end.
    const gone = await runPipeline({ ...common, runId: `${TAG}-lf2`, command: 'test T14 dropped', liveFire: { testH: TEST_H, purpose: 'T14: dropped at the end' } });
    assert.equal(gone.entry.outcome, 'succeeded', gone.entry.error);
    assert.match(gone.entry.wallet_level_output, /^deleted \d{4}-/);
    assert.deepEqual(await markedTables(c, `${TAG}-lf2`), []);
    assert.ok(!existsSync(join(runDir('preprod', `${TAG}-lf2`), 'report.json')));

    const v = verifyLog('preprod');
    assert.deepEqual(v.errors, []);
    assert.equal(v.entries, before + 3);
    assert.deepEqual(v.kept_not_cleaned.filter((x) => x.run_id.startsWith(TAG)), []);
    record('T14', { check_log: checkLogPath('preprod'), entries: [e1, ce, gone.entry], printed: lines });
  } finally {
    await c.end();
  }
});
