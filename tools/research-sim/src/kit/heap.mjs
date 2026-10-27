// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// CSL's asm.js heap. The simulator frees every CSL object it makes; objects
// the treatment's own code leaves to JavaScript are released by CSL's
// FinalizationRegistry, which runs only after a garbage collection and a turn
// of the event loop. Without both, the heap grows spend after spend and every
// later CSL call slows down, so the engine settles the heap between spends,
// as the treatment's own runners do. heapUsed reports the asm.js heap's size.

import v8 from 'node:v8';
import vm from 'node:vm';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

export async function settle() {
  for (let i = 0; i < 2; i++) {
    gc();
    await new Promise((r) => setImmediate(r));
  }
}

export const jsHeapUsed = () => process.memoryUsage().heapUsed;
