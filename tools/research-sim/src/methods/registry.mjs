// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Methods by name, so that a worker thread can make the method a job names.
// Each entry makes the method from the loaded treatment and the job's method
// options. The study's baselines register here beside the H-12 method; the
// test methods are never baselines and never appear in a study run's results
// (a run plan that names one is a test run).
//
//   csl-lf, csl-ri      methods/csl.mjs: cardano-serialization-lib's
//                       LargestFirstMultiAsset and RandomImproveMultiAsset
//   csl-lf-pure,        the same with prefer_pure_change set, the battery's
//   csl-ri-pure         sensitivity arm on change policy
//   cjs-rrri            methods/cjs.mjs: cardano-js-sdk's
//                       roundRobinRandomImprove
//   evo-lf              methods/evo.mjs: the Evolution SDK's builder at its
//                       defaults
//   unfrackit-h12       methods/h12.mjs, the planner settings as options
//   test-largest-first  methods/test-largest.mjs
//   test-stall          a method that never answers within any limit: it
//                       blocks its thread (as a synchronous CSL call does) for
//                       stallMs, then fails; it exists to force the time
//                       limits. With `only` (a list of intent ids) it stalls on
//                       those and fails at once on every other
// A baseline runs at its library's defaults and the simulator's settings, so
// it takes no options. The builder survey's other subjects (the Evolution
// SDK's unfrack option, Mesh's selectors; survey/survey.mjs) are not
// registered, so no run plan can name them. The adapters load with this
// module, and so in every worker.

import { testLargestMethod } from './test-largest.mjs';
import { h12Method } from './h12.mjs';
import { cslMethod } from './csl.mjs';
import { cjsMethod } from './cjs.mjs';
import { evoMethod } from './evo.mjs';
import { checkMethod } from './contract.mjs';
import { CLASSES } from '../kit/check.mjs';

export const TEST_METHODS = Object.freeze(['test-largest-first', 'test-stall']);

function stallMethod({ stallMs = 3600 * 1000, only = null } = {}) {
  return {
    name: 'test-stall',
    version: '1',
    deterministic: true,
    seeded: true,
    build(_state, intent) {
      if (only && !only.includes(intent.id)) return { ok: false, class: CLASSES.other, detail: 'not stalled' };
      const end = Date.now() + stallMs;
      while (Date.now() < end) {
        // Blocks the thread, as a synchronous library call does.
      }
      return { ok: false, class: CLASSES.other, detail: `stalled ${stallMs} ms` };
    }
  };
}

// A baseline's factory, refusing options.
const baseline = (name, make) => (T, o = {}) => {
  if (Object.keys(o).length) throw new Error(`method ${name} takes no options (given ${Object.keys(o).join(', ')})`);
  return make(T);
};

export const BASELINE_METHODS = Object.freeze(['csl-lf', 'csl-ri', 'csl-lf-pure', 'csl-ri-pure', 'cjs-rrri', 'evo-lf']);

const FACTORIES = new Map([
  ['csl-lf', baseline('csl-lf', (T) => cslMethod(T, { strategy: 'lf' }))],
  ['csl-ri', baseline('csl-ri', (T) => cslMethod(T, { strategy: 'ri' }))],
  ['csl-lf-pure', baseline('csl-lf-pure', (T) => cslMethod(T, { strategy: 'lf', preferPureChange: true }))],
  ['csl-ri-pure', baseline('csl-ri-pure', (T) => cslMethod(T, { strategy: 'ri', preferPureChange: true }))],
  ['cjs-rrri', baseline('cjs-rrri', (T) => cjsMethod(T))],
  ['evo-lf', baseline('evo-lf', () => evoMethod())],
  ['test-largest-first', (T) => testLargestMethod(T)],
  ['test-stall', (_T, o) => stallMethod(o)],
  ['unfrackit-h12', (T, o) => h12Method(T, o)]
]);

export function registerMethod(name, factory) {
  if (FACTORIES.has(name)) throw new Error(`method ${name} is already registered`);
  FACTORIES.set(name, factory);
}

export const methodNames = () => [...FACTORIES.keys()];

export function makeMethod(T, name, options = {}) {
  const f = FACTORIES.get(name);
  if (!f) throw new Error(`unknown method ${name} (known: ${methodNames().join(', ')})`);
  const m = checkMethod(f(T, options));
  if (m.name !== name) throw new Error(`the factory registered as ${name} made method ${m.name}`);
  return m;
}
