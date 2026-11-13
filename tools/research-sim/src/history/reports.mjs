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
//   tokens.
//
// Value bytes are the ledger's serialization of the Value (value.mjs); a
// UTxO's minimum is the ledger's rule on the output re-encoded from
// db-sync's columns, at the snapshot's coins per UTxO byte. Per-wallet rows are written to the private run directory only.

import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { q, explain } from './db.mjs';
import { makeContext, resolveWallets, allowedWallets, refuseOutside } from './commands.mjs';
import { Refusal } from './db.mjs';
import { lifeRow, loadExtras, reencode, loadLife } from './wallet.mjs';
import { valueSize } from './value.mjs';
import { minAdaForOutput } from './csl.mjs';
import { valueLimit } from './params.mjs';
import { recentWindow } from './windows.mjs';
import { runDir, JsonLines, writeJson } from './paths.mjs';

const BATCH = 500;

async function studyReadable(ctx) {
  const r = (await q(ctx.client, ctx.blocks, 'study_readable'))[0];
  return r.usage && r.has_frame;
}

// The wallet set: --wallets/--wallet, or the extraction's set when its study
// tables are readable (--from-study), or every key stake credential with an
// output (--all-wallets, for a test network). Under a scope (commands.mjs
// allowedWallets): --all-wallets is refused; wallets named must be ones the
// scope allows; a live-fire run takes no --from-study; and on mainnet after
// the final freeze the --from-study set is the gate's run's own (its tables
// carry the run's mark): for near-cap the union of its random samples, which
// lies in study.sample, and for the census its eligible recent-frame wallets,
// the census population H-8 names, which this restriction leaves as it is.
export async function walletSet(ctx, opts, studyQuery) {
  const scope = ctx.scope || null;
  if (scope && opts.allWallets) throw new Refusal(scope.path === 'live-fire' ? 'refusing: a live-fire run reads only the wallets its extraction run picked; it takes no --all-wallets' : 'refusing: after the final freeze a command reads on mainnet only wallets of the study sample; --all-wallets is for a test network');
  if (scope && scope.path === 'live-fire' && opts.fromStudy) throw new Refusal('refusing: a live-fire run reads the wallets its extraction run picked; it takes no --from-study');
  if (opts.fromStudy) {
    if (!(await studyReadable(ctx))) throw new Error('--from-study: the study tables are not readable by this role');
    const ids = (await q(ctx.client, ctx.blocks, studyQuery)).map((r) => Number(r.id));
    if (scope && studyQuery !== 'study_recent_eligible') refuseOutside(await allowedWallets(ctx), ids, scope);
    return { ids, source: 'study' };
  }
  if (opts.allWallets) return { ids: (await q(ctx.client, ctx.blocks, 'key_wallets_with_outputs', { t: { type: 'int', value: ctx.snapshot.tx } })).map((r) => Number(r.id)), source: 'all' };
  return { ids: await resolveWallets(ctx, opts, await allowedWallets(ctx)), source: 'given' };
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
            const min = minAdaForOutput(reencode(ctx, r).bytes, ctx.params.coinsPerUtxoByte);
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

// The rule every replay job of the study runs under, picked by the collateral
// measurement (pre-registration section 7.2): `share` is the share of the
// recent window's script-executing transactions whose collateral inputs all
// sit at key addresses that carry less than 20 ADA of collateral in total.
// Above one half the practice rule; otherwise the ledger rule; null when
// the measurement found no such transaction.
export function pickCollateralRule(share) {
  if (share === null || share === undefined) return null;
  return share > 0.5 ? 'practice' : 'ledger';
}

const ADA_BINS = [0, 1, 2, 5, 10, 20, 50, 100, 1000];
const binOf = (lovelace) => {
  let k = 0;
  for (let i = 0; i < ADA_BINS.length; i++) if (lovelace >= BigInt(ADA_BINS[i]) * 1000000n) k = i;
  return k;
};

export async function cmdCollateral(opts) {
  if (!opts.runId) throw new Error('--run-id is required');
  const ctx = await makeContext(opts);
  try {
    // --days shortens the window for a test on a test network; the study's
    // measurement is the recent window.
    if (opts.days && ctx.network === 'mainnet') throw new Error('--days is for a test network only');
    const w = await recentWindow(ctx, ctx.snapshot, opts.days ? Number(opts.days) * 86400 : undefined);
    w.days = opts.days ? Number(opts.days) : 365;
    const p = { lo: { type: 'int', value: w.lo }, hi: { type: 'int', value: w.hi } };
    let plans = null;
    if (opts.explain) {
      plans = {};
      for (const n of ['collateral_redeemer_txs', 'collateral_inputs_valid', 'collateral_return_txs']) plans[n] = await explain(ctx.client, ctx.blocks, n, p);
    }
    const t0 = performance.now();
    const timing = {};
    const timedQ = async (name, params) => {
      const s0 = performance.now();
      const rows = await q(ctx.client, ctx.blocks, name, params);
      timing[name] = (timing[name] || 0) + (performance.now() - s0) / 1000;
      return rows;
    };
    const red = new Set((await timedQ('collateral_redeemer_txs', p)).map((r) => Number(r.tx_id)));
    const inv = new Set((await timedQ('collateral_invalid_txs', p)).map((r) => Number(r.tx_id)));
    const script = new Set([...red, ...inv]);
    const inputs = new Map([...script].map((x) => [x, []]));
    for (const r of await timedQ('collateral_inputs_valid', p)) {
      const x = Number(r.tx_id);
      if (red.has(x)) inputs.get(x).push([Number(r.tx_out_id), Number(r.tx_out_index)]);
    }
    const invIds = [...inv];
    for (let i = 0; i < invIds.length; i += 5000) {
      for (const r of await timedQ('collateral_inputs_invalid', { ids: { type: 'intarr', value: invIds.slice(i, i + 5000) } })) inputs.get(Number(r.tx_id)).push([Number(r.tx_out_id), Number(r.tx_out_index)]);
    }
    const returns = new Set((await timedQ('collateral_return_txs', p)).map((r) => Number(r.tx_id)));
    for (let i = 0; i < invIds.length; i += 5000) {
      for (const r of await timedQ('collateral_invalid_returns', { ids: { type: 'intarr', value: invIds.slice(i, i + 5000) } })) returns.add(Number(r.tx_id));
    }
    // Outputs are read in the order db-sync stores them (by creating
    // transaction id), which keeps each batch's index probes close together.
    const refs = [...new Set([...inputs.values()].flat().map(([a, b]) => `${a}#${b}`))].sort((x, y) => {
      const [a1, b1] = x.split('#').map(Number);
      const [a2, b2] = y.split('#').map(Number);
      return a1 - a2 || b1 - b2;
    });
    const outs = new Map();
    const batch = Number(opts.batch || 2000);
    for (let i = 0; i < refs.length; i += batch) {
      const part = refs.slice(i, i + batch);
      const rows = await timedQ('collateral_outputs', { tx_ids: { type: 'intarr', value: part.map((r) => Number(r.split('#')[0])) }, indexes: { type: 'int4arr', value: part.map((r) => Number(r.split('#')[1])) } });
      for (const r of rows) outs.set(`${r.tx_id}#${r.index}`, { coin: BigInt(r.value), script: r.script_pay, tokens: r.has_tokens });
    }
    const acc = { scriptTransactions: script.size, withoutCollateralRead: 0, withScriptCollateral: 0, measured: 0, phase2Invalid: 0, under20Ada: 0, withReturn: 0, collateralInputs: 0, tokenInputs: 0 };
    const perTx = ADA_BINS.map(() => 0);
    const perInput = ADA_BINS.map(() => 0);
    const coins = [];
    for (const [x, ins] of inputs) {
      const os = ins.map(([a, b]) => outs.get(`${a}#${b}`)).filter(Boolean);
      if (!os.length || os.length !== ins.length) {
        acc.withoutCollateralRead++;
        continue;
      }
      if (os.some((o) => o.script)) {
        acc.withScriptCollateral++;
        continue;
      }
      const total = os.reduce((s, o) => s + o.coin, 0n);
      acc.measured++;
      if (inv.has(x)) acc.phase2Invalid++;
      if (total < 20000000n) acc.under20Ada++;
      if (returns.has(x)) acc.withReturn++;
      acc.collateralInputs += os.length;
      acc.tokenInputs += os.filter((o) => o.tokens).length;
      perTx[binOf(total)]++;
      for (const o of os) perInput[binOf(o.coin)]++;
      coins.push(total);
    }
    coins.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const quantile = (pp) => (coins.length ? coins[Math.min(coins.length - 1, Math.ceil(pp * coins.length) - 1)] : null);
    const res = {
      ...acc,
      shareUnder20Ada: acc.measured ? acc.under20Ada / acc.measured : null,
      shareWithReturn: acc.measured ? acc.withReturn / acc.measured : null,
      shareTokenInputs: acc.collateralInputs ? acc.tokenInputs / acc.collateralInputs : null,
      perTransactionBins: ADA_BINS.map((a, i) => ({ fromAda: a, n: perTx[i] })),
      perInputBins: ADA_BINS.map((a, i) => ({ fromAda: a, n: perInput[i] })),
      perTransactionQuantiles: Object.fromEntries([0.05, 0.25, 0.5, 0.75, 0.95].map((pp) => [pp, quantile(pp)]))
    };
    const seconds = (performance.now() - t0) / 1000;
    // The study's rule (pre-registration section 7.2): every replay job runs
    // under the practice rule when more than half of these transactions carry
    // less than 20 ADA of collateral, otherwise under the ledger rule.
    const collateralRule = pickCollateralRule(res.shareUnder20Ada);
    const summary = { command: 'collateral', network: ctx.network, snapshot: ctx.snapshot, window: w, result: res, collateralRule, practiceRuleConfirmatory: collateralRule === null ? null : collateralRule === 'practice', seconds, statementSeconds: timing, plans };
    writeJson(join(runDir(ctx.network, opts.runId), 'collateral.json'), summary);
    return { ...summary, print: { command: 'collateral', seconds, statementSeconds: timing, result: res } };
  } finally {
    await ctx.client.end();
  }
}
