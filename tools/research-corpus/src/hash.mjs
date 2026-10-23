// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The files whose SHA-256 joins the freeze record's hashed items, typed
// Software: the extraction and sampling code (src/, sql/), its data (data/),
// and package.json with the lockfile. The code draws the sample after the
// freeze, so it is fixed on chain before any study query runs. Each file is
// hashed byte for byte as it is stored: UTF-8, LF line endings, no byte-order
// mark (pre-registration section 10.2); a file that is not is refused. The
// Node version is printed with the lockfile.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const HASHED_DIRS = ['src', 'sql', 'data'];
const HASHED_FILES = ['package.json', 'package-lock.json'];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export function hashedFiles() {
  const files = [];
  for (const d of HASHED_DIRS) files.push(...walk(join(TOOL_DIR, d)));
  for (const f of HASHED_FILES) files.push(join(TOOL_DIR, f));
  return files.map((p) => relative(TOOL_DIR, p)).sort();
}

export function checkText(path, buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) throw new Error(`${path}: byte-order mark`);
  if (buf.includes(0x0d)) throw new Error(`${path}: CR in line endings`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  if (!text.endsWith('\n')) throw new Error(`${path}: no final newline`);
}

export function hashList() {
  return hashedFiles().map((rel) => {
    const buf = readFileSync(join(TOOL_DIR, rel));
    checkText(rel, buf);
    return { path: rel, sha256: createHash('sha256').update(buf).digest('hex') };
  });
}

export function lockedPackages() {
  const lock = JSON.parse(readFileSync(join(TOOL_DIR, 'package-lock.json'), 'utf8'));
  return Object.entries(lock.packages)
    .filter(([k]) => k)
    .map(([k, v]) => ({ name: k.replace(/^.*node_modules\//, ''), version: v.version, integrity: v.integrity, dev: !!v.dev }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: TOOL_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function codeVersion() {
  const pkg = JSON.parse(readFileSync(join(TOOL_DIR, 'package.json'), 'utf8'));
  // Dirty means a change to a hashed path; files outside them (a draft PR
  // body, the README) do not change what runs.
  const status = git(['status', '--porcelain', '--', ...HASHED_DIRS, ...HASHED_FILES]);
  return {
    git_commit: git(['rev-parse', 'HEAD']),
    git_dirty: status === null ? null : status.length > 0,
    node: process.version,
    engines: pkg.engines,
    files: hashList()
  };
}

export function formatHashList() {
  const lines = [];
  lines.push('SHA-256'.padEnd(66) + 'file');
  for (const f of hashList()) lines.push(`${f.sha256}  ${f.path}`);
  lines.push('');
  lines.push('dependencies, pinned by version and npm integrity:');
  for (const p of lockedPackages()) lines.push(`${p.name} ${p.version}${p.dev ? ' (development only)' : ''}\n  ${p.integrity}`);
  const pkg = JSON.parse(readFileSync(join(TOOL_DIR, 'package.json'), 'utf8'));
  lines.push('');
  lines.push(`node: engines ${pkg.engines.node}; this run ${process.version}`);
  return lines.join('\n') + '\n';
}
