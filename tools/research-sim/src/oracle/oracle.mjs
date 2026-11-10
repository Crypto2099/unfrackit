// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The oracle's interface:
//
//   const o = createOracle({ treatmentDir, pinsText, workers, watchdogMs,
//     note })
//   await o.oracle(state, spend, params, policy, { incumbents, settings,
//     path, timeLimitMs, watchdogMs })
//     resolves to { status, path, paths, scope, candidates, fee, bound, tx,
//     stop, work, ms, ... } (search.mjs)
//   await o.close()
//
// Each call runs in a worker thread (worker.mjs). Under the work budget (the
// oracle setting limit 'budget') the call stops on its own counts, the same
// for the same inputs on any machine, and runs to completion. CSL's and
// HiGHS's calls are synchronous and cannot be interrupted from inside, so
// the parent keeps a watchdog (watchdogMs, ORACLE_WATCHDOG_MS by default, an
// hour) far above any budgeted call: a call it stops is set aside, its
// worker terminated, and the call runs again in a fresh worker with the
// watchdog doubled, as often as it takes to return. A stop is never a
// result; stats.watchdogStops counts them. Errors the machine can cause make
// the call run again once in a fresh worker that records machine errors
// (kit/machine.mjs): a worker that exits or errors, an exception that is a
// machine error, and a call that ends with stop 'solver-error' (a second
// solver failure, mip.mjs); the rerun's result or error stands, and
// stats.machineReruns counts them. note(entry) is told of each.
//
// Under limit 'wall-clock', kept for the oracle's checks, the call's time is
// its limit: the parent terminates a worker at the call's timeLimitMs plus a
// margin (settings.mjs TERMINATE_MARGIN_MS), and that call is undecided, with
// no fee, `terminated` true and `stop` 'guard', whatever the worker had found.
// `tx` and `fee` are null unless a feasible solution exists. The battery
// runner calls the oracle once per wallet, spend and distinct change policy;
// two selectors that share a change policy share one reference.
//
// Workers run one call at a time each; calls beyond the worker count wait.

import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { DEFAULT_PINS } from '../treatment/bridge.mjs';
import { TIME_LIMIT_MS, TERMINATE_MARGIN_MS, ORACLE_WATCHDOG_MS, oracleSettings } from './settings.mjs';
import { OracleRefusal } from './spend.mjs';

const WORKER = new URL('./worker.mjs', import.meta.url);

