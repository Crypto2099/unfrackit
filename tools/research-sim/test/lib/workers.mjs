// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Jobs over a few worker threads of one script: each worker posts 'ready',
// then for each job any number of 'record' messages and one 'done' (or
// 'error'). Resolves to every record, in completion order.

import { Worker } from 'node:worker_threads';

export async function runJobs(script, workerData, jobs, { workers = 4, onRecord = () => {} } = {}) {
  const queue = jobs.map((j, i) => ({ ...j, id: i }));
  const records = [];
  const errors = [];
  const one = () =>
    new Promise((resolve) => {
      const w = new Worker(script, { workerData });
      const next = () => {
        const job = queue.shift();
        if (!job) {
          w.terminate().then(resolve);
          return;
        }
        w.postMessage(job);
      };
      w.on('message', (m) => {
        if (m.type === 'ready') next();
        else if (m.type === 'record') {
          records.push(m.record);
          onRecord(m.record);
        } else if (m.type === 'done') next();
        else if (m.type === 'error') {
          errors.push(m.message);
          next();
        }
      });
      w.on('error', (e) => {
        errors.push(String(e && (e.stack || e)));
        resolve();
      });
    });
  await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, one));
  return { records, errors };
}
