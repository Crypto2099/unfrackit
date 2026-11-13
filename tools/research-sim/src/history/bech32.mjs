// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Bech32 (BIP-173) without the 90-character limit, as CIP-19 ("User-facing
// Encoding") uses it for Shelley and stake addresses. Address layouts are in
// address.mjs.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >> from) throw new Error('bech32: value out of range');
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || (acc << (to - bits)) & maxv) {
    throw new Error('bech32: invalid padding');
  }
  return out;
}

export function decode(str) {
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) throw new Error('bech32: mixed case');
  const s = str.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) throw new Error('bech32: bad separator position');
  const hrp = s.slice(0, pos);
  for (const c of hrp) if (c.charCodeAt(0) < 33 || c.charCodeAt(0) > 126) throw new Error('bech32: bad prefix');
  const data = [];
  for (const c of s.slice(pos + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) throw new Error('bech32: bad character');
    data.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error('bech32: bad checksum');
  return { hrp, bytes: Buffer.from(convertBits(data.slice(0, -6), 5, 8, false)) };
}

export function encode(hrp, bytes) {
  const data = convertBits([...bytes], 8, 5, true);
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const chk = [];
  for (let i = 0; i < 6; i++) chk.push((mod >> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data, ...chk].map((v) => CHARSET[v]).join('');
}
