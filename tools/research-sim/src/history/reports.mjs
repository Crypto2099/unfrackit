// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The descriptive commands, separate from the history files:
// - census: per wallet at the snapshot, the UTxO count, the largest UTxO's
//   value bytes, near-cap status, locked ADA (the sum of today's minimum over
//   token UTxOs) and the excess ADA above it on token UTxOs;
// - near-cap: per epoch boundary from the Mary hard fork to the snapshot, how
//   many of the wallets have a largest UTxO whose Value exceeds 50, 80 and 90
//   percent of the value-size limit in force;
// - collateral: over the recent window, every script-executing transaction
//   whose collateral inputs all sit at key addresses: how many carry less
//   than 20 ADA of collateral in total, the distribution of collateral coin,
//   how many have a collateral return, and how many collateral inputs carry
//   tokens;
// - battery-pools: the T1 amounts and T5 shares of a run's history files.
//
// Value bytes are the ledger's serialization of the Value (value.mjs); a
// UTxO's minimum is cardano-serialization-lib's min_ada_for_output on the
// output re-encoded from db-sync's columns, at the snapshot's coins per UTxO
// byte. Per-wallet rows are written to the private run directory only.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { q, explain } from './db.mjs';
import { makeContext, resolveWallets } from './commands.mjs';
import { lifeRow, loadExtras, reencode, loadLife } from './wallet.mjs';
import { valueSize, assetMap, mergeAssets } from './value.mjs';
import { minAdaForOutput } from './csl.mjs';
import { valueLimit } from './params.mjs';
import { recentWindow } from './windows.mjs';
import { decodeOutputBytes } from './output.mjs';
import { runDir, historyDir, JsonLines, writeJson } from './paths.mjs';

const BATCH = 500;

async function studyReadable(ctx) {
  const r = (await q(ctx.client, ctx.blocks, 'study_readable'))[0];
  return r.usage && r.has_frame;
}

// The wallet set: --wallets/--wallet, or the extraction's set when its study
// tables are readable (--from-study), or every key stake credential with an
// output (--all-wallets, for a test network).
async function walletSet(ctx, opts, studyQuery) {
  if (opts.fromStudy) {
    if (!(await studyReadable(ctx))) throw new Error('--from-study: the study tables are not readable by this role');
    return { ids: (await q(ctx.client, ctx.blocks, studyQuery)).map((r) => Number(r.id)), source: 'study' };
  }
  if (opts.allWallets) return { ids: (await q(ctx.client, ctx.blocks, 'key_wallets_with_outputs', { t: { type: 'int', value: ctx.snapshot.tx } })).map((r) => Number(r.id)), source: 'all' };
  return { ids: await resolveWallets(ctx, opts), source: 'given' };
}

async function assetsOf(ctx, ids) {
  const m = new Map();
  for (let i = 0; i < ids.length; i += 5000) {
    for (const a of await q(ctx.client, ctx.blocks, 'output_assets', { ids: { type: 'intarr', value: ids.slice(i, i + 5000) } })) {
      const k = Number(a.tx_out_id);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push({ policy: a.policy, name: a.name, qty: BigInt(a.qty) });
    }
  }
  return m;
}

const limitShare = (bytes, limit, pct) => limit !== null && bytes * 100 > limit * pct;

