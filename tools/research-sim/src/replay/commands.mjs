// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The `replay` and `battery` commands.
//
//   replay  --treatment <dir> [--treatment-pins <file>]
//           (--history <file or directory>... | --shapes <names|all>)
//           --plan recent | peak | test [--reps-h1 <n>] [--reps-variants <n>]
//           [--test-reps <n>] [--run-id <id>] [--workers <n>]
//           [--limit-ms <ms>] [--analysis-freeze-tx <hash>] [--validity]
//   battery --treatment <dir> [--treatment-pins <file>]
//           (--history <snapshot file or directory>... | --shapes <names|all>)
//           [--methods study | test] [--reps <n>] [--pools <file>]
//           [--run-id <id>] [--workers <n>] [--answer-limit-ms <ms>] [--validity]
//           [--oracle [--oracle-workers <n>]
//           [--oracle-settings <name>=<value>,...]]
//
// A history directory is read for its *.jsonl files. A test plan runs the
// test method only and is never a study run. Results go to the private run
// directory (out/records.mjs); the command prints counts only. A run keeps at
// most MAX_BUSY_THREADS (12) threads busy: replay refuses more --workers,
// battery more --workers and --oracle-workers together (pool.mjs), and
// run.json records the counts and the cap. The battery's oracle stops on its
// work budget; --oracle-limit-ms and the wall-clock limit (oracle setting
// limit=wall-clock, kept for the oracle's checks) are refused.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadTreatment, DEFAULT_PINS } from '../treatment/bridge.mjs';
import { Pool, REPLAY_LIMIT_MS, ANSWER_LIMIT_MS, workerCount, checkBusyThreads } from './pool.mjs';
import { runReplays, runBatteries } from './run.mjs';
import { windowPlan, testPlan, STUDY_ROLES, TEST_ROLES, batteryPlan } from '../arms/plan.mjs';
import { RunOutput } from '../out/records.mjs';
import { SHAPE_NAMES } from '../shapes/shapes.mjs';
import { SIM_SETTINGS } from '../settings.mjs';
import { formatHashList } from '../hash.mjs';
import { loadSource } from './source.mjs';
import { createBatteryOracle } from '../oracle/battery-hook.mjs';
import { oracleSettings } from '../oracle/settings.mjs';
import { ORACLE_LIMIT_MS_GONE } from '../options.mjs';

const list = (x) => (x === undefined ? [] : [].concat(x));

export function historyFiles(paths) {
  const out = [];
  for (const p of paths) {
    const a = resolve(p);
    if (statSync(a).isDirectory()) {
      for (const f of readdirSync(a).sort()) if (f.endsWith('.jsonl')) out.push(join(a, f));
    } else {
      out.push(a);
    }
  }
  return out;
}

function walletsOf(opts, { stream }) {
  if (opts.shapes) {
    const names = String(opts.shapes) === 'all' ? SHAPE_NAMES : String(opts.shapes).split(',');
    for (const n of names) if (!SHAPE_NAMES.includes(n)) throw new Error(`unknown shape ${n}`);
    return names.map((name) => ({ spec: { kind: 'shape', name, stream } }));
  }
  const files = historyFiles(list(opts.history));
  if (!files.length) throw new Error('name the wallets: --history <file or directory> or --shapes <names|all>');
  return files.map((path) => ({ spec: { kind: 'history', path, analysisFreezeTx: opts.analysisFreezeTx || null } }));
}

const pinsPathOf = (opts) => (opts.treatmentPins ? resolve(opts.treatmentPins) : DEFAULT_PINS);

// --oracle-settings name=value,name=value
function parseOracleSettings(v) {
  if (v === undefined) return {};
  if (typeof v !== 'string') throw new Error('--oracle-settings <name>=<value>,...');
  return Object.fromEntries(v.split(',').map((kv) => {
    const i = kv.indexOf('=');
    if (i < 1) throw new Error(`--oracle-settings: ${kv} is not name=value`);
    return [kv.slice(0, i), kv.slice(i + 1)];
  }));
}

// The frozen pools of a --pools file: battery-pools.json as the battery-pools
// command writes it (t1Amounts, t5Shares), or a file giving t1 and t5. A file
// with neither form, or with both, is refused.
export function poolsOf(p) {
  const written = 't1Amounts' in p || 't5Shares' in p;
  const given = 't1' in p || 't5' in p;
  if (written === given) throw new Error('--pools: the file must give either t1Amounts and t5Shares (battery-pools.json) or t1 and t5');
  const t1 = written ? p.t1Amounts : p.t1;
  const t5 = written ? p.t5Shares : p.t5;
  if (!Array.isArray(t1) || !Array.isArray(t5)) throw new Error('--pools: the T1 amounts and T5 shares must be arrays');
  if (!t5.every((x) => Array.isArray(x) && x.length === 2)) throw new Error('--pools: each T5 share is [units sent, units held]');
  return { t1: t1.map(BigInt), t5: t5.map((x) => x.map(BigInt)) };
}

// The run's busy threads, checked against the cap before anything starts:
// the replay or battery workers, and the battery's oracle workers when it
// runs the oracle.
export function threadsOf(opts, command) {
  const workers = workerCount(opts.workers, '--workers');
  const oracleWorkers = command === 'battery' && opts.oracle ? workerCount(opts.oracleWorkers, '--oracle-workers') : 0;
  return checkBusyThreads(workers, oracleWorkers);
}

