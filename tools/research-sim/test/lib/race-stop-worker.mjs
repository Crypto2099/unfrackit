// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A stand-in for the replay worker that speaks its messages and writes a real
// spool the way runJob does (src/replay/run.mjs), for the test of a parent
// whose thread is busy across the time limit while the worker ends its build.
// job.mode:
//   'boundary'  a build running at the limit ends 100 ms after it; the job
//               then stops itself at the spend boundary
//   'finish'    a build running at the limit ends 100 ms after it; it is the
//               last intent, so the job finishes with its bursts and a normal
//               wallet-arm record
//   'early'     the build ends 200 ms after it starts, before the limit; the
//               job finishes as in 'finish'
// With job.validity the checks of the two spends (1 transaction; 1 with a
// failure) go to the spool's validity file as a worker writes them, and a
// stopped answer carries their sum. The worker removes nothing.
// The limit is read from stopAfterMs, or from stopAt (the form a worker was
// sent before the limit was on the worker's own clock) as a Date.now() time.

import { writeFileSync, appendFileSync } from 'node:fs';
import { SpoolStream } from '../../src/out/spool.mjs';
import { record } from '../../src/out/records.mjs';
import { spoolJob, STOPPED_AT } from '../../src/replay/run.mjs';

process.on('disconnect', () => process.exit(0));
const block = (until) => {
  while (Date.now() < until) {
    // a synchronous build
  }
};

process.on('message', ({ id, job, stopAfterMs, stopAt, attempt, limitMs }) => {
  const started = performance.now();
  const deadline = stopAfterMs !== undefined ? Date.now() + stopAfterMs : stopAt;
  process.send({ id, event: 'info', info: { methodVersion: 'v1' } });
  process.send({ id, event: 'building', on: false });
  const stream = new SpoolStream(job.spool, { hold: (r) => r.kind === 'wallet-arm', eager: true });
  const spends = [];
  const V = (txs, failed = 0) => ({ txs, cslRead: txs, cslOutputBytes: 0, cslReencoded: 0, controls: { fee: txs, size: txs, value: txs, witnesses: txs }, notApplicable: { fee: 0, value: 0 }, failed, ...(failed ? { failures: [{ at: 'spend 1', tx: 0, check: 'fee', detail: 'x' }] } : {}) });
  if (job.validity) writeFileSync(job.spool.validity, '');
  const add = (s) => {
    if (job.validity) appendFileSync(job.spool.validity, `${JSON.stringify(s.intent === 0 ? V(1) : V(1, 1))}\n`);
    spends.push(s);
    stream.add(record('spend', job.key, s));
  };
  add({ intent: 0, type: 'T1', t: 10, burst: null, outcome: 'built', fee: 170000n, ms: 1 });
  process.send({ id, event: 'building', on: true });
  block(job.mode === 'early' ? Date.now() + 200 : deadline + 100);
  process.send({ id, event: 'building', on: false });
  add({ intent: 1, type: 'T1', t: 20, burst: null, outcome: 'built', fee: 170000n, ms: 2 });
  const x = { spends, bursts: [{ id: 'b', t: 5, feasible: true, txs: 1 }], method: { name: 'm', version: 'v1', deterministic: true } };
  if (job.mode === 'boundary' && Date.now() >= deadline) {
    x.stopped = { spends: spends.length, last: { intent: 1, t: 20 } };
    x.validity = job.validity ? { ...V(2, 1), failures: V(1, 1).failures } : null;
  } else {
    x.summary = { counts: { intents: 2 }, ms: 3 };
  }
  const result = spoolJob(x, job, { stream, stop: { at: STOPPED_AT.boundary, elapsedMs: performance.now() - started, attempt, limitMs } });
  process.send({ id, event: 'done', result, memory: { rss: process.memoryUsage().rss } });
});
process.send({ event: 'ready' });
