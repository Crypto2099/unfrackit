// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The method registry: every study baseline is made by name, with its
// library's version and its deterministic flag; the builder survey's other
// subjects are refused; every name a run plan uses resolves; and the test
// plans still name only the test methods. Needs RESEARCH_SIM_TREATMENT_DIR for
// the baselines (CSL comes through the treatment).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMethod, methodNames, BASELINE_METHODS, TEST_METHODS } from '../../../src/methods/registry.mjs';
import { choosesOwnCollateral } from '../../../src/methods/contract.mjs';
import { CJS_VERSION } from '../../../src/methods/cjs.mjs';
import { EVO_VERSION } from '../../../src/methods/evo.mjs';
import { windowPlan, testPlan, expandJobs, batteryPlan, STUDY_ROLES, TEST_ROLES } from '../../../src/arms/plan.mjs';
import { treatment, skip } from '../../lib/treatment.mjs';

const T = await treatment();

test('every study baseline is made by name, with its library version and determinism', { skip }, () => {
  const want = {
    'csl-lf': ['cardano-serialization-lib 13.2.1 LargestFirstMultiAsset', true],
    'csl-ri': ['cardano-serialization-lib 13.2.1 RandomImproveMultiAsset', false],
    'csl-lf-pure': ['cardano-serialization-lib 13.2.1 LargestFirstMultiAsset, prefer_pure_change', true],
    'csl-ri-pure': ['cardano-serialization-lib 13.2.1 RandomImproveMultiAsset, prefer_pure_change', false],
    'cjs-rrri': [`@cardano-sdk/input-selection ${CJS_VERSION} roundRobinRandomImprove`, false],
    'evo-lf': [`@evolution-sdk/evolution ${EVO_VERSION} largest-first`, true]
  };
  assert.deepEqual([...BASELINE_METHODS].sort(), Object.keys(want).sort());
  for (const [name, [version, deterministic]] of Object.entries(want)) {
    const m = makeMethod(T, name);
    assert.equal(m.name, name);
    assert.equal(m.version, version);
    assert.equal(m.deterministic, deterministic, name);
    assert.equal(choosesOwnCollateral(m), name === 'evo-lf', name);
    assert.throws(() => makeMethod(T, name, { bundleCoin: 'shortest' }), /takes no options/);
  }
  assert.equal(CJS_VERSION, '0.14.35');
  assert.equal(EVO_VERSION, '0.6.0');
});

test('the builder survey\'s other subjects are not registered', () => {
  for (const name of ['evo-unfrack', 'mesh-default', 'mesh-lf']) {
    assert.ok(!methodNames().includes(name), name);
    assert.throws(() => makeMethod(T, name), /unknown method/);
  }
});

test('every method a study plan names resolves, and the test plans name only the test methods', () => {
  const names = new Set(methodNames());
  const study = new Set();
  for (const w of ['recent', 'peak']) for (const needsCollateral of [false, true]) for (const j of expandJobs(windowPlan(w), { roles: STUDY_ROLES, needsCollateral })) study.add(j.method);
  // The replays run the three H-1 baselines and the Evolution SDK default,
  // never the prefer_pure_change arm.
  assert.deepEqual([...study].sort(), ['cjs-rrri', 'csl-lf', 'csl-ri', 'evo-lf']);
  const battery = batteryPlan();
  assert.deepEqual(battery.map((m) => [m.name, m.repetitions]), [['csl-lf', 1], ['csl-ri', 30], ['cjs-rrri', 30], ['evo-lf', 1], ['csl-lf-pure', 1], ['csl-ri-pure', 30], ['unfrackit-h12', 1]]);
  for (const n of [...study, ...battery.map((m) => m.name)]) assert.ok(names.has(n), n);
  for (const role of Object.keys(STUDY_ROLES)) assert.equal(TEST_ROLES[role], 'test-largest-first', role);
  const testJobs = expandJobs(testPlan(), { roles: { ...TEST_ROLES, test: 'test-largest-first' }, needsCollateral: true });
  assert.deepEqual([...new Set(testJobs.map((j) => j.method))], ['test-largest-first']);
  assert.deepEqual([...TEST_METHODS], ['test-largest-first', 'test-stall']);
});
