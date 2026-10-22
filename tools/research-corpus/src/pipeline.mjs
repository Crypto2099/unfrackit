// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Artifact A2 of the pre-registration (its section 10.5): the snapshot block
// recorded; frames, screens and the draw; the corpus manifest; the exclusion
// flow log per frame. Also the split (artifact A3), the section 6.1 check, the
// prior-treated and franken flags and the profile inputs, all before any
// outcome is computed.
//
// Three modes:
//   study      on mainnet, after the final freeze: the freeze record checked
//              (src/freeze.mjs), the code manifest compared, every run-time
//              option held to its hashed value (src/guards.mjs), h the epoch
//              nonce the rule names;
//   test       on a test network: h from a stand-in transaction's block by the
//              same epoch rule, or a rehearsal freeze checked like the study's;
//   live-fire  before the final freeze, on any network: a stated test value of
//              h, no row count or population statistic printed, logged or
//              written, the run's study tables dropped at the end unless kept
//              for debugging, and one entry appended to the check log.

import { performance } from 'node:perf_hooks';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadAll } from './sqlfile.mjs';
import { connect, applySession, dbMeta, checkHistoryIntact, q, qBound } from './db.mjs';
import { Runner, dropRunTables, mark } from './runner.mjs';
import { sqlParams, defaultSettings, applyOverrides, FROZEN_PEAK } from './params.mjs';
import { runDir, writeJson, writePrivate } from './paths.mjs';
import { codeVersion, hashList, TOOL_DIR } from './hash.mjs';
import { buildManifest } from './manifest.mjs';
import { check61 } from './check61.mjs';
import { verifyFinalFreeze, drawKey, readTx, signedBy, sha256hex, ruleSnapshot } from './freeze.mjs';
import { mainnetOptionErrors, codeManifestErrors, readStakeList, checkStakeAddresses } from './guards.mjs';
import { appendEntry, sanitizeError, refuse, checkLogPath, verifyLog } from './checklog.mjs';
import { Koios } from './koios.mjs';

const HEX32 = /^[0-9a-f]{64}$/;
export const DEFAULT_STRATA = join(TOOL_DIR, 'data', 'strata-mainnet.json');
export const DEFAULT_RULINGS = join(TOOL_DIR, 'data', 'strata-rulings.json');
const STRATA_FORMAT = 'research-corpus-strata-v2';

// The strata file: the named rows of part 1 and the CoinGecko candidates of
// part 2 in rank order (see sql/05-04-strata.sql).
export function loadStrataList(path, settings) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (doc.format !== STRATA_FORMAT) throw new Error(`${path}: expected format ${STRATA_FORMAT}`);
  if (!Array.isArray(doc.named) || !Array.isArray(doc.candidates)) throw new Error(`${path}: expected named and candidates arrays`);
  const named = doc.named.map((r, i) => {
    if (!/^[0-9a-f]{56}$/.test(r.policy)) throw new Error(`${path} named row ${i + 1}: policy must be 56 hex characters`);
    if (r.class !== 'NFT' && r.class !== 'FT') throw new Error(`${path} named row ${i + 1}: class must be NFT or FT`);
    if (r.class === 'FT' && !/^([0-9a-f]{2}){0,32}$/.test(r.asset_name ?? '')) throw new Error(`${path} named row ${i + 1}: FT rows need asset_name hex`);
    let stratum = r.stratum || r.project;
    if (settings.x10_spacebudz_one && r.group) stratum = r.group;
    return { ord: i + 1, stratum, project: r.project, class: r.class, policy: r.policy, asset_name: r.class === 'FT' ? r.asset_name : null, nft_top_exclude: !!r.nft_top_exclude };
  });
  const candidates = doc.candidates.map((r, i) => {
    if (r.rank !== i + 1) throw new Error(`${path} candidate ${i + 1}: ranks must run 1, 2, 3 in file order`);
    if (!/^[0-9a-f]{56}$/.test(r.policy) || !/^([0-9a-f]{2}){0,32}$/.test(r.asset_name ?? '')) throw new Error(`${path} candidate ${i + 1}: policy and asset_name hex`);
    return { rank: r.rank, stratum: r.stratum || r.project, project: r.project, policy: r.policy, asset_name: r.asset_name };
  });
  if (named.length >= 100) throw new Error(`${path}: too many named rows`);
  return { provenance: doc.provenance || null, named, candidates };
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
const numRow = (r, keep = []) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, keep.includes(k) || typeof v === 'boolean' ? v : num(v)]));