export async function cmdCensus(opts) {
  if (!opts.runId) throw new Error('--run-id is required');
  const ctx = await makeContext(opts);
  if (!ctx.CSL) throw new Error('census needs --treatment and --treatment-pins');
  try {
    const t0 = performance.now();
    const set = await walletSet(ctx, opts, 'study_recent_eligible');
    const limit = valueLimit(ctx.epochParams.get(ctx.snapshot.epoch));
    const out = new JsonLines(join(runDir(ctx.network, opts.runId), 'census.jsonl'));
    const plan = opts.explain ? await explain(ctx.client, ctx.blocks, 'utxos_at_block', { sa_ids: { type: 'intarr', value: set.ids.slice(0, BATCH) }, block_id: { type: 'int', value: ctx.snapshot.id } }) : null;
    let nWallets = 0;
    let nUtxos = 0;
    let sqlMs = 0;
    for (let i = 0; i < set.ids.length; i += BATCH) {
      const part = set.ids.slice(i, i + BATCH);
      const s0 = performance.now();
      const rows = await q(ctx.client, ctx.blocks, 'utxos_at_block', { sa_ids: { type: 'intarr', value: part }, block_id: { type: 'int', value: ctx.snapshot.id } });
      const assets = await assetsOf(ctx, rows.map((r) => Number(r.tx_out_id)));
      sqlMs += performance.now() - s0;
      const life = rows.map((r) => ({ ...lifeRow({ ...r, created_tx: r.tx_id, consumed_tx: null }, assets.get(Number(r.tx_out_id)) || []), sa: Number(r.sa_id) }));
      ctx.resolved = new Map();
      await loadExtras(ctx, life);
      const by = new Map(part.map((x) => [x, []]));
      for (const r of life) by.get(r.sa).push(r);
      for (const sa of part) {
        const us = by.get(sa);
        let largest = 0;
        let locked = 0n;
        let excess = 0n;
        let tokenUtxos = 0;
        for (const r of us) {
          const vb = valueSize(r.coin, r.assets);
          if (vb > largest) largest = vb;
          if (r.assets.length) {
            tokenUtxos++;
            const min = minAdaForOutput(ctx.CSL, reencode(ctx, r).bytes, ctx.params.coinsPerUtxoByte);
            locked += min;
            excess += r.coin > min ? r.coin - min : 0n;
          }
        }
        out.write({ wallet: sa, utxos: us.length, tokenUtxos, largestValueBytes: largest, nearCap50: limitShare(largest, limit, 50), nearCap80: limitShare(largest, limit, 80), nearCap90: limitShare(largest, limit, 90), lockedAda: locked, excessAda: excess });
        nWallets++;
        nUtxos += us.length;
      }
    }
    out.close();
    const summary = { command: 'census', network: ctx.network, snapshot: ctx.snapshot, valueLimit: limit, walletSource: set.source, wallets: nWallets, utxos: nUtxos, seconds: (performance.now() - t0) / 1000, sqlSeconds: sqlMs / 1000, plan };
    writeJson(join(runDir(ctx.network, opts.runId), 'census-run.json'), summary);
    return { ...summary, print: { command: 'census', wallets: nWallets, utxos: nUtxos, seconds: summary.seconds, sqlSeconds: summary.sqlSeconds } };
  } finally {
    await ctx.client.end();
  }
}

