// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The `replay` and `battery` commands.
//
//   replay  --treatment <dir> [--treatment-pins <file>]
//           (--history <file or directory>... | --shapes <names|all>)
//           --plan recent | peak | test
//           [--collateral-rule ledger | practice] [--reps <n>]
//           [--test-reps <n>] [--run-id <id>] [--workers <n>]
//           [--memory-budget <GiB>]
//           [--analysis-freeze-tx <hash>] [--validity] [--machine <label>]
//           [--shard <k>/<n> | --wallet-indexes <file>]
//   plan-shards (--history <file or directory>... | --shapes <names|all>)
//           --plan recent | peak | test [--collateral-rule ...] [--reps <n>]
//           [--test-reps <n>] [--treatment <dir> [--treatment-pins <file>]]
//           --machines <label>[=<speed>],... --out <dir>
//   battery --treatment <dir> [--treatment-pins <file>]
//           (--history <snapshot file or directory>... | --shapes <names|all>)
//           [--methods study | test] [--reps <n>] [--pools <file>]
//           [--run-id <id>] [--workers <n>] [--memory-budget <GiB>]
//           [--validity] [--oracle [--oracle-workers <n>]
//           [--oracle-settings <name>=<value>,...]]
//
// A history directory is read for its *.jsonl files. --shapes takes `all`
// (the 21 fixed shapes) or a comma-separated list of fixed shapes and heavy
// wallets H<k>E<e> (shapes/heavy.mjs). A recent or peak plan is the study's
// (arms/plan.mjs): it needs --collateral-rule, the one rule every job runs
// under, and --reps sets the repetitions of a library that picks at random
// (10 when absent). A test plan runs the test method only and is never a
// study run; it runs under every collateral rule unless --collateral-rule
// names one. Results go to the private run
// directory (out/records.mjs); the command prints counts only. A replay's run
// directory is a stage (out/stage.mjs): each wallet's records a gzip segment
// of their own, joined in wallet order at the end; the same command on the
// same run ID resumes it at the wallets not done, and refuses when what
// decides the records differs. --shard or --wallet-indexes runs one
// machine's share of the wallets (replay/shards.mjs), which plan-shards
// plans and merge-stage (out/merge.mjs) joins. No time limit
// decides a result: every replay, answer and oracle call runs to completion,
// under watchdogs that only make hung work run again (pool.mjs,
// oracle/oracle.mjs). The worker counts and the workers' memory budget
// (--memory-budget, by default 80% of the memory available at the start;
// pool.mjs) change no record; a battery's run.json records them with the
// machine (`machine`, out/host.mjs) apart from the options, a replay stage's
// machines/<label>.json with the label --machine gives (`local` when
// absent) and the pool's counts, and the printout gives the pools' counts
// beside the totals. The battery's oracle stops on its work budget; the
// wall-clock limit (oracle setting limit=wall-clock, kept for the oracle's
// checks) is refused, and --limit-ms, --answer-limit-ms and --oracle-limit-ms
// are gone (options.mjs).

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { loadTreatment, DEFAULT_PINS } from '../treatment/bridge.mjs';
import { Pool, workerCount } from './pool.mjs';
import { runReplays, runBatteries } from './run.mjs';
import { windowPlan, testPlan, STUDY_ROLES, TEST_ROLES, batteryPlan } from '../arms/plan.mjs';
import { RunOutput, recordsShapeName } from '../out/records.mjs';
import { openStage, walletList, walletsSha256, writeAtomic, jsonText, STAGE_LAYOUT } from '../out/stage.mjs';
import { checkSelection, selectionOf, machinesOf, walletFacts, packShards, COST_FORMULA, WALLET_INDEXES_FORMAT } from './shards.mjs';
import { runDir, ensureDir } from '../history/paths.mjs';
import { SHAPE_NAMES } from '../shapes/shapes.mjs';
import { isHeavyName } from '../shapes/heavy.mjs';
import { SIM_SETTINGS } from '../settings.mjs';
import { formatHashList } from '../hash.mjs';
import { loadSource } from './source.mjs';
import { assignPopulation, countPopulation } from '../battery/population.mjs';
import { createBatteryOracle } from '../oracle/battery-hook.mjs';
import { oracleSettings } from '../oracle/settings.mjs';
import { ORACLE_LIMIT_MS_GONE, MACHINE_OPTIONS, LOCAL_OPTIONS, machineLabel, memoryBudgetOf } from '../options.mjs';
import { machineRecord } from '../out/host.mjs';

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

