// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The worker processes, their memory and the watchdogs. No time limit
// decides any result: every replay and every method answer runs to
// completion, and its time is kept as timing context (out/records.mjs).
// CSL's calls are synchronous, so work that hangs can be stopped only by
// killing the process it runs in. A watchdog far above any expected time does
// that: the work is set aside, nothing of it is recorded, and it runs again
// at once in a fresh worker with its watchdog doubled, as often as it takes
// to complete, so a stop changes when the work ends and never what it
// records.
//
//   replay   24 hours per (wallet, arm, selector, repetition) replay; the
//            replay runs again from its start
//
// Workers are child processes (child_process.fork, with an IPC channel and
// the V8 serializer, so messages carry what structured clone carries),
// speaking replay/worker.mjs's messages. Each one's memory can be measured,
// and the kernel's out-of-memory killer stops one worker, not the run.
//
// Memory. The pool has a budget (`memoryBudget`, bytes; by default 80% of
// the memory available when it starts, /proc/meminfo MemAvailable). Each job
// has an estimate (jobEstimate: a base, a UTxO term and an event term, from
// job.memory, which runReplays sets from the wallet), raised
// for the job's wallet when a job of it was measured above it. After each
// job the pool reads the worker's resident size (VmRSS) and its peak during
// the job (VmHWM, reset before each job) from /proc/<pid>/status, each with
// its helper processes' added (processMemory), and the worker reports CSL's
// WebAssembly memory and V8's heap.
//   admission  a job starts when a worker is free (an idle one, or a new one
//              in a free place: at most `size` worker processes exist at
//              once, counting those stopped and not yet exited) and the
//              running jobs' charges, the idle workers' resident sizes and
//              its own charge fit the budget; its charge is the larger of
//              its estimate and the resident size of the idle worker it
//              takes. Idle workers are stopped, largest first, when that
//              makes the job fit. Jobs are taken in the order they asked; a
//              job held for memory may be passed by later jobs that fit, at
//              most `size` times, and then nothing passes it until it
//              starts, so it cannot starve. A rerun after a worker died goes
//              first and is never passed. When nothing runs and a job alone
//              exceeds the budget, it runs alone, and its note says the
//              machine is short of memory.
//   recycling  after a job, a worker is replaced when its resident size
//              passes the budget divided by `size`, or its CSL memory half
//              that memory's ceiling (by size); else after maxJobs jobs. A
//              worker that recorded machine errors is replaced after its
//              job.
//
// Errors the machine can cause (kit/machine.mjs) make the job run again once
// in a fresh worker that records machine errors: only an error that happens
// again there is recorded, as the method's outcome where the code records
// one. A worker that exits or is killed during a job (an exit, a signal, the
// out-of-memory killer) makes the job run again in a fresh worker that
// records machine errors, its estimate doubled; when that worker dies too,
// the job runs once more alone, with the whole budget; a third death at the
// same point of the job fails it, naming the job, and the run stops with it.
// An error that is not the machine's fails the job at once.
//
// Nothing here changes a record: admission, recycling and reruns change only
// when and in which worker a job runs. The worker count and the budget are
// recorded with the machine (out/host.mjs, out/stage.mjs). `stats` counts
// what happened, for the run's log, printout and machine record only:
// workers started, recycled after maxJobs jobs and by size, watchdog stops,
// machine reruns (out-of-memory reruns among them), jobs that waited for
// memory, jobs started ahead of one held for memory, jobs that ran alone,
// and estimates raised.

import { fork } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import os from 'node:os';

export const REPLAY_WATCHDOG_MS = 24 * 3600 * 1000;

const KiB = 1024;
const MiB = 1024 * KiB;

