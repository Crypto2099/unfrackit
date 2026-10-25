#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import { readFileSync, writeFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { initSecret } from './hmac.mjs';
import { runPipeline, cleanupRun, ownDrawn, scamRecheck, DEFAULT_STRATA, DEFAULT_RULINGS, DEFAULT_SCAM_LIST } from './pipeline.mjs';
import { captureScamList } from './scam-list.mjs';
import { readStakeList } from './guards.mjs';
import { formatHashList, hashList, codeVersion, TOOL_DIR } from './hash.mjs';
import { loadAll } from './sqlfile.mjs';
import { connect, dbMeta, q } from './db.mjs';
import { a1Compare } from './a1.mjs';
import { project, rowsFromHealth } from './project.mjs';
import { runDir, writeJson, writePrivate } from './paths.mjs';
import { FIXED } from './params.mjs';
import { verifyFinalFreeze, drawKey, readTx, signedBy, ruleSnapshot } from './freeze.mjs';
import { codeManifestErrors, NODE_MAJOR, studyKeyFor } from './guards.mjs';
import { appendEntry, verifyLog, sanitizeError, refuse, loggedQuery, checkLogPath, redactCommand, closeStart } from './checklog.mjs';
import { sha256hex } from './freeze.mjs';
import { Koios } from './koios.mjs';
import { captureStrata } from './strata-capture.mjs';

