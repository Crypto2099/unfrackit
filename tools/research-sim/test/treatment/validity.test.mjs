// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The validity mode (`--validity`) of the replay engine on synthetic shapes:
//   - every transaction the kit passes is counted, CSL reads each one, and
//     each of the four negative controls is caught by its own check;
//   - the mode changes nothing else: the replay's spends, plans, bursts and
//     summary are equal with and without it once the summary's validity field
//     and the wall-clock fields are removed;
//   - a transaction checked against a state it does not spend from is a
//     failure that names its position, never a hash.
// Needs RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatment, skip } from '../lib/treatment.mjs';
import { loadSource } from '../../src/replay/source.mjs';
import { replay } from '../../src/replay/engine.mjs';
import { makeMethod } from '../../src/methods/registry.mjs';
import { newValidity, checkValidity, summarize } from '../../src/kit/validity.mjs';
import { assertClean } from '../../src/out/records.mjs';

const T = await treatment();

const strip = (v) => JSON.stringify(v, (k, x) => (k === 'ms' || k === 'validity' || k === 'built' ? undefined : typeof x === 'bigint' ? `${x}n` : x));

test('the validity mode counts every transaction, CSL reads them, the controls are caught, and no other field changes', { skip, timeout: 20 * 60 * 1000 }, async () => {
  const method = makeMethod(T, 'test-largest-first');
  for (const name of ['S1', 'CL1']) {
    const src = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const job = { arm: 'maintained-tidy', variant: 'default', repetition: 1, method, opts: { seed: 1, changePolicy: 'layout', collateralRule: 'ledger' }, settleEvery: 25 };
    const off = await replay(T, src.params, src, job);
    const on = await replay(T, src.params, src, { ...job, validity: true });
    assert.equal(strip(on), strip(off), `${name}: the validity mode changed a field`);
    assert.equal(off.summary.validity, undefined);
    const v = on.summary.validity;
    assert.ok(v.txs > 0, `${name}: no transaction counted`);
    assert.equal(v.failed, 0, JSON.stringify(v.failures));
    assert.equal(v.cslRead, v.txs);
    for (const k of ['fee', 'size', 'value', 'witnesses']) assert.equal(v.controls[k], v.txs, `${name}: control ${k}`);
    assertClean(on.summary);
  }
});

test('a transaction checked against a state it does not spend from fails with its position and no hash', { skip, timeout: 20 * 60 * 1000 }, async () => {
  const method = makeMethod(T, 'test-largest-first');
  const src = loadSource(T, { kind: 'shape', name: 'S1', stream: 'synthetic' });
  const r = await replay(T, src.params, src, { arm: 'observed', variant: 'default', repetition: 1, method, opts: { seed: 1, changePolicy: 'layout', collateralRule: 'ledger' }, settleEvery: 25, keepTx: true });
  const x = r.spends.find((s) => s.outcome === 'built');
  const v = newValidity(T.CSL);
  const seen = [];
  v.onFailure = (f) => seen.push(f);
  checkValidity(v, 'spend 0', 0, { utxos: new Map() }, src.params, x.built.txs[0].bytes, { resolve: () => undefined });
  assert.equal(v.failed, seen.length);
  assert.ok(v.failed > 0);
  const s = summarize(v);
  assert.equal(s.txs, 1);
  assert.deepEqual(s.failures[0].at, 'spend 0');
  assert.equal(s.failures[0].tx, 0);
  assertClean(s);
});
