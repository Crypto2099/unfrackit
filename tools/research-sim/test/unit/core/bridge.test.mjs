// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The bridge (methods/helper.mjs), tested without another language: a helper
// in plain Node (test/lib/bridge-csl-helper.mjs) wraps the csl-lf adapter, and
// the bridged method's replay records equal csl-lf's run directly, byte for
// byte, under both changes, on the MI-3 shapes and on the preprod history
// RESEARCH_SIM_BRIDGE_HISTORY names (that part skips without it). A helper
// that exits or writes something that is not its response stops the job with
// a run error and its stderr tail, never a spend outcome. A helper's build
// record is checked against the tree, and the pool's memory readings count a
// worker's helper processes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { helperMethod, helperBuild, helperSourceHash, helperPids, stopHelpers, BUILD_SCRIPT, HELPER_SCHEMA } from '../../../src/methods/helper.mjs';
import { RunError, checkMethod } from '../../../src/methods/contract.mjs';
import { classOfCslError } from '../../../src/methods/csl.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { REPLAY_PARTS } from '../../../src/methods/library.mjs';
import { replay } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { processMemory, descendantPids } from '../../../src/replay/pool.mjs';
import { treatment, skip } from '../../lib/treatment.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const HELPER = fileURLToPath(new URL('../../lib/bridge-csl-helper.mjs', import.meta.url));
const MI3 = ['S1', 'S6', 'S8', 'S9', 'M1', 'M7', 'CL1', 'E2', 'M2'];
const HISTORY = process.env.RESEARCH_SIM_BRIDGE_HISTORY || null;
const T = skip ? null : await treatment();

let n = 0;
function bridged(env = {}) {
  const direct = makeMethod(T, 'csl-lf');
  return helperMethod(T, {
    name: 'csl-lf',
    version: direct.version,
    deterministic: true,
    seeded: true,
    library: 'csl-lf',
    coverage: REPLAY_PARTS,
    classify: classOfCslError,
    refused: 'the bridged csl-lf takes its own change or the layout change only',
    process: { key: `test-csl-${++n}`, command: process.execPath, args: [HELPER], env: { ...process.env, ...env } }
  });
}

const strip = (x) => JSON.stringify(x, (k, v) => (k === 'ms' ? undefined : typeof v === 'bigint' ? v.toString() : v));
const run = (source, method, changePolicy) => replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method, opts: { seed: 1, changePolicy, collateralRule: 'ledger' }, settleEvery: 25, validity: true });

async function sameRecords(spec, label) {
  const source = loadSource(T, spec);
  const direct = makeMethod(T, 'csl-lf');
  const viaBridge = checkMethod(bridged());
  let built = 0;
  for (const cp of ['default', 'layout']) {
    const a = await run(source, direct, cp);
    const b = await run(source, viaBridge, cp);
    assert.equal(b.spends.length, a.spends.length, `${label} ${cp}: spends`);
    a.spends.forEach((s, i) => assert.equal(strip(b.spends[i]), strip(s), `${label} ${cp}: spend ${i}`));
    assert.equal(strip({ ...b, spends: null }), strip({ ...a, spends: null }), `${label} ${cp}: bursts and summary`);
    built += a.spends.filter((s) => s.outcome === 'built').length;
  }
  return built;
}

test('through the bridge, csl-lf\'s records equal csl-lf\'s run directly on the MI-3 shapes, under both changes', { skip, timeout: 5 * 60 * 1000 }, async () => {
  let built = 0;
  for (const name of MI3) built += await sameRecords({ kind: 'shape', name, stream: 'synthetic' }, name);
  assert.ok(built > 100);
});

test('through the bridge, csl-lf\'s records equal csl-lf\'s run directly on a preprod history', { skip: skip || (HISTORY ? false : 'set RESEARCH_SIM_BRIDGE_HISTORY to a preprod history file'), timeout: 5 * 60 * 1000 }, async () => {
  const built = await sameRecords({ kind: 'history', path: HISTORY, analysisFreezeTx: null }, HISTORY.split('/').pop());
  assert.ok(built > 0);
});

test('a helper that exits, or writes a line that is not its response, stops the job with its stderr tail', { skip }, async () => {
  const source = loadSource(T, { kind: 'shape', name: 'S1', stream: 'synthetic' });
  await assert.rejects(run(source, bridged({ HELPER_TEST_EXIT_ON: '1' }), 'default'), (e) => e instanceof RunError && /exited with code 3/.test(e.message) && /its stderr/.test(e.message));
  await assert.rejects(run(source, bridged({ HELPER_TEST_GARBAGE_ON: '2' }), 'default'), (e) => e instanceof RunError && /wrote a line that is not the response to request 2: not a response/.test(e.message));
  // The next build of the method that failed starts a fresh helper.
  const m = bridged({ HELPER_TEST_EXIT_ON: '1' });
  await assert.rejects(run(source, m, 'default'), RunError);
});

test('a helper runs in a child process the pool\'s memory readings count, and the helpers stop', { skip }, async () => {
  const source = loadSource(T, { kind: 'shape', name: 'S1', stream: 'synthetic' });
  await run(source, bridged(), 'default');
  const pids = helperPids();
  assert.ok(pids.length > 0);
  const kids = descendantPids(process.pid);
  for (const p of pids) assert.ok(kids.includes(p), `helper ${p} is a descendant`);
  const self = Number(/^VmRSS:\s+(\d+) kB$/m.exec(readFileSync('/proc/self/status', 'utf8'))[1]) * 1024;
  const helper = processMemory(pids[0]);
  assert.ok(helper.rss > 0);
  assert.ok(processMemory(process.pid).rss >= self + helper.rss / 2);
  stopHelpers();
  assert.deepEqual(helperPids(), []);
});

test('a helper\'s build is refused, naming the command, when it is missing or differs from the tree', () => {
  const tool = mkdtempSync(join(tmpdir(), 'bridge-'));
  try {
    assert.match(helperBuild('nope', tool).problem, /there is no helper nope/);
    mkdirSync(join(tool, 'helpers', 'x'), { recursive: true });
    writeFileSync(join(tool, 'helpers', 'x', 'main.go'), 'package main\n');
    const missing = helperBuild('x', tool).problem;
    assert.match(missing, /the x helper is not built/);
    assert.ok(missing.includes(`node ${BUILD_SCRIPT} x`));
    mkdirSync(join(tool, 'build', 'helpers', 'x'), { recursive: true });
    writeFileSync(join(tool, 'build', 'helpers', 'x', 'x-helper'), 'binary');
    const rec = { name: 'x', schema: HELPER_SCHEMA, sourceHash: helperSourceHash('x', tool), executable: 'x-helper', sha256: '0'.repeat(64) };
    writeFileSync(join(tool, 'build', 'helpers', 'x', 'build.json'), JSON.stringify(rec));
    assert.match(helperBuild('x', tool).problem, /differs from the tree \(the executable's SHA-256\)/);
    rec.sha256 = sha256('binary');
    writeFileSync(join(tool, 'build', 'helpers', 'x', 'build.json'), JSON.stringify(rec));
    const ok = helperBuild('x', tool);
    assert.equal(ok.problem, null);
    assert.equal(ok.record.path, join(tool, 'build', 'helpers', 'x', 'x-helper'));
    writeFileSync(join(tool, 'helpers', 'x', 'main.go'), 'package main // changed\n');
    assert.match(helperBuild('x', tool).problem, /the source under helpers\/x/);
  } finally {
    rmSync(tool, { recursive: true, force: true });
  }
});

