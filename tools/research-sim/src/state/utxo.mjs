// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// UTxO records:
//
//   { ref, cbor, address, cred, coin, assets, held, origin }
//
//   ref      'txid#index', the id lowercase hex, the index decimal
//   cbor     the CIP-30 TransactionUnspentOutput, [input, output], as hex
//            (CIP-0030, "TransactionUnspentOutput")
//   address  the output's address as bech32 text
//   cred     the payment credential, hex (a key hash or a script hash)
//   coin     bigint lovelace
//   assets   [{ policy, name, qty }], hex policy and name, bigint qty, sorted
//            by policy then name bytes (the ledger's order)
//   held     null, or why the UTxO is held: 'script-payment', 'datum',
//            'reference-script' or 'franken'
//   origin   'initial' (the arm's start state), 'deposit' (received during
//            the window) or 'built' (an output of a transaction the arm built)
//
// The history reader writes the same records (history/wallet.mjs utxoRecord)
// with amounts as decimal strings; utxoFromRecord reads them.
//
// Held UTxOs count in holdings and are never offered to a selector or spent by
// the planner: a script payment credential (it cannot be spent with a vkey
// witness; CIP-0019, "Payment part"), a datum or a reference script, or a
// payment credential the franken rule flags. A Byron output carries no stake
// credential and so is never a wallet's.

import { unspentOutput } from '../history/output.mjs';
import { sortAssets } from '../history/value.mjs';
import { encode as bech32encode } from '../history/bech32.mjs';
import { addressBytes } from '../history/address.mjs';
import { unspentOutputParts } from '../kit/inspect.mjs';

export const HELD = Object.freeze({ script: 'script-payment', datum: 'datum', refScript: 'reference-script', franken: 'franken' });
const HELD_VALUES = new Set(Object.values(HELD));
const ORIGINS = new Set(['initial', 'deposit', 'built']);

// Bech32 text of a Shelley address's bytes, the prefix by its network tag
// (CIP-0019, "Network Tag": 1 mainnet, 0 the test networks).
export function addressTextOf(bytes) {
  const b = Buffer.from(bytes);
  const type = b[0] >> 4;
  if (type === 8) throw new Error('a Byron address is never a wallet\'s');
  const mainnet = (b[0] & 15) === 1;
  if (type === 14 || type === 15) return bech32encode(mainnet ? 'stake' : 'stake_test', b);
  return bech32encode(mainnet ? 'addr' : 'addr_test', b);
}

export function heldReason({ addr, datum, scriptRef }, franken) {
  if (addr.paymentKind === 'script') return HELD.script;
  if (datum) return HELD.datum;
  if (scriptRef) return HELD.refScript;
  if (franken && franken.has(addr.payment)) return HELD.franken;
  return null;
}

// A record from its CIP-30 CBOR, the held reason derived from the output.
export function utxoFromCbor(cborHex, { franken = null, origin }) {
  const u = unspentOutputParts(cborHex);
  if (u.addr.type === 8) throw new Error(`${u.ref}: a Byron output is never a wallet's`);
  return freezeUtxo({
    ref: u.ref,
    cbor: cborHex,
    address: addressTextOf(u.address),
    cred: u.addr.payment,
    coin: u.coin,
    assets: sortAssets(u.assets),
    held: heldReason(u, franken),
    origin
  });
}

// A record for output `index` of the transaction `txid`, from the output's
// bytes as they sit in the transaction.
export function utxoFromOutput(txid, index, outputRaw, { franken = null, origin = 'built' } = {}) {
  return utxoFromCbor(unspentOutput(txid, index, outputRaw).toString('hex'), { franken, origin });
}

// A record as the history reader writes it, checked against its own CBOR.
export function utxoFromRecord(r, { franken = null } = {}) {
  if (!r || typeof r.ref !== 'string' || typeof r.cbor !== 'string') throw new TypeError('UTxO record: no ref or cbor');
  if (!ORIGINS.has(r.origin)) throw new TypeError(`UTxO record ${r.ref}: unknown origin ${r.origin}`);
  if (r.held !== null && !HELD_VALUES.has(r.held)) throw new TypeError(`UTxO record ${r.ref}: unknown held reason ${r.held}`);
  const fromCbor = utxoFromCbor(r.cbor, { franken, origin: r.origin });
  const assets = sortAssets((r.assets || []).map((a) => ({ policy: a.policy, name: a.name, qty: BigInt(a.qty) })));
  const same =
    fromCbor.ref === r.ref &&
    fromCbor.coin === BigInt(r.coin) &&
    Buffer.compare(addressBytes(r.address), addressBytes(fromCbor.address)) === 0 &&
    fromCbor.assets.length === assets.length &&
    fromCbor.assets.every((a, i) => a.policy === assets[i].policy && a.name === assets[i].name && a.qty === assets[i].qty);
  if (!same) throw new Error(`UTxO record ${r.ref}: its fields differ from its CBOR`);
  // The record's own held reason stands: it may be franken, which the output
  // alone cannot show. Every reason the output shows must agree with it.
  if ((fromCbor.held !== null || r.held !== HELD.franken) && r.held !== null && r.held !== fromCbor.held) {
    throw new Error(`UTxO record ${r.ref}: held ${r.held}, the output says ${fromCbor.held}`);
  }
  if (r.held === null && fromCbor.held !== null) throw new Error(`UTxO record ${r.ref}: not held, the output says ${fromCbor.held}`);
  return freezeUtxo({ ...fromCbor, address: r.address, cred: r.cred ?? fromCbor.cred, held: r.held });
}

function freezeUtxo(u) {
  for (const a of u.assets) Object.freeze(a);
  Object.freeze(u.assets);
  return Object.freeze(u);
}

// The record as JSON (bigint as decimal strings).
export const utxoJson = (u) => ({ ...u, coin: u.coin.toString(), assets: u.assets.map((a) => ({ policy: a.policy, name: a.name, qty: a.qty.toString() })) });