export async function cmdNearCap(opts) {
  if (!opts.runId) throw new Error('--run-id is required');
  const ctx = await makeContext(opts);
  try {
    const t0 = performance.now();
    const set = await walletSet(ctx, opts, 'study_random_samples');
    const from = Number((await q(ctx.client, ctx.blocks, 'first_mary_epoch'))[0].e);
    const to = ctx.snapshot.epoch - 1;
    const lasts = to >= from ? await q(ctx.client, ctx.blocks, 'epoch_last_blocks', { from_epoch: { type: 'int', value: from }, to_epoch: { type: 'int', value: to } }) : [];
    const limits = new Map((await q(ctx.client, ctx.blocks, 'epoch_limits', { from_epoch: { type: 'int', value: from }, to_epoch: { type: 'int', value: ctx.snapshot.epoch } })).map((r) => [Number(r.epoch_no), valueLimit(r)]));
    // Boundaries: the end of every epoch from the first Mary epoch to the one
    // before the snapshot's, then the snapshot block.
    const points = [];
    for (const l of lasts) {
      const t = Number((await q(ctx.client, ctx.blocks, 't_of_block', { block_id: { type: 'int', value: Number(l.last_block) } }))[0].t);
      points.push({ epoch: Number(l.epoch_no), block: Number(l.last_block), t, limit: limits.get(Number(l.epoch_no)) });
    }
    points.push({ epoch: ctx.snapshot.epoch, block: ctx.snapshot.id, t: ctx.snapshot.tx, limit: limits.get(ctx.snapshot.epoch), snapshot: true });
    const tallies = points.map((p) => ({ ...p, wallets: 0, withUtxos: 0, n50: 0, n80: 0, n90: 0 }));
    for (const sa of set.ids) {
      const life = await loadLife(ctx.client, ctx.blocks, sa, ctx.snapshot.tx);
      const vb = life.map((r) => valueSize(r.coin, r.assets));
      tallies.forEach((p) => {
        let largest = 0;
        let any = false;
        life.forEach((r, k) => {
          if (r.createdTx <= p.t && (r.consumedTx === null || r.consumedTx > p.t)) {
            any = true;
            if (vb[k] > largest) largest = vb[k];
          }
        });
        p.wallets++;
        if (any) p.withUtxos++;
        if (limitShare(largest, p.limit, 50)) p.n50++;
        if (limitShare(largest, p.limit, 80)) p.n80++;
        if (limitShare(largest, p.limit, 90)) p.n90++;
      });
    }
    const summary = { command: 'near-cap', network: ctx.network, snapshot: ctx.snapshot, walletSource: set.source, wallets: set.ids.length, firstEpoch: from, points: tallies, seconds: (performance.now() - t0) / 1000 };
    writeJson(join(runDir(ctx.network, opts.runId), 'near-cap.json'), summary);
    return { ...summary, print: { command: 'near-cap', wallets: set.ids.length, boundaries: tallies.length, seconds: summary.seconds } };
  } finally {
    await ctx.client.end();
  }
}

export async function cmdCollateral(opts) {
  if (!opts.runId) throw new Error('--run-id is required');
  const ctx = await makeContext(opts);
  try {
    const w = await recentWindow(ctx, ctx.snapshot);
    const p = { lo: { type: 'int', value: w.lo }, hi: { type: 'int', value: w.hi } };
    const plan = opts.explain ? await explain(ctx.client, ctx.blocks, 'collateral_summary', p) : null;
    const t0 = performance.now();
    const r = (await q(ctx.client, ctx.blocks, 'collateral_summary', p))[0];
    const seconds = (performance.now() - t0) / 1000;
    const n = (x) => (x === null ? 0 : Number(x));
    const res = {
      scriptTransactions: n(r.n_script_tx),
      withoutCollateralRead: n(r.n_no_collateral_read),
      withScriptCollateral: n(r.n_script_collateral),
      measured: n(r.n_tx),
      phase2Invalid: n(r.n_invalid),
      under20Ada: n(r.n_under_20_ada),
      shareUnder20Ada: n(r.n_tx) ? n(r.n_under_20_ada) / n(r.n_tx) : null,
      withReturn: n(r.n_with_return),
      shareWithReturn: n(r.n_tx) ? n(r.n_with_return) / n(r.n_tx) : null,
      collateralInputs: n(r.n_inputs),
      tokenInputs: n(r.n_token_inputs),
      shareTokenInputs: n(r.n_inputs) ? n(r.n_token_inputs) / n(r.n_inputs) : null,
      perTransactionBins: r.per_tx_bins,
      perInputBins: r.per_input_bins,
      perTransactionQuantiles: r.per_tx_quantiles
    };
    // The rule section 7.6 of the study states: the practice rule is
    // confirmatory when more than half carry less than 20 ADA.
    const summary = { command: 'collateral', network: ctx.network, snapshot: ctx.snapshot, window: w, result: res, practiceRuleConfirmatory: res.shareUnder20Ada === null ? null : res.shareUnder20Ada > 0.5, seconds, plan };
    writeJson(join(runDir(ctx.network, opts.runId), 'collateral.json'), summary);
    return { ...summary, print: { command: 'collateral', seconds, result: res } };
  } finally {
    await ctx.client.end();
  }
}

