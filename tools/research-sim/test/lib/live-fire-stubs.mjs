// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Stand-ins for the commands a live-fire run's stages run, for the tests:
// the study's stand-ins (study-stubs.mjs), with the replay and battery
// stand-ins returning the totals the live-fire checks read (a replay's
// time-outs, the validity failures). options: those of stubCommands, plus
// timeouts and validityFailed (each a number, or a map by stage), throws (a
// stage and the error it throws), readOnly (a stage whose run directory is
// made unwritable once it has written, so that deleting it fails).

import { chmodSync } from 'node:fs';
import { stubCommands } from './study-stubs.mjs';
import { runDir } from '../../src/history/paths.mjs';

const stageOf = (runId) => String(runId).split('/')[1];
const byStage = (v, stage) => (v && typeof v === 'object' ? v[stage] ?? 0 : v ?? 0);

export function liveFireStubs({ network = 'mainnet', timeouts = 0, validityFailed = 0, throws = null, readOnly = null, ...rest } = {}) {
  const base = stubCommands({ network, ...rest });
  const wrap = (name, totals) => async (opts) => {
    const stage = stageOf(opts.runId);
    if (throws && throws.stage === stage) throw throws.error;
    const r = await base[name](opts);
    if (readOnly === stage) chmodSync(runDir(name === 'history' ? opts.expectNetwork : name === 'battery-pools' ? opts.network : network, opts.runId.split('/')[0]), 0o500);
    if (!totals) return r;
    const t = totals(stage);
    return { ...r, print: { ...r.print, totals: t }, failed: t.validity.failed > 0 };
  };
  const replayTotals = (stage) => ({ wallets: 4, jobs: 40, timeouts: byStage(timeouts, stage), refused: 0, validity: { txs: 120, failed: byStage(validityFailed, stage) } });
  const batteryTotals = (stage) => ({ wallets: 4, runs: 80, timeouts: 0, oracle: 12, validity: { txs: 90, failed: byStage(validityFailed, stage) } });
  return {
    history: wrap('history'),
    'battery-pools': wrap('battery-pools'),
    replay: wrap('replay', replayTotals),
    battery: wrap('battery', batteryTotals)
  };
}
