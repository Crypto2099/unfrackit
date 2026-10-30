// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// CIP-67 "Specification": an asset name label is a 4-byte prefix
//   [ 0000 | 16 bits label_num | 8 bits checksum | 0000 ]
// where the checksum is CRC-8 (polynomial 0x07, initial value 0, no reflection,
// no final xor) over the two label_num bytes. CIP-67 "Test Vectors" are
// reproduced in test/vectors.test.mjs. CIP-68 "Labels" uses the prefix on the
// 100, 222, 333 and 444 asset names.

export function crc8(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

export function labelPrefixHex(label) {
  if (!Number.isInteger(label) || label < 0 || label > 0xffff) throw new RangeError('label out of range: ' + label);
  const crc = crc8([label >> 8, label & 0xff]);
  return (((label << 12) | (crc << 4)) >>> 0).toString(16).padStart(8, '0');
}

// The label number carried by an asset name, or null when the name has no valid
// prefix (too short, non-zero brackets, or checksum mismatch).
export function labelOf(assetNameHex) {
  if (typeof assetNameHex !== 'string' || assetNameHex.length < 8) return null;
  const b = [0, 2, 4, 6].map((i) => parseInt(assetNameHex.slice(i, i + 2), 16));
  if (b[0] >> 4 !== 0 || (b[3] & 0x0f) !== 0) return null;
  const label = ((b[0] & 0x0f) << 12) | (b[1] << 4) | (b[2] >> 4);
  const checksum = ((b[2] & 0x0f) << 4) | (b[3] >> 4);
  return crc8([label >> 8, label & 0xff]) === checksum ? label : null;
}

// CIP-67: the full asset name, prefix plus content, is at most 32 bytes.
export function withLabel(label, nameHex = '') {
  const hex = labelPrefixHex(label) + nameHex;
  if (hex.length > 64) throw new RangeError('asset name over 32 bytes');
  return hex;
}
