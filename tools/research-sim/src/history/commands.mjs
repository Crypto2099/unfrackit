// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The commands that read a database: history files and snapshot states, and
// the census, near-cap, collateral and battery-pool reports.
//
// Every command connects read only, refuses mainnet (db.mjs), and writes only
// under the private run directory (paths.mjs).

import { readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { connect, q } from './db.mjs';
import { loadAll } from './sqlfile.mjs';
import { settingsWith, parseSets } from './settings.mjs';
import { loadTreatmentCsl } from './csl.mjs';
import { TxBytes } from './bytes.mjs';
import { ImmutableReader, SshAccess, LocalAccess } from './immutable.mjs';
import { paramsFromRow } from './params.mjs';
import { epochParams } from './txdata.mjs';
import { snapshotBlock, recentWindow, peakWindow, windowOf, fromExtractionRun, windowFromRun } from './windows.mjs';
import { walletHistory } from './history.mjs';
import { historyDir, runDir, JsonLines, writeJson } from './paths.mjs';

export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      opts._.push(a);
      continue;
    }
    const key = a.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    const next = argv[i + 1];
    const val = next === undefined || next.startsWith('--') ? true : (i++, next);
    if (key in opts) opts[key] = [].concat(opts[key], val);
    else opts[key] = val;
  }
  return opts;
}

const list = (x) => (x === undefined ? [] : [].concat(x));

export async function makeContext(opts) {
  const blocks = loadAll();
  const client = await connect({ expectNetwork: opts.expectNetwork });
  const settings = settingsWith(parseSets(list(opts.set)));
  const ctx = { client, blocks, settings, network: client.network, datums: new Map(), scripts: new Map(), nativeRefs: new Map(), resolved: new Map(), epochParams: new Map() };
  if (opts.treatment) {
    if (!opts.treatmentPins) throw new Error('--treatment needs --treatment-pins, the SHA-256 list of the treatment files');
    ctx.CSL = await loadTreatmentCsl(opts.treatment, readFileSync(opts.treatmentPins, 'utf8'));
  }
  const mode = opts.bytes || (client.network === 'mainnet' ? 'immutable' : 'tx_cbor');
  let immutable = null;
  if (mode === 'immutable') {
    if (!opts.immutableDir) throw new Error('--bytes immutable needs --immutable-dir (and --immutable-host for a node on another host)');
    const access = opts.immutableHost ? new SshAccess(opts.immutableHost, opts.immutableDir) : new LocalAccess(opts.immutableDir);
    immutable = new ImmutableReader(access, { chunkSlots: settings.chunkSlots });
  }
  ctx.bytes = new TxBytes({ client, blocks, mode, immutable });
  ctx.run = opts.extractionRun ? fromExtractionRun(opts.extractionRun) : null;
  if (ctx.run && ctx.run.network !== client.network) throw new Error(`the extraction run is ${ctx.run.network}, the database ${client.network}`);
  ctx.snapshot = ctx.run ? await snapshotBlock(ctx, String(ctx.run.snapshot.id)) : await snapshotBlock(ctx, opts.snapshot);
  if (ctx.run && (ctx.snapshot.hash !== ctx.run.snapshot.hash || ctx.snapshot.tx !== ctx.run.snapshot.tx)) throw new Error('the extraction run\'s snapshot differs from the database\'s');
  await epochParams(ctx, [ctx.snapshot.epoch]);
  ctx.params = paramsFromRow(client.network, ctx.epochParams.get(ctx.snapshot.epoch));
  return ctx;
}

