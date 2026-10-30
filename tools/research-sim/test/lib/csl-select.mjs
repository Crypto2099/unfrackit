// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// cardano-serialization-lib 13.2.1 selecting and making change on its own,
// for the oracle's tests until the baseline adapters exist: the requested
// outputs added from their bytes, add_inputs_from over the spendable UTxOs in
// txid#index order with LargestFirstMultiAsset or RandomImproveMultiAsset,
// add_change_if_needed at the change address, build_tx, and the witness set
// filled with synthetic witnesses, one per distinct key payment credential
// among the chosen inputs. It is never a baseline and never appears in a
// study run's results.

import { cslConfig, classOfCslError } from '../../src/oracle/policies.mjs';
import { spendable } from '../../src/state/state.mjs';
import { inspectTx } from '../../src/kit/inspect.mjs';

const hex = (b) => Buffer.from(b).toString('hex');

export function cslSelect(T, state, spend, params, { strategy = 'lf', preferPure = false } = {}) {
  const CSL = T.CSL;
  const objs = [];
  const own = (o) => (objs.push(o), o);
  try {
    const cfg = own(cslConfig(CSL, params, preferPure));
    const b = own(CSL.TransactionBuilder.new(cfg));
    for (const o of spend.requested) b.add_output(own(CSL.TransactionOutput.from_bytes(Buffer.from(o.cbor, 'hex'))));
    const utxos = own(CSL.TransactionUnspentOutputs.new());
    for (const u of spendable(state)) utxos.add(own(CSL.TransactionUnspentOutput.from_hex(u.cbor)));
    const st = strategy === 'lf' ? CSL.CoinSelectionStrategyCIP2.LargestFirstMultiAsset : CSL.CoinSelectionStrategyCIP2.RandomImproveMultiAsset;
    try {
      b.add_inputs_from(utxos, st);
      b.add_change_if_needed(own(CSL.Address.from_bech32(state.changeAddress)));
    } catch (e) {
      const text = String(e && (e.message || e));
      return { ok: false, class: classOfCslError(text), detail: text };
    }
    const tx = own(b.build_tx());
    const body = own(tx.body());
    const ins = own(body.inputs());
    const refs = [];
    for (let i = 0; i < ins.len(); i++) {
      const x = own(ins.get(i));
      const th = own(x.transaction_id());
      refs.push(`${th.to_hex()}#${x.index()}`);
    }
    const k = new Set(refs.map((r) => state.utxos.get(r).cred)).size;
    const full = own(CSL.Transaction.new(body, own(T.build.makeWitnessSet(k)), undefined));
    const bytes = hex(full.to_bytes());
    return { ok: true, bytes, walletInputs: refs, fee: inspectTx(bytes).fee, k };
  } finally {
    for (const o of objs.reverse()) {
      try {
        o.free();
      } catch {
        // already consumed
      }
    }
  }
}
