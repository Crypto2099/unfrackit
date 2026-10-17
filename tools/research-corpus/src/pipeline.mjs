// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Artifact A2 of the pre-registration (its section 10.5): the snapshot block
// recorded; frames, screens and the draw; the corpus manifest; the exclusion
// flow log per frame. Also the split (artifact A3), the prior-treated and
// franken flags, the section 6.1 check and the profile inputs, all before any
// outcome is computed.

import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll } from './sqlfile.mjs';
import { connect, applySession, dbMeta, checkHistoryIntact, q, qBound } from './db.mjs';
import { Runner } from './runner.mjs';
import { sqlParams, defaultSettings, applyOverrides, FROZEN_PEAK } from './params.mjs';
import { runDir, writeJson, writePrivate } from './paths.mjs';
import { decode as bech32decode } from './bech32.mjs';
import { codeVersion } from './hash.mjs';
import { buildManifest } from './manifest.mjs';
import { check61 } from './check61.mjs';

const HEX32 = /^[0-9a-f]{64}$/;

export function loadStrataList(path, settings) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(doc.rows)) throw new Error(`${path}: expected { rows: [...] }`);
  const rows = doc.rows.map((r, i) => {
    if (!/^[0-9a-f]{56}$/.test(r.policy)) throw new Error(`${path} row ${i + 1}: policy must be 56 hex characters`);
    if (r.class !== 'NFT' && r.class !== 'FT') throw new Error(`${path} row ${i + 1}: class must be NFT or FT`);
    if (r.class === 'FT' && !/^([0-9a-f]{2}){0,32}$/.test(r.asset_name ?? '')) throw new Error(`${path} row ${i + 1}: FT rows need asset_name hex`);
    let stratum = r.stratum || r.project;
    if (settings.x10_spacebudz_one && r.group) stratum = r.group;
    return {
      ord: i + 1,
      stratum,
      project: r.project,
      class: r.class,
      policy: r.policy,
      asset_name: r.class === 'FT' ? r.asset_name : null,
      nft_top_exclude: !!r.nft_top_exclude
    };
  });
  return { source: doc.source || null, rows };
}

function readConsented(path) {
  const text = readFileSync(path, 'utf8');
  const views = text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);
  for (const v of views) {
    const { hrp, bytes } = bech32decode(v);
    if ((hrp !== 'stake' && hrp !== 'stake_test') || bytes.length !== 29) throw new Error('the consented file must hold one bech32 stake address per line');
  }
  return [...new Set(views)];
}

async function storeParam(client, runId, key, value) {
  await client.query(
    'INSERT INTO study.param (run_id, key, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT (run_id, key) DO UPDATE SET value = EXCLUDED.value',
    [runId, key, JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))]
  );
}

async function loadParams(client, runId) {
  const r = await client.query('SELECT key, value FROM study.param WHERE run_id = $1', [runId]);
  return Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
}

const num = (x) => (x === null || x === undefined ? x : Number(x));

