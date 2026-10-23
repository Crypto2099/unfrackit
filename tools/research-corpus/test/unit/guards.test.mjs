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
import { STUDY_KEY } from '../../src/params.mjs';
import { verifyFreezeCommand, a1Command, parseArgs, runOptions } from '../../src/cli.mjs';
import { freezeOf } from '../../src/manifest.mjs';

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
  const freeze = { freezeTx: 'aa'.repeat(32), hypothesesTx: 'bb'.repeat(32), prereg: manifest, drawkey: manifest };
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
    [{ ...freeze, codeManifest: goodManifest, fromBlock: 1 }, /--from-block is for test networks only/],
    [{ hmacKey: manifest }, /study key in secret\/hmac\.key/],
    [{ ...freeze, codeManifest: undefined }, /without --code-manifest/],
    [{ ...freeze, codeManifest: goodManifest, drawkey: undefined }, /without --drawkey/],
    [{ ...freeze, codeManifest: manifest }, /differs from the code manifest: differs: src\/pipeline\.mjs/],
    // A second study run while one is recorded for the final freeze, with the
    // pinned study key given or left out.
    [{ ...freeze, codeManifest: goodManifest }, /already recorded for the final freeze/],
    [{ ...freeze, codeManifest: goodManifest, studyKey: STUDY_KEY.toUpperCase() }, /already recorded for the final freeze/],
    // Any other study key.
    [{ ...freeze, codeManifest: goodManifest, studyKey: 'cc'.repeat(32) }, /pinned freeze identity/],
    [{ liveFire: { testH: TEST_H, purpose: 'p' } }, /needs --expect-network/],
    [{ ...live({ testH: undefined }) }, /needs --test-h/],
    [{ ...live({ purpose: undefined }) }, /needs --purpose/],
    [{ ...live(), freezeTx: 'aa'.repeat(32) }, /never a freeze or stand-in/],
    [{ ...live(), explain: true, capture: true }, /no plan capture/],
    [{ ...live(), snapshot: 'ab'.repeat(32) }, /--snapshot must be tip for a live-fire run/],
    [{ ...live() }, /needs --hypotheses-tx/],
    [{ ...live(), hypothesesTx: 'bb'.repeat(32), studyKey: 'cc'.repeat(32) }, /pinned freeze identity/],
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
  assert.equal(gates.length, 9);
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

