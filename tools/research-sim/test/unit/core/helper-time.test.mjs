// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The helper's own time (methods/helper.mjs, the `ms` field of each build and
// witness response): every result a helper library returns after its helper
// answered carries `helper: { buildMs, witnessMs }`, numbers that are not
// negative, with `witnessMs` null where no witness request was made; a helper
// whose responses carry no `ms` gives nulls. The tests that run a helper skip,
// naming the build command, when it is not built.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { helperBuild, helperMethod } from '../../../src/methods/helper.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { classOfCslError } from '../../../src/methods/csl.mjs';
import { REPLAY_PARTS } from '../../../src/methods/library.mjs';
import { checkMethod } from '../../../src/methods/contract.mjs';
import { constructState, ADA } from '../../lib/construct.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { replayIntent, payTo as payToOf } from '../../lib/script-intents.mjs';
import { treatment, skip as noTreatment } from '../../lib/treatment.mjs';

const P = SYNTHETIC_PARAMS;
const T = noTreatment ? null : await treatment();
const own = { changePolicy: 'default', seed: 1 };
const payment = (requested) => replayIntent('p1', 100, { type: 'T1', requested, fixed: null });
const pay = (i, coin) => payToOf(T, i, coin, undefined);

// The seven helper libraries and the helper each runs.
const LIBRARIES = [
  ['apollo-macs', 'apollo'],
  ['ccl-pw', 'jvm'],
  ['scalus-pool', 'jvm'],
  ['pycardano-lf', 'pycardano'],
  ['tx3-vd', 'tx3'],
  ['kuber-prune', 'kuber'],
  ['cwallet-rrri', 'cwallet']
];

const nonNegative = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;

for (const [name, helper] of LIBRARIES) {
  const { problem } = helperBuild(helper);
  const skip = noTreatment || (problem ? `${name}: ${problem}` : false);

  test(`${name}: a built spend carries the helper's own build and witness time`, { skip }, async () => {
    const m = checkMethod(makeMethod(T, name));
    const s = constructState(T, [{ coin: 20n * ADA }, { coin: 9n * ADA }, { coin: 5n * ADA }]);
    const r = await m.build(s, payment([pay(0, 3n * ADA)]), P, own);
    assert.equal(r.ok, true, r.detail);
    assert.ok(r.helper && nonNegative(r.helper.buildMs), `buildMs ${JSON.stringify(r.helper)}`);
    assert.ok(nonNegative(r.helper.witnessMs), `witnessMs ${JSON.stringify(r.helper)}`);
  });

  test(`${name}: a failed build carries the helper's build time and no witness time`, { skip }, async () => {
    const m = checkMethod(makeMethod(T, name));
    const s = constructState(T, [{ coin: 5n * ADA }]);
    const r = await m.build(s, payment([pay(0, 500n * ADA)]), P, own);
    assert.equal(r.ok, false);
    assert.ok(r.helper && nonNegative(r.helper.buildMs), `buildMs ${JSON.stringify(r.helper)}`);
    assert.equal(r.helper.witnessMs, null);
  });
}

test('a helper whose responses carry no ms gives nulls, and a refusal before any request carries no helper field', { skip: noTreatment }, async () => {
  const direct = makeMethod(T, 'csl-lf');
  const m = checkMethod(helperMethod(T, {
    name: 'csl-lf',
    version: direct.version,
    deterministic: true,
    seeded: true,
    library: 'csl-lf',
    coverage: REPLAY_PARTS,
    classify: classOfCslError,
    refused: 'the bridged csl-lf takes its own change or the layout change only',
    process: { key: 'test-helper-time-csl', command: process.execPath, args: [fileURLToPath(new URL('../../lib/bridge-csl-helper.mjs', import.meta.url))], env: process.env }
  }));
  const s = constructState(T, [{ coin: 20n * ADA }, { coin: 9n * ADA }]);
  const r = await m.build(s, payment([pay(0, 3n * ADA)]), P, own);
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(r.helper, { buildMs: null, witnessMs: null });
  const refused = await m.build(s, payment([pay(0, 3n * ADA)]), P, { changePolicy: 'ladder', seed: 1 });
  assert.equal(refused.ok, false);
  assert.equal('helper' in refused, false);
});
