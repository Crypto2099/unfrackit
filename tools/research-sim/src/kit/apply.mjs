// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// What the engine does with a method's answer: every transaction is checked
// by the ledger kit and applied in order, each later one spending the earlier
// ones' outputs, so a chain is checked as the ledger would see it submitted.
// A failed check on any transaction fails the whole answer, and the state is
// left as it was.
//
// A transaction record, as a method returns it:
//   { bytes (hex), walletInputs [ref], fee, size, k, roles }
// `walletInputs` are the state's UTxOs it spends (earlier transactions'
// outputs included); held inputs an intent spends are its fixed inputs.

import { checkTx } from './check.mjs';
import { applyTx } from '../state/state.mjs';
import { unspentOutputParts } from './inspect.mjs';
import { parseAddress, addressBytes } from '../history/address.mjs';

const PARSED = new WeakMap();
function view(u) {
  let v = PARSED.get(u);
  if (!v) {
    v = { coin: u.coin, assets: u.assets, addr: parseAddress(addressBytes(u.address)) };
    PARSED.set(u, v);
  }
  return v;
}

export function fixedResolver(fixed) {
  const m = new Map();
  if (fixed) for (const x of [...(fixed.inputs || []), ...(fixed.referenceInputs || [])]) {
    const p = unspentOutputParts(x.cbor);
    m.set(x.ref, { coin: p.coin, assets: p.assets, addr: p.addr });
  }
  return m;
}

// opts: { implicit, scriptFee, extraWitnesses, fixed, requested (Set of the
// last transaction's requested output indexes), heldInputs (refs of held
// UTxOs the intent spends), notWallet (state/state.mjs applyTx) }. The
// intent's implicit values, script fee and fixed parts belong to its last
// transaction (a chain's earlier transactions are the planner's, with none).
export function checkAndApply(state, params, txs, opts = {}) {
  const fixedMap = fixedResolver(opts.fixed);
  let s = state;
  const checks = [];
  for (let i = 0; i < txs.length; i++) {
    const last = i === txs.length - 1;
    const cur = s;
    const resolve = (ref) => {
      const u = cur.utxos.get(ref);
      if (u) return view(u);
      return fixedMap.get(ref);
    };
    const r = checkTx(txs[i].bytes, {
      params,
      resolve,
      implicit: last ? opts.implicit : undefined,
      scriptFee: last ? opts.scriptFee : 0n,
      extraWitnesses: last ? opts.extraWitnesses || 0 : 0,
      requested: last ? opts.requested : undefined
    });
    checks.push(r);
    if (!r.ok) return { ok: false, failed: i, checks, state, failure: r.failures[0] };
    s = applyTx(s, { bytes: txs[i].bytes, walletInputs: txs[i].walletInputs, heldInputs: last ? opts.heldInputs || [] : [], notWallet: opts.notWallet || null }).state;
  }
  return { ok: true, checks, state: s };
}
