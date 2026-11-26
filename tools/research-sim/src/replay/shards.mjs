// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A replay stage split between machines: which wallets an invocation runs,
// and the wallet index files the plan-shards command writes
// (replay/commands.mjs cmdPlanShards).
//
// An invocation's share of the stage's wallets is every wallet (no option),
// --shard k/n (the wallets whose index modulo n is k), or --wallet-indexes
// <file> (the indexes plan-shards wrote for one machine). The share changes
// only which machine writes a wallet's segment, never a record, so it is not
// in run.json (out/stage.mjs), and every shard of a stage has the same
// compatibility key.
//
// A wallet index file, one per machine, JSON:
//   { format, machine, machines: [{ label, speed }], costFormula,
//     plans: { <plan>: { wallets, walletsSha256, indexes, cost, share,
//                        balance } } }
// `wallets` and `walletsSha256` are the wallet count and the SHA-256 of the
// stage's wallets.json the indexes were planned for; a replay refuses a file
// planned for another list. One file holds one entry per plan, so a study's
// two replay stages, whose wallet lists differ, read their own from one file.
//
// The cost estimate of a wallet, deterministic from its history file and the
// plan: (E + 1) × J × g × √g with g = 1 + U / 1000, where E is the window's
// event count (the history file's end record; a shape's synthetic stream),
// J the wallet's job count under the plan (arms/plan.mjs expandJobs), and U
// the larger of its UTxO counts at the window's start and end (a shape: at
// its start). For large U, g × √g grows as U^1.5, faster than linearly, as
// the replay time per event does: that time was measured to rise about 15
// times from 3,005 to 20,005 UTxOs, where g × √g rises about 12 times. The
// packing is greedy, longest first: wallets in falling cost (ties by index),
// each to the machine that would finish it first at its relative speed (ties
// to the machine named first).

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { shardOf, MACHINE_LABEL, MACHINE_LABEL_RULE } from '../options.mjs';
import { walletsSha256, sha256 } from '../out/stage.mjs';
import { expandJobs } from '../arms/plan.mjs';
import { HISTORY_FORMAT } from '../state/history.mjs';
import { loadSource } from './source.mjs';

export const WALLET_INDEXES_FORMAT = 'unfrackit-research-sim wallet indexes 1';
export const COST_FORMULA = '(E + 1) * J * g * sqrt(g), g = 1 + U / 1000; E events, J jobs, U the larger of the start and end UTxO counts';

// Refuses --shard and --wallet-indexes given together, and a --shard that is
// not k/n with 0 <= k < n, before anything is loaded.
export function checkSelection(opts) {
  if (opts.shard !== undefined && opts.walletIndexes !== undefined) throw new Error('refusing: give --shard or --wallet-indexes, not both');
  if (opts.shard !== undefined) shardOf(opts.shard);
  if (opts.walletIndexes !== undefined && (typeof opts.walletIndexes !== 'string' || !opts.walletIndexes)) throw new Error('--wallet-indexes <file> names the index file plan-shards wrote for this machine');
}

// The indexes a wallet index file holds for a plan, checked against the
// stage's wallets.json entries. Throws a refusal naming the file.
export function readIndexFile(path, { plan, wallets }) {
  let text;
  let f;
  try {
    text = readFileSync(path);
    f = JSON.parse(text.toString('utf8'));
  } catch (e) {
    throw new Error(`refusing: --wallet-indexes ${path} cannot be read as a wallet index file (${e.code || e.message})`);
  }
  if (!f || f.format !== WALLET_INDEXES_FORMAT || !f.plans || typeof f.plans !== 'object') throw new Error(`refusing: --wallet-indexes ${path} is not a wallet index file as plan-shards writes it`);
  const e = Object.hasOwn(f.plans, plan) ? f.plans[plan] : null;
  if (!e) throw new Error(`refusing: --wallet-indexes ${path} holds no indexes for the ${plan} plan; run plan-shards for it`);
  if (e.wallets !== wallets.length || e.walletsSha256 !== walletsSha256(wallets)) throw new Error(`refusing: --wallet-indexes ${path} was planned for another wallet list (${e.wallets} wallets against this run's ${wallets.length}, or other files); run plan-shards over this run's wallets`);
  const xs = e.indexes;
  if (!Array.isArray(xs) || !xs.every((i, k) => Number.isSafeInteger(i) && i >= 0 && i < wallets.length && (k === 0 || i > xs[k - 1]))) throw new Error(`refusing: --wallet-indexes ${path}: the ${plan} plan's indexes are not increasing wallet indexes below ${wallets.length}`);
  return { indexes: [...xs], machine: typeof f.machine === 'string' ? f.machine : null, sha256: sha256(text) };
}

// This invocation's share of the stage's wallets (wallets: wallets.json's
// entries): null for every wallet, else { indexes, record }, record being
// what the stage's machine record keeps of it.
export function selectionOf(opts, { plan, wallets }) {
  checkSelection(opts);
  if (opts.shard !== undefined) {
    const { k, n } = shardOf(opts.shard);
    const indexes = [];
    for (let i = k; i < wallets.length; i += n) indexes.push(i);
    return { indexes, record: { shard: `${k}/${n}`, wallets: indexes.length } };
  }
  if (opts.walletIndexes !== undefined) {
    const f = readIndexFile(opts.walletIndexes, { plan, wallets });
    return { indexes: f.indexes, record: { walletIndexes: basename(opts.walletIndexes), sha256: f.sha256, plannedFor: f.machine, wallets: f.indexes.length } };
  }
  return null;
}

