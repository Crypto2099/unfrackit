// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The warm-up build (replay/warmup.mjs): a throwaway build of a fixed, tiny
// wallet before a method's first build in a process. Every method the study
// runs builds the warm-up wallet at the synthetic parameters, helper-backed
// ones included (a helper whose build is missing makes the test fail, naming
// the build command); the
// warm-up never draws from the job's generator, so a job's records are the
// same with and without it; a warm-up that fails or throws changes nothing of
// a job's records or counts, and its time lands beside the timing row of the
// first spend after it and nowhere else. Needs RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treatment, skip } from '../../lib/treatment.mjs';
import { warmUp, warmUpCase, warmedOnce, resetWarmUp, setWarmUp, WARM_SEED } from '../../../src/replay/warmup.mjs';
import { replay } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { makeMethod, BASELINE_METHODS } from '../../../src/methods/registry.mjs';
import { RunError } from '../../../src/methods/contract.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { addressBytes } from '../../../src/history/address.mjs';
import { record, prepare } from '../../../src/out/records.mjs';
import { runJob } from '../../../src/replay/run.mjs';
import { SpoolStream, spoolPaths } from '../../../src/out/spool.mjs';

const T = await treatment();

// A method the replay can be told is the warm-up's: its build fails, or
// throws, for the warm-up intent alone.
const warmId = (T && warmUpCase(SYNTHETIC_PARAMS).intent.id) || null;
function sabotaged(m, how) {
  const seen = [];
  return {
    seen,
    method: {
      ...m,
      build(state, intent, params, opts) {
        seen.push(intent.id === warmId ? 'warm-up' : 'build');
        if (intent.id === warmId) {
          if (how === 'fail') return { ok: false, class: CLASSES.other, detail: 'warm-up failed' };
          if (how === 'throw') throw new Error('warm-up threw');
          if (how === 'run-error') throw new RunError('warm-up helper gone');
        }
        return m.build(state, intent, params, opts);
      }
    }
  };
}

const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'ms' ? undefined : typeof x === 'bigint' ? x.toString() : x)));
const run = (source, method, extra = {}) => {
  const times = [];
  const events = [];
  return replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 3, method, opts: { seed: 3, changePolicy: 'default', collateralRule: 'ledger' }, settleEvery: 25, onSpend: (rec, _checks, t) => times.push([rec.intent, t]), onBuild: (on) => events.push(on), ...extra }).then((out) => ({ out, times, events }));
};
const S1 = () => loadSource(T, { kind: 'shape', name: 'S1', stream: 'synthetic' });

test('every method the study runs builds the warm-up wallet at the synthetic parameters, under both change policies', { skip, timeout: 4 * 60 * 1000 }, async () => {
  const cases = [...BASELINE_METHODS.map((name) => [name, {}, ['default', 'layout']]), ['unfrackit-h12', { absorb: true }, ['default']], ['unfrackit-h12', { absorb: false }, ['default']]];
  assert.equal(BASELINE_METHODS.length, 23);
  for (const [name, extra, policies] of cases) {
    for (const changePolicy of policies) {
      const r = await warmUp(makeMethod(T, name), SYNTHETIC_PARAMS, { seed: 5, changePolicy, collateralRule: 'ledger', ...extra });
      assert.equal(r.ok, true, `${name} ${JSON.stringify(extra)} ${changePolicy}`);
      assert.ok(r.ms >= 0);
    }
  }
});

