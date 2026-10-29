// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The study command: the study's run as one chain of stages under one run
// id, for a named plan, resumable.
//
//   study --plan synthetic | preprod | corpus --run-id <id> --treatment <dir>
//         [--treatment-pins <file>] [options]
//
// Plans and their stages, in order:
//   synthetic  replay-recent, replay-peak, battery, over the synthetic shapes
//              (--shapes); no database.
//   preprod    history-recent, history-peak, history-snapshot, census,
//              near-cap, collateral, fidelity, battery-pools, replay-recent,
//              replay-peak, battery, on a test network (--expect-network):
//              the wallets from --wallets or --wallet, or --from-study random
//              or all; the snapshot from --snapshot (a block id or hash) or
//              --extraction-run, never the moving tip; the windows from
//              --extraction-run or the test-network defaults; --days for the
//              collateral measurement.
//   corpus     the same stages over every sampled wallet (--from-study all),
//              with --analysis-freeze-tx, since every sampled wallet's split
//              is read; the snapshot and the windows are the extraction
//              run's: on mainnet the final freeze's study run, through the
//              gate (history/db.mjs), elsewhere --extraction-run.
// The database stages come first, so the database is needed only at the
// start. The fidelity check reads the recent and peak history files of the
// exploration split (and those that carry no split, as on a test network);
// battery-pools reads history-recent's files; the replays read their window's
// files; the battery reads history-snapshot's files and battery-pools' pools.
// Repetitions (--reps-h1, --reps-variants, --reps), workers (--workers,
// --oracle-workers), limits (--limit-ms, --answer-limit-ms, --oracle-limit-ms),
// the oracle (--oracle, --oracle-settings) and --validity pass through to the
// replay and battery stages; --analysis-freeze-tx to history, replay and
// battery. An option the plan does not use is refused.
//
// Layout, under the private root (history/paths.mjs):
//   <network>/<id>/study.json   the header: plan, network, stages, options,
//                               the input files' SHA-256 (treatment pins,
//                               wallets, extraction run), the code manifest
//                               (`hash`) and its SHA-256, Node
//   <network>/<id>/log.jsonl    the study's log, appended: each invocation's
//                               start or resume, each stage's start and its
//                               end (with the stage's printed totals) or
//                               error, skipped stages, the end
//   <network>/<id>/<stage>/     the stage's own run directory, written by its
//                               command under run id <id>/<stage>
//   <network>/<id>/lock         the PID of the invocation running it
// The network is --expect-network, or `synthetic`.
//
// Resume: running the same plan and run id again resumes it. The header must
// equal the first start's in plan, network, stages, options (paths made
// absolute), input files and code manifest, or the run is refused. A stage
// whose end entry is in the log is skipped. Any other stage is rerun from its
// start: its directory is removed first, so it is written as by an
// uninterrupted run (the stages' records are deterministic but for the
// unseeded selectors and the wall-clock limits). A live lock refuses a second
// invocation; a lock whose process is gone (a kill) is replaced.
//
// A stage that throws stops the run, with its error in the log. A stage that
// finishes with a failed check (a validity failure) has its end entry, marked
// failed, and the run goes on; the command then exits non-zero.

