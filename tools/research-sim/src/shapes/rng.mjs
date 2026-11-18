// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// mulberry32: the study's 32-bit generator for the synthetic shapes and every
// seeded draw of the simulator. The same algorithm, with the same helpers,
// as the treatment's cslkit.mjs makeRng and the preprod seeder's util.mjs, so
// that a shape generated here is the shape generated there.

export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(lo, hi) {
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    bytes(n) {
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = Math.floor(next() * 256);
      return b;
    },
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }
  };
}
