// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The `replay` and `plan-shards` commands.
//
//   replay  --treatment <dir> [--treatment-pins <file>]
//           (--history <file or directory>... | --shapes <names|all>)
//           --plan recent | peak
//           --collateral-rule ledger | practice [--reps <n>]
//           [--run-id <id>] [--workers <n>]
//           [--memory-budget <GiB>]
//           [--analysis-freeze-tx <hash>] [--validity] [--machine <label>]
//           [--shard <k>/<n> | --wallet-indexes <file>]
//   plan-shards (--history <file or directory>... | --shapes <names|all>)
//           --plan recent | peak --collateral-rule ... [--reps <n>]
//           [--treatment <dir> [--treatment-pins <file>]]
//           --machines <label>[=<speed>],... --out <dir>
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
// decides a result: every replay and answer runs to completion, under a
// watchdog that only makes hung work run again (pool.mjs). The worker count
// and the workers' memory budget (--memory-budget, by default 80% of the
// memory available at the start; pool.mjs) change no record; a replay
// stage's machines/<label>.json records them with the label --machine gives
// (`local` when absent) and the pool's counts, and the printout gives the
// pool's counts beside the totals. --limit-ms and --answer-limit-ms are
// gone (options.mjs).

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { loadTreatment, DEFAULT_PINS } from '../treatment/bridge.mjs';
import { Pool, workerCount } from './pool.mjs';
import { runReplays } from './run.mjs';
import { windowPlan, STUDY_ROLES } from '../arms/plan.mjs';
import { recordsShapeName } from '../out/records.mjs';
import { openStage, walletList, walletsSha256, writeAtomic, jsonText, STAGE_LAYOUT } from '../out/stage.mjs';
import { checkSelection, selectionOf, machinesOf, walletFacts, packShards, COST_FORMULA, WALLET_INDEXES_FORMAT } from './shards.mjs';
import { runDir, ensureDir } from '../history/paths.mjs';
import { SHAPE_NAMES } from '../shapes/shapes.mjs';
import { isHeavyName } from '../shapes/heavy.mjs';
import { SIM_SETTINGS } from '../settings.mjs';
import { formatHashList } from '../hash.mjs';
import { loadSource } from './source.mjs';
import { MACHINE_OPTIONS, LOCAL_OPTIONS, machineLabel, memoryBudgetOf } from '../options.mjs';

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

// The run's workers, checked before anything starts.
export function workersOf(opts) {
  return { workers: workerCount(opts.workers, '--workers') };
}

// The run's workers and their memory budget (bytes, the pool's default when
// --memory-budget is absent), checked before anything is loaded.
async function setup(opts, command) {
  if (!opts.treatment) throw new Error('--treatment <dir> names the treatment directory');
  const threads = workersOf(opts);
  const memoryBudget = memoryBudgetOf(opts.memoryBudget);
  const pinsPath = pinsPathOf(opts);
  const T = await loadTreatment(opts.treatment, readFileSync(pinsPath, 'utf8'));
  const pool = new Pool({ treatmentDir: resolve(opts.treatment), pinsPath, size: threads.workers, memoryBudget });
  const runId = opts.runId || `${command}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  return { T, pool, pinsPath, runId, threads: { ...threads, memoryBudgetBytes: pool.budget } };
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
// plan's entries, the roles its selectors play and the one collateral rule
// every job runs under.
export function replayPlanOf(opts) {
  const plan = opts.plan;
  if (!['recent', 'peak'].includes(plan)) throw new Error('--plan recent | peak');
  if (!opts.collateralRule) throw new Error('--collateral-rule ledger | practice names the one rule every job runs under (the study takes it from the collateral measurement)');
  const entries = windowPlan(plan, opts.reps ? { reps: Number(opts.reps) } : {});
  return { plan, entries, roles: STUDY_ROLES, collateralRules: [opts.collateralRule] };
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
    const totals = await runReplays(T, pool, { wallets, plan: entries, roles, out, validity: !!opts.validity, collateralRules });
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
