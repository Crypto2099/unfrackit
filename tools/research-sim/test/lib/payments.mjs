// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Payment intents for the tests that need a spend to build: requested outputs
// to the synthetic recipients and nothing else (no implicit value, no fixed
// part, no script), made with the survey's intent constructor
// (state/intent.mjs batteryIntent) and the ledger kit's output encoder. Each
// output carries its own minimum coin unless a coin is given.

import { treatmentParams } from '../../src/treatment/bridge.mjs';
import { adapterFor } from '../../src/treatment/wallet.mjs';
import { recipientAddress } from '../../src/kit/recipients.mjs';
import { spendable, holdings } from '../../src/state/state.mjs';
import { batteryIntent } from '../../src/state/intent.mjs';
import { outputBytes } from '../../src/kit/assemble.mjs';

const ADA = 1000000n;
const key = (a) => `${a.policy}.${a.name}`;
const cmpKey = (a, b) => (a.policy < b.policy ? -1 : a.policy > b.policy ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const adapterOf = (T, state, params) => adapterFor(T, state.changeAddress, treatmentParams(T, params), 'select');

// The coin of an output at its own minimum (the minimum depends on the coin's
// width).
export function minCoinFor(adapter, address, tokens) {
  let coin = ADA;
  for (let i = 0; i < 10; i++) {
    const m = adapter.paymentOutput(address, coin, tokens).minCoin;
    if (m === coin) return coin;
    coin = m;
  }
  throw new Error('the minimum coin did not settle');
}

function output(T, adapter, address, coin, tokens) {
  const assets = tokens.map((t) => ({ policy: t.policy, name: t.name, qty: t.qty })).sort(cmpKey);
  const c = coin === null ? minCoinFor(adapter, address, assets) : coin;
  return { cbor: outputBytes(T, { address, coin: c, assets }).toString('hex'), address, coin: c, assets };
}

// A payment of `coin` lovelace (at least the output's minimum) and `tokens`
// ([{ policy, name, qty }]) to recipient `to`.
export function paymentIntent(T, state, params, { id, coin = null, tokens = [], to = 0 }) {
  const adapter = adapterOf(T, state, params);
  const address = recipientAddress(state.network, to);
  const min = minCoinFor(adapter, address, tokens);
  const c = coin === null ? null : coin < min ? min : coin;
  return batteryIntent({ id, type: 'payment', requested: [output(T, adapter, address, c, tokens)], meta: {} });
}

// The wallet's NFT holdings (assets of one unit across its UTxOs), in policy
// and name order.
export function nftHoldings(T, state) {
  const { assets } = holdings(spendable(state));
  const classes = T.planner.classifyAssets([...state.utxos.values()]);
  return [...assets.values()].sort(cmpKey).filter((h) => classes.get(key(h)).cls === 'nft');
}

// A payment of the share [n, d] of the wallet's spendable ADA.
export function adaShareIntent(T, state, params, [n, d], id = 'ada-share') {
  const { coin } = holdings(spendable(state));
  return paymentIntent(T, state, params, { id, coin: (coin * n) / d });
}

// A set of payments to cover the forms a spend takes: ADA payments of 2, 20
// and 200 ADA, one NFT, and the shares 1/4, 1/2, 3/4 and 9/10 of the
// spendable ADA of `observed` (the observed layout's state, by default
// `state`), so that the same amounts can be asked of a tidied layout.
export function paymentSet(T, state, params, { observed = state } = {}) {
  const set = [2n, 20n, 200n].map((ada) => paymentIntent(T, state, params, { id: `ada-${ada}`, coin: ada * ADA }));
  const nft = nftHoldings(T, state)[0];
  if (nft) set.push(paymentIntent(T, state, params, { id: 'one-nft', tokens: [{ policy: nft.policy, name: nft.name, qty: 1n }] }));
  const { coin } = holdings(spendable(observed));
  for (const [n, d] of [[1n, 4n], [1n, 2n], [3n, 4n], [9n, 10n]]) set.push(paymentIntent(T, state, params, { id: `ada-share-${n}-${d}`, coin: (coin * n) / d }));
  return set;
}

// A payroll: k recipients, each paid an equal part of half the spendable ADA
// (at least the output's minimum).
export function adaPayrollIntent(T, state, params, k, id = `payroll-${k}`) {
  const adapter = adapterOf(T, state, params);
  const { coin } = holdings(spendable(state));
  const share = coin / 2n / BigInt(k);
  const requested = Array.from({ length: k }, (_x, i) => {
    const address = recipientAddress(state.network, i);
    const min = minCoinFor(adapter, address, []);
    return output(T, adapter, address, share < min ? min : share, []);
  });
  return batteryIntent({ id, type: 'payroll', requested, meta: { k } });
}
