// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Connection to a cardano-db-sync database as the study role, and the guards
// that decide whether this code may read it.
//
// The password is read from the file PGPASSFILE names (libpq's pgpass format,
// mode 0600) when the connection opens, handed to node-postgres and kept
// nowhere else; it is never printed or logged. Host, port, database and user
// come from the command line or PGHOST, PGPORT, PGDATABASE, PGUSER.
//
// Guards:
// - The first statement reads db-sync's own bookkeeping (meta, schema_version,
//   extra_migrations), as db-sync's health checks do. A database whose extra
//   migrations show prune or bootstrap has deleted history and is refused.
//   db-sync records the consumed configuration as ConsumeTxOutPreviouslySet
//   (cardano-db, Cardano/Db/Types.hs), so the match is on "consume"; and
//   every database must have tx_in rows, whatever its configuration says.
//   Probes then check that db-sync inserted what the SQL reads (db_probes in
//   05-01-snapshot.sql); a missing insert option would otherwise empty a
//   measure silently.
// - The session must have standard_conforming_strings on. Parameters are
//   written as decode() calls and do not depend on it, but any string literal
//   with a backslash would.
// - The mainnet guards (the final freeze, the code manifest, the run options)
//   live in src/guards.mjs and src/freeze.mjs.

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fill } from './sqlfile.mjs';
import { assertPrivate } from './paths.mjs';

// libpq's password file: lines host:port:database:user:password, '*' matching
// anything, ':' and '\' escaped with '\'. The first matching line wins.
export function pgpassLookup(text, { host, port, database, user }) {
  for (const raw of text.split('\n')) {
    if (!raw || raw.startsWith('#')) continue;
    const fields = [];
    let cur = '';
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === '\\' && i + 1 < raw.length) cur += raw[++i];
      else if (c === ':' && fields.length < 4) {
        fields.push(cur);
        cur = '';
      } else cur += c;
    }
    fields.push(cur);
    if (fields.length !== 5) continue;
    const want = [host, String(port), database, user];
    if (want.every((w, k) => fields[k] === '*' || fields[k] === w)) return fields[4];
  }
  return null;
}

export async function connect(opts = {}) {
  const cfg = {
    host: opts.host || process.env.PGHOST || '127.0.0.1',
    port: Number(opts.port || process.env.PGPORT || 5432),
    database: opts.database || process.env.PGDATABASE,
    user: opts.user || process.env.PGUSER || 'study'
  };
  const passfile = process.env.PGPASSFILE;
  const client = new pg.Client({
    ...cfg,
    application_name: 'research-corpus',
    statement_timeout: 0,
    password: async () => {
      if (!passfile) throw new Error('set PGPASSFILE to the password file of the study role');
      assertPrivate(passfile);
      const pw = pgpassLookup(readFileSync(passfile, 'utf8'), cfg);
      if (pw === null) throw new Error(`no line in PGPASSFILE matches ${cfg.host}:${cfg.port}:${cfg.database}:${cfg.user}`);
      return pw;
    }
  });
  await client.connect();
  await client.query("SET search_path = public, pg_catalog");
  const scs = (await client.query('SHOW standard_conforming_strings')).rows[0].standard_conforming_strings;
  if (scs !== 'on') {
    await client.end();
    throw new Error(`refusing: standard_conforming_strings is ${scs}`);
  }
  return client;
}

// Session settings for the heavy steps (the life table is a join of every
// output with a stake credential against tx_in): a work memory of 1 to 2 GB,
// parallel workers, and a temporary tablespace with free space when one is
// given.
export async function applySession(client, s) {
  const sets = [
    ['work_mem', s.work_mem || '1GB'],
    ['maintenance_work_mem', s.maintenance_work_mem || '1GB'],
    ['max_parallel_workers_per_gather', String(s.parallel_workers ?? 4)],
    ['max_parallel_maintenance_workers', String(s.parallel_workers ?? 4)]
  ];
  if (s.temp_tablespaces) sets.push(['temp_tablespaces', s.temp_tablespaces]);
  for (const [k, v] of sets) {
    if (!/^[A-Za-z0-9_,]+$/.test(v)) throw new Error(`bad value for ${k}: ${v}`);
    await client.query(`SET ${k} = '${v}'`);
  }
  const shown = {};
  for (const [k] of sets) shown[k] = (await client.query(`SHOW ${k}`)).rows[0][k];
  return shown;
}

export async function dbMeta(client, blocks) {
  const r = (await client.query(blocks.get('db_meta').statements[0])).rows[0];
  if (!r) throw new Error('meta is empty: not a db-sync database');
  const migrations = JSON.parse(r.extra_migrations);
  return { network: r.network_name, version: r.version, startTime: r.start_time, schemaVersion: JSON.parse(r.schema_version), extraMigrations: migrations };
}