async function setup(opts, command) {
  if (!opts.treatment) throw new Error('--treatment <dir> names the treatment directory');
  const threads = threadsOf(opts, command);
  const pinsPath = pinsPathOf(opts);
  const T = await loadTreatment(opts.treatment, readFileSync(pinsPath, 'utf8'));
  const pool = new Pool({ treatmentDir: resolve(opts.treatment), pinsPath, size: threads.workers });
  const runId = opts.runId || `${command}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  return { T, pool, pinsPath, runId, threads };
}

// The battery's oracle settings: the defaults with --oracle-settings over
// them, under the work budget only.
export function batteryOracleSettings(opts) {
  if (opts.oracleLimitMs !== undefined) throw new Error(ORACLE_LIMIT_MS_GONE);
  if (!opts.oracle) return null;
  const s = oracleSettings(parseOracleSettings(opts.oracleSettings));
  if (s.limit !== 'budget') throw new Error('refusing: the battery\'s oracle stops on its work budget; limit=wall-clock is kept for the oracle\'s checks');
  return s;
}

function header(command, opts, T, extra) {
  return {
    command,
    options: Object.fromEntries(Object.entries(opts).filter(([k]) => k !== '_')),
    settings: SIM_SETTINGS,
    treatmentPins: Object.fromEntries(T.pins),
    node: process.version,
    manifest: formatHashList(),
    ...extra
  };
}

export async function cmdReplay(opts) {
  const plan = opts.plan;
  if (!['recent', 'peak', 'test'].includes(plan)) throw new Error('--plan recent | peak | test');
  const { T, pool, runId, threads } = await setup(opts, 'replay');
  const wallets = walletsOf(opts, { stream: 'synthetic' });
  const first = loadSource(T, wallets[0].spec);
  const entries = plan === 'test' ? testPlan({ reps: Number(opts.testReps || 2) }) : windowPlan(plan, { reps: { h1: opts.repsH1 ? Number(opts.repsH1) : undefined, variants: opts.repsVariants ? Number(opts.repsVariants) : undefined } });
  const roles = plan === 'test' ? { ...TEST_ROLES, test: 'test-largest-first' } : STUDY_ROLES;
  const out = new RunOutput(first.network, runId, header('replay', opts, T, { plan, entries, threads }));
  out.note({ event: 'start', wallets: wallets.length, analysisFreezeTx: opts.analysisFreezeTx || null });
  try {
    const totals = await runReplays(T, pool, { wallets, plan: entries, roles, out, limitMs: Number(opts.limitMs || REPLAY_LIMIT_MS), validity: !!opts.validity });
    out.note({ event: 'end', totals, records: out.counts, workers: pool.stats });
    return { print: { runId, dir: out.dir, totals, records: out.counts, workers: pool.stats }, failed: !!(totals.validity && totals.validity.failed) };
  } finally {
    out.close();
    await pool.close();
  }
}

export async function cmdBattery(opts) {
  const oracleSettingsUsed = batteryOracleSettings(opts);
  const { T, pool, runId, threads } = await setup(opts, 'battery');
  const wallets = walletsOf(opts, { stream: null });
  const first = loadSource(T, wallets[0].spec);
  const methods = opts.methods === 'test'
    ? [{ name: 'test-largest-first', opts: [{ changePolicy: 'layout' }, { changePolicy: 'single' }, { changePolicy: 'naive' }], repetitions: 1 }, { name: 'unfrackit-h12', opts: [{ changePolicy: 'default', absorb: true }, { changePolicy: 'default', absorb: false }], repetitions: 1 }]
    : batteryPlan({ roles: STUDY_ROLES, reps: Number(opts.reps || 30) });
  // The shapes use the fixed test values of battery/battery.mjs; a wallet's
  // battery draws from the frozen pools, which must be given.
  if (!opts.shapes && !opts.pools) throw new Error('--pools <file> names the frozen T1 amounts and T5 shares the battery draws from');
  const pools = opts.pools ? poolsOf(JSON.parse(readFileSync(opts.pools, 'utf8'))) : undefined;
  // The oracle is off unless asked for: it takes up to about a minute per
  // spend and change policy.
  const out = new RunOutput(first.network, runId, header('battery', opts, T, { methods, threads, ...(oracleSettingsUsed ? { oracle: { settings: oracleSettingsUsed } } : {}) }));
  out.note({ event: 'start', wallets: wallets.length });
  let oracle = null;
  try {
    if (oracleSettingsUsed) oracle = await createBatteryOracle({ treatmentDir: resolve(opts.treatment), pinsText: readFileSync(pinsPathOf(opts), 'utf8'), workers: threads.oracleWorkers, settings: oracleSettingsUsed });
    const totals = await runBatteries(T, pool, { wallets, methods, out, answerLimitMs: Number(opts.answerLimitMs || ANSWER_LIMIT_MS), pools, oracle, validity: !!opts.validity });
    out.note({ event: 'end', totals, records: out.counts, workers: pool.stats, ...(oracle ? { oracle: oracle.stats } : {}) });
    return { print: { runId, dir: out.dir, totals, records: out.counts, workers: pool.stats, ...(oracle ? { oracle: oracle.stats } : {}) }, failed: !!(totals.validity && totals.validity.failed) };
  } finally {
    if (oracle) await oracle.close();
    out.close();
    await pool.close();
  }
}
