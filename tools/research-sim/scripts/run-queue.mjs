#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// An unattended job queue: runs a list of commands one after another, each in
// its own process group with a wall-clock limit, and records what happened in
// a state file so that a stopped queue resumes where it left off. It runs
// commands and nothing else: it knows nothing of the simulator, whose own
// commands enforce their thread caps and limits. Node built-ins only. See the
// README section "Running jobs unattended".
//
//   node scripts/run-queue.mjs run <queue.json> [--continue-on-failure] [--rerun-interrupted] [--detach]
//   node scripts/run-queue.mjs status <queue.json>
//
// Exit codes: 0 every job done, 1 a job failed or timed out, 2 the queue is
// invalid or locked, 3 paused after a pauseAfter job, 4 an interrupted job
// awaits --rerun-interrupted.
//
// RUN_QUEUE_KILL_GRACE_MS (default 30000) sets how long a job's group has to
// leave after SIGTERM before SIGKILL; it exists for the tests.

import { spawn, execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync,
  openSync, closeSync, unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const EXIT = { DONE: 0, FAILED: 1, INVALID: 2, PAUSED: 3, INTERRUPTED: 4 };

const QUEUE_KEYS = ['name', 'out', 'env', 'envFile', 'jobs'];
const JOB_KEYS = ['id', 'cwd', 'argv', 'env', 'envFile', 'timeoutMinutes', 'idle', 'before', 'after', 'pauseAfter'];
const IDLE_KEYS = ['maxLoad1', 'forMinutes', 'maxWaitMinutes'];
const RESERVED_IDS = ['state.json', 'state.json.tmp', 'queue.lock', 'runner.log'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KILL_GRACE_MS = Number(process.env.RUN_QUEUE_KILL_GRACE_MS) || 30000;

// ---------------------------------------------------------------- env files

export function parseEnvFile(text, label = 'env file') {
  const env = {};
  const errors = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) { errors.push(`${label}:${i + 1}: not KEY=VALUE or export KEY=VALUE`); return; }
    env[m[1]] = m[2];
  });
  if (errors.length) throw new Error(errors.join('; '));
  return env;
}

// ---------------------------------------------------------------- validation

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isArgv = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s !== '');

function checkEnvObject(v, path, errors) {
  if (v === undefined) return;
  if (!isObj(v)) { errors.push(`${path}: must be an object of strings`); return; }
  for (const [k, val] of Object.entries(v)) {
    if (!NAME_RE.test(k)) errors.push(`${path}.${k}: not a valid variable name`);
    if (typeof val !== 'string') errors.push(`${path}.${k}: must be a string`);
  }
}

function checkEnvFile(v, base, path, errors) {
  if (v === undefined) return;
  if (typeof v !== 'string' || v === '') { errors.push(`${path}: must be a non-empty string`); return; }
  const p = resolve(base, v);
  try {
    if (!statSync(p).isFile()) throw new Error('not a file');
    parseEnvFile(readFileSync(p, 'utf8'), p);
  } catch (e) {
    errors.push(`${path}: ${e.code === 'ENOENT' ? `file does not exist: ${p}` : e.message}`);
  }
}

function checkPositive(v, path, errors, { allowZero = false } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v) || (allowZero ? v < 0 : v <= 0)) {
    errors.push(`${path}: must be a ${allowZero ? 'non-negative' : 'positive'} number`);
  }
}

