// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Guards on what a run may be told, kept pure so the unit tests can call them
// with any network name.
//
// On mainnet the frozen apparatus is the hashed files, so nothing given at run
// time may change the sample: --set is refused unless every value equals its
// hashed default, --strata unless the file's bytes are the hashed strata file,
// --snapshot unless it is the tip, and the Node major must be the pinned one.
// A study run also compares the code's own file hashes with the code manifest
// given at run time (the `npm run hash` output frozen with the final freeze),
// path by path, and refuses on any difference.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { applyOverrides, defaultSettings } from './params.mjs';
import { decode as bech32decode } from './bech32.mjs';

export const NODE_MAJOR = 24;

export function mainnetOptionErrors({ set = [], strataPath, defaultStrataPath, snapshot, nodeVersion = process.version }) {
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
  if (snapshot && snapshot !== 'tip') errors.push('--snapshot must be tip on mainnet');
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

// Case wallets are the ones Adam K. Dean names, and each must be one of his
// consented keys: a wallet that is not removed from the frames could also be
// drawn, and a case study is never part of the sample.
export function caseWalletErrors(cases, consented) {
  const set = new Set(consented);
  return cases.filter((c) => !set.has(c)).map((c) => `case wallet ${c} is not in the consented file`);
}
