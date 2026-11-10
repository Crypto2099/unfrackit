// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A stand-in for the oracle's worker (src/oracle/worker.mjs) that speaks its
// messages without the treatment or the solver, for the oracle pool's tests.
// Each call appends a line to opts.stub.counter, so the attempt knows its
// number n across fresh workers, and acts as opts.stub.attempts[n - 1] says
// (the last entry for every later attempt): 'done', 'stall:<ms>' (blocks the
// thread, then is done), 'solver-error' (returns with stop solver-error),
// 'machine' (an error that is the machine's), 'refusal', 'die' (the thread
// exits). A result names the attempt that made it and whether it recorded
// machine errors.

import { parentPort } from 'node:worker_threads';
import { appendFileSync, readFileSync } from 'node:fs';

parentPort.postMessage({ type: 'ready' });

parentPort.on('message', (job) => {
  const { counter, attempts } = job.opts.stub;
  appendFileSync(counter, 'x\n');
  const n = readFileSync(counter, 'utf8').trim().split('\n').length;
  const [kind, arg] = String(attempts[Math.min(n, attempts.length) - 1]).split(':');
  const result = (stop) => ({ status: stop === 'proven' ? 'optimal' : 'best-at-limit', stop, fee: 170000n, policy: job.policy, settings: job.opts.settings, ms: 1, attempt: n, record: job.recordMachineErrors === true });
  if (kind === 'stall') {
    const end = Date.now() + Number(arg);
    while (Date.now() < end) {
      // Blocks the thread.
    }
  }
  if (kind === 'die') process.exit(3);
  if (kind === 'machine') return parentPort.postMessage({ type: 'error', id: job.id, refusal: false, machine: true, message: 'RuntimeError: unreachable' });
  if (kind === 'refusal') return parentPort.postMessage({ type: 'error', id: job.id, refusal: true, machine: false, message: 'a spend the oracle does not handle' });
  return parentPort.postMessage({ type: 'done', id: job.id, result: result(kind === 'solver-error' ? 'solver-error' : 'proven') });
});
