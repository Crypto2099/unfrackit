#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import { readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { initSecret } from './hmac.mjs';
import { runPipeline, cleanupRun, DEFAULT_STRATA } from './pipeline.mjs';
import { formatHashList, hashList, codeVersion } from './hash.mjs';
import { loadAll } from './sqlfile.mjs';
import { connect, dbMeta, q } from './db.mjs';
import { a1Compare } from './a1.mjs';
import { project, rowsFromHealth } from './project.mjs';
import { runDir, writeJson, writePrivate } from './paths.mjs';
import { FIXED } from './params.mjs';
import { verifyFinalFreeze, drawKey } from './freeze.mjs';
import { codeManifestErrors, NODE_MAJOR } from './guards.mjs';
import { appendEntry, verifyLog, sanitize } from './checklog.mjs';
import { Koios } from './koios.mjs';
import { captureStrata } from './strata-capture.mjs';

const USAGE = `research-corpus: draw the research corpus from a cardano-db-sync database.

  init-secret                     make secret/hmac.key (32 random bytes) once; prints its path, never the key
  run [options]                   frames, draw, samples, split, flags, the 6.1 check and the manifest
      --run-id <id>               required; a rerun with the same id resumes
      --snapshot tip|<block hash> the snapshot block (default tip; stop db-sync there first; mainnet: tip only)
      --freeze-tx <tx hash>       the final freeze transaction; h is the epoch nonce its block's epoch rule names
      --hypotheses-tx <tx hash>   the hypotheses freeze transaction the final pre-registration cites
      --prereg <file>             the final pre-registration, as frozen
      --study-key <hex>           the freeze identity's signing public key (32 bytes)
      --code-manifest <file>      the \`npm run hash\` output frozen with the final freeze (mainnet)
      --stand-in-tx <tx hash>     test networks: a transaction whose block's epoch rule stands in for the freeze's
      --live-fire                 a pre-freeze check run (any network): needs --test-h and --purpose
      --test-h <hex>              the stated test value of h for a live-fire run (32 bytes)
      --purpose <text>            what the live-fire run checks; written to the check log
      --keep-for-debug            keep a live-fire run's study tables (wallet-level output) after it ends
      --explain                   plan every statement with plain EXPLAIN before running it; numbers stripped
      --strata <file>             the strata list (default data/strata-mainnet.json; mainnet: that file only)
      --consented <file>          private file of stake addresses removed from every frame
      --case <stake address>      a case wallet (run without sampling); must be in the consented file
      --cases <file>              case wallets, one stake address per line; each must be in the consented file
      --hmac-key <file>           test networks only: an HMAC key other than secret/hmac.key
      --set name=value            override a setting (refused on mainnet unless equal to the default)
      --redo <step>|all           recompute a step and everything after it
      --capture                   EXPLAIN (ANALYZE, BUFFERS) every statement (test networks, not live-fire)
      --expect-network <name>     refuse any other database
      --work-mem <size>           session work memory (default 1GB); also --maintenance-work-mem
      --parallel-workers <n>      parallel workers per query and per index build (default 4)
      --temp-tablespaces <names>  temporary tablespaces with room for twice the study tables
  verify-freeze --freeze-tx --hypotheses-tx --prereg --study-key
                                  check the final freeze record and print the draw key once its epoch has started
  cleanup --run-id <id>           drop a live-fire run's study tables and work directory; logged in the check log
  check-log verify --network <n>  check the log's sequence and digest chain; list kept outputs not cleaned up
  check-log fix --network <n> --finding <text> --commit <sha> [--entry <seq>]
                                  log a fix made after a live-fire finding
  capture-strata [--out <file>] [--named-from <file>] [--exclusions <file>] [--own-sources <file>]
                 [--max-candidates 40] [--spacing-ms 15000]
                                  read CoinGecko's Cardano Ecosystem ranking and the token registry; write the
                                  strata file's candidate list (default: data/strata-mainnet.json)
  confirm-snapshot --run-id <id>  the snapshot hash is still on chain, ${FIXED.security_k} or more blocks later
  a1 [--from-run <id> --count 20 --node-count 5] [--stake <addr> ...] [--node-stake <addr> ...]
     [--node-container <name> --node-socket <path> --magic <n>]
     mainnet: --live-fire --purpose <text> [--keep-for-debug], or the final freeze options of run
                                  compare UTxO sets with Koios and the node at the database tip; --from-run
                                  takes the first credentials of a run's recent-frame draw order
  health                          the table sizes of health.sql, as JSON (allowed on any network)
  project --timings <file> --preprod-rows <file> --mainnet-rows <file>
                                  scale a preprod run's step times by mainnet row counts
  hash                            SHA-256 of every hashed file, the pinned dependencies and the Node version

Connection: --host --port --database --user, or PGHOST PGPORT PGDATABASE PGUSER; the password comes
from the file PGPASSFILE names. Outputs: \${XDG_DATA_HOME:-$HOME/.local/share}/unfrackit-research/.`;

