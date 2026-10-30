// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The commands that read a database: history files and snapshot states, and
// the census, near-cap, collateral and battery-pool reports.
//
// Every command connects read only, reads mainnet only through the gate
// (db.mjs), and writes only under the private run directory (paths.mjs).
// Under a grant of the gate, and in a live-fire run on any network, a command
// reads only the wallets the grant allows (allowedWallets).

import { readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { connect, q, Refusal } from './db.mjs';
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

// The command line reader, with each command's options (../options.mjs).
export { parseArgs } from '../options.mjs';

const list = (x) => (x === undefined ? [] : [].concat(x));

// The refusals before any wallet is read: a wallet the extraction's
// reconstruction check excluded, and a confirmation-split wallet without the
// analysis-freeze transaction. `samples` is the study tables' map (wallet to
// { split, excluded }) or null when they are not readable; a wallet outside
// it is not refused.
export function refuseWallets(wallets, samples, analysisFreezeTx) {
  for (const sa of wallets) {
    const s = samples && samples.get(sa);
    if (!s) continue;
    if (s.excluded) throw new Error(`wallet ${sa}: the extraction's reconstruction check excluded it`);
    if (s.split === 'confirmation' && !analysisFreezeTx) throw new Error(`wallet ${sa} is in the confirmation split; it is read only for a run given --analysis-freeze-tx`);
  }
}

// The run a mainnet grant fixes, with the options that would name another
// refused: a --snapshot other than the grant's block (by id or hash), and an
// --extraction-run other than the grant's run or snapshot. Without a grant
// (a test network), the --extraction-run file's run, or null. A live-fire
// run's scope (its grant on mainnet) fixes no run: the snapshot must be the
// pick's block, given by hash, and no --extraction-run is taken; null.
export function runOf(grant, opts) {
  if (grant && grant.path === 'live-fire') {
    if (opts.extractionRun) throw new Refusal('refusing: a live-fire run reads the block its extraction run picked at; it takes no --extraction-run file');
    if (String(opts.snapshot).toLowerCase() !== grant.pick.snapshot.hash) throw new Refusal('refusing: a live-fire run reads the block its extraction run picked at, and no other');
    return null;
  }
  const given = opts.extractionRun ? fromExtractionRun(opts.extractionRun) : null;
  if (!grant) return given;
  const g = grant.run;
  if (opts.snapshot !== undefined && String(opts.snapshot) !== String(g.snapshot.id) && String(opts.snapshot).toLowerCase() !== g.snapshot.hash) {
    throw new Refusal(`refusing: on mainnet the snapshot is the block the extraction's study run ${g.runId} fixed (id ${g.snapshot.id}); give no --snapshot`);
  }
  if (given && (given.runId !== g.runId || given.network !== g.network || given.snapshot.hash !== g.snapshot.hash)) {
    throw new Refusal(`refusing: --extraction-run names another run than the extraction's study run ${g.runId} for the final freeze`);
  }
  return g;
}

// gate: the mainnet path the calling code runs under (db.mjs connect).
// liveFire: the pick of a live-fire run (study/checklog.mjs readPick), set
// only by the live-fire command's code: the connection takes the gate's
// live-fire path on mainnet, and on any network the command reads only the
// pick's wallets at the pick's block and no study table.
export async function makeContext(opts, { gate, liveFire = null } = {}) {
  const blocks = loadAll();
  const client = await connect({ expectNetwork: opts.expectNetwork, blocks }, liveFire ? { gate: 'live-fire', liveFire } : gate ? { gate } : {});
  try {
    return await contextOn(client, blocks, opts, liveFire);
  } catch (e) {
    await client.end().catch(() => {});
    throw e;
  }
}

async function contextOn(client, blocks, opts, liveFire = null) {
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
  ctx.gate = client.gate;
  ctx.scope = scopeOf(client, liveFire);
  ctx.run = runOf(ctx.scope, opts);
  if (ctx.run && ctx.run.network !== client.network) throw new Error(`the extraction run is ${ctx.run.network}, the database ${client.network}`);
  ctx.snapshot = ctx.run ? await snapshotBlock(ctx, String(ctx.run.snapshot.id)) : await snapshotBlock(ctx, opts.snapshot);
  if (ctx.run && (ctx.snapshot.hash !== ctx.run.snapshot.hash || ctx.snapshot.tx !== ctx.run.snapshot.tx)) throw new Error('the extraction run\'s snapshot differs from the database\'s');
  if (ctx.scope && ctx.scope.path === 'live-fire' && (ctx.snapshot.hash !== ctx.scope.pick.snapshot.hash || ctx.snapshot.no !== ctx.scope.pick.snapshot.block_no)) throw new Error('the pick\'s snapshot block differs from the database\'s');
  await epochParams(ctx, [ctx.snapshot.epoch]);
  ctx.params = paramsFromRow(client.network, ctx.epochParams.get(ctx.snapshot.epoch));
  return ctx;
}

// What restricts the wallets a connection's commands read: the gate's grant
// on mainnet; a live-fire run's pick on a test network; or nothing (null).
export function scopeOf(client, liveFire) {
  if (client.gate) return client.gate;
  if (!liveFire) return null;
  if (liveFire.network !== client.network) throw new Refusal(`refusing: the live-fire pick is for ${liveFire.network}, the database ${client.network}`);
  return { path: 'live-fire', pick: liveFire };
}

// The wallets a scope allows, by stake-credential id, or null when nothing
// restricts them. Final freeze: the sampled wallets of the gate's run
// (study.sample, whose mark the gate checked), from `samples` when the caller
// has read them. Live-fire: the pick's wallets, each looked up by its stake
// address.
export async function allowedWallets(ctx, samples = undefined) {
  const s = ctx.scope;
  if (!s) return null;
  if (s.path === 'live-fire') {
    const ids = new Set();
    for (const w of s.pick.wallets) {
      const r = (await q(ctx.client, ctx.blocks, 'wallet_by_view', { view: { type: 'text', value: w.stake_address } }))[0];
      if (!r) throw new Error('a wallet of the live-fire pick is not in the database');
      ids.add(Number(r.id));
    }
    return ids;
  }
  const m = samples !== undefined ? samples : await studySamples(ctx);
  if (!m) throw new Refusal('refusing: after the final freeze every wallet read on mainnet must be in the study sample, and this role cannot read study.sample');
  return new Set(m.keys());
}

// Refuses wallets outside what a scope allows, before anything of them is
// read. The message names no wallet.
export function refuseOutside(allowed, wallets, scope) {
  if (!allowed) return;
  if (wallets.every((sa) => allowed.has(sa))) return;
  throw new Refusal(scope && scope.path === 'live-fire'
    ? 'refusing: a live-fire run reads only the wallets its extraction run picked, and a wallet named is not one of them'
    : 'refusing: after the final freeze a command reads on mainnet only wallets of the study sample (study.sample), and a wallet named is not in it');
}

// The wallets named by --wallet and --wallets, as stake-credential ids. A
// stake address is looked up to learn its id; with `allowed`, every id must
// be in it before any other row of a wallet is read.
export async function resolveWallets(ctx, opts, allowed = null) {
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
  refuseOutside(allowed, uniq, ctx.scope);
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
// readable: { split, excluded, random, randomRecent, randomPeak, stratumRecent }.
// `random` is the random sample of either frame; the two frames' memberships
// and the recent frame's purposive strata are beside it.
export async function studySamples(ctx) {
  if (!(await studyReadable(ctx))) return null;
  return samplesFromRows(await q(ctx.client, ctx.blocks, 'study_samples'));
}

// The `study_samples` rows as a map by wallet.
export function samplesFromRows(rows) {
  const m = new Map();
  for (const r of rows) m.set(Number(r.sa_id), { split: r.split, excluded: r.excluded, random: r.random, randomRecent: r.random_recent, randomPeak: r.random_peak, stratumRecent: r.stratum_recent });
  return m;
}

// What a history header records of a wallet's sample membership: null when
// the study tables were not read or the wallet is in none of the samples.
export function sampleMembership(samples, sa) {
  if (!samples || !samples.has(sa)) return null;
  const s = samples.get(sa);
  return { recentRandom: !!s.randomRecent, peakRandom: !!s.randomPeak, recentStratum: !!s.stratumRecent };
}

// The wallets a history run reads, with the study tables' sample rows (null
// when they are not read), after every refusal and before any wallet's
// outputs are read. A live-fire run reads no study table and takes no
// --from-study. Under a scope, every wallet must be one it allows; then the
// extraction's own refusals (refuseWallets).
export async function historyWallets(ctx, opts) {
  const live = !!ctx.scope && ctx.scope.path === 'live-fire';
  if (live && opts.fromStudy) throw new Refusal('refusing: a live-fire run reads the wallets its extraction run picked; it takes no --from-study');
  const samples = live ? null : await studySamples(ctx);
  const allowed = await allowedWallets(ctx, samples);
  let wallets;
  if (opts.fromStudy) {
    if (!samples) throw new Error('--from-study: the study tables are not readable by this role');
    wallets = [...samples].filter(([, s]) => opts.fromStudy === 'all' || s.random).map(([id]) => id);
    refuseOutside(allowed, wallets, ctx.scope);
  } else {
    wallets = await resolveWallets(ctx, opts, allowed);
  }
  refuseWallets(wallets, samples, opts.analysisFreezeTx);
  return { wallets, samples };
}

// History files for each wallet and window. A wallet the extraction's
// reconstruction check excluded is refused; a confirmation-split wallet is
// read only for a run given the transaction of the record that freezes the
// analysis scripts (--analysis-freeze-tx), and the run records it. With
// --from-study the wallets are the extraction's random sample (`random`) or
// every sampled wallet (`all`).
// scope.liveFire: the pick of a live-fire run, set by the live-fire command's
// code (makeContext).
export async function cmdHistory(opts, scope = {}) {
  if (!opts.runId) throw new Error('--run-id is required');
  const ctx = await makeContext(opts, scope);
  if (!ctx.CSL) throw new Error('history needs --treatment and --treatment-pins (cardano-serialization-lib comes only through the treatment)');
  try {
    const { wallets, samples } = await historyWallets(ctx, opts);
    const splitOf = (sa) => (samples && samples.has(sa) ? samples.get(sa).split : null);
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
          const r = await walletHistory(ctx, { saId: sa, frame: f, window: windows.get(f), snapshot: { block: ctx.snapshot.id, tx: ctx.snapshot.tx, hash: ctx.snapshot.hash, slot: ctx.snapshot.slot, time: ctx.snapshot.time, epoch: ctx.snapshot.epoch }, split: splitOf(sa), sample: sampleMembership(samples, sa), franken }, out);
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
