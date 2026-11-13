// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The extraction's study_samples rows reach a history file's `sample` header
// field per frame (samplesFromRows, sampleMembership). Synthetic ids only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samplesFromRows, sampleMembership } from '../../../src/history/commands.mjs';

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