// Per-field parse coverage, kept as true or false only: whether every row or
// epoch the code reads had the field present and parsed. A share would be a
// statistic of the chain; a boolean says whether the parser works.
function parseCoverage(report) {
  const p = {};
  if (report.cred_checks) p['stake_address.hash_raw'] = ['bad_length', 'bad_header', 'bad_script_flag', 'bad_script_hash', 'bad_network'].every((k) => report.cred_checks[k] === 0);
  if (report.txo_counts) p['tx_out.payment_cred'] = report.txo_counts.n_txo_payment_cred_null === 0;
  if (report.era_coverage) {
    const e = report.era_coverage;
    p['epoch_param.fees'] = e.n_fees === e.n_epochs;
    p['epoch_param.min_utxo'] = e.n_min_utxo === e.n_epochs;
    p['epoch_param.max_val_size'] = e.n_max_val_size === e.n_epochs;
  }
  if (report.unfrackit) p['tx_metadata[674].json'] = report.unfrackit.n_674_json_null === 0;
  return p;
}

// Functional checks a live-fire run records: true or false, nothing counted.
function functionalChecks(report) {
  const c = {};
  if (report.probes) c.db_probes = Object.values(report.probes).every(Boolean);
  if (report.order_check) c.order_check = report.order_check.passed;
  if (report.cred_checks) c.credential_checks = true;
  if (report.peak_vs_frozen) c.peak_rule_reproduces_frozen = report.peak_vs_frozen.agrees;
  if (report.check_61) c.check_6_1_all_agree = report.check_61.n_excluded === 0;
  if (report.profile_check) c.profile_spends_match_frame = report.profile_check.spend_count_mismatch === 0;
  return c;
}

// Aggregate tables a kept live-fire run drops anyway: each is a count of the
// population one query away. The wallet-level tables stay for debugging the
// failing step; their outputs, steps and anything after them are recomputed
// on a resumed run.
const LIVE_FIRE_AGGREGATES = ['study.flow', 'study.draw_summary', 'study.ft_floor', 'study.nft_top', 'study.unfrackit_tx'];

// A session-level advisory lock held by a run or a cleanup for its whole
// connection: steps drop and rebuild shared study tables, so two runs at once
// would read each other's tables.
const LOCK_KEY = 0x52436f72; // "RCor"
export async function takeLock(client) {
  const r = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY])).rows[0];
  if (!r.ok) throw refuse('refusing: another run or cleanup is using the study schema of this database');
}

