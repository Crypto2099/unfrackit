// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// T10. Frames end to end with test parameters: the snapshot is the database
// tip with the dev db-sync instance stopped; h is the epoch nonce that the
// draw key's epoch rule names for the block of S1's seeding transaction, read
// from the database and from Koios; guard 1,000 so the guard path runs; the
// real sample size (1,000) and quotas, which preprod does not fill within the
// guard. The flow table adds up stage by stage; the funder and S1 stay in the
// frames like any wallet, and own-drawn counts them in the frames' samples
// without writing anything; S1 is never token-holding; S3 and M2 are
// token-holding, M2 with at least 100 assets; S3 has one spend event (the
// sweep), M2 and S1 none, so none of the three is a candidate of the draw.
// The sample, its size groups, the drawn and taken counts per group and the
// cap fields agree with the rule computed here from the frame and the life
// table; every sample row carries its frame's fragmentation flag; the franken
// step covers the sampled wallets; the profile features agree with the frame;
// the split follows its rule; the run repeated gives identical tables.
// T12. The first run captures EXPLAIN (ANALYZE, BUFFERS), wall time and rows
// of every step into its run directory.

import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { db, blocks, record, S1_SEEDING_TX, TAG, RUN_A, RUN_B, SHAPES, FUNDER, seederAddress, stakeOf, saIdOf } from './env.mjs';
import { encode } from '../../src/bech32.mjs';
import { runPipeline, ownDrawn } from '../../src/pipeline.mjs';
import { q } from '../../src/db.mjs';
import { Runner } from '../../src/runner.mjs';
import { FIXED } from '../../src/params.mjs';

