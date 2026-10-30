// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Shared setup for the preprod integration tests. They run against a preprod
// cardano-db-sync database as the study role and refuse any other network.
//
// Environment:
//   PGHOST PGPORT PGDATABASE PGUSER PGPASSFILE   the preprod database and the study role
//   RESEARCH_CORPUS_SEEDER_DIR                   the preprod seeder's folder (tools/preprod-seeder)
//   RESEARCH_CORPUS_TEST_HMAC_KEY                a 32-byte test key (never the study key)
//   RESEARCH_CORPUS_TEST_TAG                     names the run ids and the results directory
//   RESEARCH_CORPUS_NODE_CONTAINER               the preprod node's container, for the node query
//   RESEARCH_CORPUS_DBTOOL_IMAGE                 the pinned db-sync image, for cardano-db-tool
//   RESEARCH_CORPUS_REHEARSAL_DIR                the freeze tool's preprod rehearsal directory (T13; optional)
//
// The seeder is used only through its documented commands `address <shape>`
// and `verify <shape>`, run from its folder, and through its deterministic
// specification generator generate(<shape>), which touches no key.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect, dbMeta } from '../../src/db.mjs';
import { loadAll } from '../../src/sqlfile.mjs';
import { runDir, writeJson } from '../../src/paths.mjs';
import { rewardAddressOf } from '../../src/bech32.mjs';

export const blocks = loadAll();
export const TAG = process.env.RESEARCH_CORPUS_TEST_TAG || 'tests';
export const SEEDER = process.env.RESEARCH_CORPUS_SEEDER_DIR;
export const FUNDER = 'addr_test1qrlyfluymcfgpzgfkgwxuagswajrvgzx79fmazk3x7ew9lse4sqrp5lwp45k8qtxmlw8k6xrsz4hndyun78udq0v0fkqdhlwfm';
export const SHAPES = ['S1', 'S3', 'M2'];
export const RUN_A = `${TAG}-a`;
export const RUN_B = `${TAG}-b`;

export async function db() {
  const c = await connect();
  const meta = await dbMeta(c, blocks);
  if (meta.network !== 'preprod') {
    await c.end();
    throw new Error(`integration tests run on preprod only; this database is ${meta.network}`);
  }
  return c;
}

export function resultsDir() {
  return join(runDir('preprod', TAG), 'tests');
}

export function record(name, value) {
  writeJson(join(resultsDir(), `${name}.json`), value);
}

export function seederAddress(shape) {
  if (!SEEDER) throw new Error('set RESEARCH_CORPUS_SEEDER_DIR');
  const out = execFileSync('node', ['src/cli.mjs', 'address', shape], { cwd: SEEDER, encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

export function seederVerify(shape) {
  try {
    const out = execFileSync('node', ['src/cli.mjs', 'verify', shape], { cwd: SEEDER, encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') };
  }
}

export async function specOf(shape) {
  const { generate } = await import(pathToFileURL(join(SEEDER, 'src', 'shapes.mjs')).href);
  return generate(shape);
}

export function stakeOf(address) {
  return rewardAddressOf(address).bech;
}

export async function saIdOf(c, view) {
  const r = await c.query('SELECT id FROM public.stake_address WHERE view = $1', [view]);
  return r.rows.length ? Number(r.rows[0].id) : null;
}

// The stand-in for the freeze on preprod: the transaction that seeded shape S1.
export const S1_SEEDING_TX = '0183bce3b177353fec0963164cf4d4693a2f5060decc87bb3ae762a6aadd0152';
