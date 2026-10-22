// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The mainnet refusals, through runPipeline itself with PGlite standing in for
// a mainnet database (db-sync's meta table says mainnet and every probe
// passes; the study schema is real): options that would change the sample, a
// missing or mismatched freeze, code manifest or consented commitment,
// live-fire runs without their stated test h or the hypotheses freeze, case
// wallets outside the consented file, and a second study run. A refused
// live-fire run never drops another run's tables, and every live-fire run
// leaves a start entry and an end entry in the check log. Also the code
// manifest comparison and the consented commitment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { runPipeline, cleanupRun, DEFAULT_STRATA } from '../../src/pipeline.mjs';
import { formatHashList, hashList } from '../../src/hash.mjs';
import { codeManifestErrors, mainnetOptionErrors, caseWalletErrors } from '../../src/guards.mjs';
import { checkLogPath, verifyLog, appendEntry } from '../../src/checklog.mjs';
import { commitConsented, consentedCommitment } from '../../src/consented.mjs';

const FIXTURE_STRATA = new URL('../fixtures/strata-preprod.json', import.meta.url).pathname;
const STAKE_A = 'stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw';
const STAKE_B = 'stake178phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtcccycj5';
const TEST_H = 'ab'.repeat(32);

// A mainnet "database": meta and the probes answered here, everything else by
// PGlite, which holds a study run with its tables.
async function mainnetDb() {
  const db = await PGlite.create();
  await db.exec(`SET check_function_bodies = off; CREATE SCHEMA study;
    CREATE TABLE study.run (run_id text PRIMARY KEY, network text NOT NULL, created timestamptz DEFAULT now());
    CREATE TABLE study.param (run_id text NOT NULL REFERENCES study.run ON DELETE CASCADE, key text NOT NULL, value jsonb NOT NULL, PRIMARY KEY (run_id, key));
    CREATE TABLE study.step (run_id text NOT NULL REFERENCES study.run ON DELETE CASCADE, name text NOT NULL, started timestamptz, finished timestamptz, rows bigint, PRIMARY KEY (run_id, name));
    INSERT INTO study.run VALUES ('study1', 'mainnet');
    INSERT INTO study.param VALUES ('study1', 'mode', '"study"'), ('study1', 'freeze', '{"role": "final-freeze", "h": "00"}');
    CREATE TABLE study.sample (sa_id bigint); INSERT INTO study.sample VALUES (1), (2);
    COMMENT ON TABLE study.sample IS 'research-corpus run study1';`);
  const client = {
    async query(sql, params) {
      if (/FROM public\.meta m/.test(sql)) return { rows: [{ network_name: 'mainnet', version: 'v', start_time: 't', schema_version: '{"id":1}', extra_migrations: '[]' }] };
      if (/AS inline_datum/.test(sql)) return { rows: [{ tx_in: true, multi_asset: true, ma_tx_out: true, ma_tx_mint: true, metadata_674: true, redeemer: true, inline_datum: true, epoch_nonce: true }] };
      if (/^\s*SET (work_mem|maintenance_work_mem|max_parallel)/.test(sql) || /^\s*SHOW (work_mem|maintenance_work_mem|max_parallel)/.test(sql)) {
        const k = /(work_mem|maintenance_work_mem|max_parallel_workers_per_gather|max_parallel_maintenance_workers)/.exec(sql)[1];
        return /^\s*SHOW/.test(sql) ? { rows: [{ [k]: '1GB' }] } : { rows: [] };
      }
      if (/^\s*(SELECT|WITH)\b/i.test(sql) && /\bpublic\./.test(sql)) throw new Error(`a chain query was reached: ${sql.replace(/\s+/g, ' ').slice(0, 80)}`);
      return db.query(sql, params);
    },
    async end() {}
  };
  const intact = async () => (await db.query(`SELECT (SELECT count(*) FROM study.run WHERE run_id = 'study1') AS runs, (SELECT count(*) FROM study.param WHERE run_id = 'study1') AS params, to_regclass('study.sample')::text AS t`)).rows[0];
  return { db, client, intact };
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
  const run = (opts) => runPipeline({ client: m.client, runId: 'guard-test', log: () => {}, snapshot: 'tip', strataList: DEFAULT_STRATA, ...opts });
  const manifest = join(home, 'code-manifest.txt');
  writeFileSync(manifest, formatHashList().replace(/^[0-9a-f]{64}(?= {2}src\/pipeline\.mjs$)/m, '0'.repeat(64)));
  const goodManifest = join(home, 'code-manifest-good.txt');
  writeFileSync(goodManifest, formatHashList());
  const consented = join(home, 'consented.txt');
  writeFileSync(consented, `# keys\n${STAKE_A}\n`, { mode: 0o600 });
  const { sha256: commitment } = commitConsented(consented);
  const freeze = { freezeTx: 'aa'.repeat(32), hypothesesTx: 'bb'.repeat(32), prereg: manifest, studyKey: 'cc'.repeat(32), drawkey: manifest, consented, consentedSha256: commitment };
  const live = (over = {}) => ({ expectNetwork: 'mainnet', liveFire: { testH: TEST_H, purpose: 'p', ...over } });
  const cases = [
    [{}, /without --freeze-tx/],
    [{ set: ['guard=1000'] }, /--set changes guard/],
    [{ set: ['guard=200000'] }, /without --freeze-tx/],
    [{ strataList: FIXTURE_STRATA, strataGiven: true }, /not the hashed strata file/],
    [{ snapshot: 'ab'.repeat(32) }, /--snapshot must be tip/],
    [{ capture: true }, /no plan capture/],
    [{ standInTx: 'ab'.repeat(32) }, /stand-in for h is for test networks only/],
    [{ hmacKey: manifest }, /study key in secret\/hmac\.key/],
    [{ ...freeze, codeManifest: undefined }, /without --code-manifest/],
    [{ ...freeze, codeManifest: goodManifest, drawkey: undefined }, /without --drawkey/],
    [{ ...freeze, codeManifest: goodManifest, consentedSha256: undefined }, /without --consented-sha256/],
    [{ ...freeze, codeManifest: manifest }, /differs from the code manifest: differs: src\/pipeline\.mjs/],
    [{ ...freeze, codeManifest: goodManifest, consentedSha256: 'ee'.repeat(32) }, /do not give the committed digest/],
    // A second study run while one is recorded for the final freeze.
    [{ ...freeze, codeManifest: goodManifest }, /already recorded for the final freeze/],
    [{ liveFire: { testH: TEST_H, purpose: 'p' } }, /needs --expect-network/],
    [{ ...live({ testH: undefined }) }, /needs --test-h/],
    [{ ...live({ purpose: undefined }) }, /needs --purpose/],
    [{ ...live(), freezeTx: 'aa'.repeat(32) }, /never a freeze or stand-in/],
    [{ ...live(), explain: true, capture: true }, /no plan capture/],
    [{ ...live() }, /needs --hypotheses-tx and --study-key/],
    [{ ...live(), consented, caseWallets: [STAKE_B] }, /not in the consented file/]
  ];
  for (const [opts, want] of cases) await assert.rejects(run(opts), want, JSON.stringify(opts));
  // A refused live-fire run under the study run's own id drops nothing.
  await assert.rejects(runPipeline({ client: m.client, runId: 'study1', log: () => {}, ...live({ testH: undefined }) }), /needs --test-h/);
  assert.deepEqual(await m.intact(), { runs: 1, params: 2, t: 'study.sample' });
  // The live-fire runs that got as far as the log each left a start entry
  // closed by an end entry, with no count and nothing deleted.
  const v = verifyLog('mainnet');
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.unclosed, []);
  assert.deepEqual(v.failed_deletions, []);
  const entries = readFileSync(checkLogPath('mainnet'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(entries.filter((e) => e.type === 'live-fire-start').length, 7);
  assert.equal(entries.filter((e) => e.type === 'live-fire').length, 7);
  for (const e of entries.filter((x) => x.type === 'live-fire')) {
    assert.equal(e.outcome, 'failed');
    assert.equal(e.wallet_level_output, 'none written');
    assert.equal(entries.find((x) => x.seq === e.start_seq).type, 'live-fire-start');
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

test('the consented commitment: a salt made once, mode 0600, and SHA-256 of salt and file', withHome(async (home) => {
  const f = join(home, 'c.txt');
  writeFileSync(f, `${STAKE_A}\n`, { mode: 0o600 });
  const a = commitConsented(f);
  assert.equal(a.made, true);
  assert.equal(statSync(`${f}.salt`).mode & 0o777, 0o600);
  assert.equal(statSync(`${f}.salt`).size, 32);
  const b = commitConsented(f);
  assert.equal(b.made, false);
  assert.equal(b.sha256, a.sha256);
  const { createHash } = await import('node:crypto');
  assert.equal(a.sha256, createHash('sha256').update(Buffer.concat([readFileSync(`${f}.salt`), readFileSync(f)])).digest('hex'));
  writeFileSync(f, `${STAKE_A}\n${STAKE_B}\n`);
  assert.notEqual(consentedCommitment(f), a.sha256, 'a changed file gives another digest');
  chmodSync(`${f}.salt`, 0o644);
  assert.throws(() => consentedCommitment(f), /readable by others/);
}));

test('a test network takes run-time options the mainnet refuses', () => {
  assert.deepEqual(mainnetOptionErrors({ set: ['guard=200000'], strataPath: DEFAULT_STRATA, defaultStrataPath: DEFAULT_STRATA, snapshot: 'tip', nodeVersion: 'v24.1.0' }), []);
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

test('case wallets must be consented keys', () => {
  assert.deepEqual(caseWalletErrors([STAKE_A], [STAKE_A, STAKE_B]), []);
  assert.equal(caseWalletErrors([STAKE_B], [STAKE_A]).length, 1);
});
