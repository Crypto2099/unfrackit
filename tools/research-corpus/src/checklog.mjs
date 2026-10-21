// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The check log of the pre-freeze live-fire runs (decided 2026-10-21): every
// run of this code against mainnet before the final freeze is logged with its
// date, command, purpose and outcome in functional terms only (succeeded or
// failed with which error, run time, fields parsed), never a row count, a
// population statistic or wallet-level data. Each fix names its finding and
// commit. The log is one of the files hashed at the final freeze.
//
// Format: one JSON object per line (JSON Lines), UTF-8, LF, a final newline,
// keys in a fixed order, appended and never rewritten. Each entry carries its
// sequence number and the SHA-256 of the whole file before it was appended,
// so an edit to an earlier line breaks every later `prev`. One file per
// network: ${home}/check-log/<network>.jsonl.

import { readFileSync, existsSync, appendFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homeDir, ensureDir } from './paths.mjs';

export function checkLogPath(network) {
  if (!/^[a-z]+$/.test(network)) throw new Error(`bad network name ${network}`);
  return join(homeDir(), 'check-log', `${network}.jsonl`);
}

// Error text with every number that is not part of an identifier replaced,
// so a count inside a database or check message cannot reach the log.
export function sanitize(message) {
  return String(message)
    .replace(/(?<![\w.])\d[\d,._]*(?![\w])/g, '#')
    .slice(0, 500);
}

function readLines(path) {
  if (!existsSync(path)) return { text: '', entries: [] };
  const text = readFileSync(path, 'utf8');
  const entries = text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { text, entries };
}

// Appends one entry. `fields` are written after seq, prev, date and type, in
// the order given.
export function appendEntry(network, type, fields, now = new Date()) {
  const path = checkLogPath(network);
  ensureDir(join(homeDir(), 'check-log'));
  const { text, entries } = readLines(path);
  const entry = { seq: entries.length + 1, prev: createHash('sha256').update(text).digest('hex'), date: now.toISOString(), type, ...fields };
  appendFileSync(path, JSON.stringify(entry) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return entry;
}

// Checks the sequence and the chain of prev digests, and lists live-fire runs
// whose wallet-level output was kept and has not been cleaned up since.
export function verifyLog(network) {
  const path = checkLogPath(network);
  const { text, entries } = readLines(path);
  const errors = [];
  let before = '';
  const lines = text.split('\n').filter(Boolean);
  entries.forEach((e, i) => {
    if (e.seq !== i + 1) errors.push(`line ${i + 1}: seq ${e.seq}`);
    if (e.prev !== createHash('sha256').update(before).digest('hex')) errors.push(`line ${i + 1}: prev does not match the file before it`);
    before += lines[i] + '\n';
  });
  if (text && !text.endsWith('\n')) errors.push('no final newline');
  const open = new Map();
  for (const e of entries) {
    if ((e.type === 'live-fire' || e.type === 'a1-live-fire') && e.wallet_level_output === 'kept for debugging') open.set(e.run_id, e.seq);
    if (e.type === 'cleanup' && e.outcome === 'succeeded') open.delete(e.run_id);
  }
  return { path, entries: entries.length, errors, kept_not_cleaned: [...open.entries()].map(([run_id, seq]) => ({ run_id, seq })), sha256: createHash('sha256').update(text).digest('hex') };
}
