// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The mainnet refusals, through runPipeline itself with PGlite standing in for
// a mainnet database (db-sync's meta table says mainnet and every probe
// passes; the study schema is real): options that would change the sample, a
// missing or mismatched freeze or code manifest, a snapshot other than the
// rule, live-fire runs without their stated test h or the hypotheses freeze,
// and a second study run. A refused live-fire run never drops another run's
// tables; its gate is logged as a query, and only a run past the gate leaves
// a live-fire start entry, closed by an end entry. The wiring of the final
// freeze checks, the check log, the freeze tool's drawkey.json and the
// snapshot rule into the run, on chain tables held by PGlite. Also the code
// manifest comparison.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { runPipeline, cleanupRun, DEFAULT_STRATA } from '../../src/pipeline.mjs';
import { formatHashList, hashList } from '../../src/hash.mjs';
import { codeManifestErrors, mainnetOptionErrors } from '../../src/guards.mjs';
import { checkLogPath, verifyLog, appendEntry } from '../../src/checklog.mjs';
import { logPrefixDigests } from '../../src/freeze.mjs';
import { sha, keypair, record, metadataBytes, chain } from '../lib/records.mjs';

const FIXTURE_STRATA = new URL('../fixtures/strata-preprod.json', import.meta.url).pathname;
const STAKE_A = 'stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw';
const TEST_H = 'ab'.repeat(32);

// A mainnet "database": meta and the probes answered here, everything else by
// PGlite, which holds a study run with its tables. With `withChain`, PGlite
// also holds db-sync's block, tx, tx_metadata and epoch_param and chain
// queries reach them; without it, a chain query fails the test.
async function mainnetDb({ withChain = false, studyRun = true } = {}) {
  const db = await PGlite.create();
  await db.exec(`SET check_function_bodies = off; CREATE SCHEMA study;
    CREATE TABLE study.run (run_id text PRIMARY KEY, network text NOT NULL, created timestamptz DEFAULT now());
    CREATE TABLE study.param (run_id text NOT NULL REFERENCES study.run ON DELETE CASCADE, key text NOT NULL, value jsonb NOT NULL, PRIMARY KEY (run_id, key));
    CREATE TABLE study.step (run_id text NOT NULL REFERENCES study.run ON DELETE CASCADE, name text NOT NULL, started timestamptz, finished timestamptz, rows bigint, PRIMARY KEY (run_id, name));`);
  if (studyRun) {
    await db.exec(`INSERT INTO study.run VALUES ('study1', 'mainnet');
      INSERT INTO study.param VALUES ('study1', 'mode', '"study"'), ('study1', 'freeze', '{"role": "final-freeze", "h": "00"}');
      CREATE TABLE study.sample (sa_id bigint); INSERT INTO study.sample VALUES (1), (2);
      COMMENT ON TABLE study.sample IS 'research-corpus run study1';`);
  }
  const ch = withChain ? await chain(db) : null;
  const client = {
    async query(sql, params) {
      if (/FROM public\.meta m/.test(sql)) return { rows: [{ network_name: 'mainnet', version: 'v', start_time: 't', schema_version: '{"id":1}', extra_migrations: '[]' }] };
      if (/AS inline_datum/.test(sql)) return { rows: [{ tx_in: true, multi_asset: true, ma_tx_out: true, ma_tx_mint: true, metadata_674: true, redeemer: true, inline_datum: true, epoch_nonce: true }] };
      if (/^\s*SET (work_mem|maintenance_work_mem|max_parallel)/.test(sql) || /^\s*SHOW (work_mem|maintenance_work_mem|max_parallel)/.test(sql)) {
        const k = /(work_mem|maintenance_work_mem|max_parallel_workers_per_gather|max_parallel_maintenance_workers)/.exec(sql)[1];
        return /^\s*SHOW/.test(sql) ? { rows: [{ [k]: '1GB' }] } : { rows: [] };
      }
      if (!withChain && /^\s*(SELECT|WITH)\b/i.test(sql) && /\bpublic\./.test(sql)) throw new Error(`a chain query was reached: ${sql.replace(/\s+/g, ' ').slice(0, 80)}`);
      return db.query(sql, params);
    },
    async end() {}
  };
  const intact = async () => (await db.query(`SELECT (SELECT count(*) FROM study.run WHERE run_id = 'study1') AS runs, (SELECT count(*) FROM study.param WHERE run_id = 'study1') AS params, to_regclass('study.sample')::text AS t`)).rows[0];
  return { db, client, intact, ch };
}