import { existsSync, readFileSync, rmSync, openSync, writeSync, closeSync, readSync, readdirSync, statSync, chmodSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { runDir, historyDir, ensureDir, writeJson, toJson } from '../history/paths.mjs';
import { formatHashList } from '../hash.mjs';
import { DEFAULT_PINS } from '../treatment/bridge.mjs';
import { scrubText } from '../out/records.mjs';
import { Refusal } from '../history/db.mjs';

const DB_STAGES = Object.freeze(['history-recent', 'history-peak', 'history-snapshot', 'census', 'near-cap', 'collateral']);
const OFFLINE_STAGES = Object.freeze(['fidelity', 'battery-pools', 'replay-recent', 'replay-peak', 'battery']);
export const PLANS = Object.freeze({
  synthetic: Object.freeze(['replay-recent', 'replay-peak', 'battery']),
  preprod: Object.freeze([...DB_STAGES, ...OFFLINE_STAGES]),
  corpus: Object.freeze([...DB_STAGES, ...OFFLINE_STAGES])
});

// The command each stage runs.
export const STAGE_COMMAND = Object.freeze({
  'history-recent': 'history',
  'history-peak': 'history',
  'history-snapshot': 'history',
  census: 'census',
  'near-cap': 'near-cap',
  collateral: 'collateral',
  fidelity: 'fidelity',
  'battery-pools': 'battery-pools',
  'replay-recent': 'replay',
  'replay-peak': 'replay',
  battery: 'battery'
});

// Options by use. Paths are made absolute before they are recorded.
const COMMON = ['plan', 'runId', 'treatment', 'treatmentPins', 'workers', 'reps', 'repsH1', 'repsVariants', 'limitMs', 'answerLimitMs', 'oracle', 'oracleWorkers', 'oracleLimitMs', 'oracleSettings', 'validity'];
const DATABASE = ['expectNetwork', 'snapshot', 'extractionRun', 'wallets', 'wallet', 'fromStudy', 'analysisFreezeTx', 'bytes', 'immutableDir', 'immutableHost', 'set'];
const ALLOWED = Object.freeze({
  synthetic: new Set([...COMMON, 'shapes']),
  preprod: new Set([...COMMON, ...DATABASE, 'days']),
  corpus: new Set([...COMMON, ...DATABASE])
});
const PATHS = ['treatment', 'treatmentPins', 'wallets', 'extractionRun', 'immutableDir'];
const RUN_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const HEX64 = /^[0-9a-f]{64}$/;
const flag = (k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

// The study's options, checked against its plan and normalized (paths
// absolute), before anything is written. Throws a Refusal.
export function studyOptions(opts) {
  const plan = opts.plan;
  if (!(plan in PLANS)) throw new Refusal('refusing: --plan synthetic | preprod | corpus');
  if (typeof opts.runId !== 'string' || !RUN_ID.test(opts.runId)) throw new Refusal('refusing: --run-id <id> names the study run (letters, digits, dot, dash, underscore)');
  const o = Object.fromEntries(Object.entries(opts).filter(([k]) => k !== '_'));
  if (opts._ && opts._.length) throw new Refusal(`refusing: unexpected argument ${opts._[0]}`);
  const unused = Object.keys(o).filter((k) => !ALLOWED[plan].has(k));
  if (unused.length) throw new Refusal(`refusing: the ${plan} plan does not use ${unused.map(flag).join(', ')}`);
  if (!o.treatment || o.treatment === true) throw new Refusal('refusing: --treatment <dir> names the treatment directory');
  for (const k of PATHS) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== 'string') throw new Refusal(`refusing: ${flag(k)} takes one path`);
    o[k] = resolve(o[k]);
  }
  if (o.analysisFreezeTx !== undefined && !HEX64.test(String(o.analysisFreezeTx))) throw new Refusal('refusing: --analysis-freeze-tx is a transaction hash, 64 lowercase hex digits');
  if (plan === 'synthetic') {
    if (!o.shapes || o.shapes === true) throw new Refusal('refusing: the synthetic plan needs --shapes <names|all>');
    return o;
  }
  if (!o.expectNetwork || o.expectNetwork === true || !/^[a-z]+$/.test(o.expectNetwork)) throw new Refusal(`refusing: the ${plan} plan needs --expect-network <name>, the database's network`);
  if (o.snapshot !== undefined && o.extractionRun !== undefined) throw new Refusal('refusing: give --snapshot or --extraction-run, not both');
  if (plan === 'preprod') {
    if (o.expectNetwork === 'mainnet') throw new Refusal('refusing: the preprod plan runs on a test network; the study\'s mainnet run is the corpus plan');
    const sources = ['wallets', 'wallet', 'fromStudy'].filter((k) => o[k] !== undefined);
    if (sources.length !== 1) throw new Refusal('refusing: name the wallets once: --wallets <file>, --wallet <id or stake address>..., or --from-study random | all');
    if (o.fromStudy !== undefined && !['random', 'all'].includes(o.fromStudy)) throw new Refusal('refusing: --from-study random | all');
    if (o.extractionRun === undefined && (o.snapshot === undefined || o.snapshot === true || o.snapshot === 'tip')) throw new Refusal('refusing: the preprod plan reads every stage at one block: give --snapshot <block id or hash> or --extraction-run <params.json>, not the moving tip');
    return o;
  }
  // corpus
  if (o.wallets !== undefined || o.wallet !== undefined) throw new Refusal('refusing: the corpus plan reads every sampled wallet (--from-study all); --wallets and --wallet are for the preprod plan');
  if (o.fromStudy !== undefined && o.fromStudy !== 'all') throw new Refusal('refusing: the corpus plan reads every sampled wallet; --from-study is all');
  o.fromStudy = 'all';
  if (o.snapshot !== undefined) throw new Refusal('refusing: the corpus plan\'s snapshot is the extraction run\'s; give no --snapshot');
  if (o.analysisFreezeTx === undefined) throw new Refusal('refusing: the corpus plan reads the confirmation split; give --analysis-freeze-tx <hash>, the transaction whose record freezes the analysis scripts');
  if (o.expectNetwork !== 'mainnet' && o.extractionRun === undefined) throw new Refusal('refusing: on a test network the corpus plan needs --extraction-run <params.json>; on mainnet the gate reads the final freeze\'s study run');
  return o;
}

