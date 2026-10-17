// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// T10. Frames end to end with test parameters: the snapshot is the database
// tip with the dev db-sync instance stopped; h is the hash of the block of
// S1's seeding transaction; guard 1,000 so the guard path runs; the real
// targets (2,400, 1,000, 600 and 1,200), which preprod does not meet. The flow
// table adds up stage by stage; S1 is in the ADA-only sample if drawn and is
// never token-holding; S3 and M2 are token-holding, M2 with at least 100
// assets; S3 has one spend event (the sweep), M2 and S1 none; no franken flags
// on the shapes; the run repeated gives identical tables.
// T12. The first run captures EXPLAIN (ANALYZE, BUFFERS), wall time and rows
// of every step into its run directory.

import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { db, blocks, record, resultsDir, TAG, RUN_A, RUN_B, SHAPES, FUNDER, seederAddress, stakeOf, saIdOf } from './env.mjs';
import { encode } from '../../src/bech32.mjs';
import { runPipeline } from '../../src/pipeline.mjs';
import { q } from '../../src/db.mjs';
import { writePrivate } from '../../src/paths.mjs';

export const S1_SEEDING_TX = '0183bce3b177353fec0963164cf4d4693a2f5060decc87bb3ae762a6aadd0152';
const STRATA = new URL('../fixtures/strata-preprod.json', import.meta.url).pathname;

