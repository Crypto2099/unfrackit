// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The method registry: every study baseline is made by name, with its
// library's version and its deterministic and seeded flags; the pure-change
// arm is not registered; the builder survey's other subjects are refused;
// every name a run plan uses resolves; and the test roles still name only the
// test methods. Needs RESEARCH_SIM_TREATMENT_DIR for
// the baselines (CSL comes through the treatment).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMethod, methodNames, BASELINE_METHODS, TEST_METHODS } from '../../../src/methods/registry.mjs';
import { choosesOwnCollateral } from '../../../src/methods/contract.mjs';
import { CJS_VERSION } from '../../../src/methods/cjs.mjs';
import { EVO_VERSION } from '../../../src/methods/evo.mjs';
import { LUCID_VERSION } from '../../../src/methods/lucid.mjs';
import { MESH_VERSION, MESH_CJS_VERSION } from '../../../src/methods/mesh.mjs';
import { HELIOS_TX_UTILS_VERSION, HELIOS_LEDGER_VERSION } from '../../../src/methods/helios.mjs';
import { laceBuildProblem } from '../../../src/methods/lace.mjs';
import { windowPlan, expandJobs, STUDY_ROLES, TEST_ROLES } from '../../../src/arms/plan.mjs';
import { treatment, skip } from '../../lib/treatment.mjs';

const T = await treatment();

test('every study baseline is made by name, with its library version, determinism and seeding', { skip }, () => {
  // [version, deterministic, seeded]: csl-ri draws from a generator no caller
  // can seed; cjs-rrri is random and seeded by its run.
  const want = {
    'csl-lf': ['cardano-serialization-lib 17.0.0 LargestFirstMultiAsset', true, true],
    'csl-ri': ['cardano-serialization-lib 17.0.0 RandomImproveMultiAsset', false, false],
    'cjs-rrri': [`@cardano-sdk/input-selection ${CJS_VERSION} roundRobinRandomImprove`, false, true],
    'evo-lf': [`@evolution-sdk/evolution ${EVO_VERSION} largest-first`, true, true],
    'blaze-wd': ['@blaze-cardano/tx 0.15.4 with @blaze-cardano/sdk 0.3.3 micahsSelector', true, true],
    'lucid-lf': [`@lucid-evolution/lucid ${LUCID_VERSION} LargestFirst`, true, true],
    'mesh-rrri': [`@meshsdk/transaction ${MESH_VERSION} CardanoSdkInputSelector (@cardano-sdk/input-selection ${MESH_CJS_VERSION} roundRobinRandomImprove)`, false, true],
    'typhon-lp': ['@stricahq/typhonjs 4.0.0 paymentTransaction', true, true],
    'helios-sf': ['@helios-lang/tx-utils 0.6.42 with @helios-lang/ledger 0.7.24 selectSmallestFirst', true, true],
    'cml-lf': ['@dcspark/cardano-multiplatform-lib-nodejs 6.2.0 LargestFirstMultiAsset', true, true],
    'cml-ri': ['@dcspark/cardano-multiplatform-lib-nodejs 6.2.0 RandomImproveMultiAsset', false, false],
    'cometa-lf': ['@biglup/cometa 1.2.0 (cardano-c 1.2.0) large-first', true, true],
    'lace-rrri': ['lace 4d553bd (lace-extension 2.5.1) @lace-contract/cardano-context TransactionBuilder with RoundRobinRandomCoinSelector', false, true]
  };
  // Lace's method loads only with the build of the wallet's source; without
  // it, making the method names the build script.
  const laceProblem = laceBuildProblem();
  assert.deepEqual([...BASELINE_METHODS].sort(), Object.keys(want).sort());
  for (const [name, [version, deterministic, seeded]] of Object.entries(want)) {
    if (name === 'lace-rrri' && laceProblem) {
      assert.throws(() => makeMethod(T, name), /scripts\/build-lace\.mjs/);
      continue;
    }
    const m = makeMethod(T, name);
    assert.equal(m.name, name);
    assert.equal(m.version, version);
    assert.equal(m.deterministic, deterministic, name);
    assert.equal(m.seeded, seeded, name);
    assert.equal(choosesOwnCollateral(m), name === 'evo-lf' || name === 'lucid-lf', name);
    assert.throws(() => makeMethod(T, name, { bundleCoin: 'shortest' }), /takes no options/);
  }
  for (const name of ['unfrackit-h12', 'test-largest-first', 'test-stall']) assert.deepEqual([makeMethod(T, name).deterministic, makeMethod(T, name).seeded], [true, true], name);
  assert.equal(CJS_VERSION, '0.14.35');
  assert.equal(EVO_VERSION, '0.8.0');
  assert.deepEqual([MESH_VERSION, MESH_CJS_VERSION], ['1.9.1', '0.14.28']);
  assert.deepEqual([HELIOS_TX_UTILS_VERSION, HELIOS_LEDGER_VERSION], ['0.6.42', '0.7.24']);
});

test('the builder survey\'s other subjects are not registered', () => {
  for (const name of ['evo-unfrack', 'mesh-default', 'mesh-lf', 'csl-lf-pure', 'csl-ri-pure']) {
    assert.ok(!methodNames().includes(name), name);
    assert.throws(() => makeMethod(T, name), /unknown method/);
  }
});

test('every method a study plan names resolves, and the test roles name only the test methods', () => {
  const names = new Set(methodNames());
  const study = new Set();
  for (const w of ['recent', 'peak']) for (const needsCollateral of [false, true]) for (const j of expandJobs(windowPlan(w), { roles: STUDY_ROLES, needsCollateral })) study.add(j.method);
  // The replays run the thirteen libraries and UnFrack.It's H-12 rule.
  assert.deepEqual([...study].sort(), ['blaze-wd', 'cjs-rrri', 'cml-lf', 'cml-ri', 'cometa-lf', 'csl-lf', 'csl-ri', 'evo-lf', 'helios-sf', 'lace-rrri', 'lucid-lf', 'mesh-rrri', 'typhon-lp', 'unfrackit-h12']);
  for (const n of study) assert.ok(names.has(n), n);
  assert.deepEqual(Object.keys(STUDY_ROLES), ['lf', 'ri', 'rrri', 'evo', 'blaze-wd', 'lucid-lf', 'mesh-rrri', 'typhon-lp', 'helios-sf', 'cml-lf', 'cml-ri', 'cometa-lf', 'lace-rrri', 'h12']);
  for (const role of Object.keys(STUDY_ROLES)) assert.equal(TEST_ROLES[role], 'test-largest-first', role);
  const testJobs = expandJobs(windowPlan('recent'), { roles: TEST_ROLES, needsCollateral: true });
  assert.deepEqual([...new Set(testJobs.map((j) => j.method))], ['test-largest-first']);
  assert.deepEqual([...TEST_METHODS], ['test-largest-first', 'test-stall']);
});