export async function resolveWallets(ctx, opts) {
  const given = [...list(opts.wallet)];
  if (opts.wallets) {
    for (const l of readFileSync(opts.wallets, 'utf8').split('\n')) {
      const s = l.replace(/#.*/, '').trim();
      if (s) given.push(s);
    }
  }
  const ids = [];
  for (const g of given) {
    if (/^\d+$/.test(g)) ids.push(Number(g));
    else {
      const r = (await q(ctx.client, ctx.blocks, 'wallet_by_view', { view: { type: 'text', value: g } }))[0];
      if (!r) throw new Error('a stake address given is not in the database');
      ids.push(Number(r.id));
    }
  }
  const uniq = [...new Set(ids)];
  if (!uniq.length) return [];
  const rows = await q(ctx.client, ctx.blocks, 'wallets_by_id', { ids: { type: 'intarr', value: uniq } });
  for (const r of rows) if (r.is_script) throw new Error(`stake credential ${r.id} is a script credential; wallets are key credentials`);
  if (rows.length !== uniq.length) throw new Error('a wallet id given is not in the database');
  return uniq;
}

// The window a frame names: recent, peak, snapshot, or blocks:<b1>-<b2> (a
// test window over block ids).
export async function windowFor(ctx, frame) {
  if (frame === 'snapshot') return null;
  if (ctx.run && (frame === 'recent' || frame === 'peak')) return windowFromRun(ctx, ctx.run.windows[frame]);
  if (frame === 'recent') return recentWindow(ctx, ctx.snapshot);
  if (frame === 'peak') return peakWindow(ctx, ctx.snapshot);
  const m = /^blocks:(\d+)-(\d+)$/.exec(frame);
  if (m) {
    const b2 = Number(m[2]);
    if (b2 > ctx.snapshot.id) throw new Error('a test window must end at or before the snapshot');
    return windowOf(ctx, Number(m[1]), b2);
  }
  throw new Error(`unknown window ${frame}`);
}

async function studyReadable(ctx) {
  const r = (await q(ctx.client, ctx.blocks, 'study_readable'))[0];
  return r.usage && r.has_frame;
}

// The extraction's sample rows by wallet, when its study tables are
// readable: { split, excluded, random }.
async function studySamples(ctx) {
  if (!(await studyReadable(ctx))) return null;
  const m = new Map();
  for (const r of await q(ctx.client, ctx.blocks, 'study_samples')) m.set(Number(r.sa_id), { split: r.split, excluded: r.excluded, random: r.random });
  return m;
}

// History files for each wallet and window. A wallet the extraction's
// reconstruction check excluded is refused; a confirmation-split wallet is
// read only for a run given the transaction of the record that freezes the
// analysis scripts (--analysis-freeze-tx), and the run records it. With
// --from-study the wallets are the extraction's random sample (`random`) or
// every sampled wallet (`all`).
export async function cmdHistory(opts) {
  if (!opts.runId) throw new Error('--run-id is required');
  const ctx = await makeContext(opts);
  if (!ctx.CSL) throw new Error('history needs --treatment and --treatment-pins (cardano-serialization-lib comes only through the treatment)');
  try {
    const samples = await studySamples(ctx);
    let wallets;
    if (opts.fromStudy) {
      if (!samples) throw new Error('--from-study: the study tables are not readable by this role');
      wallets = [...samples].filter(([, s]) => opts.fromStudy === 'all' || s.random).map(([id]) => id);
    } else {
      wallets = await resolveWallets(ctx, opts);
    }
    const splitOf = (sa) => (samples && samples.has(sa) ? samples.get(sa).split : null);
    for (const sa of wallets) {
      if (samples && samples.has(sa) && samples.get(sa).excluded) throw new Error(`wallet ${sa}: the extraction's reconstruction check excluded it`);
      if (splitOf(sa) === 'confirmation' && !opts.analysisFreezeTx) throw new Error(`wallet ${sa} is in the confirmation split; it is read only for a run given --analysis-freeze-tx`);
    }
    const frames = list(opts.window).length ? list(opts.window) : ['recent'];
    const dir = historyDir(ctx.network, opts.runId);
    const summary = {
      network: ctx.network,
      runId: opts.runId,
      snapshot: ctx.snapshot,
      params: ctx.params,
      settings: ctx.settings,
      bytes: ctx.bytes.mode,
      studyTables: samples ? 'read' : 'not readable',
      analysisFreezeTx: opts.analysisFreezeTx || null,
      confirmationWallets: wallets.filter((sa) => splitOf(sa) === 'confirmation').length,
      runs: []
    };
    const windows = new Map();
    for (const f of frames) windows.set(f, await windowFor(ctx, f));
    for (const sa of wallets) {
      let franken = null;
      if (samples && samples.has(sa)) franken = new Set((await q(ctx.client, ctx.blocks, 'study_franken', { sa_id: { type: 'int', value: sa } })).map((r) => r.payment_cred));
      for (const f of frames) {
        const name = `${sa}.${f.replace(/[^a-z0-9-]/g, '_')}.jsonl`;
        const path = join(dir, name);
        const tmp = `${path}.partial`;
        const out = new JsonLines(tmp);
        const t0 = performance.now();
        try {
          const r = await walletHistory(ctx, { saId: sa, frame: f, window: windows.get(f), snapshot: { block: ctx.snapshot.id, tx: ctx.snapshot.tx, hash: ctx.snapshot.hash, slot: ctx.snapshot.slot, time: ctx.snapshot.time, epoch: ctx.snapshot.epoch }, split: splitOf(sa), franken }, out);
          out.close();
          renameSync(tmp, path);
          summary.runs.push({ wallet: sa, window: f, file: name, seconds: (performance.now() - t0) / 1000, ...r });
        } catch (e) {
          out.close();
          rmSync(tmp, { force: true });
          throw e;
        }
      }
    }
    writeJson(join(runDir(ctx.network, opts.runId), 'history-run.json'), summary);
    const totals = summary.runs.reduce((a, r) => ({ files: a.files + 1, spends: a.spends + r.spends, seconds: a.seconds + r.seconds }), { files: 0, spends: 0, seconds: 0 });
    return { ...summary, print: { command: 'history', ...totals, studyTables: summary.studyTables } };
  } finally {
    await ctx.client.end();
  }
}
