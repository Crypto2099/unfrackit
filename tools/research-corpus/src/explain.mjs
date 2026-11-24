// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// explain: the plans of the study's SQL on a database, before anything is
// run there, so plans can be read on mainnet before the hypotheses freeze.
// Plain EXPLAIN (FORMAT JSON) only, never ANALYZE, which would execute the
// statement and count its rows.
//
// Every statement of every step and query in sql/ whose inputs are db-sync's
// tables only is planned, with parameters from a stand-in snapshot (the
// database tip, or a stated block hash) and the default settings. A step's
// CREATE TABLE ... AS or INSERT INTO ... SELECT is planned as its query, so
// nothing is created. The statements it cannot plan are listed by name with
// the reason, and none of them is planned: those that read study tables
// (which do not exist before a run), those that call functions of schema
// study not in the database, those that bind values at run time, and those
// whose placeholders the stand-in does not give. Statements that are not
// queries (DROP, CREATE INDEX, ANALYZE, ALTER, COMMENT, function definitions)
// are left out.
//
// The command runs in one read-only transaction, rolled back, and sets only
// the session settings a run uses: it creates no table in any schema and
// writes nothing to the database. Each plan is reduced to its shape exactly as
// run --explain reduces it (src/db.mjs, stripPlan), and the plans go to a
// private file under the tool's home, never the repository. The check log of
// the expected network gets a start entry before the first database query and
// an end entry with the functional outcome: succeeded or failed with the
// sanitized error, the run time, the names planned, not planned and (if
// planning one raised an error) failed, and per plan whether it uses a
// sequential scan of a db-sync table, as true or false. That flag is
// information about the plan only.

import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { loadAll, fill, placeholders } from './sqlfile.mjs';
import { connect, dbMeta, applySession, q, stripPlan } from './db.mjs';
import { defaultSettings, sqlParams } from './params.mjs';
import { appendEntry, sanitizeError, refuse } from './checklog.mjs';
import { homeDir, writeJson } from './paths.mjs';
import { codeVersion } from './hash.mjs';

const QUERY = /^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE\s+TABLE\s+[a-z_.]+\s+AS\b)/i;
const CTAS = /^\s*CREATE\s+TABLE\s+[a-z_.]+\s+AS\s+/i;
const INSERT_SELECT = /^\s*INSERT\s+INTO\s+[a-z_.]+(\s*\([^)]*\))?\s+(?=SELECT\b|WITH\b)/i;
const STUDY_REF = /\bstudy\.([a-z_][a-z0-9_]*)(\s*\()?/gi;

const stripComments = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// What explain does with one statement: { name, file, kind: 'plan', sql } or
// { name, file, kind: 'not planned', reason } or null for a statement that is
// not a query. `studyFunctions` is the set of function names of schema study
// in the database.
export function classifyStatement(block, index, params, studyFunctions) {
  const name = block.kind === 'query' ? block.name : `${block.name}#${index + 1}`;
  const raw = stripComments(block.statements[index]).trim();
  if (block.kind === 'lib' || !QUERY.test(raw)) return null;
  const notPlanned = (reason) => ({ name, file: block.file, kind: 'not planned', reason });
  // The query a CREATE TABLE ... AS or an INSERT ... SELECT runs.
  let body = raw;
  if (CTAS.test(body)) body = body.replace(CTAS, '');
  else if (INSERT_SELECT.test(body)) body = body.replace(INSERT_SELECT, '');
  else if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(body)) return notPlanned('writes a table');
  if (/\$\d/.test(body)) return notPlanned('binds values at run time');
  const tables = new Set();
  const fns = new Set();
  for (const m of body.matchAll(STUDY_REF)) (m[2] ? fns : tables).add(m[1].toLowerCase());
  if (tables.size) return notPlanned(`reads study tables: ${[...tables].sort().join(', ')}`);
  const missing = [...fns].filter((f) => !studyFunctions.has(f));
  if (missing.length) return notPlanned(`calls functions of schema study not in this database: ${missing.sort().join(', ')}`);
  const absent = placeholders(body).filter((p) => !Object.prototype.hasOwnProperty.call(params, p));
  if (absent.length) return notPlanned(`needs run parameters the stand-in does not give: ${absent.sort().join(', ')}`);
  return { name, file: block.file, kind: 'plan', sql: fill(body, params) };
}

// Whether a plan reads a table by sequential scan, and which tables.
export function seqScans(plan) {
  const out = new Set();
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (n['Node Type'] === 'Seq Scan' && n['Relation Name']) out.add(n['Relation Name']);
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
  };
  walk(plan);
  return [...out].sort();
}