export async function runPipeline(opts) {
  const live = opts.liveFire || null;
  const t0 = performance.now();
  const say = opts.log || ((s) => process.stderr.write(s + '\n'));
  // A live-fire run prints only step names, outcomes and times.
  const log = live ? () => {} : say;
  const codeAtStart = codeVersion();
  const blocks = loadAll();
  const code = { git_commit: codeAtStart.git_commit, git_dirty: codeAtStart.git_dirty, node: codeAtStart.node };
  // A live-fire run's gate (connection, probes, refusals, the hypotheses
  // record on mainnet, the run's own row) is logged as a query before the
  // first database query; the live-fire start entry follows only once the
  // gate has passed, and the end entry closes it.
  let gateStart = null;
  let gateClosed = false;
  let startEntry = null;
  if (live) {
    if (!opts.expectNetwork) throw refuse('refusing: a live-fire run needs --expect-network, so that its check-log entry is written before the first query');
    gateStart = appendEntry(opts.expectNetwork, 'query-start', { name: 'live-fire gate', run_id: opts.runId, command: opts.command || null, code });
  }
  // opts.client lets the unit tests stand a stub in for the database.
  let client = null;
  const report = { run_id: opts.runId };
  let network = live ? opts.expectNetwork : null;
  let runner = null;
  let error = null;
  let dir = null;
  let result = null;
  // Set once this invocation has created or resumed a live-fire run: only
  // then may it drop that run's tables.
  let ownsLiveRun = false;
  // A study run on mainnet is logged too, as a query.
  let queryStart = null;
  try {
    client = opts.client || (await connect(opts.db || {}));
    const meta = await dbMeta(client, blocks);
    if (opts.expectNetwork && opts.expectNetwork !== meta.network) throw refuse(`refusing: database is ${meta.network}, expected ${opts.expectNetwork}`);
    network = meta.network;
    report.network = network;
    if (!live && network === 'mainnet') queryStart = appendEntry(network, 'query-start', { name: 'run', run_id: opts.runId, command: opts.command || null, code });
    report.probes = await checkHistoryIntact(client, blocks, meta);
    const mainnet = network === 'mainnet';
    const finalRun = !live && !!opts.freezeTx;
    const mode = live ? 'live-fire' : mainnet ? 'study' : 'test';

    // Options.
    if (mainnet) {
      const errors = mainnetOptionErrors({ set: opts.set || [], strataPath: opts.strataGiven ? opts.strataList : null, defaultStrataPath: DEFAULT_STRATA, snapshot: opts.snapshot, live: !!live });
      if (opts.capture) errors.push('no plan capture under EXPLAIN ANALYZE on mainnet');
      if (opts.hmacKey) errors.push('mainnet runs use the study key in secret/hmac.key');
      if (opts.standInTx) errors.push('a stand-in for h is for test networks only');
      if (opts.fromBlock !== undefined && opts.fromBlock !== null) errors.push('--from-block is for test networks only: on mainnet the scan for the study key\'s records starts at genesis');
      if (errors.length) throw refuse(`refusing: ${errors.join('; ')}`);
    }
    if (finalRun && opts.snapshot && opts.snapshot !== 'rule') throw refuse('refusing: the snapshot of a run on the final freeze is fixed by rule (the last block of epoch N - 1); give no --snapshot');
    const caseViews = checkStakeAddresses([...new Set([...(opts.caseWallets || []), ...(opts.casesFile ? readStakeList(opts.casesFile, 'the cases file') : [])])], '--case and --cases');
    if (live) {
      if (!HEX32.test(live.testH || '')) throw refuse('refusing: a live-fire run needs --test-h <64 lowercase hex>');
      if (!live.purpose || !live.purpose.trim()) throw refuse('refusing: a live-fire run needs --purpose');
      if (opts.freezeTx || opts.standInTx) throw refuse('refusing: a live-fire run uses a stated test h, never a freeze or stand-in transaction');
      if (opts.capture) throw refuse('refusing: a live-fire run may use --explain, not --capture');
      // The hypotheses are frozen before the first live-fire run on mainnet.
      if (mainnet && (!HEX32.test(opts.hypothesesTx || '') || !HEX32.test(opts.studyKey || ''))) throw refuse('refusing: a mainnet live-fire run needs --hypotheses-tx and --study-key (the hypotheses freeze comes first)');
      const used = (await q(client, blocks, 'test_h_in_use', { h: { type: 'bytea', value: live.testH } }))[0];
      if (used.nonce || used.block_hash) throw refuse('refusing: the test h is an epoch nonce or block hash of this chain');
      if (mainnet) {
        const hyp = await readTx(client, blocks, opts.hypothesesTx);
        if (!hyp || !signedBy(hyp, opts.studyKey)) throw refuse('refusing: the hypotheses freeze is not in the database with a record signed by the study key');
        report.hypotheses = { tx: hyp.tx, block_no: hyp.block.block_no, time: hyp.block.time };
      }
    } else if (mainnet) {
      for (const [k, flag] of [['freezeTx', '--freeze-tx'], ['prereg', '--prereg'], ['studyKey', '--study-key'], ['codeManifest', '--code-manifest'], ['drawkey', '--drawkey']]) {
        if (!opts[k]) throw refuse(`refusing a mainnet database without ${flag} (or --live-fire before the final freeze)`);
      }
      const errs = codeManifestErrors(readFileSync(opts.codeManifest, 'utf8'), codeAtStart.files);
      if (errs.length) throw refuse(`refusing: the code differs from the code manifest: ${errs.join('; ')}`);
    }

    await takeLock(client);
    const session = await applySession(client, opts.session || {});
    for (const lib of ['schema', 'cip67', 'strata_fn']) {
      await new Runner({ client, blocks, runId: '-', params: {}, log: () => {} }).run(lib);
    }

    const runId = opts.runId;
    const existing = await client.query('SELECT network FROM study.run WHERE run_id = $1', [runId]);
    if (existing.rows.length && existing.rows[0].network !== network) throw refuse(`refusing: run ${runId} belongs to ${existing.rows[0].network}`);
    const finals = (await client.query(`SELECT run_id FROM study.param WHERE key = 'freeze' AND value->>'role' = 'final-freeze' AND run_id <> $1 ORDER BY run_id`, [runId])).rows;
    if (live && finals.length) throw refuse(`refusing: this database holds the study's run ${finals[0].run_id}; live-fire runs would overwrite its tables`);
    // One study run per final freeze. Its snapshot is fixed by rule and
    // confirmed beyond rollback, so a second run could only repeat it; a run
    // that stopped resumes under its own id.
    if (finalRun && finals.length) throw refuse(`refusing: the study's run ${finals[0].run_id} is already recorded for the final freeze; resume it under its own run id`);
    const stored0 = existing.rows.length ? await loadParams(client, runId) : {};
    if (stored0.mode && stored0.mode !== mode) throw refuse(`refusing: run ${runId} was started in ${stored0.mode} mode`);
    if (!existing.rows.length) await client.query('INSERT INTO study.run (run_id, network) VALUES ($1, $2)', [runId, network]);
    await storeParam(client, runId, 'mode', mode);
    // Set again when this invocation finishes the run.
    await client.query(`DELETE FROM study.param WHERE run_id = $1 AND key = 'finished'`, [runId]);
    if (live) {
      ownsLiveRun = true;
      appendEntry(network, 'query', { name: 'live-fire gate', start_seq: gateStart.seq, outcome: 'succeeded', error: null, run_ms: Math.round(performance.now() - t0) });
      gateClosed = true;
      startEntry = appendEntry(network, 'live-fire-start', { run_id: opts.runId, gate_seq: gateStart.seq, command: opts.command || null, purpose: live.purpose || null, test_h: live.testH || null, code });
    }
    const stored = await loadParams(client, runId);
    dir = runDir(network, runId);

    // Settings: fixed values and readings, with overrides. A resumed run must
    // use the settings it started with.
    const settings = applyOverrides(defaultSettings(), opts.set || []);
    const canonical = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
    if (stored.settings && canonical(stored.settings) !== canonical(settings)) throw refuse(`refusing: run ${runId} was started with other settings; use a new run id`);
    await storeParam(client, runId, 'settings', settings);
    await storeParam(client, runId, 'db', { network, version: meta.version, schema_version: meta.schemaVersion, extra_migrations: meta.extraMigrations });
    await storeParam(client, runId, 'session', session);
    Object.assign(report, { mode, settings, session });
    const tip = (await q(client, blocks, 'tip_block'))[0];

    // h. Study: the epoch nonce of the final freeze's epoch rule, after the
    // freeze record is checked. Test networks: the same rule from a stand-in
    // transaction's block, or a rehearsal freeze checked like the study's.
    // Live-fire: the stated test value.
    const koios = opts.koios || (!live ? new Koios(network, { log }) : null);
    let freeze = stored.freeze;
    if (live) {
      if (freeze && freeze.h !== live.testH) throw refuse(`refusing: run ${runId} was started with another test h`);
      freeze = { role: 'live-fire test h', h: live.testH };
    } else {
      const given = opts.freezeTx || opts.standInTx;
      if (freeze && given && given.toLowerCase() !== freeze.tx) throw refuse(`refusing: run ${runId} was started with ${freeze.role} transaction ${freeze.tx}`);
      if (opts.freezeTx) {
        // The code manifest given at run time must be the one the
        // pre-registration names, so the path-by-path comparison is the
        // frozen one; on mainnet, the check-log prefix it names must be a
        // prefix of the log.
        const codeManifestSha256 = opts.codeManifest ? sha256hex(readFileSync(opts.codeManifest)) : null;
        const checkLogText = mainnet ? (existsSync(checkLogPath(network)) ? readFileSync(checkLogPath(network), 'utf8') : '') : undefined;
        const v = await verifyFinalFreeze({ client, blocks, freezeTx: opts.freezeTx, hypothesesTx: opts.hypothesesTx || null, preregPath: opts.prereg, studyKey: opts.studyKey, codeDigests: hashList(), tipBlockNo: Number(tip.block_no), codeManifestSha256, checkLogText, fromBlock: mainnet ? null : opts.fromBlock ?? null });
        report.freeze_checks = v.checks;
        if (!v.ok) throw refuse(`refusing the freeze transaction: ${v.checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail && typeof c.detail === 'string' ? ` (${c.detail})` : ''}`).join('; ')}`);
        const dk = await drawKey({ client, blocks, network, block: v.freezeBlock, koios, txHash: v.freeze.tx, drawkeyFile: opts.drawkey || null });
        const fresh = { tx: v.freeze.tx, role: 'final-freeze', ...v.freeze, document_sha256: v.document.sha256, study_key: opts.studyKey.toLowerCase(), hypotheses: v.hypotheses, code_manifest_sha256: codeManifestSha256, scan: v.scan, draw: dk, h: dk.nonce };
        if (freeze && freeze.h !== fresh.h) throw refuse(`refusing: run ${runId} was started with another draw key`);
        freeze = fresh;
      } else if (!freeze) {
        if (!HEX32.test((opts.standInTx || '').toLowerCase())) throw refuse('refusing: give --stand-in-tx <64 hex> (test networks), --freeze-tx with its checks, or --live-fire');
        const st = await readTx(client, blocks, opts.standInTx.toLowerCase());
        if (!st) throw new Error(`transaction ${opts.standInTx} is not in the database`);
        const dk = await drawKey({ client, blocks, network, block: st.block, koios });
        freeze = { tx: st.tx, role: 'stand-in', block_no: st.block.block_no, slot_no: st.block.slot_no, epoch_no: st.block.epoch_no, epoch_slot_no: st.block.epoch_slot_no, block_hash: st.block.hash, time: st.block.time, draw: dk, h: dk.nonce };
      }
    }
    await storeParam(client, runId, 'freeze', freeze);
    report.freeze = freeze;
    const h = freeze.h;

    // Snapshot. A run on the final freeze: fixed by rule, the last block of
    // epoch N - 1, confirmed beyond rollback. A stand-in run on a test network
    // with --snapshot rule: the same. Otherwise the tip when the run starts
    // (db-sync stopped there), or on a test network a given block. A resumed
    // run keeps the block it recorded.
    let snapshot = stored.snapshot;
    const byRule = finalRun || (opts.snapshot === 'rule' && freeze.draw);
    if (!snapshot) {
      let b;
      let chosen;
      let rule = null;
      if (byRule) {
        const rs = await ruleSnapshot({ client, blocks, network, n: freeze.draw.n, koios, tipBlockNo: Number(tip.block_no) });
        b = rs.block;
        chosen = 'rule';
        rule = { ...rs.rule, confirmation: rs.confirmation };
      } else {
        if (opts.snapshot === 'rule') throw refuse('refusing: --snapshot rule needs a draw epoch (--freeze-tx or --stand-in-tx)');
        const useTip = opts.snapshot === 'tip' || !opts.snapshot;
        const rows = useTip ? [tip] : await q(client, blocks, 'block_by_hash', { block_hash: { type: 'bytea', value: opts.snapshot } });
        if (!rows.length) throw new Error(`snapshot block ${opts.snapshot} not found`);
        b = rows[0];
        chosen = useTip ? 'tip' : 'hash';
      }
      const t = (await q(client, blocks, 't_of_block', { block_id: { type: 'int', value: b.id } }))[0].t;
      snapshot = { id: num(b.id), block_no: num(b.block_no), slot_no: num(b.slot_no), epoch_no: num(b.epoch_no), time: b.time, hash: b.hash, t: num(t), chosen, rule };
      await storeParam(client, runId, 'snapshot', snapshot);
    } else if (opts.snapshot && !['tip', 'rule'].includes(opts.snapshot) && opts.snapshot !== snapshot.hash) {
      throw refuse(`refusing: run ${runId} has snapshot ${snapshot.hash}`);
    }
    report.snapshot = snapshot;
    if (!live && !(snapshot.block_no >= freeze.block_no)) throw refuse(`refusing: snapshot block ${snapshot.block_no} is before the freeze block ${freeze.block_no}`);

    const run = { network, runId, settings, snapshot, h, windows: stored.windows || null };
    runner = new Runner({ client, blocks, runId, params: sqlParams(run), capture: !!opts.capture && !mainnet && !live, explain: !!opts.explain, quiet: !!live, log: live ? (s) => say(s.replace(/, \d+ rows$/, '')) : log, redo: new Set(opts.redo || []) });
    const setParams = () => {
      runner.params = sqlParams(run);
    };

    // Block and transaction ids increase along the chain, or tx-id ranges are
    // not windows (integration test T1).
    const ocStart = performance.now();
    const oc = stored.order_check || numRow((await q(client, blocks, 'order_check'))[0]);
    const failedOrder = ['blocks_out_of_order', 'blocks_not_after_previous', 'tx_out_of_order', 'tx_index_repeated'].filter((k) => oc[k] !== 0 && oc[k] !== undefined);
    if (!stored.order_check) oc.ms = performance.now() - ocStart;
    oc.passed = failedOrder.length === 0;
    await storeParam(client, runId, 'order_check', live ? { passed: oc.passed } : oc);
    report.order_check = oc;
    if (failedOrder.length) throw refuse(`order check failed (${failedOrder.join(', ')}); transaction-id ranges cannot stand for windows`);

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
        first_eligible_epoch: num(pc.first_eligible_epoch),
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
      report.peak_vs_frozen = { frozen, agrees: frozen.first_epoch === run.windows.peak.first_epoch && frozen.last_epoch === run.windows.peak.last_epoch && frozen.n_tx === run.windows.peak.n_tx_rule };
    }
    await runner.run('era_report');
    report.era_changes = await q(client, blocks, 'era_changes', runner.params);
    report.era_coverage = numRow((await q(client, blocks, 'era_coverage'))[0]);
    report.snapshot_epoch_param = JSON.parse((await q(client, blocks, 'snapshot_epoch_param', runner.params))[0].row);

    // Credentials.
    await runner.run('cred');
    report.cred_checks = numRow((await q(client, blocks, 'cred_checks', runner.params))[0]);
    const badCred = ['bad_length', 'bad_header', 'bad_script_flag', 'bad_script_hash', 'bad_network'].filter((k) => report.cred_checks[k] !== 0);
    if (badCred.length) throw new Error(`credential checks failed: ${badCred.join(', ')}`);

    // The life table and the frames.
    for (const s of ['txo', 'txo_asset', 'asset']) await runner.run(s);
    report.txo_counts = numRow((await q(client, blocks, 'txo_counts'))[0]);
    for (const s of ['activity', 'state', 'paycount', 'frame', 'flow']) await runner.run(s);
    report.flow = (await q(client, blocks, 'flow_rows')).map((r) => ({ ...r, n_in: num(r.n_in), n_removed: num(r.n_removed), n_out: num(r.n_out) }));
    report.frame_report = (await q(client, blocks, 'frame_report', runner.params)).map((r) => numRow(r, ['frame']));

    // The draw and the samples.
    await runner.run('draw');
    report.draw = (await q(client, blocks, 'draw_summary_rows')).map((r) => numRow(r, ['frame', 'guard_reached']));
    const strata = loadStrataList(opts.strataList || DEFAULT_STRATA, settings);
    await runner.run('strata_list_table', {}, async (c) => {
      await qBound(c, blocks, 'strata_list_load', [JSON.stringify(strata.named)]);
      await qBound(c, blocks, 'strata_candidate_load', [JSON.stringify(strata.candidates)]);
    });
    if (!live) await storeParam(client, runId, 'strata_list', strata);
    await runner.run('ft_floor');
    await runner.run('nft_top');
    await runner.run('strata');
    report.ft_floor = (await q(client, blocks, 'ft_floor_report')).map((r) => ({ ...r, rank: num(r.rank), n_holders: num(r.n_holders) }));
    report.strata = (await q(client, blocks, 'strata_report')).map((r) => ({ ...r, ord: num(r.ord), nft_top_holders: num(r.nft_top_holders), n_recent: num(r.n_recent), n_peak: num(r.n_peak) }));
    await runner.run('split', {}, (c) => qBound(c, blocks, 'case_wallet_load', [caseViews]));
    await runner.run('sample_wallets');
    report.case_wallets = { listed: caseViews.length, matched: num((await client.query('SELECT count(*) AS n FROM study.case_wallet')).rows[0].n) };

    // Section 6.1 check, before anything that counts the sample.
    await runner.run('check_61_table', {}, async (c) => {
      report.check_61_run = await check61({ client: c, blocks, run, params: runner.params, log, batch: opts.batch || 500 });
      await q(c, blocks, 'check_61_mark');
    });
    report.check_61 = numRow((await q(client, blocks, 'check_61_counts'))[0], ['direct_valid']);
    report.split = (await q(client, blocks, 'split_counts')).map((r) => numRow(r, ['frame', 'kind', 'stratum']));
    report.split_overall = numRow((await q(client, blocks, 'split_overall'))[0]);
    report.sample_bounds = (await q(client, blocks, 'sample_bounds')).map((r) => ({ ...r, n: num(r.n) }));
    report.pointer_wallets = numRow((await q(client, blocks, 'pointer_wallets'))[0]);

    // Prior-treated and franken flags.
    await runner.run('unfrackit_tx');
    report.unfrackit = numRow((await q(client, blocks, 'unfrackit_report', runner.params))[0], ['earliest_match_time', 'latest_match_time']);
    if (!live) report.unfrackit_matches = await q(client, blocks, 'unfrackit_matches');
    await runner.run('prior_flags');
    report.prior = (await q(client, blocks, 'prior_counts')).map((r) => numRow(r, ['frame']));
    await runner.run('franken');
    report.franken = numRow((await q(client, blocks, 'franken_counts'))[0]);

    // Profile inputs (descriptive until v0.3 specifies the data-driven profiles).
    await runner.run('script_tx');
    await runner.run('profile');
    report.profile_check = numRow((await q(client, blocks, 'profile_check'))[0]);
    report.profiles = (await q(client, blocks, 'profile_counts')).map((r) => ({ ...r, n: num(r.n), nft_heavy: num(r.nft_heavy), ft_heavy: num(r.ft_heavy), dex_active: num(r.dex_active) }));

    if (live) {
      result = { runId, dir, mode, live: true };
      return result;
    }

    // Code version and manifest.
    const codeAtEnd = codeVersion();
    if (JSON.stringify(codeAtEnd.files) !== JSON.stringify(codeAtStart.files)) throw refuse('refusing to write the manifest: a hashed file changed during the run; run again with a new run id');
    report.code_version = codeAtStart;
    await storeParam(client, runId, 'code_version', report.code_version);
    report.steps = runner.timings.map((t) => ({ name: t.name, file: t.file, ms: Math.round(t.ms), rows: t.rows }));
    const manifest = await buildManifest({ client, run, report, hmacKeyPath: opts.hmacKey, dir });
    writeJson(join(dir, 'params.json'), { run_id: runId, network, mode, snapshot, freeze, h, windows: run.windows, settings, session, case_wallets: report.case_wallets, code_version: report.code_version, db: (await loadParams(client, runId)).db });
    writeJson(join(dir, 'report.json'), report);
    writeJson(join(dir, 'timings.json'), runner.timings);
    writeJson(join(dir, 'manifest.json'), manifest);
    writePrivate(join(dir, 'README.txt'), 'Private run directory of the research-corpus tool. Raw lists name stake addresses; only manifest.json is meant for publication.\n');
    await storeParam(client, runId, 'finished', { at: new Date().toISOString() });
    result = { runId, dir, report, manifest, timings: runner.timings };
    return result;
  } catch (e) {
    error = e;
    throw live ? new Error(sanitizeError(e)) : e;
  } finally {
    if (live && gateStart && !gateClosed) {
      // The gate failed: a query that refused, not a live-fire run.
      appendEntry(network, 'query', { name: 'live-fire gate', start_seq: gateStart.seq, outcome: 'failed', error: error ? sanitizeError(error) : null, run_ms: Math.round(performance.now() - t0) });
    }
    if (live && startEntry) {
      let outputs = 'none written';
      let dropped = null;
      if (ownsLiveRun && client) {
        try {
          // Drop only a run this invocation created or resumed as live-fire,
          // and only while it is still recorded as one.
          const m = (await client.query(`SELECT value #>> '{}' AS m FROM study.param WHERE run_id = $1 AND key = 'mode'`, [opts.runId])).rows[0];
          if (!m || m.m !== 'live-fire') throw new Error('the run is not recorded as live-fire');
          if (live.keep) {
            // Only aggregates this run built.
            for (const t of LIVE_FIRE_AGGREGATES) {
              const own = (await client.query('SELECT obj_description(to_regclass($1), $2) AS c', [t, 'pg_class'])).rows[0].c === mark(opts.runId);
              if (own) await client.query(`DROP TABLE IF EXISTS ${t}`);
            }
            outputs = 'kept for debugging';
          } else {
            dropped = (await dropRunTables(client, opts.runId)).length;
            if (dir && existsSync(join(dir, 'work'))) rmSync(join(dir, 'work'), { recursive: true, force: true });
            outputs = `deleted ${new Date().toISOString()}`;
          }
        } catch (e) {
          outputs = `deletion failed: ${sanitizeError(e)}`;
        }
      }
      const steps = runner ? runner.timings.filter((t) => t.kind === 'step').map((t) => ({ name: t.name, ok: true, ms: Math.round(t.ms) })) : [];
      if (runner && runner.failed) steps.push({ name: runner.failed.name, ok: false, ms: Math.round(runner.failed.ms) });
      const entry = {
        run_id: opts.runId,
        start_seq: startEntry ? startEntry.seq : null,
        command: opts.command || null,
        purpose: live.purpose || null,
        test_h: live.testH || null,
        code,
        outcome: error ? 'failed' : 'succeeded',
        error: error ? sanitizeError(error) : null,
        run_ms: Math.round(performance.now() - t0),
        steps,
        checks: functionalChecks(report),
        parse: parseCoverage(report),
        explain: !!opts.explain,
        wallet_level_output: outputs,
        study_tables_dropped: dropped !== null
      };
      if (network && startEntry) {
        const logged = appendEntry(network, 'live-fire', entry);
        if (dir) {
          writeJson(join(dir, 'live-fire.json'), logged);
          if (opts.explain && runner) writeJson(join(dir, 'plans.json'), runner.timings.map((t) => ({ name: t.name, statements: t.statements.map((s) => ({ head: s.head, plan: s.plan })) })));
        }
        if (result) result.entry = logged;
      }
    }
    if (queryStart) appendEntry(network, 'query', { name: 'run', start_seq: queryStart.seq, outcome: error ? 'failed' : 'succeeded', error: error ? sanitizeError(error) : null, run_ms: Math.round(performance.now() - t0) });
    if (client && !opts.client) await client.end();
  }
}

