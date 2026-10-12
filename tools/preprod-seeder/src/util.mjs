// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import CSL from '@emurgo/cardano-serialization-lib-nodejs';

export { CSL };

export const ADA = 1000000n;

export const toHex = (b) => Buffer.from(b).toString('hex');
export const fromHex = (h) => new Uint8Array(Buffer.from(h, 'hex'));
export const asciiHex = (s) => Buffer.from(s, 'ascii').toString('hex');

// mulberry32: small, fast, deterministic. The shape generators draw every
// random choice from one of these, seeded per shape, so a shape is the same on
// every machine and every run.
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

// JSON with bigints as decimal strings.
export function stringify(value, space) {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), space);
}
