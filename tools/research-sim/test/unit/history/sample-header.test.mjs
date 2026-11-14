// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The extraction's study_samples rows reach a history file's `sample` header
// field per frame (samplesFromRows, sampleMembership). Synthetic ids only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samplesFromRows, sampleMembership, drawOf } from '../../../src/history/commands.mjs';
import { DRAW_FLAGS } from '../../../src/history/history.mjs';

test('study_samples rows reach the header field per frame', () => {
  const rows = [
    { sa_id: '1', random: true, random_recent: true, random_peak: false, stratum_recent: false, split: 'exploration', excluded: false },
    { sa_id: '2', random: true, random_recent: false, random_peak: true, stratum_recent: false, split: 'exploration', excluded: false },
    { sa_id: '3', random: false, random_recent: false, random_peak: false, stratum_recent: false, split: 'exploration', excluded: false },
    { sa_id: '4', random: false, random_recent: false, random_peak: false, stratum_recent: true, split: 'exploration', excluded: false }
  ];
  const m = samplesFromRows(rows);
  assert.deepEqual(sampleMembership(m, 1), { recentRandom: true, peakRandom: false, recentStratum: false });
  assert.deepEqual(sampleMembership(m, 2), { recentRandom: false, peakRandom: true, recentStratum: false });
  assert.deepEqual(sampleMembership(m, 3), { recentRandom: false, peakRandom: false, recentStratum: false });
  assert.deepEqual(sampleMembership(m, 4), { recentRandom: false, peakRandom: false, recentStratum: true });
  assert.equal(m.get(2).random, true);
  assert.equal(sampleMembership(m, 9), null);
  assert.equal(sampleMembership(null, 1), null);
});

// The six per-wallet flags of study.sample, as study_sample_draw returns them,
// reach the `draw` the history header writes, under the column names.
const FLAGS = ['fragmented', 'franken_any', 'franken_no_cospend', 'unfrackit_user', 'evolution_tidied', 'prior_treated'];
const base = { frame: 'recent', size_group: 'B1', n_window_tx: '12', capped: false, history_hi: '900' };

test('the six study.sample flags reach the draw, each on its own', () => {
  assert.deepEqual(DRAW_FLAGS, FLAGS);
  const rows = [{ sa_id: '1', random: true, random_recent: true, random_peak: false, stratum_recent: false, split: 'exploration', excluded: false }, { sa_id: '2', random: true, random_recent: true, random_peak: false, stratum_recent: false, split: 'exploration', excluded: false }];
  for (const [i, k] of FLAGS.entries()) {
    const only = Object.fromEntries(FLAGS.map((f) => [f, f === k]));
    const none = Object.fromEntries(FLAGS.map((f) => [f, false]));
    const m = samplesFromRows(rows, [{ sa_id: '1', ...base, ...only }, { sa_id: '2', ...base, ...none }], null);
    const d = drawOf(m, 1, 'recent');
    for (const f of FLAGS) assert.equal(d[f], f === k, `${k} set: ${f}`);
    for (const f of FLAGS) assert.equal(drawOf(m, 2, 'recent')[f], false, `${k} unset on the other wallet (${i}): ${f}`);
  }
});

test('a null or absent flag column reads as false, and the other draw fields are kept', () => {
  const m = samplesFromRows([{ sa_id: '5', random: true, random_recent: true, random_peak: false, stratum_recent: false, split: null, excluded: false }], [{ sa_id: '5', ...base, fragmented: null }], null);
  const d = drawOf(m, 5, 'recent');
  for (const f of FLAGS) assert.equal(d[f], false);
  assert.equal(d.sizeGroup, 'B1');
  assert.equal(d.nWindowTx, 12);
  assert.equal(d.historyHi, 900);
});
