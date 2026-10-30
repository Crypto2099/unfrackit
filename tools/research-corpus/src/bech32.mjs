// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Bech32 (BIP-173) without the 90-character limit, as CIP-19 ("User-facing
// Encoding") uses it for Shelley and stake addresses, and the CIP-19 byte
// layout of the address types this tool reads.

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

// CIP-19 "Binary format": header type in bits 7..4, network tag in bits 3..0
// (0 testnet, 1 mainnet). Types 0 to 3 carry a 28-byte payment part and a
// 28-byte delegation part (57 bytes in all); 14 and 15 are reward addresses
// (29 bytes).
export function parseAddress(bech) {
  const { hrp, bytes } = decode(bech);
  const header = bytes[0];
  const type = header >> 4;
  const network = header & 15;
  const out = { hrp, bytes, type, network };
  if (type <= 3) {
    if (bytes.length !== 57) throw new Error(`address type ${type} must be 57 bytes, found ${bytes.length}`);
    out.paymentHash = bytes.subarray(1, 29).toString('hex');
    out.paymentIsScript = type === 1 || type === 3;
    out.stakeHash = bytes.subarray(29, 57).toString('hex');
    out.stakeIsScript = type === 2 || type === 3;
  } else if (type === 14 || type === 15) {
    if (bytes.length !== 29) throw new Error(`reward address must be 29 bytes, found ${bytes.length}`);
    out.stakeHash = bytes.subarray(1, 29).toString('hex');
    out.stakeIsScript = type === 15;
  }
  return out;
}

// The reward address (CIP-19 "Stake Addresses") of a base address's
// delegation part: header 0xe0 | network for a key hash, 0xf0 | network for a
// script hash.
export function rewardAddressOf(bech) {
  const a = parseAddress(bech);
  if (a.type > 3) throw new Error('not a base address');
  const header = ((a.stakeIsScript ? 15 : 14) << 4) | a.network;
  const raw = Buffer.concat([Buffer.from([header]), Buffer.from(a.stakeHash, 'hex')]);
  return { raw, bech: encode(a.network === 1 ? 'stake' : 'stake_test', raw) };
}