// workerUrl: the worker script, worker.mjs unless a test gives a stand-in
// that speaks its messages.
export function createOracle({ treatmentDir, pinsText = readFileSync(DEFAULT_PINS, 'utf8'), workers = 1, marginMs = TERMINATE_MARGIN_MS, watchdogMs = ORACLE_WATCHDOG_MS, note = () => {}, resourceLimits, workerUrl = WORKER } = {}) {
  if (!treatmentDir) throw new Error('the oracle needs the treatment directory');
  const idle = [];
  const all = new Set();
  const waiting = [];
  let seq = 0;
  let closed = false;
  const stats = { calls: 0, workersStarted: 0, watchdogStops: 0, machineReruns: 0, terminated: 0 };

  function spawn() {
    return new Promise((resolve, reject) => {
      const w = new Worker(workerUrl, { workerData: { treatmentDir, pinsText }, resourceLimits });
      stats.workersStarted++;
      all.add(w);
      const onReady = (m) => {
        if (m && m.type === 'ready') {
          w.off('message', onReady);
          w.off('error', onError);
          resolve(w);
        }
      };
      const onError = (e) => {
        all.delete(w);
        reject(e);
      };
      w.on('message', onReady);
      w.once('error', onError);
    });
  }

  async function acquire() {
    if (closed) throw new Error('the oracle is closed');
    if (idle.length) return idle.pop();
    if (all.size < workers) return spawn();
    return new Promise((resolve) => waiting.push(resolve));
  }

  function release(w) {
    if (closed) {
      w.terminate();
      return;
    }
    const next = waiting.shift();
    if (next) next(w);
    else idle.push(w);
  }

  // Terminates a worker; with `again`, starts the fresh worker the call runs
  // again in, in its place; otherwise hands a fresh one to a waiting call.
  async function drop(w, { again = false } = {}) {
    all.delete(w);
    await w.terminate();
    if (closed) throw new Error('the oracle is closed');
    if (again) return spawn();
    const next = waiting.shift();
    if (next) next(await spawn());
    return null;
  }

  // One attempt of a call on worker w, stopped at stopMs. Resolves { kind:
  // 'done', result } | { kind: 'error', message, refusal, machine } |
  // { kind: 'died', error } | { kind: 'stopped' }, with ms.
  function attempt(w, message, stopMs) {
    const id = ++seq;
    const t0 = performance.now();
    return new Promise((resolve) => {
      let over = false;
      const end = (r) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        w.off('message', onMessage);
        w.off('error', onError);
        w.off('exit', onExit);
        resolve({ ...r, ms: performance.now() - t0 });
      };
      const onMessage = (m) => {
        if (!m || m.id !== id) return;
        if (m.type === 'done') end({ kind: 'done', result: m.result });
        else if (m.type === 'error') end({ kind: 'error', message: m.message, refusal: !!m.refusal, machine: !!m.machine });
      };
      const onError = (e) => end({ kind: 'died', error: e });
      const onExit = (code) => end({ kind: 'died', error: new Error(`the oracle worker exited with code ${code}`) });
      const timer = setTimeout(() => end({ kind: 'stopped' }), stopMs);
      w.on('message', onMessage);
      w.once('error', onError);
      w.once('exit', onExit);
      w.postMessage({ id, ...message });
    });
  }

  const failure = (r) => (r.refusal ? new OracleRefusal(r.message) : new Error(`oracle worker: ${r.message}`));

  // Under limit 'wall-clock': one attempt, stopped at the limit plus the
  // margin.
  async function wallClock(message, policy, settings, timeLimitMs) {
    const w = await acquire();
    const r = await attempt(w, message, timeLimitMs + marginMs);
    if (r.kind === 'done' || r.kind === 'error') release(w);
    else await drop(w);
    if (r.kind === 'done') return { ...r.result, wallMs: r.ms, terminated: false };
    if (r.kind === 'error') throw failure(r);
    if (r.kind === 'died') throw r.error;
    stats.terminated++;
    return { status: 'undecided', path: null, paths: null, scope: null, candidates: null, policy, fee: null, bound: null, tx: null, best: null, stop: 'guard', work: null, settings, ms: r.ms, wallMs: r.ms, terminated: true };
  }

  async function oracle(state, spend, params, policy, opts = {}) {
    const settings = opts.settings || oracleSettings();
    const budgeted = settings.limit === 'budget';
    if (budgeted && opts.timeLimitMs !== undefined) throw new Error('timeLimitMs applies only under the oracle setting limit=wall-clock');
    const timeLimitMs = budgeted ? undefined : opts.timeLimitMs ?? TIME_LIMIT_MS;
    const { onProgress, watchdogMs: callWatchdogMs, ...rest } = opts;
    const message = { state, spend, params, policy, opts: { ...rest, settings, ...(budgeted ? {} : { timeLimitMs }) } };
    stats.calls++;
    if (!budgeted) return wallClock(message, policy, settings, timeLimitMs);
    let watchdog = callWatchdogMs ?? watchdogMs;
    let record = false;
    let died = false;
    let w = await acquire();
    for (;;) {
      const r = await attempt(w, { ...message, recordMachineErrors: record }, watchdog);
      const rerunSolver = r.kind === 'done' && !record && r.result.stop === 'solver-error';
      if ((r.kind === 'done' && !rerunSolver) || (r.kind === 'error' && (!r.machine || record))) {
        if (record) await drop(w);
        else release(w);
        if (r.kind === 'error') throw failure(r);
        return { ...r.result, wallMs: r.ms, terminated: false };
      }
      if (r.kind === 'died' && died) {
        await drop(w);
        throw r.error;
      }
      if (r.kind === 'stopped') {
        stats.watchdogStops++;
        note({ event: 'watchdog stop', policy, watchdogMs: watchdog, ms: r.ms });
        watchdog *= 2;
      } else {
        stats.machineReruns++;
        note({ event: 'machine rerun', policy, cause: r.kind === 'died' ? 'worker died' : rerunSolver ? 'solver error' : 'machine error', error: r.kind === 'died' ? String(r.error && (r.error.message || r.error)) : r.kind === 'error' ? r.message : 'stop solver-error' });
        if (r.kind === 'died') died = true;
        record = true;
      }
      w = await drop(w, { again: true });
    }
  }

  async function close() {
    closed = true;
    for (const r of waiting.splice(0)) r(null);
    await Promise.all([...all].map((w) => w.terminate()));
    all.clear();
    idle.length = 0;
  }

  return { oracle, close, stats };
}
