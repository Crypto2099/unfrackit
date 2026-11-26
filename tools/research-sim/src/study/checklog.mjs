// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The check log the extraction tool keeps (tools/research-corpus,
// src/checklog.mjs), written here in its format, and the extraction run's pick
// of the simulator's live-fire wallets, read from beside it. Nothing is
// imported from the extraction tool: the format is written out below, and the
// tests run that tool's own reader (verifyLog) and final-freeze check over a
// log this code wrote.
//
// Where: the extraction tool's root, RESEARCH_CORPUS_HOME or
// ${XDG_DATA_HOME:-$HOME/.local/share}/unfrackit-research/, which is the
// parent of this tool's default root. The log of a network is
// check-log/<network>.jsonl under it; an extraction run's pick is
// runs/<network>/<run id>/sim/wallets.json.
//
// Format: one JSON object per line, UTF-8, LF, a final newline, appended and
// never rewritten. Each entry begins with its sequence number (`seq`, from 1),
// `prev` (the SHA-256 of the whole file before it was appended), `date` (ISO
// time) and `type`, followed by its fields in a fixed order.
//
// The entries this code writes: a live-fire run's gate as a query
// (`query-start` and `query`, named SIM_GATE), its start (`sim-live-fire-start`)
// once the gate has passed, its end (`sim-live-fire`) naming the start, and a
// `cleanup` entry when output kept from a run is deleted later. Simulator run
// IDs begin with `sim-`, so no entry of one tool settles a run of the other.
//
// Error text in an entry passes through `sanitize`, the extraction tool's
// redaction: bech32 strings and hex runs of 20 or more characters are
// replaced, and so is every number and every word holding a digit. This code
// applies it in full to every error, its own refusals included, since a
// refusal of this code can name a wallet by its stake-credential id.

import { readFileSync, existsSync, appendFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ensureDir } from '../history/paths.mjs';
import { Refusal } from '../history/db.mjs';

export const SIM_LIVE_FIRE_START = 'sim-live-fire-start';
export const SIM_LIVE_FIRE = 'sim-live-fire';
export const SIM_GATE = 'sim live-fire gate';
export const SIM_RUN_PREFIX = 'sim-';
// The extraction's end entry of a live-fire run that picked and kept the
// simulator's wallets (its sim_wallets field).
export const SIM_KEPT = 'kept for the simulator checks';
export const KEPT = 'kept for debugging';
// The start and end types of either tool's live-fire runs, as the
// extraction's reader counts them.
const STARTS = new Set(['live-fire-start', 'source-check-live-fire-start', SIM_LIVE_FIRE_START]);
const ENDS = new Set(['live-fire', 'source-check-live-fire', SIM_LIVE_FIRE]);

const HEX64 = /^[0-9a-f]{64}$/;
const RUN_ID = /^[A-Za-z0-9._-]+$/;
const sha256 = (x) => createHash('sha256').update(x).digest('hex');
export const isSimRunId = (id) => typeof id === 'string' && id.startsWith(SIM_RUN_PREFIX);

export function corpusHome() {
  if (process.env.RESEARCH_CORPUS_HOME) return process.env.RESEARCH_CORPUS_HOME;
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'unfrackit-research');
}

const networkName = (network) => {
  if (!/^[a-z]+$/.test(network)) throw new Error(`bad network name ${network}`);
  return network;
};
export const checkLogPath = (network) => join(corpusHome(), 'check-log', `${networkName(network)}.jsonl`);
export const pickPath = (network, runId) => join(corpusHome(), 'runs', networkName(network), runId, 'sim', 'wallets.json');

// The log's text and entries. A line that does not parse is refused: the log
// is never appended to past it.
export function readLog(network) {
  const path = checkLogPath(network);
  if (!existsSync(path)) return { path, text: '', entries: [] };
  const text = readFileSync(path, 'utf8');
  const entries = text.split('\n').filter(Boolean).map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new Refusal(`refusing: line ${i + 1} of the ${network} check log is not JSON`);
    }
  });
  return { path, text, entries };
}