// --machines <label>[=<speed>],...: the machines in the order given, each
// with its relative speed (1 when absent; a positive decimal).
export function machinesOf(v) {
  if (typeof v !== 'string' || !v) throw new Error('--machines <label>=<speed>,... names the machines and their relative speeds');
  const out = [];
  for (const part of v.split(',')) {
    const i = part.indexOf('=');
    const label = i === -1 ? part : part.slice(0, i);
    const speedText = i === -1 ? '1' : part.slice(i + 1);
    if (!MACHINE_LABEL.test(label)) throw new Error(`--machines: ${MACHINE_LABEL_RULE.replace('--machine takes', 'a machine is')}, not ${JSON.stringify(label)}`);
    if (out.some((m) => m.label === label)) throw new Error(`--machines names ${label} twice`);
    const speed = Number(speedText);
    if (!/^(\d+(\.\d+)?|\.\d+)$/.test(speedText) || !(speed > 0) || !Number.isFinite(speed)) throw new Error(`--machines: ${label}'s speed is a positive number, not ${JSON.stringify(speedText)}`);
    out.push({ label, speed });
  }
  return out;
}

// The cost estimate of one wallet from its event count, job count and UTxO
// count (the file's header comment).
export function walletCost({ events, jobs, utxos }) {
  const g = 1 + utxos / 1000;
  return (events + 1) * jobs * g * Math.sqrt(g);
}

// What the cost reads of a history file: its event count (the end record's
// counts summed), its UTxO counts at the start (the state record) and the
// end (the end record), and, when asked, whether an intent needs collateral
// (a script interaction, which expands the collateral rules). The events in
// between are parsed only for that question.
function historyFacts(path, { collateral }) {
  const text = readFileSync(path, 'utf8');
  const name = basename(path);
  const lines = text.split('\n');
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const parse = (l, what) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new Error(`history file ${name}: its ${what} cannot be read`);
    }
  };
  if (lines.length < 3) throw new Error(`history file ${name}: it needs a header, a start state and an end record`);
  const header = parse(lines[0], 'header');
  if (header.kind !== 'header' || header.format !== HISTORY_FORMAT) throw new Error(`history file ${name}: format ${header.format}, expected ${HISTORY_FORMAT}`);
  const state = parse(lines[1], 'start state');
  const end = parse(lines[lines.length - 1], 'end record');
  if (state.kind !== 'state' || !Array.isArray(state.utxos)) throw new Error(`history file ${name}: no start state`);
  if (end.kind !== 'end' || !end.counts) throw new Error(`history file ${name}: no end record; the file is incomplete`);
  const events = Object.values(end.counts).reduce((a, b) => a + b, 0);
  const utxos = Math.max(state.utxos.length, Number(end.utxos) || 0);
  let needsCollateral = false;
  if (collateral) {
    for (const l of lines.slice(2, -1)) {
      if (!l.includes('"intent"')) continue;
      const e = parse(l, 'event');
      if (e.kind === 'intent' && e.intent && e.intent.collateral && e.intent.collateral.required) {
        needsCollateral = true;
        break;
      }
    }
  }
  return { events, utxos, needsCollateral };
}

// One wallet's cost facts and estimate under the plan: { events, jobs,
// utxos, cost }. T: the treatment, needed for a shape only.
export function walletFacts(T, spec, { entries, roles, collateralRules }) {
  const jobsOf = (needsCollateral) => expandJobs(entries, { roles, needsCollateral, ...(collateralRules ? { collateralRules } : {}) }).length;
  // The job count depends on the script question only when the plan runs
  // under more than one collateral rule.
  const collateral = jobsOf(true) !== jobsOf(false);
  let f;
  if (spec.kind === 'history') f = historyFacts(spec.path, { collateral });
  else if (spec.kind === 'shape') {
    const s = loadSource(T, spec);
    f = { events: s.events.length, utxos: s.start.length, needsCollateral: s.events.some((e) => e.kind === 'intent' && e.intent.collateral.required) };
  } else throw new Error(`unknown wallet source ${spec.kind}`);
  const facts = { events: f.events, jobs: jobsOf(f.needsCollateral), utxos: f.utxos };
  return { ...facts, cost: walletCost(facts) };
}

// Greedy longest-first packing: the wallets in falling cost (ties by index),
// each to the machine whose load plus the wallet's cost, over its speed, is
// least (ties to the machine first in the list). Returns per machine, in
// the order given, { label, speed, indexes (increasing), cost, time
// (cost / speed) }.
export function packShards(costs, machines) {
  const order = costs.map((_c, i) => i).sort((a, b) => costs[b] - costs[a] || a - b);
  const load = machines.map(() => 0);
  const got = machines.map(() => []);
  for (const i of order) {
    let best = 0;
    let bestTime = Infinity;
    for (const [j, m] of machines.entries()) {
      const t = (load[j] + costs[i]) / m.speed;
      if (t < bestTime) {
        best = j;
        bestTime = t;
      }
    }
    load[best] += costs[i];
    got[best].push(i);
  }
  return machines.map((m, j) => ({ label: m.label, speed: m.speed, indexes: got[j].sort((a, b) => a - b), cost: load[j], time: load[j] / m.speed }));
}
