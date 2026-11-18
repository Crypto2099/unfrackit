// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Address bytes as CIP-19 lays them out ("Binary format"): a header byte whose
// bits 7..4 are the header type and bits 3..0 the network tag, then the
// payload. Types 0 to 3 are base addresses (a 28-byte payment part, then a
// 28-byte delegation part), 4 and 5 pointer addresses (a payment part, then
// three variable-length unsigned integers), 6 and 7 enterprise addresses (a
// payment part only), 8 a Byron address (CBOR, encoded in Base58 as text), 14
// and 15 reward addresses (a 28-byte stake credential). Odd types 1, 3, 5 and
// 7 carry a script payment part ("Payment part"); types 2 and 3 a script
// delegation part.
//
// cardano-db-sync writes an output's address as text: Bech32 for Shelley
// addresses and Base58 for Byron addresses (doc/schema.md, tx_out.address, at
// tag 13.7.3.0, commit 8a2cd5f360523afc3567a0e4774ac269cd1b5516).

import { decode as bech32decode, encode as bech32encode } from './bech32.mjs';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58decode(s) {
  let n = 0n;
  for (const ch of s) {
    const d = B58.indexOf(ch);
    if (d < 0) throw new Error('base58: bad character');
    n = n * 58n + BigInt(d);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

// The bytes of an address given as db-sync text.
export function addressBytes(text) {
  if (/^(addr|addr_test)1/.test(text)) return bech32decode(text).bytes;
  return base58decode(text);
}

export function addressText(bytes, network) {
  const type = bytes[0] >> 4;
  if (type === 8) throw new Error('Byron addresses are written in Base58; take the text from db-sync');
  if (type === 14 || type === 15) return bech32encode(network === 'mainnet' ? 'stake' : 'stake_test', bytes);
  return bech32encode(network === 'mainnet' ? 'addr' : 'addr_test', bytes);
}

// { type, network, paymentKind ('key' | 'script' | null), payment (hex | null),
//   stakeKind ('key' | 'script' | 'pointer' | null), stake (hex | null) }
export function parseAddress(bytes) {
  const b = Buffer.from(bytes);
  if (!b.length) throw new Error('empty address');
  const type = b[0] >> 4;
  const out = { type, network: b[0] & 15, paymentKind: null, payment: null, stakeKind: null, stake: null };
  if (type <= 7) {
    if (b.length < 29) throw new Error(`address type ${type} shorter than its payment part`);
    out.paymentKind = type % 2 === 1 ? 'script' : 'key';
    out.payment = b.subarray(1, 29).toString('hex');
    if (type <= 3) {
      if (b.length !== 57) throw new Error(`base address of ${b.length} bytes`);
      out.stakeKind = type === 2 || type === 3 ? 'script' : 'key';
      out.stake = b.subarray(29, 57).toString('hex');
    } else if (type <= 5) {
      out.stakeKind = 'pointer';
    } else if (b.length !== 29) {
      throw new Error(`enterprise address of ${b.length} bytes`);
    }
  } else if (type === 8) {
    out.network = null;
  } else if (type === 14 || type === 15) {
    if (b.length !== 29) throw new Error(`reward address of ${b.length} bytes`);
    out.stakeKind = type === 15 ? 'script' : 'key';
    out.stake = b.subarray(1, 29).toString('hex');
  } else {
    throw new Error(`unknown address header type ${type}`);
  }
  return out;
}

// A reward address (CIP-19, "Stake Addresses"): header 0xe0 | network for a
// key hash, 0xf0 | network for a script hash, then the 28-byte credential.
export function rewardAddress(kind, hashHex, networkTag) {
  const header = ((kind === 'script' ? 15 : 14) << 4) | networkTag;
  return Buffer.concat([Buffer.from([header]), Buffer.from(hashHex, 'hex')]);
}
