// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The extraction tool's own reader of the check log, run over logs this
// tool's live-fire command wrote: its verifyLog (sequence, digest chain,
// unclosed starts, kept output, failed deletions, the sim- prefix rule) and
// its final-freeze check's live_fire_after_hypotheses on a chain of signed
// records in PGlite, built as that tool's own tests build them; and its
// redaction against this tool's. The extraction tool is read where
// RESEARCH_SIM_CORPUS_TOOL points (its tools/research-corpus directory, with
// its dependencies installed), or beside this tool; without it these tests
// are skipped. Nothing in it is changed or run but these functions.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runLiveFire, cleanupLiveFire } from '../../../src/study/live-fire.mjs';
import { sanitize } from '../../../src/study/checklog.mjs';
import { runDir } from '../../../src/history/paths.mjs';
import { TOOL_DIR } from '../../../src/hash.mjs';
import { seedPick, logText, logEntries } from '../../lib/live-fire.mjs';
import { liveFireStubs } from '../../lib/live-fire-stubs.mjs';

const CORPUS = process.env.RESEARCH_SIM_CORPUS_TOOL || join(TOOL_DIR, '..', 'research-corpus');
const present = existsSync(join(CORPUS, 'src', 'checklog.mjs')) && existsSync(join(CORPUS, 'node_modules', '@electric-sql', 'pglite'));
const skip = present ? false : 'the extraction tool is not beside this one with its dependencies installed; set RESEARCH_SIM_CORPUS_TOOL to its directory';
const load = (p) => import(pathToFileURL(join(CORPUS, p)).href);
const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, '..', '..', 'lib', 'live-fire-child.mjs');
const saved = { sim: process.env.RESEARCH_SIM_HOME, corpus: process.env.RESEARCH_CORPUS_HOME };
let root;
let C;
let F;
let R;
let S;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'research-sim-live-fire-corpus-'));
  process.env.RESEARCH_SIM_HOME = join(root, 'sim');
  if (!present) return;
  [C, F, R, S] = await Promise.all([load('src/checklog.mjs'), load('src/freeze.mjs'), load('test/lib/records.mjs'), load('src/sqlfile.mjs')]);
});
after(() => {
  for (const [k, v] of [['RESEARCH_SIM_HOME', saved.sim], ['RESEARCH_CORPUS_HOME', saved.corpus]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

// A fresh check-log root for a test, with the extraction run's pick written
// by the extraction tool's own appendEntry.
function fresh(name, extractionRun, date) {
  process.env.RESEARCH_CORPUS_HOME = join(root, name);
  seedPick('mainnet', extractionRun, { append: (n, t, f, d) => C.appendEntry(n, t, f, d), date });
}
const opts = (runId, extractionRun, extra = {}) => ({ _: [], runId, extractionRun, purpose: 'confirm the replays run on real data', expectNetwork: 'mainnet', treatment: join(root, 'treatment'), ...extra });
const run = (o, stub = {}, more = {}) => runLiveFire(o, { commands: liveFireStubs(stub), gate: async () => {}, manifest: () => 'stand-in manifest\n', say: () => {}, ...more });
const ids = (xs) => xs.map((x) => x.run_id);

function runChild(o, stub) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, JSON.stringify([o, stub])], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('HUNG')) child.kill('SIGKILL');
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

test("the extraction tool's verifyLog reads the simulator's runs: clean, refused at the gate, kept until cleanup, killed, a failed deletion", { skip }, async () => {
  fresh('verify', 'xr-1');
  await run(opts('sim-clean', 'xr-1'));
  await assert.rejects(run(opts('sim-refused', 'xr-1'), {}, { gate: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:15434'); } }), /the live-fire gate failed/);
  let v = C.verifyLog('mainnet');
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.unclosed, []);
  assert.deepEqual(v.failed_deletions, []);
  // Only the extraction run that kept the pick is listed as kept.
  assert.deepEqual(ids(v.kept_not_cleaned), ['xr-1']);

  await run(opts('sim-kept', 'xr-1', { keepForDebug: true }), { fail: 'battery' });
  v = C.verifyLog('mainnet');
  assert.deepEqual(ids(v.kept_not_cleaned), ['xr-1', 'sim-kept']);
  cleanupLiveFire({ _: [], cleanup: true, runId: 'sim-kept', network: 'mainnet' });
  v = C.verifyLog('mainnet');
  assert.deepEqual(ids(v.kept_not_cleaned), ['xr-1']);

  const killed = await runChild(opts('sim-killed', 'xr-1'), { network: 'mainnet', hang: 'replay-peak' });
  assert.equal(killed.signal, 'SIGKILL');
  v = C.verifyLog('mainnet');
  assert.deepEqual(v.unclosed.map((x) => [x.type, x.run_id]), [['sim-live-fire-start', 'sim-killed']]);
  cleanupLiveFire({ _: [], cleanup: true, runId: 'sim-killed', network: 'mainnet' });
  assert.deepEqual(C.verifyLog('mainnet').unclosed, []);

  const stuck = await run(opts('sim-stuck', 'xr-1'), { readOnly: 'battery' });
  assert.match(stuck.entry.wallet_level_output, /^deletion failed: /);
  v = C.verifyLog('mainnet');
  assert.deepEqual(ids(v.failed_deletions), ['sim-stuck']);
  chmodSync(runDir('mainnet', 'sim-stuck'), 0o700);
  cleanupLiveFire({ _: [], cleanup: true, runId: 'sim-stuck', network: 'mainnet' });
  v = C.verifyLog('mainnet');
  assert.deepEqual([v.errors, v.unclosed, v.failed_deletions, ids(v.kept_not_cleaned)], [[], [], [], ['xr-1']]);
  assert.equal(v.entries, logEntries('mainnet').length);
});

test("the extraction tool's redaction and this tool's agree", { skip }, () => {
  const samples = [
    'wallet 4182: transaction ' + 'c0ffee'.repeat(10) + 'beef pays addr1q' + 'x9v8w7'.repeat(9) + '; 37 UTxOs',
    'canceling statement due to statement timeout at 1,234,567 rows (row37, 1e5, 12h30m, abc0x1f4)',
    'relation "study.frame_2024" does not exist; stake_test1u' + 'q'.repeat(52) + ' and \\xdeadbeef and 0x1f',
    'connect ECONNREFUSED 127.0.0.1:15434',
    'x5_reward29 and t_of_block and 3_rows_5'
  ];
  for (const s of samples) {
    assert.equal(sanitize(s), C.sanitize(s), s);
    assert.equal(sanitize(s, { refusal: true }), C.sanitize(s, { refusal: true }), s);
  }
});

// The final-freeze check on a chain of a hypotheses record (block time
// 2026-10-01) and a final record whose document lists the given log as the
// check-log prefix, as the extraction tool's tests build it.
async function freezeCheck(text) {
  const key = R.keypair();
  const dir = mkdtempSync(join(root, 'freeze-'));
  try {
    const { db, add } = await R.chain();
    const hypDigest = R.sha(Buffer.from(`hypotheses text\nkey ${key.pub.toString('hex')}\n`));
    const hypTx = await add({ blockNo: 1000, slot: 50000, epoch: 10, epochSlot: 1000, body: R.metadataBytes(R.record([hypDigest], key)), msg: hypDigest });
    const code = [{ path: 'src/a.mjs', sha256: R.sha('a') }];
    const listed = [{ sha256: R.sha('a'), name: 'a.mjs' }, { sha256: R.sha('the code manifest'), name: 'code-manifest.txt' }, { sha256: F.logPrefixDigests(text).at(-1), name: 'check-log.jsonl' }];
    const doc = `final text\nkey ${key.pub.toString('hex')}\nhypotheses web+cardano://transaction/${hypTx}/metadata/309\n\n${listed.map((l) => `${l.sha256}  ${l.name}`).join('\n')}\n`;
    const finalDigest = R.sha(Buffer.from(doc));
    const freezeTx = await add({ blockNo: 2000, slot: 4800000, epoch: 11, epochSlot: 5000, body: R.metadataBytes(R.record([finalDigest, ...listed.map((l) => l.sha256)], key)), msg: finalDigest });
    writeFileSync(join(dir, 'final.md'), doc);
    return await F.verifyFinalFreeze({ client: db, blocks: S.loadAll(), freezeTx, hypothesesTx: hypTx, preregPath: join(dir, 'final.md'), studyKey: key.pub.toString('hex'), codeDigests: code, tipBlockNo: 5000, checkLogText: text });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const failed = (v) => v.checks.filter((c) => !c.ok).map((c) => c.name);
const detail = (v, name) => v.checks.find((c) => c.name === name).detail;

test("the final-freeze check counts the simulator's start as a live-fire run, before and after the hypotheses block", { skip }, async () => {
  // The simulator's lines alone, as it wrote them: its start is then the
  // log's first live-fire run.
  for (const [name, when, want] of [['before', '2026-09-01T00:00:00.000Z', ['live_fire_after_hypotheses']], ['after', '2026-10-20T00:00:00.000Z', []]]) {
    fresh(`freeze-${name}`, 'xr-f', '2026-08-01T00:00:00.000Z');
    const n0 = logEntries('mainnet').length;
    await run(opts(`sim-${name}`, 'xr-f'), {}, { now: () => new Date(when) });
    const lines = logText('mainnet').split('\n').filter(Boolean).slice(n0);
    assert.deepEqual(lines.map((l) => JSON.parse(l).type), ['query-start', 'query', 'sim-live-fire-start', 'sim-live-fire']);
    const v = await freezeCheck(lines.join('\n') + '\n');
    assert.deepEqual(failed(v), want, name);
    assert.match(detail(v, 'live_fire_after_hypotheses'), new RegExp(`^first live-fire run ${when.replace(/\./g, '\\.')} \\(sim-live-fire-start\\)`));
  }
  // The whole log, the extraction's pick first: its chain verifies, and its
  // first live-fire run is the extraction's start, after the block.
  fresh('freeze-whole', 'xr-w', '2026-10-15T00:00:00.000Z');
  await run(opts('sim-whole', 'xr-w'), {}, { now: () => new Date('2026-10-20T00:00:00.000Z') });
  const v = await freezeCheck(logText('mainnet'));
  assert.deepEqual(failed(v), []);
  assert.match(detail(v, 'live_fire_after_hypotheses'), /^first live-fire run 2026-10-15T00:00:00\.000Z \(live-fire-start\)/);
  assert.deepEqual(C.verifyLog('mainnet').errors, []);
});