// Returns { errors, queue } where queue is the normalized queue (paths made
// absolute against the queue file's directory) when errors is empty.
export function validateQueue(raw, queueFile) {
  const errors = [];
  const base = dirname(resolve(queueFile));
  if (!isObj(raw)) return { errors: ['queue: must be a JSON object'] };
  for (const k of Object.keys(raw)) if (!QUEUE_KEYS.includes(k)) errors.push(`queue.${k}: unknown key`);
  if (typeof raw.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(raw.name)) errors.push('queue.name: must be a non-empty string of letters, digits, space, dot, dash or underscore');
  if (typeof raw.out !== 'string' || raw.out === '') errors.push('queue.out: must be a non-empty string');
  checkEnvObject(raw.env, 'queue.env', errors);
  checkEnvFile(raw.envFile, base, 'queue.envFile', errors);
  if (!Array.isArray(raw.jobs) || raw.jobs.length === 0) {
    errors.push('queue.jobs: must be a non-empty array');
  } else {
    const seen = new Set();
    raw.jobs.forEach((job, i) => {
      const p = `jobs[${i}]`;
      if (!isObj(job)) { errors.push(`${p}: must be an object`); return; }
      for (const k of Object.keys(job)) if (!JOB_KEYS.includes(k)) errors.push(`${p}.${k}: unknown key`);
      if (typeof job.id !== 'string' || !ID_RE.test(job.id) || RESERVED_IDS.includes(job.id)) {
        errors.push(`${p}.id: must be a safe file name (letters, digits, dot, dash, underscore; not a name the queue uses)`);
      } else if (seen.has(job.id)) errors.push(`${p}.id: duplicate id ${job.id}`);
      else seen.add(job.id);
      if (typeof job.cwd !== 'string' || job.cwd === '') errors.push(`${p}.cwd: must be a non-empty string`);
      else {
        const c = resolve(base, job.cwd);
        if (!existsSync(c) || !statSync(c).isDirectory()) errors.push(`${p}.cwd: directory does not exist: ${c}`);
      }
      if (!isArgv(job.argv)) errors.push(`${p}.argv: must be a non-empty array of non-empty strings`);
      checkEnvObject(job.env, `${p}.env`, errors);
      checkEnvFile(job.envFile, base, `${p}.envFile`, errors);
      if (job.timeoutMinutes === undefined) errors.push(`${p}.timeoutMinutes: required`);
      else checkPositive(job.timeoutMinutes, `${p}.timeoutMinutes`, errors);
      if (job.idle !== undefined) {
        if (!isObj(job.idle)) errors.push(`${p}.idle: must be an object`);
        else {
          for (const k of Object.keys(job.idle)) if (!IDLE_KEYS.includes(k)) errors.push(`${p}.idle.${k}: unknown key`);
          for (const k of IDLE_KEYS) if (job.idle[k] === undefined) errors.push(`${p}.idle.${k}: required`);
          if (job.idle.maxLoad1 !== undefined) checkPositive(job.idle.maxLoad1, `${p}.idle.maxLoad1`, errors, { allowZero: true });
          if (job.idle.forMinutes !== undefined) checkPositive(job.idle.forMinutes, `${p}.idle.forMinutes`, errors, { allowZero: true });
          if (job.idle.maxWaitMinutes !== undefined) checkPositive(job.idle.maxWaitMinutes, `${p}.idle.maxWaitMinutes`, errors);
        }
      }
      for (const k of ['before', 'after']) if (job[k] !== undefined && !isArgv(job[k])) errors.push(`${p}.${k}: must be a non-empty array of non-empty strings`);
      if (job.pauseAfter !== undefined && typeof job.pauseAfter !== 'boolean') errors.push(`${p}.pauseAfter: must be true or false`);
    });
  }
  if (errors.length) return { errors };
  const queue = {
    name: raw.name,
    out: resolve(base, raw.out),
    env: raw.env || {},
    envFile: raw.envFile ? resolve(base, raw.envFile) : null,
    jobs: raw.jobs.map((j) => ({
      id: j.id,
      cwd: resolve(base, j.cwd),
      argv: j.argv,
      env: j.env || {},
      envFile: j.envFile ? resolve(base, j.envFile) : null,
      timeoutMinutes: j.timeoutMinutes,
      idle: j.idle || null,
      before: j.before || null,
      after: j.after || null,
      pauseAfter: j.pauseAfter === true,
    })),
  };
  return { errors, queue };
}

export function loadQueue(queueFile) {
  let raw;
  try { raw = JSON.parse(readFileSync(queueFile, 'utf8')); } catch (e) {
    return { errors: [`queue file ${queueFile}: ${e.message}`] };
  }
  return validateQueue(raw, queueFile);
}

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const log = (msg) => console.log(`${now()} ${msg}`);

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function signalGroup(pgid, sig) {
  try { process.kill(-pgid, sig); } catch { /* already gone */ }
}

