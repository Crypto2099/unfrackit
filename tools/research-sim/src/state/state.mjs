// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A wallet's state in one arm:
//
//   { network, stakeCred, changeAddress, utxos, at: { slot, time }, franken }
//
//   stakeCred      the wallet's stake credential, hex
//   changeAddress  bech32 text, the change address of every method in the arm
//   utxos          Map ref -> UTxO record (state/utxo.mjs), in ref order:
//                  transaction id bytes, then output index, ascending
//   franken        the franken-flagged payment credentials (a Set of hex)
//
// States are never changed in place: every operation returns a new state.
//
// Applying a built transaction removes its wallet inputs and adds, under the
// transaction's body hash, the outputs that carry the wallet's stake
// credential (CIP-0019, "Delegation part"), so that a chain's later
// transactions spend the earlier ones' outputs. Payments to other stake
// credentials leave the wallet.

import { parseAddress, addressBytes } from '../history/address.mjs';
import { utxoFromOutput, addressTextOf } from './utxo.mjs';
import { inspectTx } from '../kit/inspect.mjs';

const txidOf = (ref) => ref.slice(0, ref.indexOf('#'));
const indexOf = (ref) => Number(ref.slice(ref.indexOf('#') + 1));

// txid#index ascending: the id as hex (the same order as its bytes), then the
// index as a number.
export function cmpRef(a, b) {
  const x = txidOf(a);
  const y = txidOf(b);
  return x < y ? -1 : x > y ? 1 : indexOf(a) - indexOf(b);
}

function sortedMap(utxos) {
  const list = [...utxos].sort((a, b) => cmpRef(a.ref, b.ref));
  const m = new Map();
  for (const u of list) {
    if (m.has(u.ref)) throw new Error(`state: ${u.ref} twice`);
    m.set(u.ref, u);
  }
  return m;
}

export function makeState({ network, stakeCred, changeAddress, utxos, at = { slot: null, time: null }, franken = [] }) {
  if (!/^[0-9a-f]{56}$/.test(stakeCred)) throw new TypeError('state: the stake credential must be 28 bytes of hex');
  const ca = parseAddress(addressBytes(changeAddress));
  if (ca.stake !== stakeCred) throw new Error('state: the change address does not carry the wallet\'s stake credential');
  if (ca.paymentKind !== 'key') throw new Error('state: the change address must have a key payment credential');
  return Object.freeze({
    network,
    stakeCred,
    changeAddress,
    utxos: sortedMap(utxos),
    at: Object.freeze({ ...at }),
    franken: franken instanceof Set ? franken : new Set(franken)
  });
}

const withUtxos = (s, utxos, at = s.at) => Object.freeze({ ...s, utxos: sortedMap(utxos), at: Object.freeze({ ...at }) });

export const spendable = (s) => [...s.utxos.values()].filter((u) => u.held === null);
export const held = (s) => [...s.utxos.values()].filter((u) => u.held !== null);

// Whether an output's address carries the wallet's stake credential.
export function isWalletAddress(s, addressBytesOrParsed) {
  const a = addressBytesOrParsed.type !== undefined ? addressBytesOrParsed : parseAddress(addressBytesOrParsed);
  return a.stake === s.stakeCred && (a.stakeKind === 'key' || a.stakeKind === 'script');
}

// The state after a built transaction (its bytes). `walletInputs` are the
// state's UTxOs it spends; every one must be in the state and spendable;
// `heldInputs` are held UTxOs the intent spends as fixed inputs. `notWallet`
// (a Set of bech32 addresses) names outputs to treat as payments although
// their address carries the wallet's stake credential: only the comparison
// with the treatment's own runner uses it, whose test payees share the
// shapes' stake key.
export function applyTx(s, { bytes, walletInputs, heldInputs = [], notWallet = null }, at = s.at) {
  const t = inspectTx(bytes);
  const m = new Map(s.utxos);
  const inputs = new Set(t.inputs.map((x) => x.ref));
  for (const r of walletInputs) {
    const u = m.get(r);
    if (!u) throw new Error(`apply: wallet input ${r} is not in the state`);
    if (u.held !== null) throw new Error(`apply: wallet input ${r} is held`);
    if (!inputs.has(r)) throw new Error(`apply: ${r} is not an input of the transaction`);
    m.delete(r);
  }
  for (const r of heldInputs) {
    if (!m.has(r)) throw new Error(`apply: held input ${r} is not in the state`);
    if (!inputs.has(r)) throw new Error(`apply: ${r} is not an input of the transaction`);
    m.delete(r);
  }
  for (const r of inputs) if (m.has(r)) throw new Error(`apply: the transaction spends ${r}, which the method did not name`);
  for (const o of t.outputs) {
    if (!isWalletAddress(s, o.addr)) continue;
    if (notWallet && notWallet.has(addressTextOf(o.address))) continue;
    const u = utxoFromOutput(t.hash, o.index, o.raw, { franken: s.franken, origin: 'built' });
    m.set(u.ref, u);
  }
  return { state: withUtxos(s, m.values(), at), hash: t.hash };
}

// UTxOs received from outside the wallet (a deposit).
export function addUtxos(s, utxos, at = s.at) {
  const m = new Map(s.utxos);
  for (const u of utxos) {
    if (m.has(u.ref)) throw new Error(`deposit: ${u.ref} is already in the state`);
    m.set(u.ref, u);
  }
  return withUtxos(s, m.values(), at);
}

// Held UTxOs consumed by a transaction that is not the wallet's spend.
export function removeHeld(s, refs, at = s.at) {
  const m = new Map(s.utxos);
  for (const r of refs) {
    const u = m.get(r);
    if (!u) throw new Error(`held-consumed: ${r} is not in the state`);
    if (u.held === null) throw new Error(`held-consumed: ${r} is not held`);
    m.delete(r);
  }
  return withUtxos(s, m.values(), at);
}

// Totals over a list of UTxOs.
export function holdings(utxos) {
  let coin = 0n;
  const assets = new Map();
  for (const u of utxos) {
    coin += u.coin;
    for (const a of u.assets) {
      const k = `${a.policy}.${a.name}`;
      const e = assets.get(k);
      if (e) e.qty += a.qty;
      else assets.set(k, { policy: a.policy, name: a.name, qty: a.qty, utxos: 0 });
      assets.get(k).utxos++;
    }
  }
  return { coin, assets };
}

// The change address rule: the address of the wallet's most recently created
// output at a key payment credential and a base address (largest creating
// transaction id, then output index). `created` maps a ref to the creating
// transaction's id in chain order (db-sync's tx.id); a UTxO without one makes
// the rule inapplicable, which stops the run rather than guessing.
export function latestKeyBaseAddress(utxos, created) {
  let best = null;
  for (const u of utxos) {
    const a = parseAddress(addressBytes(u.address));
    if (a.paymentKind !== 'key' || a.type > 3) continue;
    const id = created.get(u.ref);
    if (id === undefined) throw new Error(`change address: no creating transaction id for ${u.ref}`);
    const idx = indexOf(u.ref);
    if (!best || id > best.id || (id === best.id && idx > best.index)) best = { id, index: idx, address: u.address };
  }
  if (!best) throw new Error('change address: the wallet has no output at a key payment credential and a base address');
  return best.address;
}
