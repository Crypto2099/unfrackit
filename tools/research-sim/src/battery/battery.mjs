// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The battery intents, made at the snapshot from a wallet's observed layout.
//
// The standard battery (for every token-holding wallet of the random sample):
//   ada-payment     pay an ADA amount drawn from the pool of observed T1
//                   amounts to an external key address
//   one-nft         send one held NFT, chosen uniformly
//   fungible-share  send a share of one held fungible, the fungible chosen
//                   uniformly, the share drawn from the pool of observed T5
//                   shares (units sent over the units held before the spend);
//                   the output carries floor(share * balance) units
//   policy-nfts     send all held NFTs of one policy, the policy chosen
//                   uniformly
//   fungible-p      send p of one fungible's balance, for p in {0.25, 0.5,
//                   0.75, 0.9}: the fungible the wallet holds on the most
//                   spendable UTxOs, ties going to the larger total of units,
//                   then to the lower policy and asset-name bytes; the output
//                   carries floor(p * balance) units, at least one
//   payroll         k recipients, k in {10, 100}, each paid an equal share,
//                   rounded down, of half the wallet's balance of the payment
//                   asset, plus the minimum ADA of its output; the payment
//                   asset is the fungible-p spend's fungible when the wallet
//                   holds one, otherwise ADA, an ADA share being raised to the
//                   pure-ADA minimum when below it
// H-10's battery: pay p of the wallet's ADA balance (the coin of all its
// spendable UTxOs) to an external key address, for p in {0.25, 0.5, 0.75,
// 0.9}; the same amounts serve the tidy layout (setting h10Amount
// 'observed'). The wallet is token-laden for p when its pure-ADA UTxOs cannot
// cover the amount.
//
// Every token output carries its minimum ADA. A requested token output over
// the value-size limit is split into as many outputs as needed, in policy and
// asset-name order, each at its minimum (setting oversizeRequest 'split').
// Assets are classified by the decided rule (planner2.mjs classifyAssets: a
// CIP-67 label decides, 333 and 444 fungible, 222, 100 and 500 non-fungible
// unless more than one unit is held; otherwise more than one unit held makes
// an asset fungible; CIP-0067, "Specification"; CIP-0068, "Labels") over the
// whole wallet, held UTxOs included; choices are made among spendable holdings
// only.
//
// Draws (setting batteryDraws 'pool'): one mulberry32 generator per wallet and
// spend kind, seeded from the first four bytes, read big-endian, of
// SHA-256("battery" || 28-byte stake credential || the kind's ASCII name); a
// uniform choice among n items takes index floor(next() * n). The pools are
// inputs: for the study, the frozen pools of the exploration split's
// recent-window spends; for the synthetic shapes, which have no history,
// SHAPE_POOLS below.
//
// A case the rules leave open is not built: the spend is returned as
// { kind, unsettled } and reported. These are: a drawn ADA amount under the
// minimum of its output; a fungible share or a payroll token share that
// rounds down to zero units.

import { createHash } from 'node:crypto';
import { makeRng } from '../shapes/rng.mjs';
import { treatmentParams } from '../treatment/bridge.mjs';
import { selectAdapterFor } from './suffices.mjs';
import { recipientAddress } from './recipients.mjs';
import { spendable, holdings } from '../state/state.mjs';
import { batteryIntent } from '../state/intent.mjs';
import { outputBytes } from '../kit/assemble.mjs';

export const P_GRID = Object.freeze([[1n, 4n], [1n, 2n], [3n, 4n], [9n, 10n]]);
export const PAYROLL_K = Object.freeze([10, 100]);
const ADA = 1000000n;

// Fixed test values for the shapes: the ADA amounts of the treatment's own
// battery runner (2, 20 and 200 ADA) and its fungible shares (10, 50 and
// 100 percent), as [units, units held] pairs.
export const SHAPE_POOLS = Object.freeze({
  t1: Object.freeze([2n * ADA, 20n * ADA, 200n * ADA]),
  t5: Object.freeze([[1n, 10n], [1n, 2n], [1n, 1n]])
});

export function drawSeed(stakeCred, kind) {
  const h = createHash('sha256').update(Buffer.from('battery', 'ascii')).update(Buffer.from(stakeCred, 'hex')).update(Buffer.from(kind, 'ascii')).digest();
  return h.readUInt32BE(0);
}
const drawer = (stakeCred, kind) => {
  const rng = makeRng(drawSeed(stakeCred, kind));
  return (n) => Math.floor(rng.next() * n);
};