function withHome(fn) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'rc-guards-'));
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

test('mainnet refusals through runPipeline; a refused live-fire run leaves the study run intact and a closed log entry', withHome(async (home) => {
  const m = await mainnetDb();
  const run = (opts) => runPipeline({ client: m.client, runId: 'guard-test', log: () => {}, strataList: DEFAULT_STRATA, ...opts });
  const manifest = join(home, 'code-manifest.txt');
  writeFileSync(manifest, formatHashList().replace(/^[0-9a-f]{64}(?= {2}src\/pipeline\.mjs$)/m, '0'.repeat(64)));
  const goodManifest = join(home, 'code-manifest-good.txt');
  writeFileSync(goodManifest, formatHashList());
  const freeze = { freezeTx: 'aa'.repeat(32), hypothesesTx: 'bb'.repeat(32), prereg: manifest, studyKey: 'cc'.repeat(32), drawkey: manifest };
  const live = (over = {}) => ({ expectNetwork: 'mainnet', liveFire: { testH: TEST_H, purpose: 'p', ...over } });
  const cases = [
    [{}, /without --freeze-tx/],
    [{ set: ['guard=1000'] }, /--set changes guard/],
    [{ set: ['guard=200000'] }, /without --freeze-tx/],
    [{ strataList: FIXTURE_STRATA, strataGiven: true }, /not the hashed strata file/],
    [{ snapshot: 'ab'.repeat(32) }, /snapshot is fixed by rule/],
    [{ snapshot: 'tip' }, /snapshot is fixed by rule/],
    [{ ...freeze, codeManifest: goodManifest, snapshot: 'tip' }, /snapshot is fixed by rule/],
    [{ capture: true }, /no plan capture/],
    [{ standInTx: 'ab'.repeat(32) }, /stand-in for h is for test networks only/],
    [{ hmacKey: manifest }, /study key in secret\/hmac\.key/],
    [{ ...freeze, codeManifest: undefined }, /without --code-manifest/],
    [{ ...freeze, codeManifest: goodManifest, drawkey: undefined }, /without --drawkey/],
    [{ ...freeze, codeManifest: manifest }, /differs from the code manifest: differs: src\/pipeline\.mjs/],
    // A second study run while one is recorded for the final freeze.
    [{ ...freeze, codeManifest: goodManifest }, /already recorded for the final freeze/],
    [{ liveFire: { testH: TEST_H, purpose: 'p' } }, /needs --expect-network/],
    [{ ...live({ testH: undefined }) }, /needs --test-h/],
    [{ ...live({ purpose: undefined }) }, /needs --purpose/],
    [{ ...live(), freezeTx: 'aa'.repeat(32) }, /never a freeze or stand-in/],
    [{ ...live(), explain: true, capture: true }, /no plan capture/],
    [{ ...live(), snapshot: 'ab'.repeat(32) }, /--snapshot must be tip for a live-fire run/],
    [{ ...live() }, /needs --hypotheses-tx and --study-key/],
    [{ ...live(), caseWallets: ['stake1notanaddress'] }, /--case and --cases/]
  ];
  for (const [opts, want] of cases) await assert.rejects(run(opts), want, JSON.stringify(opts));
  // A refused live-fire run under the study run's own id drops nothing.
  await assert.rejects(runPipeline({ client: m.client, runId: 'study1', log: () => {}, ...live({ testH: undefined }) }), /needs --test-h/);
  assert.deepEqual(await m.intact(), { runs: 1, params: 2, t: 'study.sample' });
  // A refused live-fire attempt is a failed gate query, never a live-fire
  // run: no start entry, and every gate start closed.
  const v = verifyLog('mainnet');
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.unclosed, []);
  assert.deepEqual(v.failed_deletions, []);
  const entries = readFileSync(checkLogPath('mainnet'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(entries.filter((e) => e.type === 'live-fire-start' || e.type === 'live-fire').length, 0);
  const gates = entries.filter((e) => e.type === 'query' && e.name === 'live-fire gate');
  assert.equal(gates.length, 8);
  for (const e of gates) {
    assert.equal(e.outcome, 'failed');
    assert.equal(entries.find((x) => x.seq === e.start_seq).type, 'query-start');
  }
  assert.match(entries.at(-1).error, /needs --test-h <64 lowercase hex>/, 'a refusal keeps its own wording');
}));

test('an interrupted live-fire run is reported until cleanup closes it', withHome(async () => {
  const m = await mainnetDb();
  // A live-fire run that got as far as recording itself, then stopped.
  await m.db.exec(`INSERT INTO study.run VALUES ('lf9', 'mainnet'); INSERT INTO study.param VALUES ('lf9', 'mode', '"live-fire"');
                   CREATE TABLE study.frame (sa_id bigint); COMMENT ON TABLE study.frame IS 'research-corpus run lf9';`);
  appendEntry('mainnet', 'live-fire-start', { run_id: 'lf9', purpose: 'interrupted' });
  assert.deepEqual(verifyLog('mainnet').unclosed.map((x) => x.run_id), ['lf9']);
  // cleanup refuses the study run, and cleans the live-fire one.
  await assert.rejects(cleanupRun({ client: m.client, runId: 'study1' }), /is a study run/);
  const e = await cleanupRun({ client: m.client, runId: 'lf9', command: 'cleanup' });
  assert.equal(e.start_seq, 1);
  assert.equal((await m.db.query(`SELECT to_regclass('study.frame')::text AS t`)).rows[0].t, null);
  assert.deepEqual(await m.intact(), { runs: 1, params: 2, t: 'study.sample' });
  const v = verifyLog('mainnet');
  assert.deepEqual(v.unclosed, []);
  assert.deepEqual(v.kept_not_cleaned, []);
}));

test('cleanup takes an a1 live-fire run from the check log', withHome(async (home) => {
  const m = await mainnetDb();
  const start = appendEntry('mainnet', 'a1-live-fire-start', { run_id: 'a1-x', purpose: 'p' });
  appendEntry('mainnet', 'a1-live-fire', { run_id: 'a1-x', start_seq: start.seq, outcome: 'succeeded', wallet_level_output: 'kept for debugging' });
  writeFileSync(join(home, 'marker'), '');
  assert.deepEqual(verifyLog('mainnet').kept_not_cleaned.map((x) => x.run_id), ['a1-x']);
  await cleanupRun({ client: m.client, runId: 'a1-x' });
  assert.deepEqual(verifyLog('mainnet').kept_not_cleaned, []);
  await assert.rejects(cleanupRun({ client: m.client, runId: 'nothing' }), /no live-fire run nothing/);
}));

test('a test network takes run-time options the mainnet refuses', () => {
  assert.deepEqual(mainnetOptionErrors({ set: ['guard=200000'], strataPath: DEFAULT_STRATA, defaultStrataPath: DEFAULT_STRATA, snapshot: 'tip', live: true, nodeVersion: 'v24.1.0' }), []);
  assert.deepEqual(mainnetOptionErrors({ snapshot: 'rule', nodeVersion: 'v24.1.0' }), []);
  assert.match(mainnetOptionErrors({ nodeVersion: 'v20.19.0' }).join(), /pinned to Node 24/);
  assert.match(mainnetOptionErrors({ set: ['x8_measure=units'], nodeVersion: 'v24.1.0' }).join(), /x8_measure/);
});

test('the code manifest: the hash output itself matches, and every difference is named', () => {
  assert.deepEqual(codeManifestErrors(formatHashList(), hashList()), []);
  const files = hashList();
  const text = formatHashList();
  const dropped = text.split('\n').filter((l) => !l.endsWith('  src/guards.mjs')).join('\n');
  assert.deepEqual(codeManifestErrors(dropped, files), ['not in the manifest: src/guards.mjs']);
  assert.deepEqual(codeManifestErrors(text + `${'0'.repeat(64)}  src/extra.mjs\n`, files), ['missing: src/extra.mjs']);
  assert.throws(() => codeManifestErrors('nothing here', files), /lists no files/);
});

// Live-fire on mainnet: a hypotheses record signed by another key is refused
// at the gate, and so is any run on a database holding the study's run; a run
// past the gate is logged as live-fire (start and end entries) whatever
// happens to it next.
test('a mainnet live-fire run needs the hypotheses record signed by the study key', withHome(async () => {
  for (const studyRun of [true, false]) {
    const m = await mainnetDb({ withChain: true, studyRun });
    const key = keypair();
    const hypDigest = sha('hypotheses');
    const good = await m.ch.add({ blockNo: 100, slot: 1000, epoch: 1, epochSlot: 10, body: metadataBytes(record([hypDigest], key)), msg: hypDigest });
    const other = await m.ch.add({ blockNo: 101, slot: 1001, epoch: 1, epochSlot: 11, body: metadataBytes(record([hypDigest], keypair())), msg: hypDigest });
    const run = (hypothesesTx) => runPipeline({ client: m.client, runId: 'lf-hyp', log: () => {}, expectNetwork: 'mainnet', liveFire: { testH: TEST_H, purpose: 'p' }, hypothesesTx, studyKey: key.pub.toString('hex') });
    await assert.rejects(run(other), /not in the database with a record signed by the study key/);
    if (studyRun) {
      await assert.rejects(run(good), /holds the study's run study1/);
      assert.deepEqual(await m.intact(), { runs: 1, params: 2, t: 'study.sample' });
    } else {
      // Past the gate; the first step then fails on the stand-in chain.
      await assert.rejects(run(good));
    }
  }
  const entries = readFileSync(checkLogPath('mainnet'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(entries.filter((e) => e.type === 'query').map((e) => e.outcome), ['failed', 'failed', 'failed', 'succeeded']);
  const starts = entries.filter((e) => e.type === 'live-fire-start');
  assert.equal(starts.length, 1, 'only the run past the gate is a live-fire run');
  const end = entries.find((e) => e.type === 'live-fire');
  assert.equal(end.start_seq, starts[0].seq);
  assert.equal(end.outcome, 'failed');
  assert.deepEqual(verifyLog('mainnet').unclosed, []);
}));

// The study run on a final freeze, as far as the snapshot rule: the run
// passes the code manifest, the record checks with the digests given at run
// time and the check log, and the draw key with the freeze tool's file, and
// stops at the rule because the database does not yet hold a block of epoch
// N. Each case is a fresh database holding one final record.
test('the study run wires the freeze checks, the check log, drawkey.json and the snapshot rule', withHome(async (home) => {
  const key = keypair();
  const studyKey = key.pub.toString('hex');
  const manifest = join(home, 'code-manifest.txt');
  writeFileSync(manifest, formatHashList());
  const manifestDigest = sha(readFileSync(manifest));
  // The check log as it stood at the final freeze.
  appendEntry('mainnet', 'health', { outcome: 'succeeded' });
  const frozenDigest = logPrefixDigests(readFileSync(checkLogPath('mainnet'), 'utf8')).at(-1);
  const code = hashList().map((x) => x.sha256);
  const nonce = 'cd'.repeat(32);
  const old = '2020-01-01 00:00:00';
  const finalDoc = join(home, 'final.md');
  const drawkey = join(home, 'drawkey.json');
  const koios = { genesis: async () => ({ securityparam: '2160', activeslotcoeff: '0.05', epochlength: '432000' }), epochNonce: async () => ({ nonce, read_at: 'now' }), lastBlockOfEpoch: async () => null, tip: async () => ({ block_no: 9999 }) };
  let k = 0;
  // named: digests the document names; items: run-time digests in the record.
  const attempt = async ({ named, items, drawkeyNonce = nonce, drawkeyTx = null }) => {
    const m = await mainnetDb({ withChain: true, studyRun: false });
    const hypDigest = sha('hypotheses');
    const hypTx = await m.ch.add({ blockNo: 100, slot: 500 * 432000 + 500, epoch: 500, epochSlot: 500, body: metadataBytes(record([hypDigest], key)), msg: hypDigest, time: old });
    const text = `final\nkey ${studyKey}\nweb+cardano://transaction/${hypTx}/metadata/309\n${named.join('\n')}\n`;
    writeFileSync(finalDoc, text);
    const d = sha(Buffer.from(text));
    // Early in epoch 500, so N = 501, whose nonce is recorded; epoch 500 runs
    // on past the freeze, and no block of 501 is in the database yet.
    const f = await m.ch.add({ blockNo: 200, slot: 500 * 432000 + 1000, epoch: 500, epochSlot: 1000, body: metadataBytes(record([d, ...code, ...items], key)), msg: d, time: old });
    await m.db.query(`INSERT INTO public.epoch_param VALUES (500, decode($1, 'hex'), 10), (501, decode($2, 'hex'), 10)`, ['11'.repeat(32), nonce]);
    await m.ch.block({ blockNo: 3000, slot: 500 * 432000 + 400000, epoch: 500, epochSlot: 400000, time: old });
    writeFileSync(drawkey, JSON.stringify({ format: 'research-freeze-drawkey-v1', network: 'mainnet', tx_hash: drawkeyTx || f, nonce_epoch: 501, nonce: drawkeyNonce, readings: [{ source: 'koios', nonce: drawkeyNonce }, { source: 'blockfrost', nonce: drawkeyNonce }] }));
    return runPipeline({ client: m.client, runId: `study-${++k}`, log: () => {}, koios, freezeTx: f, hypothesesTx: hypTx, prereg: finalDoc, studyKey, codeManifest: manifest, drawkey });
  };
  // Items but not named: refused on both.
  await assert.rejects(attempt({ named: [], items: [manifestDigest, frozenDigest] }), (e) => /code_manifest_named_in_document/.test(e.message) && /check_log_frozen/.test(e.message));
  // Named, but the record lacks the frozen log: refused on the log alone.
  await assert.rejects(attempt({ named: [manifestDigest, frozenDigest], items: [manifestDigest] }), (e) => /check_log_frozen/.test(e.message) && !/code_manifest/.test(e.message));
  // Everything frozen: the drawkey.json nonce must agree.
  await assert.rejects(attempt({ named: [manifestDigest, frozenDigest], items: [manifestDigest, frozenDigest], drawkeyNonce: 'ef'.repeat(32) }), /drawkey\.json differs: nonce/);
  // And it does, written for another carrier: on to the snapshot rule, which
  // waits for epoch 501.
  await assert.rejects(attempt({ named: [manifestDigest, frozenDigest], items: [manifestDigest, frozenDigest], drawkeyTx: 'ee'.repeat(32) }), /last block of epoch 500, and the database does not yet hold epoch 501/);
}));

// own-drawn: counts per drawn sample, for the run that owns the sample table
// only, and nothing written anywhere.
test('own-drawn counts listed wallets per drawn sample and writes nothing', withHome(async (home) => {
  const { ownDrawn } = await import('../../src/pipeline.mjs');
  const db = await PGlite.create();
  await db.exec(`CREATE SCHEMA study;
    CREATE TABLE study.cred (sa_id bigint PRIMARY KEY, view text);
    CREATE TABLE study.sample (frame text, kind text, stratum text, sa_id bigint);
    COMMENT ON TABLE study.sample IS 'research-corpus run r1';
    INSERT INTO study.cred VALUES (1, '${STAKE_A}'), (2, 'stake1other');
    INSERT INTO study.sample VALUES ('recent', 'random', '', 1), ('recent', 'strata', 'MIN', 1), ('peak', 'random', '', 2), ('peak', 'ada_only', '', 1);`);
  const r = await ownDrawn(db, 'r1', [STAKE_A]);
  assert.equal(r.drawn_wallets, 1);
  assert.deepEqual(r.by_sample, [
    { frame: 'recent', kind: 'random', stratum: '', drawn: 1 },
    { frame: 'recent', kind: 'strata', stratum: 'MIN', drawn: 1 },
    { frame: 'peak', kind: 'ada_only', stratum: '', drawn: 1 }
  ]);
  await assert.rejects(ownDrawn(db, 'r2', [STAKE_A]), /does not belong to run r2/);
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(home), []);
}));
