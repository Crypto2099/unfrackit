// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Constructed wallets for the adapters' behavior tests: UTxOs at the synthetic
// shapes' change address (the treatment's baseAddress(0)), each given as
// { coin, assets, txid? }, the transaction id by default the BLAKE2b-256 of a
// label, so that the state's order (txid#index ascending) is known to the
// test. `order` returns the refs in state order.

import { blake2b224, blake2b256 } from '../../src/history/blake2b.mjs';
import { unspentOutput } from '../../src/history/output.mjs';
import { outputBytes } from '../../src/kit/assemble.mjs';
import { utxoFromCbor } from '../../src/state/utxo.mjs';
import { makeState } from '../../src/state/state.mjs';
import { batteryIntent } from '../../src/state/intent.mjs';
import { recipientAddress } from '../../src/battery/recipients.mjs';
import { parseAddress, addressBytes } from '../../src/history/address.mjs';

export const ADA = 1000000n;
export const policy = (label) => blake2b224(Buffer.from(`test policy ${label}`, 'ascii')).toString('hex');
export const assetName = (label) => Buffer.from(label, 'ascii').toString('hex');

// txid: 64 hex characters, or a label hashed into one.
export function constructState(T, specs, { address = null } = {}) {
  const changeAddress = address || T.cslkit.baseAddress(0).to_bech32();
  const utxos = specs.map((s, i) => {
    const txid = s.txid && /^[0-9a-f]{64}$/.test(s.txid) ? s.txid : blake2b256(Buffer.from(`test utxo ${s.txid || i}`, 'ascii')).toString('hex');
    const bytes = outputBytes(T, { address: s.address || changeAddress, coin: s.coin, assets: s.assets || [] });
    return utxoFromCbor(unspentOutput(txid, s.index || 0, bytes).toString('hex'), { origin: 'initial' });
  });
  const stakeCred = parseAddress(addressBytes(changeAddress)).stake;
  return makeState({ network: 'synthetic', stakeCred, changeAddress, utxos, at: { slot: 0, time: 0 } });
}

// A battery intent paying `outputs` ({ coin, assets, to }) to the external
// recipients (recipient i by default).
export function payIntent(T, outputs, id = 'test') {
  return batteryIntent({
    id,
    type: 'test',
    requested: outputs.map((o, i) => {
      const address = o.address || recipientAddress('synthetic', o.to ?? i);
      const assets = o.assets || [];
      return { cbor: outputBytes(T, { address, coin: o.coin, assets }).toString('hex'), address, coin: o.coin, assets };
    })
  });
}

export const order = (state) => [...state.utxos.keys()];
