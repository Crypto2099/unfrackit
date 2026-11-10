// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The worker thread every replay and battery spend runs in. CSL's calls are
// synchronous, so work that hangs can only be stopped by terminating its
// thread; the parent (replay/pool.mjs) does that when a watchdog falls, and
// runs the work again in a fresh worker.
//
// The worker loads the treatment itself (digest-checked, one CSL instance per
// thread), makes each job's method from the registry, reads its wallet (a
// history file or a synthetic shape), and answers with plain data. Messages:
//   in   { id, task: 'replay', job, recordMachineErrors }
//        { id, task: 'battery', job }  (job.recordMachineThrough)
//   out  { id, event: 'answering', spend }  a method is about to answer
//        { id, event: 'answered', spend }   it returned
//        { id, event: 'spend', spend, result }  a battery spend's result
//        { id, event: 'done', result }
//        { id, event: 'error', error, stop, machine }
// recordMachineErrors: whether this replay records the machine's errors
// (kit/machine.mjs), which it does when it runs again after one; `machine`
// says that the job's error is one.

import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { loadTreatment } from '../treatment/bridge.mjs';
import { makeMethod } from '../methods/registry.mjs';
import { replay } from './engine.mjs';
import { loadSource } from './source.mjs';
import { batteryWallet } from '../battery/runner-core.mjs';
import { StopPoint } from '../treatment/run.mjs';
import { recordMachineErrors, isMachineError } from '../kit/machine.mjs';

const pins = workerData.pinsPath ? readFileSync(workerData.pinsPath, 'utf8') : undefined;
const T = await loadTreatment(workerData.treatmentDir, pins);

parentPort.on('message', async ({ id, task, job, recordMachineErrors: record = false }) => {
  try {
    recordMachineErrors(task === 'replay' ? record : job.recordMachineThrough !== null && job.recordMachineThrough !== undefined);
    const source = loadSource(T, job.source);
    if (task === 'replay') {
      const method = makeMethod(T, job.method.name, job.method.options || {});
      const result = await replay(T, source.params, source, { ...job, method });
      result.method = { name: method.name, version: method.version, deterministic: method.deterministic };
      parentPort.postMessage({ id, event: 'done', result });
    } else if (task === 'battery') {
      const hooks = {
        answering: (spend) => parentPort.postMessage({ id, event: 'answering', spend }),
        answered: (spend) => parentPort.postMessage({ id, event: 'answered', spend }),
        result: (spend, result) => parentPort.postMessage({ id, event: 'spend', spend, result })
      };
      const result = await batteryWallet(T, source, job, hooks);
      parentPort.postMessage({ id, event: 'done', result });
    } else {
      throw new Error(`unknown task ${task}`);
    }
  } catch (e) {
    parentPort.postMessage({ id, event: 'error', error: String((e && e.stack) || e), stop: e instanceof StopPoint, machine: isMachineError(e) });
  } finally {
    recordMachineErrors(false);
  }
});
parentPort.postMessage({ event: 'ready' });
