// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// One wallet's history over one window, written as one JSON Lines file:
//   header       the stake-credential id, frame, window bounds as block and
//                transaction ids, the snapshot parameters, the franken-flagged
//                credentials, the arrival table, the latest output received
//                before the window at a key payment credential and a base
//                address (latestKeyBase, wallet.mjs), the settings
//   state        the UTxO set as of the last block before the window's first
//   events       in chain order, by transaction id:
//                  deposit              wallet outputs created by a
//                                       transaction that is not the wallet's
//                                       spend
//                  held-consumed        held wallet UTxOs consumed by a
//                                       transaction that is not the wallet's
//                                       spend
//                  intent               a spend event and its intent
//                  self-reorganization  a spend with no requested output, no
//                                       certificate or governance action, no
//                                       mint or burn and no script; counted,
//                                       its reshuffle not replayed, its
//                                       reward withdrawals replayed as a
//                                       deposit of the withdrawn ADA
//                  mark                 every 30 days of block time from the
//                                       window's first block
//   end          the UTxO set's count and digest at the end of the replayed
//                history, and whether the wallet was capped
//
// A capped wallet (the extraction's study.sample: its window holds more than
// the history cap's transactions) is replayed only to its cap-th window
// transaction, `draw.historyHi`: the header's window range ends there, the
// end state is the state after that transaction, the marks run to that
// transaction's block time (`window.endTime`), and the end record says
// `capped`. The header's `draw` carries the extraction's size group, window
// transaction count, capped flag and history end for the wallet and frame
// (null when the wallet is not in that frame's sample).
//
// A burst is a maximal run of the wallet's spends with no more than 60
// seconds between consecutive block times. It is chained if any of its
// transactions spends an output of an earlier transaction of the same burst,
// transactions in one block ordered by their index (transaction ids follow
// that order); parallel otherwise. Every spend of a burst carries its id,
// whether it is parallel, and its position.
//
// Before a file is complete, the observed events are replayed from the start
// state: the result must be the UTxO set at the window's last block.

import { q } from './db.mjs';
import { loadLife, aliveAt, frankenFlags, holdingsOf, arrivalTable, loadExtras, utxoRecord, digestOf, heldReason, latestKeyBase } from './wallet.mjs';
import { loadBundles } from './txdata.mjs';
import { spendEvent, timeOf, IntentCheck } from './intent.mjs';

export const FORMAT = 'unfrackit-research-sim history 4';
const BUNDLE_BATCH = 400;

export function bursts(spends, settings) {
  // spends: [{ txId, hash, blockTime, consumed: [refs] }] in transaction order.
  const out = new Map();
  let run = [];
  let n = 0;
  const close = () => {
    if (run.length >= settings.burstMinSpends) {
      n++;
      const hashes = new Map(run.map((s, i) => [s.hash, i]));
      let chained = false;
      run.forEach((s, j) => {
        for (const ref of s.consumed) {
          const i = hashes.get(ref.split('#')[0]);
          if (i !== undefined && i < j) chained = true;
        }
      });
      run.forEach((s, index) => out.set(s.txId, { id: `b${n}`, parallel: !chained, index }));
    }
    run = [];
  };
  for (const s of spends) {
    if (run.length && s.blockTime - run[run.length - 1].blockTime > settings.burstGapSeconds) close();
    run.push(s);
  }
  close();
  return out;
}

// Marks every `markSeconds` of block time from t0 through t1, placed before
// the first event at or after their time (strictly after, when ties go
// after).
export function placeMarks(events, t0, t1, settings) {
  const out = [];
  let k = 1;
  const next = () => t0 + k * settings.markSeconds;
  const timeOfEvent = (e) => (e.kind === 'intent' ? e.intent.time.blockTime : e.time.blockTime);
  const mark = () => {
    out.push({ kind: 'mark', n: k, blockTime: next() });
    k++;
  };
  for (const e of events) {
    const te = timeOfEvent(e);
    while (next() <= t1 && (settings.markBeforeTies ? next() <= te : next() < te)) mark();
    out.push(e);
  }
  while (next() <= t1) mark();
  return out;
}

