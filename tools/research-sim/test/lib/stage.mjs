// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A replay stage for the tests (src/out/stage.mjs): opened over the given
// replay wallets ({ spec }) under the private root with a stand-in header,
// and its joined streams read back decompressed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { runDir } from '../../src/history/paths.mjs';
import { openStage, walletList } from '../../src/out/stage.mjs';

export function testStage(runId, wallets, { network = 'synthetic', header = { command: 'test' }, machine, workers = 1 } = {}) {
  return openStage(runDir(network, runId), { header, wallets: walletList(wallets), machine, workers });
}

// A stage's joined records or timings, decompressed, as text.
export const stageText = (dir, kind = 'records') => gunzipSync(readFileSync(join(dir, `${kind}.jsonl.gz`))).toString('utf8');

// A stage's log under a machine label, one entry per line.
export const stageLog = (dir, label = 'local') => readFileSync(join(dir, 'machines', `${label}.log.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
