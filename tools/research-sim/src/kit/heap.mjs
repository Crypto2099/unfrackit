// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// CSL's asm.js heap. The simulator frees every CSL object it makes; objects
// the treatment's own code leaves to JavaScript are released by CSL's
// FinalizationRegistry, which runs only after a garbage collection and a turn
// of the event loop. Without both, the heap grows spend after spend and every
// later CSL call slows down, so the engine settles the heap between spends.
// The finalizers need idle time, not only a turn of the event loop. Measured
// on the 3,005-UTxO shape M2: building its plan grew from 0.7 to over 4
// seconds across eight builds with immediate turns only, and stayed at 0.2
// seconds with collections and short waits; across 24 H-12 spends each
// followed by a plan, the plan after grew to 32 seconds without settling,
// still drifted upward with two 5 ms waits, and held at 0.25 to 0.4 seconds
// with three 10 ms waits, the default.

import v8 from 'node:v8';
import vm from 'node:vm';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

export async function settle({ rounds = 3, ms = 10 } = {}) {
  for (let i = 0; i < rounds; i++) {
    gc();
    await new Promise((r) => setTimeout(r, ms));
  }
}
