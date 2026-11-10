// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The oracle's worker thread: it loads the treatment (checked against its
// pins) once, then runs one oracle search per message and posts its result.
// The search stops on its own budget; CSL and HiGHS calls are synchronous and
// cannot be interrupted from inside, so the parent's watchdog (oracle.mjs)
// stops a call that hangs. recordMachineErrors: whether this call records
// the machine's errors (kit/machine.mjs), which it does when it runs again
// after one; `machine` says that a call's error is one.

import { parentPort, workerData } from 'node:worker_threads';
import { loadTreatment } from '../treatment/bridge.mjs';
import { searchOracle } from './search.mjs';
import { OracleRefusal } from './spend.mjs';
import { settle } from '../kit/heap.mjs';
import { recordMachineErrors, isMachineError } from '../kit/machine.mjs';

const T = await loadTreatment(workerData.treatmentDir, workerData.pinsText || undefined);
parentPort.postMessage({ type: 'ready' });

parentPort.on('message', async (job) => {
  try {
    recordMachineErrors(job.recordMachineErrors === true);
    await settle();
    const r = await searchOracle(T, job.state, job.spend, job.params, job.policy, job.opts);
    parentPort.postMessage({ type: 'done', id: job.id, result: r });
  } catch (e) {
    parentPort.postMessage({ type: 'error', id: job.id, refusal: e instanceof OracleRefusal, machine: isMachineError(e), message: String(e && (e.stack || e.message || e)) });
  } finally {
    recordMachineErrors(false);
  }
});
