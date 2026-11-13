// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A stand-in for the replay worker process
// (src/replay/worker.mjs) that speaks its messages without the treatment,
// for the pool's tests. Each attempt appends a line to job.counter, so the
// attempt knows its number n across fresh workers, and acts as
// job.attempts[n - 1] says (the last entry for every later attempt).
//   replay   an action, or several joined by '+': 'done', 'stall:<ms>'
//            (blocks the process, as a synchronous library call does, then
//            is done), 'sleep:<ms>' (waits without blocking, then is done),
//            'hold:<MiB>' (allocates that much and keeps it, then is done),
//            'csl:<MiB>' (reports CSL memory of that size, of a 4 GiB
//            ceiling, then is done), 'machine' (an error that is the
//            machine's), 'error' (one that is not), 'die' (the process
//            exits with code 3), 'kill' (it is killed by SIGKILL, as the
//            out-of-memory killer does), 'throw' (an uncaught exception)
// A replay result names the attempt that made it and whether it recorded
// machine errors, and, when job.trace is set, the process and when the
// attempt started and ended (Date.now()).

import { appendFileSync, readFileSync } from 'node:fs';

process.on('disconnect', () => process.exit(0));
process.on('uncaughtException', (e) => {
  process.send({ event: 'fatal', error: String((e && e.stack) || e) }, () => process.exit(1));
});

const held = [];
const block = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Blocks the process.
  }
};

function attemptOf(job) {
  appendFileSync(job.counter, 'x\n');
  const n = readFileSync(job.counter, 'utf8').trim().split('\n').length;
  return { n, act: job.attempts[Math.min(n, job.attempts.length) - 1] };
}

const report = (csl = 0) => ({ cslBytes: csl, cslCeilingBytes: 4 * 1024 ** 3, rss: process.memoryUsage().rss });

process.on('message', async ({ id, task, job, recordMachineErrors = false }) => {
  const start = Date.now();
  const { n, act } = attemptOf(job);
  const fail = (machine) => process.send({ id, event: 'error', error: machine ? 'RangeError: stand-in heap' : 'Error: stand-in', stop: false, machine, memory: report() });
  if (task === 'replay') {
    let csl = 0;
    for (const step of String(act).split('+')) {
      const [kind, arg] = step.split(':');
      if (kind === 'stall') block(Number(arg));
      if (kind === 'sleep') await new Promise((r) => setTimeout(r, Number(arg)));
      if (kind === 'hold') held.push(Buffer.alloc(Number(arg) * 1024 * 1024, 1));
      if (kind === 'csl') csl = Number(arg) * 1024 * 1024;
      if (kind === 'machine') return fail(true);
      if (kind === 'error') return fail(false);
      if (kind === 'die') process.exit(3);
      if (kind === 'kill') process.kill(process.pid, 'SIGKILL');
      if (kind === 'throw') {
        setImmediate(() => {
          throw new Error('stand-in uncaught');
        });
        return undefined;
      }
    }
    return process.send({ id, event: 'done', result: { attempt: n, record: recordMachineErrors, ...(job.trace ? { pid: process.pid, start, end: Date.now() } : {}) }, memory: report(csl) });
  }
  return fail(false);
});
process.send({ event: 'ready' });
