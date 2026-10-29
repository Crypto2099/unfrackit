// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The mainnet gate (src/history/db.mjs), with the query layer stubbed: a
// client whose query() answers db-sync's meta and the gate's three reads
// (sql/gate.sql) from a constructed run record, and refuses any other
// statement, so a test fails if the gate reads anything else. Then the run a
// grant fixes and the options that would name another
// (src/history/commands.mjs runOf), and EXPLAIN ANALYZE on mainnet.
// Synthetic run ids and block values only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkConnection, mainnetGate, Refusal, runMark, explainAnalyze } from '../../../src/history/db.mjs';
import { loadAll } from '../../../src/history/sqlfile.mjs';
import { runOf } from '../../../src/history/commands.mjs';

const blocks = loadAll();
const HASH = 'ab'.repeat(32);
const TABLES = ['frame', 'sample', 'franken', 'txo', 'txo_asset', 'asset'];
const win = (a) => ({ first_block: a, last_block: a + 10, lo: a * 2, hi: a * 2 + 30, t_start: a * 2 - 1 });

// A finished study run of the final freeze, as the extraction's driver
// records it.
function record(over = {}) {
  return {
    run_id: 'study-1',
    network: 'mainnet',
    mode: 'study',
    freeze: { role: 'final-freeze', tx: 'cd'.repeat(32), block_no: 90 },
    snapshot: { id: 120, block_no: 100, slot_no: 5000, epoch_no: 7, time: '2026-11-20 00:00:00', hash: HASH, t: 900, chosen: 'rule', rule: {} },
    windows: { recent: win(50), peak: win(20) },
    finished: { at: '2026-11-21T00:00:00.000Z' },
    ...over
  };
}

// A client for one database: meta's network, whether the run records are
// readable, the final-freeze runs and the table marks.
function fakeClient({ network = 'mainnet', readable = true, runs = [record()], marks = null } = {}) {
  const seen = [];
  const others = [];
  const client = {
    seen,
    others,
    async query(sql) {
      const s = String(sql);
      if (s.startsWith('SET ')) return { rows: [] };
      if (s.includes('FROM public.meta')) return { rows: [{ network_name: network, version: '13.7.3.0' }] };
      if (s.includes('AS readable')) {
        seen.push('readable');
        return { rows: [{ readable }] };
      }
      if (s.includes("'final-freeze'")) {
        seen.push('runs');
        return { rows: runs };
      }
      if (s.includes('obj_description')) {
        seen.push('marks');
        return { rows: marks || TABLES.map((name) => ({ name, mark: runMark(runs[0] ? runs[0].run_id : 'none') })) };
      }
      others.push(s);
      throw new Error('the gate read something else');
    }
  };
  return client;
}

const refusedWith = async (c, re) => {
  await assert.rejects(checkConnection(c, blocks), (e) => e instanceof Refusal && re.test(e.message));
  assert.equal(c.others.length, 0);
};

test('a test network is read without the gate', async () => {
  const c = fakeClient({ network: 'preprod', readable: false, runs: [] });
  await checkConnection(c, blocks, { expectNetwork: 'preprod' });
  assert.equal(c.network, 'preprod');
  assert.equal(c.gate, null);
  assert.deepEqual(c.seen, []);
});