const USAGE = `research-corpus: draw the research corpus from a cardano-db-sync database.

  init-secret                     make secret/hmac.key (32 random bytes) once; prints its path, never the key
  run [options]                   frames, draw, samples, split, flags, the 6.1 check and the manifest
      --run-id <id>               required; a rerun with the same id resumes
      --snapshot tip|rule|<hash> the snapshot block: on the final freeze always the rule (the last block of
                                  epoch N - 1 before its randomness stabilization cutoff, with the first block of
                                  N 2,160 blocks deep); otherwise the tip by default (stop db-sync there first),
                                  the rule with --stand-in-tx, or a given block
      --freeze-tx <tx hash>       the final freeze transaction; h is the epoch nonce its block's epoch rule names
      --hypotheses-tx <tx hash>   optional: the hypotheses freeze transaction, which must be the chain's
      --from-block <height>       test networks: start the scan for the study key's records at this block
      --prereg <file>             the final pre-registration, as frozen
      --study-key <hex>           test networks: the freeze identity's signing public key (32 bytes); mainnet
                                  uses STUDY_KEY in src/params.mjs and refuses any other
      --code-manifest <file>      the \`npm run hash\` output frozen with the final freeze (mainnet)
      --drawkey <file>            the freeze tool's drawkey.json for the final freeze (mainnet)
      --stand-in-tx <tx hash>     test networks: a transaction whose block's epoch rule stands in for the freeze's
      --live-fire                 a pre-freeze check run (any network): needs --test-h, --purpose and
                                  --expect-network; on mainnet also --hypotheses-tx
      --test-h <hex>              the stated test value of h for a live-fire run (32 bytes)
      --purpose <text>            what the live-fire run checks; written to the check log
      --keep-for-debug            keep a live-fire run's study tables (wallet-level output) after it ends
      --sim-wallets               live-fire: pick the simulator's live-fire wallets (at most ten, by the run's
                                  test h) and keep them in sim/wallets.json until cleanup; once on mainnet
      --explain                   plan every statement with plain EXPLAIN before running it; numbers stripped
      --strata <file>             the strata list (default data/strata-mainnet.json; mainnet: that file only)
      --scam-clone <dir>          a git clone of the scam list's repository, holding the record's commit;
                                  required on mainnet, and on a test network the screen applies only with it
      --scam-list <file>          the scam-list record (default data/scam-list.json; mainnet: that file only)
      --case <stake address>      a case wallet: the per-wallet steps also run for it
      --cases <file>              case wallets, one stake address per line
      --hmac-key <file>           test networks only: an HMAC key other than secret/hmac.key
      --set name=value            override a setting (refused on mainnet unless equal to the default)
      --redo <step>|all           recompute a step and everything after it
      --capture                   EXPLAIN (ANALYZE, BUFFERS) every statement (test networks, not live-fire)
      --expect-network <name>     refuse any other database
      --work-mem <size>           session work memory (default 1GB); also --maintenance-work-mem
      --parallel-workers <n>      parallel workers per query and per index build (default 4)
      --temp-tablespaces <names>  temporary tablespaces with room for twice the study tables
  verify-freeze --prereg [--study-key] [--code-manifest] [--freeze-tx] [--hypotheses-tx] [--from-block]
                                  find the hypotheses record and the final freeze on chain, check the final
                                  record, and print the draw key and the rule's snapshot once each is known;
                                  mainnet: --code-manifest required, --study-key and --from-block as for run
  cleanup --run-id <id>           drop a live-fire run's study tables and work directory, or an a1 live-fire
                                  run's work directory; logged in the check log
  cleanup --start-seq <n> --network <n>
                                  close the start entry a killed command left, by its sequence number; that
                                  start only, never a run's tables, kept output or other starts
  own-drawn --list <file> --run <id>
                                  print, privately, how many listed stake addresses fell in each drawn sample of
                                  a run; writes nothing to the run directory, the manifest or the check log
  check-log verify --network <n>  check the log's sequence and digest chain; list kept outputs not cleaned up
  check-log fix --network <n> --finding <text> --commit <sha> [--entry <seq>]
                                  log a fix made after a live-fire finding
  capture-strata [--out <file>] [--named-from <file>] [--rulings <file>] [--own-sources <file>]
                 [--max-candidates 40] [--spacing-ms 15000]
                                  read CoinGecko's Cardano Ecosystem ranking (every coin's detail) and the token
                                  registry; write the strata file's part 2 and part 4 lists (default:
                                  data/strata-mainnet.json)
  capture-scam-list --clone <dir> [--commit <rev>] [--out <file>] [--extract-out <file>]
                                  record the scam list at a commit of a clone of its repository (default HEAD):
                                  the commit, the SHA-256 of the fixed extract, the counts and any license file
                                  (default: data/scam-list.json); --extract-out writes the extract, outside this
                                  tool's folder
  scam-recheck --run <id> --scam-list <file> --scam-clone <dir>
                                  on a finished run, the strata a later version of the scam list flags, for the
                                  sensitivity analysis; writes scam-recheck-<commit>.json to the run directory
  confirm-snapshot --run-id <id>  the snapshot is still on chain, ${FIXED.security_k} or more blocks deep in the database and
                                  in Koios; for a snapshot by rule, the rule still names it, with the first block
                                  of epoch N that deep
  a1 [--from-run <id> --count 20 --node-count 5] [--stake <addr> ...] [--node-stake <addr> ...]
     [--node-container <name> --node-socket <path> --magic <n>]
     mainnet: --live-fire --purpose <text> --expect-network mainnet --hypotheses-tx
     [--keep-for-debug], or the final freeze options of run
                                  compare UTxO sets with Koios and the node at the database tip; --from-run
                                  takes the first credentials of a run's recent-frame draw order
  health                          the table sizes of health.sql, as JSON (allowed on any network)
  project --timings <file> --preprod-rows <file> --mainnet-rows <file>
                                  scale a preprod run's step times by mainnet row counts
  hash                            SHA-256 of every hashed file, the pinned dependencies and the Node version

Connection: --host --port --database --user, or PGHOST PGPORT PGDATABASE PGUSER; the password comes
from the file PGPASSFILE names. Outputs: \${XDG_DATA_HOME:-$HOME/.local/share}/unfrackit-research/.`;

const FLAGS = new Set(['capture', 'live-fire', 'keep-for-debug', 'explain', 'sim-wallets']);

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
async function a1Gate(c, blocks, meta, a, studyKey) {
  if (meta.network !== 'mainnet' || a.liveFire) return;
  if (!a.freezeTx || !a.prereg || !a.codeManifest) throw new Error('refusing: on mainnet a1 needs --live-fire --purpose, or --freeze-tx, --prereg and --code-manifest');
  const fc = finalChecks(a, meta.network);
  const errs = codeManifestErrors(readFileSync(a.codeManifest, 'utf8'), hashList());
  if (errs.length) throw new Error(`refusing: the code differs from the code manifest: ${errs.join('; ')}`);
  const tip = (await q(c, blocks, 'tip_block'))[0];
  const v = await verifyFinalFreeze({ client: c, blocks, freezeTx: lower(a.freezeTx), hypothesesTx: lower(a.hypothesesTx), preregPath: a.prereg, studyKey, codeDigests: hashList(), tipBlockNo: Number(tip.block_no), ...fc });
  if (!v.ok) throw new Error(`refusing the freeze transaction: ${v.checks.filter((x) => !x.ok).map((x) => x.name).join(', ')}`);
}

