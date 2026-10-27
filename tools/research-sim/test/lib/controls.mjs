// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The four negative controls on one built transaction, checked against the
// state it spends from: the fee one lovelace under the ledger's minimum (the
// difference moved into the last output, so the transaction stays balanced),
// one byte over the size limit, a Value one byte over the value-size limit,
// and one vkey witness short. Each must be caught by its own check alone.
// Returns the checks each control failed.

import { checkTx } from '../../src/kit/check.mjs';
import { inspectTx } from '../../src/kit/inspect.mjs';
import { minFee } from '../../src/kit/fee.mjs';
import { valueSize } from '../../src/history/value.mjs';
import { parseAddress, addressBytes } from '../../src/history/address.mjs';
import { withFee, withoutOneWitness } from './txcbor.mjs';

export function negativeControls(state, params, bytes, ctx = {}) {
  const view = (u) => u && { coin: u.coin, assets: u.assets, addr: parseAddress(addressBytes(u.address)) };
  const resolve = (ref) => view(state.utxos.get(ref));
  const c = { params, resolve, ...ctx };
  const base = checkTx(bytes, c);
  const t = inspectTx(bytes);
  // The distinct checks that failed: several outputs may share the largest
  // Value, and each is caught by the same check.
  const reasons = (r) => [...new Set(r.failures.map((f) => f.check))].join(',');
  const vb = Math.max(...t.outputs.map((o) => valueSize(o.coin, o.assets)));
  return {
    base: base.ok ? '' : reasons(base),
    fee: reasons(checkTx(withFee(bytes, minFee(params, t.size, ctx.scriptFee || 0n) - 1n, t.outputs.length - 1), c)),
    size: reasons(checkTx(bytes, { ...c, params: { ...params, maxTxSize: t.size - 1 } })),
    value: reasons(checkTx(bytes, { ...c, params: { ...params, maxValSize: vb - 1 } })),
    witnesses: reasons(checkTx(withoutOneWitness(bytes), c))
  };
}

export const EXPECTED = Object.freeze({ base: '', fee: 'fee', size: 'size', value: 'value-size', witnesses: 'witnesses' });
