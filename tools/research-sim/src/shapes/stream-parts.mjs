// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The parts the synthetic streams share (streams.mjs and heavy.mjs): output
// requests, minimum-coin outputs, synthetic hashes and the fixed-byte count of
// a replayed intent.

import { blake2b256, blake2b224 } from '../history/blake2b.mjs';
import { encodeOutput } from '../history/output.mjs';
import { addressBytes } from '../history/address.mjs';
import { assembleReplayOnce } from '../kit/replay.mjs';
import { inspectTx } from '../kit/inspect.mjs';

export const ADA = 1000000n;
export const DAY = 86400;
export const hash32 = (s) => blake2b256(Buffer.from(`unfrackit-research-sim stream ${s}`, 'ascii')).toString('hex');
export const hash28 = (s) => blake2b224(Buffer.from(`unfrackit-research-sim stream ${s}`, 'ascii')).toString('hex');
export const key = (a) => `${a.policy}.${a.name}`;
export const cmpKey = (a, b) => (a.policy < b.policy ? -1 : a.policy > b.policy ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// The minimum coin of an output at its own width.
export function atMinimum(params, build) {
  let coin = ADA;
  for (let i = 0; i < 8; i++) {
    const b = build(coin);
    const min = params.coinsPerUtxoByte * (160n + BigInt(b.length));
    if (min === coin) return { coin, bytes: b };
    coin = min;
  }
  throw new Error('the minimum coin did not settle');
}

export function requestedOut(address, bytes, coin, assets, extra = {}) {
  return { cbor: bytes.toString('hex'), address, coin, assets, datum: extra.datum || null, scriptRef: null, raised: null, wallet: !!extra.wallet, scriptPayment: !!extra.scriptPayment, index: extra.index ?? null, from: null, inflow: !!extra.inflow };
}

export function payOut(params, address, coin, assets) {
  const a = addressBytes(address);
  if (coin === null) {
    const m = atMinimum(params, (c) => encodeOutput({ address: a, coin: c, assets }, 'array'));
    return requestedOut(address, m.bytes, m.coin, assets);
  }
  return requestedOut(address, encodeOutput({ address: a, coin, assets }, 'array'), coin, assets);
}

export const ZERO = () => ({ withdrawals: 0n, refunds: 0n, deposits: 0n, donation: 0n, mint: [], burn: [] });

// Fixed bytes: the kit's assembly with the fixed parts less the same without
// them, over one stand-in input and no change, as the history reader computes
// it from an observed transaction.
export function fixedBytesOf(T, intent) {
  const stand = { ref: `${'00'.repeat(32)}#0`, cred: '00'.repeat(28) };
  const a = assembleReplayOnce(T, { intent, inputs: [stand], change: [], collateral: null, fee: 200000n });
  const b = assembleReplayOnce(T, { intent: { ...intent, fixed: null }, inputs: [stand], change: [], collateral: null, fee: 200000n });
  return inspectTx(a.bytes).size - inspectTx(b.bytes).size;
}

