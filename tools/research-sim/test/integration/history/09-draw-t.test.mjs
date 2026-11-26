// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The extraction's T against the simulator's own window transaction count.
// T is study.sample's n_window_tx, the extraction's count of the window's
// transactions that create or consume an output carrying the wallet's stake
// credential. The history stage counts the same set from its reconstruction
// and, for a wallet whose header carries a draw, stops with a history-check
// error when the count, the capped flag or the cap-th transaction differs
// (drawEnd in src/history/history.mjs). A live-fire run reads no study table,
// so only this test, over an extraction run whose study tables are readable,
// compares the two on real rows.
//
// The history stage runs with --from-study all (every wallet of a study.sample
// row, the random samples' and the pilots' wallets) over both windows of the
// extraction run. The test requires the stage to end without a history-check
// stop, every wallet and frame of the extraction's draw to carry its draw
// fields in the header, and the end record of each to agree with them. It
// reports counts only: no wallet, address or transaction is written. The
// wallet-level history files are deleted at the end.
//
// Environment, besides env.mjs's:
//   RESEARCH_SIM_EXTRACTION_RUN   params.json of a preprod extraction run (tools/research-corpus at 5fe47bc or later)
//                                 whose study tables are still in the database, read by a role that can read them
//                                 (the test is skipped when it is not set)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { context, record, TAG } from './env.mjs';
import { cmdHistory, studySamples } from '../../../src/history/commands.mjs';
import { runDir, historyDir } from '../../../src/history/paths.mjs';

const EXTRACTION_RUN = process.env.RESEARCH_SIM_EXTRACTION_RUN;
const FRAMES = ['recent', 'peak'];

const firstLine = (path) => {
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text.slice(0, text.indexOf('\n')));
};
const lastLine = (path) => {
  const text = readFileSync(path, 'utf8').trimEnd();
  return JSON.parse(text.slice(text.lastIndexOf('\n') + 1));
};

test('the history stage over a preprod extraction run agrees with the extraction\'s T', { skip: EXTRACTION_RUN ? false : 'RESEARCH_SIM_EXTRACTION_RUN is not set', timeout: 3 * 3600 * 1000 }, async () => {
  const runId = `${TAG}-09`;
  const ctx = await context({ extractionRun: EXTRACTION_RUN });
  let samples;
  try {
    samples = await studySamples(ctx);
  } finally {
    await ctx.client.end();
  }
  assert.ok(samples, 'the study tables are not readable by this role');
  assert.ok(samples.size > 0, 'study.sample holds no wallet');

  try {
    const summary = await cmdHistory({
      expectNetwork: 'preprod',
      extractionRun: EXTRACTION_RUN,
      treatment: process.env.RESEARCH_SIM_TREATMENT_DIR,
      treatmentPins: process.env.RESEARCH_SIM_TREATMENT_PINS,
      runId,
      fromStudy: 'all',
      window: FRAMES,
      analysisFreezeTx: 'preprod-t-check'
    });
    assert.equal(summary.studyTables, 'read');
    assert.equal(summary.runs.length, samples.size * FRAMES.length, 'every wallet is read over both windows');

    const out = { wallets: samples.size, frames: {}, notInFrame: 0 };
    for (const f of FRAMES) out.frames[f] = { checked: 0, random: 0, pilot: 0, capped: 0, uncapped: 0 };
    for (const r of summary.runs) {
      const path = join(historyDir('preprod', runId), r.file);
      const header = firstLine(path);
      const end = lastLine(path);
      const expected = samples.get(r.wallet).draw[r.window] || null;
      if (!expected) {
        // The wallet is sampled in the other frame only.
        assert.equal(header.draw, null, `${r.file}: a wallet outside the frame's sample carries a draw`);
        out.notInFrame++;
        continue;
      }
      assert.ok(header.draw, `${r.file}: the header carries no draw`);
      assert.equal(header.draw.nWindowTx, expected.nWindowTx);
      assert.equal(header.draw.capped, expected.capped);
      assert.equal(header.draw.historyHi, expected.historyHi);
      assert.equal(header.draw.sizeGroup, expected.sizeGroup);
      assert.equal(end.kind, 'end');
      assert.equal(end.capped, expected.capped);
      assert.equal(end.at.tx, expected.historyHi);
      // The simulator's own count of the window's transactions up to the history end.
      assert.equal(r.windowTx, expected.capped ? expected.historyCap : expected.nWindowTx, `${r.file}: the simulator's window transaction count differs from the extraction's`);
      const c = out.frames[r.window];
      c.checked++;
      c[expected.kind === 'pilot' ? 'pilot' : 'random']++;
      c[expected.capped ? 'capped' : 'uncapped']++;
    }
    for (const f of FRAMES) assert.ok(out.frames[f].checked > 0, `no wallet of the ${f} frame was checked`);
    record('09-draw-t', out);
    console.log(JSON.stringify(out));
  } finally {
    rmSync(runDir('preprod', runId), { recursive: true, force: true });
  }
});