// The wallets --shapes names: `all` is the 21 fixed shapes; a list may name
// fixed shapes and heavy wallets H<k>E<e>. A heavy name is refused, before
// anything runs, when it is not one the generator makes (k from 1 to 30, at
// least 10 events) or when it is longer than a record's wallet field can
// carry (six characters; H20E005 is valid and too long).
export function shapeNamesOf(v) {
  if (String(v) === 'all') return [...SHAPE_NAMES];
  const names = String(v).split(',');
  for (const n of names) {
    if (SHAPE_NAMES.includes(n)) continue;
    if (!isHeavyName(n)) throw new Error(`unknown shape ${n}: --shapes takes all, a fixed shape or a heavy wallet H<k>E<e> (k from 1 to 30, at least 10 events)`);
    if (!recordsShapeName(n)) throw new Error(`heavy wallet ${n}: a record names a shape in at most six characters`);
  }
  return names;
}

export function walletsOf(opts, { stream }) {
  if (opts.shapes) return shapeNamesOf(opts.shapes).map((name) => ({ spec: { kind: 'shape', name, stream } }));
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

// The run's workers, checked before anything starts: the replay or battery
// workers, and the battery's oracle workers when it runs the oracle.
export function workersOf(opts, command) {
  const workers = workerCount(opts.workers, '--workers');
  const oracleWorkers = command === 'battery' && opts.oracle ? workerCount(opts.oracleWorkers, '--oracle-workers') : 0;
  return { workers, oracleWorkers };
}

// The run's workers and their memory budget (bytes, the pool's default when
// --memory-budget is absent), checked before anything is loaded.
async function setup(opts, command) {
  if (!opts.treatment) throw new Error('--treatment <dir> names the treatment directory');
  const threads = workersOf(opts, command);
  const memoryBudget = memoryBudgetOf(opts.memoryBudget);
  const pinsPath = pinsPathOf(opts);
  const T = await loadTreatment(opts.treatment, readFileSync(pinsPath, 'utf8'));
  const pool = new Pool({ treatmentDir: resolve(opts.treatment), pinsPath, size: threads.workers, memoryBudget });
  const runId = opts.runId || `${command}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  return { T, pool, pinsPath, runId, threads: { ...threads, memoryBudgetBytes: pool.budget } };
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

// run.json: what the run ran under, and apart from it (`machine`) the worker
// counts, the memory budget and the machine, which change no record.
function header(command, opts, T, threads, extra) {
  return {
    command,
    options: Object.fromEntries(Object.entries(opts).filter(([k]) => k !== '_' && !MACHINE_OPTIONS.includes(k))),
    settings: SIM_SETTINGS,
    treatmentPins: Object.fromEntries(T.pins),
    node: process.version,
    manifest: formatHashList(),
    ...extra,
    machine: machineRecord(threads)
  };
}

// The options a replay stage's run.json records: those that change a record,
// leaving out how the run uses the machine and where its files are.
export function recordOptions(opts) {
  return Object.fromEntries(Object.entries(opts).filter(([k]) => k !== '_' && !MACHINE_OPTIONS.includes(k) && !LOCAL_OPTIONS.includes(k)));
}

// The CSL build the treatment loads: its package, version and the SHA-256 of
// each WebAssembly file beside the module, which pin the build exactly.
export function cslBuild(T) {
  const k = T.cslkit;
  const wasm = {};
  if (k.CSL_PATH) {
    const dir = dirname(k.CSL_PATH);
    for (const f of readdirSync(dir).sort()) if (f.endsWith('.wasm')) wasm[f] = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
  }
  return { package: k.CSL_PACKAGE ?? null, version: k.CSL_VERSION ?? null, wasm };
}

// A replay stage's run.json (out/stage.mjs adds the wallet list's SHA-256):
// what decides the records, and nothing about the machine.
export function stageHeader(opts, T, { plan, entries }) {
  return {
    layout: STAGE_LAYOUT,
    command: 'replay',
    plan,
    entries,
    options: recordOptions(opts),
    settings: SIM_SETTINGS,
    treatmentPins: Object.fromEntries(T.pins),
    node: process.version,
    csl: cslBuild(T),
    manifest: formatHashList()
  };
}

// A replay's plan from its options, checked before anything is loaded: the
// plan's entries, the roles its selectors play and the collateral rules
// (the one --collateral-rule names, or every rule for a test plan without
// it).
export function replayPlanOf(opts) {
  const plan = opts.plan;
  if (!['recent', 'peak', 'test'].includes(plan)) throw new Error('--plan recent | peak | test');
  if (plan !== 'test' && !opts.collateralRule) throw new Error('--collateral-rule ledger | practice names the one rule every job runs under (the study takes it from the collateral measurement)');
  if (plan === 'test' && opts.reps !== undefined) throw new Error('--reps is for the recent and peak plans; a test plan takes --test-reps');
  const entries = plan === 'test' ? testPlan({ reps: Number(opts.testReps || 2) }) : windowPlan(plan, opts.reps ? { reps: Number(opts.reps) } : {});
  const roles = plan === 'test' ? { ...TEST_ROLES, test: 'test-largest-first' } : STUDY_ROLES;
  return { plan, entries, roles, collateralRules: opts.collateralRule ? [opts.collateralRule] : null };
}

// The replay command. A shard (--shard or --wallet-indexes) runs only its
// wallets not done and ends without the stage's join unless every wallet is
// done in the directory; its printout gives `ended: false` and `shard`: the
// selection, the done indexes as ranges, their count and how many remain.
// A stage that has ended prints its totals and runs nothing (`endedEarlier`).
export async function cmdReplay(opts) {
  const { plan, entries, roles, collateralRules } = replayPlanOf(opts);
  const machine = machineLabel(opts.machine);
  checkSelection(opts);
  const wallets = walletsOf(opts, { stream: 'synthetic' });
  const { T, pool, runId, threads } = await setup(opts, 'replay');
  let out = null;
  try {
    const first = loadSource(T, wallets[0].spec);
    const list = walletList(wallets);
    const selection = selectionOf(opts, { plan, wallets: list });
    out = await openStage(runDir(first.network, runId), { header: stageHeader(opts, T, { plan, entries }), wallets: list, machine, workers: threads.workers, selection });
    out.machine({ memoryBudgetBytes: pool.budget, pool: pool.stats });
    out.note({ event: 'start', wallets: wallets.length, analysisFreezeTx: opts.analysisFreezeTx || null, selection: selection ? selection.record : null });
    const totals = await runReplays(T, pool, { wallets, plan: entries, roles, out, validity: !!opts.validity, ...(collateralRules ? { collateralRules } : {}) });
    out.note({ event: 'end', ended: out.ended, totals, records: out.counts, workers: pool.stats });
    const print = { runId, dir: out.dir, ended: out.ended, ...(out.earlier ? { endedEarlier: true } : {}), ...(out.progress ? { shard: { selection: selection.record, ...out.progress } } : {}), totals, records: out.counts, workers: pool.stats };
    return { print, ended: out.ended, failed: !!(totals.validity && totals.validity.failed) };
  } finally {
    if (out) out.close();
    await pool.close();
  }
}

// plan-shards: one wallet index file per machine (replay/shards.mjs) for the
// replay given the same wallets and plan, written to --out as
// <label>.json. A file already there for the same machines gains or
// replaces this plan's entry, so one file serves a study's two replay
// stages; one planned for other machines is refused. The shapes need the
// treatment, to build their streams; history files do not.
export async function cmdPlanShards(opts) {
  const { plan, entries, roles, collateralRules } = replayPlanOf(opts);
  const machines = machinesOf(opts.machines);
  if (typeof opts.out !== 'string' || !opts.out) throw new Error('--out <dir> names the directory the index files are written to');
  const wallets = walletsOf(opts, { stream: 'synthetic' });
  let T = null;
  if (wallets.some((w) => w.spec.kind === 'shape')) {
    if (!opts.treatment) throw new Error('--treatment <dir> loads the shapes, whose streams the estimate counts');
    T = await loadTreatment(opts.treatment, readFileSync(pinsPathOf(opts), 'utf8'));
  }
  const list = walletList(wallets);
  const sha = walletsSha256(list);
  const facts = wallets.map((w) => walletFacts(T, w.spec, { entries, roles, collateralRules }));
  const packed = packShards(facts.map((f) => f.cost), machines);
  const total = packed.reduce((a, m) => a + m.cost, 0);
  const ideal = total / machines.reduce((a, m) => a + m.speed, 0);
  const dir = ensureDir(resolve(opts.out));
  const files = packed.map((m) => {
    const path = join(dir, `${m.label}.json`);
    let file = { format: WALLET_INDEXES_FORMAT, machine: m.label, machines: machines.map(({ label, speed }) => ({ label, speed })), costFormula: COST_FORMULA, plans: {} };
    if (existsSync(path)) {
      let was = null;
      try {
        was = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        // refused below
      }
      if (!was || was.format !== WALLET_INDEXES_FORMAT || was.machine !== m.label || JSON.stringify(was.machines) !== JSON.stringify(file.machines) || !was.plans) throw new Error(`refusing: ${path} was planned for other machines or is not a wallet index file; remove it or write to another --out`);
      file = { ...was, costFormula: COST_FORMULA };
    }
    const entry = { wallets: list.length, walletsSha256: sha, indexes: m.indexes, cost: m.cost, share: total ? m.cost / total : 0, balance: ideal ? m.time / ideal : 0 };
    file.plans = { ...file.plans, [plan]: entry };
    return { path, file, m, entry };
  });
  for (const f of files) writeAtomic(f.path, jsonText(f.file));
  return { print: { command: 'plan-shards', plan, wallets: list.length, costFormula: COST_FORMULA, out: dir, machines: files.map(({ path, m, entry }) => ({ label: m.label, speed: m.speed, wallets: m.indexes.length, share: entry.share, balance: entry.balance, file: path })) } };
}

export async function cmdBattery(opts) {
  const oracleSettingsUsed = batteryOracleSettings(opts);
  // Each file's batteries are decided before anything starts or is written;
  // a file the rules refuse stops the command here.
  const wallets = assignPopulation(walletsOf(opts, { stream: null }));
  const { T, pool, runId, threads } = await setup(opts, 'battery');
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
  const out = new RunOutput(first.network, runId, header('battery', opts, T, threads, { methods, population: countPopulation(wallets), ...(oracleSettingsUsed ? { oracle: { settings: oracleSettingsUsed } } : {}) }));
  out.note({ event: 'start', wallets: wallets.length });
  let oracle = null;
  try {
    if (oracleSettingsUsed) oracle = await createBatteryOracle({ treatmentDir: resolve(opts.treatment), pinsText: readFileSync(pinsPathOf(opts), 'utf8'), workers: threads.oracleWorkers, settings: oracleSettingsUsed, note: (e) => out.note({ ...e, oracle: true }) });
    const totals = await runBatteries(T, pool, { wallets, methods, out, pools, oracle, validity: !!opts.validity });
    out.note({ event: 'end', totals, records: out.counts, workers: pool.stats, ...(oracle ? { oracle: oracle.stats } : {}) });
    return { print: { runId, dir: out.dir, totals, records: out.counts, workers: pool.stats, ...(oracle ? { oracle: oracle.stats } : {}) }, failed: !!(totals.validity && totals.validity.failed) };
  } finally {
    if (oracle) await oracle.close();
    out.close();
    await pool.close();
  }
}
