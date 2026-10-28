// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The oracle's worker thread: it loads the treatment (checked against its
// pins) once, then runs one oracle search per message, posting every
// improvement of the best as it is found so that the parent holds the best
// so far if it has to terminate the worker. CSL and HiGHS calls are
// synchronous and cannot be interrupted from inside, so the parent's
// termination is the hard limit; the search's own deadline normally ends it
// first.

import { parentPort, workerData } from 'node:worker_threads';
import { loadTreatment } from '../treatment/bridge.mjs';
import { searchOracle } from './search.mjs';
import { OracleRefusal } from './spend.mjs';
import { settle } from '../kit/heap.mjs';

const T = await loadTreatment(workerData.treatmentDir, workerData.pinsText || undefined);
parentPort.postMessage({ type: 'ready' });

parentPort.on('message', async (job) => {
  try {
    await settle();
    const r = await searchOracle(T, job.state, job.spend, job.params, job.policy, {
      ...job.opts,
      onProgress: (best, tx) => parentPort.postMessage({ type: 'best', id: job.id, best, tx })
    });
    parentPort.postMessage({ type: 'done', id: job.id, result: r });
  } catch (e) {
    parentPort.postMessage({ type: 'error', id: job.id, refusal: e instanceof OracleRefusal, message: String(e && (e.stack || e.message || e)) });
  }
});