// The run's code manifest, the check log, and on a test network the block the
// scan for the study key's records starts at. On mainnet the code manifest is
// required, so the check that the document names it always runs, and
// --from-block is refused.
function finalChecks(a, network) {
  if (network === 'mainnet' && a.fromBlock !== undefined) throw refuse('refusing: --from-block is for test networks only');
  if (network === 'mainnet' && !a.codeManifest) throw refuse('refusing: on mainnet the final-freeze checks need --code-manifest, the code manifest the final freeze names');
  const codeManifestSha256 = a.codeManifest ? sha256hex(readFileSync(a.codeManifest)) : null;
  const checkLogText = network === 'mainnet' ? (existsSync(checkLogPath(network)) ? readFileSync(checkLogPath(network), 'utf8') : '') : undefined;
  return { codeManifestSha256, checkLogText, fromBlock: a.fromBlock !== undefined ? Number(a.fromBlock) : null };
}

const codeFacts = () => (({ git_commit, git_dirty, node }) => ({ git_commit, git_dirty, node }))(codeVersion());

// verify-freeze: finds the hypotheses record and the final freeze on chain,
// checks the final record, and prints the draw key and the rule's snapshot
// once each is known. Reads only. `client` lets the unit tests stand PGlite
// in for the database.
export async function verifyFreezeCommand(a, command, { client = null } = {}) {
  const blocks = loadAll();
  const c = client || (await connect(dbOpts(a)));
  try {
    const meta = await dbMeta(c, blocks);
    await loggedQuery(meta.network, 'verify-freeze', { command, code: codeFacts() }, async () => {
      const fc = finalChecks(a, meta.network);
      const studyKey = studyKeyFor(meta.network, a.studyKey);
      const tip = (await q(c, blocks, 'tip_block'))[0];
      const v = await verifyFinalFreeze({ client: c, blocks, freezeTx: lower(a.freezeTx), hypothesesTx: lower(a.hypothesesTx), preregPath: a.prereg, studyKey, codeDigests: hashList(), tipBlockNo: Number(tip.block_no), ...fc });
      let draw = null;
      let snapshot = null;
      if (v.freezeBlock) {
        const koios = new Koios(meta.network);
        try {
          draw = await drawKey({ client: c, blocks, network: meta.network, block: v.freezeBlock, koios, txHash: v.freeze.tx, drawkeyFile: a.drawkey || null });
          // The snapshot the rule fixes, once it is deep enough to run.
          try {
            const rs = await ruleSnapshot({ client: c, blocks, network: meta.network, n: draw.n, koios, tipBlockNo: Number(tip.block_no) });
            snapshot = { block_no: Number(rs.block.block_no), hash: rs.block.hash, time: rs.block.time, rule: rs.rule, confirmation: rs.confirmation };
          } catch (e) {
            snapshot = { error: e.message };
          }
        } catch (e) {
          draw = { error: e.message };
        }
      }
      console.log(JSON.stringify({ network: meta.network, ok: v.ok, checks: v.checks, document: v.document, freeze: v.freeze, hypotheses: v.hypotheses, draw, snapshot }, null, 2));
      if (!v.ok) process.exitCode = 2;
    });
  } finally {
    if (!client) await c.end();
  }
}