// Drops a live-fire run's study tables and work directory, or removes an a1
// live-fire run's work directory, and logs when. An unclosed start entry of
// the run (an interrupted run) is closed by the cleanup entry.
export async function cleanupRun({ db, runId, command, client: given = null }) {
  const client = given || (await connect(db || {}));
  try {
    const blocks = loadAll();
    const meta = await dbMeta(client, blocks);
    const network = meta.network;
    const reg = (await client.query('SELECT to_regclass($1) AS t', ['study.param'])).rows[0].t;
    const mode = reg ? (await client.query(`SELECT value #>> '{}' AS m FROM study.param WHERE run_id = $1 AND key = 'mode'`, [runId])).rows[0] : null;
    const log = verifyLog(network);
    const text = existsSync(checkLogPath(network)) ? readFileSync(checkLogPath(network), 'utf8') : '';
    const entries = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    // A live-fire run is found by its mode row, or, once its rows are gone (a
    // run that finished after being kept, an a1 run), by its check-log entries.
    const logged = entries.some((e) => e.run_id === runId && ['live-fire', 'live-fire-start', 'a1-live-fire', 'a1-live-fire-start'].includes(e.type));
    if (!mode && !logged) throw refuse(`refusing: no live-fire run ${runId} in this database or the check log`);
    if (mode && mode.m !== 'live-fire') throw refuse(`refusing: run ${runId} is a ${mode.m} run; cleanup is for live-fire runs`);
    await takeLock(client);
    let outcome = 'succeeded';
    let error = null;
    let n = 0;
    try {
      // Only tables marked with this run id; with no mode row there may be none.
      if (reg) n = (await dropRunTables(client, runId)).length;
      const work = join(runDir(network, runId), 'work');
      if (existsSync(work)) rmSync(work, { recursive: true, force: true });
    } catch (e) {
      outcome = 'failed';
      error = sanitizeError(e);
    }
    const open = log.unclosed.find((x) => x.run_id === runId);
    const entry = appendEntry(network, 'cleanup', {
      run_id: runId,
      start_seq: open ? open.seq : null,
      command: command || null,
      outcome,
      error,
      wallet_level_output: outcome === 'succeeded' ? `deleted ${new Date().toISOString()}` : `deletion failed: ${error}`,
      tables_dropped: n
    });
    if (error) throw new Error(error);
    return entry;
  } finally {
    if (!given) await client.end();
  }
}

