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
//   cjs-rrri            methods/cjs.mjs: cardano-js-sdk's
//                       roundRobinRandomImprove
//   evo-lf              methods/evo.mjs: the Evolution SDK's builder at its
//                       defaults
//   blaze-wd            methods/blaze.mjs: Blaze's builder at its defaults,
//                       micahsSelector's wide-then-deep selection
//   lucid-lf            methods/lucid.mjs: Lucid Evolution's complete() at
//                       its defaults
//   mesh-rrri           methods/mesh.mjs: Mesh's builder at its default
//                       selector, with exact constraint callbacks
//   typhon-lp           methods/typhon.mjs: typhonjs's paymentTransaction,
//                       the shortest prefix of the list it is given
//   helios-sf           methods/helios.mjs: Helios's WalletHelper.selectUtxos
//                       at its smallest-first default, then build with the
//                       wallet's UTxOs as spares
//   cml-lf, cml-ri      methods/cml.mjs: Cardano Multiplatform Lib's
//                       LargestFirstMultiAsset and RandomImproveMultiAsset
//   cometa-lf           methods/cometa.mjs: Cometa's transaction builder at
//                       its defaults, cardano-c's large-first selector
//   lace-rrri           methods/lace.mjs: Lace's TransactionBuilder from the
//                       wallet's source (scripts/build-lace.mjs), its
//                       round-robin random-improve selector, seeded
//   adalite-lp          methods/adalite.mjs: AdaLite's send path from the
//                       wallet's source (scripts/build-adalite.mjs),
//                       Account.getTxPlan, the shortest prefix of its own
//                       order
//   yoroi-lf            methods/yoroi.mjs: the Yoroi wallet's send flow,
//                       built from its source by scripts/build-yoroi.mjs;
//                       made only when that build is present
//   apollo-macs         methods/apollo.mjs: Apollo's transaction builder at
//                       its defaults, MACSSelector, in a Go helper process
//                       (scripts/build-helpers.mjs apollo) through the bridge
//                       (methods/helper.mjs)
//   ccl-pw              methods/jvm.mjs: cardano-client-lib's QuickTx
//                       builder at its defaults, its page-wise default
//                       selection, in the JVM helper process
//   pycardano-lf        methods/pycardano.mjs: PyCardano's transaction
//                       builder at its defaults, LargestFirstSelector with
//                       its RandomImproveMultiAsset fallback, seeded, in a
//                       Python helper process (scripts/build-helpers.mjs
//                       pycardano) through the bridge
//   scalus-pool         methods/jvm.mjs: Scalus's TxBuilder.complete with
//                       the wallet's address as sponsor, in the JVM helper
//                       process (scripts/build-helpers.mjs jvm) through the
//                       bridge
//   unfrackit-h12       methods/h12.mjs, the planner settings as options
//   test-largest-first  methods/test-largest.mjs
//   test-stall          a method that blocks its thread (as a synchronous
//                       CSL call does) for stallMs, then fails; it exists to
//                       force the watchdogs (replay/pool.mjs). With `only` (a
//                       list of intent ids) it stalls on those and fails at
//                       once on every other
// A baseline runs at its library's defaults and the simulator's settings, so
// it takes no options. The builder survey's other subjects (the Evolution
// SDK's unfrack option, Mesh's selectors with Mesh's own callbacks;
// survey/survey.mjs) are not registered, so no run plan can name them. The adapters load with this
// module, and so in every worker.

import { testLargestMethod } from './test-largest.mjs';
import { h12Method } from './h12.mjs';
import { cslMethod } from './csl.mjs';
import { cjsMethod } from './cjs.mjs';
import { evoMethod } from './evo.mjs';
import { blazeMethod } from './blaze.mjs';
import { lucidMethod } from './lucid.mjs';
import { meshStudyMethod } from './mesh.mjs';
import { typhonMethod } from './typhon.mjs';
import { heliosMethod } from './helios.mjs';
import { cmlMethod } from './cml.mjs';
import { cometaMethod } from './cometa.mjs';
import { laceMethod } from './lace.mjs';
import { adaliteMethod } from './adalite.mjs';
import { yoroiMethod } from './yoroi.mjs';
import { apolloMethod } from './apollo.mjs';
import { cclMethod, scalusMethod } from './jvm.mjs';
import { pycardanoMethod } from './pycardano.mjs';
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

export const BASELINE_METHODS = Object.freeze(['csl-lf', 'csl-ri', 'cjs-rrri', 'evo-lf', 'blaze-wd', 'lucid-lf', 'mesh-rrri', 'typhon-lp', 'helios-sf', 'cml-lf', 'cml-ri', 'cometa-lf', 'lace-rrri', 'adalite-lp', 'yoroi-lf', 'apollo-macs', 'scalus-pool', 'ccl-pw', 'pycardano-lf']);

const FACTORIES = new Map([
  ['csl-lf', baseline('csl-lf', (T) => cslMethod(T, { strategy: 'lf' }))],
  ['csl-ri', baseline('csl-ri', (T) => cslMethod(T, { strategy: 'ri' }))],
  ['cjs-rrri', baseline('cjs-rrri', (T) => cjsMethod(T))],
  ['evo-lf', baseline('evo-lf', (T) => evoMethod({ T }))],
  ['blaze-wd', baseline('blaze-wd', (T) => blazeMethod(T))],
  ['lucid-lf', baseline('lucid-lf', (T) => lucidMethod({ T }))],
  ['mesh-rrri', baseline('mesh-rrri', (T) => meshStudyMethod(T))],
  ['typhon-lp', baseline('typhon-lp', (T) => typhonMethod(T))],
  ['helios-sf', baseline('helios-sf', (T) => heliosMethod(T))],
  ['cml-lf', baseline('cml-lf', (T) => cmlMethod(T, { strategy: 'lf' }))],
  ['cml-ri', baseline('cml-ri', (T) => cmlMethod(T, { strategy: 'ri' }))],
  ['cometa-lf', baseline('cometa-lf', (T) => cometaMethod(T))],
  ['lace-rrri', baseline('lace-rrri', (T) => laceMethod(T))],
  ['adalite-lp', baseline('adalite-lp', (T) => adaliteMethod(T))],
  ['yoroi-lf', baseline('yoroi-lf', (T) => yoroiMethod(T))],
  ['apollo-macs', baseline('apollo-macs', (T) => apolloMethod(T))],
  ['scalus-pool', baseline('scalus-pool', (T) => scalusMethod(T))],
  ['ccl-pw', baseline('ccl-pw', (T) => cclMethod(T))],
  ['pycardano-lf', baseline('pycardano-lf', (T) => pycardanoMethod(T))],
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