// a1: compares stake credentials' UTxO sets in the database with Koios and
// the node. `client` lets the unit tests stand PGlite in for the database.
export async function a1Command(a, command, { client = null } = {}) {
  const blocks = loadAll();
  const t0 = performance.now();
  const runId = a.runId || `a1-${new Date().toISOString().replace(/[:.]/g, '')}`;
  // A live-fire a1 logs its gate (connection, the hypotheses record on
  // mainnet) as a query before its first query, and its start entry once
  // the gate has passed, like a live-fire run.
  let gate = null;
  let start = null;
  if (a.liveFire) {
    if (!(a.purpose || '').trim()) throw refuse('refusing: a live-fire a1 needs --purpose');
    if (!a.expectNetwork) throw refuse('refusing: a live-fire a1 needs --expect-network, so that its check-log entry is written before the first query');
    gate = appendEntry(a.expectNetwork, 'query-start', { name: 'a1 live-fire gate', run_id: runId, command, code: codeFacts() });
  }
  let c = null;
  let meta = null;
  let error = null;
  let r = null;
  const body = async () => {
    const studyKey = studyKeyFor(meta.network, a.studyKey);
    if (a.liveFire) {
      if (meta.network === 'mainnet') {
        if (!/^[0-9a-f]{64}$/.test(lower(a.hypothesesTx) || '')) throw refuse('refusing: a mainnet live-fire a1 needs --hypotheses-tx (the hypotheses freeze comes first)');
        const hyp = await readTx(c, blocks, lower(a.hypothesesTx));
        if (!hyp || !signedBy(hyp, studyKey)) throw refuse('refusing: the hypotheses freeze is not in the database with a record signed by the study key');
      }
      appendEntry(meta.network, 'query', { name: 'a1 live-fire gate', start_seq: gate.seq, outcome: 'succeeded', error: null, run_ms: Math.round(performance.now() - t0) });
      gate = null;
      start = appendEntry(meta.network, 'a1-live-fire-start', { run_id: runId, command, purpose: a.purpose, code: codeFacts() });
    }
    await a1Gate(c, blocks, meta, a, studyKey);
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
    r = await a1Compare({ client: c, blocks, network: meta.network, views, nodeViews, node, log: a.liveFire ? () => {} : (x) => process.stderr.write(x + '\n') });
    if (!a.liveFire) console.log(JSON.stringify(r, null, 2));
  };
  try {
    c = client || (await connect(dbOpts(a)));
    meta = await dbMeta(c, blocks);
    if (a.expectNetwork && a.expectNetwork !== meta.network) throw refuse(`refusing: database is ${meta.network}, expected ${a.expectNetwork}`);
    if (a.liveFire) await body();
    else await loggedQuery(meta.network, 'a1', { run_id: runId, command, code: codeFacts() }, body);
  } catch (e) {
    error = e;
  } finally {
    if (c && !client) await c.end();
  }
  if (gate) appendEntry(a.expectNetwork, 'query', { name: 'a1 live-fire gate', start_seq: gate.seq, outcome: 'failed', error: error ? sanitizeError(error) : null, run_ms: Math.round(performance.now() - t0) });
  if (start) {
    // Wallet-level output (the UTxO lines that differ) goes to the run's
    // work directory, removed unless kept; the log gets outcomes only.
    const work = join(runDir(a.expectNetwork, runId), 'work');
    let outputs = 'none written';
    if (r) {
      writePrivate(join(work, 'a1.json'), JSON.stringify(r, null, 2) + '\n');
      outputs = 'kept for debugging';
      if (!a.keepForDebug) {
        try {
          rmSync(work, { recursive: true, force: true });
          outputs = `deleted ${new Date().toISOString()}`;
        } catch (e) {
          outputs = `deletion failed: ${sanitizeError(e)}`;
        }
      }
    }
    const results = r ? r.results.map((x) => ({ koios: x.error ? 'error' : x.koios.equal ? 'equal' : x.koios.explained_by_later_txs ? 'explained' : 'differs', node: x.node ? (x.node.equal ? 'equal' : x.node.explained_by_later_txs ? 'explained' : 'differs') : null })) : [];
    const entry = appendEntry(a.expectNetwork, 'a1-live-fire', {
      run_id: runId,
      start_seq: start.seq,
      command,
      purpose: a.purpose,
      code: codeFacts(),
      outcome: error ? 'failed' : 'succeeded',
      error: error ? sanitizeError(error) : null,
      run_ms: Math.round(performance.now() - t0),
      credentials_compared: results.length,
      results,
      wallet_level_output: outputs
    });
    console.log(JSON.stringify(entry, null, 2));
  }
  if (error) throw a.liveFire ? new Error(sanitizeError(error)) : error;
}

// The options `run` passes to runPipeline, named one by one from the parsed
// command line. parseArgs accepts any --name value, so a spread of the parsed
// arguments would let the command line set options no flag is meant to, such
// as the unit tests' stand-in for the pinned study key (studyKeyPin).
export function runOptions(a, command) {
  return {
    db: dbOpts(a),
    runId: a.runId,
    command,
    snapshot: a.snapshot,
    freezeTx: lower(a.freezeTx),
    hypothesesTx: lower(a.hypothesesTx),
    fromBlock: a.fromBlock !== undefined ? Number(a.fromBlock) : undefined,
    prereg: a.prereg,
    studyKey: lower(a.studyKey),
    codeManifest: a.codeManifest,
    drawkey: a.drawkey,
    standInTx: lower(a.standInTx),
    liveFire: a.liveFire ? { testH: lower(a.testH), purpose: a.purpose, keep: !!a.keepForDebug, simWallets: !!a.simWallets } : null,
    simWallets: !!a.simWallets,
    explain: !!a.explain,
    strataList: a.strata || DEFAULT_STRATA,
    strataGiven: !!a.strata,
    scamList: a.scamList,
    scamClone: a.scamClone,
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
  };
}

