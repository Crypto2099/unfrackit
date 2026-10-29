// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The simulator's live-fire wallets: the step's choice, in each frame's draw
// order, of the first wallet meeting each of the ten conditions, a wallet
// meeting several counted once (a wallet first in both frames included), the
// Mary-era epochs read from protocol_major, a phase-2-invalid spend counted as
// executing a script; and the run's refusals and the check log: the flag
// outside a live-fire run, a second selection on mainnet, the kept selection
// reported until cleanup deletes it; and the simulator's own live-fire runs,
// which this tool's cleanup refuses and its second-selection refusal ignores.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { freshDb } from '../lib/pglite.mjs';
import { defaultSettings, sqlParams } from '../../src/params.mjs';
import { runPipeline, cleanupRun } from '../../src/pipeline.mjs';
import { appendEntry, verifyLog, checkLogPath, SIM_KEPT } from '../../src/checklog.mjs';
import { runDir, writeJson } from '../../src/paths.mjs';

async function fixture(maryMajor = 4) {
  const { db, runBlock, rows } = await freshDb();
  await db.exec(`
    CREATE TABLE public.block (id bigint PRIMARY KEY, epoch_no int);
    CREATE TABLE public.tx (id bigint PRIMARY KEY, block_id bigint, valid_contract boolean);
    CREATE TABLE public.epoch_param (epoch_no int PRIMARY KEY, protocol_major int);
    CREATE TABLE study.frame (frame text, sa_id bigint, n_assets_a bigint, n_assets_b bigint, n_utxo bigint);
    CREATE TABLE study.draw_order (frame text, sa_id bigint, k bigint, tok boolean, ge5 boolean, frag boolean);
    CREATE TABLE study.txo (tx_out_id bigint PRIMARY KEY, created_tx bigint, consumed_tx bigint, sa_id bigint, script_pay boolean);
    CREATE TABLE study.script_tx (tx_id bigint PRIMARY KEY);
    CREATE TABLE study.cred (sa_id bigint PRIMARY KEY, view text);
  `);
  // The peak window: epochs 1 and 2; epoch 1 is Mary era (protocol_major 4)
  // unless maryMajor says otherwise. Blocks 1 and 2, one transaction each;
  // the recent window's transactions are 3 to 10.
  await db.exec(`INSERT INTO public.block VALUES (1, 1), (2, 2), (3, 3);
                 INSERT INTO public.epoch_param VALUES (1, ${maryMajor}), (2, 5), (3, 9);
                 INSERT INTO public.tx VALUES (1, 1, true), (2, 2, false), (5, 3, true), (6, 3, true);
                 INSERT INTO study.script_tx VALUES (5);`);
  const order = async (frame, k, sa, { tok = true, ge5 = false, frag = false, nAssets = 1, nUtxo = 2 } = {}) => {
    await db.query(`INSERT INTO study.draw_order VALUES ($1, $2, $3, $4, $5, $6)`, [frame, sa, k, tok, ge5, frag]);
    await db.query(`INSERT INTO study.frame VALUES ($1, $2, $3, $3, $4)`, [frame, sa, nAssets, nUtxo]);
  };
  const spend = async (id, sa, tx) => db.query(`INSERT INTO study.txo VALUES ($1, 1, $2, $3, false)`, [id, tx, sa]);
  for (const sa of [10, 11, 12, 13, 14, 15, 16, 17]) await db.query(`INSERT INTO study.cred VALUES ($1, $2)`, [sa, `stake_test_${sa}`]);
  await order('recent', 1, 10, { tok: false, nAssets: 0 });
  await order('recent', 2, 11, { ge5: true, nAssets: 150 });
  await order('recent', 3, 12, { frag: true });
  await order('recent', 4, 13, { nUtxo: 2000 });
  await order('recent', 5, 14);
  await order('recent', 6, 15, { tok: false, nAssets: 0 });
  await spend(1, 14, 5); // a script-executing spend in the recent window
  await spend(2, 15, 6); // a plain spend
  await order('peak', 1, 11, { ge5: true });
  await order('peak', 2, 16);
  await order('peak', 3, 17);
  await spend(3, 16, 1); // a spend in the Mary-era epoch
  await spend(4, 17, 2); // a phase-2-invalid spend
  const p = sqlParams({ network: 'preprod', settings: defaultSettings(), snapshot: { id: 3, t: 10 }, h: '00'.repeat(32), windows: { recent: { lo: 3, hi: 10, t_start: 2, first_epoch: 3, last_epoch: 3 }, peak: { lo: 1, hi: 2, t_start: 0, first_epoch: 1, last_epoch: 2 } } });
  await runBlock('sim_wallets', p);
  return (await rows(`SELECT sa_id, conditions, frames FROM study.sim_wallet ORDER BY conditions[1]`)).map((r) => [Number(r.sa_id), r.conditions.map(Number), [...r.frames].sort()]);
}

test('the simulator\'s wallets: the first in draw order for each condition, each wallet once', async () => {
  assert.deepEqual(await fixture(), [
    [11, [1, 2, 3, 8], ['peak', 'recent']],
    [12, [4], ['recent']],
    [10, [5], ['recent']],
    [14, [6], ['recent']],
    [13, [7], ['recent']],
    [16, [9], ['peak']],
    [17, [10], ['peak']]
  ]);
  // A peak window with no Mary-era epoch gives no wallet for condition 9.
  assert.ok(!(await fixture(5)).some(([, conds]) => conds.includes(9)));
});

