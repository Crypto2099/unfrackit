// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// CSL's WebAssembly memory. The simulator frees every CSL object it makes;
// objects the treatment's own code leaves to JavaScript are released by CSL's
// FinalizationRegistry, which runs only after a garbage collection and a turn
// of the event loop. Without both, those objects pile up spend after spend
// and later CSL calls slow down, so the engine settles the heap between
// spends. A settle forces two full collections, each followed by a turn of
// the event loop, and only when the process's external and ArrayBuffer memory
// (where WebAssembly memory is counted) has grown by GROWTH_BYTES since the
// last settle: a forced full collection costs about as much as a plan build,
// and with many workers the collections queue for V8's shared helper threads,
// so a settle that finds nothing to release is pure loss. With the earlier
// fixed settle (three collections with 10 ms waits, after every plan and
// every 25 spends), collection was 65% of all CPU time at 12 workers; this
// one holds a worker's external memory to about 50 MiB above its settled size,
// and a worker is replaced after 40 jobs (replay/pool.mjs).

import v8 from 'node:v8';
import vm from 'node:vm';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

const GROWTH_BYTES = 48 * 1024 * 1024;
const turn = () => new Promise((r) => setImmediate(r));
const external = () => {
  const m = process.memoryUsage();
  return m.external + m.arrayBuffers;
};

let settled = 0;

export async function settle({ growth = GROWTH_BYTES, rounds = 2 } = {}) {
  const now = external();
  if (now - settled < growth) {
    if (now < settled) settled = now;
    return;
  }
  for (let i = 0; i < rounds; i++) {
    gc();
    await turn();
  }
  settled = external();
}
