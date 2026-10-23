// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The step runner. Each step runs in one transaction: its statements, its row
// in study.step(name, run_id, started, finished, rows), and a comment on every
// table it builds naming the run. A rerun skips a step whose row is finished
// and whose tables still carry this run's mark, unless told to redo it; once
// one step is recomputed, every later step is recomputed too, since each reads
// the tables before it. A failed step rolls back whole and leaves no partial
// table or step row behind.
//
// In quiet mode (a live-fire run) the runner counts nothing: study.step.rows
// stays NULL, the log line and the timings carry the step's name, outcome and
// time only, and no statement's row count is kept.

import { performance } from 'node:perf_hooks';
import { fill } from './sqlfile.mjs';
import { exec } from './db.mjs';

export const mark = (runId) => `research-corpus run ${runId}`;

export async function ownedBy(client, table, runId) {
  const r = await client.query('SELECT obj_description(to_regclass($1), $2) AS c', [table, 'pg_class']);
  return r.rows[0].c === mark(runId);
}

export async function stepDone(client, runId, name) {
  const r = await client.query('SELECT finished FROM study.step WHERE run_id = $1 AND name = $2', [runId, name]);
  return r.rows.length > 0 && r.rows[0].finished !== null;
}

export class Runner {
  constructor({ client, blocks, runId, params, capture = false, explain = false, quiet = false, log = () => {}, redo = new Set(), onStep = null }) {
    this.client = client;
    this.blocks = blocks;
    this.runId = runId;
    this.params = params;
    this.capture = capture;
    this.explain = explain;
    this.quiet = quiet;
    this.log = log;
    this.redo = redo;
    this.recomputing = false;
    this.timings = [];
    this.onStep = onStep;
  }

  async isSkippable(block) {
    if (this.recomputing || this.redo.has(block.name) || this.redo.has('all')) return false;
    if (!(await stepDone(this.client, this.runId, block.name))) return false;
    for (const t of block.outputs) if (!(await ownedBy(this.client, t, this.runId))) return false;
    return true;
  }

  // Runs a step or lib block by name. `extra` adds parameters for this call;
  // `hook(client)` runs inside the step transaction after its statements (bound
  // loads, rows the driver computes).
  async run(name, extra = {}, hook = null) {
    const block = this.blocks.get(name);
    if (!block) throw new Error(`no SQL block named ${name}`);
    if (block.kind === 'query') throw new Error(`${name} is a query`);
    if (block.kind === 'step' && (await this.isSkippable(block))) {
      this.log(`skip ${name} (finished in run ${this.runId})`);
      return { skipped: true };
    }
    if (block.kind === 'step') this.recomputing = true;
    const params = { ...this.params, ...extra };
    const statements = block.statements.map((s) => fill(s, params));
    const c = this.client;
    const t0 = performance.now();
    const stmts = [];
    await c.query('BEGIN');
    try {
      if (block.kind === 'step') {
        await c.query('DELETE FROM study.step WHERE run_id = $1 AND name = $2', [this.runId, name]);
        await c.query('INSERT INTO study.step (run_id, name, started) VALUES ($1, $2, clock_timestamp())', [this.runId, name]);
      }
      const rows = new Map();
      for (const sql of statements) {
        const r = await exec(c, sql, { capture: this.capture, explain: this.explain });
        if (this.quiet) r.rowCount = null;
        stmts.push(r);
        if (r.target && r.rowCount !== null && r.rowCount !== undefined) {
          const prev = rows.get(r.target) || 0;
          if (r.kind === 'create') rows.set(r.target, r.rowCount);
          else if (r.kind === 'insert') rows.set(r.target, prev + r.rowCount);
          else if (r.kind === 'delete') rows.set(r.target, prev - r.rowCount);
        }
      }
      if (hook) await hook(c);
      let stepRows = null;
      if (block.outputs.length) {
        const first = block.outputs[0];
        if (!this.quiet) {
          stepRows =
            !this.capture && !hook && rows.has(first) ? rows.get(first) : Number((await c.query(`SELECT count(*) AS n FROM ${first}`)).rows[0].n);
        }
        for (const t of block.outputs) await c.query(`COMMENT ON TABLE ${t} IS '${mark(this.runId)}'`);
      }
      if (block.kind === 'step') {
        await c.query('UPDATE study.step SET finished = clock_timestamp(), rows = $3 WHERE run_id = $1 AND name = $2', [this.runId, name, stepRows]);
      }
      await c.query('COMMIT');
      const ms = performance.now() - t0;
      const rec = { name, kind: block.kind, file: block.file, ms, rows: stepRows, statements: stmts };
      this.timings.push(rec);
      this.log(`${block.kind} ${name}: ${(ms / 1000).toFixed(1)} s${stepRows !== null ? `, ${stepRows} rows` : ''}`);
      this.lastOk = name;
      if (this.onStep) await this.onStep(rec);
      return rec;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      this.failed = { name, ms: performance.now() - t0 };
      e.message = `step ${name}: ${e.message}`;
      throw e;
    }
  }
}

// Drops every study table that carries the run's mark and the run's
// bookkeeping rows (study.param and study.step cascade from study.run).
// Returns the names of the tables dropped.
export async function dropRunTables(client, runId) {
  const r = await client.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'study' AND c.relkind = 'r' AND obj_description(c.oid, 'pg_class') = $1 ORDER BY c.relname`,
    [mark(runId)]
  );
  const names = r.rows.map((x) => x.relname);
  for (const t of names) {
    if (!/^[a-z0-9_]+$/.test(t)) throw new Error(`unexpected table name ${t}`);
    await client.query(`DROP TABLE IF EXISTS study.${t} CASCADE`);
  }
  await client.query('DELETE FROM study.run WHERE run_id = $1', [runId]);
  return names;
}
