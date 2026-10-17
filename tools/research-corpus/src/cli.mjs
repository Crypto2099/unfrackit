#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initSecret } from './hmac.mjs';
import { runPipeline } from './pipeline.mjs';
import { formatHashList, TOOL_DIR } from './hash.mjs';
import { loadAll } from './sqlfile.mjs';
import { connect, dbMeta, q } from './db.mjs';
import { a1Compare } from './a1.mjs';
import { project, rowsFromHealth } from './project.mjs';
import { runDir, writeJson } from './paths.mjs';
import { FIXED } from './params.mjs';

const USAGE = `research-corpus: draw the research corpus from a cardano-db-sync database.

  init-secret                     make secret/hmac.key (32 random bytes) once; prints its path, never the key
  run [options]                   frames, draw, samples, split, flags, the 6.1 check and the manifest
      --run-id <id>               required; a rerun with the same id resumes
      --snapshot tip|<block hash> the snapshot block (default tip; stop db-sync there first)
      --freeze-tx <tx hash>       mainnet: the freeze transaction; h is its block's hash
      --stand-in-tx <tx hash>     test networks: a transaction whose block hash stands in for h
      --strata <file>             the strata list (default data/strata-mainnet.json)
      --consented <file>          private file of stake addresses removed from every frame
      --case <stake address>      also run the per-wallet steps for this wallet (never sampled)
      --hmac-key <file>           test networks only: an HMAC key other than secret/hmac.key
      --set name=value            override a setting (fixed values and readings)
      --redo <step>|all           recompute a step and everything after it
      --capture                   EXPLAIN (ANALYZE, BUFFERS) every statement (refused on mainnet)
      --expect-network <name>     refuse any other database
      --work-mem <size>           session work memory (default 1GB); also --maintenance-work-mem
      --parallel-workers <n>      parallel workers per query and per index build (default 4)
      --temp-tablespaces <names>  temporary tablespaces with room for twice the study tables
  confirm-snapshot --run-id <id>  the snapshot hash is still on chain, ${FIXED.security_k} or more blocks later
  a1 [--from-run <id> --count 20 --node-count 5] [--stake <addr> ...] [--node-stake <addr> ...]
     [--node-container <name> --node-socket <path> --magic <n>]
                                  compare UTxO sets with Koios and the node at the database tip; --from-run
                                  takes the first credentials of a run's recent-frame draw order
  health                          the table sizes of health.sql, as JSON (allowed on any network)
  project --timings <file> --preprod-rows <file> --mainnet-rows <file>
                                  scale a preprod run's step times by mainnet row counts
  hash                            SHA-256 of every hashed file, the pinned dependencies and the Node version

Connection: --host --port --database --user, or PGHOST PGPORT PGDATABASE PGUSER; the password comes
from the file PGPASSFILE names. Outputs: \${XDG_DATA_HOME:-$HOME/.local/share}/unfrackit-research/.`;