// The sequence and the chain of prev digests, as the extraction's reader
// checks them.
export function chainErrors({ text, entries }) {
  const errors = [];
  const lines = text.split('\n').filter(Boolean);
  let before = '';
  entries.forEach((e, i) => {
    if (e.seq !== i + 1) errors.push(`line ${i + 1}: seq ${e.seq}`);
    if (e.prev !== sha256(before)) errors.push(`line ${i + 1}: prev does not match the file before it`);
    before += lines[i] + '\n';
  });
  if (text && !text.endsWith('\n')) errors.push('no final newline');
  return errors;
}

// Appends one entry: seq, prev, date and type, then `fields` in the order
// given.
export function appendEntry(network, type, fields, now = new Date()) {
  const path = checkLogPath(network);
  ensureDir(join(corpusHome(), 'check-log'));
  const { text, entries } = readLog(network);
  const entry = { seq: entries.length + 1, prev: sha256(text), date: now.toISOString(), type, ...fields };
  appendFileSync(path, JSON.stringify(entry) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return entry;
}

// The extraction's redaction (tools/research-corpus, src/checklog.mjs,
// sanitize), with this code's own names in CODE_NAMES: names with an
// underscore-separated part that begins with a digit, kept whole. This code
// has none; a unit test keeps it so.
const NUMBER = /(?<![\w.])\d[\d,._]*[a-zA-Z]*(?![\w])/g;
const WORD_WITH_DIGIT = /(?<![\w])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]+(?![\w])/g;
const JOINED = /(?<![\w])\w*_\w*(?![\w])/g;
export const CODE_NAMES = new Set();
const joined = (w) => (CODE_NAMES.has(w) ? w : w.split('_').map((p) => (/^\d/.test(p) ? '#' : p)).join('_'));
export function sanitize(message, { refusal = false } = {}) {
  let t = String(message)
    .replace(/\b[a-z][a-z0-9_]*1[02-9ac-hj-np-z]{20,}\b/gi, '<bech32>')
    .replace(/(?:\\x|0x|_)?[0-9a-fA-F]{20,}/g, '<hex>')
    .replace(/(?:\\x|\b0x)[0-9a-fA-F]+\b/g, '<hex>');
  if (!refusal) t = t.split(/(<bech32>|<hex>)/).map((part, i) => (i % 2 ? part : part.replace(NUMBER, '#').replace(WORD_WITH_DIGIT, '#').replace(JOINED, joined))).join('');
  return t.slice(0, 500);
}
export const sanitizeError = (e) => sanitize(e && e.message !== undefined ? e.message : e);

// The command line as logged, with the values of options that name wallets
// replaced.
const WALLET_OPTIONS = new Set(['--wallet', '--wallets']);
export function redactCommand(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    out.push(argv[i]);
    if (WALLET_OPTIONS.has(argv[i]) && i + 1 < argv.length) {
      out.push('<wallet>');
      i++;
    }
  }
  return out.join(' ');
}

// Start entries no later entry has closed or settled, by the extraction
// reader's rules: an entry naming the start (start_seq); a successful query of
// the same run and name; a live-fire end whose output was deleted, or a
// successful cleanup, which settle every start of its run.
export function unclosedStarts(entries) {
  const starts = new Map();
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  for (const e of entries) {
    if (STARTS.has(e.type) || e.type === 'query-start') starts.set(e.seq, e);
    if (e.start_seq !== undefined && e.start_seq !== null) starts.delete(e.start_seq);
    if (e.type === 'query' && e.outcome === 'succeeded' && bySeq.has(e.start_seq)) {
      const st0 = bySeq.get(e.start_seq);
      if (st0.run_id) for (const [seq, st] of starts) if (st.type === 'query-start' && st.run_id === st0.run_id && st.name === st0.name) starts.delete(seq);
    }
    const settles = (ENDS.has(e.type) && typeof e.wallet_level_output === 'string' && e.wallet_level_output.startsWith('deleted ')) || (e.type === 'cleanup' && e.outcome === 'succeeded');
    if (settles) for (const [seq, st] of starts) if (st.run_id === e.run_id) starts.delete(seq);
  }
  return [...starts.values()];
}

