// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The brute-force check's small wallets: a sub-wallet of k spendable UTxOs of
// a shape's state, 8 <= k <= 12, drawn with mulberry32 from a fixed seed.

import { makeState, spendable } from '../../src/state/state.mjs';
import { makeRng } from '../../src/shapes/rng.mjs';

export function subWallet(state, seed) {
  const rng = makeRng(seed);
  const pool = spendable(state);
  const k = 8 + Math.floor(rng.next() * 5);
  const idx = pool.map((_, i) => i);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng.next() * (idx.length - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const utxos = idx.slice(0, k).map((i) => pool[i]);
  return makeState({ network: state.network, stakeCred: state.stakeCred, changeAddress: state.changeAddress, utxos, at: state.at });
}
