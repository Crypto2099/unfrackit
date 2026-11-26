// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The extraction's pilot draw in the history stage: a pilot wallet's header
// `draw.kind` and `split`, the run-level `draw[F].pilot`, the refusal of an
// extraction run without the `kind` columns, and the wallets each plan reads.
// Hand-built rows, synthetic ids only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAll } from '../../../src/history/sqlfile.mjs';
import { Refusal } from '../../../src/history/db.mjs';
import { samplesFromRows, sampleMembership, drawOf, drawRunLevel, studySamples, fromStudyWallets, DRAW_MISSING } from '../../../src/history/commands.mjs';
import { fidelityFiles } from '../../../src/study/study.mjs';

const blocks = loadAll();
const row = (id, o) => ({ sa_id: String(id), random: false, random_recent: false, random_peak: false, stratum_recent: false, pilot: false, pilot_recent: false, pilot_peak: false, split: 'confirmation', excluded: false, ...o });
// 1 and 2 sampled (2 in both frames), 3 pilot in the recent frame, 4 pilot in both frames.
const SAMPLE = [
  row(1, { random: true, random_recent: true }),
  row(2, { random: true, random_recent: true, random_peak: true }),
  row(3, { pilot: true, pilot_recent: true, split: 'exploration' }),
  row(4, { pilot: true, pilot_recent: true, pilot_peak: true, split: 'exploration' })
];
const d = (sa, frame, kind, group) => ({ sa_id: String(sa), frame, kind, size_group: group, n_window_tx: '30', capped: false, history_hi: '900' });
const DRAW = [d(1, 'recent', 'random', 'B0'), d(2, 'recent', 'random', 'B1'), d(2, 'peak', 'random', 'B0'), d(3, 'recent', 'pilot', 'B1'), d(4, 'recent', 'pilot', 'B0'), d(4, 'peak', 'pilot', 'B0')];
const GROUPS = [
  { frame: 'recent', kind: 'random', size_group: 'B0', quota: null, n_drawn: '800', n_taken: '800' },
  { frame: 'recent', kind: 'random', size_group: 'B1', quota: '100', n_drawn: '300', n_taken: '100' },
  { frame: 'recent', kind: 'pilot', size_group: 'B0', quota: null, n_drawn: '90', n_taken: '89' },
  { frame: 'recent', kind: 'pilot', size_group: 'B1', quota: '10', n_drawn: '30', n_taken: '10' },
  { frame: 'peak', kind: 'random', size_group: 'B0', quota: null, n_drawn: '700', n_taken: '700' },
  { frame: 'peak', kind: 'pilot', size_group: 'B0', quota: null, n_drawn: '60', n_taken: '60' }
];
const SUMMARY = [
  { frame: 'recent', kind: 'random', quota_scale: '1', sample_n: '1000', history_cap: '1000' },
  { frame: 'recent', kind: 'pilot', quota_scale: '1', sample_n: '100', history_cap: '1000' },
  { frame: 'peak', kind: 'random', quota_scale: '0.5', sample_n: '1000', history_cap: '1000' },
  { frame: 'peak', kind: 'pilot', quota_scale: '0.5', sample_n: '100', history_cap: '1000' }
];

test('a pilot wallet is kind pilot and an exploration wallet; a sampled wallet is random and confirmation', () => {
  const m = samplesFromRows(SAMPLE, DRAW, drawRunLevel(GROUPS, SUMMARY));
  assert.equal(drawOf(m, 3, 'recent').kind, 'pilot');
  assert.equal(m.get(3).split, 'exploration');
  assert.equal(drawOf(m, 4, 'peak').kind, 'pilot');
  assert.equal(drawOf(m, 1, 'recent').kind, 'random');
  assert.equal(drawOf(m, 2, 'peak').kind, 'random');
  assert.equal(m.get(1).split, 'confirmation');
  assert.equal(drawOf(m, 3, 'peak'), null);
  assert.deepEqual(sampleMembership(m, 3), { recentRandom: false, peakRandom: false, recentStratum: false, recentPilot: true, peakPilot: false });
  assert.deepEqual(sampleMembership(m, 4), { recentRandom: false, peakRandom: false, recentStratum: false, recentPilot: true, peakPilot: true });
  assert.deepEqual(sampleMembership(m, 2), { recentRandom: true, peakRandom: true, recentStratum: false, recentPilot: false, peakPilot: false });
});

