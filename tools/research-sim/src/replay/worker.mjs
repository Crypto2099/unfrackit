// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The worker process every replay runs in, forked by
// replay/pool.mjs with an IPC channel; its argument is the JSON of
// { treatmentDir, pinsPath }. CSL's calls are synchronous, so work that hangs
// can only be stopped by killing its process; the parent does that when a
// watchdog falls, and runs the work again in a fresh worker.
//
// The worker loads the treatment itself (digest-checked, one CSL instance per
// process), makes each job's method from the registry, reads its wallet (a
// history file or a synthetic shape), and answers with plain data. A replay
// job's records are built here and written to the job's spool (job.spool,
// out/spool.mjs); its answer is what replay/run.mjs's spoolJob returns: the
// spool's counts, the refusal, the validity summary and H-6's fields, never
// the records themselves. Messages:
//   in   { id, task: 'replay', job, recordMachineErrors }
//   out  { event: 'ready' }  the treatment is loaded
//        { id, event: 'done', result, memory }
//        { id, event: 'error', error, stop, machine, memory }
//        { event: 'fatal', error }  an uncaught exception; the worker exits
// recordMachineErrors: whether this replay records the machine's errors
// (kit/machine.mjs), which it does when it runs again after one; `machine`
// says that the job's error is one. memory: after the job, CSL's WebAssembly
// memory and its ceiling (cslBytes, cslCeilingBytes; null for a build
// without one), the resident size and V8's heap (kit/heap.mjs memoryReport).
// The worker exits when its parent's channel closes.

import { readFileSync } from 'node:fs';
import { loadTreatment } from '../treatment/bridge.mjs';
import { makeMethod } from '../methods/registry.mjs';
import { replay } from './engine.mjs';
import { loadSource } from './source.mjs';
import { spoolJob } from './run.mjs';
import { StopPoint } from '../treatment/run.mjs';
import { recordMachineErrors, isMachineError } from '../kit/machine.mjs';
import { cslMemory, memoryReport } from '../kit/heap.mjs';

const send = (m) => process.send(m);

process.on('disconnect', () => process.exit(0));
process.on('uncaughtException', (e) => {
  try {
    process.send({ event: 'fatal', error: String((e && e.stack) || e) }, () => process.exit(1));
  } catch {
    process.exit(1);
  }
});

const workerData = JSON.parse(process.argv[2]);
const pins = workerData.pinsPath ? readFileSync(workerData.pinsPath, 'utf8') : undefined;
const T = await loadTreatment(workerData.treatmentDir, pins);
const csl = cslMemory(T);

process.on('message', async ({ id, task, job, recordMachineErrors: record = false }) => {
  try {
    recordMachineErrors(record);
    const source = loadSource(T, job.source);
    if (task === 'replay') {
      if (!job.spool) throw new Error('a replay job names its spool files');
      const method = makeMethod(T, job.method.name, job.method.options || {});
      const result = await replay(T, source.params, source, { ...job, method });
      result.method = { name: method.name, version: method.version, deterministic: method.deterministic };
      send({ id, event: 'done', result: spoolJob(result, job), memory: memoryReport(csl) });
    } else {
      throw new Error(`unknown task ${task}`);
    }
  } catch (e) {
    send({ id, event: 'error', error: String((e && e.stack) || e), stop: e instanceof StopPoint, machine: isMachineError(e), memory: memoryReport(csl) });
  } finally {
    recordMachineErrors(false);
  }
});
send({ event: 'ready' });
