// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// What the wallet build scripts share (build-lace.mjs, build-yoroi.mjs): their
// two ways of naming the source, a local clone or a fresh shallow clone of
// the pinned commit alone; the check of each pinned path's git object at the
// commit; the extraction of the pinned paths from the commit's objects, never
// from a working tree; and a file's SHA-256. Node built-ins and git only.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const git = (dir, args, opts = {}) => execFileSync('git', ['-C', dir, ...args], { encoding: opts.encoding === null ? null : 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

// The usage of a build script, named `name` (scripts/<name>.mjs), with a
// message; exits 1.
export function usage(name, msg) {
  if (msg) console.error(`${name}: ${msg}`);
  console.error(`usage: node scripts/${name}.mjs --clone <dir> | --fetch <dir>`);
  process.exit(1);
}

// --clone <dir> or --fetch <dir>: { mode, dir }.
export function parseArgs(name, argv) {
  if (argv.length !== 2) usage(name);
  const [flag, dir] = argv;
  if (flag !== '--clone' && flag !== '--fetch') usage(name, `unknown option ${flag}`);
  return { mode: flag.slice(2), dir: resolve(dir) };
}

// A shallow clone of the pinned commit alone, its blobs fetched only for the
// paths later read.
export function freshClone(name, dir, repo, commit) {
  if (existsSync(dir)) usage(name, `${dir} exists; --fetch makes a new clone`);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--quiet']);
  git(dir, ['remote', 'add', 'origin', repo]);
  git(dir, ['config', 'remote.origin.promisor', 'true']);
  git(dir, ['config', 'remote.origin.partialclonefilter', 'blob:none']);
  git(dir, ['fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', commit]);
  return dir;
}

// Throws unless the clone holds the commit.
export function requireCommit(clone, commit) {
  try {
    git(clone, ['cat-file', '-e', `${commit}^{commit}`]);
  } catch {
    throw new Error(`${clone} does not hold commit ${commit}`);
  }
}

// Checks one path's object at the commit against its pin; returns its hash.
export function checkObject(clone, commit, path, type, hash) {
  let got;
  let kind;
  try {
    got = git(clone, ['rev-parse', `${commit}:${path}`]).trim();
    kind = git(clone, ['cat-file', '-t', got]).trim();
  } catch (e) {
    throw new Error(`${path} at ${commit}: ${String(e.stderr || e.message).trim()}`);
  }
  if (kind !== type) throw new Error(`${path} at ${commit} is a ${kind}, pinned as a ${type}`);
  if (got !== hash) throw new Error(`${path} at ${commit} is ${got}, pinned as ${hash}`);
  return got;
}

// The paths at the commit, from its objects, extracted under `dest`.
export function extractPaths(clone, commit, paths, dest) {
  const tar = git(clone, ['archive', '--format=tar', commit, '--', ...paths], { encoding: null });
  const x = spawnSync('tar', ['-x', '-C', dest], { input: tar });
  if (x.status !== 0) throw new Error(`tar: ${String(x.stderr).trim()}`);
}

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