export const PROBES = ['tx_in', 'multi_asset', 'ma_tx_out', 'ma_tx_mint', 'metadata_674', 'redeemer', 'inline_datum', 'epoch_nonce'];

export function checkMigrations(extraMigrations) {
  const bad = extraMigrations.filter((t) => /prune|bootstrap/i.test(t));
  if (bad.length) throw new Error(`refusing: extra_migrations shows ${bad.join(', ')}; history has been deleted`);
  return { consumed: extraMigrations.some((t) => /consume/i.test(t)) };
}

// Returns the probe results; throws when any is missing.
export async function checkHistoryIntact(client, blocks, meta) {
  const m = checkMigrations(meta.extraMigrations);
  const r = (await client.query(blocks.get('db_probes').statements[0])).rows[0];
  const missing = PROBES.filter((k) => r[k] !== true);
  if (missing.includes('tx_in') && m.consumed) throw new Error('refusing: consumed is configured and tx_in is empty');
  if (missing.length) throw new Error(`refusing: db-sync inserted nothing for ${missing.join(', ')}`);
  return Object.fromEntries(PROBES.map((k) => [k, r[k]]));
}

// Runs a named query block with typed parameters.
export async function q(client, blocks, name, params = {}) {
  const b = blocks.get(name);
  if (!b) throw new Error(`no SQL block named ${name}`);
  if (b.kind !== 'query') throw new Error(`${name} is a ${b.kind}, not a query`);
  return (await client.query(fill(b.statements[0], params))).rows;
}

// Runs a query block that takes bound $n values (keys or lists that must not
// appear in statement text).
export async function qBound(client, blocks, name, values) {
  const b = blocks.get(name);
  if (!b) throw new Error(`no SQL block named ${name}`);
  return client.query(b.statements[0], values);
}

const EXPLAINABLE = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE\s+TABLE\s+[a-z_.]+\s+AS\b)/i;
const TARGET = /^\s*(?:CREATE\s+TABLE\s+([a-z_.]+)\s+AS\b|INSERT\s+INTO\s+([a-z_.]+)|DELETE\s+FROM\s+([a-z_.]+))/i;

function headOf(sql) {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

// A plan reduced to its shape: only the keys below are kept (node types,
// relations and indexes, join and scan kinds, conditions, keys and outputs).
// Everything else, row estimates, widths, costs, planned workers and
// partitions, and the JIT and memory flags that follow cost thresholds, is
// derived from planner estimates of the data, and is dropped.
const PLAN_KEYS = new Set([
  'Plan', 'Plans', 'Node Type', 'Parent Relationship', 'Subplan Name', 'Relation Name', 'Schema', 'Alias', 'Index Name',
  'Join Type', 'Strategy', 'Partial Mode', 'Scan Direction', 'Operation', 'Command', 'CTE Name', 'Function Name',
  'Hash Cond', 'Merge Cond', 'Join Filter', 'Filter', 'Index Cond', 'Recheck Cond', 'TID Cond', 'One-Time Filter',
  'Group Key', 'Sort Key', 'Presorted Key', 'Output', 'Parallel Aware', 'Async Capable', 'Inner Unique', 'Single Copy'
]);
export function stripPlan(node) {
  if (Array.isArray(node)) return node.map(stripPlan);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) if (PLAN_KEYS.has(k)) out[k] = stripPlan(v);
    return out;
  }
  return node;
}

// Executes one statement. With capture, an explainable statement runs under
// EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON), which executes it, and the plan is
// returned with the wall time. With explain, an explainable statement is first
// planned under plain EXPLAIN (FORMAT JSON), which does not execute it, the
// plan is kept with its numbers stripped, and the statement then runs.
export async function exec(client, sql, { capture = false, explain = false } = {}) {
  const body = sql.replace(/^(\s*--[^\n]*\n)+/, '');
  const t0 = performance.now();
  let res;
  let plan = null;
  if (capture && EXPLAINABLE.test(body)) {
    res = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${body}`);
    plan = res.rows[0]['QUERY PLAN'];
  } else if (explain && EXPLAINABLE.test(body)) {
    plan = stripPlan((await client.query(`EXPLAIN (FORMAT JSON) ${body}`)).rows[0]['QUERY PLAN']);
    res = await client.query(body);
  } else {
    res = await client.query(body);
  }
  const ms = performance.now() - t0;
  const tm = TARGET.exec(body);
  const target = tm ? (tm[1] || tm[2] || tm[3]).toLowerCase() : null;
  const kind = tm ? (tm[1] ? 'create' : tm[2] ? 'insert' : 'delete') : null;
  let rowCount = capture && plan ? null : res.rowCount;
  if (capture && plan && kind === 'create') rowCount = plan[0].Plan['Actual Rows'] * (plan[0].Plan['Actual Loops'] || 1);
  return { head: headOf(body), ms, rowCount, target, kind, plan };
}
