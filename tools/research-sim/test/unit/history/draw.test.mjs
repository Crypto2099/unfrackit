// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The extraction's draw fields in the history stage (src/history/commands.mjs
// samplesFromRows, drawOf, drawRunLevel, studySamples; src/history/history.mjs
// drawEnd): hand-built study rows with known answers. Each size group, a
// wallet whose window holds exactly 1,000 transactions (not capped), one that
// holds 1,001 (capped, its history ending at its 1,000th), an uncapped wallet
// whose history ends at the window's last transaction, the run-level counts of
// two frames, and the refusal of an extraction run without the columns.
// Synthetic ids only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAll } from '../../../src/history/sqlfile.mjs';
import { Refusal } from '../../../src/history/db.mjs';
import { samplesFromRows, drawOf, drawRunLevel, studySamples, DRAW_MISSING } from '../../../src/history/commands.mjs';
import { drawEnd } from '../../../src/history/history.mjs';

const blocks = loadAll();
const CAP = 1000;
const WINDOW_HI = 5_000_000;

const ids = (n, step = 3) => Array.from({ length: n }, (_, i) => 1000 + i * step);

const SAMPLE = [1, 2, 3, 4, 5].map((id) => ({ sa_id: String(id), random: true, random_recent: true, random_peak: id === 5, stratum_recent: false, split: 'exploration', excluded: false }));
const DRAW = [
  { sa_id: '1', frame: 'recent', size_group: 'B0', n_window_tx: '40', capped: false, history_hi: String(WINDOW_HI) },
  { sa_id: '2', frame: 'recent', size_group: 'B1', n_window_tx: '260', capped: false, history_hi: String(WINDOW_HI) },
  { sa_id: '3', frame: 'recent', size_group: 'B2', n_window_tx: '1000', capped: false, history_hi: String(WINDOW_HI) },
  { sa_id: '4', frame: 'recent', size_group: 'B3', n_window_tx: '1001', capped: true, history_hi: '3998' },
  { sa_id: '5', frame: 'recent', size_group: 'B3', n_window_tx: '4200', capped: true, history_hi: '9000' },
  { sa_id: '5', frame: 'peak', size_group: 'B1', n_window_tx: '300', capped: false, history_hi: '77' }
];
const GROUPS = [
  { frame: 'peak', size_group: 'B0', quota: null, n_drawn: '700', n_taken: '700' },
  { frame: 'peak', size_group: 'B1', quota: '50', n_drawn: '120', n_taken: '50' },
  { frame: 'recent', size_group: 'B0', quota: null, n_drawn: '800', n_taken: '800' },
  { frame: 'recent', size_group: 'B1', quota: '100', n_drawn: '300', n_taken: '100' },
  { frame: 'recent', size_group: 'B2', quota: '10', n_drawn: '25', n_taken: '10' },
  { frame: 'recent', size_group: 'B3', quota: '2', n_drawn: '4', n_taken: '2' }
];
const SUMMARY = [
  { frame: 'peak', quota_scale: '0.5', sample_n: '1000', history_cap: '1000' },
  { frame: 'recent', quota_scale: '1', sample_n: '1000', history_cap: '1000' }
];

test('each size group, per wallet and frame, with the frame\'s cap', () => {
  const run = drawRunLevel(GROUPS, SUMMARY);
  const m = samplesFromRows(SAMPLE, DRAW, run);
  const want = (g, n, c, hi) => ({ sizeGroup: g, nWindowTx: n, capped: c, historyHi: hi, historyCap: CAP });
  assert.deepEqual(drawOf(m, 1, 'recent'), want('B0', 40, false, WINDOW_HI));
  assert.deepEqual(drawOf(m, 2, 'recent'), want('B1', 260, false, WINDOW_HI));
  assert.deepEqual(drawOf(m, 3, 'recent'), want('B2', 1000, false, WINDOW_HI));
  assert.deepEqual(drawOf(m, 4, 'recent'), want('B3', 1001, true, 3998));
  assert.deepEqual(drawOf(m, 5, 'recent'), want('B3', 4200, true, 9000));
  assert.deepEqual(drawOf(m, 5, 'peak'), want('B1', 300, false, 77));
  // Not in that frame's sample, not in any sample, a test window, no study tables.
  assert.equal(drawOf(m, 1, 'peak'), null);
  assert.equal(drawOf(m, 99, 'recent'), null);
  assert.equal(drawOf(m, 1, 'blocks:1-2'), null);
  assert.equal(drawOf(null, 1, 'recent'), null);
});

