// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Which batteries a snapshot file's wallet runs (battery/population.mjs), from
// its header's split and sample membership, and which methods run on which
// battery (the run list). No treatment is loaded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { batteriesOf, readHeader, assignPopulation, countPopulation } from '../../../src/battery/population.mjs';
import { batteryRuns } from '../../../src/battery/runner-core.mjs';
import { batteryPlan, STUDY_ROLES } from '../../../src/arms/plan.mjs';

const sample = (recentRandom, peakRandom, recentStratum) => ({ recentRandom, peakRandom, recentStratum });
const both = { standard: true, h10: true };

test('a file\'s batteries from its header, each case', () => {
  assert.deepEqual(batteriesOf({ split: 'exploration', sample: sample(true, false, false) }), { kind: 'standard-and-h10', batteries: both });
  // A random-sample wallet that is also in a stratum runs both.
  assert.deepEqual(batteriesOf({ split: 'exploration', sample: sample(true, false, true) }), { kind: 'standard-and-h10', batteries: both });
  assert.deepEqual(batteriesOf({ split: 'exploration', sample: sample(false, false, true) }), { kind: 'h10-only', batteries: { standard: false, h10: true } });
  assert.deepEqual(batteriesOf({ split: 'exploration', sample: sample(false, true, false) }), { kind: 'none', batteries: { standard: false, h10: false } });
  assert.deepEqual(batteriesOf({ split: 'confirmation', sample: sample(false, false, false) }), { kind: 'none', batteries: { standard: false, h10: false } });
  assert.deepEqual(batteriesOf({ split: null, sample: null }), { kind: 'no-sample', batteries: both });
  assert.deepEqual(batteriesOf({}), { kind: 'no-sample', batteries: both });
  assert.throws(() => batteriesOf({ split: 'exploration', sample: null }, '7.snapshot.jsonl'), /7\.snapshot\.jsonl.*rerun history/);
  assert.throws(() => batteriesOf({ split: 'exploration' }, '7.snapshot.jsonl'), /rerun history/);
  // Unit 14's form, without the stratum flag.
  assert.throws(() => batteriesOf({ split: 'exploration', sample: { recentRandom: true, peakRandom: false } }, '8.snapshot.jsonl'), /8\.snapshot\.jsonl.*rerun history/);
  assert.throws(() => batteriesOf({ split: null, sample: { recentRandom: true, recentStratum: 1 } }, 'x'), /rerun history/);
});

test('files are decided before any runs, a refused file refuses the set, and the counts name no wallet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'research-sim-population-'));
  try {
    const put = (name, header) => {
      const path = join(dir, name);
      writeFileSync(path, `${JSON.stringify({ kind: 'header', wallet: 1, ...header })}\n${JSON.stringify({ kind: 'state', utxos: [] })}\n`);
      return { spec: { kind: 'history', path, analysisFreezeTx: null } };
    };
    const ok = [
      put('a.jsonl', { split: 'exploration', sample: sample(true, false, false) }),
      put('b.jsonl', { split: 'exploration', sample: sample(false, false, true) }),
      put('c.jsonl', { split: 'exploration', sample: sample(false, true, false) }),
      put('d.jsonl', { split: null, sample: null }),
      { spec: { kind: 'shape', name: 'S1', stream: null } }
    ];
    assert.equal(readHeader(ok[0].spec.path).wallet, 1);
    const decided = assignPopulation(ok);
    assert.deepEqual(decided.map((w) => w.population.kind), ['standard-and-h10', 'h10-only', 'none', 'no-sample', 'no-sample']);
    assert.deepEqual(countPopulation(decided), { files: 5, 'standard-and-h10': 1, 'h10-only': 1, none: 1, 'no-sample': 2 });
    const bad = put('e.jsonl', { split: 'exploration', sample: { recentRandom: true, peakRandom: false } });
    assert.throws(() => assignPopulation([...ok, bad]), /e\.jsonl.*rerun history/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A battery's spends as the worker lists them.
const spends = (list) => list.map((battery, n) => ({ n, battery, intent: { id: `s${n}` } }));
const perSpend = (runs) => {
  const m = new Map();
  for (const r of runs) m.set(r.spend, (m.get(r.spend) || 0) + 1);
  return m;
};

test('runs per spend: 95 on the standard battery, 61 on H-10\'s, with the three baselines only on H-10', () => {
  const methods = batteryPlan({ roles: STUDY_ROLES, reps: 30 });
  const list = spends(['standard', 'standard', 'h10', 'h10', 'h10']);
  const runs = batteryRuns(list, methods);
  assert.deepEqual([...perSpend(runs)], [[0, 95], [1, 95], [2, 61], [3, 61], [4, 61]]);
  assert.deepEqual([...new Set(runs.filter((r) => list[r.spend].battery === 'h10').map((r) => r.method))].sort(), ['cjs-rrri', 'csl-lf', 'csl-ri']);
  assert.deepEqual([...new Set(runs.filter((r) => list[r.spend].battery === 'standard').map((r) => r.method))].sort(), ['cjs-rrri', 'csl-lf', 'csl-lf-pure', 'csl-ri', 'csl-ri-pure', 'evo-lf', 'unfrackit-h12']);
  assert.deepEqual(runs.map((r) => r.k), runs.map((_, i) => i));
  // A wallet with H-10's battery only: numbered from 0, 61 runs per spend.
  const only = batteryRuns(spends(['h10', 'h10']), methods);
  assert.equal(only.length, 122);
  // The parent's rebuild from the worker's list (spend numbers, batteries and
  // ids) gives the same runs, the unsettled spends skipped.
  const worker = spends(['standard', 'standard', 'h10']);
  const rebuilt = worker.map((s) => ({ n: s.n, battery: s.battery, intent: s.n === 1 ? null : { id: s.intent.id } }));
  assert.deepEqual(batteryRuns(rebuilt, methods), batteryRuns(worker.map((s) => (s.n === 1 ? { ...s, intent: null } : s)), methods));
});

test('the test methods, which name no battery, run on every spend', () => {
  const methods = [{ name: 'test-largest-first', opts: [{ changePolicy: 'layout' }, { changePolicy: 'single' }], repetitions: 1 }, { name: 'unfrackit-h12', opts: [{ changePolicy: 'default', absorb: true }, { changePolicy: 'default', absorb: false }], repetitions: 1 }];
  const runs = batteryRuns(spends(['standard', 'h10', 'h10']), methods);
  assert.deepEqual([...perSpend(runs)], [[0, 4], [1, 4], [2, 4]]);
});