// Whether the rule, applied again by confirm-snapshot, still names the
// recorded snapshot: true or false when it does or names another block (the
// database's or Koios's last block before the cutoff), null when it cannot
// tell yet. Koios naming another first block of epoch N, or that block not
// yet deep enough, leaves the snapshot unconfirmed rather than replaced, so
// the command exits 3 for it, not 2.
export function snapshotRuleHolds(rs, error, hash) {
  if (rs) return rs.block.hash === hash;
  return /Koios names another last block|no block before its cutoff/.test(error || '') ? false : null;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  const command = redactCommand(process.argv.slice(2));
  switch (cmd) {
    case 'init-secret': {
      const p = initSecret();
      console.log(`created ${p} (mode 0600)`);
      return;
    }
    case 'run': {
      if (!a.runId) throw new Error('--run-id is required');
      const r = await runPipeline(runOptions(a, command));
      console.log(r.live ? JSON.stringify(r.entry, null, 2) : r.dir);
      return;
    }
    case 'verify-freeze':
      await verifyFreezeCommand(a, command);
      return;
    case 'cleanup': {
      if (a.startSeq !== undefined) {
        // A killed command's start entry, closed by its sequence number.
        if (!a.network) throw new Error('cleanup --start-seq needs --network');
        console.log(JSON.stringify(closeStart(a.network, Number(a.startSeq), command), null, 2));
        return;
      }
      if (!a.runId) throw new Error('--run-id is required');
      console.log(JSON.stringify(await cleanupRun({ db: dbOpts(a), runId: a.runId, command }), null, 2));
      return;
    }
    case 'own-drawn': {
      // Private: how many of the listed wallets (Adam K. Dean's own) were
      // drawn, so he can state the number and a sensitivity analysis can
      // drop them. Prints to the terminal only.
      if (!a.list || !a.run) throw new Error('own-drawn --list <file> --run <id>');
      const views = readStakeList(a.list, 'the list');
      const c = await connect(dbOpts(a));
      try {
        console.log(JSON.stringify(await ownDrawn(c, a.run, views), null, 2));
      } finally {
        await c.end();
      }
      return;
    }
    case 'check-log': {
      const sub = a._[0];
      if (!a.network) throw new Error('--network is required');
      if (sub === 'verify') {
        const r = verifyLog(a.network);
        console.log(JSON.stringify(r, null, 2));
        if (r.errors.length || r.kept_not_cleaned.length || r.unclosed.length || r.failed_deletions.length) process.exitCode = 2;
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
        rulings: JSON.parse(readFileSync(a.rulings || DEFAULT_RULINGS, 'utf8')),
        ownSources: a.ownSources ? JSON.parse(readFileSync(a.ownSources, 'utf8')) : {},
        maxCandidates: Number(a.maxCandidates || 40),
        spacingMs: Number(a.spacingMs || 15000),
        tool: codeVersion().git_commit,
        log: (s) => process.stderr.write(s + '\n')
      });
      writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
      console.log(`${out}: ${doc.candidates.length} part 2 candidates, ${doc.part4.length} part 4 coins, ${doc.excluded.length} excluded, ${doc.unsettled.length} unsettled`);
      if (doc.unsettled.length) process.stderr.write(`unsettled, and refused by run until decided: ${doc.unsettled.map((u) => `${u.coingecko_id} (${u.question})`).join('; ')}\n`);
      return;
    }
    case 'capture-scam-list': {
      if (!a.clone) throw new Error('capture-scam-list --clone <dir> [--commit <rev>] [--out <file>] [--extract-out <file>]');
      const out = a.out || DEFAULT_SCAM_LIST;
      const { record, extract } = captureScamList({ clone: a.clone, rev: a.commit || 'HEAD', tool: codeVersion().git_commit });
      if (a.extractOut) {
        // The extract is the list's content; it never lands in this tool's
        // folder, so it cannot be committed with the code by mistake.
        const rel = relative(TOOL_DIR, resolve(a.extractOut));
        if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('--extract-out must be outside the tool\'s folder');
        writePrivate(resolve(a.extractOut), extract.text);
      }
      writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
      for (const x of extract.invalid) process.stderr.write(`not a fingerprint, left out: ${x.path}: ${JSON.stringify(x.value)} (${x.reason})\n`);
      console.log(`${out}: commit ${record.source.commit}, ${record.extract.n_fingerprints} fingerprints, extract SHA-256 ${record.extract.sha256}, license file ${record.license.present ? record.license.files.map((f) => f.path).join(', ') : 'none'}`);
      return;
    }
    case 'scam-recheck': {
      if (!a.run || !a.scamList || !a.scamClone) throw new Error('scam-recheck --run <id> --scam-list <file> --scam-clone <dir>');
      const c = await connect(dbOpts(a));
      try {
        const meta = await dbMeta(c, loadAll());
        await loggedQuery(meta.network, 'scam-recheck', { run_id: a.run, command, code: codeFacts() }, async () => {
          console.log(JSON.stringify(await scamRecheck({ client: c, runId: a.run, recordPath: a.scamList, clone: a.scamClone, network: meta.network }), null, 2));
        });
      } finally {
        await c.end();
      }
      return;
    }
    case 'confirm-snapshot': {
      if (!a.runId) throw new Error('--run-id is required');
      const blocks = loadAll();
      const c = await connect(dbOpts(a));
      try {
        const meta = await dbMeta(c, blocks);
        await loggedQuery(meta.network, 'confirm-snapshot', { run_id: a.runId, command, code: codeFacts() }, async () => {
          const p = (await c.query("SELECT value FROM study.param WHERE run_id = $1 AND key = 'snapshot'", [a.runId])).rows[0];
          if (!p) throw new Error(`no snapshot recorded for run ${a.runId}`);
          const snap = p.value;
          const r = (await q(c, blocks, 'confirm_snapshot', { snap_hash: { type: 'bytea', value: snap.hash } }))[0];
          const depth = r.snap_block_no === null ? null : Number(r.tip_block_no) - Number(r.snap_block_no);
          const k = new Koios(meta.network);
          let result;
          if (snap.rule) {
            // A snapshot by rule: the rule applied again, in the database and
            // in Koios, must give the same block, with the first block of
            // epoch N deep enough in both.
            let rs = null;
            let err = null;
            try {
              rs = await ruleSnapshot({ client: c, blocks, network: meta.network, n: snap.rule.n, koios: k, tipBlockNo: Number(r.tip_block_no) });
            } catch (e) {
              err = e.message;
            }
            const ruleHolds = snapshotRuleHolds(rs, err, snap.hash);
            result = { run_id: a.runId, snapshot: snap, on_chain: r.snap_block_no !== null, rule_holds: ruleHolds, confirmation: rs ? rs.confirmation : null, error: err, required: FIXED.security_k, confirmed: r.snap_block_no !== null && ruleHolds === true, checked_at: new Date().toISOString() };
          } else {
            let koiosReading;
            try {
              const kt = await k.tip();
              koiosReading = { tip_block_no: kt.block_no, depth: kt.block_no - snap.block_no, read_at: new Date().toISOString() };
            } catch (e) {
              koiosReading = { error: e.message };
            }
            const koiosOk = !koiosReading.error && koiosReading.depth >= FIXED.security_k;
            result = { run_id: a.runId, snapshot: snap, on_chain: r.snap_block_no !== null, depth, koios: koiosReading, required: FIXED.security_k, confirmed: r.snap_block_no !== null && depth >= FIXED.security_k && koiosOk, checked_at: new Date().toISOString() };
          }
          await c.query(
            "INSERT INTO study.param (run_id, key, value) VALUES ($1, 'confirm_snapshot', $2::jsonb) ON CONFLICT (run_id, key) DO UPDATE SET value = EXCLUDED.value",
            [a.runId, JSON.stringify(result)]
          );
          writeJson(join(runDir(meta.network, a.runId), 'confirm-snapshot.json'), result);
          console.log(JSON.stringify(result, null, 2));
          if (!result.on_chain || result.rule_holds === false) process.exitCode = 2;
          else if (!result.confirmed) process.exitCode = 3;
        });
      } finally {
        await c.end();
      }
      return;
    }
    case 'a1':
      await a1Command(a, command);
      return;
    case 'health': {
      const c = await connect(dbOpts(a));
      try {
        const meta = await dbMeta(c, loadAll());
        await loggedQuery(meta.network, 'health', { command, code: codeFacts() }, async () => {
          const r = await c.query(`SELECT c.relname, c.reltuples::bigint AS approx_rows, pg_total_relation_size(c.oid) AS bytes
                                     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                    WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`);
          console.log(JSON.stringify(r.rows.map((x) => ({ relname: x.relname, approx_rows: Number(x.approx_rows), bytes: Number(x.bytes) })), null, 2));
        });
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