// The SHA-256 of each input file the options name, so that a file changed
// between a start and a resume is seen.
function inputDigests(o) {
  const d = { treatmentPins: sha256(readFileSync(o.treatmentPins || DEFAULT_PINS)) };
  if (o.wallets) d.wallets = sha256(readFileSync(o.wallets));
  if (o.extractionRun) d.extractionRun = sha256(readFileSync(o.extractionRun));
  return d;
}

export function studyHeader(o, { manifest = formatHashList } = {}) {
  const network = o.plan === 'synthetic' ? 'synthetic' : o.expectNetwork;
  const m = manifest();
  return { command: 'study', plan: o.plan, network, runId: o.runId, stages: [...PLANS[o.plan]], options: o, inputs: inputDigests(o), manifestSha256: sha256(m), node: process.version, manifest: m };
}

// What differs between a recorded header and this invocation's, by name.
export function headerDifferences(was, now) {
  const out = [];
  for (const k of ['plan', 'network', 'stages']) if (canonical(was[k]) !== canonical(now[k])) out.push(k);
  const keys = [...new Set([...Object.keys(was.options || {}), ...Object.keys(now.options || {})])].sort();
  for (const k of keys) if (canonical((was.options || {})[k]) !== canonical(now.options[k])) out.push(flag(k));
  for (const k of [...new Set([...Object.keys(was.inputs || {}), ...Object.keys(now.inputs)])].sort()) if ((was.inputs || {})[k] !== now.inputs[k]) out.push(`the ${k} file`);
  if (was.manifestSha256 !== now.manifestSha256) out.push('the code manifest');
  return out;
}

// The log: one JSON object per line, appended with one write each.
class StudyLog {
  constructor(path) {
    this.path = path;
    if (existsSync(path)) {
      const t = readFileSync(path, 'utf8');
      if (t.length && !t.endsWith('\n')) this.append('\n');
    }
  }
  append(text) {
    const fd = openSync(this.path, 'a', 0o600);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    chmodSync(this.path, 0o600);
  }
  note(entry) {
    this.append(toJson({ at: new Date().toISOString(), ...entry }) + '\n');
  }
  // Entries that parse; a line cut by a kill is passed over.
  static entries(path) {
    if (!existsSync(path)) return [];
    const out = [];
    for (const l of readFileSync(path, 'utf8').split('\n')) {
      if (!l) continue;
      try {
        out.push(JSON.parse(l));
      } catch {
        // a torn line: not an entry
      }
    }
    return out;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function takeLock(dir) {
  const path = join(dir, 'lock');
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) throw new Refusal(`refusing: process ${pid} is running this study run`);
      unlinkSync(path);
    }
  }
  throw new Refusal('refusing: the study run\'s lock could not be taken');
}

