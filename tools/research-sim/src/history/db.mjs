// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The connection to a cardano-db-sync database, read only, and the guards
// that decide whether this code may read it.
//
// Host, port, database and user come from the options or from PGHOST, PGPORT,
// PGDATABASE and PGUSER. The password is read from the file PGPASSFILE names
// (libpq's format, mode 0600) when the connection opens, handed to
// node-postgres and kept nowhere else; it is never printed or logged.
//
// Every session is read only (default_transaction_read_only), and the first
// statement reads db-sync's own bookkeeping (meta) to learn the network.
// Mainnet is refused: this reader's mainnet runs belong to the study's run
// after its final freeze and to its pre-freeze checks, whose gate and check
// log are not part of this code. EXPLAIN ANALYZE executes a statement and
// reports row counts, so it is refused on mainnet in any case; plain EXPLAIN
// is allowed everywhere.

import pg from 'pg';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fill } from './sqlfile.mjs';

export class Refusal extends Error {}

// libpq's password file: host:port:database:user:password, '*' matching
// anything, ':' and '\' escaped with '\'. The first matching line wins.
export function pgpassLookup(text, { host, port, database, user }) {
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const fields = [];
    let cur = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '\\' && i + 1 < line.length) cur += line[++i];
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

function assertPrivate(path) {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} is readable by others (mode ${mode.toString(8)}); expected 0600`);
}

export async function connect(opts = {}) {
  const cfg = {
    host: opts.host || process.env.PGHOST || '127.0.0.1',
    port: Number(opts.port || process.env.PGPORT || 5432),
    database: opts.database || process.env.PGDATABASE,
    user: opts.user || process.env.PGUSER || 'readonly'
  };
  const passfile = process.env.PGPASSFILE;
  const client = new pg.Client({
    ...cfg,
    application_name: 'research-sim',
    statement_timeout: 0,
    password: async () => {
      if (!passfile) throw new Error('set PGPASSFILE to the password file of the database role');
      assertPrivate(passfile);
      const pw = pgpassLookup(readFileSync(passfile, 'utf8'), cfg);
      if (pw === null) throw new Error(`no line in PGPASSFILE matches ${cfg.host}:${cfg.port}:${cfg.database}:${cfg.user}`);
      return pw;
    }
  });
  await client.connect();
  try {
    await client.query('SET search_path = public, pg_catalog');
    await client.query('SET default_transaction_read_only = on');
    const meta = (await client.query('SELECT network_name, version::text AS version FROM public.meta LIMIT 1')).rows[0];
    if (!meta) throw new Refusal('refusing: public.meta is empty; not a cardano-db-sync database');
    client.network = meta.network_name;
    client.dbsyncVersion = meta.version;
    if (opts.expectNetwork && meta.network_name !== opts.expectNetwork) {
      throw new Refusal(`refusing: the database is ${meta.network_name}, not ${opts.expectNetwork}`);
    }
    if (meta.network_name === 'mainnet') {
      throw new Refusal('refusing: this reader does not query mainnet; its mainnet runs need the final freeze or a pre-freeze check gate, which this code does not implement');
    }
  } catch (e) {
    await client.end().catch(() => {});
    throw e;
  }
  return client;
}

// Runs a named query block with typed parameters.
export async function q(client, blocks, name, params = {}) {
  const b = blocks.get(name);
  if (!b) throw new Error(`no SQL block named ${name}`);
  if (b.kind !== 'query') throw new Error(`${name} is a ${b.kind}, not a query`);
  return (await client.query(fill(b.statements[0], params))).rows;
}

// Plain EXPLAIN of a named query: the plan without executing it.
export async function explain(client, blocks, name, params = {}) {
  const b = blocks.get(name);
  const sql = fill(b.statements[0], params);
  return (await client.query(`EXPLAIN (FORMAT JSON) ${sql}`)).rows[0]['QUERY PLAN'];
}

// EXPLAIN (ANALYZE, BUFFERS): executes the query. Refused on mainnet.
export async function explainAnalyze(client, blocks, name, params = {}) {
  if (client.network === 'mainnet') throw new Refusal('refusing: EXPLAIN ANALYZE on mainnet');
  const b = blocks.get(name);
  const sql = fill(b.statements[0], params);
  return (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`)).rows[0]['QUERY PLAN'];
}

// Runs a named query and returns its rows with the wall time in ms.
export async function timed(client, blocks, name, params = {}) {
  const t0 = performance.now();
  const rows = await q(client, blocks, name, params);
  return { rows, ms: performance.now() - t0 };
}