const FLAGS = new Set(['capture', 'live-fire', 'keep-for-debug', 'explain']);

export function parseArgs(argv) {
  const out = { _: [], set: [], redo: [], stake: [], nodeStake: [], case: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const k = a.slice(2);
    const camel = k.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    if (FLAGS.has(k)) {
      out[camel] = true;
      continue;
    }
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    if (k === 'set') out.set.push(v);
    else if (k === 'redo') out.redo.push(v);
    else if (k === 'stake') out.stake.push(v);
    else if (k === 'node-stake') out.nodeStake.push(v);
    else if (k === 'case') out.case.push(v);
    else out[camel] = v;
  }
  return out;
}

const dbOpts = (a) => ({ host: a.host, port: a.port, database: a.database, user: a.user });
const lower = (x) => (x ? x.toLowerCase() : x);

// On mainnet, a1 is a study query: it runs only as a logged live-fire check
// before the final freeze, or after it with the final freeze checked.
async function a1Gate(c, blocks, meta, a) {
  if (meta.network !== 'mainnet' || a.liveFire) return;
  if (!a.freezeTx || !a.hypothesesTx || !a.prereg || !a.studyKey || !a.codeManifest) throw new Error('refusing: on mainnet a1 needs --live-fire --purpose, or --freeze-tx, --hypotheses-tx, --prereg, --study-key and --code-manifest');
  const errs = codeManifestErrors(readFileSync(a.codeManifest, 'utf8'), hashList());
  if (errs.length) throw new Error(`refusing: the code differs from the code manifest: ${errs.join('; ')}`);
  const tip = (await q(c, blocks, 'tip_block'))[0];
  const v = await verifyFinalFreeze({ client: c, blocks, freezeTx: a.freezeTx, hypothesesTx: a.hypothesesTx, preregPath: a.prereg, studyKey: a.studyKey, codeDigests: hashList(), tipBlockNo: Number(tip.block_no) });
  if (!v.ok) throw new Error(`refusing the freeze transaction: ${v.checks.filter((x) => !x.ok).map((x) => x.name).join(', ')}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  const command = process.argv.slice(2).join(' ');
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
        command,
        snapshot: a.snapshot || 'tip',
        freezeTx: lower(a.freezeTx),
        hypothesesTx: lower(a.hypothesesTx),
        prereg: a.prereg,
        studyKey: lower(a.studyKey),
        codeManifest: a.codeManifest,
        standInTx: lower(a.standInTx),
        liveFire: a.liveFire ? { testH: lower(a.testH), purpose: a.purpose, keep: !!a.keepForDebug } : null,
        explain: !!a.explain,
        strataList: a.strata || DEFAULT_STRATA,
        strataGiven: !!a.strata,
        consented: a.consented,
        hmacKey: a.hmacKey,
        caseWallets: a.case,
        casesFile: a.cases,
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
      console.log(r.live ? JSON.stringify(r.entry, null, 2) : r.dir);
      return;
    }
    case 'verify-freeze': {
      const blocks = loadAll();
      const c = await connect(dbOpts(a));
      try {
        const meta = await dbMeta(c, blocks);
        const tip = (await q(c, blocks, 'tip_block'))[0];
        const v = await verifyFinalFreeze({ client: c, blocks, freezeTx: a.freezeTx, hypothesesTx: a.hypothesesTx, preregPath: a.prereg, studyKey: a.studyKey, codeDigests: hashList(), tipBlockNo: Number(tip.block_no) });
        let draw = null;
        if (v.freezeBlock) {
          try {
            draw = await drawKey({ client: c, blocks, network: meta.network, block: v.freezeBlock, koios: new Koios(meta.network) });
          } catch (e) {
            draw = { error: e.message };
          }
        }
        console.log(JSON.stringify({ network: meta.network, ok: v.ok, checks: v.checks, document: v.document, freeze: v.freeze, hypotheses: v.hypotheses, draw }, null, 2));
        if (!v.ok) process.exitCode = 2;
      } finally {
        await c.end();
      }
      return;
    }
    case 'cleanup': {
      if (!a.runId) throw new Error('--run-id is required');
      console.log(JSON.stringify(await cleanupRun({ db: dbOpts(a), runId: a.runId, command }), null, 2));
      return;
    }
    case 'check-log': {
      const sub = a._[0];
      if (!a.network) throw new Error('--network is required');
      if (sub === 'verify') {
        const r = verifyLog(a.network);
        console.log(JSON.stringify(r, null, 2));
        if (r.errors.length || r.kept_not_cleaned.length) process.exitCode = 2;
      } else if (sub === 'fix') {
        if (!a.finding || !/^[0-9a-f]{7,40}$/.test(a.commit || '')) throw new Error('fix needs --finding <text> and --commit <sha>');
        console.log(JSON.stringify(appendEntry(a.network, 'fix', { finding: a.finding, commit: a.commit, entry: a.entry ? Number(a.entry) : null, command }), null, 2));
      } else throw new Error('check-log verify|fix');
      return;
    }
    case 'capture-strata': {
      const out = a.out || DEFAULT_STRATA;
      const named = JSON.parse(readFileSync(a.namedFrom || DEFAULT_STRATA, 'utf8')).named;
      const doc = await captureStrata({
        named,
        exclusions: a.exclusions ? JSON.parse(readFileSync(a.exclusions, 'utf8')) : [],
        ownSources: a.ownSources ? JSON.parse(readFileSync(a.ownSources, 'utf8')) : {},
        maxCandidates: Number(a.maxCandidates || 40),
        spacingMs: Number(a.spacingMs || 15000),
        tool: codeVersion().git_commit,
        log: (s) => process.stderr.write(s + '\n')
      });
      writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
      console.log(`${out}: ${doc.candidates.length} candidates, ${doc.excluded.length} excluded`);
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
      const t0 = performance.now();
      let meta = null;
      let error = null;
      let r = null;
      const runId = a.runId || `a1-${new Date().toISOString().replace(/[:.]/g, '')}`;
      try {
        meta = await dbMeta(c, blocks);
        if (a.liveFire && !(a.purpose || '').trim()) throw new Error('refusing: a live-fire a1 needs --purpose');
        await a1Gate(c, blocks, meta, a);
        const node = a.nodeContainer ? { container: a.nodeContainer, socket: a.nodeSocket || '/ipc/node.socket', magic: a.magic || (meta.network === 'mainnet' ? 'mainnet' : '1') } : null;
        let views = a.stake;
        let nodeViews = a.nodeStake;
        if (a.fromRun) {
          // The first credentials in the recent frame's draw order of a run.
          const n = Number(a.count || 20);
          const m = Number(a.nodeCount || 5);
          const rows = await c.query(
            `SELECT c.view FROM study.draw_order d JOIN study.cred c ON c.sa_id = d.sa_id
              WHERE d.frame = 'recent' AND obj_description('study.draw_order'::regclass, 'pg_class') = $1
              ORDER BY d.k LIMIT $2`,
            [`research-corpus run ${a.fromRun}`, n]
          );
          if (rows.rows.length < n) throw new Error(`run ${a.fromRun} does not own study.draw_order, or it has too few keys`);
          views = [...views, ...rows.rows.map((x) => x.view)];
          nodeViews = [...nodeViews, ...rows.rows.slice(0, m).map((x) => x.view)];
        }
        r = await a1Compare({ client: c, blocks, network: meta.network, views, nodeViews, node, log: a.liveFire ? () => {} : (s) => process.stderr.write(s + '\n') });
        if (!a.liveFire) console.log(JSON.stringify(r, null, 2));
      } catch (e) {
        error = e;
      } finally {
        await c.end();
      }
      if (a.liveFire && meta) {
        // Wallet-level output (the UTxO lines that differ) goes to the run's
        // work directory, removed unless kept; the log gets outcomes only.
        const work = join(runDir(meta.network, runId), 'work');
        let outputs = 'none written';
        if (r) {
          writePrivate(join(work, 'a1.json'), JSON.stringify(r, null, 2) + '\n');
          outputs = 'kept for debugging';
          if (!a.keepForDebug) {
            rmSync(work, { recursive: true, force: true });
            outputs = `deleted ${new Date().toISOString()}`;
          }
        }
        const results = r ? r.results.map((x) => ({ koios: x.error ? 'error' : x.koios.equal ? 'equal' : x.koios.explained_by_later_txs ? 'explained' : 'differs', node: x.node ? (x.node.equal ? 'equal' : x.node.explained_by_later_txs ? 'explained' : 'differs') : null })) : [];
        const entry = appendEntry(meta.network, 'a1-live-fire', {
          run_id: runId,
          command,
          purpose: a.purpose,
          code: (({ git_commit, git_dirty, node }) => ({ git_commit, git_dirty, node }))(codeVersion()),
          outcome: error ? 'failed' : 'succeeded',
          error: error ? sanitize(error.message) : null,
          run_ms: Math.round(performance.now() - t0),
          credentials_compared: results.length,
          results,
          wallet_level_output: outputs
        });
        console.log(JSON.stringify(entry, null, 2));
      }
      if (error) throw a.liveFire ? new Error(sanitize(error.message)) : error;
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
      if (Number(process.versions.node.split('.')[0]) !== NODE_MAJOR) process.stderr.write(`warning: Node ${process.version}; the code is pinned to Node ${NODE_MAJOR}\n`);
      return;
    default:
      console.log(USAGE);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
}

const invoked = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invoked) {
  main().catch((e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
}