function withHome(fn) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'rc-sim-'));
    const prev = process.env.RESEARCH_CORPUS_HOME;
    process.env.RESEARCH_CORPUS_HOME = home;
    try {
      await fn(home);
    } finally {
      if (prev === undefined) delete process.env.RESEARCH_CORPUS_HOME;
      else process.env.RESEARCH_CORPUS_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

// A mainnet database stand-in: db-sync's meta and probes, a study schema in
// PGlite, and an error for any other chain query.
async function mainnetClient() {
  const db = await PGlite.create();
  await db.exec(`CREATE SCHEMA study;
    CREATE TABLE study.run (run_id text PRIMARY KEY, network text NOT NULL, created timestamptz DEFAULT now());
    CREATE TABLE study.param (run_id text NOT NULL REFERENCES study.run ON DELETE CASCADE, key text NOT NULL, value jsonb NOT NULL, PRIMARY KEY (run_id, key));`);
  return {
    async query(sql, params) {
      if (/FROM public\.meta m/.test(sql)) return { rows: [{ network_name: 'mainnet', version: 'v', start_time: 't', schema_version: '{"id":1}', extra_migrations: '[]' }] };
      if (/AS inline_datum/.test(sql)) return { rows: [{ tx_in: true, multi_asset: true, ma_tx_out: true, ma_tx_mint: true, metadata_674: true, redeemer: true, inline_datum: true, epoch_nonce: true }] };
      if (/\bpublic\./.test(sql)) throw new Error('a chain query was reached');
      return db.query(sql, params);
    },
    async end() {}
  };
}

test('--sim-wallets: only in a live-fire run, once on mainnet, kept until cleanup', withHome(async (home) => {
  await assert.rejects(runPipeline({ runId: 'x', simWallets: true, log: () => {} }), /--sim-wallets is for a live-fire run/);
  // A mainnet database whose check log records a selection already made.
  const client = await mainnetClient();
  const start = appendEntry('mainnet', 'live-fire-start', { run_id: 'lf-sim', purpose: 'p' });
  const end = appendEntry('mainnet', 'live-fire', { run_id: 'lf-sim', start_seq: start.seq, outcome: 'succeeded', wallet_level_output: 'deleted 2026-10-25T00:00:00Z', sim_wallets: SIM_KEPT });
  writeJson(join(runDir('mainnet', 'lf-sim'), 'sim', 'wallets.json'), { wallets: [] });
  await assert.rejects(
    runPipeline({ client, runId: 'lf-sim-2', log: () => {}, expectNetwork: 'mainnet', hypothesesTx: 'bb'.repeat(32), scamClone: home, liveFire: { testH: 'ab'.repeat(32), purpose: 'p', simWallets: true } }),
    new RegExp(`picked by run lf-sim \\(check-log entry ${end.seq}\\)`)
  );
  const entries = readFileSync(checkLogPath('mainnet'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(entries.slice(-2).map((e) => [e.type, e.name, e.outcome]), [['query-start', 'live-fire gate', undefined], ['query', 'live-fire gate', 'failed']], 'refused at the gate, before any chain query');
  // The kept selection is reported until cleanup deletes it.
  assert.deepEqual(verifyLog('mainnet').kept_not_cleaned.map((x) => x.run_id), ['lf-sim']);
  const ce = await cleanupRun({ client, runId: 'lf-sim', command: 'cleanup' });
  assert.equal(ce.outcome, 'succeeded');
  assert.ok(!existsSync(join(runDir('mainnet', 'lf-sim'), 'sim')));
  assert.deepEqual(verifyLog('mainnet').kept_not_cleaned, []);
}));

test("the simulator's runs: this tool's cleanup refuses one and deletes nothing, and a second selection is refused only for this tool's own", withHome(async (home) => {
  const client = await mainnetClient();
  // A simulator run kept for debugging; its end entry even carries the
  // selection's word, which only this tool's live-fire entries are read for.
  const st = appendEntry('mainnet', 'sim-live-fire-start', { run_id: 'sim-1', purpose: 'p' });
  const end = appendEntry('mainnet', 'sim-live-fire', { run_id: 'sim-1', start_seq: st.seq, outcome: 'failed', wallet_level_output: 'kept for debugging', sim_wallets: SIM_KEPT });
  // Directories under this tool's home at the run ID's place.
  for (const d of ['work', 'sim']) mkdirSync(join(runDir('mainnet', 'sim-1'), d), { recursive: true });
  const before = readFileSync(checkLogPath('mainnet'), 'utf8');
  await assert.rejects(cleanupRun({ client, runId: 'sim-1', command: 'cleanup' }), /run sim-1 is the simulator's; the simulator's cleanup deletes its output/);
  assert.equal(readFileSync(checkLogPath('mainnet'), 'utf8'), before, 'no cleanup entry');
  for (const d of ['work', 'sim']) assert.ok(existsSync(join(runDir('mainnet', 'sim-1'), d)), d);
  assert.deepEqual(verifyLog('mainnet').kept_not_cleaned, [{ run_id: 'sim-1', seq: end.seq }]);
  // With the simulator's entries alone in the log, a mainnet selection is not
  // refused as a second one: the run passes that refusal and stops at its
  // first chain query.
  await assert.rejects(
    runPipeline({ client, runId: 'lf-pick', log: () => {}, expectNetwork: 'mainnet', hypothesesTx: 'bb'.repeat(32), scamClone: home, liveFire: { testH: 'ab'.repeat(32), purpose: 'p', simWallets: true } }),
    (e) => /a chain query was reached/.test(e.message) && !/picked by run/.test(e.message)
  );
}));
