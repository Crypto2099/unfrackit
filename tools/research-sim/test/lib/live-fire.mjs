// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The extraction tool's side of a live-fire run, for the tests: its entries in
// the check log under RESEARCH_CORPUS_HOME (a gate query, a live-fire start,
// an end entry that kept the simulator's pick) and the pick's
// sim/wallets.json, written as that tool writes them (tools/research-corpus,
// src/pipeline.mjs runPipeline). `append` writes an entry: this tool's
// appendEntry by default, or the extraction tool's own. Synthetic stake
// addresses (no checksum, no real wallet) and values only.

import { dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { appendEntry, pickPath, checkLogPath, SIM_KEPT } from '../../src/study/checklog.mjs';

export const TEST_H = '5e'.repeat(32);
export const SNAP = Object.freeze({ block_no: 4000, hash: 'a1'.repeat(32) });
const CHARS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
export const stakeAddress = (network, k) => `${network === 'mainnet' ? 'stake1' : 'stake_test1'}u${'q'.repeat(48)}${CHARS[k % 32]}${CHARS[(k * 7 + 3) % 32]}ll`;

export function pickWallets(network, n = 3) {
  return Array.from({ length: n }, (_x, k) => ({ stake_address: stakeAddress(network, k + 1), conditions: [k + 1], frames: k + 1 >= 8 ? ['peak'] : ['recent'] }));
}

// The extraction run's entries and pick. over: start (false: no live-fire
// start), kept (false: an end entry without the pick), file (false: no
// wallets.json), cleanup (true: a successful cleanup after the end), wallets,
// fileNetwork, testH, date (the entries' date), append.
export function seedPick(network, runId, over = {}) {
  const append = over.append || ((net, type, fields, now) => appendEntry(net, type, fields, now));
  const date = over.date ? new Date(over.date) : new Date();
  const wallets = over.wallets || pickWallets(network);
  const gate = append(network, 'query-start', { name: 'live-fire gate', run_id: runId, command: 'run --live-fire', code: { git_commit: null, git_dirty: null, node: process.version } }, date);
  append(network, 'query', { name: 'live-fire gate', start_seq: gate.seq, outcome: 'succeeded', error: null, run_ms: 5 }, date);
  let start = null;
  if (over.start !== false) start = append(network, 'live-fire-start', { run_id: runId, gate_seq: gate.seq, command: 'run --live-fire', purpose: 'pick the simulator wallets', test_h: over.testH || TEST_H, code: {} }, date);
  const end = append(network, 'live-fire', { run_id: runId, start_seq: start ? start.seq : null, command: 'run --live-fire', purpose: 'pick the simulator wallets', test_h: over.testH || TEST_H, code: {}, outcome: 'succeeded', error: null, run_ms: 10, steps: [], checks: {}, parse: {}, explain: false, wallet_level_output: `deleted ${date.toISOString()}`, study_tables_dropped: true, sim_wallets: over.kept === false ? 'none written' : SIM_KEPT }, date);
  if (over.file !== false) {
    const p = pickPath(network, runId);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, JSON.stringify({ run_id: runId, network: over.fileNetwork || network, test_h: TEST_H, snapshot: over.snapshot === undefined ? SNAP : over.snapshot, selected_at: date.toISOString(), wallets }, null, 2) + '\n', { mode: 0o600 });
  }
  if (over.cleanup) append(network, 'cleanup', { run_id: runId, start_seq: null, command: 'cleanup', outcome: 'succeeded', error: null, wallet_level_output: `deleted ${date.toISOString()}`, tables_dropped: 0 }, date);
  return { wallets, end };
}

export const logText = (network) => (existsSync(checkLogPath(network)) ? readFileSync(checkLogPath(network), 'utf8') : '');
export const logEntries = (network) => logText(network).split('\n').filter(Boolean).map((l) => JSON.parse(l));