function jobEnv(queue, job) {
  const merged = { ...process.env };
  const names = new Set();
  const layers = [
    queue.envFile ? parseEnvFile(readFileSync(queue.envFile, 'utf8'), queue.envFile) : {},
    queue.env,
    job.envFile ? parseEnvFile(readFileSync(job.envFile, 'utf8'), job.envFile) : {},
    job.env,
  ];
  for (const layer of layers) for (const [k, v] of Object.entries(layer)) { merged[k] = v; names.add(k); }
  return { env: merged, names: [...names].sort() };
}

function hostFacts() {
  let osName = null;
  try {
    osName = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? null;
  } catch { /* not Linux */ }
  const cpus = os.cpus();
  return {
    cpuModel: cpus[0]?.model ?? null,
    logicalCores: cpus.length,
    totalMemoryBytes: os.totalmem(),
    os: osName,
    osRelease: os.release(),
    platform: os.platform(),
    node: process.version,
  };
}

function gitFacts(cwds) {
  const out = {};
  for (const cwd of cwds) {
    const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      if (git('rev-parse', '--is-inside-work-tree').trim() !== 'true') continue;
      out[cwd] = {
        commit: git('rev-parse', 'HEAD').trim(),
        uncommittedChanges: git('status', '--porcelain', '--untracked-files=no').trim() !== '',
        untrackedFiles: git('status', '--porcelain', '--untracked-files=normal').split('\n').some((l) => l.startsWith('??')),
      };
    } catch { /* not a git work tree */ }
  }
  return out;
}

// ---------------------------------------------------------------- state

class State {
  constructor(file, data) { this.file = file; this.data = data; }
  save() {
    this.data.updated = now();
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
  job(id) { return this.data.jobs.find((j) => j.id === id); }
}

function loadState(queue) {
  const file = join(queue.out, 'state.json');
  let data = null;
  if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8'));
  if (data && data.queue !== queue.name) {
    throw new Error(`${file} belongs to the queue "${data.queue}", not "${queue.name}"`);
  }
  if (!data) data = { schema: 1, queue: queue.name, updated: null, runners: [], jobs: [] };
  for (const j of queue.jobs) {
    if (!data.jobs.some((s) => s.id === j.id)) data.jobs.push({ id: j.id, status: 'pending', attempts: [] });
  }
  return new State(file, data);
}

// ---------------------------------------------------------------- lock

function readLock(file) {
  try { return Number.parseInt(readFileSync(file, 'utf8').trim(), 10); } catch { return null; }
}

function takeLock(file) {
  for (let i = 0; i < 3; i++) {
    try {
      const fd = openSync(file, 'wx');
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = readLock(file);
      if (pid !== null && pid !== process.pid && pidAlive(pid)) return { ok: false, pid };
      log(`taking over the lock of process ${pid ?? 'unknown'}, which is gone`);
      try { unlinkSync(file); } catch { /* raced */ }
    }
  }
  return { ok: false, pid: readLock(file) };
}

function releaseLock(file) {
  if (readLock(file) === process.pid) { try { unlinkSync(file); } catch { /* gone */ } }
}

// ---------------------------------------------------------------- running a process

let activeProc = null;
let interruptSignal = null;

// Runs argv in its own process group. Resolves with { code, signal, pid,
// timedOut, interrupted, error }. When the limit passes or interrupt() is
// called, the group gets SIGTERM and, if anything is left after the grace
// period, SIGKILL; the result is not returned until the group is gone.
function runProcess(argv, { cwd, env, outFd, errFd, timeoutMs, onPid }) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', outFd, errFd] });
    } catch (e) { done({ code: null, signal: null, pid: null, error: e.message }); return; }
    const state = { timedOut: false, interrupted: false, termP: null, pid: null };
    child.once('error', (e) => { if (!child.pid) done({ code: null, signal: null, pid: null, error: e.message }); });
    if (!child.pid) return;
    state.pid = child.pid;
    if (onPid) onPid(child.pid);
    const terminate = () => {
      if (state.termP) return state.termP;
      state.termP = (async () => {
        signalGroup(child.pid, 'SIGTERM');
        const killAt = Date.now() + KILL_GRACE_MS;
        let killed = false;
        while (groupAlive(child.pid)) {
          if (!killed && Date.now() >= killAt) { signalGroup(child.pid, 'SIGKILL'); killed = true; }
          if (killed && Date.now() > killAt + 10000) break;
          await sleep(50);
        }
      })();
      return state.termP;
    };
    const timer = timeoutMs > 0 ? setTimeout(() => { state.timedOut = true; terminate(); }, timeoutMs) : null;
    activeProc = { interrupt() { state.interrupted = true; terminate(); } };
    child.once('exit', async (code, signal) => {
      if (timer) clearTimeout(timer);
      if (state.termP) await state.termP;
      activeProc = null;
      done({ code, signal, pid: child.pid, timedOut: state.timedOut, interrupted: state.interrupted });
    });
  });
}

