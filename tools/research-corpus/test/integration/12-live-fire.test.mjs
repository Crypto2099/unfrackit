// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// T14. The live-fire mode end to end on preprod, as it will run on mainnet
// before the final freeze: a stated test h (refused when it is a real epoch
// nonce or block hash), no row count in what the run prints or writes, no
// report, manifest or raw list, plain EXPLAIN plans reduced to their shape, the
// gate logged as a query and then a start entry and an end entry per run in
// the check log with the functional outcome only, refused attempts logged as
// failed gate queries and never as live-fire runs, the run's study tables dropped at the end, or kept for
// debugging without the aggregate tables and then dropped by `cleanup`,
// which logs when; the simulator's live-fire wallets picked by one run, kept
// in a private file the log does not name, and deleted by `cleanup`. A refused live-fire run under another run's id drops
// nothing. This test runs last: the live-fire runs replace the study tables
// the earlier tests read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { db, record, TAG, RUN_B } from './env.mjs';
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
    // Refused under T10's run id: that run's tables stay.
    const tablesB = (await markedTables(c, RUN_B)).sort();
    if (tablesB.length) {
      await assert.rejects(runPipeline({ ...common, runId: RUN_B, liveFire: { testH: TEST_H, purpose: 'refusal under another run' } }), /was started in test mode/);
      assert.deepEqual((await markedTables(c, RUN_B)).sort(), tablesB, `${RUN_B} keeps its tables`);
    }
    const refusedLog = readFileSync(checkLogPath('preprod'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => [`${TAG}-lf0`, RUN_B].includes(e.run_id) || e.name === 'live-fire gate');
    assert.ok(!refusedLog.some((e) => e.type === 'live-fire-start' && [`${TAG}-lf0`, RUN_B].includes(e.run_id)), 'a refused attempt is not a live-fire run');
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
    for (const v of Object.values(e1.parse)) assert.equal(typeof v, 'boolean');
    const keptTables = await markedTables(c, `${TAG}-lf1`);
    assert.ok(keptTables.length > 20, 'study tables kept');
    for (const t of ['flow', 'draw_summary', 'ft_floor', 'sc_floor', 'nft_top', 'unfrackit_tx']) assert.ok(!keptTables.includes(t), `aggregate ${t} dropped although kept`);
    assert.equal(e1.start_seq, e1.seq - 1);
    const dir1 = runDir('preprod', `${TAG}-lf1`);
    assert.deepEqual(readdirSync(dir1).sort(), ['live-fire.json', 'plans.json']);
    const plans = JSON.parse(readFileSync(join(dir1, 'plans.json'), 'utf8'));
    const planText = JSON.stringify(plans);
    assert.ok(planText.includes('Node Type'));
    assert.ok(!/"(Plan Rows|Actual Rows|Total Cost|Startup Cost|Plan Width|Workers Planned|Planned Partitions|JIT)"/.test(planText), 'plan numbers stripped');
    const stepRows = (await c.query(`SELECT count(*) FILTER (WHERE rows IS NOT NULL) AS n FROM study.step WHERE run_id = $1`, [`${TAG}-lf1`])).rows[0];
    assert.equal(Number(stepRows.n), 0, 'no step row count stored');
    assert.ok(!lines.some((l) => /\d+ rows|\d+ wallets|\d+\/\d+/.test(l)), 'no count printed');

    // cleanup drops the kept tables and logs when.
    const ce = await cleanupRun({ runId: `${TAG}-lf1`, command: 'test T14 cleanup' });
    assert.equal(ce.type, 'cleanup');
    assert.equal(ce.outcome, 'succeeded');
    assert.deepEqual(await markedTables(c, `${TAG}-lf1`), []);
    assert.equal((await c.query('SELECT count(*) AS n FROM study.run WHERE run_id = $1', [`${TAG}-lf1`])).rows[0].n, '0');

    // Not kept: dropped at the end. This run also picks the simulator's
    // live-fire wallets: at most ten, kept in a private file until cleanup,
    // the log saying only that they were written.
    const gone = await runPipeline({ ...common, runId: `${TAG}-lf2`, command: 'test T14 dropped', liveFire: { testH: TEST_H, purpose: 'T14: dropped at the end, simulator wallets picked', simWallets: true } });
    assert.equal(gone.entry.outcome, 'succeeded', gone.entry.error);
    assert.match(gone.entry.wallet_level_output, /^deleted \d{4}-/);
    assert.deepEqual(await markedTables(c, `${TAG}-lf2`), []);
    assert.ok(!existsSync(join(runDir('preprod', `${TAG}-lf2`), 'report.json')));
    assert.equal(gone.entry.sim_wallets, 'kept for the simulator checks');
    const simFile = join(runDir('preprod', `${TAG}-lf2`), 'sim', 'wallets.json');
    const sim = JSON.parse(readFileSync(simFile, 'utf8'));
    assert.equal(sim.test_h, TEST_H);
    assert.ok(sim.wallets.length >= 1 && sim.wallets.length <= 10);
    assert.equal(new Set(sim.wallets.flatMap((w) => w.conditions)).size, sim.wallets.reduce((n, w) => n + w.conditions.length, 0), 'each condition names one wallet');
    assert.ok(sim.wallets.every((w) => /^stake_test1/.test(w.stake_address)));
    assert.ok(!JSON.stringify(gone.entry).includes('stake_test1'), 'no stake address in the log');
    assert.deepEqual(verifyLog('preprod').kept_not_cleaned.filter((x) => x.run_id === `${TAG}-lf2`).length, 1);
    const ce2 = await cleanupRun({ runId: `${TAG}-lf2`, command: 'test T14 cleanup of the simulator wallets' });
    assert.equal(ce2.outcome, 'succeeded');
    assert.ok(!existsSync(simFile));

    const v = verifyLog('preprod');
    assert.deepEqual(v.errors, []);
    assert.equal(v.entries, before + 10, 'per run a gate query pair and a start and end pair; two cleanups');
    assert.deepEqual(v.kept_not_cleaned.filter((x) => x.run_id.startsWith(TAG)), []);
    assert.deepEqual(v.unclosed.filter((x) => (x.run_id || '').startsWith(TAG)), []);
    assert.deepEqual(v.failed_deletions.filter((x) => (x.run_id || '').startsWith(TAG)), []);
    record('T14', { check_log: checkLogPath('preprod'), entries: [e1, ce, gone.entry, ce2], sim_conditions: sim.wallets.map((w) => w.conditions), printed: lines });
  } finally {
    await c.end();
  }
});
