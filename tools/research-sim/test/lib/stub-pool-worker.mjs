// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A stand-in for the replay and battery worker (src/replay/worker.mjs) that
// speaks its messages without the treatment, for the pool's tests. Each
// attempt appends a line to job.counter, so the attempt knows its number n
// across fresh workers, and acts as job.attempts[n - 1] says (the last entry
// for every later attempt).
//   replay   an action: 'done', 'stall:<ms>' (blocks the thread, as a
//            synchronous library call does, then is done), 'machine' (an
//            error that is the machine's), 'error' (one that is not), 'die'
//            (the thread exits), 'throw' (an uncaught exception)
//   battery  { stall: { <run>: ms }, machine: <run>, die: <run> } over runs
//            0 to job.runs - 1, skipping job.skip
// A result names the attempt that made it and whether it recorded machine
// errors.

import { parentPort } from 'node:worker_threads';
import { appendFileSync, readFileSync } from 'node:fs';

const block = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Blocks the thread.
  }
};

function attemptOf(job) {
  appendFileSync(job.counter, 'x\n');
  const n = readFileSync(job.counter, 'utf8').trim().split('\n').length;
  return { n, act: job.attempts[Math.min(n, job.attempts.length) - 1] };
}

parentPort.on('message', ({ id, task, job, recordMachineErrors = false }) => {
  const { n, act } = attemptOf(job);
  const fail = (machine) => parentPort.postMessage({ id, event: 'error', error: machine ? 'RangeError: stand-in heap' : 'Error: stand-in', stop: false, machine });
  if (task === 'replay') {
    const [kind, arg] = String(act).split(':');
    if (kind === 'stall') block(Number(arg));
    if (kind === 'machine') return fail(true);
    if (kind === 'error') return fail(false);
    if (kind === 'die') process.exit(3);
    if (kind === 'throw') {
      setImmediate(() => {
        throw new Error('stand-in uncaught');
      });
      return undefined;
    }
    return parentPort.postMessage({ id, event: 'done', result: { attempt: n, record: recordMachineErrors } });
  }
  const skip = new Set(job.skip || []);
  for (let k = 0; k < job.runs; k++) {
    if (skip.has(k)) continue;
    parentPort.postMessage({ id, event: 'answering', spend: k });
    if (act.stall && act.stall[k]) block(act.stall[k]);
    if (act.machine === k) return fail(true);
    if (act.die === k) process.exit(3);
    parentPort.postMessage({ id, event: 'answered', spend: k });
    parentPort.postMessage({ id, event: 'spend', spend: k, result: { k, attempt: n, through: job.recordMachineThrough } });
  }
  return parentPort.postMessage({ id, event: 'done', result: { runs: job.runs } });
});
parentPort.postMessage({ event: 'ready' });
