// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The deposits an intent pays, one entry per certificate or proposal, priced as
// the history reader prices them (history/intent.mjs, `deposits`): Shelley-era
// registration at the key deposit; Conway registration, DRep registration and
// the other Conway certificates at their stated coin; a proposal at its
// deposit; each new pool at the pool deposit (the count is the history
// reader's, carried in the intent's `derived`). Refunds are not deposits and
// are not listed. The certificates and proposals are read from the intent's
// fixed body (fields 4 and 20, their original bytes), so no CSL is loaded.

import { decode, setItems, asUint } from '../history/cbor.mjs';

const hexBytes = (h) => Buffer.from(h, 'hex');

// The deposits of an intent as a list of BigInt, in wire order (certificates,
// then proposals, then new pools). `params` supplies the key and pool deposits.
export function depositParts(intent, params) {
  const out = [];
  const body = intent.fixed ? intent.fixed.body : null;
  if (body && body[4] !== undefined) {
    for (const c of setItems(decode(hexBytes(body[4])))) {
      const type = Number(asUint(c.items[0], 'certificate type'));
      const coinAt = (i) => asUint(c.items[i], 'certificate coin');
      if (type === 0) out.push(params.keyDeposit);
      else if (type === 7 || type === 16) out.push(coinAt(2));
      else if (type === 11 || type === 12) out.push(coinAt(3));
      else if (type === 13) out.push(coinAt(4));
    }
  }
  if (body && body[20] !== undefined) {
    for (const p of setItems(decode(hexBytes(body[20])))) out.push(asUint(p.items[0], 'proposal deposit'));
  }
  const pools = intent.derived && intent.derived.poolDeposits ? intent.derived.poolDeposits.newPools : 0;
  for (let i = 0; i < pools; i++) out.push(params.poolDeposit);
  return out;
}

// Whether `shortfall` equals the sum of a non-empty subset of `parts` (D5).
// Sums above the shortfall are dropped as they arise.
export function isDepositSubset(shortfall, parts) {
  if (shortfall <= 0n) return false;
  let sums = new Set([0n]);
  for (const p of parts) {
    for (const s of [...sums]) if (s + p <= shortfall) sums.add(s + p);
    if (sums.has(shortfall)) return true;
  }
  return false;
}
