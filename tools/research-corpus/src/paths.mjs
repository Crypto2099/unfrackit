// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Where outputs live. Data never enters the repository:
// ${XDG_DATA_HOME:-$HOME/.local/share}/unfrackit-research/ holds
//   secret/hmac.key            32 random bytes, made once by init-secret
//   runs/<network>/<run-id>/   parameters, flow tables, sample lists, checks, manifest
// Directories are created 0700 and files 0600. RESEARCH_CORPUS_HOME overrides
// the root (tests use a temporary one).

import { mkdirSync, writeFileSync, chmodSync, existsSync, statSync, openSync, closeSync, writeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export function homeDir() {
  if (process.env.RESEARCH_CORPUS_HOME) return process.env.RESEARCH_CORPUS_HOME;
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'unfrackit-research');
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export const secretDir = () => join(homeDir(), 'secret');
export const hmacKeyPath = () => join(secretDir(), 'hmac.key');

export function runDir(network, runId) {
  if (!/^[a-z]+$/.test(network)) throw new Error(`bad network name ${network}`);
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`bad run id ${runId}`);
  return join(homeDir(), 'runs', network, runId);
}

// Writes a file with mode 0600, creating its directory 0700. Text is written
// as UTF-8 with LF line endings as given.
export function writePrivate(path, data) {
  ensureDir(dirname(path));
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function writeJson(path, value) {
  return writePrivate(path, JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
}

// Creates a file that must not exist yet (the HMAC key), mode 0600.
export function createExclusive(path, bytes) {
  ensureDir(dirname(path));
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

export function assertPrivate(path) {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} is readable by others (mode ${mode.toString(8)}); expected 0600`);
}