function exitText(r) {
  if (r.error) return `could not start: ${r.error}`;
  if (r.signal) return `signal ${r.signal}`;
  return `exit ${r.code}`;
}

// ---------------------------------------------------------------- one job

async function runPhase(argv, ctx, attempt, files, timeoutMs) {
  const outFd = openSync(files.out, 'a');
  const errFd = files.err === files.out ? outFd : openSync(files.err, 'a');
  try {
    return await runProcess(argv, {
      cwd: ctx.job.cwd, env: ctx.env, outFd, errFd, timeoutMs,
      onPid: (pid) => { attempt.livePid = pid; ctx.state.save(); },
    });
  } finally {
    attempt.livePid = null;
    closeSync(outFd);
    if (errFd !== outFd) closeSync(errFd);
  }
}

async function waitIdle(job, jobState, attempt, state) {
  const { maxLoad1, forMinutes, maxWaitMinutes } = job.idle;
  const forMs = forMinutes * 60000;
  const maxMs = maxWaitMinutes * 60000;
  const poll = Math.min(5000, Math.max(10, Math.floor(maxMs / 10)));
  const t0 = Date.now();
  let lowSince = null;
  jobState.status = 'waiting-idle';
  state.save();
  for (;;) {
    if (interruptSignal) return 'interrupted';
    const load = os.loadavg()[0];
    const t = Date.now();
    if (load <= maxLoad1) { if (lowSince === null) lowSince = t; if (t - lowSince >= forMs) return 'idle'; } else lowSince = null;
    if (t - t0 >= maxMs) {
      attempt.note = `load average (1 minute) did not stay at or under ${maxLoad1} for ${forMinutes} minutes within ${maxWaitMinutes} minutes; last reading ${load.toFixed(2)}`;
      return 'timeout';
    }
    await sleep(poll);
  }
}

async function runJob(ctx, queue, job, jobState) {
  const { state } = ctx;
  const n = jobState.attempts.length + 1;
  let dirN = n;
  while (existsSync(join(queue.out, job.id, `attempt-${dirN}`))) dirN += 1;
  const dir = join(queue.out, job.id, `attempt-${dirN}`);
  mkdirSync(dir, { recursive: true });
  const { env, names } = jobEnv(queue, job);
  ctx.job = job; ctx.env = env;
  const attempt = {
    n, dir, start: now(), end: null, durationSeconds: null, exitCode: null, signal: null, pid: null, livePid: null,
    loadAtStart: null, before: null, after: null, argv: job.argv, envNamesFromQueue: names, note: null,
  };
  jobState.attempts.push(attempt);
  jobState.status = job.idle ? 'waiting-idle' : 'running';
  state.save();
  const t0 = Date.now();
  const limitMs = job.timeoutMinutes * 60000;
  let status = null;
  log(`${job.id}: attempt ${n} starting`);

  if (job.idle) {
    const r = await waitIdle(job, jobState, attempt, state);
    if (r === 'interrupted') status = 'interrupted';
    else if (r === 'timeout') status = 'failed';
  }
  if (status === null) {
    jobState.status = 'running';
    state.save();
    if (job.before) {
      const r = await runPhase(job.before, ctx, attempt, { out: join(dir, 'before.log'), err: join(dir, 'before.log') }, limitMs);
      attempt.before = { exitCode: r.code, signal: r.signal, error: r.error ?? null };
      if (r.interrupted) status = 'interrupted';
      else if (r.code !== 0) { status = 'failed'; attempt.note = `before failed (${exitText(r)}); the job did not run`; }
    }
  }
  if (status === null && interruptSignal) status = 'interrupted';
  if (status === null) {
    attempt.loadAtStart = os.loadavg()[0];
    const r = await runPhase(job.argv, ctx, attempt, { out: join(dir, 'stdout.log'), err: join(dir, 'stderr.log') }, limitMs);
    attempt.pid = r.pid;
    attempt.exitCode = r.code;
    attempt.signal = r.signal;
    if (r.error) attempt.note = `could not start: ${r.error}`;
    if (r.interrupted) status = 'interrupted';
    else if (r.timedOut) { status = 'timeout'; attempt.note = `ended by the ${job.timeoutMinutes} minute limit`; }
    else status = !r.error && r.code === 0 ? 'done' : 'failed';
  }
  if (status !== 'interrupted' && job.after) {
    const r = await runPhase(job.after, ctx, attempt, { out: join(dir, 'after.log'), err: join(dir, 'after.log') }, limitMs);
    attempt.after = { exitCode: r.code, signal: r.signal, error: r.error ?? null };
    if (r.interrupted) status = 'interrupted';
  }
  attempt.end = now();
  attempt.durationSeconds = Math.round((Date.now() - t0) / 100) / 10;
  jobState.status = status;
  state.save();
  log(`${job.id}: ${status} after ${attempt.durationSeconds} s${attempt.exitCode !== null ? ` (exit ${attempt.exitCode})` : ''}`);
  return status;
}

