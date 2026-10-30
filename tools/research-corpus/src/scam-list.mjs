// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The scam screen's list: Eternl's public registry of scam tokens, addresses
// and domains on Cardano (github.com/Tastenkunst/eternl-guard, src/entries/),
// read from a local git clone at one commit. No policy that the list names an
// asset of becomes a stratum in any part.
//
// The registry names assets by their CIP-14 fingerprints (CIP-14,
// "Specification": bech32 with prefix "asset" of the 20-byte BLAKE2b of
// policy id || asset name), one entry file per campaign, each a JSON object
// whose related_assets array lists them. The tool keeps no copy of the list:
// the record (data/scam-list.json) holds the commit, the SHA-256 of a fixed
// extract and counts, and every run reads the extract again from a clone at
// that commit and refuses one whose digest differs.
//
// The extract, byte for byte: every blob directly in src/entries/ at the
// commit whose name ends in .json is parsed as UTF-8 JSON; every string of its
// related_assets array (none when the key is absent) is trimmed of
// surrounding white space and kept when it is a valid bech32 string (all
// lowercase or all uppercase, checksum valid) with prefix "asset" and a
// 20-byte payload, written in lowercase; the distinct fingerprints are sorted
// in ascending byte order, each followed by one LF, as ASCII. Why this form:
// the screen depends only on which assets the list names, and this text is a
// function of that set alone. File names, the split of campaigns into files,
// key order, white space, descriptions, domains and addresses can change
// without changing it; a fingerprint listed twice, within one entry or in two,
// appears once; and anyone can recompute it from the commit with a JSON tool,
// `LC_ALL=C sort -u` and `sha256sum`. A mention that is not a valid
// fingerprint (the registry's own template entry lists "asset1....") is left
// out and counted. A file that is not valid JSON, or whose related_assets is
// not an array of strings, stops the capture: whether its assets are listed is
// not something the tool can decide.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decode as bech32decode } from './bech32.mjs';
import { refuse } from './checklog.mjs';
import { fingerprint as cip14 } from './strata-capture.mjs';