test('the warm-up wallet carries the run\'s network id and nothing a real wallet can hold', { skip }, async () => {
  for (const [network, id] of [['mainnet', 1], ['preprod', 0], ['synthetic', 1]]) {
    const { state, intent } = warmUpCase({ ...SYNTHETIC_PARAMS, network });
    assert.equal(state.network, network);
    assert.equal(state.utxos.size, 5);
    assert.equal([...state.utxos.values()].filter((u) => u.assets.length).length, 1);
    assert.equal(intent.requested.length, 1);
    assert.equal(intent.fixed, null);
    assert.equal(intent.collateral.required, false);
    for (const a of [state.changeAddress, intent.requested[0].address]) assert.equal(addressBytes(a)[0] & 15, id);
    for (const u of state.utxos.values()) assert.match(u.ref, /^[0-9a-f]{64}#[0-4]$/);
  }
  const a = warmUpCase(SYNTHETIC_PARAMS);
  const b = warmUpCase(SYNTHETIC_PARAMS);
  assert.deepEqual([...a.state.utxos.keys()], [...b.state.utxos.keys()], 'the same wallet every time');
  const r = await warmUp(makeMethod(T, 'csl-lf'), { ...SYNTHETIC_PARAMS, network: 'preprod' }, { seed: 1, changePolicy: 'default', collateralRule: 'ledger' });
  assert.equal(r.ok, true);
});

test('the warm-up draws nothing from the job\'s generator: a seeded JavaScript library and a seeded helper library give the same records with and without it', { skip, timeout: 4 * 60 * 1000 }, async () => {
  for (const name of ['cjs-rrri', 'cwallet-rrri']) {
    const source = S1();
    setWarmUp(false);
    const off = await run(source, makeMethod(T, name));
    setWarmUp(true);
    resetWarmUp();
    const on = await run(source, makeMethod(T, name));
    assert.ok(on.times[0][1] && typeof on.times[0][1].warmUpMs === 'number', `${name}: the warm-up ran`);
    assert.ok(off.out.spends.length > 5, name);
    assert.deepEqual(strip(on.out.spends), strip(off.out.spends), `${name}: spends`);
    assert.deepEqual(strip(on.out.summary), strip(off.out.summary), `${name}: summary`);
    assert.equal(JSON.stringify(strip(on.out.bursts)), JSON.stringify(strip(off.out.bursts)), `${name}: bursts`);
    assert.ok(on.out.spends.some((s) => s.outcome === 'built'), name);
  }
  resetWarmUp();
});

test('the warm-up is one throwaway build per method per process, told to onBuild as a build, before the first build', { skip }, async () => {
  const source = S1();
  resetWarmUp();
  const first = sabotaged(makeMethod(T, 'test-largest-first'), 'none');
  const a = await run(source, first.method);
  assert.deepEqual(first.seen.slice(0, 2), ['warm-up', 'build']);
  assert.equal(first.seen.filter((x) => x === 'warm-up').length, 1);
  assert.equal(a.events.length, 2 * first.seen.length, 'onBuild is told of every build, the warm-up included');
  assert.deepEqual(a.events.slice(0, 4), [true, false, true, false]);
  const again = sabotaged(makeMethod(T, 'test-largest-first'), 'none');
  const b = await run(source, again.method);
  assert.equal(again.seen.filter((x) => x === 'warm-up').length, 0, 'a method warmed in this process is not warmed again, whatever object makes it');
  assert.ok(b.times.every(([, t]) => t === null));
  resetWarmUp();
  assert.equal(await warmedOnce(makeMethod(T, 'test-largest-first'), SYNTHETIC_PARAMS, { seed: 1, changePolicy: 'default', collateralRule: 'ledger' }).then((r) => r.ok), true);
  assert.equal(await warmedOnce(makeMethod(T, 'test-largest-first'), SYNTHETIC_PARAMS, { seed: 1, changePolicy: 'default', collateralRule: 'ledger' }), null);
  resetWarmUp();
});

test('a warm-up that fails or throws leaves the job\'s records and counts as they are; a run error stops the job as the first build would', { skip }, async () => {
  const source = S1();
  setWarmUp(false);
  const off = await run(source, makeMethod(T, 'test-largest-first'));
  setWarmUp(true);
  for (const how of ['none', 'fail', 'throw']) {
    resetWarmUp();
    const s = sabotaged(makeMethod(T, 'test-largest-first'), how);
    const on = await run(source, s.method);
    assert.deepEqual(strip(on.out.spends), strip(off.out.spends), how);
    assert.deepEqual(strip(on.out.summary), strip(off.out.summary), how);
    assert.equal(on.out.summary.counts.built + on.out.summary.counts.failed + on.out.summary.counts.notReplayable <= on.out.summary.counts.intents, true);
    const timed = on.times.filter(([, t]) => t !== null);
    assert.deepEqual(timed.map(([i]) => i), [on.times[0][0]], `${how}: the time lands on the first spend only`);
    assert.equal(typeof timed[0][1].warmUpMs, 'number');
  }
  resetWarmUp();
  const dead = sabotaged(makeMethod(T, 'test-largest-first'), 'run-error');
  await assert.rejects(run(source, dead.method), (e) => e instanceof RunError);
  resetWarmUp();
});

test('through runJob, a slow warm-up\'s time is in the first spend\'s timing row, outside its ms, and in no later row', { skip, timeout: 60 * 1000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'research-sim-warmup-job-'));
  try {
    const tlf = makeMethod(T, 'test-largest-first');
    const slow = {
      ...tlf,
      async build(state, intent, params, opts) {
        if (intent.id === warmId) await new Promise((r) => setTimeout(r, 200));
        return tlf.build(state, intent, params, opts);
      }
    };
    resetWarmUp();
    const source = S1();
    const key = { wallet: source.wallet, window: source.window, arm: 'observed', variant: 'default', method: 'test-largest-first', change: 'default', collateral: 'ledger', repetition: 1 };
    const job = { arm: 'observed', variant: 'default', repetition: 1, opts: { seed: 1, changePolicy: 'default', collateralRule: 'ledger' }, settleEvery: 25, key, hypotheses: [], planned: 99, machine: 'rig', spool: spoolPaths(dir, 1) };
    const r = await runJob(T, source, job, slow, {});
    const rows = readFileSync(r.spooled.timings, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const spends = rows.filter((x) => x.kind === 'spend');
    assert.ok(spends.length > 3);
    assert.ok(spends[0].times.warmUpMs >= 200, `warmUpMs ${spends[0].times.warmUpMs}`);
    assert.ok(spends[0].times.ms < 100, `ms ${spends[0].times.ms}`);
    assert.equal(rows.filter((x) => 'warmUpMs' in x.times).length, 1);
    assert.equal(readFileSync(r.spooled.records, 'utf8').includes('warmUp'), false);
  } finally {
    resetWarmUp();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the warm-up\'s time is in the timing row of the spend it preceded and no record line changes', () => {
  const key = { wallet: 'S1', window: 'synthetic', arm: 'observed', variant: 'default', method: 'm', change: 'default', collateral: 'ledger', repetition: 1 };
  const dir = mkdtempSync(join(tmpdir(), 'research-sim-warmup-'));
  try {
    const write = (name, extras) => {
      const paths = spoolPaths(dir, name);
      const s = new SpoolStream(paths, { eager: true });
      extras.forEach((x, i) => s.add(record('spend', key, { intent: i, outcome: 'built', fee: 1n, ms: 2 + i }), x));
      s.close();
      return { records: readFileSync(paths.records, 'utf8'), timings: readFileSync(paths.timings, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
    };
    const plain = write('a', [null, null, null]);
    const warm = write('b', [{ warmUpMs: 9.5 }, null, null]);
    assert.equal(warm.records, plain.records, 'no record line changes');
    assert.equal(warm.timings.length, plain.timings.length, 'no row is added');
    assert.deepEqual(warm.timings.map((r) => r.times), [{ ms: 2, warmUpMs: 9.5 }, { ms: 3 }, { ms: 4 }]);
    assert.deepEqual(plain.timings.map((r) => r.times), [{ ms: 2 }, { ms: 3 }, { ms: 4 }]);
    assert.equal(prepare(record('spend', key, { intent: 0, ms: 1 })).line.includes('warmUp'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the warm-up\'s seed is fixed', () => {
  assert.equal(WARM_SEED, 1);
});