// verify-freeze and a1 on mainnet, through the commands themselves: --from-block
// and any study key but the pinned one are refused, and verify-freeze needs
// the code manifest, each before a chain table is read (the stand-in database
// fails the test on any chain query) and each logged as a failed query.
test('verify-freeze and a1 on mainnet refuse --from-block and another study key; verify-freeze needs --code-manifest', withHome(async (home) => {
  const m = await mainnetDb({ studyRun: false });
  const manifest = join(home, 'code-manifest.txt');
  writeFileSync(manifest, formatHashList());
  const base = { prereg: manifest, freezeTx: 'aa'.repeat(32), codeManifest: manifest };
  const opts = { client: m.client };
  await assert.rejects(verifyFreezeCommand({ ...base, fromBlock: '1' }, 'verify-freeze', opts), /--from-block is for test networks only/);
  await assert.rejects(verifyFreezeCommand({ ...base, codeManifest: undefined }, 'verify-freeze', opts), /need --code-manifest/);
  await assert.rejects(verifyFreezeCommand({ ...base, studyKey: 'cc'.repeat(32) }, 'verify-freeze', opts), /pinned freeze identity/);
  // The parsed command line may carry --study-key-pin; neither command reads it.
  await assert.rejects(verifyFreezeCommand({ ...base, studyKey: 'cc'.repeat(32), studyKeyPin: 'cc'.repeat(32) }, 'verify-freeze', opts), /pinned freeze identity/);
  await assert.rejects(a1Command({ ...base, fromBlock: '1' }, 'a1', opts), /--from-block is for test networks only/);
  await assert.rejects(a1Command({ ...base, studyKey: 'cc'.repeat(32) }, 'a1', opts), /pinned freeze identity/);
  await assert.rejects(a1Command({ ...base, studyKey: 'cc'.repeat(32), studyKeyPin: 'cc'.repeat(32) }, 'a1', opts), /pinned freeze identity/);
  await assert.rejects(a1Command({ liveFire: true, purpose: 'p', expectNetwork: 'mainnet', hypothesesTx: 'bb'.repeat(32), studyKey: 'cc'.repeat(32) }, 'a1', opts), /pinned freeze identity/);
  const entries = readFileSync(checkLogPath('mainnet'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(entries.filter((e) => e.type === 'query').map((e) => [e.name, e.outcome]), [
    ['verify-freeze', 'failed'],
    ['verify-freeze', 'failed'],
    ['verify-freeze', 'failed'],
    ['verify-freeze', 'failed'],
    ['a1', 'failed'],
    ['a1', 'failed'],
    ['a1', 'failed'],
    ['a1 live-fire gate', 'failed']
  ]);
  assert.equal(entries.filter((e) => e.type === 'a1-live-fire-start').length, 0);
  assert.deepEqual(verifyLog('mainnet').unclosed, []);
}));

// The pin's only stand-in is the unit tests' studyKeyPin. parseArgs takes any
// --name value, so `run` must name each option it passes to runPipeline: the
// parsed --study-key-pin never reaches it, and --study-key arrives as given.
test('run passes runPipeline its options one by one, so --study-key-pin never reaches it', () => {
  const pin = 'cc'.repeat(32);
  const a = parseArgs(['--run-id', 'r1', '--study-key-pin', pin, '--study-key', 'DD'.repeat(32), '--freeze-tx', 'AA'.repeat(32)]);
  assert.equal(a.studyKeyPin, pin, 'parseArgs maps the flag');
  const o = runOptions(a, 'run');
  assert.equal(Object.hasOwn(o, 'studyKeyPin'), false);
  assert.ok(!JSON.stringify(o).includes(pin));
  assert.deepEqual([o.runId, o.studyKey, o.freezeTx], ['r1', 'dd'.repeat(32), 'aa'.repeat(32)]);
});

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
// happens to it next. The test key stands in for the pinned STUDY_KEY
// (studyKeyPin), and the same key given as --study-key without that stand-in
// is refused.
test('a mainnet live-fire run needs the hypotheses record signed by the study key', withHome(async () => {
  for (const studyRun of [true, false]) {
    const m = await mainnetDb({ withChain: true, studyRun });
    const key = keypair();
    const hypDigest = sha('hypotheses');
    const good = await m.ch.add({ blockNo: 100, slot: 1000, epoch: 1, epochSlot: 10, body: metadataBytes(record([hypDigest], key)), msg: hypDigest });
    const other = await m.ch.add({ blockNo: 101, slot: 1001, epoch: 1, epochSlot: 11, body: metadataBytes(record([hypDigest], keypair())), msg: hypDigest });
    const run = (hypothesesTx) => runPipeline({ client: m.client, runId: 'lf-hyp', log: () => {}, expectNetwork: 'mainnet', liveFire: { testH: TEST_H, purpose: 'p' }, hypothesesTx, studyKeyPin: key.pub.toString('hex') });
    await assert.rejects(run(other), /not in the database with a record signed by the study key/);
    if (studyRun) {
      await assert.rejects(runPipeline({ client: m.client, runId: 'lf-hyp', log: () => {}, expectNetwork: 'mainnet', liveFire: { testH: TEST_H, purpose: 'p' }, hypothesesTx: good, studyKey: key.pub.toString('hex') }), /pinned freeze identity/);
      await assert.rejects(run(good), /holds the study's run study1/);
      assert.deepEqual(await m.intact(), { runs: 1, params: 2, t: 'study.sample' });
    } else {
      // Past the gate; the first step then fails on the stand-in chain.
      await assert.rejects(run(good));
    }
  }
  const entries = readFileSync(checkLogPath('mainnet'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(entries.filter((e) => e.type === 'query').map((e) => e.outcome), ['failed', 'failed', 'failed', 'failed', 'succeeded']);
  const starts = entries.filter((e) => e.type === 'live-fire-start');
  assert.equal(starts.length, 1, 'only the run past the gate is a live-fire run');
  const end = entries.find((e) => e.type === 'live-fire');
  assert.equal(end.start_seq, starts[0].seq);
  assert.equal(end.outcome, 'failed');
  assert.deepEqual(verifyLog('mainnet').unclosed, []);
}));

// The study run on a final freeze: the run passes the code manifest, the
// record checks with the document's list and the check log, and the draw key
// with the freeze tool's file; it refuses until the rule's block is deep
// enough, and then stores that block, not the tip, as its snapshot before its
// first step. Each case is a fresh database holding one final record.
test('the study run wires the freeze checks, the check log, drawkey.json and the snapshot rule', withHome(async (home) => {
  const key = keypair();
  const studyKey = key.pub.toString('hex');
  const manifest = join(home, 'code-manifest.txt');
  writeFileSync(manifest, formatHashList());
  const manifestDigest = sha(readFileSync(manifest));
  // The check log as it stood at the final freeze.
  appendEntry('mainnet', 'health', { outcome: 'succeeded' });
  const frozenDigest = logPrefixDigests(readFileSync(checkLogPath('mainnet'), 'utf8')).at(-1);
  const files = hashList();
  const nonce = 'cd'.repeat(32);
  const old = '2020-01-01 00:00:00';
  const E = 432000;
  const finalDoc = join(home, 'final.md');
  const drawkey = join(home, 'drawkey.json');
  let k = 0;
  // listed: [{ sha256, name }] the document lists besides the code files;
  // items: run-time digests in the record; deep: epoch 501 is in the database
  // with its first block 2,160 below the tip.
  const hypDigest = sha('hypotheses');
  const forged = sha('a document a stranger names');
  const attempt = async ({ listed, items, drawkeyNonce = nonce, drawkeyTx = null, deep = false, freezeIsSnap = false, frontRun = false }) => {
    const m = await mainnetDb({ withChain: true, studyRun: false });
    // With frontRun, a stranger's copy of the hypotheses body with the
    // stranger's own 674 line lands one block ahead: the first carrier.
    const copy = frontRun ? await m.ch.add({ blockNo: 99, slot: 500 * E + 400, epoch: 500, epochSlot: 400, body: metadataBytes(record([hypDigest], key), 40), msg: forged, time: old }) : null;
    const hypTx = await m.ch.add({ blockNo: 100, slot: 500 * E + 500, epoch: 500, epochSlot: 500, body: metadataBytes(record([hypDigest], key)), msg: hypDigest, time: old });
    const lines = [...files.map((f) => `${f.sha256}  ${f.path}`), ...listed.map((l) => `${l.sha256}  ${l.name}`)];
    const text = `final\nkey ${studyKey}\nweb+cardano://transaction/${hypTx}/metadata/309\n\n${lines.join('\n')}\n`;
    writeFileSync(finalDoc, text);
    const d = sha(Buffer.from(text));
    // Early in epoch 500, so N = 501, whose nonce is recorded.
    // With freezeIsSnap the final freeze is itself the rule's snapshot block.
    const f = await m.ch.add(freezeIsSnap ? { blockNo: 2500, slot: 500 * E + 200000, epoch: 500, epochSlot: 200000, body: metadataBytes(record([d, ...files.map((x) => x.sha256), ...items], key)), msg: d, time: old } : { blockNo: 200, slot: 500 * E + 1000, epoch: 500, epochSlot: 1000, body: metadataBytes(record([d, ...files.map((x) => x.sha256), ...items], key)), msg: d, time: old });
    await m.db.query(`INSERT INTO public.epoch_param VALUES (500, decode($1, 'hex'), 10), (501, decode($2, 'hex'), 10)`, ['11'.repeat(32), nonce]);
    // The snapshot the rule names: the last block of epoch 500 before its
    // cutoff; one block after the cutoff.
    const snap = freezeIsSnap ? { hash: (await m.db.query(`SELECT encode(hash, 'hex') AS h FROM public.block WHERE block_no = 2500`)).rows[0].h } : await m.ch.block({ blockNo: 2500, slot: 500 * E + 200000, epoch: 500, epochSlot: 200000, time: old });
    await m.ch.block({ blockNo: 2600, slot: 500 * E + 400000, epoch: 500, epochSlot: 400000, time: old });
    let firstN = null;
    if (deep) {
      firstN = await m.ch.block({ blockNo: 2601, slot: 501 * E + 10, epoch: 501, epochSlot: 10, time: old });
      await m.ch.block({ blockNo: 4761, slot: 501 * E + 50000, epoch: 501, epochSlot: 50000, time: old });
    } else {
      await m.ch.block({ blockNo: 3000, slot: 500 * E + 431000, epoch: 500, epochSlot: 431000, time: old });
    }
    const koios = {
      genesis: async () => ({ securityparam: '2160', activeslotcoeff: '0.05', epochlength: '432000' }),
      epochNonce: async () => ({ nonce, read_at: 'now' }),
      snapshotBlock: async () => ({ hash: snap.hash, block_height: 2500 }),
      firstBlockOfEpoch: async () => (firstN ? { hash: firstN.hash, block_height: 2601 } : null),
      tip: async () => ({ block_no: 9999 })
    };
    writeFileSync(drawkey, JSON.stringify({ format: 'research-freeze-drawkey-v1', network: 'mainnet', tx_hash: drawkeyTx || f, nonce_epoch: 501, nonce: drawkeyNonce, readings: [{ source: 'koios', nonce: drawkeyNonce }, { source: 'blockfrost', nonce: drawkeyNonce }] }));
    const runId = `study-${++k}`;
    const error = await runPipeline({ client: m.client, runId, log: () => {}, koios, freezeTx: f, prereg: finalDoc, studyKeyPin: studyKey, codeManifest: manifest, drawkey }).then(() => null, (e) => e);
    const stored = (await m.db.query(`SELECT value FROM study.param WHERE run_id = $1 AND key = 'snapshot'`, [runId])).rows[0];
    const freeze = (await m.db.query(`SELECT value FROM study.param WHERE run_id = $1 AND key = 'freeze'`, [runId])).rows[0];
    return { error, snapshot: stored ? stored.value : null, snap, freeze: freeze ? freeze.value : null, hypTx, copy };
  };
  const named = [{ sha256: manifestDigest, name: 'code-manifest.txt' }, { sha256: frozenDigest, name: 'check-log.jsonl' }];
  // Items the document does not list: refused.
  let r = await attempt({ listed: [], items: [manifestDigest, frozenDigest] });
  assert.match(r.error.message, /document_lists_every_other_item.*document_names_one_code_manifest/);
  // The document names another code manifest than the run's.
  const otherManifest = sha('another code manifest');
  r = await attempt({ listed: [{ sha256: otherManifest, name: 'code-manifest.txt' }, named[1]], items: [otherManifest, frozenDigest] });
  assert.match(r.error.message, /code_manifest_is_the_named_one/);
  assert.doesNotMatch(r.error.message, /check_log/);
  // Everything frozen: the drawkey.json nonce must agree.
  r = await attempt({ listed: named, items: [manifestDigest, frozenDigest], drawkeyNonce: 'ef'.repeat(32) });
  assert.match(r.error.message, /drawkey\.json differs: nonce/);
  // Written for another carrier: on to the snapshot rule, which waits for
  // epoch 501.
  r = await attempt({ listed: named, items: [manifestDigest, frozenDigest], drawkeyTx: 'ee'.repeat(32) });
  assert.match(r.error.message, /the snapshot is in epoch 500, and the database does not yet hold epoch 501/);
  assert.equal(r.snapshot, null);
  // Epoch 501 deep enough: the run stores the rule's block, not the tip, and
  // goes on to its steps (which fail here on the stand-in chain).
  r = await attempt({ listed: named, items: [manifestDigest, frozenDigest], deep: true });
  assert.ok(r.error, 'the stand-in chain has no tables for the steps');
  assert.equal(r.snapshot.hash, r.snap.hash);
  assert.equal(r.snapshot.chosen, 'rule');
  assert.equal(r.snapshot.block_no, 2500);
  assert.deepEqual([r.snapshot.rule.epoch, r.snapshot.rule.n, r.snapshot.rule.cutoff_slot], [500, 501, 500 * E + 259200]);
  assert.equal(r.snapshot.rule.confirmation.db_depth, 4761 - 2601);
  // The hypotheses record as the run stores it and the manifest publishes it:
  // its document digest from the key holder's line, the one of the carrier
  // the document cites.
  assert.equal(freezeOf(r.freeze).hypotheses.document_sha256, hypDigest);
  // After a front-run with a stranger's 674 line, the run still passes and
  // publishes the hypotheses document's digest, not the stranger's.
  r = await attempt({ listed: named, items: [manifestDigest, frozenDigest], deep: true, frontRun: true });
  assert.ok(r.error, 'the stand-in chain has no tables for the steps');
  assert.equal(r.snapshot.block_no, 2500);
  const published = freezeOf(r.freeze).hypotheses;
  assert.deepEqual([published.tx, published.cited_tx, published.document_sha256, published.items_sha256], [r.copy, r.hypTx, hypDigest, [hypDigest]]);
  assert.ok(!JSON.stringify(freezeOf(r.freeze)).includes(forged));
  // The final freeze is the last block before the cutoff, so the rule's
  // snapshot is the freeze block itself: not refused for its order.
  r = await attempt({ listed: named, items: [manifestDigest, frozenDigest], deep: true, freezeIsSnap: true });
  assert.ok(r.error, 'the stand-in chain has no tables for the steps');
  assert.doesNotMatch(r.error.message, /before the freeze block|not after the freeze block/);
  assert.equal(r.snapshot.hash, r.snap.hash);
  assert.equal(r.snapshot.block_no, 2500);
}));

// own-drawn: counts per drawn sample, only for a finished study run of a final
// freeze (or a test run), never a live-fire run, and nothing written anywhere.
test('own-drawn counts listed wallets per drawn sample of a finished study run and writes nothing', withHome(async (home) => {
  const { ownDrawn } = await import('../../src/pipeline.mjs');
  const db = await PGlite.create();
  await db.exec(`CREATE SCHEMA study;
    CREATE TABLE study.param (run_id text, key text, value jsonb, PRIMARY KEY (run_id, key));
    CREATE TABLE study.cred (sa_id bigint PRIMARY KEY, view text);
    CREATE TABLE study.sample (frame text, kind text, stratum text, sa_id bigint);
    INSERT INTO study.cred VALUES (1, '${STAKE_A}'), (2, 'stake1other');
    INSERT INTO study.sample VALUES ('recent', 'random', '', 1), ('recent', 'strata', 'MIN', 1), ('peak', 'random', '', 2), ('peak', 'ada_only', '', 1);`);
  const owned = (run) => db.exec(`COMMENT ON TABLE study.sample IS 'research-corpus run ${run}'`);
  const param = (run, key, value) => db.query(`INSERT INTO study.param VALUES ($1, $2, $3::jsonb) ON CONFLICT (run_id, key) DO UPDATE SET value = EXCLUDED.value`, [run, key, JSON.stringify(value)]);
  // A live-fire run kept for debugging owns the sample table: refused.
  await owned('lf1');
  await param('lf1', 'mode', 'live-fire');
  await param('lf1', 'finished', { at: 'now' });
  await assert.rejects(ownDrawn(db, 'lf1', [STAKE_A]), /a live-fire run/);
  // The study run, in progress, then finished.
  await owned('r1');
  await param('r1', 'mode', 'study');
  await param('r1', 'freeze', { role: 'final-freeze' });
  await assert.rejects(ownDrawn(db, 'r1', [STAKE_A]), /has not finished/);
  await param('r1', 'finished', { at: 'now' });
  const r = await ownDrawn(db, 'r1', [STAKE_A]);
  assert.equal(r.drawn_wallets, 1);
  assert.deepEqual(r.by_sample, [
    { frame: 'recent', kind: 'random', stratum: '', drawn: 1 },
    { frame: 'recent', kind: 'strata', stratum: 'MIN', drawn: 1 },
    { frame: 'peak', kind: 'ada_only', stratum: '', drawn: 1 }
  ]);
  // A finished run whose sample table another run has since replaced.
  await param('r2', 'mode', 'test');
  await param('r2', 'finished', { at: 'now' });
  await assert.rejects(ownDrawn(db, 'r2', [STAKE_A]), /does not belong to run r2/);
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(home), []);
}));