// The observed replay: start set, then each event's observed effect.
export function replayObserved(startRefs, events) {
  const s = new Set(startRefs);
  const rm = (ref, why) => {
    if (!s.delete(ref)) throw new IntentCheck(`observed replay: ${ref} removed by ${why} is not in the state`);
  };
  for (const e of events) {
    if (e.kind === 'deposit') for (const u of e.utxos) s.add(u.ref);
    else if (e.kind === 'held-consumed') for (const r of e.refs) rm(r, e.tx);
    else if (e.kind === 'intent') {
      const it = e.intent;
      for (const x of it.observed.walletInputs) rm(x.ref, it.id);
      if (it.fixed) for (const x of it.fixed.inputs) if (x.held) rm(x.ref, it.id);
      if (it.invalid) for (const r of it.invalid.heldConsumed) rm(r, it.id);
      for (const o of it.observed.walletOutputs) s.add(`${it.id}#${o.index}`);
    } else if (e.kind === 'self-reorganization') {
      for (const x of e.observed.walletInputs) rm(x.ref, e.tx);
      for (const r of e.heldConsumed) rm(r, e.tx);
      for (const o of e.observed.walletOutputs) s.add(`${e.tx}#${o.index}`);
    }
  }
  return s;
}

export async function txRows(ctx, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 1000) {
    for (const r of await q(ctx.client, ctx.blocks, 'txs', { ids: { type: 'intarr', value: ids.slice(i, i + 1000) } })) out.set(Number(r.id), r);
  }
  return out;
}

// The reconstruction check at one block: this code's set (the wallet's rows
// alive at T(B)) against the reference query's, as count and digest, and
// against the extraction's life table when `withLifeTable` is set (its study
// tables readable).
export async function reconstructionCheck(ctx, saIds, block, tOfBlock, lifeOf, { withLifeTable = false } = {}) {
  const ref = await q(ctx.client, ctx.blocks, 'ref_digests', { sa_ids: { type: 'intarr', value: saIds }, block_id: { type: 'int', value: block } });
  const byId = new Map(ref.map((r) => [Number(r.sa_id), { n: Number(r.n), digest: r.digest }]));
  let life = null;
  if (withLifeTable) {
    const rows = await q(ctx.client, ctx.blocks, 'life_digests', { sa_ids: { type: 'intarr', value: saIds }, t: { type: 'int', value: tOfBlock } });
    life = new Map(rows.map((r) => [Number(r.sa_id), { n: Number(r.n), digest: r.digest }]));
  }
  const out = [];
  for (const sa of saIds) {
    const mine = digestOf(aliveAt(lifeOf(sa), tOfBlock));
    const theirs = byId.get(sa);
    const r = { sa, agree: mine.n === theirs.n && mine.digest === theirs.digest, n: mine.n, nRef: theirs.n };
    if (life) {
      const l = life.get(sa);
      r.agreeLife = mine.n === l.n && mine.digest === l.digest;
      r.agree = r.agree && r.agreeLife;
    }
    out.push(r);
  }
  return out;
}

// The extraction's draw fields for one wallet and frame, as the header
// carries them: { sizeGroup, nWindowTx, capped, historyHi, historyCap }, or
// null for a wallet outside the frame's sample.
//
// The window's transaction ids for a wallet are the distinct transactions in
// [lo, hi] that create or consume one of its outputs, in id order: the
// extraction's T (activity.sql n_tx_any). They must number nWindowTx; a
// capped wallet's historyCap-th id must be historyHi and nWindowTx must exceed
// the cap; an uncapped wallet's nWindowTx must not exceed it and its history
// ends at the window's hi. Returns the transaction id the replay ends at.
export function drawEnd(draw, windowIds, windowHi) {
  if (!draw) return windowHi;
  const { nWindowTx, capped, historyHi, historyCap } = draw;
  if (windowIds.length !== nWindowTx) throw new IntentCheck(`the window holds ${windowIds.length} transactions of the wallet, the extraction's T is ${nWindowTx}`);
  if (capped !== nWindowTx > historyCap) throw new IntentCheck(`the extraction marks the wallet ${capped ? 'capped' : 'uncapped'} with T ${nWindowTx} and the cap ${historyCap}`);
  if (!capped) {
    if (historyHi !== windowHi) throw new IntentCheck('the extraction ends an uncapped wallet\'s history at a transaction other than the window\'s last');
    return windowHi;
  }
  if (windowIds[historyCap - 1] !== historyHi) throw new IntentCheck(`the wallet's ${historyCap}th window transaction is not the extraction's history end`);
  return historyHi;
}