// The stand-in's parameters: the snapshot block and T(B), the default
// settings, and lo = 0 for the scan of the study key's records, its start
// when no --from-block is given (always, on mainnet).
export function standInParams(network, snapshot) {
  const p = sqlParams({ network, settings: defaultSettings(), snapshot });
  p.lo = { type: 'int', value: 0 };
  return p;
}

export async function explainCommand(a, command, { client = null, blocks = loadAll(), now = () => new Date() } = {}) {
  if (!a.expectNetwork) throw refuse('refusing: explain needs --expect-network, so that its check-log entry is written before the first query');
  if (!(a.purpose || '').trim()) throw refuse('refusing: explain needs --purpose');
  if (a.capture || a.analyze !== undefined) throw refuse('refusing: explain plans with plain EXPLAIN only, never EXPLAIN ANALYZE');
  const t0 = performance.now();
  const v = codeVersion();
  const start = appendEntry(a.expectNetwork, 'query-start', { name: 'explain', purpose: a.purpose, command, code: { git_commit: v.git_commit, git_dirty: v.git_dirty, node: v.node } });
  let c = null;
  let error = null;
  const planned = [];
  const notPlanned = [];
  let file = null;
  try {
    c = client || (await connect({ host: a.host, port: a.port, database: a.database, user: a.user }));
    const meta = await dbMeta(c, blocks);
    if (meta.network !== a.expectNetwork) throw refuse(`refusing: database is ${meta.network}, expected ${a.expectNetwork}`);
    await applySession(c, { work_mem: a.workMem, maintenance_work_mem: a.maintenanceWorkMem, parallel_workers: a.parallelWorkers === undefined ? undefined : Number(a.parallelWorkers), temp_tablespaces: a.tempTablespaces });
    await c.query('BEGIN READ ONLY');
    try {
      const snapRow = !a.snapshot || a.snapshot === 'tip' ? (await q(c, blocks, 'tip_block'))[0] : (await q(c, blocks, 'block_by_hash', { block_hash: { type: 'bytea', value: a.snapshot } }))[0];
      if (!snapRow) throw refuse(`refusing: no block ${a.snapshot} in the database`);
      const t = Number((await q(c, blocks, 't_of_block_plain', { block_id: { type: 'int', value: snapRow.id } }))[0].t);
      const params = standInParams(meta.network, { id: Number(snapRow.id), t });
      const fns = new Set((await c.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'study'`)).rows.map((r) => r.proname));
      for (const b of [...blocks.values()].sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0))) {
        for (let i = 0; i < b.statements.length; i++) {
          const s = classifyStatement(b, i, params, fns);
          if (!s) continue;
          if (s.kind === 'not planned') {
            notPlanned.push({ name: s.name, file: s.file, reason: s.reason });
            continue;
          }
          await c.query('SAVEPOINT plan');
          try {
            const plan = stripPlan((await c.query(`EXPLAIN (FORMAT JSON) ${s.sql}`)).rows[0]['QUERY PLAN']);
            const scans = seqScans(plan);
            planned.push({ name: s.name, file: s.file, seq_scan: scans.length > 0, seq_scan_relations: scans, plan });
          } catch (e) {
            await c.query('ROLLBACK TO SAVEPOINT plan');
            planned.push({ name: s.name, file: s.file, error: sanitizeError(e) });
          }
        }
      }
      const failed = planned.filter((x) => x.error);
      file = join(homeDir(), 'explain', meta.network, `${now().toISOString().replace(/[:.]/g, '')}.json`);
      writeJson(file, { network: meta.network, purpose: a.purpose, stand_in_snapshot: { block_no: Number(snapRow.block_no), hash: snapRow.hash, chosen: !a.snapshot || a.snapshot === 'tip' ? 'tip' : 'hash' }, settings: 'defaults', planned, not_planned: notPlanned });
      if (failed.length) throw new Error(`explain could not plan ${failed.map((x) => x.name).join(', ')}`);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
    }
  } catch (e) {
    error = e;
  } finally {
    appendEntry(a.expectNetwork, 'query', {
      name: 'explain',
      start_seq: start.seq,
      outcome: error ? 'failed' : 'succeeded',
      error: error ? sanitizeError(error) : null,
      run_ms: Math.round(performance.now() - t0),
      planned: planned.filter((x) => !x.error).map((x) => x.name),
      not_planned: notPlanned.map((x) => x.name),
      plan_failed: planned.filter((x) => x.error).map((x) => x.name),
      seq_scan: Object.fromEntries(planned.filter((x) => !x.error).map((x) => [x.name, x.seq_scan]))
    });
    if (c && !client) await c.end();
  }
  if (error) throw error;
  return { file, planned: planned.map(({ plan, ...rest }) => rest), not_planned: notPlanned };
}
