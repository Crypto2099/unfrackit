// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import crypto from 'node:crypto';

export const ADA = 1000000n;

export const toHex = (b) => Buffer.from(b).toString('hex');

// Strict hex decoding: an even number of hex digits and nothing else. With
// `lower`, uppercase digits are refused (the record URIs and transaction
// hashes this tool writes are lowercase by rule).
export function fromHex(h, { lower = false, length } = {}) {
  if (typeof h !== 'string' || h.length % 2 !== 0 || !(lower ? /^[0-9a-f]*$/ : /^[0-9a-fA-F]*$/).test(h)) {
    throw new Error(`not ${lower ? 'lowercase ' : ''}hex: ${String(h).slice(0, 80)}`);
  }
  const out = new Uint8Array(Buffer.from(h, 'hex'));
  if (length !== undefined && out.length !== length) throw new Error(`expected ${length} bytes, got ${out.length}`);
  return out;
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const sha256 = (bytes) => new Uint8Array(crypto.createHash('sha256').update(bytes).digest());
export const md5Hex = (bytes) => crypto.createHash('md5').update(bytes).digest('hex');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// JSON with bigints as decimal strings and byte arrays as hex.
export function stringify(value, space) {
  return JSON.stringify(
    value,
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? toHex(v) : v),
    space
  );
}

export function tada(lovelace) {
  const n = BigInt(lovelace);
  const neg = n < 0n;
  const a = neg ? -n : n;
  return `${neg ? '-' : ''}${(a / ADA).toLocaleString('en-US')}.${(a % ADA).toString().padStart(6, '0')}`;
}

// The study classifies prior users of the app by this string, so nothing this
// tool puts on chain may contain it in any letter case: no byte of the
// transaction, no byte of the reassembled record (a string can straddle two
// 64-byte chunks, whose headers break a scan of the transaction bytes), and no
// text string in it.
export const FORBIDDEN_MARKER = 'unfrack.it';

export function stringContainsMarker(s) {
  return String(s).toLowerCase().includes(FORBIDDEN_MARKER);
}

export function containsMarker(bytes) {
  const needle = Buffer.from(FORBIDDEN_MARKER, 'ascii');
  const hay = Buffer.from(bytes);
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      let c = hay[i + j];
      if (c >= 0x41 && c <= 0x5a) c += 0x20;
      if (c !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

export class UserError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = 'UserError';
    this.exitCode = code;
  }
}