export async function runPipeline(opts) {
  const log = opts.log || ((s) => process.stderr.write(s + '\n'));
  // The code version is the one the run starts with; a file that changes
  // before the run ends voids the manifest.
  const codeAtStart = codeVersion();
  const blocks = loadAll();
  const client = await connect(opts.db || {});
  try {
    const meta = await dbMeta(client, blocks);
    await checkHistoryIntact(client, blocks, meta);
    const network = meta.network;
    if (opts.expectNetwork && opts.expectNetwork !== network) throw new Error(`refusing: database is ${network}, expected ${opts.expectNetwork}`);
    if (network === 'mainnet') {
      if (!opts.freezeTx || !HEX32.test(opts.freezeTx)) throw new Error('refusing a mainnet database without --freeze-tx <64 hex>');
      if (opts.standInTx) throw new Error('refusing: a stand-in for h is for test networks only');
      if (opts.hmacKey) throw new Error('refusing: mainnet runs use the study key in secret/hmac.key');
      if (opts.capture) throw new Error('refusing: no plan capture on mainnet');
    }
    const session = await applySession(client, opts.session || {});
    for (const lib of ['schema', 'cip67', 'strata_fn']) {
      await new Runner({ client, blocks, runId: '-', params: {}, log: () => {} }).run(lib);
    }

    const runId = opts.runId;
    const existing = await client.query('SELECT network FROM study.run WHERE run_id = $1', [runId]);
    if (existing.rows.length && existing.rows[0].network !== network) throw new Error(`run ${runId} belongs to ${existing.rows[0].network}`);
    if (!existing.rows.length) await client.query('INSERT INTO study.run (run_id, network) VALUES ($1, $2)', [runId, network]);
    const stored = await loadParams(client, runId);
    const dir = runDir(network, runId);

    // Settings: fixed values and readings, with overrides. A resumed
    // run must use the settings it started with.
    const settings = applyOverrides(defaultSettings(), opts.set || []);
    const canonical = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
    if (stored.settings && canonical(stored.settings) !== canonical(settings)) {
      throw new Error(`run ${runId} was started with other settings; use a new run id`);
    }
    await storeParam(client, runId, 'settings', settings);
    await storeParam(client, runId, 'db', { network, version: meta.version, schema_version: meta.schemaVersion, extra_migrations: meta.extraMigrations });
    await storeParam(client, runId, 'session', session);

    // Snapshot: the tip when the run starts (db-sync stopped there), or a given hash; a resumed
    // run keeps the block it recorded.
    let snapshot = stored.snapshot;
    if (!snapshot) {
      const rows = opts.snapshot === 'tip' || !opts.snapshot ? await q(client, blocks, 'tip_block') : await q(client, blocks, 'block_by_hash', { block_hash: { type: 'bytea', value: opts.snapshot } });
      if (!rows.length) throw new Error(`snapshot block ${opts.snapshot} not found`);
      const b = rows[0];
      const t = (await q(client, blocks, 't_of_block', { block_id: { type: 'int', value: b.id } }))[0].t;
      snapshot = { id: num(b.id), block_no: num(b.block_no), slot_no: num(b.slot_no), epoch_no: num(b.epoch_no), time: b.time, hash: b.hash, t: num(t), chosen: opts.snapshot === 'tip' || !opts.snapshot ? 'tip' : 'hash' };
      await storeParam(client, runId, 'snapshot', snapshot);
    } else if (opts.snapshot && opts.snapshot !== 'tip' && opts.snapshot !== snapshot.hash) {
      throw new Error(`run ${runId} has snapshot ${snapshot.hash}`);
    }

    // h: the hash of the block containing the freeze transaction (section 5.4);
    // on test networks a stand-in transaction's block. The snapshot must be
    // later (section 10.1).
    let freeze = stored.freeze;
    const givenTx = network === 'mainnet' ? opts.freezeTx : opts.standInTx;
    if (freeze && givenTx && givenTx.toLowerCase() !== freeze.tx) throw new Error(`run ${runId} was started with ${freeze.role} transaction ${freeze.tx}`);
    if (!freeze) {
      const txHash = givenTx ? givenTx.toLowerCase() : givenTx;
      if (!txHash || !HEX32.test(txHash)) throw new Error('give --stand-in-tx <64 hex> (test networks) or --freeze-tx (mainnet)');
      const rows = await q(client, blocks, 'block_of_tx', { tx_hash: { type: 'bytea', value: txHash } });
      if (!rows.length) throw new Error(`transaction ${txHash} is not in the database`);
      const b = rows[0];
      freeze = { tx: txHash, role: network === 'mainnet' ? 'freeze' : 'stand-in', id: num(b.id), block_no: num(b.block_no), time: b.time, hash: b.hash };
      await storeParam(client, runId, 'freeze', freeze);
    }
    if (!(snapshot.block_no > freeze.block_no)) throw new Error(`refusing: snapshot block ${snapshot.block_no} is not after the freeze block ${freeze.block_no}`);
    const h = freeze.hash;

    const run = { network, runId, settings, snapshot, h, windows: stored.windows || null };
    const runner = new Runner({ client, blocks, runId, params: sqlParams(run), capture: !!opts.capture && network !== 'mainnet', log, redo: new Set(opts.redo || []) });
    const report = { run_id: runId, network, snapshot, freeze, settings, session };
    const setParams = () => {
      runner.params = sqlParams(run);
    };

    // Block and transaction ids increase along the chain, or tx-id ranges are
    // not windows (integration test T1).
    const ocStart = performance.now();
    const oc = stored.order_check || Object.fromEntries(Object.entries((await q(client, blocks, 'order_check'))[0]).map(([k, v]) => [k, num(v)]));
    if (!stored.order_check) oc.ms = performance.now() - ocStart;
    await storeParam(client, runId, 'order_check', oc);
    report.order_check = oc;
    for (const k of ['blocks_out_of_order', 'blocks_not_after_previous', 'tx_out_of_order', 'tx_index_repeated']) {
      if (oc[k] !== 0) throw new Error(`order check ${k}: ${oc[k]}; transaction-id ranges cannot stand for windows`);
    }

    // Windows (pre-registration section 5.3).
    await runner.run('epoch_counts');
    await runner.run('peak_runs');
    if (!run.windows) {
      const pc = (await q(client, blocks, 'peak_choice', runner.params))[0];
      if (!pc) throw new Error('no complete 73-epoch run before the snapshot epoch');
      const tOf = async (b) => num((await q(client, blocks, 't_of_block', { block_id: { type: 'int', value: b } }))[0].t);
      const firstTx = async (b) => num((await q(client, blocks, 'first_tx_from_block', { block_id: { type: 'int', value: b } }))[0].t);
      const prev = async (b) => num((await q(client, blocks, 'prev_block', { block_id: { type: 'int', value: b } }))[0].b);
      const startT = async (b1) => (settings.x3_after_first ? tOf(b1) : tOf((await prev(b1)) ?? 0));
      const blk = async (id) => (await q(client, blocks, 'block_by_id', { block_id: { type: 'int', value: id } }))[0];
      const pFirst = await blk(num(pc.first_block));
      const pLast = await blk(num(pc.last_block));
      const peak = {
        first_epoch: num(pc.first_epoch),
        last_epoch: num(pc.last_epoch),
        first_block: num(pc.first_block),
        last_block: num(pc.last_block),
        first_block_no: num(pFirst.block_no),
        last_block_no: num(pLast.block_no),
        first_time: pFirst.time,
        last_time: pLast.time,
        n_tx_rule: num(pc.n_tx_rule),
        n_tx_all: num(pc.n_tx_all),
        n_tx_valid: num(pc.n_tx_valid),
        n_tx_view: num(pc.n_tx_view),
        n_runs: num(pc.n_runs),
        alonzo_epoch: num(pc.alonzo_epoch),
        lo: await firstTx(num(pc.first_block)),
        hi: await tOf(num(pc.last_block)),
        t_start: await startT(num(pc.first_block))
      };
      const latest = (await q(client, blocks, 'latest_run', runner.params))[0];
      peak.latest_run = latest ? { first_epoch: num(latest.first_epoch), last_epoch: num(latest.last_epoch), n_tx_rule: num(latest.n_tx_rule) } : null;
      const rf = num((await q(client, blocks, 'recent_first_block', runner.params))[0].id);
      const rFirst = await blk(rf);
      const recent = {
        first_block: rf,
        last_block: snapshot.id,
        first_block_no: num(rFirst.block_no),
        last_block_no: snapshot.block_no,
        first_time: rFirst.time,
        last_time: snapshot.time,
        first_epoch: num(rFirst.epoch_no),
        last_epoch: snapshot.epoch_no,
        lo: await firstTx(rf),
        hi: snapshot.t,
        t_start: await startT(rf)
      };
      run.windows = { recent, peak };
      await storeParam(client, runId, 'windows', run.windows);
      setParams();
    }
    report.windows = run.windows;
    const frozen = opts.frozenPeak || FROZEN_PEAK[network];
    if (frozen) {
      const f = frozen;
      report.peak_vs_frozen = { frozen: f, agrees: f.first_epoch === run.windows.peak.first_epoch && f.last_epoch === run.windows.peak.last_epoch && f.n_tx === run.windows.peak.n_tx_rule };
    }
    await runner.run('era_report');
    report.era_changes = await q(client, blocks, 'era_changes', runner.params);
    report.snapshot_epoch_param = JSON.parse((await q(client, blocks, 'snapshot_epoch_param', runner.params))[0].row);

    // Credentials and consented keys.
    await runner.run('cred');
    const cc = (await q(client, blocks, 'cred_checks', runner.params))[0];
    report.cred_checks = Object.fromEntries(Object.entries(cc).map(([k, v]) => [k, num(v)]));
    for (const k of ['bad_length', 'bad_header', 'bad_script_flag', 'bad_script_hash', 'bad_network']) {
      if (report.cred_checks[k] !== 0) throw new Error(`credential check ${k}: ${report.cred_checks[k]} rows`);
    }
    const consentedViews = opts.consented ? readConsented(opts.consented) : [];
    await runner.run('consented_table', {}, (c) => qBound(c, blocks, 'consented_load', [consentedViews]));
    const nCons = num((await q(client, blocks, 'consented_count'))[0].n);
    report.consented = { listed: consentedViews.length, matched: nCons, unmatched: consentedViews.length - nCons };
    await storeParam(client, runId, 'consented_count', report.consented);

    // The life table and the frames.
    for (const s of ['txo', 'txo_asset', 'asset']) await runner.run(s);
    report.txo_counts = Object.fromEntries(Object.entries((await q(client, blocks, 'txo_counts'))[0]).map(([k, v]) => [k, num(v)]));
    for (const s of ['activity', 'state', 'paycount', 'frame', 'flow']) await runner.run(s);
    report.flow = (await q(client, blocks, 'flow_rows')).map((r) => ({ ...r, n_in: num(r.n_in), n_removed: num(r.n_removed), n_out: num(r.n_out) }));
    report.frame_report = (await q(client, blocks, 'frame_report')).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'frame' ? v : num(v)])));

    // The draw and the samples.
    await runner.run('draw');
    report.draw = (await q(client, blocks, 'draw_summary_rows')).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'frame' || k === 'guard_reached' ? v : num(v)])));
    report.consented_in_prefix = (await q(client, blocks, 'consented_in_prefix')).map((r) => ({ frame: r.frame, random_prefix: num(r.random_prefix), ada_only_prefix: num(r.ada_only_prefix) }));
    const strata = loadStrataList(opts.strataList, settings);
    await runner.run('strata_list_table', {}, (c) => qBound(c, blocks, 'strata_list_load', [JSON.stringify(strata.rows)]));
    await storeParam(client, runId, 'strata_list', { source: strata.source, rows: strata.rows });
    await runner.run('nft_top');
    await runner.run('strata');
    report.strata = (await q(client, blocks, 'strata_report')).map((r) => ({ ...r, ord: num(r.ord), nft_top_holders: num(r.nft_top_holders), n_recent: num(r.n_recent), n_peak: num(r.n_peak) }));
    const caseViews = [...new Set(opts.caseWallets || [])];
    for (const v of caseViews) {
      const { hrp, bytes } = bech32decode(v);
      if ((hrp !== 'stake' && hrp !== 'stake_test') || bytes.length !== 29) throw new Error(`--case expects a bech32 stake address: ${v}`);
    }
    await runner.run('split', {}, (c) => qBound(c, blocks, 'case_wallet_load', [caseViews]));
    await runner.run('sample_wallets');
    report.split = (await q(client, blocks, 'split_counts')).map((r) => ({ ...r, n: num(r.n), n_exploration: num(r.n_exploration), n_confirmation: num(r.n_confirmation), n_unassigned: num(r.n_unassigned) }));

    // Prior-treated and franken flags.
    await runner.run('unfrackit_tx');
    report.unfrackit = Object.fromEntries(Object.entries((await q(client, blocks, 'unfrackit_report', runner.params))[0]).map(([k, v]) => [k, /time/.test(k) ? v : num(v)]));
    report.unfrackit_matches = await q(client, blocks, 'unfrackit_matches');
    await runner.run('prior_flags');
    report.prior = (await q(client, blocks, 'prior_counts')).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'frame' ? v : num(v)])));
    await runner.run('franken');
    report.franken = Object.fromEntries(Object.entries((await q(client, blocks, 'franken_counts'))[0]).map(([k, v]) => [k, num(v)]));

    // Section 6.1 check.
    await runner.run('check_61_table', {}, async (c) => {
      report.check_61_run = await check61({ client: c, blocks, run, params: runner.params, log, batch: opts.batch || 500 });
    });
    report.check_61 = Object.fromEntries(Object.entries((await q(client, blocks, 'check_61_counts'))[0]).map(([k, v]) => [k, k === 'direct_valid' ? v : num(v)]));

    // Profile inputs.
    await runner.run('script_tx');
    await runner.run('profile');
    report.profile_check = Object.fromEntries(Object.entries((await q(client, blocks, 'profile_check'))[0]).map(([k, v]) => [k, num(v)]));
    report.profiles = (await q(client, blocks, 'profile_counts')).map((r) => ({ ...r, n: num(r.n), nft_heavy: num(r.nft_heavy), ft_heavy: num(r.ft_heavy), dex_active: num(r.dex_active) }));

    // Code version and manifest.
    const codeAtEnd = codeVersion();
    if (JSON.stringify(codeAtEnd.files) !== JSON.stringify(codeAtStart.files)) {
      throw new Error('refusing to write the manifest: a hashed file changed during the run; run again with a new run id');
    }
    report.code_version = codeAtStart;
    await storeParam(client, runId, 'code_version', report.code_version);
    report.steps = runner.timings.map((t) => ({ name: t.name, file: t.file, ms: Math.round(t.ms), rows: t.rows }));
    const manifest = await buildManifest({ client, run, report, hmacKeyPath: opts.hmacKey, dir });
    writeJson(join(dir, 'params.json'), { run_id: runId, network, snapshot, freeze, h, windows: run.windows, settings, session, consented: report.consented, code_version: report.code_version, db: (await loadParams(client, runId)).db });
    writeJson(join(dir, 'report.json'), report);
    writeJson(join(dir, 'timings.json'), runner.timings);
    writeJson(join(dir, 'manifest.json'), manifest);
    writePrivate(join(dir, 'README.txt'), 'Private run directory of the research-corpus tool. Raw lists name stake addresses; only manifest.json is meant for publication.\n');
    return { runId, dir, report, manifest, timings: runner.timings };
  } finally {
    await client.end();
  }
}