// Private (decided 2026-10-21): Adam K. Dean's own wallets are eligible like
// any other, and after the draw he checks how many were drawn, states the
// number, and a sensitivity analysis drops them. This counts the listed
// stake addresses in each drawn sample of a run and returns the counts; it
// writes nothing to the run directory, the manifest or the check log.
export async function ownDrawn(client, runId, views) {
  // Only a finished run that drew with the study's key: the study run of a
  // final freeze, or on a test network a test run. Never a live-fire run
  // (kept or not), never a run in progress.
  const p = await loadParams(client, runId);
  const study = p.mode === 'study' && p.freeze && p.freeze.role === 'final-freeze';
  if (!(study || p.mode === 'test')) throw refuse(`refusing: run ${runId} is ${p.mode ? `a ${p.mode} run` : 'not recorded'}; own-drawn reads only the study run of a final freeze (or a test run on a test network)`);
  if (!p.finished) throw refuse(`refusing: run ${runId} has not finished`);
  const owner = (await client.query('SELECT obj_description(to_regclass($1), $2) AS c', ['study.sample', 'pg_class'])).rows[0].c;
  if (owner !== mark(runId)) throw refuse(`refusing: study.sample does not belong to run ${runId}`);
  const rows = (
    await client.query(
      `SELECT s.frame, s.kind, s.stratum, count(*) AS drawn
         FROM study.sample s JOIN study.cred c ON c.sa_id = s.sa_id
        WHERE c.view = ANY ($1::text[])
        GROUP BY s.frame, s.kind, s.stratum ORDER BY s.frame DESC, s.kind, s.stratum`,
      [views]
    )
  ).rows;
  const wallets = (await client.query(`SELECT count(DISTINCT s.sa_id) AS n FROM study.sample s JOIN study.cred c ON c.sa_id = s.sa_id WHERE c.view = ANY ($1::text[])`, [views])).rows[0].n;
  return { run_id: runId, listed: views.length, drawn_wallets: Number(wallets), by_sample: rows.map((r) => ({ frame: r.frame, kind: r.kind, stratum: r.stratum, drawn: Number(r.drawn) })) };
}

export const resolvePath = (p) => (p ? resolve(p) : p);
