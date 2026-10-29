// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The connection to a cardano-db-sync database, read only, and the gate that
// decides whether this code may read it.
//
// Host, port, database and user come from the options or from PGHOST, PGPORT,
// PGDATABASE and PGUSER. The password is read from the file PGPASSFILE names
// (libpq's format, mode 0600) when the connection opens, handed to
// node-postgres and kept nowhere else; it is never printed or logged.
//
// Every session is read only (default_transaction_read_only), and the first
// statement reads db-sync's own bookkeeping (meta) to learn the network. A
// test network is read at any time. Mainnet is read only through the gate
// below, which runs before the connection is handed to any command, so before
// any wallet query. EXPLAIN ANALYZE executes a statement and reports row
// counts, so it is refused on mainnet in any case; plain EXPLAIN is allowed
// everywhere.
//
// The gate. A mainnet connection names its path, and the calling code chooses
// it, never a command-line option. One path exists, `final-freeze`: the
// extraction tool's study run for the final freeze has finished. The gate
// reads the record that tool's driver writes once it has verified the final
// freeze record, the code and the check log (tools/research-corpus,
// src/pipeline.mjs and src/freeze.mjs), and does not verify the freeze again:
// - study.run and study.param are readable by this role;
// - exactly one run's `freeze` row has the role `final-freeze`, on mainnet;
// - its `mode` row is `study`, and it has a `finished` row, which the driver
//   deletes when a run starts or resumes and writes as its last act;
// - its `snapshot` row is a block fixed by rule, with id, hash and T(B), and
//   its `windows` row gives both windows' blocks and transaction-id bounds;
// - every study table this code reads (frame, sample, franken, txo,
//   txo_asset, asset) carries that run's mark, `research-corpus run <id>`, so
//   the samples and flags read are that run's.
// The grant is that run's snapshot and windows, in the form an extraction
// run's params.json gives them (windows.mjs fromExtractionRun); every command
// on the connection uses them (commands.mjs makeContext), and a --snapshot or
// --extraction-run naming anything else is refused. Every other mainnet
// connection is refused.

import pg from 'pg';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fill, loadAll } from './sqlfile.mjs';

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

// opts: host, port, database, user, expectNetwork, blocks (the loaded SQL).
// gate: the mainnet path the calling code runs under (see above).
export async function connect(opts = {}, { gate = 'final-freeze' } = {}) {
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
    await checkConnection(client, opts.blocks || loadAll(), { expectNetwork: opts.expectNetwork, gate });
  } catch (e) {
    await client.end().catch(() => {});
    throw e;
  }
  return client;
}

// The session settings, the network, and on mainnet the gate. Sets
// client.network, client.dbsyncVersion and, on mainnet, client.gate (the
// grant). Exported for the tests, which give it a client whose query layer is
// stubbed.
export async function checkConnection(client, blocks, { expectNetwork = null, gate = 'final-freeze' } = {}) {
  await client.query('SET search_path = public, pg_catalog');
  await client.query('SET default_transaction_read_only = on');
  const meta = (await client.query('SELECT network_name, version::text AS version FROM public.meta LIMIT 1')).rows[0];
  if (!meta) throw new Refusal('refusing: public.meta is empty; not a cardano-db-sync database');
  client.network = meta.network_name;
  client.dbsyncVersion = meta.version;
  client.gate = null;
  if (expectNetwork && meta.network_name !== expectNetwork) {
    throw new Refusal(`refusing: the database is ${meta.network_name}, not ${expectNetwork}`);
  }
  if (meta.network_name === 'mainnet') client.gate = await mainnetGate((name, params) => q(client, blocks, name, params), gate);
  return client;
}

export const MAINNET_PATHS = Object.freeze(['final-freeze']);

// The gate: the grant for a mainnet connection on `path`, or a Refusal.
// read(name, params) runs a named query of sql/gate.sql.
export async function mainnetGate(read, path = 'final-freeze') {
  if (path === 'final-freeze') return finalFreezeGrant(read);
  throw new Refusal(`refusing: mainnet is read only after the final freeze; there is no mainnet path ${path}`);
}

const STUDY_TABLES = Object.freeze(['frame', 'sample', 'franken', 'txo', 'txo_asset', 'asset']);
const HEX64 = /^[0-9a-f]{64}$/;
const isId = (x) => Number.isSafeInteger(x) && x >= 0;
export const runMark = (runId) => `research-corpus run ${runId}`;

export async function finalFreezeGrant(read) {
  const no = (why) => new Refusal(`refusing: mainnet is read only after the extraction's study run for the final freeze has finished; ${why}`);
  const readable = (await read('gate_runs_readable'))[0];
  if (!readable || !readable.readable) throw no('this role cannot read the extraction\'s run records (study.run, study.param)');
  const runs = await read('gate_final_freeze_runs');
  if (!runs.length) throw no('no run of the final freeze is recorded');
  if (runs.length > 1) throw no(`${runs.length} runs of the final freeze are recorded, where the extraction allows one`);
  const r = runs[0];
  const id = r.run_id;
  if (r.network !== 'mainnet') throw no(`run ${id} is recorded for ${r.network}`);
  if (r.mode !== 'study') throw no(`run ${id} is recorded as a ${r.mode === null || r.mode === undefined ? 'run without a mode' : `${r.mode} run`}, not a study run`);
  if (!r.finished) throw no(`run ${id} has not finished`);
  const s = r.snapshot;
  if (!s || !isId(s.id) || !HEX64.test(String(s.hash)) || !isId(s.t) || s.chosen !== 'rule') throw no(`run ${id} records no snapshot block fixed by rule`);
  const win = (w) => (w && [w.first_block, w.last_block, w.lo, w.hi, w.t_start].every(isId) ? { firstBlock: w.first_block, lastBlock: w.last_block, lo: w.lo, hi: w.hi, tStart: w.t_start } : null);
  const windows = r.windows ? { recent: win(r.windows.recent), peak: win(r.windows.peak) } : null;
  if (!windows || !windows.recent || !windows.peak) throw no(`run ${id} records no windows`);
  const marks = await read('gate_table_marks');
  const want = runMark(id);
  const other = STUDY_TABLES.filter((t) => !marks.some((m) => m.name === t && m.mark === want));
  if (other.length) throw no(`the study tables ${other.join(', ')} are not marked as built by run ${id}`);
  return { path: 'final-freeze', run: { network: 'mainnet', runId: id, snapshot: { id: s.id, hash: s.hash, tx: s.t }, windows } };
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
