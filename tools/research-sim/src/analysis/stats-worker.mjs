// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The bootstrap pool's thread: computes one chunk of resamples per message.

import { parentPort } from 'node:worker_threads';
import { runChunk } from './stats.mjs';

parentPort.on('message', ({ id, task }) => {
  parentPort.postMessage({ id, result: runChunk(task) });
});
