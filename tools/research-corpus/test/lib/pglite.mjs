// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// An in-process PostgreSQL (PGlite) for unit tests: no server and no db-sync
// data. The study SQL files run unchanged against small fixture tables.

import { PGlite } from '@electric-sql/pglite';
import { loadAll, fill } from '../../src/sqlfile.mjs';

export async function freshDb() {
  const db = await PGlite.create();
  await db.exec('SET check_function_bodies = off; CREATE SCHEMA study;');
  const blocks = loadAll();
  const runBlock = async (name, params = {}) => {
    const b = blocks.get(name);
    if (!b) throw new Error(`no block ${name}`);
    for (const s of b.statements) await db.exec(fill(s, params));
  };
  const rows = async (sql, params) => (await db.query(sql, params)).rows;
  await runBlock('schema');
  await runBlock('cip67');
  return { db, blocks, runBlock, rows };
}

export const bool = (value) => ({ type: 'bool', value });
export const int = (value) => ({ type: 'int', value });
export const num = (value) => ({ type: 'num', value });
export const text = (value) => ({ type: 'text', value });
export const bytea = (value) => ({ type: 'bytea', value });