// w: { saId, frame, window: { first, last, lo, hi }, snapshot: { block, tx }, split, sample, draw, franken (Set) or null }
export async function walletHistory(ctx, w, out) {
  const { saId } = w;
  ctx.resolved = new Map();
  const life = await loadLife(ctx.client, ctx.blocks, saId, w.snapshot.tx);
  const fr = w.franken ? { flagged: w.franken, source: 'study' } : { ...frankenFlags(life, w.snapshot.tx), source: 'computed' };
  const franken = fr.flagged;
  const snapCheck = await reconstructionCheck(ctx, [saId], w.snapshot.block, w.snapshot.tx, () => life);
  if (!snapCheck[0].agree) throw new IntentCheck(`wallet ${saId}: the reconstruction differs from the reference query at the snapshot; the wallet is excluded`);

  const isSnapshot = w.frame === 'snapshot';
  const lo = isSnapshot ? w.snapshot.tx + 1 : w.window.lo;
  const windowHi = isSnapshot ? w.snapshot.tx : w.window.hi;
  const tStart = isSnapshot ? w.snapshot.tx : w.window.tStart;
  const startRows = aliveAt(life, tStart);
  const draw = isSnapshot ? null : w.draw || null;
  const inWindow = (t) => t !== null && t >= lo && t <= windowHi;
  const created = new Map();
  const consumed = new Map();
  for (const r of life) {
    if (inWindow(r.createdTx)) (created.get(r.createdTx) || created.set(r.createdTx, []).get(r.createdTx)).push(r);
    if (inWindow(r.consumedTx)) (consumed.get(r.consumedTx) || consumed.set(r.consumedTx, []).get(r.consumedTx)).push(r);
  }
  const windowIds = [...new Set([...created.keys(), ...consumed.keys()])].sort((a, b) => a - b);
  const hi = drawEnd(draw, windowIds, windowHi);
  const capped = !!(draw && draw.capped);
  const ids = windowIds.filter((t) => t <= hi);
  for (const m of [created, consumed]) for (const k of [...m.keys()]) if (k > hi) m.delete(k);
  const endRows = aliveAt(life, hi);
  const isSpend = (id) => (consumed.get(id) || []).some((r) => !r.scriptPay);
  const spendIds = ids.filter(isSpend);
  await loadExtras(ctx, [...startRows, ...[...created.values()].flat()]);
  const rows = await txRows(ctx, ids);
  // Spends are read in batches as the events reach them, so a wallet with
  // thousands of spends never holds them all decoded at once.
  const bundles = new Map();
  let nextSpend = 0;
  const bundleOf = async (id) => {
    if (!bundles.has(id)) {
      bundles.clear();
      const k = spendIds.indexOf(id, nextSpend);
      const part = spendIds.slice(k, k + BUNDLE_BATCH);
      for (const [x, b] of await loadBundles(ctx, part)) bundles.set(x, b);
      nextSpend = k + part.length;
    }
    return bundles.get(id);
  };

  const holdStart = holdingsOf(startRows);
  const holdEnd = holdingsOf(endRows);
  const wctx = { saId, franken, holdStart, holdEnd, holdBefore: (txId) => holdingsOf(aliveAt(life, txId - 1)) };

  const events = [];
  const spends = [];
  const counts = { deposit: 0, 'held-consumed': 0, intent: 0, 'self-reorganization': 0, mark: 0, skippedInvalid: 0, raised: 0 };
  for (const id of ids) {
    const row = rows.get(id);
    if (isSpend(id)) {
      const b = await bundleOf(id);
      b.lifeConsumed = (consumed.get(id) || []).map((r) => r.ref);
      spends.push({ txId: id, hash: row.hash, blockTime: Number(row.time), consumed: b.consumed });
      const ev = spendEvent(ctx, wctx, b);
      if (ev === null) {
        counts.skippedInvalid++;
        continue;
      }
      ev.txId = id;
      events.push(ev);
      counts[ev.kind]++;
      if (ev.kind === 'intent') counts.raised += ev.intent.requested.filter((x) => x.raised).length;
      continue;
    }
    const gone = consumed.get(id) || [];
    if (gone.length && ctx.settings.heldConsumed === 'a') {
      for (const r of gone) if (heldReason(r, franken) === null) throw new IntentCheck(`transaction ${row.hash}: consumes ${r.ref}, which is not held, without being the wallet's spend`);
      events.push({ kind: 'held-consumed', tx: row.hash, txId: id, time: timeOf(row), refs: gone.map((r) => r.ref) });
      counts['held-consumed']++;
    }
    const made = created.get(id) || [];
    if (made.length) {
      events.push({ kind: 'deposit', tx: row.hash, txId: id, time: timeOf(row), utxos: made.map((r) => utxoRecord(ctx, r, 'deposit', franken)) });
      counts.deposit++;
    }
  }

  const bmap = bursts(spends, ctx.settings);
  for (const e of events) {
    if (e.kind === 'intent') e.intent.burst = bmap.get(e.txId) || null;
    if (e.kind === 'self-reorganization') e.burst = bmap.get(e.txId) || null;
  }

  // The observed replay must reach the end state.
  if (ctx.settings.heldConsumed === 'a') {
    const endSet = replayObserved(startRows.map((r) => r.ref), events);
    const want = new Set(endRows.map((r) => r.ref));
    const missing = [...want].filter((r) => !endSet.has(r));
    const extra = [...endSet].filter((r) => !want.has(r));
    if (missing.length || extra.length) throw new IntentCheck(`wallet ${saId}: the observed replay ends with ${extra.length} UTxOs too many and ${missing.length} too few`);
  }

  // A capped wallet's window ends at the block time of its last replayed
  // transaction.
  const endTime = isSnapshot ? null : capped ? timeOf(rows.get(hi)).blockTime : Number(w.window.last.time);
  const withMarks = isSnapshot ? [] : placeMarks(events, Number(w.window.first.time), endTime, ctx.settings);
  counts.mark = withMarks.filter((e) => e.kind === 'mark').length;

  out.write({
    kind: 'header',
    format: FORMAT,
    network: ctx.network,
    wallet: saId,
    frame: w.frame,
    split: w.split || null,
    sample: w.sample || null,
    draw: draw ? { sizeGroup: draw.sizeGroup, nWindowTx: draw.nWindowTx, capped: draw.capped, historyHi: draw.historyHi } : null,
    window: isSnapshot ? null : { first: w.window.first, last: w.window.last, lo, hi, tStart, endTime },
    snapshot: w.snapshot,
    params: ctx.params,
    franken: [...franken].sort(),
    frankenSource: fr.source,
    arrival: arrivalTable(life, tStart),
    latestKeyBase: latestKeyBase(life, tStart, franken),
    settings: ctx.settings,
    source: { bytes: ctx.bytes.mode, dbsync: ctx.client.dbsyncVersion }
  });
  out.write({ kind: 'state', at: { tx: tStart }, utxos: startRows.map((r) => utxoRecord(ctx, r, 'initial', franken)) });
  for (const e of withMarks) out.write(e);
  const d = digestOf(endRows);
  out.write({ kind: 'end', at: { tx: hi }, utxos: d.n, digest: d.digest, capped, counts });
  return { counts, spends: spends.length, utxosStart: startRows.length, utxosEnd: endRows.length, windowTx: ids.length, capped };
}
