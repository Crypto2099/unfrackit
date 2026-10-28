// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A wallet's state in one arm:
//
//   { network, stakeCred, changeAddress, utxos, at: { slot, time }, franken }
//
//   stakeCred      the wallet's stake credential, hex
//   changeAddress  bech32 text, the change address of every method in the arm
//                  at this point of the replay; null before the wallet has
//                  received any output the change-address rule can name, when
//                  no method or plan may run on the state
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
import { decodeOutputBytes } from '../history/output.mjs';
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

function checkChangeAddress(changeAddress, stakeCred) {
  if (changeAddress === null) return;
  const ca = parseAddress(addressBytes(changeAddress));
  if (ca.stake !== stakeCred) throw new Error('state: the change address does not carry the wallet\'s stake credential');
  if (ca.paymentKind !== 'key') throw new Error('state: the change address must have a key payment credential');
}

export function makeState({ network, stakeCred, changeAddress, utxos, at = { slot: null, time: null }, franken = [] }) {
  if (!/^[0-9a-f]{56}$/.test(stakeCred)) throw new TypeError('state: the stake credential must be 28 bytes of hex');
  if (changeAddress === undefined) throw new TypeError('state: no change address (null when the rule names none yet)');
  checkChangeAddress(changeAddress, stakeCred);
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

// The state with the change address the rule names at a later point.
export function withChangeAddress(s, changeAddress) {
  if (changeAddress === s.changeAddress) return s;
  checkChangeAddress(changeAddress, s.stakeCred);
  return Object.freeze({ ...s, changeAddress });
}

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

// The change-address rule, over a set of outputs: the address of the latest
// one (largest creating transaction id, then output index) at a key payment
// credential and a base address (CIP-0019, "Shelley addresses": header types
// 0 and 2). An output whose payment credential the franken rule flags is
// passed over: change sent there would be held at once and never spent again.
const nameable = (a, franken) => a.paymentKind === 'key' && a.type <= 3 && !(franken && franken.has(a.payment));
const later = (o, best) => !best || o.txId > best.txId || (o.txId === best.txId && o.index > best.index);

// The rule over a set of UTxOs alone (a start state): { address, txId, index }
// or null. `created` maps a ref to the creating transaction's id in chain
// order (db-sync's tx.id); a UTxO without one makes the rule inapplicable,
// which stops the run rather than guessing.
export function latestKeyBase(utxos, created) {
  let best = null;
  for (const u of utxos) {
    if (u.held === 'franken') continue;
    const a = parseAddress(addressBytes(u.address));
    if (!nameable(a, null)) continue;
    const txId = created.get(u.ref);
    if (txId === undefined) throw new Error(`change address: no creating transaction id for ${u.ref}`);
    const o = { address: u.address, txId, index: indexOf(u.ref) };
    if (later(o, best)) best = o;
  }
  return best;
}

export function latestKeyBaseAddress(utxos, created) {
  const best = latestKeyBase(utxos, created);
  if (!best) throw new Error('change address: the wallet has no output at a key payment credential and a base address');
  return best.address;
}

// The outputs an event brings to the wallet on the chain: a deposit's UTxOs,
// and the observed wallet outputs of a spend (a phase-2-invalid spend's
// collateral return among them) and of a self-reorganization, the real
// wallet's own change included.
function receivedOutputs(e) {
  const of = (list) =>
    list.map((o) => {
      const bytes = decodeOutputBytes(Buffer.from(o.cbor, 'hex')).address;
      return { address: addressTextOf(bytes), addr: parseAddress(bytes), index: o.index };
    });
  let outs = [];
  if (e.kind === 'deposit') outs = e.utxos.map((u) => ({ address: u.address, addr: parseAddress(addressBytes(u.address)), index: indexOf(u.ref) }));
  else if (e.kind === 'intent') outs = e.intent.observed ? of(e.intent.observed.walletOutputs) : [];
  else if (e.kind === 'self-reorganization') outs = of(e.walletOutputs || []);
  if (outs.length && !Number.isSafeInteger(e.txId)) throw new Error(`change address: a ${e.kind} event without its transaction id`);
  return outs.map((o) => ({ ...o, txId: e.txId }));
}

// The rule over every output the wallet has received on the chain up to each
// point of the window, so that every arm and method has the same change
// address at a given point, and the address moves as later outputs arrive.
// `before` is the latest such output received before the window ({ address,
// txId, index } or null). Every event is given `changeAddress`, the address in
// effect when it applies: an event's own outputs count from the next event
// on. Returns the address at the window's start and after its last event.
export function annotateChangeAddresses(before, events, franken) {
  let best = before ? { address: before.address, txId: before.txId, index: before.index } : null;
  for (const e of events) {
    e.changeAddress = best ? best.address : null;
    for (const o of receivedOutputs(e)) if (nameable(o.addr, franken) && later(o, best)) best = { address: o.address, txId: o.txId, index: o.index };
  }
  return { start: before ? before.address : null, end: best ? best.address : null };
}

export const CHANGE_GAPS = Object.freeze({
  none: 'the wallet receives no output at a key payment credential and a base address, so the change-address rule names no address',
  spendable: 'the wallet holds a spendable UTxO before it receives an output at a key payment credential and a base address, so the change-address rule names no address for a plan',
  spend: 'the wallet spends before it receives an output at a key payment credential and a base address, so the change-address rule names no address for the spend'
});

// Where a replay needs a change address the rule does not name: the wallet
// spends, or holds a spendable UTxO a plan could spend, before the first
// output the rule can name, or never receives one. Returns null or the
// reason, the same in every arm, so that a wallet is refused in all of them
// or in none. Before the first such output a state holds no spendable UTxO,
// so no plan has anything to propose. Events without `changeAddress` keep the
// address in effect; once named, an address stays named.
export function changeAddressGap({ changeAddress, changeAddressEnd, start, events }) {
  let address = changeAddress ?? null;
  let spendableN = start.filter((u) => u.held === null).length;
  for (const e of events) {
    if (e.changeAddress !== undefined) address = e.changeAddress;
    if (address !== null) return null;
    if (spendableN) return CHANGE_GAPS.spendable;
    if (e.kind === 'intent') return CHANGE_GAPS.spend;
    if (e.kind === 'deposit') spendableN += e.utxos.filter((u) => u.held === null).length;
  }
  if ((changeAddressEnd !== undefined ? changeAddressEnd : address) !== null) return null;
  return spendableN ? CHANGE_GAPS.spendable : CHANGE_GAPS.none;
}
