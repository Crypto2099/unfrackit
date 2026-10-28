// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Methods by name, so that a worker thread can make the method a job names.
// Each entry makes the method from the loaded treatment and the job's method
// options. The baseline adapters register here beside the H-12 method; the
// test methods are never baselines and never appear in a study run's results
// (a run plan that names one is a test run).
//
//   test-largest-first  methods/test-largest.mjs
//   test-stall          a method that never answers within any limit: it
//                       blocks its thread (as a synchronous CSL call does) for
//                       stallMs, then fails; it exists to force the time
//                       limits. With `only` (a list of intent ids) it stalls on
//                       those and fails at once on every other
//   unfrackit-h12       methods/h12.mjs, the planner settings as options

import { testLargestMethod } from './test-largest.mjs';
import { h12Method } from './h12.mjs';
import { checkMethod } from './contract.mjs';
import { CLASSES } from '../kit/check.mjs';

export const TEST_METHODS = Object.freeze(['test-largest-first', 'test-stall']);

function stallMethod({ stallMs = 3600 * 1000, only = null } = {}) {
  return {
    name: 'test-stall',
    version: '1',
    deterministic: true,
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

const FACTORIES = new Map([
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
  return checkMethod(f(T, options));
}