// The first line of a history file, its header.
function headerOf(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1 << 16);
    let text = '';
    let pos = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      const chunk = buf.subarray(0, n).toString('latin1');
      const i = chunk.indexOf('\n');
      if (i >= 0) {
        text += chunk.slice(0, i);
        break;
      }
      text += chunk;
    }
    return JSON.parse(Buffer.from(text, 'latin1').toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

// The history files of the given directories that the fidelity check reads:
// the exploration split's, and those carrying no split.
export function fidelityFiles(dirs) {
  const out = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).sort()) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(d, f);
      if (!statSync(p).isFile()) continue;
      const split = headerOf(p).split ?? null;
      if (split === null || split === 'exploration') out.push(p);
    }
  }
  return out;
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

// The options a stage's command runs with.
export function stageOptions(stage, o, network) {
  const id = (s) => `${o.runId}/${s}`;
  const pins = o.treatmentPins || DEFAULT_PINS;
  const db = pick(o, ['expectNetwork', 'snapshot', 'extractionRun', 'bytes', 'immutableDir', 'immutableHost']);
  const wallets = o.fromStudy !== undefined ? null : pick(o, ['wallets', 'wallet']);
  const runId = id(stage);
  const replayOpts = pick(o, ['repsH1', 'repsVariants', 'workers', 'limitMs', 'validity']);
  const batteryOpts = pick(o, ['reps', 'workers', 'answerLimitMs', 'oracle', 'oracleWorkers', 'oracleLimitMs', 'oracleSettings', 'validity']);
  const freeze = pick(o, ['analysisFreezeTx']);
  switch (stage) {
    case 'history-recent':
    case 'history-peak':
    case 'history-snapshot':
      return { runId, treatment: o.treatment, treatmentPins: pins, ...db, ...pick(o, ['set']), ...(wallets || { fromStudy: o.fromStudy }), ...freeze, window: stage.slice('history-'.length) };
    case 'census':
      return { runId, treatment: o.treatment, treatmentPins: pins, ...db, ...pick(o, ['set']), ...(wallets || { fromStudy: true }) };
    case 'near-cap':
      return { runId, ...db, ...(wallets || { fromStudy: true }) };
    case 'collateral':
      return { runId, ...db, ...pick(o, ['days']) };
    case 'fidelity':
      return { runId, treatment: o.treatment, treatmentPins: pins, history: fidelityFiles(['recent', 'peak'].map((w) => historyDir(network, id(`history-${w}`)))) };
    case 'battery-pools':
      return { runId, network, historyRun: id('history-recent') };
    case 'replay-recent':
    case 'replay-peak': {
      const w = stage.slice('replay-'.length);
      const src = o.plan === 'synthetic' ? { shapes: o.shapes } : { history: [historyDir(network, id(`history-${w}`))] };
      return { runId, treatment: o.treatment, treatmentPins: pins, ...src, plan: w, ...replayOpts, ...freeze };
    }
    case 'battery': {
      const src = o.plan === 'synthetic' ? { shapes: o.shapes } : { history: [historyDir(network, id('history-snapshot'))], pools: join(runDir(network, id('battery-pools')), 'battery-pools.json') };
      return { runId, treatment: o.treatment, treatmentPins: pins, ...src, ...batteryOpts, ...freeze };
    }
    default:
      throw new Error(`unknown stage ${stage}`);
  }
}