export const SCAM_LIST_FORMAT = 'research-corpus-scam-list-v1';
export const ETERNL_GUARD = { repository: 'github.com/Tastenkunst/eternl-guard', folder: 'src/entries' };
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function git(clone, args) {
  try {
    return execFileSync('git', ['-C', clone, ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    const msg = e.stderr ? e.stderr.toString().trim() : e.message;
    throw new Error(`git ${args[0]} in ${clone}: ${msg}`);
  }
}

// The full commit hash a revision names in the clone.
export function resolveCommit(clone, rev) {
  if (typeof rev !== 'string' || !/^[A-Za-z0-9._/^~-]+$/.test(rev) || rev.startsWith('-')) throw new Error(`not a revision: ${rev}`);
  return git(clone, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).toString().trim();
}

// Tree entries of a commit's folder ('' for the root): [{ mode, type, sha, path }].
function lsTree(clone, commit, folder) {
  const out = git(clone, ['ls-tree', '-z', commit, '--', folder ? `${folder}/` : '.']).toString('utf8');
  return out
    .split('\0')
    .filter(Boolean)
    .map((l) => {
      const m = /^(\d+) (\w+) ([0-9a-f]{40,64})\t(.*)$/s.exec(l);
      if (!m) throw new Error(`unexpected ls-tree line: ${l}`);
      return { mode: m[1], type: m[2], sha: m[3], path: m[4] };
    });
}

const blob = (clone, sha) => git(clone, ['cat-file', 'blob', sha]);

// A fingerprint as the extract writes it, or the reason it is not one.
export function fingerprintOf(value) {
  if (typeof value !== 'string') return { reason: 'not a string' };
  const v = value.trim();
  let d;
  try {
    d = bech32decode(v);
  } catch (e) {
    return { reason: e.message };
  }
  if (d.hrp !== 'asset') return { reason: `prefix ${d.hrp}` };
  if (d.bytes.length !== 20) return { reason: `${d.bytes.length}-byte payload` };
  return { fingerprint: v.toLowerCase() };
}

// The extract from the entry files: { fingerprints, text, sha256, counts,
// invalid: [{ path, value, reason }] }. files: [{ path, bytes }].
export function extractFromFiles(files) {
  const set = new Set();
  const invalid = [];
  let mentions = 0;
  for (const f of files) {
    let doc;
    try {
      doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(f.bytes));
    } catch (e) {
      throw refuse(`refusing: ${f.path} is not valid UTF-8 JSON (${e.message}); whether its assets are listed cannot be decided`);
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw refuse(`refusing: ${f.path} is not a JSON object`);
    if (doc.related_assets === undefined) continue;
    if (!Array.isArray(doc.related_assets)) throw refuse(`refusing: ${f.path}: related_assets is not an array`);
    for (const v of doc.related_assets) {
      mentions++;
      if (typeof v !== 'string') throw refuse(`refusing: ${f.path}: related_assets holds a value that is not a string`);
      const r = fingerprintOf(v);
      if (r.fingerprint) set.add(r.fingerprint);
      else invalid.push({ path: f.path, value: v, reason: r.reason });
    }
  }
  const fingerprints = [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const text = fingerprints.map((x) => `${x}\n`).join('');
  return { fingerprints, text, sha256: sha256(Buffer.from(text, 'ascii')), counts: { entry_files: files.length, mentions, invalid: invalid.length, fingerprints: fingerprints.length }, invalid };
}

// The entry files of a commit: blobs directly in src/entries/ named *.json.
export function entryFiles(clone, commit) {
  const prefix = `${ETERNL_GUARD.folder}/`;
  return lsTree(clone, commit, ETERNL_GUARD.folder)
    .filter((e) => e.type === 'blob' && e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes('/') && e.path.endsWith('.json'))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => ({ path: e.path, bytes: blob(clone, e.sha) }));
}

// License files at the root of the commit (a name containing "license",
// "licence" or "copying", in any case), each with the SHA-256 of its bytes.
export function licenseFiles(clone, commit) {
  return lsTree(clone, commit, '')
    .filter((e) => e.type === 'blob' && /licen[cs]e|copying/i.test(e.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => ({ path: e.path, sha256: sha256(blob(clone, e.sha)) }));
}

// The record capture-scam-list writes, from a clone at a revision.
export function captureScamList({ clone, rev = 'HEAD', now = () => new Date(), tool = null }) {
  const commit = resolveCommit(clone, rev);
  const commitTime = git(clone, ['show', '-s', '--format=%cI', commit]).toString().trim();
  const ex = extractFromFiles(entryFiles(clone, commit));
  const lic = licenseFiles(clone, commit);
  return {
    record: {
      format: SCAM_LIST_FORMAT,
      note: 'The scam screen of the strata: no policy that this list names an asset of becomes a stratum in any part. The list itself is not copied here; a run reads the extract again from a clone of the repository at the commit and refuses one whose SHA-256 differs.',
      source: { repository: ETERNL_GUARD.repository, folder: ETERNL_GUARD.folder, commit, commit_time: commitTime },
      extract: {
        form: 'the distinct valid CIP-14 fingerprints of the related_assets arrays of the .json files directly in the folder, trimmed, in lowercase, sorted in ascending byte order, each followed by one LF, as ASCII',
        sha256: ex.sha256,
        n_fingerprints: ex.counts.fingerprints,
        n_entry_files: ex.counts.entry_files,
        n_mentions: ex.counts.mentions,
        n_invalid: ex.counts.invalid
      },
      license: { present: lic.length > 0, files: lic },
      captured_at: now().toISOString(),
      tool: tool ? `research-corpus capture-scam-list at ${tool}` : 'research-corpus capture-scam-list'
    },
    extract: ex
  };
}

export function readScamRecord(path) {
  const r = JSON.parse(readFileSync(path, 'utf8'));
  if (r.format !== SCAM_LIST_FORMAT) throw new Error(`${path}: expected format ${SCAM_LIST_FORMAT}`);
  if (!r.source || !/^[0-9a-f]{40}$/.test(r.source.commit || '') || r.source.repository !== ETERNL_GUARD.repository || r.source.folder !== ETERNL_GUARD.folder) throw new Error(`${path}: the source must name ${ETERNL_GUARD.repository}, ${ETERNL_GUARD.folder} and a 40-hex commit`);
  if (!r.extract || !/^[0-9a-f]{64}$/.test(r.extract.sha256 || '')) throw new Error(`${path}: the extract needs its SHA-256`);
  return r;
}

// The list a run screens with: the record, and the fingerprints read again
// from the clone at the record's commit, whose extract must have the
// record's SHA-256.
export function loadScamList(recordPath, clone) {
  const record = readScamRecord(recordPath);
  let commit;
  try {
    commit = resolveCommit(clone, record.source.commit);
  } catch {
    throw refuse(`refusing: the scam list's commit ${record.source.commit} is not in the clone ${clone}`);
  }
  if (commit !== record.source.commit) throw refuse(`refusing: the clone resolves ${record.source.commit} to ${commit}`);
  const ex = extractFromFiles(entryFiles(clone, commit));
  if (ex.sha256 !== record.extract.sha256) throw refuse(`refusing: the scam list's extract at ${commit} has SHA-256 ${ex.sha256}, and the record says ${record.extract.sha256}`);
  return { record, fingerprints: ex.fingerprints, sha256: ex.sha256 };
}

// Whether `older` is an ancestor of `newer` in the clone (true or false), or
// null when either commit is missing.
export function descendsFrom(clone, newer, older) {
  try {
    execFileSync('git', ['-C', clone, 'merge-base', '--is-ancestor', older, newer], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return e.status === 1 ? false : null;
  }
}

// The resolved assets ({ fingerprint, policy, name } in hex) whose CIP-14
// fingerprint, computed here from policy and name, is not the one db-sync
// stored for them.
export function fingerprintMismatches(rows) {
  return rows.filter((r) => cip14(r.policy + r.name) !== r.fingerprint);
}
