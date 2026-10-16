// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The byte form hashed: every digest is SHA-256 over the file exactly as it
// sits on disk, byte for byte, with no normalization (CIP-190, "Exact-bytes
// scope of a PoE claim"). A text item must already be in the published form:
// valid UTF-8, no byte-order mark, LF line endings only. A file that is not is
// refused rather than normalized, unless the manifest marks it binary.

import fs from 'node:fs';
import { sha256, toHex, UserError } from './util.mjs';

export function textFormProblems(bytes) {
  const problems = [];
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) problems.push('starts with a UTF-8 byte-order mark');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    problems.push('is not valid UTF-8');
  }
  const cr = bytes.indexOf(0x0d);
  if (cr !== -1) problems.push(`contains a carriage return (first at byte ${cr})`);
  return problems;
}

export function hashItems(manifest) {
  return manifest.items.map((item) => {
    let bytes;
    try {
      bytes = new Uint8Array(fs.readFileSync(item.path));
    } catch (e) {
      throw new UserError(`cannot read ${item.name} (${item.path}): ${e.message}`);
    }
    if (!item.binary) {
      const problems = textFormProblems(bytes);
      if (problems.length) throw new UserError(`${item.name} ${problems.join(', ')}; publish it as UTF-8 with LF line endings and no byte-order mark, or mark it binary`);
    }
    const digest = sha256(bytes);
    return { ...item, bytes, size: bytes.length, digest, hex: toHex(digest) };
  });
}

// A hash line in the document: 64 lowercase hex digits, two spaces, a file
// name (the form of the pre-registration's hash table).
const HASH_LINE_RE = /^([0-9a-f]{64}) {2}(\S+)$/;
const LOOSE_HASH_LINE_RE = /^\s*([0-9a-fA-F]{64})\s+(\S+)\s*$/;

// The consistency of a freeze record's document with the manifest: every hash
// line names a non-document item and carries its computed digest, every
// non-document item is listed exactly once, and the document carries the
// identity's signing public key and the manifest's DOI. Any mismatch fails.
export function documentChecks(manifest, hashed, signingPublicKeyHex) {
  const doc = hashed.find((x) => x.document);
  const text = new TextDecoder().decode(doc.bytes);
  const byName = new Map(hashed.map((x) => [x.name, x]));
  const seen = new Map();
  const errors = [];
  const lines = text.split('\n');
  lines.forEach((line, n) => {
    const m = HASH_LINE_RE.exec(line);
    if (!m) {
      const loose = LOOSE_HASH_LINE_RE.exec(line);
      if (loose && byName.has(loose[2])) errors.push(`line ${n + 1} lists ${loose[2]} but is not of the exact form "<64 lowercase hex><two spaces><file name>"`);
      return;
    }
    const [, hex, name] = m;
    const item = byName.get(name);
    if (!item) {
      errors.push(`line ${n + 1} lists ${name}, which is not an item of the manifest`);
      return;
    }
    if (item.document) {
      errors.push(`line ${n + 1} lists the document itself; a file cannot list its own hash`);
      return;
    }
    if (hex !== item.hex) errors.push(`line ${n + 1}: the document lists ${hex} for ${name}, the file's SHA-256 is ${item.hex}`);
    seen.set(name, (seen.get(name) || 0) + 1);
  });
  for (const item of hashed) {
    if (item.document) continue;
    const count = seen.get(item.name) || 0;
    if (count !== 1) errors.push(`${item.name} appears ${count} times in the document's hash table; it must appear exactly once`);
  }
  if (!text.includes(signingPublicKeyHex)) errors.push(`the document does not carry the signing public key ${signingPublicKeyHex}`);
  if (!manifest.doi || !text.includes(manifest.doi)) errors.push(`the document does not carry the DOI ${manifest.doi}`);
  return { ok: errors.length === 0, errors, hashLines: [...seen.values()].reduce((a, b) => a + b, 0) };
}
