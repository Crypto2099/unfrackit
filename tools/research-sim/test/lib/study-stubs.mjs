// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Stand-ins for the commands a study's stages run (src/study/study.mjs), for
// the tests, with no database and no treatment. Each writes records.jsonl in
// its stage's run directory: lines made from its command and its options,
// with the study run id taken out, so that two study runs given the same
// options write the same records. The history stand-in also writes one
// history file per wallet whose header carries the split `splits` gives, so
// that the fidelity stage's selection can be checked; given `samples`, it
// first applies the history command's own refusals (refuseWallets).
//
// options: { network, calls (an array each call is pushed to: [stage,
// options]), hang (a stage that writes half its records, a `partial` file,
// prints HUNG and never returns), fail (a stage that throws), splits,
// samples }.

import { join } from 'node:path';
import { runDir, historyDir, ensureDir, writePrivate, writeJson } from '../../src/history/paths.mjs';
import { refuseWallets } from '../../src/history/commands.mjs';

export const STUB_RECORDS = 6;
export const STUB_SPLITS = Object.freeze(['exploration', 'confirmation', null, 'exploration']);

const stageOf = (runId) => String(runId).split('/')[1];
const studyOf = (runId) => String(runId).split('/')[0];

function normalized(opts) {
  const id = studyOf(opts.runId);
  const strip = (v) => (typeof v === 'string' ? v.split(id).join('<id>') : Array.isArray(v) ? v.map(strip) : v);
  return Object.fromEntries(Object.keys(opts).filter((k) => k !== 'runId').sort().map((k) => [k, strip(opts[k])]));
}

export function stubCommands({ network, calls = [], hang = null, fail = null, splits = STUB_SPLITS, samples = null } = {}) {
  const make = (command, networkOf) => async (opts) => {
    const stage = stageOf(opts.runId);
    calls.push([stage, opts]);
    if (fail === stage) throw new Error(`stand-in failure in ${stage}`);
    const net = networkOf(opts);
    const dir = ensureDir(runDir(net, opts.runId));
    if (command === 'history') {
      const wallets = splits.map((_s, k) => k + 1);
      if (samples) refuseWallets(wallets, samples, opts.analysisFreezeTx || null);
      for (const w of wallets) writePrivate(join(historyDir(net, opts.runId), `${w}.${opts.window}.jsonl`), JSON.stringify({ kind: 'header', wallet: w, frame: opts.window, split: splits[w - 1] }) + '\n');
      writeJson(join(dir, 'history-run.json'), { files: wallets.length });
    }
    const lines = Array.from({ length: STUB_RECORDS }, (_x, n) => JSON.stringify({ command, stage, n, opts: normalized(opts) }) + '\n');
    if (hang === stage) {
      writePrivate(join(dir, 'records.jsonl'), lines.slice(0, STUB_RECORDS / 2).join(''));
      writePrivate(join(dir, 'partial'), 'written before the kill\n');
      process.stdout.write('HUNG\n');
      await new Promise(() => setInterval(() => {}, 1000));
    }
    writePrivate(join(dir, 'records.jsonl'), lines.join(''));
    return { print: { command, stage, records: STUB_RECORDS } };
  };
  const study = () => network;
  return {
    history: make('history', (o) => o.expectNetwork),
    census: make('census', (o) => o.expectNetwork),
    'near-cap': make('near-cap', (o) => o.expectNetwork),
    collateral: make('collateral', (o) => o.expectNetwork),
    'battery-pools': make('battery-pools', (o) => o.network),
    fidelity: make('fidelity', study),
    replay: make('replay', study),
    battery: make('battery', study)
  };
}
