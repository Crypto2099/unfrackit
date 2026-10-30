// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// External recipients of the battery spends (setting recipients
// 'synthetic-base'): base addresses with a key payment part and a key stake
// part (CIP-0019, "Shelley Addresses", header type 0), 57 bytes, each part the
// BLAKE2b-224 of a fixed text, so no key controls them. Recipient i has its own
// payment part; all share one stake part, which is no wallet's. The network
// tag is the run's (CIP-0019, "Network Tag": 1 for mainnet and for the
// synthetic shapes, whose test addresses carry it; 0 for preprod). The same
// addresses serve every method and every wallet.

import { blake2b224 } from '../history/blake2b.mjs';
import { encode as bech32encode } from '../history/bech32.mjs';

const STAKE = blake2b224(Buffer.from('unfrackit-research-sim battery recipient stake', 'ascii'));
const CACHE = new Map();

export function recipientAddress(network, i) {
  const k = `${network}|${i}`;
  let a = CACHE.get(k);
  if (!a) {
    const tag = network === 'preprod' ? 0 : 1;
    const pay = blake2b224(Buffer.from(`unfrackit-research-sim battery recipient ${i}`, 'ascii'));
    a = bech32encode(tag === 1 ? 'addr' : 'addr_test', Buffer.concat([Buffer.from([tag]), pay, STAKE]));
    CACHE.set(k, a);
  }
  return a;
}

export const RECIPIENT_STAKE = STAKE.toString('hex');