// ---------------------------------------------------------------- run command

function parseArgs(args) {
  const flags = { continueOnFailure: false, rerunInterrupted: false, detach: false };
  const pos = [];
  for (const a of args) {
    if (a === '--continue-on-failure') flags.continueOnFailure = true;
    else if (a === '--rerun-interrupted') flags.rerunInterrupted = true;
    else if (a === '--detach') flags.detach = true;
    else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else pos.push(a);
  }
  return { flags, pos };
}

function refuseInvalid(errors) {
  console.error('The queue is invalid; nothing was run:');
  for (const e of errors) console.error(`  ${e}`);
  return EXIT.INVALID;
}

async function commandRun(queueFile, flags) {
  const { errors, queue } = loadQueue(queueFile);
  if (errors.length) return refuseInvalid(errors);
  mkdirSync(queue.out, { recursive: true });
  const lockFile = join(queue.out, 'queue.lock');

  if (flags.detach) {
    const lockPid = readLock(lockFile);
    if (lockPid !== null && pidAlive(lockPid)) {
      console.error(`Another runner holds ${lockFile} (process ${lockPid}).`);
      return EXIT.INVALID;
    }
    const fd = openSync(join(queue.out, 'runner.log'), 'a');
    const args = [fileURLToPath(import.meta.url), 'run', resolve(queueFile)];
    if (flags.continueOnFailure) args.push('--continue-on-failure');
    if (flags.rerunInterrupted) args.push('--rerun-interrupted');
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    closeSync(fd);
    console.log(child.pid);
    return EXIT.DONE;
  }

  const lock = takeLock(lockFile);
  if (!lock.ok) {
    console.error(`Another runner holds ${lockFile} (process ${lock.pid}).`);
    return EXIT.INVALID;
  }
  let code;
  try {
    code = await runQueue(queue, flags);
  } finally {
    releaseLock(lockFile);
  }
  return code;
}

