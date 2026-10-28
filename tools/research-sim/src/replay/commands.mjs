// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The `replay` and `battery` commands.
//
//   replay  --treatment <dir> [--treatment-pins <file>]
//           (--history <file or directory>... | --shapes <names|all>)
//           --plan recent | peak | test [--reps-h1 <n>] [--reps-variants <n>]
//           [--test-reps <n>] [--run-id <id>] [--workers <n>]
//           [--limit-ms <ms>] [--analysis-freeze-tx <hash>]
//   battery --treatment <dir> [--treatment-pins <file>]
//           (--history <snapshot file or directory>... | --shapes <names|all>)
//           [--methods study | test] [--reps <n>] [--pools <file>]
//           [--run-id <id>] [--workers <n>] [--answer-limit-ms <ms>]
//           [--oracle [--oracle-workers <n>] [--oracle-limit-ms <ms>]
//           [--oracle-settings <name>=<value>,...]]
//
// A history directory is read for its *.jsonl files. A test plan runs the
// test method only and is never a study run. Results go to the private run
// directory (out/records.mjs); the command prints counts only.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadTreatment, DEFAULT_PINS } from '../treatment/bridge.mjs';
import { Pool, REPLAY_LIMIT_MS, ANSWER_LIMIT_MS } from './pool.mjs';
import { runReplays, runBatteries } from './run.mjs';
import { windowPlan, testPlan, STUDY_ROLES, TEST_ROLES, batteryPlan } from '../arms/plan.mjs';
import { RunOutput } from '../out/records.mjs';
import { SHAPE_NAMES } from '../shapes/shapes.mjs';
import { SIM_SETTINGS } from '../settings.mjs';
import { formatHashList } from '../hash.mjs';
import { loadSource } from './source.mjs';
import { createBatteryOracle } from '../oracle/battery-hook.mjs';
import { oracleSettings } from '../oracle/settings.mjs';

const list = (x) => (x === undefined ? [] : [].concat(x));

function historyFiles(paths) {
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

async function setup(opts, command) {
  if (!opts.treatment) throw new Error('--treatment <dir> names the treatment directory');
  const pinsPath = pinsPathOf(opts);
  const T = await loadTreatment(opts.treatment, readFileSync(pinsPath, 'utf8'));
  const pool = new Pool({ treatmentDir: resolve(opts.treatment), pinsPath, size: Number(opts.workers || 1) });
  const runId = opts.runId || `${command}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  return { T, pool, pinsPath, runId };
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
  const { T, pool, runId } = await setup(opts, 'replay');
  const wallets = walletsOf(opts, { stream: 'synthetic' });
  const first = loadSource(T, wallets[0].spec);
  const entries = plan === 'test' ? testPlan({ reps: Number(opts.testReps || 2) }) : windowPlan(plan, { reps: { h1: opts.repsH1 ? Number(opts.repsH1) : undefined, variants: opts.repsVariants ? Number(opts.repsVariants) : undefined } });
  const roles = plan === 'test' ? { ...TEST_ROLES, test: 'test-largest-first' } : STUDY_ROLES;
  const out = new RunOutput(first.network, runId, header('replay', opts, T, { plan, entries }));
  out.note({ event: 'start', wallets: wallets.length, analysisFreezeTx: opts.analysisFreezeTx || null });
  try {
    const totals = await runReplays(T, pool, { wallets, plan: entries, roles, out, limitMs: Number(opts.limitMs || REPLAY_LIMIT_MS) });
    out.note({ event: 'end', totals, records: out.counts, workers: pool.stats });
    return { print: { runId, dir: out.dir, totals, records: out.counts, workers: pool.stats } };
  } finally {
    out.close();
    await pool.close();
  }
}

export async function cmdBattery(opts) {
  const { T, pool, runId } = await setup(opts, 'battery');
  const wallets = walletsOf(opts, { stream: null });
  const first = loadSource(T, wallets[0].spec);
  const methods = opts.methods === 'test'
    ? [{ name: 'test-largest-first', opts: [{ changePolicy: 'layout' }, { changePolicy: 'single' }, { changePolicy: 'naive' }], repetitions: 1 }, { name: 'unfrackit-h12', opts: [{ changePolicy: 'default', absorb: true }, { changePolicy: 'default', absorb: false }], repetitions: 1 }]
    : batteryPlan({ roles: STUDY_ROLES, reps: Number(opts.reps || 30) });
  // The shapes use the fixed test values of battery/battery.mjs; a wallet's
  // battery draws from the frozen pools, which must be given.
  if (!opts.shapes && !opts.pools) throw new Error('--pools <file> names the frozen T1 amounts and T5 shares the battery draws from');
  const pools = opts.pools ? JSON.parse(readFileSync(opts.pools, 'utf8')) : undefined;
  // The oracle is off unless asked for: it takes up to a minute per spend
  // and change policy.
  const oracleSettingsUsed = opts.oracle ? oracleSettings(parseOracleSettings(opts.oracleSettings)) : null;
  const out = new RunOutput(first.network, runId, header('battery', opts, T, { methods, ...(oracleSettingsUsed ? { oracle: { settings: oracleSettingsUsed } } : {}) }));
  out.note({ event: 'start', wallets: wallets.length });
  let oracle = null;
  try {
    if (oracleSettingsUsed) oracle = await createBatteryOracle({ treatmentDir: resolve(opts.treatment), pinsText: readFileSync(pinsPathOf(opts), 'utf8'), workers: Number(opts.oracleWorkers || 1), ...(opts.oracleLimitMs ? { limitMs: Number(opts.oracleLimitMs) } : {}), settings: oracleSettingsUsed });
    const totals = await runBatteries(T, pool, { wallets, methods, out, answerLimitMs: Number(opts.answerLimitMs || ANSWER_LIMIT_MS), pools: pools && { t1: pools.t1.map(BigInt), t5: pools.t5.map((x) => x.map(BigInt)) }, oracle });
    out.note({ event: 'end', totals, records: out.counts, workers: pool.stats, ...(oracle ? { oracle: oracle.stats } : {}) });
    return { print: { runId, dir: out.dir, totals, records: out.counts, workers: pool.stats, ...(oracle ? { oracle: oracle.stats } : {}) } };
  } finally {
    if (oracle) await oracle.close();
    out.close();
    await pool.close();
  }
}
