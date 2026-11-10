// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Worker threads and the watchdogs. No time limit decides any result: every
// replay and every method answer runs to completion, and its time is kept as
// timing context (out/records.mjs). CSL's calls are synchronous, so work that
// hangs can be stopped only by terminating the thread it runs in. A watchdog
// far above any expected time does that: the work is set aside, nothing of
// it is recorded, and it runs again at once in a fresh worker with its
// watchdog doubled, as often as it takes to complete, so a stop changes when
// the work ends and never what it records.
//
//   replay   24 hours per (wallet, arm, selector, repetition) replay; the
//            replay runs again from its start
//   battery  30 minutes per method answer for one wallet and spend, counted
//            from the method's start to its return; the wallet's battery
//            resumes at that answer (job.skip lists the runs already done)
//
// Errors the machine can cause (kit/machine.mjs), and a worker that exits or
// errors during a job, make the job run again once in a fresh worker that
// records machine errors: only an error that happens again there is recorded,
// as the method's outcome where the code records one. A worker that dies
// twice at the same point of a job, or an error that is not the machine's,
// fails the job, and the run stops with it.
//
// Each worker runs one job at a time, and is replaced after maxJobs jobs:
// CSL's WebAssembly memory only grows, to the high-water mark of the largest
// wallet the worker has built for, and a fresh thread gives it back. The
// worker count changes no record; the commands record it and the machine
// beside the timings (out/host.mjs). `stats` counts what happened, for the
// run's log and printout only: workers started and recycled, watchdog stops
// and machine reruns.

import { Worker } from 'node:worker_threads';

export const REPLAY_WATCHDOG_MS = 24 * 3600 * 1000;
export const ANSWER_WATCHDOG_MS = 30 * 60 * 1000;