const key = (a) => `${a.policy}.${a.name}`;
const cmpKey = (a, b) => (a.policy < b.policy ? -1 : a.policy > b.policy ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const pLabel = ([n, d]) => (Number(n) / Number(d)).toString();

// The coin of an output at its own minimum (the minimum depends on the coin's
// width).
function minCoinFor(adapter, address, tokens) {
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

// Tokens into outputs at their minimum, in order, each output as full as the
// value-size limit allows.
function splitOutputs(T, adapter, address, tokens, maxValSize) {
  const outs = [];
  let cur = [];
  for (const t of tokens) {
    const cand = cur.concat([t]);
    const vb = adapter.paymentOutput(address, minCoinFor(adapter, address, cand), cand).valueBytes;
    if (vb <= maxValSize || !cur.length) cur = cand;
    else {
      outs.push(cur);
      cur = [t];
    }
  }
  if (cur.length) outs.push(cur);
  return outs.map((ts) => output(T, adapter, address, null, ts));
}

function walletView(T, state) {
  const spend = spendable(state);
  const { coin, assets } = holdings(spend);
  const classes = T.planner.classifyAssets([...state.utxos.values()]);
  const all = [...assets.values()].sort(cmpKey);
  return {
    spend,
    coin,
    pureCoin: spend.filter((u) => !u.assets.length).reduce((s, u) => s + u.coin, 0n),
    nfts: all.filter((h) => classes.get(key(h)).cls === 'nft'),
    fts: all.filter((h) => classes.get(key(h)).cls === 'ft')
  };
}

// The fungible of the fungible-p and payroll spends, or null.
export function spreadFungible(fts) {
  let best = null;
  for (const h of fts) {
    if (!best || h.utxos > best.utxos || (h.utxos === best.utxos && (h.qty > best.qty || (h.qty === best.qty && cmpKey(h, best) < 0)))) best = h;
  }
  return best;
}

// The standard battery. pools: { t1: [bigint lovelace], t5: [[units, held]] }.
// Returns intents and unsettled cases in battery order.
export function standardBattery(T, state, params, { pools }) {
  const tp = treatmentParams(T, params);
  const adapter = selectAdapterFor(T, state, tp);
  const w = walletView(T, state);
  const ext = recipientAddress(state.network, 0);
  const out = [];
  const add = (kind, requested, meta) => out.push(batteryIntent({ id: kind, type: kind.replace(/-[0-9.]+$/, ''), requested, meta }));

  if (pools.t1.length) {
    const amount = BigInt(pools.t1[drawer(state.stakeCred, 'ada-payment')(pools.t1.length)]);
    const min = minCoinFor(adapter, ext, []);
    if (amount < min) out.push({ kind: 'ada-payment', unsettled: 'ada-amount-below-minimum', meta: { amount, min } });
    else add('ada-payment', [output(T, adapter, ext, amount, [])], { amount });
  }
  if (w.nfts.length) {
    const h = w.nfts[drawer(state.stakeCred, 'one-nft')(w.nfts.length)];
    add('one-nft', [output(T, adapter, ext, null, [{ policy: h.policy, name: h.name, qty: 1n }])], { asset: key(h) });
  }
  if (w.fts.length && pools.t5.length) {
    const d = drawer(state.stakeCred, 'fungible-share');
    const h = w.fts[d(w.fts.length)];
    const [u, held] = pools.t5[d(pools.t5.length)].map(BigInt);
    const units = (h.qty * u) / held;
    if (units === 0n) out.push({ kind: 'fungible-share', unsettled: 'share-rounds-to-zero', meta: { asset: key(h), share: [u, held] } });
    else add('fungible-share', [output(T, adapter, ext, null, [{ policy: h.policy, name: h.name, qty: units }])], { asset: key(h), share: [u, held], units });
  }
  if (w.nfts.length) {
    const policies = [...new Set(w.nfts.map((h) => h.policy))].sort();
    const pol = policies[drawer(state.stakeCred, 'policy-nfts')(policies.length)];
    const tokens = w.nfts.filter((h) => h.policy === pol).map((h) => ({ policy: h.policy, name: h.name, qty: h.qty }));
    add('policy-nfts', splitOutputs(T, adapter, ext, tokens, tp.maxValSize), { policy: pol, nfts: tokens.length });
  }
  const f = spreadFungible(w.fts);
  if (f) {
    for (const p of P_GRID) {
      let units = (f.qty * p[0]) / p[1];
      if (units < 1n) units = 1n;
      add(`fungible-p-${pLabel(p)}`, [output(T, adapter, ext, null, [{ policy: f.policy, name: f.name, qty: units }])], { asset: key(f), p: p.map(String), units });
    }
  }
  for (const k of PAYROLL_K) {
    const kind = `payroll-${k}`;
    const addrs = Array.from({ length: k }, (_, i) => recipientAddress(state.network, i));
    if (f) {
      const each = f.qty / 2n / BigInt(k);
      if (each === 0n) {
        out.push({ kind, unsettled: 'payroll-share-rounds-to-zero', meta: { asset: key(f), k } });
        continue;
      }
      add(kind, addrs.map((a) => output(T, adapter, a, null, [{ policy: f.policy, name: f.name, qty: each }])), { asset: key(f), k, each });
    } else {
      const share = w.coin / 2n / BigInt(k);
      add(kind, addrs.map((a) => {
        const min = minCoinFor(adapter, a, []);
        return output(T, adapter, a, share < min ? min : share, []);
      }), { asset: 'ada', k, each: share });
    }
  }
  return out;
}

// H-10's battery. `observed` is the observed layout's state, whose balance
// sets the amounts in every layout; `state` is the layout the spends are made
// from.
export function h10Battery(T, state, params, { observed = state } = {}) {
  const tp = treatmentParams(T, params);
  const adapter = selectAdapterFor(T, state, tp);
  const o = walletView(T, observed);
  const w = state === observed ? o : walletView(T, state);
  const ext = recipientAddress(state.network, 0);
  const min = minCoinFor(adapter, ext, []);
  return P_GRID.map((p) => {
    const amount = (o.coin * p[0]) / p[1];
    const kind = `h10-${pLabel(p)}`;
    if (amount < min) return { kind, unsettled: 'ada-amount-below-minimum', meta: { amount, min } };
    return batteryIntent({ id: kind, source: 'h10', type: 'h10', requested: [output(T, adapter, ext, amount, [])], meta: { p: p.map(String), amount, tokenLaden: w.pureCoin < amount } });
  });
}