// Whether a run's output is kept: its last end entry kept it, and no
// successful cleanup or later deletion has settled it since.
export function keptRun(entries, runId) {
  let kept = false;
  for (const e of entries) {
    if (e.run_id !== runId) continue;
    if (ENDS.has(e.type) && e.wallet_level_output === KEPT) kept = true;
    if (ENDS.has(e.type) && typeof e.wallet_level_output === 'string' && e.wallet_level_output.startsWith('deleted ')) kept = false;
    if (e.type === 'cleanup' && e.outcome === 'succeeded') kept = false;
  }
  return kept;
}

const STAKE = { mainnet: /^stake1[02-9ac-hj-np-z]{50,}$/, test: /^stake_test1[02-9ac-hj-np-z]{50,}$/ };
const isInt = (x) => Number.isSafeInteger(x) && x >= 0;

// The extraction run's pick of the simulator's live-fire wallets, checked
// before anything queries a database. It must be a live-fire run of the
// extraction (its start entry in this network's log), whose end entry kept
// the pick, with no successful cleanup since, and with sim/wallets.json in
// its run directory naming that run, this network, the test h its start
// entry records, the snapshot block, and one to ten wallets. The log's chain
// must hold, since a run appends to it. Returns { runId, network, testH,
// snapshot: { block_no, hash }, wallets: [{ stake_address, conditions,
// frames }], sha256 } or throws a Refusal.
export function readPick(network, runId) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId) || isSimRunId(runId)) throw new Refusal('refusing: --extraction-run names the extraction tool\'s live-fire run by its run ID');
  const no = (why) => new Refusal(`refusing: extraction run ${runId} holds no kept pick of the simulator's live-fire wallets on ${network}: ${why}`);
  const log = readLog(network);
  const errs = chainErrors(log);
  if (errs.length) throw new Refusal(`refusing: the ${network} check log does not verify (${errs[0]})`);
  const start = log.entries.find((e) => e.type === 'live-fire-start' && e.run_id === runId);
  if (!start) throw no('the check log has no live-fire start entry for it');
  const end = log.entries.find((e) => e.type === 'live-fire' && e.run_id === runId && e.sim_wallets === SIM_KEPT);
  if (!end) throw no('the check log has no end entry of it that kept the pick');
  if (log.entries.some((e) => e.type === 'cleanup' && e.run_id === runId && e.outcome === 'succeeded' && e.seq > end.seq)) throw no('a cleanup has deleted it');
  const path = pickPath(network, runId);
  if (!existsSync(path)) throw no('its run directory has no sim/wallets.json');
  const buf = readFileSync(path);
  let p;
  try {
    p = JSON.parse(buf.toString('utf8'));
  } catch {
    throw no('sim/wallets.json does not parse');
  }
  if (!p || p.run_id !== runId) throw no('sim/wallets.json names another run');
  if (p.network !== network) throw no(`sim/wallets.json is for ${p.network}`);
  if (!HEX64.test(String(p.test_h)) || p.test_h !== end.test_h || p.test_h !== start.test_h) throw no('sim/wallets.json does not carry the test h the run\'s entries record');
  const s = p.snapshot;
  if (!s || !isInt(s.block_no) || !HEX64.test(String(s.hash))) throw no('sim/wallets.json names no snapshot block');
  const stake = network === 'mainnet' ? STAKE.mainnet : STAKE.test;
  const ws = p.wallets;
  if (!Array.isArray(ws) || ws.length < 1 || ws.length > 10) throw no('sim/wallets.json does not list one to ten wallets');
  const seen = new Set();
  for (const w of ws) {
    const ok = w && typeof w.stake_address === 'string' && stake.test(w.stake_address) && Array.isArray(w.conditions) && w.conditions.length > 0 && w.conditions.every(isInt) && Array.isArray(w.frames) && w.frames.length > 0 && w.frames.every((f) => f === 'recent' || f === 'peak');
    if (!ok || seen.has(w.stake_address)) throw no('a wallet in sim/wallets.json is not a stake address with its conditions and frames');
    seen.add(w.stake_address);
  }
  return {
    runId,
    network,
    testH: p.test_h,
    snapshot: { block_no: s.block_no, hash: s.hash },
    wallets: ws.map((w) => ({ stake_address: w.stake_address, conditions: [...w.conditions], frames: [...w.frames] })),
    sha256: sha256(buf)
  };
}