async function fingerprint(c) {
  const tables = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'study' AND tablename NOT IN ('run', 'param', 'step') ORDER BY 1`)).rows.map((r) => r.tablename);
  const out = {};
  for (const t of tables) {
    const r = await c.query(`SELECT count(*) AS n, coalesce(sum(('x' || left(md5(x::text), 15))::bit(60)::bigint), 0) AS sum FROM study.${t} x`);
    out[t] = `${r.rows[0].n}:${r.rows[0].sum}`;
  }
  return out;
}

// The parts of a manifest that may differ between two runs of the same draw:
// the run id, the code version and the time Koios was read.
const strip = (m) => {
  const { run_id, code_version, ...rest } = m;
  const copy = JSON.parse(JSON.stringify(rest));
  if (copy.freeze && copy.freeze.draw) delete copy.freeze.draw.readings.koios_read_at;
  return copy;
};

test('T10 frames, draw and samples end to end, run twice; T12 capture', { timeout: 4 * 3600 * 1000 }, async () => {
  const c = await db();
  try {
    // The bookkeeping tables, created as every run creates them before it
    // reads them, so the check below holds on a database no run has used.
    await new Runner({ client: c, blocks, runId: '-', params: {}, log: () => {} }).run('schema');
    const existing = await c.query('SELECT run_id FROM study.run WHERE run_id = ANY($1)', [[RUN_A, RUN_B]]);
    assert.equal(existing.rows.length, 0, `runs ${RUN_A} and ${RUN_B} already exist; set RESEARCH_CORPUS_TEST_TAG to a new value`);
    const tip0 = (await q(c, blocks, 'tip_block'))[0];
    const views = Object.fromEntries(SHAPES.map((s) => [s, stakeOf(seederAddress(s)[0])]));
    views.funder = stakeOf(FUNDER);
    // The funder's key (active in both windows) and S1's key (active in the
    // recent window only). own-drawn is given them and a random
    // key hash, checked to be absent from the database. (The CIP-19 test
    // vector's stake key is not a safe choice: it is in use on preprod.)
    const absent = encode('stake_test', Buffer.concat([Buffer.from([0xe0]), createHash('sha256').update(`absent ${TAG}`).digest().subarray(0, 28)]));
    assert.equal(await saIdOf(c, absent), null, 'the absent key is not on preprod');
    const common = {
      expectNetwork: 'preprod',
      snapshot: 'tip',
      standInTx: S1_SEEDING_TX,
      hmacKey: process.env.RESEARCH_CORPUS_TEST_HMAC_KEY,
      set: ['guard=1000'],
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
    // Stage 1 starts from the credentials with an output at or before the
    // snapshot block, counted here from db-sync's own tables by block.
    const nCred = Number((await c.query(
      `SELECT count(*) AS n FROM study.cred c
        WHERE EXISTS (SELECT 1 FROM public.tx_out o JOIN public.tx t ON t.id = o.tx_id
                       WHERE o.stake_address_id = c.sa_id AND t.block_id <= $1)`,
      [b.report.snapshot.id])).rows[0].n);
    for (const frame of ['recent', 'peak']) {
      const f = b.report.flow.filter((r) => r.frame === frame).sort((x, y) => x.stage_no - y.stage_no);
      assert.equal(f.length, 7);
      assert.equal(f[0].n_in, nCred);
      for (let i = 0; i < f.length; i++) {
        assert.equal(f[i].n_removed, f[i].n_in - f[i].n_out);
        assert.ok(f[i].n_removed >= 0);
        if (i > 0) assert.equal(f[i].n_in, f[i - 1].n_out);
      }
      const elig = Number((await c.query('SELECT count(*) AS n FROM study.frame WHERE frame = $1 AND eligible', [frame])).rows[0].n);
      assert.equal(f[6].n_out, elig);
    }

    // The funder and S1 are named in no published file.
    for (const f of ['params.json', 'report.json', 'manifest.json', 'timings.json']) {
      for (const dir of [a.dir, b.dir]) {
        const text = readFileSync(join(dir, f), 'utf8');
        assert.ok(!text.includes(views.funder) && !text.includes(views.S1), `${f} names no listed wallet`);
      }
    }
    // own-drawn: the listed wallets' places in the frames' samples, counted
    // from the sample table, and nothing written to the run directory.
    const filesBefore = readdirSync(b.dir).sort();
    const own = await ownDrawn(c, RUN_B, [views.funder, views.S1, absent]);
    const ids = [await saIdOf(c, views.funder), await saIdOf(c, views.S1)];
    const direct = (await c.query('SELECT frame, kind, count(*) AS n FROM study.sample WHERE sa_id = ANY($1) GROUP BY 1, 2', [ids])).rows;
    assert.equal(own.by_sample.reduce((x, r) => x + r.drawn, 0), direct.reduce((x, r) => x + Number(r.n), 0));
    assert.equal(own.listed, 3);
    assert.deepEqual(readdirSync(b.dir).sort(), filesBefore);
    // The raw list carries no published identifier.
    assert.equal(readFileSync(join(b.dir, 'raw', 'sample.csv'), 'utf8').split('\n')[0], 'frame,kind,sa_id,stake_address,draw_rank,size_group,n_utxo_start,n_utxo_ref,n_window_tx,capped,history_hi,split,reconstruction_agree,franken_any,fragmented');

    // h is the epoch nonce of the stand-in's epoch rule, read twice.
    const dk = b.report.freeze.draw;
    assert.equal(b.report.freeze.role, 'stand-in');
    assert.equal(dk.n, dk.slot_no < dk.cutoff ? dk.e + 1 : dk.e + 2);
    assert.equal(dk.readings.db, dk.readings.koios);
    assert.equal(b.report.freeze.h, dk.nonce);

    // The split: one label per credential, the first fifth of all sampled
    // credentials by split key.
    const labels = (await c.query(`SELECT sa_id, count(DISTINCT split) AS n FROM study.sample GROUP BY sa_id HAVING count(DISTINCT split) > 1`)).rows;
    assert.equal(labels.length, 0, 'no credential has two labels');
    assert.equal(b.report.split_overall.n_exploration, Math.floor(b.report.split_overall.n_credentials / 5));

    // The guard path ran in both frames, and the sample did not fill.
    for (const d of b.report.draw) {
      assert.equal(d.guard_reached, true, `${d.frame}: guard reached`);
      assert.equal(d.k_stop, 1000);
      assert.equal(d.k_full, null);
      assert.ok(d.n_sample < 1000);
    }
    assert.deepEqual(b.report.draw_check, { groups_add_up: true, quotas_hold: true, sample_size_holds: true, caps_hold: true });

    // The draw against the rule, computed here from the frame and the life
    // table: within the guard, the token-holding wallets with at least 5 spends
    // in draw order; U the larger of the UTxO count at the window's start and
    // at the reference block, held UTxOs counted; T the distinct window
    // transactions creating or consuming the wallet's outputs; the group the
    // highest edge either reaches; each group taken until its quota is full.
    for (const frame of ['recent', 'peak']) {
      const w = b.report.windows[frame];
      const cands = (await c.query(
        `SELECT d.k, d.sa_id, f.n_utxo AS ref,
                (SELECT count(*) FROM study.txo t WHERE t.sa_id = d.sa_id AND t.created_tx <= $2
                    AND (t.consumed_tx IS NULL OR t.consumed_tx > $2)) AS start,
                (SELECT array_agg(e.tx ORDER BY e.tx) FROM (
                   SELECT t.created_tx AS tx FROM study.txo t WHERE t.sa_id = d.sa_id AND t.created_tx BETWEEN $3 AND $4
                   UNION
                   SELECT t.consumed_tx FROM study.txo t WHERE t.sa_id = d.sa_id AND t.consumed_tx BETWEEN $3 AND $4) e) AS txs
           FROM study.draw_order d JOIN study.frame f ON f.frame = d.frame AND f.sa_id = d.sa_id
          WHERE d.frame = $1 AND d.k <= 1000 AND f.tok AND f.n_spends >= 5
          ORDER BY d.k`,
        [frame, w.t_start, w.lo, w.hi])).rows;
      const quota = { B0: Infinity, B1: FIXED.quota_b1, B2: FIXED.quota_b2, B3: FIXED.quota_b3 };
      const taken = { B0: 0, B1: 0, B2: 0, B3: 0 };
      const drawn = { B0: 0, B1: 0, B2: 0, B3: 0 };
      const want = [];
      for (const r of cands) {
        const txs = (r.txs || []).map(Number);
        const u = Math.max(Number(r.start), Number(r.ref));
        const t = txs.length;
        const reaches = (e) => u >= e || t >= e;
        const g = reaches(4000) ? 'B3' : reaches(1000) ? 'B2' : reaches(250) ? 'B1' : 'B0';
        drawn[g]++;
        if (taken[g] >= quota[g]) continue;
        taken[g]++;
        want.push([Number(r.sa_id), Number(r.k), g, Number(r.start), Number(r.ref), t, t > 1000, t > 1000 ? txs[999] : Number(w.hi)]);
        if (want.length === 1000) break;
      }
      const got = (await c.query(`SELECT sa_id, draw_rank, size_group, n_utxo_start, n_utxo_ref, n_window_tx, capped, history_hi FROM study.sample WHERE frame = $1 ORDER BY draw_rank`, [frame])).rows
        .map((r) => [Number(r.sa_id), Number(r.draw_rank), r.size_group, Number(r.n_utxo_start), Number(r.n_utxo_ref), Number(r.n_window_tx), r.capped, Number(r.history_hi)]);
      assert.deepEqual(got, want, `${frame}: the sample`);
      const groups = b.report.draw_groups.filter((x) => x.frame === frame);
      assert.deepEqual(groups.map((x) => [x.size_group, x.n_drawn, x.n_taken]), ['B0', 'B1', 'B2', 'B3'].map((g) => [g, drawn[g], taken[g]]), `${frame}: D_k and A_k`);
      assert.deepEqual(groups.map((x) => x.quota), [null, FIXED.quota_b1, FIXED.quota_b2, FIXED.quota_b3]);
    }
    assert.deepEqual(b.manifest.draw_groups, b.report.draw_groups);

    // The shapes.
    const sa = {};
    for (const [k, v] of Object.entries(views)) sa[k] = await saIdOf(c, v);
    const row = async (frame, id) => (await c.query('SELECT * FROM study.frame WHERE frame = $1 AND sa_id = $2', [frame, id])).rows[0];
    const s1 = await row('recent', sa.S1);
    assert.ok(s1, 'S1 is in the recent frame');
    assert.equal(s1.tok, false, 'S1 is never token-holding');
    assert.equal(Number(s1.n_spends_any), 0);
    assert.equal(s1.eligible, true, 'S1 is eligible like any wallet');
    const s1Samples = (await c.query('SELECT frame, kind FROM study.sample WHERE sa_id = $1', [sa.S1])).rows;
    const s1Rank = (await c.query(`SELECT k, candidate FROM study.draw_order WHERE frame = 'recent' AND sa_id = $1`, [sa.S1])).rows[0];
    assert.ok(s1Rank, 'S1 is in the draw order');
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
    // Fewer than 5 spends: S1, S3 and M2 are never candidates, so never in
    // the sample.
    assert.equal(s1Rank.candidate, false);
    for (const k of ['S1', 'S3', 'M2']) {
      const n = Number((await c.query('SELECT count(*) AS n FROM study.sample WHERE sa_id = $1', [sa[k]])).rows[0].n);
      assert.equal(n, 0, `${k} is not in the sample`);
    }
    // S3 and M2 hold NFTs one unit to a UTxO, so neither is fragmented; every
    // sample row carries its frame's flag.
    assert.equal(s3.frag, false);
    assert.equal(m2.frag, false);
    const flagMismatch = (await c.query(`SELECT count(*) AS n FROM study.sample s JOIN study.frame f ON f.frame = s.frame AND f.sa_id = s.sa_id WHERE s.fragmented IS DISTINCT FROM f.frag`)).rows[0];
    assert.equal(Number(flagMismatch.n), 0);
    const s3peak = await row('peak', sa.S3);
    // The franken step covers the sampled wallets and nothing else.
    const frankenWallets = (await c.query('SELECT DISTINCT sa_id FROM study.franken ORDER BY 1')).rows.map((r) => String(r.sa_id));
    const sampledWallets = (await c.query('SELECT DISTINCT sa_id FROM study.sample ORDER BY 1')).rows.map((r) => String(r.sa_id));
    assert.ok(frankenWallets.every((x) => sampledWallets.includes(x)));
    const franken = (await c.query('SELECT sa_id, bool_or(flagged) AS f, max(n_creds) AS n FROM study.franken WHERE sa_id = ANY($1) GROUP BY sa_id', [[sa.S1, sa.S3, sa.M2]])).rows;
    assert.deepEqual(franken, [], 'the shapes are not sampled');

    // The reconstruction check ran with the direct read, for the sample.
    assert.equal(b.report.reconstruction_check.direct_valid, true);
    assert.equal(b.report.reconstruction_check.n_excluded, 0);

    // The profile features: f1 agrees with the frame's spend count, f5 is a
    // subset of the window's receipts, and f8 is the frame's UTxO count at
    // the window's end.
    assert.deepEqual([b.report.profile_check.spend_count_mismatch, b.report.profile_check.receipt_count_mismatch, b.report.profile_check.utxo_count_mismatch], [0, 0, 0]);

    // T12: every step of run A has a wall time and rows; explainable
    // statements carry their plan.
    const steps = a.timings.filter((t) => t.kind === 'step');
    assert.ok(steps.length >= 20);
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
      draw_key: b.report.freeze,
      windows: b.report.windows,
      flow: b.report.flow,
      frame_report: b.report.frame_report,
      draw: b.report.draw,
      draw_groups: b.report.draw_groups,
      draw_check: b.report.draw_check,
      split: b.report.split,
      split_overall: b.report.split_overall,
      sample_bounds: b.report.sample_bounds,
      own_drawn: own,
      pointer_wallets: b.report.pointer_wallets,
      probes: b.report.probes,
      era_coverage: b.report.era_coverage,
      prior: b.report.prior,
      franken: b.report.franken,
      reconstruction_check: b.report.reconstruction_check,
      profiles: b.report.profiles,
      shapes: {
        S1: { recent: { tok: s1.tok, eligible: s1.eligible, draw_rank: Number(s1Rank.k), candidate: s1Rank.candidate, n_tx: Number(s1.n_tx), n_spends_any: Number(s1.n_spends_any), samples: s1Samples } },
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
