// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The live-fire command: before the final freeze, the simulator's steps on the
// wallets an extraction live-fire run picked, to confirm the code works on
// real data, logged in the extraction tool's check log in functional terms
// only, with nothing left behind but the entries.
//
//   live-fire --run-id sim-<id> --extraction-run <id> --purpose <text>
//             --expect-network <name> --treatment <dir> [--treatment-pins <file>]
//             [--workers <n>] [--oracle-workers <n>] [--bytes tx_cbor|immutable]
//             [--immutable-dir <dir>] [--immutable-host <host>] [--keep-for-debug]
//   live-fire --cleanup --run-id sim-<id> --network <name>
//
// Order:
// 1. The options, then the pick (checklog.mjs readPick): the extraction run
//    is a live-fire run of this network whose end entry kept its pick, with
//    sim/wallets.json present. A refusal here has queried nothing and logs
//    nothing.
// 2. The gate, logged as a query (query-start, then query with its outcome):
//    a connection that reads db-sync's meta, refuses another network than
//    --expect-network, and on mainnet takes the gate's live-fire path
//    (history/db.mjs), which reads the pick again and refuses once a study run
//    of the final freeze is recorded. A refused gate is a failed query, never
//    a live-fire run.
// 3. The start entry (sim-live-fire-start), before any wallet is read.
// 4. The stages, in the study's stage layout (study.mjs): each in its own run
//    directory <run id>/<stage> under the private root, run by the command
//    the study runs for it (STAGE_COMMAND), in order: history-recent,
//    history-peak and history-snapshot over every picked wallet at the pick's
//    snapshot block, with the windows computed from it; battery-pools over the
//    recent files; replay-recent and replay-peak; the battery with its study
//    selectors and the oracle. Validity checks are on throughout. A stage that
//    throws stops the run; a stage that finishes with a failed check is a
//    failed step, and the run goes on.
// 5. The end entry (sim-live-fire), naming the start: the outcome, the error
//    redacted, the run time, each step's outcome, error class and time, and
//    three checks, each true, false or null (not reached), over the whole run:
//    every intent parsed, every built transaction passed the ledger checks,
//    and a replay reached the replay limit. Then what became of the
//    wallet-level output: the run directory (history files, records, logs) is
//    deleted whether the run succeeded or failed, unless --keep-for-debug is
//    given and a step failed; a kept run is deleted later by --cleanup, which
//    logs a cleanup entry under the run's ID. A run killed midway leaves its
//    start unclosed, which the extraction tool's `check-log verify` reports
//    until the same run ID ends with its output deleted or --cleanup runs.
//
// Nothing counted reaches the log, the progress lines or what the command
// prints: the stages' totals are read in memory for the three checks only.
// The repetitions are one of each (LIVE_FIRE_REPS) and the limits are the
// study's; both are recorded in the start entry.

import { existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { join, resolve } from 'node:path';
import { runDir, historyDir } from '../history/paths.mjs';
import { Refusal, connect } from '../history/db.mjs';
import { IntentCheck } from '../history/rebuild.mjs';
import { formatHashList } from '../hash.mjs';
import { DEFAULT_PINS } from '../treatment/bridge.mjs';
import { REPLAY_LIMIT_MS, ANSWER_LIMIT_MS, MAX_BUSY_THREADS } from '../replay/pool.mjs';
import { ORACLE_SETTINGS } from '../oracle/settings.mjs';
import { STAGE_COMMAND } from './study.mjs';
import { readPick, readLog, appendEntry, sanitizeError, redactCommand, unclosedStarts, keptRun, isSimRunId, SIM_GATE, SIM_LIVE_FIRE_START, SIM_LIVE_FIRE, KEPT } from './checklog.mjs';

export const LIVE_FIRE_STAGES = Object.freeze(['history-recent', 'history-peak', 'history-snapshot', 'battery-pools', 'replay-recent', 'replay-peak', 'battery']);
// One repetition of every arm, variant and random selector: each code path a
// study run takes runs at least once, and a run over ten mainnet wallets ends
// in hours at most.
export const LIVE_FIRE_REPS = Object.freeze({ repsH1: 1, repsVariants: 1, reps: 1 });
export { MAX_BUSY_THREADS };

const RUN_OPTIONS = new Set(['runId', 'extractionRun', 'purpose', 'expectNetwork', 'treatment', 'treatmentPins', 'workers', 'oracleWorkers', 'bytes', 'immutableDir', 'immutableHost', 'keepForDebug']);
const CLEANUP_OPTIONS = new Set(['cleanup', 'runId', 'network']);
const SIM_ID = /^sim-[A-Za-z0-9._-]+$/;
const flag = (k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
const sha256 = (x) => createHash('sha256').update(x).digest('hex');
const positive = (v, name) => {
  if (v === undefined) return 1;
  if (typeof v !== 'string' || !/^[1-9]\d*$/.test(v)) throw new Refusal(`refusing: ${name} takes a positive whole number`);
  return Number(v);
};

function checkKeys(opts, allowed) {
  if (opts._ && opts._.length) throw new Refusal(`refusing: unexpected argument ${opts._[0]}`);
  const keys = Object.keys(opts).filter((k) => k !== '_');
  const unknown = keys.filter((k) => !allowed.has(k));
  if (unknown.length) throw new Refusal(`refusing: live-fire does not take ${unknown.map(flag).join(', ')}`);
  const twice = keys.filter((k) => Array.isArray(opts[k]));
  if (twice.length) throw new Refusal(`refusing: ${twice.map(flag).join(', ')} given more than once`);
}

const runIdOf = (v) => {
  if (typeof v !== 'string' || !SIM_ID.test(v)) throw new Refusal('refusing: --run-id sim-<id> names the live-fire run (a simulator run ID begins with sim-; then letters, digits, dot, dash, underscore)');
  return v;
};
const text = (v, name, what) => {
  if (typeof v !== 'string' || !v.trim()) throw new Refusal(`refusing: ${name} <${what}> is required`);
  return v;
};

// The run's options, checked before anything is read. Throws a Refusal.
export function liveFireOptions(opts) {
  checkKeys(opts, RUN_OPTIONS);
  const o = {
    runId: runIdOf(opts.runId),
    extractionRun: text(opts.extractionRun, '--extraction-run', 'the extraction live-fire run\'s ID'),
    purpose: text(opts.purpose, '--purpose', 'text'),
    expectNetwork: text(opts.expectNetwork, '--expect-network', 'the database\'s network'),
    treatment: resolve(text(opts.treatment, '--treatment', 'dir')),
    treatmentPins: opts.treatmentPins === undefined ? DEFAULT_PINS : resolve(text(opts.treatmentPins, '--treatment-pins', 'file')),
    workers: positive(opts.workers, '--workers'),
    oracleWorkers: positive(opts.oracleWorkers, '--oracle-workers'),
    keepForDebug: opts.keepForDebug === undefined ? false : opts.keepForDebug
  };
  if (o.keepForDebug !== false && o.keepForDebug !== true) throw new Refusal('refusing: --keep-for-debug takes no value');
  if (!/^[a-z]+$/.test(o.expectNetwork)) throw new Refusal('refusing: --expect-network <name> names a network');
  if (isSimRunId(o.extractionRun)) throw new Refusal('refusing: --extraction-run names the extraction tool\'s run; sim- run IDs are the simulator\'s');
  if (o.workers + o.oracleWorkers > MAX_BUSY_THREADS) throw new Refusal(`refusing: --workers and --oracle-workers together may keep at most ${MAX_BUSY_THREADS} threads busy`);
  if (opts.bytes !== undefined) {
    if (opts.bytes !== 'tx_cbor' && opts.bytes !== 'immutable') throw new Refusal('refusing: --bytes tx_cbor | immutable');
    o.bytes = opts.bytes;
  }
  if (opts.immutableDir !== undefined) o.immutableDir = text(opts.immutableDir, '--immutable-dir', 'dir');
  if (opts.immutableHost !== undefined) o.immutableHost = text(opts.immutableHost, '--immutable-host', 'host');
  return o;
}

// What the run records of its plan: the stages, the repetitions and limits,
// the workers. No wallet, count or path.
export function planOf(o) {
  return {
    stages: [...LIVE_FIRE_STAGES],
    repetitions: { h1: LIVE_FIRE_REPS.repsH1, variants: LIVE_FIRE_REPS.repsVariants, battery: LIVE_FIRE_REPS.reps },
    limits_ms: { replay: REPLAY_LIMIT_MS, answer: ANSWER_LIMIT_MS, oracle_guard: ORACLE_SETTINGS.guardMs },
    oracle_budget: { candidate_sets: ORACLE_SETTINGS.maxCandidateSets, solves: ORACLE_SETTINGS.maxSolves, nodes: ORACLE_SETTINGS.maxNodes, solve_nodes: ORACLE_SETTINGS.maxSolveNodes },
    oracle: true,
    validity: true,
    workers: o.workers,
    oracle_workers: o.oracleWorkers,
    keep_for_debug: o.keepForDebug
  };
}

// The options each stage's command runs with: the study's stage layout
// (run ID <run id>/<stage>), every picked wallet in each history stage, the
// pick's block by hash, one repetition, the study's limits (the commands'
// defaults), validity checks, and the oracle in the battery.
export function liveFireStageOptions(stage, o, pick, network) {
  const id = (s) => `${o.runId}/${s}`;
  const runId = id(stage);
  const loads = { treatment: o.treatment, treatmentPins: o.treatmentPins };
  const db = { expectNetwork: network, snapshot: pick.snapshot.hash, ...(o.bytes ? { bytes: o.bytes } : {}), ...(o.immutableDir ? { immutableDir: o.immutableDir } : {}), ...(o.immutableHost ? { immutableHost: o.immutableHost } : {}) };
  const wallet = pick.wallets.map((w) => w.stake_address);
  switch (stage) {
    case 'history-recent':
    case 'history-peak':
    case 'history-snapshot':
      return { runId, ...loads, ...db, wallet, window: stage.slice('history-'.length) };
    case 'battery-pools':
      return { runId, network, historyRun: id('history-recent') };
    case 'replay-recent':
    case 'replay-peak': {
      const w = stage.slice('replay-'.length);
      return { runId, ...loads, history: [historyDir(network, id(`history-${w}`))], plan: w, repsH1: String(LIVE_FIRE_REPS.repsH1), repsVariants: String(LIVE_FIRE_REPS.repsVariants), workers: String(o.workers), validity: true };
    }
    case 'battery':
      return { runId, ...loads, history: [historyDir(network, id('history-snapshot'))], pools: join(runDir(network, id('battery-pools')), 'battery-pools.json'), reps: String(LIVE_FIRE_REPS.reps), workers: String(o.workers), oracle: true, oracleWorkers: String(o.oracleWorkers), validity: true };
    default:
      throw new Error(`unknown stage ${stage}`);
  }
}

// A failed step's class of error: the code's refusals, the history reader's
// checks on a wallet's transactions (an intent, the reconstruction, the
// observed replay), the database, the connection, a validity check, or the
// error's own kind.
export function errorClass(e) {
  if (e instanceof Refusal) return 'refusal';
  if (e instanceof IntentCheck) return 'history-check';
  if (e && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && e.severity) return 'database';
  if (e && typeof e.code === 'string' && /^E[A-Z]+$/.test(e.code)) return 'connection';
  return (e && e.constructor && /^[A-Za-z]+$/.test(e.constructor.name) && e.constructor.name) || 'error';
}

// The three checks over the whole run, from the stages' results in memory;
// each true, false, or null when the stages that settle it did not all
// finish. intents: every spend of every history stage read into its event,
// and each history file completed (a history check failing makes it false).
// transactions: every transaction the replays and the battery built passed
// the validity checks (no validity failure). replayLimit: a replay reached
// its limit.
export function checksOf(results, failure) {
  const history = ['history-recent', 'history-peak', 'history-snapshot'];
  const built = ['replay-recent', 'replay-peak', 'battery'];
  const replays = ['replay-recent', 'replay-peak'];
  const totals = (s) => (results[s] && results[s].print && results[s].print.totals) || null;
  let intents = history.every((s) => results[s]) ? true : null;
  if (failure && history.includes(failure.stage) && failure.error instanceof IntentCheck) intents = false;
  const validity = built.map((s) => (totals(s) && totals(s).validity) || null);
  const transactions = validity.some((v) => v && v.failed > 0) ? false : validity.every((v) => v) ? true : null;
  const timeouts = replays.map((s) => (totals(s) && Number.isInteger(totals(s).timeouts) ? totals(s).timeouts : null));
  const replayLimit = timeouts.some((n) => n > 0) ? true : timeouts.every((n) => n !== null) ? false : null;
  return { every_intent_parsed: intents, every_built_transaction_passed_ledger_checks: transactions, replay_reached_limit: replayLimit };
}

const codeFacts = (manifest) => ({ manifest_sha256: sha256(manifest()), node: process.version });

// The gate's connection: meta, the network, and on mainnet the gate's
// live-fire path; closed at once.
async function gateConnection(o, pick) {
  const client = await connect({ expectNetwork: o.expectNetwork }, { gate: 'live-fire', liveFire: pick });
  await client.end();
}

// Runs a live-fire run, or with --cleanup deletes a kept run's output.
// commands: the stage commands by name (cmdHistory and the rest; the tests
// give stand-ins), or a function of the pick that returns them; gate: the gate's connection; argv: the command line as
// given, logged with wallet options redacted; now: the clock of the entries'
// dates; say: progress lines (step names and times only).
export async function runLiveFire(opts, { commands, gate = gateConnection, argv = [], manifest = formatHashList, now = () => new Date(), say = (s) => process.stderr.write(`${s}\n`) } = {}) {
  if (opts.cleanup !== undefined) return cleanupLiveFire(opts, { argv, now });
  const o = liveFireOptions(opts);
  const pick = readPick(o.expectNetwork, o.extractionRun);
  const network = o.expectNetwork;
  const command = redactCommand(['live-fire', ...argv]);
  const code = codeFacts(manifest);
  const t0 = performance.now();
  const ms = (since) => Math.round(performance.now() - since);

  const gateStart = appendEntry(network, 'query-start', { name: SIM_GATE, run_id: o.runId, command, code }, now());
  let gateError = null;
  try {
    await gate(o, pick);
  } catch (e) {
    gateError = e;
  }
  appendEntry(network, 'query', { name: SIM_GATE, start_seq: gateStart.seq, outcome: gateError ? 'failed' : 'succeeded', error: gateError ? sanitizeError(gateError) : null, run_ms: ms(t0) }, now());
  if (gateError) throw gateError instanceof Refusal ? gateError : new Error(`the live-fire gate failed: ${sanitizeError(gateError)}`);

  const stageCommands = typeof commands === 'function' ? commands(pick) : commands;
  const plan = planOf(o);
  const start = appendEntry(network, SIM_LIVE_FIRE_START, { run_id: o.runId, gate_seq: gateStart.seq, command, purpose: o.purpose, test_h: pick.testH, extraction_run: pick.runId, code, plan }, now());
  const dir = runDir(network, o.runId);
  const steps = [];
  const results = {};
  let failure = null;
  let ownError = null;
  try {
    // What an earlier attempt under this run ID left goes first.
    rmSync(dir, { recursive: true, force: true });
    for (const stage of LIVE_FIRE_STAGES) {
      const fn = stageCommands[STAGE_COMMAND[stage]];
      if (!fn) throw new Error(`no command for stage ${stage}`);
      const s0 = performance.now();
      say(`live-fire ${o.runId}: ${stage} started`);
      let r;
      try {
        r = await fn(liveFireStageOptions(stage, o, pick, network));
      } catch (e) {
        steps.push({ name: stage, ok: false, ms: ms(s0), error_class: errorClass(e) });
        failure = { stage, error: e };
        say(`live-fire ${o.runId}: ${stage} failed after ${(ms(s0) / 1000).toFixed(1)} s`);
        break;
      }
      results[stage] = r;
      const checkFailed = !!(r && r.failed);
      steps.push({ name: stage, ok: !checkFailed, ms: ms(s0), error_class: checkFailed ? 'check' : null });
      if (checkFailed && !failure) failure = { stage, error: null };
      say(`live-fire ${o.runId}: ${stage} finished in ${(ms(s0) / 1000).toFixed(1)} s${checkFailed ? ', with a failed check' : ''}`);
    }
  } catch (e) {
    ownError = e;
  }
  const failed = !!failure || !!ownError;
  let output;
  if (o.keepForDebug && failed && !ownError) output = KEPT;
  else if (!existsSync(dir)) output = 'none written';
  else {
    try {
      rmSync(dir, { recursive: true, force: true });
      output = `deleted ${now().toISOString()}`;
    } catch (e) {
      output = `deletion failed: ${sanitizeError(e)}`;
    }
  }
  const error = ownError ? sanitizeError(ownError) : failure ? (failure.error ? sanitizeError(`stage ${failure.stage}: ${failure.error.message}`) : `stage ${failure.stage}: a validity check failed`) : null;
  const checks = checksOf(results, failure);
  const end = appendEntry(network, SIM_LIVE_FIRE, {
    run_id: o.runId,
    start_seq: start.seq,
    command,
    purpose: o.purpose,
    test_h: pick.testH,
    extraction_run: pick.runId,
    code,
    outcome: failed ? 'failed' : 'succeeded',
    error,
    run_ms: ms(t0),
    steps,
    checks,
    wallet_level_output: output
  }, now());
  const print = { command: 'live-fire', runId: o.runId, network, outcome: end.outcome, error, steps: steps.map((s) => ({ name: s.name, ok: s.ok, seconds: s.ms / 1000, errorClass: s.error_class })), checks, walletLevelOutput: output, checkLog: { start: start.seq, end: end.seq } };
  return { print, failed, entry: end };
}

// Deletes a kept or interrupted run's output and logs a cleanup entry with
// the fields the extraction tool's cleanup writes, closing the run's
// unclosed start if it has one. Refused for a run the log does not hold, or
// one with nothing left to settle.
export function cleanupLiveFire(opts, { argv = [], now = () => new Date() } = {}) {
  checkKeys(opts, CLEANUP_OPTIONS);
  if (opts.cleanup !== true) throw new Refusal('refusing: --cleanup takes no value');
  const runId = runIdOf(opts.runId);
  const network = text(opts.network, '--network', 'the network whose check log holds the run');
  if (!/^[a-z]+$/.test(network)) throw new Refusal('refusing: --network <name> names a network');
  const { entries } = readLog(network);
  if (!entries.some((e) => e.type === SIM_LIVE_FIRE_START && e.run_id === runId)) throw new Refusal(`refusing: the ${network} check log holds no live-fire run ${runId} of the simulator`);
  const dir = runDir(network, runId);
  const open = unclosedStarts(entries).find((e) => e.run_id === runId) || null;
  if (!keptRun(entries, runId) && !open && !existsSync(dir)) throw new Refusal(`refusing: live-fire run ${runId} kept nothing and left nothing to clean up`);
  let outcome = 'succeeded';
  let error = null;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    outcome = 'failed';
    error = sanitizeError(e);
  }
  const entry = appendEntry(network, 'cleanup', {
    run_id: runId,
    start_seq: open ? open.seq : null,
    command: redactCommand(['live-fire', ...argv]),
    outcome,
    error,
    wallet_level_output: outcome === 'succeeded' ? `deleted ${now().toISOString()}` : `deletion failed: ${error}`,
    tables_dropped: 0
  }, now());
  return { print: { command: 'live-fire --cleanup', runId, network, outcome, walletLevelOutput: entry.wallet_level_output, checkLog: { entry: entry.seq } }, failed: outcome !== 'succeeded', entry };
}

// The command line's live-fire: the real commands, imported when it runs,
// the history command given the pick so that it takes the live-fire path.
export async function cmdLiveFire(opts, { argv = [] } = {}) {
  if (opts.cleanup !== undefined) return runLiveFire(opts, { argv });
  const [h, r, rc] = await Promise.all([import('../history/commands.mjs'), import('../history/reports.mjs'), import('../replay/commands.mjs')]);
  const commands = (pick) => ({ history: (o) => h.cmdHistory(o, { liveFire: pick }), 'battery-pools': r.cmdBatteryPools, replay: rc.cmdReplay, battery: rc.cmdBattery });
  return runLiveFire(opts, { commands, argv });
}