function parseArgs(argv) {
  const out = { _: [], set: [], redo: [], stake: [], nodeStake: [], case: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const k = a.slice(2);
    if (k === 'capture') {
      out.capture = true;
      continue;
    }
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    if (k === 'set') out.set.push(v);
    else if (k === 'redo') out.redo.push(v);
    else if (k === 'stake') out.stake.push(v);
    else if (k === 'node-stake') out.nodeStake.push(v);
    else if (k === 'case') out.case.push(v);
    else out[k.replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = v;
  }
  return out;
}

const dbOpts = (a) => ({ host: a.host, port: a.port, database: a.database, user: a.user });

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  switch (cmd) {
    case 'init-secret': {
      const p = initSecret();
      console.log(`created ${p} (mode 0600)`);
      return;
    }
    case 'run': {
      if (!a.runId) throw new Error('--run-id is required');
      const r = await runPipeline({
        db: dbOpts(a),
        runId: a.runId,
        snapshot: a.snapshot || 'tip',
        freezeTx: a.freezeTx,
        standInTx: a.standInTx,
        strataList: a.strata || join(TOOL_DIR, 'data', 'strata-mainnet.json'),
        consented: a.consented,
        hmacKey: a.hmacKey,
        caseWallets: a.case,
        set: a.set,
        redo: a.redo,
        capture: !!a.capture,
        expectNetwork: a.expectNetwork,
        session: {
          work_mem: a.workMem,
          maintenance_work_mem: a.maintenanceWorkMem,
          parallel_workers: a.parallelWorkers === undefined ? undefined : Number(a.parallelWorkers),
          temp_tablespaces: a.tempTablespaces
        }
      });
      console.log(r.dir);
      return;
    }
    case 'confirm-snapshot': {
      if (!a.runId) throw new Error('--run-id is required');
      const blocks = loadAll();
      const c = await connect(dbOpts(a));
      try {
        const meta = await dbMeta(c, blocks);
        const p = (await c.query("SELECT value FROM study.param WHERE run_id = $1 AND key = 'snapshot'", [a.runId])).rows[0];
        if (!p) throw new Error(`no snapshot recorded for run ${a.runId}`);
        const r = (await q(c, blocks, 'confirm_snapshot', { snap_hash: { type: 'bytea', value: p.value.hash } }))[0];
        const depth = r.snap_block_no === null ? null : Number(r.tip_block_no) - Number(r.snap_block_no);
        const result = { run_id: a.runId, snapshot: p.value, on_chain: r.snap_block_no !== null, depth, required: FIXED.security_k, confirmed: r.snap_block_no !== null && depth >= FIXED.security_k, checked_at: new Date().toISOString() };
        writeJson(join(runDir(meta.network, a.runId), 'confirm-snapshot.json'), result);
        console.log(JSON.stringify(result, null, 2));
        if (!result.on_chain) process.exitCode = 2;
        else if (!result.confirmed) process.exitCode = 3;
      } finally {
        await c.end();
      }
      return;
    }
    case 'a1': {
      const blocks = loadAll();
      const c = await connect(dbOpts(a));
      try {
        const meta = await dbMeta(c, blocks);
        const node = a.nodeContainer ? { container: a.nodeContainer, socket: a.nodeSocket || '/ipc/node.socket', magic: a.magic || (meta.network === 'mainnet' ? 'mainnet' : '1') } : null;
        let views = a.stake;
        let nodeViews = a.nodeStake;
        if (a.fromRun) {
          // The first credentials in the recent frame's draw order of a run.
          const n = Number(a.count || 20);
          const m = Number(a.nodeCount || 5);
          const r = await c.query(
            `SELECT c.view FROM study.draw_order d JOIN study.cred c ON c.sa_id = d.sa_id
              WHERE d.frame = 'recent' AND obj_description('study.draw_order'::regclass, 'pg_class') = $1
              ORDER BY d.k LIMIT $2`,
            [`research-corpus run ${a.fromRun}`, n]
          );
          if (r.rows.length < n) throw new Error(`run ${a.fromRun} does not own study.draw_order, or it has fewer than ${n} keys`);
          views = [...views, ...r.rows.map((x) => x.view)];
          nodeViews = [...nodeViews, ...r.rows.slice(0, m).map((x) => x.view)];
        }
        const r = await a1Compare({ client: c, blocks, network: meta.network, views, nodeViews, node, log: (s) => process.stderr.write(s + '\n') });
        console.log(JSON.stringify(r, null, 2));
      } finally {
        await c.end();
      }
      return;
    }
    case 'health': {
      const c = await connect(dbOpts(a));
      try {
        const r = await c.query(`SELECT c.relname, c.reltuples::bigint AS approx_rows, pg_total_relation_size(c.oid) AS bytes
                                   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                  WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`);
        console.log(JSON.stringify(r.rows.map((x) => ({ relname: x.relname, approx_rows: Number(x.approx_rows), bytes: Number(x.bytes) })), null, 2));
      } finally {
        await c.end();
      }
      return;
    }
    case 'project': {
      const timings = JSON.parse(readFileSync(a.timings, 'utf8'));
      const pre = rowsFromHealth(JSON.parse(readFileSync(a.preprodRows, 'utf8')));
      const main = rowsFromHealth(JSON.parse(readFileSync(a.mainnetRows, 'utf8')));
      console.log(JSON.stringify(project(timings, pre, main), null, 2));
      return;
    }
    case 'hash':
      process.stdout.write(formatHashList());
      return;
    default:
      console.log(USAGE);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