async function runQueue(queue, flags) {
  let state;
  try { state = loadState(queue); } catch (e) { console.error(e.message); return EXIT.INVALID; }

  // A job recorded as running or waiting belongs to a runner that is gone.
  for (const js of state.data.jobs) {
    if (js.status !== 'running' && js.status !== 'waiting-idle') continue;
    const att = js.attempts[js.attempts.length - 1];
    if (att?.livePid && groupAlive(att.livePid)) {
      console.error(`Job ${js.id} is still running (process group ${att.livePid}) although no runner holds the lock. Stop it, or wait for it, and run again.`);
      return EXIT.INVALID;
    }
    js.status = 'interrupted';
    if (att) { att.end = att.end ?? now(); att.note = att.note ?? 'the runner stopped while the job was recorded as running'; att.livePid = null; }
    log(`${js.id}: was recorded as running and its process is gone; marked interrupted`);
  }

  const cwds = [...new Set(queue.jobs.map((j) => j.cwd))];
  state.data.runners.push({ pid: process.pid, start: now(), host: hostFacts(), git: gitFacts(cwds), args: { continueOnFailure: flags.continueOnFailure, rerunInterrupted: flags.rerunInterrupted } });
  state.save();

  const interrupted = state.data.jobs.filter((j) => j.status === 'interrupted' && queue.jobs.some((q) => q.id === j.id));
  if (interrupted.length && !flags.rerunInterrupted) {
    console.error(`Interrupted: ${interrupted.map((j) => j.id).join(', ')}. A rerun can meet a half-written run directory; check it, then run again with --rerun-interrupted.`);
    return EXIT.INTERRUPTED;
  }

  const onSignal = (sig) => {
    if (interruptSignal) return;
    interruptSignal = sig;
    log(`received ${sig}; stopping the running job`);
    if (activeProc) activeProc.interrupt();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const ctx = { state };
  let anyFailed = false;
  let anyInterrupted = false;
  let paused = false;
  for (const job of queue.jobs) {
    const js = state.job(job.id);
    if (js.status === 'done') { log(`${job.id}: done already; skipped`); continue; }
    if (interruptSignal) break;
    const status = await runJob(ctx, queue, job, js);
    if (status === 'interrupted') { anyInterrupted = true; break; }
    if (status !== 'done') {
      anyFailed = true;
      if (!flags.continueOnFailure) break;
    } else if (job.pauseAfter) {
      paused = queue.jobs.some((q) => state.job(q.id).status !== 'done');
      if (paused) { log(`${job.id}: pauseAfter; the queue stops here`); break; }
    }
  }
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  state.save();

  if (anyInterrupted) return EXIT.INTERRUPTED;
  if (interruptSignal) return EXIT.FAILED;
  if (paused) return EXIT.PAUSED;
  const allDone = queue.jobs.every((q) => state.job(q.id).status === 'done');
  if (allDone) { log('every job is done'); return EXIT.DONE; }
  return EXIT.FAILED;
}

// ---------------------------------------------------------------- status command

function commandStatus(queueFile) {
  const { errors, queue } = loadQueue(queueFile);
  if (errors.length) return refuseInvalid(errors);
  let data = null;
  try { data = JSON.parse(readFileSync(join(queue.out, 'state.json'), 'utf8')); } catch { /* none yet */ }
  console.log(`queue ${queue.name}`);
  for (const job of queue.jobs) {
    const js = data?.jobs?.find((j) => j.id === job.id);
    const last = js?.attempts?.[js.attempts.length - 1];
    const exit = last ? (last.signal ? `signal ${last.signal}` : last.exitCode !== null ? `exit ${last.exitCode}` : '-') : '-';
    const dur = last?.durationSeconds != null ? `${last.durationSeconds} s` : '-';
    console.log(`${job.id}  ${js?.status ?? 'pending'}  attempts ${js?.attempts?.length ?? 0}  last ${dur}  ${exit}`);
  }
  const pid = readLock(join(queue.out, 'queue.lock'));
  if (pid === null) console.log('runner: none');
  else if (pidAlive(pid)) console.log(`runner: running (process ${pid})`);
  else console.log(`runner: none (stale lock of process ${pid})`);
  return EXIT.DONE;
}

// ---------------------------------------------------------------- main

const USAGE = `usage:
  node scripts/run-queue.mjs run <queue.json> [--continue-on-failure] [--rerun-interrupted] [--detach]
  node scripts/run-queue.mjs status <queue.json>
exit codes: 0 every job done, 1 a job failed or timed out, 2 invalid or locked queue,
            3 paused after a pauseAfter job, 4 an interrupted job awaits --rerun-interrupted`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const parsed = parseArgs(rest);
  if (parsed.error || parsed.pos.length !== 1 || !['run', 'status'].includes(cmd)) {
    console.error(parsed.error ? `${parsed.error}\n${USAGE}` : USAGE);
    process.exit(EXIT.INVALID);
  }
  try {
    const code = cmd === 'run' ? await commandRun(parsed.pos[0], parsed.flags) : commandStatus(parsed.pos[0]);
    process.exit(code);
  } catch (e) {
    console.error(e.stack || e.message);
    process.exit(EXIT.INVALID);
  }
}
