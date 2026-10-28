// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// T15. A full run at the snapshot the rule names, below the database tip: h
// from the stand-in's epoch rule (T10's), the snapshot the last block of
// epoch N - 1 before its stabilisation cutoff, with the first block of epoch N
// 2,160 blocks deep in the database and in Koios. Wallet state is read as of
// that block: the recent window ends there, the reconstruction check runs the
// reference query and the life table and skips the direct read (defined at
// the tip only), the shapes seeded before the snapshot land where T10 puts
// them, and the published 6.1 counts name no case wallet. own-drawn reads the
// finished run. This replaces the study tables T10 left; T14 runs after it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, blocks, record, S1_SEEDING_TX, TAG, SHAPES, FUNDER, seederAddress, stakeOf, saIdOf } from './env.mjs';
import { runPipeline, ownDrawn } from '../../src/pipeline.mjs';
import { q } from '../../src/db.mjs';

const STRATA = new URL('../fixtures/strata-preprod.json', import.meta.url).pathname;
const RUN_C = `${TAG}-c`;

test('T15 a full run at the rule snapshot, below the tip', { timeout: 4 * 3600 * 1000 }, async () => {
  const c = await db();
  try {
    const tip = (await q(c, blocks, 'tip_block'))[0];
    const views = Object.fromEntries(SHAPES.map((s) => [s, stakeOf(seederAddress(s)[0])]));
    views.funder = stakeOf(FUNDER);
    const r = await runPipeline({
      expectNetwork: 'preprod',
      runId: RUN_C,
      snapshot: 'rule',
      standInTx: S1_SEEDING_TX,
      strataList: STRATA,
      hmacKey: process.env.RESEARCH_CORPUS_TEST_HMAC_KEY,
      set: ['guard=1000'],
      caseWallets: [views.funder, views.S1],
      log: (s) => process.stderr.write(`  ${s}\n`)
    });
    const n = r.report.freeze.draw.n;
    const want = (await c.query(`SELECT id, block_no, encode(hash, 'hex') AS hash FROM block WHERE epoch_no = $1 AND epoch_slot_no < $2 ORDER BY id DESC LIMIT 1`, [n - 1, 432000 - 172800])).rows[0];
    const snap = r.report.snapshot;
    assert.equal(snap.chosen, 'rule');
    assert.equal(snap.hash, want.hash, 'the last block of epoch N - 1 before its cutoff');
    assert.ok(snap.block_no < Number(tip.block_no) - 2160, 'well below the tip');
    assert.equal(r.manifest.snapshot.rule.cutoff_slot, r.report.snapshot.rule.cutoff_slot);
    // The recent window ends at the snapshot.
    const t = (await q(c, blocks, 't_of_block', { block_id: { type: 'int', value: Number(want.id) } }))[0].t;
    assert.equal(Number(r.report.windows.recent.hi), Number(t));
    // The reconstruction check: two implementations, every sampled wallet
    // agreeing; the published counts carry no case-wallet figure.
    assert.equal(r.report.reconstruction_check.direct_valid, false);
    assert.equal(r.report.reconstruction_check.n_excluded, 0);
    assert.ok('n_case_wallets' in r.report.reconstruction_check);
    assert.ok(!('n_case_wallets' in r.manifest.reconstruction_check) && !('n_case_disagree' in r.manifest.reconstruction_check));
    // The shapes seeded before the snapshot.
    const row = async (id) => (await c.query(`SELECT tok, ge100 FROM study.frame WHERE frame = 'recent' AND sa_id = $1`, [id])).rows[0];
    const s3 = await row(await saIdOf(c, views.S3));
    const m2 = await row(await saIdOf(c, views.M2));
    assert.equal(s3.tok, true);
    assert.equal(m2.ge100, true);
    // own-drawn on the finished run.
    const own = await ownDrawn(c, RUN_C, [views.funder, views.S1]);
    assert.equal(own.listed, 2);
    record('T15', { run_dir: r.dir, snapshot: snap, tip_block_no: Number(tip.block_no), windows: r.report.windows, reconstruction_check: r.report.reconstruction_check, draw: r.report.draw, own_drawn: own });
  } finally {
    await c.end();
  }
});
