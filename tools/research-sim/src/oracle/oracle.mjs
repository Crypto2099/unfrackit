// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The oracle's interface:
//
//   const o = createOracle({ treatmentDir, pinsText, workers })
//   await o.oracle(state, spend, params, policy, { timeLimitMs, incumbents,
//     settings, path })
//     resolves to { status, path, scope, candidates, fee, tx, ms, ... }
//   await o.close()
//
// Each call runs in a worker thread (worker.mjs) that the parent terminates
// at the time limit plus a margin (settings.mjs TERMINATE_MARGIN_MS),
// recording the termination: CSL's and HiGHS's calls are synchronous and
// cannot be interrupted from inside. A terminated call returns the best the
// worker had reported (status best-at-limit) or none (undecided), with
// `terminated` true, and its worker is replaced. `tx` and `fee` are null
// unless a feasible solution exists. The battery runner calls it once per
// wallet, spend and distinct change policy; two selectors that share a
// change policy share one reference.
//
// Workers run one call at a time each; calls beyond the worker count wait.

import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { DEFAULT_PINS } from '../treatment/bridge.mjs';
import { TIME_LIMIT_MS, TERMINATE_MARGIN_MS } from './settings.mjs';
import { OracleRefusal } from './spend.mjs';

const WORKER = new URL('./worker.mjs', import.meta.url);

export function createOracle({ treatmentDir, pinsText = readFileSync(DEFAULT_PINS, 'utf8'), workers = 1, marginMs = TERMINATE_MARGIN_MS, resourceLimits } = {}) {
  if (!treatmentDir) throw new Error('the oracle needs the treatment directory');
  const idle = [];
  const all = new Set();
  const waiting = [];
  let seq = 0;
  let closed = false;
  const stats = { calls: 0, terminated: 0, workersStarted: 0 };

  function spawn() {
    return new Promise((resolve, reject) => {
      const w = new Worker(WORKER, { workerData: { treatmentDir, pinsText }, resourceLimits });
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

  async function replace() {
    const w = await spawn();
    release(w);
  }

  async function oracle(state, spend, params, policy, opts = {}) {
    const timeLimitMs = opts.timeLimitMs ?? TIME_LIMIT_MS;
    const w = await acquire();
    const id = ++seq;
    stats.calls++;
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      let best = null;
      let tx = null;
      let done = false;
      const finish = (fn) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        w.off('message', onMessage);
        w.off('error', onError);
        fn();
      };
      const onMessage = (m) => {
        if (m.id !== id) return;
        if (m.type === 'best') {
          best = m.best;
          tx = m.tx;
        } else if (m.type === 'done') {
          finish(() => {
            release(w);
            resolve({ ...m.result, wallMs: performance.now() - t0, terminated: false });
          });
        } else if (m.type === 'error') {
          finish(() => {
            release(w);
            reject(m.refusal ? new OracleRefusal(m.message) : new Error(`oracle worker: ${m.message}`));
          });
        }
      };
      const onError = (e) => {
        finish(() => {
          all.delete(w);
          replace().catch(() => {});
          reject(e);
        });
      };
      const timer = setTimeout(() => {
        finish(() => {
          stats.terminated++;
          all.delete(w);
          w.terminate();
          replace().catch(() => {});
          resolve({
            status: best ? 'best-at-limit' : 'undecided',
            path: null,
            scope: null,
            candidates: null,
            policy,
            fee: best ? best.fee : null,
            tx: best ? tx : null,
            best,
            ms: performance.now() - t0,
            wallMs: performance.now() - t0,
            terminated: true
          });
        });
      }, timeLimitMs + marginMs);
      w.on('message', onMessage);
      w.once('error', onError);
      const { onProgress, ...rest } = opts;
      w.postMessage({ id, state, spend, params, policy, opts: { ...rest, timeLimitMs } });
    });
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
