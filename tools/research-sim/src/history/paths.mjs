// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Where the reader writes. Wallet-level data never enters the repository:
// ${XDG_DATA_HOME:-$HOME/.local/share}/unfrackit-research/sim/<network>/<run-id>/
// holds history/ (one JSON Lines file per wallet and window) and the reports
// of the census, near-cap, collateral and battery-pool commands. Directories
// are created 0700 and files 0600. RESEARCH_SIM_HOME overrides the root
// (tests use a temporary one).

import { mkdirSync, writeFileSync, chmodSync, openSync, writeSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export function homeDir() {
  if (process.env.RESEARCH_SIM_HOME) return process.env.RESEARCH_SIM_HOME;
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'unfrackit-research', 'sim');
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

// A run id names one directory, or a stage of a study run as
// <study run id>/<stage> (study/study.mjs), a directory inside the study
// run's.
export function runDir(network, runId) {
  if (!/^[a-z]+$/.test(network)) throw new Error(`bad network name ${network}`);
  const parts = String(runId).split('/');
  if (parts.length > 2 || parts.some((p) => !/^[A-Za-z0-9._-]+$/.test(p) || p === '.' || p === '..')) throw new Error(`bad run id ${runId}`);
  return join(homeDir(), network, ...parts);
}

export const historyDir = (network, runId) => join(runDir(network, runId), 'history');

// JSON with BigInt written as decimal strings.
export const toJson = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

export function writePrivate(path, data) {
  ensureDir(dirname(path));
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export const writeJson = (path, value) => writePrivate(path, JSON.stringify(value, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2) + '\n');

// A JSON Lines file written line by line, mode 0600.
export class JsonLines {
  constructor(path) {
    ensureDir(dirname(path));
    this.path = path;
    this.fd = openSync(path, 'w', 0o600);
    chmodSync(path, 0o600);
  }
  write(obj) {
    writeSync(this.fd, toJson(obj) + '\n');
  }
  close() {
    closeSync(this.fd);
  }
}