// A worker count as a command line gives it: a positive whole number, or
// `dflt` when absent.
export function workerCount(v, flag, dflt = 1) {
  if (v === undefined) return dflt;
  const n = typeof v === 'string' && /^[1-9]\d*$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${flag} takes a positive whole number`);
  return n;
}

// The memory the kernel says can be used without swapping (MemAvailable),
// in bytes; os.freemem() where /proc/meminfo gives none.
export function memoryAvailable(meminfo = readText('/proc/meminfo')) {
  const m = meminfo && /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo);
  return m ? Number(m[1]) * KiB : os.freemem();
}

// The budget when none is given: 80% of the memory available now.
export const DEFAULT_BUDGET_SHARE = 0.8;
export const defaultMemoryBudget = () => Math.floor(DEFAULT_BUDGET_SHARE * memoryAvailable());

// The per-job estimate, in MiB and KiB: a worker's peak resident size while
// it runs a replay job of a wallet with U UTxOs and E events, on CSL
// 17.0.0's WebAssembly build, 600 MiB + 29 KiB x U + 36 KiB x E. U is the
// start's UTxOs plus those the window's deposits add (walletMemory), E the
// window's events. Fitted as the upper envelope with the least total excess
// over the heaviest job measured on each of five wallets (README, "Worker
// memory"): M2 (U 3,010, E 18; evo-lf, 596 MiB), H5E01 (5,015, 100; evo-lf,
// at least 736 MiB when stopped), H20E01 (20,015, 100; evo-lf, at least
// 1,066 MiB when stopped), H20E05 (20,079, 500; cjs-rrri, 1,171 MiB) and
// H3E6 (3,962, 6,000; evo-lf, at least 910 MiB when stopped). An idle
// worker holds about 204 MiB.
export const MEMORY_ESTIMATE = Object.freeze({ baseMiB: 600, utxoKiB: 29, eventKiB: 36 });

// A job's estimate in bytes from job.memory ({ utxos, events }); the base
// alone for a job that gives neither.
export function jobEstimate(memory) {
  const e = MEMORY_ESTIMATE;
  const u = memory && Number.isFinite(memory.utxos) ? memory.utxos : 0;
  const n = memory && Number.isFinite(memory.events) ? memory.events : 0;
  return Math.round(e.baseMiB * MiB + u * e.utxoKiB * KiB + n * e.eventKiB * KiB);
}

// What the estimate reads of a wallet's source (replay/source.mjs): the
// start's UTxOs plus those the window's deposits add, which bounds the most
// it holds when no spend leaves more outputs than it took, and the window's
// events.
export function walletMemory(source) {
  let utxos = source.start.length;
  for (const e of source.events) if (e.kind === 'deposit') utxos += e.utxos.length;
  return { utxos, events: source.events.length };
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// The process ids of a process's descendants (/proc/<pid>/task/*/children,
// recursively); none where /proc gives none.
export function descendantPids(pid) {
  const out = [];
  const visit = (p) => {
    let tasks;
    try {
      tasks = readdirSync(`/proc/${p}/task`);
    } catch {
      return;
    }
    for (const t of tasks) {
      const s = readText(`/proc/${p}/task/${t}/children`);
      if (!s) continue;
      for (const c of s.trim().split(/\s+/)) {
        if (!/^\d+$/.test(c)) continue;
        out.push(Number(c));
        visit(Number(c));
      }
    }
  };
  visit(pid);
  return out;
}

// One process's resident size (VmRSS) and its peak (VmHWM), in bytes, or null
// where /proc gives none.
function ownMemory(pid) {
  const s = readText(`/proc/${pid}/status`);
  if (!s) return null;
  const kb = (k) => {
    const m = new RegExp(`^${k}:\\s+(\\d+) kB$`, 'm').exec(s);
    return m ? Number(m[1]) * KiB : null;
  };
  const rss = kb('VmRSS');
  if (rss === null) return null;
  return { rss, hwm: kb('VmHWM') ?? rss };
}

// A worker's resident size and its peak, in bytes, or null where /proc gives
// none: its own plus its descendants' (the helper processes of the methods
// whose library runs in another language, methods/helper.mjs), each read
// alike. The sum of the peaks can only overstate the joint peak.
export function processMemory(pid) {
  const own = ownMemory(pid);
  if (!own) return null;
  for (const c of descendantPids(pid)) {
    const m = ownMemory(c);
    if (!m) continue;
    own.rss += m.rss;
    own.hwm += m.hwm;
  }
  return own;
}

// Resets the peak (VmHWM) of a worker and its descendants to their resident
// sizes, so that the peak read after a job is the job's. Where the kernel
// refuses, the peak read is the process's since its start, which only
// overstates the job's.
function resetPeak(pid) {
  for (const p of [pid, ...descendantPids(pid)]) {
    try {
      writeFileSync(`/proc/${p}/clear_refs`, '5');
    } catch {
      // the lifetime peak stands
    }
  }
}

const exitText = ({ code, signal }) => (signal ? `the worker was killed by ${signal}` : code === null ? 'the worker could not be started' : `the worker exited with code ${code}`);

// A job named for a message: a replay's key, or its wallet.
export function jobName(job) {
  const k = job && job.key;
  if (k) return `wallet ${k.wallet} ${k.arm}/${k.variant} ${k.method} change ${k.change} collateral ${k.collateral} repetition ${k.repetition}`;
  const s = job && job.source;
  if (s && s.kind === 'shape') return `wallet ${s.name}`;
  if (s && s.path) return `wallet file ${s.path.split('/').pop()}`;
  return 'the job';
}

const WORKER = new URL('./worker.mjs', import.meta.url);

// One worker process. `ended` resolves, with { code, signal }, once the
// process has exited and its IPC channel has closed (so every message it
// sent has arrived), or a second after the exit.
class Child {
  constructor(proc) {
    this.proc = proc;
    this.pid = proc.pid;
    this.jobs = 0;
    this.footprint = 0;
    this.exit = null;
    this.fatal = null;
    proc.on('message', (m) => {
      if (m && m.event === 'fatal') this.fatal = m.error;
    });
    this.ended = new Promise((resolve) => {
      // A process that could not be started ends here; for one that runs, a
      // failed send or kill surfaces as its exit.
      proc.on('error', (e) => {
        if (this.pid !== undefined || this.exit) return;
        this.exit = { code: null, signal: null };
        this.fatal = String((e && e.message) || e);
        resolve(this.exit);
      });
      let closed = !proc.connected;
      const done = () => {
        if (this.exit && closed) resolve(this.exit);
      };
      proc.once('disconnect', () => {
        closed = true;
        done();
      });
      proc.once('exit', (code, signal) => {
        this.exit = { code, signal };
        if (!closed) {
          setTimeout(() => {
            closed = true;
            done();
          }, 1000).unref();
        }
        done();
      });
    });
  }

  get alive() {
    return this.exit === null;
  }

  send(m) {
    try {
      this.proc.send(m, () => {});
    } catch {
      // the exit follows
    }
  }

  kill() {
    if (this.alive) this.proc.kill('SIGKILL');
    return this.ended;
  }
}

export class Pool {
  // workerUrl: the worker script, replay/worker.mjs unless a test gives a
  // stand-in that speaks its messages. memoryBudget: bytes (the default when
  // null). estimate(job): a job's estimate in bytes (jobEstimate of
  // job.memory unless a test gives another). execArgv: the workers' Node
  // options (none of the parent's).
  constructor({ treatmentDir, pinsPath = null, size = 1, maxJobs = 40, memoryBudget = null, estimate = (job) => jobEstimate(job.memory), workerUrl = WORKER, execArgv = [] } = {}) {
    if (!treatmentDir) throw new Error('the pool needs the treatment directory');
    this.workerData = { treatmentDir, pinsPath };
    this.workerPath = workerUrl instanceof URL ? fileURLToPath(workerUrl) : workerUrl;
    this.execArgv = execArgv;
    this.size = size;
    this.maxJobs = maxJobs;
    this.budget = memoryBudget ?? defaultMemoryBudget();
    this.estimateJob = estimate;
    // Every worker that has not been stopped (starting, idle or busy).
    this.live = new Set();
    // Workers stopped and not yet exited.
    this.stopping = new Set();
    this.idle = [];
    // Admission: the jobs waiting, in order, and the slots of those
    // admitted, each { charge, alone, worker }.
    this.queue = [];
    this.running = new Set();
    // Raised estimates, by wallet (walletKey).
    this.estimates = new Map();
    // Places held for workers being replaced (renew).
    this.renewing = 0;
    this.seq = 0;
    this.closed = false;
    this.stats = { started: 0, recycled: 0, recycledBySize: 0, watchdogStops: 0, machineReruns: 0, outOfMemoryReruns: 0, admissionWaits: 0, admissionPasses: 0, aloneRuns: 0, estimatesRaised: 0 };
  }

  // The resident size above which a worker is replaced after its job.
  get recycleBytes() {
    return this.budget / this.size;
  }

  // A job's estimate: the larger of its own and its wallet's raised one.
  estimateOf(job) {
    return Math.max(this.estimateJob(job), this.estimates.get(walletKey(job)) ?? 0);
  }

  spawn() {
    if (this.closed) return Promise.reject(new Error('the pool is closed'));
    return new Promise((resolve, reject) => {
      const proc = fork(this.workerPath, [JSON.stringify(this.workerData)], { execArgv: this.execArgv, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      const w = new Child(proc);
      this.stats.started++;
      this.live.add(w);
      let ready = false;
      const onMessage = (m) => {
        if (!m || m.event !== 'ready') return;
        ready = true;
        proc.off('message', onMessage);
        const mem = processMemory(w.pid);
        w.footprint = mem ? mem.rss : 0;
        resolve(w);
      };
      proc.on('message', onMessage);
      w.ended.then((exit) => {
        this.live.delete(w);
        this.idle = this.idle.filter((x) => x !== w);
        if (!ready) {
          proc.off('message', onMessage);
          reject(new Error(`the worker stopped before it was ready: ${w.fatal || exitText(exit)}`));
        }
        this.pump();
      });
    });
  }

  // Stops a worker that holds no job. Its place among the `size` workers is
  // free once it has exited.
  stop(w) {
    this.live.delete(w);
    this.idle = this.idle.filter((x) => x !== w);
    this.stopping.add(w);
    return w.kill().then(() => {
      this.stopping.delete(w);
      this.pump();
    });
  }

  // The places among the `size` workers that are taken: every live worker,
  // every worker stopped and not yet exited, and every worker being
  // replaced. A new worker starts only in a free place, so no more than
  // `size` worker processes exist at once.
  places() {
    return this.live.size + this.stopping.size + this.renewing;
  }

  runningCharge() {
    let n = 0;
    for (const s of this.running) n += s.charge;
    return n;
  }

  // Waits until the job may start and gives it a worker: resolves its slot,
  // { charge, alone, worker }. alone: the job runs with the whole budget,
  // once nothing else runs; front: it goes ahead of the jobs waiting (a
  // rerun); fresh: it runs in a new worker. note(entry) is told when the job
  // runs alone.
  admit({ estimate, alone = false, front = false, fresh = false, note = () => {} }) {
    if (this.closed) return Promise.reject(new Error('the pool is closed'));
    return new Promise((resolve, reject) => {
      const q = { estimate, alone, fresh, rerun: front, note, resolve, reject, waited: false, passes: 0 };
      if (front) this.queue.unshift(q);
      else this.queue.push(q);
      this.pump();
    });
  }

  // Starts the waiting jobs that may start, in the order they asked. A job
  // held for memory may be passed by later jobs that fit, each held job at
  // most `size` times; then nothing passes it, the running jobs drain, and it
  // starts (alone, if it alone exceeds the budget). A rerun is never passed.
  pump() {
    if (this.closed) return;
    const held = [];
    for (let k = 0; k < this.queue.length;) {
      if ([...this.running].some((s) => s.alone)) return;
      if (held.some((h) => h.rerun || h.passes >= this.size)) return;
      const q = this.queue[k];
      const r = this.start(q);
      if (r === 'started') {
        this.queue.splice(k, 1);
        if (held.length) this.stats.admissionPasses++;
        for (const h of held) h.passes++;
      } else if (r === 'memory') {
        if (!q.waited) {
          q.waited = true;
          this.stats.admissionWaits++;
        }
        held.push(q);
        k++;
      } else {
        // No worker for it, or it waits to run alone: no later job starts.
        return;
      }
    }
  }

  // Starts job q when it may start now, giving it a worker; else says why
  // not: 'memory' (its charge does not fit beside the running jobs'),
  // 'worker' (no idle worker and no free place for a new one) or 'alone' (it
  // waits for the running jobs to end).
  start(q) {
    if (q.alone && this.running.size) return 'alone';
    // The idle worker whose resident size the job's charge covers best;
    // none for a job that needs a fresh worker.
    const w = q.fresh ? null : this.idle.reduce((a, x) => (a === null || x.footprint > a.footprint ? x : a), null);
    const place = w !== null || this.places() < this.size;
    if (!place && !(q.fresh && this.idle.length)) return 'worker';
    const charge = q.alone ? Math.max(this.budget, q.estimate) : Math.max(q.estimate, w ? w.footprint : 0);
    const running = this.runningCharge();
    if (this.running.size && running + charge > this.budget) return 'memory';
    if (!place) {
      // A fresh worker's place: an idle worker is stopped for it, and the
      // job starts once that worker has exited.
      if (!this.stopping.size) this.stop(this.idle.reduce((a, x) => (x.footprint > a.footprint ? x : a)));
      return 'worker';
    }
    // Idle workers stopped, largest first, until the job fits.
    const others = this.idle.filter((x) => x !== w).sort((a, b) => b.footprint - a.footprint);
    let idleBytes = others.reduce((a, x) => a + x.footprint, 0);
    for (const x of others) {
      if (running + idleBytes + charge <= this.budget) break;
      this.stop(x);
      idleBytes -= x.footprint;
    }
    const slot = { charge, alone: q.alone || charge > this.budget, worker: null };
    if (slot.alone) {
      this.stats.aloneRuns++;
      q.note(q.alone ? { event: 'running alone', budgetBytes: this.budget } : { event: 'machine short of memory', estimateBytes: q.estimate, budgetBytes: this.budget });
    }
    this.running.add(slot);
    if (w) {
      this.idle = this.idle.filter((x) => x !== w);
      slot.worker = w;
      q.resolve(slot);
    } else {
      this.spawn().then((x) => {
        slot.worker = x;
        q.resolve(slot);
      }, (e) => {
        this.running.delete(slot);
        q.reject(e);
        this.pump();
      });
    }
    return 'started';
  }

  // Ends a slot without returning its worker to the pool: the worker is
  // stopped (when it still runs) and its charge freed.
  release(slot) {
    this.running.delete(slot);
    if (slot.worker && this.live.has(slot.worker)) this.stop(slot.worker);
  }

  // After a job's last attempt on slot.worker (r: the attempt): the
  // measured peak raises the wallet's estimate when it passed it, and the
  // worker goes back to the idle workers or is replaced (`retire`: it
  // recorded machine errors; by size; after maxJobs jobs).
  finish(slot, r, job, { retire = false } = {}) {
    const w = slot.worker;
    const mem = processMemory(w.pid);
    const report = r.memory || null;
    const peak = mem ? mem.hwm : report && report.rss ? report.rss : null;
    const key = walletKey(job);
    if (peak !== null && peak > this.estimateOf(job)) {
      this.estimates.set(key, peak);
      this.stats.estimatesRaised++;
    }
    this.running.delete(slot);
    w.jobs++;
    const rss = mem ? mem.rss : report && report.rss ? report.rss : 0;
    const csl = report && Number.isFinite(report.cslBytes) && Number.isFinite(report.cslCeilingBytes) && report.cslBytes > report.cslCeilingBytes / 2;
    if (retire || !w.alive) this.stop(w);
    else if (rss > this.recycleBytes || csl) {
      this.stats.recycledBySize++;
      this.stop(w);
    } else if (w.jobs >= this.maxJobs) {
      this.stats.recycled++;
      this.stop(w);
    } else {
      w.footprint = rss;
      this.idle.push(w);
    }
    this.pump();
  }

  // Replaces a slot's worker with a fresh one, keeping its admission and
  // its place among the `size` workers.
  async renew(slot) {
    const old = slot.worker;
    this.renewing++;
    this.live.delete(old);
    let fresh;
    try {
      await old.kill();
      fresh = this.spawn();
    } finally {
      this.renewing--;
    }
    try {
      slot.worker = await fresh;
    } catch (e) {
      this.running.delete(slot);
      this.pump();
      throw e;
    }
    return slot;
  }

  // One attempt of a job on worker w. arm: the watchdog armed at the start
  // (milliseconds), or null.
  // Resolves, with ms, the attempt's time:
  //   { kind: 'done', result, memory }
  //   { kind: 'error', error, stop, machine, memory }  the job threw
  //   { kind: 'died', error, exit }   the worker exited or was killed
  //   { kind: 'watchdog' }            the watchdog stopped it
  // memory: the worker's report (cslBytes, cslCeilingBytes, rss and V8's
  // heap). The caller finishes, releases or renews the slot.
  attempt(w, task, job, extra, { arm = null } = {}) {
    const id = ++this.seq;
    const t0 = performance.now();
    resetPeak(w.pid);
    return new Promise((resolve) => {
      let over = false;
      let timer = null;
      const end = (r) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        w.proc.off('message', onMessage);
        resolve({ ...r, ms: performance.now() - t0 });
      };
      const watchdog = (ms) => {
        clearTimeout(timer);
        timer = ms === null ? null : setTimeout(() => end({ kind: 'watchdog' }), ms);
      };
      const onMessage = (m) => {
        if (!m || m.id !== id) return;
        if (m.event === 'done') end({ kind: 'done', result: m.result, memory: m.memory || null });
        else if (m.event === 'error') end({ kind: 'error', error: m.error, stop: !!m.stop, machine: !!m.machine, memory: m.memory || null });
      };
      w.proc.on('message', onMessage);
      w.ended.then((exit) => end({ kind: 'died', error: w.fatal || exitText(exit), exit }));
      if (arm !== null) watchdog(arm);
      w.send({ id, task, job, ...extra });
    });
  }

  // One replay job. Resolves { ok: true, result, ms } or { ok: false, error,
  // stop, ms }, ms being the time of the attempt that ended it. note(entry) is
  // told of each watchdog stop and machine rerun, and of a run alone.
  async replay(job, { watchdogMs = REPLAY_WATCHDOG_MS, note = () => {} } = {}) {
    let watchdog = watchdogMs;
    let record = false;
    let deaths = 0;
    let estimate = this.estimateOf(job);
    let slot = await this.admit({ estimate, note });
    for (;;) {
      const r = await this.attempt(slot.worker, 'replay', job, { recordMachineErrors: record }, { arm: watchdog });
      if (r.kind === 'done' || (r.kind === 'error' && (!r.machine || record))) {
        this.finish(slot, r, job, { retire: record });
        return r.kind === 'done' ? { ok: true, result: r.result, ms: r.ms } : { ok: false, error: r.error, stop: r.stop, ms: r.ms };
      }
      if (this.closed) {
        this.release(slot);
        return { ok: false, error: 'the pool closed', stop: false, ms: r.ms };
      }
      if (r.kind === 'died') {
        deaths++;
        this.release(slot);
        if (deaths === 3) {
          this.pump();
          return { ok: false, error: `${jobName(job)}: its worker died three times, the last: ${r.error}`, stop: false, ms: r.ms };
        }
        if (deaths === 1) estimate *= 2;
        this.stats.machineReruns++;
        this.stats.outOfMemoryReruns++;
        note({ event: 'machine rerun', cause: 'worker died', error: r.error, estimateBytes: estimate, alone: deaths === 2 });
        record = true;
        slot = await this.admit({ estimate, alone: deaths === 2, front: true, fresh: true, note });
        continue;
      }
      if (r.kind === 'watchdog') {
        this.stats.watchdogStops++;
        note({ event: 'watchdog stop', watchdogMs: watchdog, ms: r.ms });
        watchdog *= 2;
      } else {
        this.stats.machineReruns++;
        note({ event: 'machine rerun', cause: 'machine error', error: r.error });
        record = true;
      }
      slot = await this.renew(slot);
    }
  }

  // Stops every worker; a job still waiting for admission is refused.
  async close() {
    this.closed = true;
    for (const q of this.queue.splice(0)) q.reject(new Error('the pool is closed'));
    for (const w of [...this.live]) this.stop(w);
    await Promise.all([...this.stopping].map((w) => w.ended));
    this.idle = [];
  }
}

// The key a raised estimate is kept under: the job's wallet (its source).
const walletKey = (job) => JSON.stringify((job && job.source) ?? null);
