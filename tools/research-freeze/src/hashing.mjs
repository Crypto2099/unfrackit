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

// A DOI mentioned as a whole token. Before it: the start of the text or a
// character that cannot end a DOI name (whitespace, `:`, `/`, brackets,
// quotes). After it: the end of the text or a character that cannot continue
// one: not a letter, digit, `-`, `_` or `/`, and not a `.` followed by a
// letter or digit. So `10.5281/zenodo.1700000` does not match inside
// `10.5281/zenodo.17000001`.
export function mentionsDoi(text, doi) {
  for (let i = text.indexOf(doi); i !== -1; i = text.indexOf(doi, i + 1)) {
    const before = i === 0 ? '' : text[i - 1];
    const after = text.slice(i + doi.length, i + doi.length + 2);
    if (before && /[0-9A-Za-z._-]/.test(before)) continue;
    if (after && (/^[0-9A-Za-z_/-]/.test(after) || /^\.[0-9A-Za-z]/.test(after))) continue;
    return true;
  }
  return false;
}

// A 64-digit hex key mentioned as a whole token: not run into other hex digits.
export function mentionsHexToken(text, hex) {
  for (let i = text.indexOf(hex); i !== -1; i = text.indexOf(hex, i + 1)) {
    const before = i === 0 ? '' : text[i - 1];
    const after = text[i + hex.length] || '';
    if (!/[0-9a-fA-F]/.test(before) && !/[0-9a-fA-F]/.test(after)) return true;
  }
  return false;
}

// The record kinds whose document lists the other files' SHA-256: a freeze
// and an amendment (a new document version, with its own hash table). A
// re-typing successor carries the superseded record's digests unchanged.
export const DOCUMENT_CHECKED_KINDS = new Set(['freeze', 'amend']);

// The consistency of a record's document with the manifest: every hash line
// names a non-document item and carries its computed digest, every
// non-document item is listed exactly once, and the document carries the
// identity's signing public key and the manifest's DOI, each as a whole
// token. Any mismatch fails.
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
  if (!mentionsHexToken(text, signingPublicKeyHex)) errors.push(`the document does not carry the signing public key ${signingPublicKeyHex}`);
  if (manifest.doi && !mentionsDoi(text, manifest.doi)) errors.push(`the document does not carry the DOI ${manifest.doi} as a whole token`);
  return { ok: errors.length === 0, errors, hashLines: [...seen.values()].reduce((a, b) => a + b, 0) };
}

// The record URIs a document cites (CIP-0107 transaction-metadata URIs for
// label 309), in order and without repeats. Uppercase hex is reported, since
// this tool writes and matches record URIs in lowercase only.
export function citedRecords(text) {
  const hashes = [];
  const uppercase = [];
  for (const m of text.matchAll(/web\+cardano:\/\/transaction\/([0-9a-fA-F]{64})\/metadata\/309(?![0-9])/g)) {
    if (m[1] !== m[1].toLowerCase()) uppercase.push(m[0]);
    else if (!hashes.includes(m[1])) hashes.push(m[1]);
  }
  return { hashes, uppercase };
}
