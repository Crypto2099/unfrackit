// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// CSL's WebAssembly memory. The simulator frees every CSL object it makes;
// objects the treatment's own code leaves to JavaScript are released by CSL's
// FinalizationRegistry, which runs only after a garbage collection and a turn
// of the event loop. Without both, those objects pile up spend after spend
// and later CSL calls slow down, so the engine settles the heap between
// spends. Measured on the 3,005-UTxO shape M2 with cardano-serialization-lib
// 17.0.0: eight plan builds in a row took about 0.14 seconds each, settled or
// not; after each of its 13 H-12 battery spends, the plan took about 0.2
// seconds with only a turn of the event loop between spends, and 0.11 to 0.14
// seconds with three 10 ms waits, the default (two 5 ms waits did about as
// well), the process then holding 0.6 GiB rather than 0.8 GiB.

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
