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
// one holds a worker's external memory to about 50 MiB above its settled size;
// the pool replaces a worker after 40 jobs, or sooner when it has grown
// (replay/pool.mjs).

import v8 from 'node:v8';
import vm from 'node:vm';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

// CSL's WebAssembly memory and its ceiling: the maximum the module declares
// for it, or, where it declares none (CSL 17.0.0 does not), the 4 GiB a
// 32-bit WebAssembly memory can reach. Null for a build that exports no
// WebAssembly memory. The module is read from the WebAssembly file beside
// the library's module (T.cslkit.CSL_PATH).
export function cslMemory(T) {
  const memory = T.CSL && T.CSL.__wasm && T.CSL.__wasm.memory;
  if (!(memory instanceof WebAssembly.Memory)) return null;
  let pages = null;
  const path = T.cslkit && T.cslkit.CSL_PATH;
  if (path) {
    const dir = dirname(path);
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.wasm')) continue;
      const max = wasmMemoryMaximum(readFileSync(join(dir, f)));
      if (max !== undefined) {
        pages = max;
        break;
      }
    }
  }
  return { memory, ceilingBytes: (pages ?? WASM32_PAGES) * WASM_PAGE };
}

const WASM_PAGE = 65536;
const WASM32_PAGES = 65536;

// The maximum, in pages, a WebAssembly binary declares for the first memory
// of its memory section: a number, null when it declares none, undefined
// when it has no memory section.
export function wasmMemoryMaximum(bytes) {
  let p = 8;
  const leb = () => {
    let r = 0;
    let s = 1;
    for (;;) {
      const b = bytes[p++];
      r += (b & 0x7f) * s;
      s *= 128;
      if (!(b & 0x80)) return r;
    }
  };
  while (p < bytes.length) {
    const id = bytes[p++];
    const size = leb();
    const end = p + size;
    if (id === 5) {
      if (leb() === 0) return undefined;
      const flags = bytes[p++];
      leb();
      return flags & 1 ? leb() : null;
    }
    p = end;
  }
  return undefined;
}

// What a worker reports of its memory after a job: CSL's WebAssembly memory
// and its ceiling (null without one), the resident size, and V8's heap.
export function memoryReport(csl) {
  const h = v8.getHeapStatistics();
  const m = process.memoryUsage();
  return {
    cslBytes: csl ? csl.memory.buffer.byteLength : null,
    cslCeilingBytes: csl ? csl.ceilingBytes : null,
    rss: m.rss,
    heapUsed: h.used_heap_size,
    heapTotal: h.total_heap_size,
    heapLimit: h.heap_size_limit,
    external: m.external,
    arrayBuffers: m.arrayBuffers
  };
}
