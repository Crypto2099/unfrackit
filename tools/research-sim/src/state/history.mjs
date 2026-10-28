// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A history file (history/history.mjs) read into the simulator's form: one
// wallet and window, JSON Lines, in this order:
//
//   header   the wallet (db-sync's stake-credential id), frame, split, window
//            bounds, snapshot, the snapshot epoch's parameters, the
//            franken-flagged payment credentials, the arrival table, the
//            latest output received before the window at a key payment
//            credential and a base address (latestKeyBase), the reader's
//            settings, the byte source
//   state    the UTxO set at the window's start
//   events   in chain order: deposit, held-consumed, intent,
//            self-reorganization, mark
//   end      the UTxO set's count and digest at the window's last block, and
//            the event counts
//
// Every UTxO record of the start state and of a deposit carries `txId`, db-sync's
// id of its creating transaction, in chain order. The change address of every
// arm is the change-address rule's over every output the wallet has received
// on the chain up to each point: the header's latestKeyBase, then the outputs
// of the window's events (state/state.mjs annotateChangeAddresses), so every
// event carries the address in effect at it.
//
// A file without its end record, or whose event counts differ from the end
// record's, is refused as incomplete. A confirmation-split wallet is refused
// unless the run names the transaction whose record freezes the analysis
// scripts, and the run logs that it was given.

import { normalizeParams } from '../kit/params.mjs';
import { utxoFromRecord } from './utxo.mjs';
import { intentFromHistory } from './intent.mjs';
import { latestKeyBase, annotateChangeAddresses } from './state.mjs';
import { parseAddress, addressBytes } from '../history/address.mjs';

export const HISTORY_FORMAT = 'unfrackit-research-sim history 3';

// A record's creating transaction id, which every record must carry.
function createdId(r, created) {
  if (!Number.isSafeInteger(r.txId) || r.txId < 0) throw new Error(`history file: UTxO record ${r.ref} carries no creating transaction id`);
  if (created.has(r.ref)) throw new Error(`history file: UTxO record ${r.ref} twice`);
  created.set(r.ref, r.txId);
  return utxoFromRecord(r);
}

export function readHistory(text, { analysisFreezeTx = null } = {}) {
  const lines = text.split('\n').filter((l) => l.length).map((l) => JSON.parse(l));
  if (!lines.length || lines[0].kind !== 'header') throw new Error('history file: no header');
  const header = lines[0];
  if (header.format !== HISTORY_FORMAT) throw new Error(`history file: format ${header.format}, expected ${HISTORY_FORMAT}`);
  if (header.split === 'confirmation' && !analysisFreezeTx) throw new Error(`history file: wallet ${header.wallet} is in the confirmation split, and the run names no analysis-freeze transaction`);
  if (lines.length < 3 || lines[1].kind !== 'state') throw new Error('history file: no start state');
  const end = lines[lines.length - 1];
  if (end.kind !== 'end') throw new Error('history file: no end record; the file is incomplete');
  const franken = new Set(header.franken || []);
  const params = normalizeParams(header.params);
  const created = new Map();
  const start = lines[1].utxos.map((r) => createdId(r, created));
  const events = [];
  const counts = { deposit: 0, 'held-consumed': 0, intent: 0, 'self-reorganization': 0, mark: 0 };
  for (const e of lines.slice(2, -1)) {
    if (!(e.kind in counts)) throw new Error(`history file: unknown event ${e.kind}`);
    counts[e.kind]++;
    if (e.kind === 'deposit') events.push({ kind: 'deposit', tx: e.tx, txId: e.txId, time: e.time, utxos: e.utxos.map((r) => createdId(r, created)) });
    else if (e.kind === 'held-consumed') events.push({ kind: 'held-consumed', tx: e.tx, txId: e.txId, time: e.time, refs: [...e.refs] });
    else if (e.kind === 'intent') events.push({ kind: 'intent', txId: e.txId, intent: intentFromHistory(e.intent) });
    else if (e.kind === 'self-reorganization') {
      const vc = e.valueChange || { coin: '0', assets: [] };
      events.push({ kind: 'self-reorganization', tx: e.tx, txId: e.txId, time: e.time, burst: e.burst || null, heldConsumed: [...(e.heldConsumed || [])], valueChange: { coin: BigInt(vc.coin), assets: (vc.assets || []).map((a) => ({ policy: a.policy, name: a.name, qty: BigInt(a.qty) })) }, walletOutputs: (e.observed ? e.observed.walletOutputs : []).map((o) => ({ index: o.index, cbor: o.cbor })) });
    }
    else events.push({ kind: 'mark', n: e.n, blockTime: e.blockTime });
  }
  for (const k of Object.keys(counts)) {
    if (end.counts && end.counts[k] !== undefined && end.counts[k] !== counts[k]) throw new Error(`history file: ${counts[k]} ${k} events, the end record says ${end.counts[k]}`);
  }
  // The arrival table, as the planner's arrival grouping reads it: each
  // asset's arrival key is db-sync's integer id of its arrival transaction.
  const arrival = new Map((header.arrival || []).map((a) => [`${a.policy}.${a.name}`, { txId: a.txId, flagged: !!a.flagged }]));
  const before = latestKeyBaseOf(header, start, created);
  const change = annotateChangeAddresses(before, events, franken);
  const stakeCred = change.end === null ? null : parseAddress(addressBytes(change.end)).stake;
  return { header, params, franken, start, events, end, arrival, created, changeAddress: change.start, changeAddressEnd: change.end, stakeCred, analysisFreezeTx };
}

// The header's latest output before the window at a key payment credential
// and a base address, checked against the start state: the header ranges
// over every output received before the window, the start state's UTxOs among
// them, so the start state's own latest such UTxO is never later.
function latestKeyBaseOf(header, start, created) {
  if (!('latestKeyBase' in header)) throw new Error('history file: the header carries no latestKeyBase');
  const k = header.latestKeyBase;
  if (k !== null && (typeof k.address !== 'string' || !Number.isSafeInteger(k.txId) || !Number.isSafeInteger(k.index))) throw new Error('history file: latestKeyBase is not { address, txId, index }');
  const own = latestKeyBase(start, created);
  if (own && (!k || own.txId > k.txId || (own.txId === k.txId && (own.index > k.index || (own.index === k.index && own.address !== k.address))))) throw new Error('history file: the start state holds a later output at a key payment credential and a base address than the header\'s latestKeyBase');
  return k;
}

// The change address of the start state's UTxOs alone (the rule before it
// counted every output received), or null when none sits at a key payment
// credential and a base address. Kept for comparison.
export function startChangeAddress(start, created) {
  const b = latestKeyBase(start, created);
  return b ? b.address : null;
}
