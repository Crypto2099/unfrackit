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
// The replay stand-in writes a replay stage (src/out/stage.mjs) as the replay
// command does: its wallets are the history files of the directories it is
// given, or the shapes it names; each wallet's segment holds STUB_RECORDS
// refused records whose reason is made from the command, the stage, the
// wallet, the record's number and the options that decide the records, and
// the stage is joined at its end. It resumes as the replay command does, at
// the wallets the stage has not done, runs only its share when given
// --shard or --wallet-indexes (src/replay/shards.mjs), ending without the
// join while other wallets remain, prints nothing new for a stage that has
// ended, and pushes each wallet it runs to `ran` as [stage, wallet index].
//
// The collateral stand-in also writes collateral.json, whose measurement
// gives `share` (the share under 20 ADA; 0.75 when absent, null for a
// measurement that found no transaction), as the study reads it.
//
// options: { network, calls (an array each call is pushed to: [stage,
// options]), ran, share, hang (a stage that writes half its records, a
// `partial` file, prints HUNG and never returns; a replay stage instead
// completes the first half of its wallets and writes half the next one's
// records to its spool), fail (a stage that throws), splits, samples }.

import { join, basename } from 'node:path';
import { runDir, historyDir, ensureDir, writePrivate, writeJson } from '../../src/history/paths.mjs';
import { refuseWallets } from '../../src/history/commands.mjs';
import { walletsOf, recordOptions } from '../../src/replay/commands.mjs';
import { openStage, walletList } from '../../src/out/stage.mjs';
import { selectionOf } from '../../src/replay/shards.mjs';
import { record } from '../../src/out/records.mjs';
import { workerCount } from '../../src/replay/pool.mjs';

export const STUB_RECORDS = 6;
export const STUB_SPLITS = Object.freeze(['exploration', 'confirmation', null, 'exploration']);

const stageOf = (runId) => String(runId).split('/')[1];
const studyOf = (runId) => String(runId).split('/')[0];

function normalized(opts) {
  const id = studyOf(opts.runId);
  const strip = (v) => (typeof v === 'string' ? v.split(id).join('<id>') : Array.isArray(v) ? v.map(strip) : v);
  return Object.fromEntries(Object.keys(opts).filter((k) => k !== 'runId').sort().map((k) => [k, strip(opts[k])]));
}

const hang = () => {
  process.stdout.write('HUNG\n');
  return new Promise(() => setInterval(() => {}, 1000));
};

// The replay stand-in: a replay stage over the wallets opts names.
async function stubReplay(opts, { net, stage, hangs, ran }) {
  const wallets = walletsOf(opts, { stream: 'synthetic' });
  const decided = normalized({ ...recordOptions(opts), runId: opts.runId });
  const list = walletList(wallets);
  const selection = selectionOf(opts, { plan: opts.plan, wallets: list });
  const out = await openStage(runDir(net, opts.runId), { header: { command: 'replay', options: decided }, wallets: list, machine: opts.machine, workers: workerCount(opts.workers, '--workers'), selection });
  try {
    for (const [wi, w] of wallets.entries()) {
      if (!out.runs(wi)) continue;
      ran.push([stage, wi]);
      const wallet = w.spec.kind === 'shape' ? w.spec.name : Number(basename(w.spec.path).split('.')[0]);
      const key = { wallet, window: w.spec.kind === 'shape' ? 'synthetic' : opts.plan, arm: 'observed', variant: 'default', method: 'stub', change: 'default', collateral: 'none-needed', repetition: 1 };
      const seg = out.segment(wi);
      for (let n = 0; n < STUB_RECORDS; n++) {
        if (hangs && wi === Math.floor(wallets.length / 2) && n === STUB_RECORDS / 2) await hang();
        seg.write(record('refused', key, { reason: JSON.stringify({ command: 'replay', stage, wi, n, opts: decided }), ms: n }));
      }
      await out.complete(wi, seg, { wallet, totals: { jobs: 1, refused: STUB_RECORDS, triggers: 0 }, start: new Date() });
    }
    const totals = await out.finish();
    return { print: { command: 'replay', stage, ended: out.ended, ...(out.progress ? { shard: out.progress } : {}), totals, records: out.counts }, ended: out.ended };
  } finally {
    out.close();
  }
}

export function stubCommands({ network, calls = [], ran = [], hang: hangStage = null, fail = null, splits = STUB_SPLITS, samples = null, share = 0.75 } = {}) {
  const make = (command, networkOf) => async (opts) => {
    const stage = stageOf(opts.runId);
    calls.push([stage, opts]);
    if (fail === stage) throw new Error(`stand-in failure in ${stage}`);
    const net = networkOf(opts);
    if (command === 'replay') return stubReplay(opts, { net, stage, hangs: hangStage === stage, ran });
    const dir = ensureDir(runDir(net, opts.runId));
    if (command === 'history') {
      const wallets = splits.map((_s, k) => k + 1);
      if (samples) refuseWallets(wallets, samples, opts.analysisFreezeTx || null);
      for (const w of wallets) writePrivate(join(historyDir(net, opts.runId), `${w}.${opts.window}.jsonl`), JSON.stringify({ kind: 'header', wallet: w, frame: opts.window, split: splits[w - 1] }) + '\n');
      writeJson(join(dir, 'history-run.json'), { files: wallets.length });
    }
    if (command === 'collateral') writeJson(join(dir, 'collateral.json'), { command, result: { shareUnder20Ada: share, measured: share === null ? 0 : 40 } });
    const lines = Array.from({ length: STUB_RECORDS }, (_x, n) => JSON.stringify({ command, stage, n, opts: normalized(opts) }) + '\n');
    if (hangStage === stage) {
      writePrivate(join(dir, 'records.jsonl'), lines.slice(0, STUB_RECORDS / 2).join(''));
      writePrivate(join(dir, 'partial'), 'written before the kill\n');
      await hang();
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
    fidelity: make('fidelity', study),
    replay: make('replay', study)
  };
}
