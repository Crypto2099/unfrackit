// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The explain command: its refusals (no expected network, no purpose, any
// ANALYZE), a database of another network refused after its start entry, the
// statements it plans (db-sync tables only, a CREATE TABLE ... AS planned as
// its query) and those it lists as not planned with the reason (study
// tables, a missing study function, bound values, parameters the stand-in
// does not give, a write), the plans reduced to their shape in a private file
// under the tool's home, nothing created in the database, a plan that cannot
// be made reported as failed, and the check log's start and end entries with
// the names and the sequential-scan flags. Also the classification of the
// real SQL files with an empty study schema.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { explainCommand, classifyStatement, standInParams } from '../../src/explain.mjs';
import { loadAll, parseSqlFile } from '../../src/sqlfile.mjs';
import { checkLogPath, verifyLog } from '../../src/checklog.mjs';

function withHome(fn) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'rc-explain-'));
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

const entries = (network) => readFileSync(checkLogPath(network), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

async function chainDb(network = 'preprod') {
  const db = await PGlite.create();
  await db.exec(`
    CREATE TABLE public.meta (network_name text, version text, start_time timestamp);
    CREATE TABLE public.schema_version (id int, stage_one int, stage_two int, stage_three int);
    CREATE TABLE public.extra_migrations (id int, token text);
    CREATE TABLE public.block (id bigint PRIMARY KEY, block_no bigint, slot_no bigint, epoch_no int, time timestamp, hash bytea);
    CREATE TABLE public.tx (id bigint PRIMARY KEY, block_id bigint, valid_contract boolean);
    CREATE INDEX ON public.tx (block_id);
    INSERT INTO public.meta VALUES ('${network}', '13.7.3.0', '2026-01-01');
    INSERT INTO public.schema_version VALUES (1, 1, 51, 1);
    INSERT INTO public.block VALUES (1, 1, 10, 1, '2026-10-20', decode('aa', 'hex')), (2, 2, 20, 1, '2026-10-21', decode('bb', 'hex'));
    INSERT INTO public.tx VALUES (1, 1, true), (2, 2, true), (3, 2, false);
    CREATE SCHEMA study;
    CREATE FUNCTION study.known(x bigint) RETURNS bigint LANGUAGE sql AS 'SELECT x';
  `);
  return db;
}

// The command's own queries from sql/, and test statements of every kind.
function testBlocks() {
  const real = loadAll();
  const blocks = new Map(['db_meta', 'tip_block', 'block_by_hash', 't_of_block_plain'].map((n) => [n, real.get(n)]));
  const text = `
-- @step chain_only
-- @outputs study.made
DROP TABLE IF EXISTS study.made;
CREATE TABLE study.made AS SELECT b.id, count(t.id) AS n FROM public.block b LEFT JOIN public.tx t ON t.block_id = b.id WHERE b.id <= {{snap_block}} GROUP BY b.id;
CREATE INDEX ON study.made (id);
INSERT INTO study.made SELECT t.block_id, t.id FROM public.tx t WHERE t.id <= {{snap_tx}} AND study.known(t.id) > 0;
UPDATE study.made SET n = 0;
-- @query reads_study
SELECT count(*) FROM study.frame f JOIN public.block b ON b.id = f.sa_id;
-- @query missing_fn
SELECT study.absent(id) FROM public.block;
-- @query bound
SELECT * FROM public.block WHERE hash = $1;
-- @query needs_window
SELECT * FROM public.tx WHERE id BETWEEN {{recent_lo}} AND {{recent_hi}};
-- @query by_index
SELECT id FROM public.tx WHERE block_id = {{snap_block}};
`;
  for (const b of parseSqlFile(text, 'test.sql')) blocks.set(b.name, b);
  return blocks;
}

test('explain: refusals before the first query', withHome(async () => {
  await assert.rejects(explainCommand({ purpose: 'p' }, 'explain'), /needs --expect-network/);
  await assert.rejects(explainCommand({ expectNetwork: 'preprod', purpose: ' ' }, 'explain'), /needs --purpose/);
  await assert.rejects(explainCommand({ expectNetwork: 'preprod', purpose: 'p', capture: true }, 'explain'), /never EXPLAIN ANALYZE/);
  await assert.rejects(explainCommand({ expectNetwork: 'preprod', purpose: 'p', analyze: 'true' }, 'explain'), /never EXPLAIN ANALYZE/);
  assert.equal(verifyLog('preprod').entries, 0, 'nothing logged and nothing queried');
}));

test('explain: another network refused after its start entry', withHome(async () => {
  const db = await chainDb('preview');
  await assert.rejects(explainCommand({ expectNetwork: 'preprod', purpose: 'p' }, 'explain', { client: db, blocks: testBlocks() }), /database is preview, expected preprod/);
  const e = entries('preprod');
  assert.deepEqual(e.map((x) => [x.type, x.name, x.outcome]), [['query-start', 'explain', undefined], ['query', 'explain', 'failed']]);
  assert.deepEqual(verifyLog('preprod').unclosed, []);
}));

test('explain: plans db-sync-only statements, lists the rest, creates nothing, logs names and flags', withHome(async (home) => {
  const db = await chainDb();
  const tables = async () => (await db.query(`SELECT count(*) AS n FROM pg_class WHERE relkind = 'r'`)).rows[0].n;
  const before = await tables();
  const r = await explainCommand({ expectNetwork: 'preprod', purpose: 'unit test', snapshot: 'tip' }, 'explain --expect-network preprod', { client: db, blocks: testBlocks(), now: () => new Date('2026-10-25T00:00:00Z') });
  assert.equal(await tables(), before, 'no table created');
  assert.equal((await db.query(`SELECT to_regclass('study.made') AS t`)).rows[0].t, null);
  assert.deepEqual(r.planned.map((x) => x.name), ['db_meta', 'tip_block', 'chain_only#2', 'chain_only#4', 'by_index']);
  assert.deepEqual(r.not_planned.map((x) => [x.name, x.reason]), [
    ['block_by_hash', 'needs run parameters the stand-in does not give: block_hash'],
    ['t_of_block_plain', 'needs run parameters the stand-in does not give: block_id'],
    ['chain_only#5', 'writes a table'],
    ['reads_study', 'reads study tables: frame'],
    ['missing_fn', 'calls functions of schema study not in this database: absent'],
    ['bound', 'binds values at run time'],
    ['needs_window', 'needs run parameters the stand-in does not give: recent_hi, recent_lo']
  ]);
  const file = JSON.parse(readFileSync(r.file, 'utf8'));
  assert.ok(r.file.startsWith(join(home, 'explain', 'preprod')));
  assert.equal(file.stand_in_snapshot.block_no, 2);
  const text = JSON.stringify(file.planned);
  assert.ok(text.includes('Node Type'));
  assert.ok(!/"(Plan Rows|Total Cost|Startup Cost|Plan Width|Workers Planned)"/.test(text), 'plan numbers stripped');
  const end = entries('preprod').at(-1);
  assert.equal(end.type, 'query');
  assert.equal(end.outcome, 'succeeded');
  assert.deepEqual(end.planned, r.planned.map((x) => x.name));
  assert.deepEqual(end.not_planned, r.not_planned.map((x) => x.name));
  assert.deepEqual(end.plan_failed, []);
  for (const v of Object.values(end.seq_scan)) assert.equal(typeof v, 'boolean');
  assert.equal(end.seq_scan['chain_only#2'], true, 'PGlite scans the small block table');
  assert.ok(!JSON.stringify(end).includes('Node Type'), 'no plan in the log');
  // A stated block as the stand-in, and a plan that cannot be made.
  const blocks = testBlocks();
  for (const b of parseSqlFile('-- @query broken\nSELECT no_such_column FROM public.block;\n', 'broken.sql')) blocks.set(b.name, b);
  await assert.rejects(explainCommand({ expectNetwork: 'preprod', purpose: 'unit test', snapshot: 'aa' }, 'explain', { client: db, blocks }), /could not plan broken/);
  const failed = entries('preprod').at(-1);
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.plan_failed, ['broken']);
  assert.ok(failed.planned.includes('by_index'), 'the statements after a failed plan are still planned');
  assert.deepEqual(verifyLog('preprod').unclosed, []);
}));

test('explain: with an empty study schema, the real SQL plans only statements over db-sync tables', () => {
  const blocks = loadAll();
  const params = standInParams('mainnet', { id: 100, t: 1000 });
  const planned = [];
  for (const b of blocks.values()) {
    for (let i = 0; i < b.statements.length; i++) {
      const s = classifyStatement(b, i, params, new Set());
      if (s && s.kind === 'plan') {
        planned.push(s.name);
        assert.ok(!/\bstudy\./.test(s.sql), `${s.name} reads nothing of schema study`);
        assert.ok(!/\{\{|\$\d/.test(s.sql), `${s.name} is fully filled`);
      }
    }
  }
  for (const name of ['txo#2', 'label_309_from', 'order_check', 'cred#2', 'script_tx#2', 'unfrackit_tx#2']) assert.ok(planned.includes(name), name);
  for (const name of ['scam_policy#3', 'activity#2', 'txo#3']) assert.ok(!planned.includes(name), name);
});