// The observed state along a history file, for the holding before each
// spend.
function observedStates(lines, onIntent) {
  const state = new Map();
  for (const e of lines) {
    if (e.kind === 'state') for (const u of e.utxos) state.set(u.ref, u.assets.map((a) => ({ ...a, qty: BigInt(a.qty) })));
    else if (e.kind === 'deposit') for (const u of e.utxos) state.set(u.ref, u.assets.map((a) => ({ ...a, qty: BigInt(a.qty) })));
    else if (e.kind === 'held-consumed') for (const r of e.refs) state.delete(r);
    else if (e.kind === 'intent' || e.kind === 'self-reorganization') {
      const it = e.kind === 'intent' ? e.intent : e;
      if (e.kind === 'intent') onIntent(it, mergeAssets(...[...state.values()]));
      for (const x of it.observed.walletInputs) state.delete(x.ref);
      if (e.kind === 'intent' && it.fixed) for (const x of it.fixed.inputs) if (x.held) state.delete(x.ref);
      if (e.kind === 'intent' && it.invalid) for (const r of it.invalid.heldConsumed) state.delete(r);
      if (e.kind === 'self-reorganization') for (const r of e.heldConsumed) state.delete(r);
      const tx = e.kind === 'intent' ? it.id : e.tx;
      for (const o of it.observed.walletOutputs) state.set(`${tx}#${o.index}`, decodeOutputBytes(Buffer.from(o.cbor, 'hex')).assets);
    }
  }
}

// T1 amounts: per T1 intent, the coin of its requested outputs to other stake
// credentials, as observed (before any raise). T5 shares: per T5 intent and
// fungible asset sent, the units sent over the wallet's holding just before
// the spend. Only exploration-split wallets' recent-window files are read,
// unless the files carry no split (a test network), which the output says.
export async function cmdBatteryPools(opts) {
  if (!opts.runId || !opts.network) throw new Error('--run-id and --network are required');
  const dir = historyDir(opts.network, opts.runId);
  if (!existsSync(dir)) throw new Error('the run has no history directory');
  const files = readdirSync(dir).filter((f) => f.endsWith('.recent.jsonl')).sort();
  const t1 = [];
  const t5 = [];
  let used = 0;
  let noSplit = 0;
  let skipped = 0;
  for (const f of files) {
    const lines = readFileSync(join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const h = lines[0];
    if (h.split === null) noSplit++;
    else if (h.split !== 'exploration') {
      skipped++;
      continue;
    }
    used++;
    observedStates(lines, (it, holding) => {
      if (it.type === 'T1') {
        const amount = it.requested.filter((r) => !r.wallet).reduce((s, r) => s + BigInt(r.raised ? r.raised.from : r.coin), 0n);
        if (amount > 0n) t1.push(amount);
      } else if (it.type === 'T5') {
        const held = assetMap(holding);
        const sent = assetMap(it.requested.filter((r) => !r.inflow).flatMap((r) => r.assets.map((a) => ({ ...a, qty: BigInt(a.qty) }))));
        for (const [k, units] of sent) {
          if (it.classes[k] !== 'FT') continue;
          const before = held.get(k) || 0n;
          if (before > 0n) t5.push([units.toString(), before.toString(), k]);
        }
      }
    });
  }
  t1.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const pools = { network: opts.network, runId: opts.runId, files: files.length, used, withoutSplit: noSplit, skippedConfirmation: skipped, t1Amounts: t1.map(String), t5Shares: t5.map(([u, b]) => [u, b]) };
  writeJson(join(runDir(opts.network, opts.runId), 'battery-pools.json'), pools);
  return { print: { command: 'battery-pools', files: files.length, used, withoutSplit: noSplit, t1: t1.length, t5: t5.length } };
}
