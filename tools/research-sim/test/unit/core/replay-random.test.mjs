// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A replay job's one generator (replay/engine.mjs jobOptions): every build of
// a job draws from one mulberry32 stream seeded with the job's seed, in the
// order the engine makes the builds, the burst pass included; jobs with one
// seed in different arms start from the same values; a caller's own
// generator is refused. Needs RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatment, skip } from '../../lib/treatment.mjs';
import { replay, jobOptions } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { makeRng } from '../../../src/shapes/rng.mjs';

const T = await treatment();

// The test method, drawing 1, 2 or 3 values at each build in turn and
// recording them with the intent it builds.
function recording() {
  const tlf = makeMethod(T, 'test-largest-first');
  const builds = [];
  const m = {
    ...tlf,
    deterministic: false,
    build(state, intent, params, opts) {
      const n = 1 + (builds.length % 3);
      const values = [];
      for (let i = 0; i < n; i++) values.push(opts.random());
      builds.push({ id: intent.id, values });
      return tlf.build(state, intent, params, opts);
    }
  };
  return { m, builds };
}

const stream = (seed, n) => {
  const r = makeRng(seed);
  return Array.from({ length: n }, () => r.next());
};

const run = (source, method, arm, seed, extra = {}) => replay(T, source.params, source, { arm, variant: 'default', repetition: seed, method, opts: { seed, changePolicy: 'default', collateralRule: 'ledger', ...extra }, settleEvery: 25 });

test('a job\'s builds draw one stream, the burst pass in its place', { skip }, async () => {
  for (const name of ['S1', 'M8']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const { m, builds } = recording();
    const r = await run(source, m, 'observed', 7);
    const drawn = builds.flatMap((b) => b.values);
    assert.ok(builds.length > 5, name);
    assert.deepEqual(drawn, stream(7, drawn.length), `${name}: one stream from the seed, never restarted`);
    // The parallel burst: its pass builds both spends from the state at the
    // first spend, and the sequential replay then builds that spend and the
    // next, each draw following the last.
    const burst = source.events.filter((e) => e.kind === 'intent' && e.intent.burst && e.intent.burst.parallel).map((e) => e.intent.id);
    assert.equal(burst.length, 2);
    assert.deepEqual(r.bursts.map((b) => [b.spends, b.built]), [[2, 2]]);
    const ids = builds.map((b) => b.id);
    const at = ids.indexOf(burst[0]);
    assert.deepEqual(ids.slice(at, at + 4), [burst[0], burst[1], burst[0], burst[1]], name);
    assert.equal(ids.filter((x) => x === burst[0]).length, 2);
  }
});

test('jobs with one seed in different arms start from the same values, and seeds differ', { skip }, async () => {
  const source = loadSource(T, { kind: 'shape', name: 'S4', stream: 'synthetic' });
  const draws = {};
  for (const arm of ['observed', 'tidy-once', 'maintained-tidy']) {
    for (const seed of [1, 2]) {
      const { m, builds } = recording();
      await run(source, m, arm, seed);
      draws[`${arm} ${seed}`] = builds.flatMap((b) => b.values);
    }
  }
  for (const seed of [1, 2]) {
    const want = stream(seed, 1)[0];
    for (const arm of ['observed', 'tidy-once', 'maintained-tidy']) {
      const d = draws[`${arm} ${seed}`];
      assert.equal(d[0], want, `${arm}, seed ${seed}`);
      assert.deepEqual(d, stream(seed, d.length));
    }
  }
  assert.notEqual(draws['observed 1'][0], draws['observed 2'][0]);
});

test('the engine is a replay\'s only random source', { skip }, async () => {
  const source = loadSource(T, { kind: 'shape', name: 'S1', stream: 'synthetic' });
  const { m } = recording();
  await assert.rejects(run(source, m, 'observed', 1, { random: () => 0.5 }), /opts\.random is the engine's own/);
  await assert.rejects(replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: m, opts: { changePolicy: 'default', collateralRule: 'ledger' } }), /seed must be an integer/);
  const a = jobOptions({ seed: 3, changePolicy: 'default' });
  const b = jobOptions({ seed: 3, changePolicy: 'default' });
  assert.deepEqual([a.random(), a.random()], stream(3, 2));
  assert.equal(b.random(), stream(3, 1)[0], 'each job starts its own generator');
});