test('mainnet with no finished study run of the final freeze is refused before any other query', async () => {
  await refusedWith(fakeClient({ readable: false }), /cannot read the extraction's run records/);
  await refusedWith(fakeClient({ runs: [] }), /no run of the final freeze is recorded/);
  await refusedWith(fakeClient({ runs: [record({ finished: null })] }), /run study-1 has not finished/);
  await refusedWith(fakeClient({ runs: [record(), record({ run_id: 'study-2' })] }), /2 runs of the final freeze/);
  await refusedWith(fakeClient({ runs: [record({ mode: 'live-fire' })] }), /a live-fire run, not a study run/);
  await refusedWith(fakeClient({ runs: [record({ mode: null })] }), /without a mode/);
  await refusedWith(fakeClient({ runs: [record({ network: 'preprod' })] }), /recorded for preprod/);
  await refusedWith(fakeClient({ runs: [record({ snapshot: { ...record().snapshot, chosen: 'tip' } })] }), /no snapshot block fixed by rule/);
  await refusedWith(fakeClient({ runs: [record({ snapshot: null })] }), /no snapshot block fixed by rule/);
  await refusedWith(fakeClient({ runs: [record({ windows: { recent: win(50) } })] }), /records no windows/);
  const marks = TABLES.map((name) => ({ name, mark: name === 'sample' ? runMark('live-3') : runMark('study-1') }));
  await refusedWith(fakeClient({ marks }), /the study tables sample are not marked as built by run study-1/);
  await refusedWith(fakeClient({ marks: TABLES.filter((t) => t !== 'txo').map((name) => ({ name, mark: runMark('study-1') })) }), /txo are not marked/);
  // An expected network other than mainnet refuses before the gate reads.
  const c = fakeClient();
  await assert.rejects(checkConnection(c, blocks, { expectNetwork: 'preprod' }), /the database is mainnet, not preprod/);
  assert.deepEqual(c.seen, []);
});

test('mainnet after the study run of the final freeze has finished: the grant is its snapshot and windows', async () => {
  const c = fakeClient();
  await checkConnection(c, blocks, { expectNetwork: 'mainnet' });
  assert.deepEqual(c.seen, ['readable', 'runs', 'marks']);
  assert.equal(c.network, 'mainnet');
  assert.deepEqual(c.gate, {
    path: 'final-freeze',
    run: {
      network: 'mainnet',
      runId: 'study-1',
      snapshot: { id: 120, hash: HASH, tx: 900 },
      windows: { recent: { firstBlock: 50, lastBlock: 60, lo: 100, hi: 130, tStart: 99 }, peak: { firstBlock: 20, lastBlock: 30, lo: 40, hi: 70, tStart: 39 } }
    }
  });
});

test('mainnet on any other path is refused', async () => {
  await assert.rejects(checkConnection(fakeClient(), blocks, { gate: 'live-fire' }), (e) => e instanceof Refusal && /there is no mainnet path live-fire/.test(e.message));
  await assert.rejects(mainnetGate(async () => [], 'pre-freeze'), /no mainnet path pre-freeze/);
});

test('a grant fixes the run: --snapshot and --extraction-run may only name it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'research-sim-gate-'));
  try {
    const grant = { path: 'final-freeze', run: { network: 'mainnet', runId: 'study-1', snapshot: { id: 120, hash: HASH, tx: 900 }, windows: {} } };
    assert.equal(runOf(grant, {}), grant.run);
    assert.equal(runOf(grant, { snapshot: '120' }), grant.run);
    assert.equal(runOf(grant, { snapshot: HASH.toUpperCase() }), grant.run);
    assert.throws(() => runOf(grant, { snapshot: 'tip' }), (e) => e instanceof Refusal && /give no --snapshot/.test(e.message));
    assert.throws(() => runOf(grant, { snapshot: '121' }), /give no --snapshot/);
    const params = (runId, hash) => {
      const p = join(dir, `${runId}.json`);
      writeFileSync(p, JSON.stringify({ network: 'mainnet', run_id: runId, snapshot: { id: 120, hash, t: 900 }, windows: { recent: win(50), peak: win(20) } }));
      return p;
    };
    assert.equal(runOf(grant, { extractionRun: params('study-1', HASH) }), grant.run);
    assert.throws(() => runOf(grant, { extractionRun: params('live-3', HASH) }), /names another run/);
    assert.throws(() => runOf(grant, { extractionRun: params('study-1', 'ef'.repeat(32)) }), /names another run/);
    // Without a grant (a test network): the file's run, or none.
    assert.equal(runOf(null, {}), null);
    assert.equal(runOf(null, { extractionRun: params('test-1', HASH) }).runId, 'test-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('EXPLAIN ANALYZE stays refused on mainnet', async () => {
  const c = fakeClient();
  await checkConnection(c, blocks);
  await assert.rejects(explainAnalyze(c, blocks, 'tip_block'), /EXPLAIN ANALYZE on mainnet/);
});
