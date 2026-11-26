// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Stand-ins for the commands a live-fire run's stages run, for the tests:
// the study's stand-ins (study-stubs.mjs), with the replay stand-in
// returning what the live-fire checks read (the validity failures in the
// totals, the pool's watchdog stops beside them). options: those of
// stubCommands, plus stops (the pool's watchdog stops) and validityFailed
// (each a number, or a map by stage), throws (a stage and the error it
// throws), readOnly (a stage whose run directory is
// made unwritable once it has written, so that deleting it fails).

import { chmodSync } from 'node:fs';
import { stubCommands } from './study-stubs.mjs';
import { runDir } from '../../src/history/paths.mjs';

const stageOf = (runId) => String(runId).split('/')[1];
const byStage = (v, stage) => (v && typeof v === 'object' ? v[stage] ?? 0 : v ?? 0);

export function liveFireStubs({ network = 'mainnet', stops = 0, validityFailed = 0, throws = null, readOnly = null, ...rest } = {}) {
  const base = stubCommands({ network, ...rest });
  const wrap = (name, totals) => async (opts) => {
    const stage = stageOf(opts.runId);
    if (throws && throws.stage === stage) throw throws.error;
    const r = await base[name](opts);
    if (readOnly === stage) chmodSync(runDir(name === 'history' ? opts.expectNetwork : network, opts.runId.split('/')[0]), 0o500);
    if (!totals) return r;
    const t = totals(stage);
    const workers = { started: 4, recycled: 0, watchdogStops: byStage(stops, stage), machineReruns: 0 };
    return { ...r, print: { ...r.print, totals: t, workers }, failed: t.validity.failed > 0 };
  };
  const replayTotals = (stage) => ({ wallets: 4, jobs: 40, refused: 0, triggers: 0, validity: { txs: 120, failed: byStage(validityFailed, stage) } });
  return {
    history: wrap('history'),
    replay: wrap('replay', replayTotals)
  };
}
