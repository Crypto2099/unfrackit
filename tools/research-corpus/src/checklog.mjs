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
//
// A live-fire run writes a start entry before its first database query and an
// end entry naming the start's sequence number; an interrupted run leaves the
// start unclosed, which `verifyLog` reports, as it reports kept or undeleted
// wallet-level output.

import { readFileSync, existsSync, appendFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homeDir, ensureDir } from './paths.mjs';

export function checkLogPath(network) {
  if (!/^[a-z]+$/.test(network)) throw new Error(`bad network name ${network}`);
  return join(homeDir(), 'check-log', `${network}.jsonl`);
}

// A refusal the code itself raises: its fixed text carries no count, so only
// addresses and hashes are redacted from it.
export class Refusal extends Error {}
export const refuse = (message) => new Refusal(message);

// Error text with every bech32 string (an address, a stake address) and every
// hex run of 20 or more characters (a hash, a key, a credential) replaced, and,
// unless the error is one of the code's own refusals, every number and every
// other word with a digit in it, except snake_case names (settings, tables,
// columns), so neither wallet-level data nor a count inside a database or
// provider message can reach the log.
const NUMBER = /(?<![\w.])\d[\d,._]*[a-zA-Z]*(?![\w])/g;
const WORD_WITH_DIGIT = /(?<![\w])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]+(?![\w])/g;
export function sanitize(message, { refusal = false } = {}) {
  let t = String(message)
    .replace(/\b[a-z][a-z0-9_]*1[02-9ac-hj-np-z]{20,}\b/gi, '<bech32>')
    .replace(/(?:\\x|0x|_)?[0-9a-fA-F]{20,}/g, '<hex>')
    .replace(/(?:\\x|\b0x)[0-9a-fA-F]+\b/g, '<hex>');
  // Numbers, with or without a unit or word joined to them (3,400, 0.05, 37k,
  // 1500ms, 37rows); then any word that still holds a digit (row37, 1e5,
  // 12h30m, abc0x1f4) unless it joins an underscore. The placeholders above
  // are left as they are.
  if (!refusal) t = t.split(/(<bech32>|<hex>)/).map((part, i) => (i % 2 ? part : part.replace(NUMBER, '#').replace(WORD_WITH_DIGIT, '#'))).join('');
  return t.slice(0, 500);
}

// The command line as logged: the values of options that name wallets are
// replaced, so the log never carries an address.
const WALLET_OPTIONS = new Set(['--stake', '--node-stake', '--case']);
export function redactCommand(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    out.push(argv[i]);
    if (WALLET_OPTIONS.has(argv[i]) && i + 1 < argv.length) {
      out.push('<address>');
      i++;
    }
  }
  return out.join(' ');
}

export const sanitizeError = (e) => sanitize(e && e.message !== undefined ? e.message : e, { refusal: e instanceof Refusal });

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
  const starts = new Map();
  const failedDeletions = [];
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  for (const e of entries) {
    if (e.type === 'live-fire-start' || e.type === 'a1-live-fire-start' || e.type === 'query-start') starts.set(e.seq, e);
    if (e.start_seq !== undefined && e.start_seq !== null) starts.delete(e.start_seq);
    // A query of a run (a run's gate, a study run) that finishes cleanly
    // settles the same run's earlier starts of that query, left by a killed
    // attempt.
    if (e.type === 'query' && e.outcome === 'succeeded' && bySeq.has(e.start_seq)) {
      const st0 = bySeq.get(e.start_seq);
      if (st0.run_id) for (const [seq, st] of starts) if (st.type === 'query-start' && st.run_id === st0.run_id && st.name === st0.name) starts.delete(seq);
    }
    // A later end entry that deleted the run's output (a run resumed to a
    // clean finish) settles its earlier unclosed starts, its gates' included,
    // kept output and failed deletions.
    if ((e.type === 'live-fire' || e.type === 'a1-live-fire') && typeof e.wallet_level_output === 'string' && e.wallet_level_output.startsWith('deleted ')) {
      for (const [seq, st] of starts) if (st.run_id === e.run_id) starts.delete(seq);
      open.delete(e.run_id);
      for (let i = failedDeletions.length - 1; i >= 0; i--) if (failedDeletions[i].run_id === e.run_id) failedDeletions.splice(i, 1);
    }
    if ((e.type === 'live-fire' || e.type === 'a1-live-fire') && e.wallet_level_output === 'kept for debugging') open.set(e.run_id, e.seq);
    if ((e.type === 'live-fire' || e.type === 'a1-live-fire' || e.type === 'cleanup') && typeof e.wallet_level_output === 'string' && !/^(deleted |kept for debugging$|none written$)/.test(e.wallet_level_output)) {
      failedDeletions.push({ run_id: e.run_id, seq: e.seq, wallet_level_output: e.wallet_level_output });
    }
    // A run's cleanup settles the run. A start-closed entry (cleanup
    // --start-seq) is no cleanup: it closed its one start through start_seq
    // above.
    if (e.type === 'cleanup' && e.outcome === 'succeeded') {
      open.delete(e.run_id);
      for (const [seq, st] of starts) if (st.run_id === e.run_id) starts.delete(seq);
      for (let i = failedDeletions.length - 1; i >= 0; i--) if (failedDeletions[i].run_id === e.run_id) failedDeletions.splice(i, 1);
    }
  }
  const unclosed = [...starts.values()].map((e) => ({ seq: e.seq, type: e.type, run_id: e.run_id || null, date: e.date }));
  return { path, entries: entries.length, errors, unclosed, kept_not_cleaned: [...open.entries()].map(([run_id, seq]) => ({ run_id, seq })), failed_deletions: failedDeletions, sha256: createHash('sha256').update(text).digest('hex') };
}

// Closes a start entry left by a command that never wrote its end entry (a
// query with no run to clean up, or whose run id a later clean finish will
// never settle) by its sequence number: appends a start-closed entry naming
// it. That entry closes that one start and nothing else: it is not a cleanup,
// so it settles none of the run's other starts, kept output or failed
// deletions, and it says nothing about what the command wrote. Only an
// unclosed query-start is closed this way; a live-fire run is cleaned up by
// its run id.
export function closeStart(network, seq, command = null) {
  const v = verifyLog(network);
  const st = v.unclosed.find((x) => x.seq === Number(seq));
  if (!st) throw refuse(`refusing: entry ${seq} is not an unclosed start in the ${network} check log`);
  if (st.type !== 'query-start') throw refuse(`refusing: entry ${seq} is a ${st.type}; clean up a live-fire run with cleanup --run-id`);
  return appendEntry(network, 'start-closed', { start_seq: st.seq, run_id: st.run_id, command, closed: 'no end entry' });
}

// Runs fn as a logged query when the network is mainnet: a start entry
// before fn, an end entry after it naming the start, with the outcome and run
// time only. Before the final freeze every query of the study's code against
// mainnet is logged; after it, logging changes nothing the freeze recorded,
// since the frozen log is a prefix of the log.
export async function loggedQuery(network, name, fields, fn, now = () => Date.now()) {
  if (network !== 'mainnet') return fn();
  const start = appendEntry(network, 'query-start', { name, ...fields });
  const t0 = now();
  let error = null;
  try {
    return await fn();
  } catch (e) {
    error = e;
    throw e;
  } finally {
    appendEntry(network, 'query', { name, start_seq: start.seq, outcome: error ? 'failed' : 'succeeded', error: error ? sanitizeError(error) : null, run_ms: now() - t0 });
  }
}