async function fingerprint(c) {
  const tables = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'study' AND tablename NOT IN ('run', 'param', 'step') ORDER BY 1`)).rows.map((r) => r.tablename);
  const out = {};
  for (const t of tables) {
    const r = await c.query(`SELECT count(*) AS n, coalesce(sum(('x' || left(md5(x::text), 15))::bit(60)::bigint), 0) AS sum FROM study.${t} x`);
    out[t] = `${r.rows[0].n}:${r.rows[0].sum}`;
  }
  return out;
}

const strip = (m) => {
  const { run_id, code_version, ...rest } = m;
  return rest;
};

test('T10 frames, draw and samples end to end, run twice; T12 capture', { timeout: 4 * 3600 * 1000 }, async () => {
  const c = await db();
  try {
    const existing = await c.query('SELECT run_id FROM study.run WHERE run_id = ANY($1)', [[RUN_A, RUN_B]]);
    assert.equal(existing.rows.length, 0, `runs ${RUN_A} and ${RUN_B} already exist; set RESEARCH_CORPUS_TEST_TAG to a new value`);
    const tip0 = (await q(c, blocks, 'tip_block'))[0];
    const views = Object.fromEntries(SHAPES.map((s) => [s, stakeOf(seederAddress(s)[0])]));
    views.funder = stakeOf(FUNDER);
    // A consented list: the funder's key (active in both windows) and a random
    // key hash, checked to be absent from the database. (The CIP-19 test
    // vector's stake key is not a safe choice: it is in use on preprod.)
    const absent = encode('stake_test', Buffer.concat([Buffer.from([0xe0]), createHash('sha256').update(`absent ${TAG}`).digest().subarray(0, 28)]));
    assert.equal(await saIdOf(c, absent), null, 'the absent key is not on preprod');
    const consented = join(resultsDir(), 'consented-test.txt');
    writePrivate(consented, `# test list\n${views.funder}\n${absent}\n`);
    const common = {
      expectNetwork: 'preprod',
      snapshot: 'tip',
      standInTx: S1_SEEDING_TX,
      strataList: STRATA,
      consented,
      hmacKey: process.env.RESEARCH_CORPUS_TEST_HMAC_KEY,
      set: ['guard=1000'],
      caseWallets: Object.values(views),
      log: (s) => process.stderr.write(`  ${s}\n`)
    };
    const t0 = performance.now();
    const a = await runPipeline({ ...common, runId: RUN_A, capture: true });
    const msA = performance.now() - t0;
    const fpA = await fingerprint(c);
    const t1 = performance.now();
    const b = await runPipeline({ ...common, runId: RUN_B });
    const msB = performance.now() - t1;
    const fpB = await fingerprint(c);
    const tip1 = (await q(c, blocks, 'tip_block'))[0];

    // db-sync was stopped at the snapshot for the whole test.
    assert.equal(tip0.hash, tip1.hash, 'the database tip moved: stop the dev db-sync instance first');
    assert.equal(a.report.snapshot.hash, tip0.hash);
    assert.equal(b.report.snapshot.hash, tip0.hash);

    // Identical tables and manifests.
    assert.deepEqual(fpB, fpA);
    assert.deepEqual(strip(b.manifest), strip(a.manifest));

    // The flow table adds up stage by stage.
    const nCred = Number((await c.query('SELECT count(*) AS n FROM study.cred')).rows[0].n);
    for (const frame of ['recent', 'peak']) {
      const f = b.report.flow.filter((r) => r.frame === frame).sort((x, y) => x.stage_no - y.stage_no);
      assert.equal(f.length, 8);
      assert.equal(f[0].n_in, nCred);
      for (let i = 0; i < f.length; i++) {
        assert.equal(f[i].n_removed, f[i].n_in - f[i].n_out);
        assert.ok(f[i].n_removed >= 0);
        if (i > 0) assert.equal(f[i].n_in, f[i - 1].n_out);
      }
      const elig = Number((await c.query('SELECT count(*) AS n FROM study.frame WHERE frame = $1 AND eligible', [frame])).rows[0].n);
      assert.equal(f[7].n_out, elig);
    }

    // The consented key is removed at stage 3 of both frames, counted, and
    // never written to the run's files.
    assert.deepEqual(b.report.consented, { listed: 2, matched: 1, unmatched: 1 });
    for (const frame of ['recent', 'peak']) {
      assert.equal(b.report.flow.find((r) => r.frame === frame && r.stage_no === 3).n_removed, 1, `${frame}: one consented key removed`);
    }
    for (const f of ['params.json', 'report.json', 'manifest.json', 'timings.json', join('raw', 'sample.csv')]) {
      for (const dir of [a.dir, b.dir]) assert.ok(!readFileSync(join(dir, f), 'utf8').includes(views.funder), `${f} names no consented key`);
    }

    // The guard path ran in both frames, and the real targets were not met.
    for (const d of b.report.draw) {
      assert.equal(d.guard_reached, true, `${d.frame}: guard reached`);
      assert.equal(d.k_stop, 1000);
      assert.equal(d.k_all, null);
    }

    // The shapes.
    const sa = {};
    for (const [k, v] of Object.entries(views)) sa[k] = await saIdOf(c, v);
    const row = async (frame, id) => (await c.query('SELECT * FROM study.frame WHERE frame = $1 AND sa_id = $2', [frame, id])).rows[0];
    const s1 = await row('recent', sa.S1);
    assert.ok(s1, 'S1 is in the recent frame');
    assert.equal(s1.tok, false, 'S1 is never token-holding');
    assert.equal(Number(s1.n_spends_any), 0);
    const s1Samples = (await c.query('SELECT frame, kind FROM study.sample WHERE sa_id = $1', [sa.S1])).rows;
    const s1Rank = (await c.query(`SELECT k, n_ada FROM study.draw_order WHERE frame = 'recent' AND sa_id = $1`, [sa.S1])).rows[0];
    const s1Drawn = s1Rank && Number(s1Rank.k) <= 1000 && Number(s1Rank.n_ada) <= 1200;
    assert.deepEqual(s1Samples, s1Drawn ? [{ frame: 'recent', kind: 'ada_only' }] : [], 'S1 is in the ADA-only sample if drawn, else in none');
    assert.equal(await row('peak', sa.S1), undefined, 'S1 has no spend, so it is not in the peak frame');
    const s3 = await row('recent', sa.S3);
    const m2 = await row('recent', sa.M2);
    assert.equal(s3.tok, true);
    assert.equal(m2.tok, true);
    assert.equal(m2.ge100, true, 'M2 holds at least 100 assets');
    assert.ok(Number(m2.n_assets_a) >= 3000);
    assert.equal(Number(s3.n_spends_key), 1, 'S3 has one spend event, the sweep');
    assert.equal(Number(m2.n_spends_key), 0);
    assert.equal(Number(m2.n_spends_any), 0);
    const s3peak = await row('peak', sa.S3);
    const franken = (await c.query('SELECT sa_id, bool_or(flagged) AS f, max(n_creds) AS n FROM study.franken WHERE sa_id = ANY($1) GROUP BY sa_id', [[sa.S1, sa.S3, sa.M2]])).rows;
    assert.equal(franken.length, 3);
    for (const f of franken) assert.equal(f.f, false, `no franken flag on ${f.sa_id}`);

    // The 6.1 check ran with the direct read, for the sample and the case wallets.
    assert.equal(b.report.check_61.direct_valid, true);
    assert.equal(b.report.check_61.n_excluded, 0);
    assert.equal(b.report.check_61.n_case_disagree, 0);

    // T12: every step of run A has a wall time and rows; explainable
    // statements carry their plan.
    const steps = a.timings.filter((t) => t.kind === 'step');
    assert.ok(steps.length >= 25);
    let plans = 0;
    for (const s of steps) {
      assert.ok(s.ms > 0 && s.rows !== null, `${s.name}: time and rows`);
      plans += s.statements.filter((x) => x.plan).length;
    }
    assert.ok(plans > 30, 'plans captured');

    record('T10', {
      run_a: { dir: a.dir, ms: msA },
      run_b: { dir: b.dir, ms: msB },
      snapshot: b.report.snapshot,
      h_block: b.report.freeze,
      windows: b.report.windows,
      flow: b.report.flow,
      frame_report: b.report.frame_report,
      draw: b.report.draw,
      strata: b.report.strata,
      split: b.report.split,
      prior: b.report.prior,
      franken: b.report.franken,
      check_61: b.report.check_61,
      profiles: b.report.profiles,
      shapes: {
        S1: { recent: { tok: s1.tok, n_tx: Number(s1.n_tx), n_spends_any: Number(s1.n_spends_any), draw_rank: s1Rank ? Number(s1Rank.k) : null, samples: s1Samples } },
        S3: { recent: { tok: s3.tok, n_assets: Number(s3.n_assets_a), n_spends_key: Number(s3.n_spends_key) }, peak: s3peak ? { tok: s3peak.tok, n_spends_key: Number(s3peak.n_spends_key) } : null },
        M2: { recent: { tok: m2.tok, ge100: m2.ge100, n_assets: Number(m2.n_assets_a), n_spends_key: Number(m2.n_spends_key) } },
        franken
      },
      identical_tables: Object.keys(fpA).length,
      tip_unchanged: tip0.hash === tip1.hash
    });
    record('T12', { run_dir: a.dir, timings_file: join(a.dir, 'timings.json'), steps: a.timings.map((t) => ({ name: t.name, kind: t.kind, ms: Math.round(t.ms), rows: t.rows })), uncaptured_run_b: b.timings.map((t) => ({ name: t.name, ms: Math.round(t.ms), rows: t.rows })) });
  } finally {
    await c.end();
  }
});