test('the run-level record keeps the sample\'s fields and holds the pilot\'s own beside them', () => {
  const r = drawRunLevel(GROUPS, SUMMARY);
  assert.deepEqual(r.recent.groups, { B0: { quota: null, nDrawn: 800, nTaken: 800 }, B1: { quota: 100, nDrawn: 300, nTaken: 100 } });
  assert.equal(r.recent.sampleN, 1000);
  assert.deepEqual(r.recent.pilot, { quotaScale: '1', sampleN: 100, historyCap: 1000, groups: { B0: { quota: null, nDrawn: 90, nTaken: 89 }, B1: { quota: 10, nDrawn: 30, nTaken: 10 } } });
  assert.deepEqual(r.peak.pilot, { quotaScale: '0.5', sampleN: 100, historyCap: 1000, groups: { B0: { quota: null, nDrawn: 60, nTaken: 60 } } });
  assert.deepEqual(r.peak.groups, { B0: { quota: null, nDrawn: 700, nTaken: 700 } });
  assert.throws(() => drawRunLevel([{ frame: 'peak', kind: 'pilot', size_group: 'B0', quota: null, n_drawn: '1', n_taken: '1' }], SUMMARY.filter((s) => !(s.frame === 'peak' && s.kind === 'pilot'))), /does not/);
  assert.throws(() => drawRunLevel([], SUMMARY.filter((s) => s.kind === 'pilot')), /pilot.*no sample/);
});

function fakeCtx({ has_draw = true } = {}) {
  const client = {
    async query(sql) {
      const s = String(sql);
      if (s.includes('AS has_frame')) return { rows: [{ usage: true, has_frame: true, has_draw }] };
      if (s.includes('bool_or(s.kind')) return { rows: SAMPLE };
      if (s.includes('s.history_hi')) return { rows: DRAW };
      if (s.includes('FROM study.draw_group')) return { rows: GROUPS };
      if (s.includes('FROM study.draw_summary')) return { rows: SUMMARY };
      throw new Error(`unexpected query: ${s.slice(0, 60)}`);
    }
  };
  return { client, blocks };
}

test('studySamples carries the pilot into the run-level record, and an extraction without kind is refused with the new message', async () => {
  const m = await studySamples(fakeCtx());
  assert.equal(m.drawRunLevel.recent.pilot.groups.B1.nDrawn, 30);
  await assert.rejects(studySamples(fakeCtx({ has_draw: false })), (e) => e instanceof Refusal && e.message === DRAW_MISSING && /rerun the extraction at 5fe47bc or later/.test(e.message) && /kind/.test(e.message));
});

test('the draw queries read both kinds, and has_draw counts the two kind columns', () => {
  const sql = (n) => blocks.get(n).text;
  assert.match(sql('study_sample_draw'), /s\.kind IN \('random', 'pilot'\)/);
  assert.match(sql('study_sample_draw'), /s\.kind,/);
  assert.match(sql('study_draw_groups'), /g\.kind/);
  assert.match(sql('study_draw_summary'), /d\.kind/);
  assert.match(sql('study_readable'), /'kind', 'quota_scale', 'sample_n', 'history_cap'/);
  assert.match(sql('study_readable'), /'kind', 'quota', 'n_drawn', 'n_taken'/);
  assert.match(sql('study_readable'), /= 18 AS has_draw/);
});

test('the corpus plan reads every wallet of a sample row and the exploration split is the pilot\'s wallets only', () => {
  const m = samplesFromRows(SAMPLE);
  assert.deepEqual(fromStudyWallets(m, 'random'), [1, 2]);
  assert.deepEqual(fromStudyWallets(m, 'all'), [1, 2, 3, 4]);
  const explore = [...m].filter(([, s]) => s.split === 'exploration').map(([id]) => id);
  assert.deepEqual(explore, [3, 4]);
  assert.deepEqual(explore, [...m].filter(([, s]) => s.pilot).map(([id]) => id));
  assert.ok(fromStudyWallets(m, 'random').every((id) => !m.get(id).pilot));
});

test('the fidelity check reads exactly the exploration (pilot) wallets\' history files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-hist-'));
  try {
    const m = samplesFromRows(SAMPLE);
    for (const [id, s] of m) writeFileSync(join(dir, `${id}.recent.jsonl`), JSON.stringify({ kind: 'header', split: s.split }) + '\n');
    const got = fidelityFiles([dir]).map((p) => p.slice(dir.length + 1));
    assert.deepEqual(got, ['3.recent.jsonl', '4.recent.jsonl']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
