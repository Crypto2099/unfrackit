// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Worker threads and the time limits. CSL's calls are synchronous, so a
// replay or a method answer is stopped at its limit only by terminating the
// thread it runs in; the pool then records the time-out and starts a fresh
// worker.
//
//   replay   300 seconds of wall-clock time per (wallet, arm, selector,
//            repetition) replay; a replay that times out leaves no record but
//            its time-out, and its wallet is excluded from the paired
//            comparisons that need that arm
//   battery  60 seconds per method answer for one wallet and spend, counted
//            from the method's start to its return; a method that runs past
//            it has returned an error with the reason "time limit", and the
//            wallet's remaining spends continue in a fresh worker
// Each worker runs one job at a time, and is replaced after maxJobs jobs:
// CSL's asm.js heap only grows, to the high-water mark of the largest wallet
// the worker has built for, and a fresh thread gives it back.
//
// The thread cap: a run keeps at most MAX_BUSY_THREADS threads busy, its
// replay or battery workers and its oracle workers together, so that the
// wall-clock limits above hold on a machine whose cores are not
// oversubscribed. The commands refuse more (checkBusyThreads) and record the
// counts in run.json.

import { Worker } from 'node:worker_threads';

export const REPLAY_LIMIT_MS = 300 * 1000;
export const ANSWER_LIMIT_MS = 60 * 1000;
export const MAX_BUSY_THREADS = 12;

// A worker count as a command line gives it: a positive whole number, or
// `dflt` when absent.
export function workerCount(v, flag, dflt = 1) {
  if (v === undefined) return dflt;
  const n = typeof v === 'string' && /^[1-9]\d*$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${flag} takes a positive whole number`);
  return n;
}

// The busy threads of a run, refused above the cap: { workers,
// oracleWorkers, busy, cap }.
export function checkBusyThreads(workers, oracleWorkers = 0) {
  const busy = workers + oracleWorkers;
  if (busy > MAX_BUSY_THREADS) throw new Error(`refusing: ${oracleWorkers ? '--workers and --oracle-workers together' : '--workers'} may keep at most ${MAX_BUSY_THREADS} threads busy (${busy} asked)`);
  return { workers, oracleWorkers, busy, cap: MAX_BUSY_THREADS };
}
const WORKER = new URL('./worker.mjs', import.meta.url);

export class Pool {
  constructor({ treatmentDir, pinsPath = null, size = 1, resourceLimits, maxJobs = 40 } = {}) {
    if (!treatmentDir) throw new Error('the pool needs the treatment directory');
    this.workerData = { treatmentDir, pinsPath };
    this.size = size;
    this.maxJobs = maxJobs;
    this.jobs = new WeakMap();
    this.resourceLimits = resourceLimits;
    this.idle = [];
    this.waiting = [];
    this.live = new Set();
    this.seq = 0;
    this.stats = { started: 0, terminated: 0 };
  }

  spawn() {
    return new Promise((resolve, reject) => {
      const w = new Worker(WORKER, { workerData: this.workerData, resourceLimits: this.resourceLimits });
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
      this.live.delete(w);
      this.stats.recycled = (this.stats.recycled || 0) + 1;
      await w.terminate();
      const next = this.waiting.shift();
      if (next) next(await this.spawn());
      return;
    }
    const next = this.waiting.shift();
    if (next) next(w);
    else this.idle.push(w);
  }

  async kill(w) {
    this.live.delete(w);
    this.stats.terminated++;
    await w.terminate();
    // A replacement, so that a waiting job is not left without a worker.
    const next = this.waiting.shift();
    if (next) next(await this.spawn());
  }

  // One replay job. Resolves { ok: true, result, ms } or { ok: false,
  // timedOut: true, ms } or { ok: false, error, stop, ms }.
  async replay(job, { limitMs = REPLAY_LIMIT_MS } = {}) {
    const w = await this.acquire();
    const id = ++this.seq;
    const t0 = performance.now();
    return new Promise((resolve) => {
      let done = false;
      const finish = async (r, dead) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        w.off('message', onMessage);
        w.off('error', onError);
        if (dead) await this.kill(w);
        else await this.release(w);
        resolve({ ...r, ms: performance.now() - t0 });
      };
      const timer = setTimeout(() => finish({ ok: false, timedOut: true }, true), limitMs);
      const onMessage = (m) => {
        if (m.id !== id) return;
        if (m.event === 'done') finish({ ok: true, result: m.result }, false);
        else if (m.event === 'error') finish({ ok: false, error: m.error, stop: m.stop }, false);
      };
      const onError = (e) => finish({ ok: false, error: String((e && e.stack) || e), stop: false }, true);
      w.on('message', onMessage);
      w.once('error', onError);
      w.postMessage({ id, task: 'replay', job });
    });
  }

  // One wallet's battery job. onSpend(k, result) is called for each run as it
  // ends, with { timeLimit: true } for one that ran out of time. Resolves
  // { ok, result, timeouts, ms } or { ok: false, error, stop }.
  async battery(job, { answerLimitMs = ANSWER_LIMIT_MS, onSpend = () => {} } = {}) {
    const t0 = performance.now();
    const doneK = new Set(job.skip || []);
    const timeouts = [];
    for (;;) {
      const w = await this.acquire();
      const id = ++this.seq;
      const r = await new Promise((resolve) => {
        let timer = null;
        let current = null;
        let over = false;
        const finish = async (x, dead) => {
          if (over) return;
          over = true;
          clearTimeout(timer);
          w.off('message', onMessage);
          w.off('error', onError);
          if (dead) await this.kill(w);
          else await this.release(w);
          resolve(x);
        };
        const onMessage = (m) => {
          if (m.id !== id) return;
          if (m.event === 'answering') {
            current = m.spend;
            clearTimeout(timer);
            timer = setTimeout(() => finish({ timedOut: current }, true), answerLimitMs);
          } else if (m.event === 'answered') {
            clearTimeout(timer);
            timer = null;
          } else if (m.event === 'spend') {
            doneK.add(m.spend);
            onSpend(m.spend, m.result);
          } else if (m.event === 'done') finish({ done: m.result }, false);
          else if (m.event === 'error') finish({ error: m.error, stop: m.stop }, false);
        };
        const onError = (e) => finish({ error: String((e && e.stack) || e), stop: false }, true);
        w.on('message', onMessage);
        w.once('error', onError);
        w.postMessage({ id, task: 'battery', job: { ...job, skip: [...doneK] } });
      });
      if (r.done) return { ok: true, result: r.done, timeouts, ms: performance.now() - t0 };
      if (r.error) return { ok: false, error: r.error, stop: r.stop, timeouts, ms: performance.now() - t0 };
      timeouts.push(r.timedOut);
      doneK.add(r.timedOut);
      onSpend(r.timedOut, { timeLimit: true, limitMs: answerLimitMs });
    }
  }

  async close() {
    for (const w of this.live) await w.terminate();
    this.live.clear();
    this.idle = [];
  }
}
