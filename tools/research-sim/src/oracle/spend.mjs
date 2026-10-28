// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// What the oracle searches: one battery spend on one wallet state. A battery
// spend carries requested outputs only, so the oracle handles no script,
// certificate, collateral, implicit value or fixed part, and refuses any
// intent that has one. Held UTxOs are never candidates.
//
// The candidate set of the exhaustive path (setting searchSpace
// 'requested-plus-20'): the spendable UTxOs holding any requested asset,
// plus the 20 largest spendable pure-ADA UTxOs by coin, ties by txid#index
// ascending. When it numbers at most 24, it is the exhaustive path's search
// space; otherwise the mixed-integer program searches every spendable UTxO.

import { spendable, cmpRef } from '../state/state.mjs';
import { PURE_ADA_CANDIDATES, EXHAUSTIVE_MAX } from './settings.mjs';

const key = (a) => `${a.policy}.${a.name}`;

export class OracleRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'OracleRefusal';
  }
}

// Refuses an intent the oracle does not handle.
export function checkSpend(spend) {
  if (!spend || !Array.isArray(spend.requested) || !spend.requested.length) throw new OracleRefusal('the spend has no requested output');
  if (spend.source !== 'battery' && spend.source !== 'h10') throw new OracleRefusal(`the oracle builds battery spends only (source ${spend.source})`);
  if (spend.fixed) throw new OracleRefusal('the spend has fixed parts');
  if (spend.collateral && spend.collateral.required) throw new OracleRefusal('the spend needs collateral');
  const imp = spend.implicit || {};
  if (imp.withdrawals || imp.refunds || imp.deposits || imp.donation || (imp.mint && imp.mint.length) || (imp.burn && imp.burn.length)) throw new OracleRefusal('the spend has implicit values');
  for (const o of spend.requested) {
    if (o.datum || o.scriptRef) throw new OracleRefusal('a requested output carries a datum or a script reference');
    if (typeof o.cbor !== 'string' || !o.cbor) throw new OracleRefusal('a requested output has no bytes');
  }
  return spend;
}

// The requested assets with their quantities.
export function requestedAssets(spend) {
  const m = new Map();
  for (const o of spend.requested) for (const a of o.assets) m.set(key(a), (m.get(key(a)) || 0n) + BigInt(a.qty));
  return m;
}

const byCoinDesc = (a, b) => (a.coin > b.coin ? -1 : a.coin < b.coin ? 1 : cmpRef(a.ref, b.ref));

// The exhaustive path's candidates: holders first (txid#index order), then the
// pure-ADA UTxOs largest first.
export function candidateSet(state, spend) {
  const req = requestedAssets(spend);
  const pool = spendable(state);
  const holders = pool.filter((u) => u.assets.some((a) => req.has(key(a))));
  const pure = pool.filter((u) => !u.assets.length).sort(byCoinDesc).slice(0, PURE_ADA_CANDIDATES);
  return { holders, pure, all: [...holders, ...pure], exhaustive: holders.length + pure.length <= EXHAUSTIVE_MAX };
}