test('the run-level record holds each frame\'s counts and scale, and no weight', () => {
  const r = drawRunLevel(GROUPS, SUMMARY);
  assert.deepEqual(r.recent, {
    quotaScale: '1', sampleN: 1000, historyCap: 1000,
    groups: { B0: { quota: null, nDrawn: 800, nTaken: 800 }, B1: { quota: 100, nDrawn: 300, nTaken: 100 }, B2: { quota: 10, nDrawn: 25, nTaken: 10 }, B3: { quota: 2, nDrawn: 4, nTaken: 2 } }
  });
  assert.deepEqual(r.peak, { quotaScale: '0.5', sampleN: 1000, historyCap: 1000, groups: { B0: { quota: null, nDrawn: 700, nTaken: 700 }, B1: { quota: 50, nDrawn: 120, nTaken: 50 } } });
  assert.ok(!JSON.stringify(r).toLowerCase().includes('weight'));
  assert.throws(() => drawRunLevel([{ frame: 'other', size_group: 'B0', quota: null, n_drawn: '1', n_taken: '1' }], SUMMARY), /does not/);
});

test('a window of exactly 1,000 transactions is not capped; one of 1,001 ends at its 1,000th', () => {
  const exact = ids(1000);
  const d1000 = { nWindowTx: 1000, capped: false, historyHi: WINDOW_HI, historyCap: CAP };
  assert.equal(drawEnd(d1000, exact, WINDOW_HI), WINDOW_HI);
  const over = ids(1001);
  const d1001 = { nWindowTx: 1001, capped: true, historyHi: over[999], historyCap: CAP };
  assert.equal(drawEnd(d1001, over, WINDOW_HI), over[999]);
  assert.notEqual(over[999], over[1000]);
  // The same 1,000 transactions are not capped whatever the extraction says of T = 1,000.
  assert.throws(() => drawEnd({ ...d1000, capped: true, historyHi: exact[999] }, exact, WINDOW_HI), /marks the wallet capped/);
  assert.throws(() => drawEnd({ ...d1001, capped: false, historyHi: WINDOW_HI }, over, WINDOW_HI), /marks the wallet uncapped/);
});

test('an uncapped wallet ends at the window\'s last transaction; a wallet with no draw is unchanged', () => {
  const few = ids(40);
  assert.equal(drawEnd({ nWindowTx: 40, capped: false, historyHi: WINDOW_HI, historyCap: CAP }, few, WINDOW_HI), WINDOW_HI);
  assert.equal(drawEnd(null, few, WINDOW_HI), WINDOW_HI);
  assert.throws(() => drawEnd({ nWindowTx: 40, capped: false, historyHi: few[39], historyCap: CAP }, few, WINDOW_HI), /other than the window's last/);
});

test('a transaction count that differs from the extraction\'s T stops the wallet', () => {
  const some = ids(41);
  assert.throws(() => drawEnd({ nWindowTx: 40, capped: false, historyHi: WINDOW_HI, historyCap: CAP }, some, WINDOW_HI), /holds 41 transactions.*T is 40/);
  const over = ids(1001);
  assert.throws(() => drawEnd({ nWindowTx: 1001, capped: true, historyHi: over[1000], historyCap: CAP }, over, WINDOW_HI), /1000th window transaction is not/);
});

function fakeCtx({ usage = true, has_frame = true, has_draw = true } = {}) {
  const client = {
    async query(sql) {
      const s = String(sql);
      if (s.includes('AS has_frame')) return { rows: [{ usage, has_frame, has_draw }] };
      if (s.includes('bool_or(s.kind')) return { rows: SAMPLE };
      if (s.includes('s.history_hi')) return { rows: DRAW };
      if (s.includes('FROM study.draw_group')) return { rows: GROUPS };
      if (s.includes('FROM study.draw_summary')) return { rows: SUMMARY };
      throw new Error(`unexpected query: ${s.slice(0, 60)}`);
    }
  };
  return { client, blocks };
}

test('studySamples reads the draw and refuses an extraction run without its columns', async () => {
  const m = await studySamples(fakeCtx());
  assert.equal(drawOf(m, 4, 'recent').historyHi, 3998);
  assert.equal(m.drawRunLevel.recent.groups.B3.nTaken, 2);
  assert.equal(await studySamples(fakeCtx({ has_frame: false, has_draw: false })), null);
  await assert.rejects(studySamples(fakeCtx({ has_draw: false })), (e) => e instanceof Refusal && e.message === DRAW_MISSING && /rerun the extraction at e861aa0 or later/.test(e.message));
});
