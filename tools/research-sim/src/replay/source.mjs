// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A replay's or battery's wallet, from its history file or a synthetic shape:
//   { wallet, window, network, stakeCred, changeAddress, changeAddressEnd,
//     franken, start, events, arrival, windowStart, windowEnd, params,
//     analysisFreezeTx }
// `wallet` is db-sync's stake-credential id or the shape's name; `window` the
// history's frame ('recent', 'peak', or a test frame), 'snapshot' for a
// snapshot file (no window), or 'synthetic' for a shape's own stream. The
// change address is the change-address rule's over every output the wallet
// has received on the chain (state/state.mjs annotateChangeAddresses):
// `changeAddress` at the window's start (for a snapshot, at the snapshot),
// `changeAddressEnd` after its last event, and each event's own; either may
// be null when the wallet has received no output the rule can name. The
// stake credential is that of the addresses the rule names; a shape's stream
// starts from the shape's change address.
//
// spec: { kind: 'history', path, analysisFreezeTx } or { kind: 'shape', name,
// stream: null | 'synthetic' } (shapes/streams.mjs).

import { readFileSync } from 'node:fs';
import { readHistory } from '../state/history.mjs';
import { annotateChangeAddresses } from '../state/state.mjs';
import { shapeState } from '../shapes/shapes.mjs';
import { syntheticStream } from '../shapes/streams.mjs';
import { SYNTHETIC_PARAMS } from '../kit/params.mjs';

let last = null;

export function loadSource(T, spec) {
  const k = JSON.stringify(spec);
  if (last && last.k === k) return last.source;
  let source;
  if (spec.kind === 'history') {
    const h = readHistory(readFileSync(spec.path, 'utf8'), { analysisFreezeTx: spec.analysisFreezeTx || null });
    const w = h.header.window;
    source = {
      wallet: h.header.wallet,
      window: w ? h.header.frame : 'snapshot',
      split: h.header.split || null,
      network: h.header.network,
      stakeCred: h.stakeCred,
      changeAddress: h.changeAddress,
      changeAddressEnd: h.changeAddressEnd,
      franken: h.franken,
      start: h.start,
      events: h.events,
      arrival: h.arrival,
      windowStart: w ? Number(w.first.time) : null,
      windowEnd: w ? Number(w.last.time) : null,
      params: h.params,
      analysisFreezeTx: h.analysisFreezeTx
    };
  } else if (spec.kind === 'shape') {
    const s = shapeState(T, spec.name);
    const stream = spec.stream ? syntheticStream(T, s, SYNTHETIC_PARAMS, { kind: spec.stream }) : { events: [], windowEnd: 0 };
    const change = annotateChangeAddresses({ address: s.state.changeAddress, txId: -1, index: 0 }, stream.events, new Set());
    source = {
      wallet: spec.name,
      window: spec.stream ? 'synthetic' : 'snapshot',
      split: null,
      network: 'synthetic',
      stakeCred: s.state.stakeCred,
      changeAddress: change.start,
      changeAddressEnd: change.end,
      franken: new Set(),
      start: [...s.state.utxos.values()],
      events: stream.events,
      arrival: stream.arrival || new Map(),
      windowStart: 0,
      windowEnd: stream.windowEnd,
      params: SYNTHETIC_PARAMS,
      analysisFreezeTx: null
    };
  } else {
    throw new Error(`unknown wallet source ${spec.kind}`);
  }
  last = { k, source };
  return source;
}
