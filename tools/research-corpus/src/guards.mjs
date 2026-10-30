// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Guards on what a run may be told, kept pure so the unit tests can call them
// with any network name.
//
// On mainnet the frozen apparatus is the hashed files, so nothing given at run
// time may change the sample: --set is refused unless every value equals its
// hashed default, --strata unless the file's bytes are the hashed strata file,
// --scam-list unless they are the hashed scam-list record (and the clone it
// is read from must be given),
// --snapshot of a live-fire run unless it is the tip (a run on the final
// freeze takes its snapshot by rule), and the Node major must be the pinned
// one.
// A study run also compares the code's own file hashes with the code manifest
// given at run time (the `npm run hash` output frozen with the final freeze),
// path by path, and refuses on any difference.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { applyOverrides, defaultSettings, STUDY_KEY } from './params.mjs';
import { decode as bech32decode } from './bech32.mjs';
import { refuse } from './checklog.mjs';

export const NODE_MAJOR = 24;

// The study key a command reads the freeze records with: on mainnet the
// pinned STUDY_KEY, against which any other --study-key is refused; on a test
// network the flag as given (null when absent). `pinned` stands in for
// STUDY_KEY in the unit tests, which cannot sign with it; no command passes it.
export function studyKeyFor(network, given, pinned = STUDY_KEY) {
  const key = given === undefined || given === null || given === '' ? null : String(given).toLowerCase();
  if (network !== 'mainnet') return key;
  if (key !== null && key !== pinned) throw refuse(`refusing: on mainnet the study key is the pinned freeze identity's (STUDY_KEY in src/params.mjs), and --study-key names another key`);
  return pinned;
}

export function mainnetOptionErrors({ set = [], strataPath, defaultStrataPath, scamPath = null, defaultScamPath = null, scamClone = null, snapshot, live = false, nodeVersion = process.version }) {
  const errors = [];
  if (set.length) {
    const d = defaultSettings();
    const s = applyOverrides(d, set);
    const changed = Object.keys(d).filter((k) => s[k] !== d[k]);
    if (changed.length) errors.push(`--set changes ${changed.join(', ')}; on mainnet every setting is the hashed default`);
  }
  if (strataPath && defaultStrataPath) {
    const h = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
    if (h(strataPath) !== h(defaultStrataPath)) errors.push('--strata is not the hashed strata file');
  }
  if (scamPath && defaultScamPath) {
    const h = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
    if (h(scamPath) !== h(defaultScamPath)) errors.push('--scam-list is not the hashed scam-list record');
  }
  if (!scamClone) errors.push('--scam-clone: a mainnet run screens the strata with the scam list, read again from a clone of its repository');
  if (live && snapshot && snapshot !== 'tip') errors.push('--snapshot must be tip for a live-fire run on mainnet');
  if (!live && snapshot && snapshot !== 'rule') errors.push('--snapshot: the study run\'s snapshot is fixed by rule (the last block of epoch N - 1 before its randomness stabilization cutoff)');
  const major = Number(/^v(\d+)\./.exec(nodeVersion)?.[1]);
  if (major !== NODE_MAJOR) errors.push(`Node ${nodeVersion}; the code is pinned to Node ${NODE_MAJOR}`);
  return errors;
}

// `npm run hash` output: lines of <64 hex><two spaces><path>.
export function parseCodeManifest(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (m) {
      if (out.has(m[2])) throw new Error(`code manifest lists ${m[2]} twice`);
      out.set(m[2], m[1]);
    }
  }
  if (!out.size) throw new Error('code manifest lists no files');
  return out;
}

// Differences between the code manifest and the files as they are now.
export function codeManifestErrors(manifestText, files) {
  const want = parseCodeManifest(manifestText);
  const have = new Map(files.map((f) => [f.path, f.sha256]));
  const errors = [];
  for (const [p, d] of want) {
    if (!have.has(p)) errors.push(`missing: ${p}`);
    else if (have.get(p) !== d) errors.push(`differs: ${p}`);
  }
  for (const p of have.keys()) if (!want.has(p)) errors.push(`not in the manifest: ${p}`);
  return errors;
}

// A file of bech32 stake addresses, one per line, '#' starting a comment.
export function readStakeList(path, what) {
  const views = readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);
  return checkStakeAddresses(views, what);
}

export function checkStakeAddresses(views, what) {
  for (const v of views) {
    let ok = false;
    try {
      const { hrp, bytes } = bech32decode(v);
      ok = (hrp === 'stake' || hrp === 'stake_test') && bytes.length === 29;
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`${what} must hold bech32 stake addresses, one per line`);
  }
  return [...new Set(views)];
}