// A worker count as a command line gives it: a positive whole number, or
// `dflt` when absent.
export function workerCount(v, flag, dflt = 1) {
  if (v === undefined) return dflt;
  const n = typeof v === 'string' && /^[1-9]\d*$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${flag} takes a positive whole number`);
  return n;
}

const WORKER = new URL('./worker.mjs', import.meta.url);

export class Pool {
  // workerUrl: the worker script, replay/worker.mjs unless a test gives a
  // stand-in that speaks its messages.
  constructor({ treatmentDir, pinsPath = null, size = 1, resourceLimits, maxJobs = 40, workerUrl = WORKER } = {}) {
    if (!treatmentDir) throw new Error('the pool needs the treatment directory');
    this.workerData = { treatmentDir, pinsPath };
    this.workerUrl = workerUrl;
    this.size = size;
    this.maxJobs = maxJobs;
    this.jobs = new WeakMap();
    this.resourceLimits = resourceLimits;
    this.idle = [];
    this.waiting = [];
    this.live = new Set();
    this.seq = 0;
    this.stats = { started: 0, recycled: 0, watchdogStops: 0, machineReruns: 0 };
  }

  spawn() {
    return new Promise((resolve, reject) => {
      const w = new Worker(this.workerUrl, { workerData: this.workerData, resourceLimits: this.resourceLimits });
      this.stats.started++;
      this.live.add(w);
      const onMessage = (m) => {
        if (m && m.event === 'ready') {
          w.off('message', onMessage);
          w.off('error', onError);
          resolve(w);
        }
      };
      const onError = (e) => {
        this.live.delete(w);
        reject(e);
      };
      w.on('message', onMessage);
      w.once('error', onError);
    });
  }

  async acquire() {
    if (this.idle.length) return this.idle.pop();
    if (this.live.size < this.size) return this.spawn();
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async release(w) {
    const n = (this.jobs.get(w) || 0) + 1;
    this.jobs.set(w, n);
    if (n >= this.maxJobs) {
      this.stats.recycled++;
      await this.retire(w);
      return;
    }
    const next = this.waiting.shift();
    if (next) next(w);
    else this.idle.push(w);
  }

  // Terminates a worker after its job, so that a waiting job gets a fresh one.
  async retire(w) {
    this.live.delete(w);
    await w.terminate();
    const next = this.waiting.shift();
    if (next) next(await this.spawn());
  }

  // Terminates a worker whose job is to run again, and starts the fresh
  // worker it runs in, in the same place in the pool.
  async renew(w) {
    this.live.delete(w);
    await w.terminate();
    return this.spawn();
  }

  // One attempt of a job on worker w. arm: the watchdog armed at the start
  // (milliseconds), or null; on(m, watchdog) sees each other message of the
  // job and may arm the watchdog (watchdog(ms)) or clear it (watchdog(null)).
  // Resolves, with ms, the attempt's time:
  //   { kind: 'done', result }
  //   { kind: 'error', error, stop, machine }  the job threw
  //   { kind: 'died', error }                  the worker exited or errored
  //   { kind: 'watchdog' }                     the watchdog stopped it
  // The caller releases, retires or renews the worker.
  attempt(w, task, job, extra, { arm = null, on = () => {} } = {}) {
    const id = ++this.seq;
    const t0 = performance.now();
    return new Promise((resolve) => {
      let over = false;
      let timer = null;
      const end = (r) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        w.off('message', onMessage);
        w.off('error', onError);
        w.off('exit', onExit);
        resolve({ ...r, ms: performance.now() - t0 });
      };
      const watchdog = (ms) => {
        clearTimeout(timer);
        timer = ms === null ? null : setTimeout(() => end({ kind: 'watchdog' }), ms);
      };
      const onMessage = (m) => {
        if (!m || m.id !== id) return;
        if (m.event === 'done') end({ kind: 'done', result: m.result });
        else if (m.event === 'error') end({ kind: 'error', error: m.error, stop: !!m.stop, machine: !!m.machine });
        else on(m, watchdog);
      };
      const onError = (e) => end({ kind: 'died', error: String((e && e.stack) || e) });
      const onExit = (code) => end({ kind: 'died', error: `the worker exited with code ${code}` });
      w.on('message', onMessage);
      w.once('error', onError);
      w.once('exit', onExit);
      if (arm !== null) watchdog(arm);
      w.postMessage({ id, task, job, ...extra });
    });
  }

  // One replay job. Resolves { ok: true, result, ms } or { ok: false, error,
  // stop, ms }, ms being the time of the attempt that ended it. note(entry) is
  // told of each watchdog stop and machine rerun.
  async replay(job, { watchdogMs = REPLAY_WATCHDOG_MS, note = () => {} } = {}) {
    let watchdog = watchdogMs;
    let record = false;
    let died = false;
    let w = await this.acquire();
    for (;;) {
      const r = await this.attempt(w, 'replay', job, { recordMachineErrors: record }, { arm: watchdog });
      if (r.kind === 'done' || (r.kind === 'error' && (!r.machine || record))) {
        if (record) await this.retire(w);
        else await this.release(w);
        return r.kind === 'done' ? { ok: true, result: r.result, ms: r.ms } : { ok: false, error: r.error, stop: r.stop, ms: r.ms };
      }
      if (r.kind === 'died' && died) {
        this.live.delete(w);
        await w.terminate();
        return { ok: false, error: r.error, stop: false, ms: r.ms };
      }
      if (r.kind === 'watchdog') {
        this.stats.watchdogStops++;
        note({ event: 'watchdog stop', watchdogMs: watchdog, ms: r.ms });
        watchdog *= 2;
      } else {
        this.stats.machineReruns++;
        note({ event: 'machine rerun', cause: r.kind === 'died' ? 'worker died' : 'machine error', error: r.error });
        if (r.kind === 'died') died = true;
        record = true;
      }
      w = await this.renew(w);
    }
  }

  // One wallet's battery job. onSpend(k, result) is called for each run as it
  // ends, once per run. Resolves { ok: true, result, ms } or { ok: false,
  // error, stop, ms }. A run's position is its number; the wallet's setup
  // before its first answer is -1. A machine rerun records machine errors up
  // to the position where the error happened (job.recordMachineThrough).
  async battery(job, { watchdogMs = ANSWER_WATCHDOG_MS, onSpend = () => {}, note = () => {} } = {}) {
    const t0 = performance.now();
    const doneK = new Set(job.skip || []);
    const watchdogs = new Map();
    let through = null;
    const died = new Set();
    let w = await this.acquire();
    for (;;) {
      let at = -1;
      const r = await this.attempt(w, 'battery', { ...job, skip: [...doneK], recordMachineThrough: through }, {}, {
        on: (m, watchdog) => {
          if (m.event === 'answering') {
            at = m.spend;
            watchdog(watchdogs.get(m.spend) ?? watchdogMs);
          } else if (m.event === 'answered') {
            watchdog(null);
          } else if (m.event === 'spend') {
            doneK.add(m.spend);
            onSpend(m.spend, m.result);
          }
        }
      });
      const recorded = through !== null && at <= through;
      if (r.kind === 'done' || (r.kind === 'error' && (!r.machine || recorded))) {
        if (through !== null) await this.retire(w);
        else await this.release(w);
        return r.kind === 'done' ? { ok: true, result: r.result, ms: performance.now() - t0 } : { ok: false, error: r.error, stop: r.stop, ms: performance.now() - t0 };
      }
      if (r.kind === 'died' && died.has(at)) {
        this.live.delete(w);
        await w.terminate();
        return { ok: false, error: r.error, stop: false, ms: performance.now() - t0 };
      }
      if (r.kind === 'watchdog') {
        const ms = watchdogs.get(at) ?? watchdogMs;
        this.stats.watchdogStops++;
        note({ event: 'watchdog stop', run: at, watchdogMs: ms, ms: r.ms });
        watchdogs.set(at, ms * 2);
      } else {
        this.stats.machineReruns++;
        note({ event: 'machine rerun', run: at, cause: r.kind === 'died' ? 'worker died' : 'machine error', error: r.error });
        if (r.kind === 'died') died.add(at);
        through = through === null ? at : Math.max(through, at);
      }
      w = await this.renew(w);
    }
  }

  async close() {
    for (const w of this.live) await w.terminate();
    this.live.clear();
    this.idle = [];
  }
}