// Runs a study. commands: the command functions by name (cmdHistory and the
// rest; the tests give stand-ins); manifest: the code manifest's text;
// say: progress lines.
export async function runStudy(opts, { commands, manifest = formatHashList, say = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const o = studyOptions(opts);
  const header = studyHeader(o, { manifest });
  const dir = runDir(header.network, o.runId);
  const headerPath = join(dir, 'study.json');
  const resuming = existsSync(headerPath);
  if (resuming) {
    const was = JSON.parse(readFileSync(headerPath, 'utf8'));
    const diff = headerDifferences(was, header);
    if (diff.length) throw new Refusal(`refusing: study run ${o.runId} differs from its first start in ${diff.join(', ')}; resume it with the same options, input files and code, or start a new run id`);
  }
  ensureDir(dir);
  const unlock = takeLock(dir);
  const t0 = performance.now();
  try {
    if (!resuming) writeJson(headerPath, header);
    const logPath = join(dir, 'log.jsonl');
    const done = new Map();
    for (const e of StudyLog.entries(logPath)) if (e.event === 'stage-end') done.set(e.stage, e);
    const log = new StudyLog(logPath);
    log.note({ event: resuming ? 'resume' : 'start', plan: o.plan, stages: header.stages, finished: [...done.keys()], manifestSha256: header.manifestSha256 });
    const result = { runId: o.runId, plan: o.plan, network: header.network, dir, stages: [] };
    let failed = false;
    for (const stage of header.stages) {
      if (done.has(stage)) {
        const e = done.get(stage);
        log.note({ event: 'stage-skipped', stage });
        say(`study ${o.runId}: ${stage} finished earlier, skipped`);
        result.stages.push({ stage, ran: false, seconds: e.seconds, failed: !!e.failed, print: e.print ?? null });
        failed = failed || !!e.failed;
        continue;
      }
      const name = STAGE_COMMAND[stage];
      const fn = commands[name];
      if (!fn) throw new Error(`no command ${name} for stage ${stage}`);
      // A stage reruns from its start: what an interrupted invocation left
      // in its directory goes first.
      rmSync(runDir(header.network, `${o.runId}/${stage}`), { recursive: true, force: true });
      const stageOpts = stageOptions(stage, o, header.network);
      log.note({ event: 'stage-start', stage, command: name });
      say(`study ${o.runId}: ${stage} started`);
      const s0 = performance.now();
      let r;
      try {
        r = await fn(stageOpts);
      } catch (e) {
        const seconds = (performance.now() - s0) / 1000;
        log.note({ event: 'stage-error', stage, seconds, error: scrubText(e && e.message ? e.message : String(e)) });
        e.message = `stage ${stage}: ${e.message}`;
        throw e;
      }
      const seconds = (performance.now() - s0) / 1000;
      const print = r && r.print !== undefined ? r.print : null;
      const stageFailed = !!(r && r.failed);
      failed = failed || stageFailed;
      log.note({ event: 'stage-end', stage, seconds, failed: stageFailed, print });
      say(`study ${o.runId}: ${stage} finished in ${seconds.toFixed(1)} s${stageFailed ? ', with a failed check' : ''}`);
      result.stages.push({ stage, ran: true, seconds, failed: stageFailed, print });
    }
    const seconds = (performance.now() - t0) / 1000;
    log.note({ event: 'end', seconds, failed });
    return { ...result, seconds, failed, print: { command: 'study', ...result, seconds, failed } };
  } finally {
    unlock();
  }
}

// The command line's study: the real commands, imported when it runs.
export async function cmdStudy(opts) {
  const [h, r, rc, f] = await Promise.all([import('../history/commands.mjs'), import('../history/reports.mjs'), import('../replay/commands.mjs'), import('../fidelity/fidelity.mjs')]);
  const commands = { history: h.cmdHistory, census: r.cmdCensus, 'near-cap': r.cmdNearCap, collateral: r.cmdCollateral, 'battery-pools': r.cmdBatteryPools, fidelity: f.cmdFidelity, replay: rc.cmdReplay, battery: rc.cmdBattery };
  return runStudy(opts, { commands });
}
