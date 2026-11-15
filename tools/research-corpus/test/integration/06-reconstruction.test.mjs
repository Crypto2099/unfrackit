// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// T6. Reconstruction at block boundaries: for each history transaction at
// block B, the state at the block before B and at B. S3: empty before its
// first seeding, the specification after it, unchanged until the sweep's
// block, empty at it, the specification again (new transaction hashes) after
// the second seeding. M2: cumulative output counts per block across its 25
// transactions, equal to the specification at the last.
// T7. The implementations agree on every case of T6 (reference query and life
// table at every block; with the direct read at the snapshot, where it is
// defined), and with the aggregated output of `cardano-db-tool utxo-set
// --slot-no <slot>` for the shape addresses at three of those slots.

import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { db, blocks, record, resultsDir, RUN_B, SHAPES, seederAddress, specOf, stakeOf, saIdOf } from './env.mjs';
import { q } from '../../src/db.mjs';
import { ensureDir } from '../../src/paths.mjs';
import { digests } from '../../src/reconstruction-check.mjs';
import { parseLine, matchSpec } from '../lib/spec.mjs';
import { history } from '../lib/history.mjs';

const tOf = async (c, b) => Number((await q(c, blocks, 't_of_block', { block_id: { type: 'int', value: b } }))[0].t);
const prevOf = async (c, b) => Number((await q(c, blocks, 'prev_block', { block_id: { type: 'int', value: b } }))[0].b);
const linesAt = async (c, sa, t) => (await q(c, blocks, 'lines_life', { sa_id: { type: 'int', value: sa }, t: { type: 'int', value: t } })).map((r) => r.line);

// Filled by the first test for the second.
const picks = [];
const shapes = {};

test('T6 and T7 reconstruction at block boundaries; the three implementations', { timeout: 3 * 3600 * 1000 }, async () => {
  const c = await db();
  const out = { cases: [] };
  try {
    const params = (await c.query(`SELECT value FROM study.param WHERE run_id = $1 AND key = 'settings'`, [RUN_B])).rows[0].value;
    const x1 = { x1_enterprise: { type: 'bool', value: params.x1_enterprise } };
    const snap = (await c.query(`SELECT value FROM study.param WHERE run_id = $1 AND key = 'snapshot'`, [RUN_B])).rows[0].value;
    const sa = {};
    const addr = {};
    for (const s of SHAPES) {
      addr[s] = seederAddress(s)[0];
      sa[s] = await saIdOf(c, stakeOf(addr[s]));
    }
    const ids = SHAPES.map((s) => sa[s]);
    const compare = async (label, blockId) => {
      const t = await tOf(c, blockId);
      const ref = await digests(c, blocks, 'digest_ref', ids, { ...x1, block_id: { type: 'int', value: blockId } });
      const life = await digests(c, blocks, 'digest_life', ids, { ...x1, t: { type: 'int', value: t } });
      const row = { label, block_id: blockId, t };
      for (const s of SHAPES) {
        const r = ref.get(String(sa[s]));
        const l = life.get(String(sa[s]));
        assert.deepEqual(r, l, `${label} ${s}: reference query and life table`);
        row[s] = l.n;
      }
      out.cases.push(row);
      return row;
    };

    // S1
    const h1 = await history(c, sa.S1);
    const b1 = h1[0].block_id;
    assert.equal((await compare('S1 before seeding', await prevOf(c, b1))).S1, 0);
    assert.equal((await compare('S1 at seeding', b1)).S1, 3);
    assert.ok(matchSpec((await specOf('S1')).utxos, (await linesAt(c, sa.S1, await tOf(c, b1))).map(parseLine)).ok);

    // S3
    const h3 = await history(c, sa.S3);
    const [first, sweep, second] = h3;
    const spec3 = (await specOf('S3')).utxos;
    assert.equal((await compare('S3 before first seeding', await prevOf(c, first.block_id))).S3, 0);
    assert.equal((await compare('S3 at first seeding', first.block_id)).S3, 95);
    const afterFirst = await linesAt(c, sa.S3, await tOf(c, first.block_id));
    assert.ok(matchSpec(spec3, afterFirst.map(parseLine)).ok, 'S3 after the first seeding is the specification');
    const beforeSweep = await prevOf(c, sweep.block_id);
    assert.equal((await compare('S3 before sweep', beforeSweep)).S3, 95);
    assert.deepEqual(await linesAt(c, sa.S3, await tOf(c, beforeSweep)), afterFirst, 'unchanged until the sweep block');
    assert.equal((await compare('S3 at sweep', sweep.block_id)).S3, 0);
    assert.equal((await compare('S3 before second seeding', await prevOf(c, second.block_id))).S3, 0);
    assert.equal((await compare('S3 at second seeding', second.block_id)).S3, 95);
    const afterSecond = await linesAt(c, sa.S3, await tOf(c, second.block_id));
    assert.ok(matchSpec(spec3, afterSecond.map(parseLine)).ok, 'S3 after the second seeding is the specification');
    const hashes = (ls) => new Set(ls.map((l) => l.split('#')[0]));
    assert.equal([...hashes(afterSecond)].filter((x) => hashes(afterFirst).has(x)).length, 0, 'new transaction hashes');

    // M2, block by block
    const h2 = await history(c, sa.M2);
    const byBlock = new Map();
    for (const t of h2) byBlock.set(t.block_id, (byBlock.get(t.block_id) || 0) + t.n_created);
    let cum = 0;
    const m2Blocks = [...byBlock.keys()].sort((x, y) => x - y);
    assert.equal((await compare('M2 before first seeding', await prevOf(c, m2Blocks[0]))).M2, 0);
    for (const b of m2Blocks) {
      const before = await compare(`M2 before block ${b}`, await prevOf(c, b));
      assert.equal(before.M2, cum);
      cum += byBlock.get(b);
      assert.equal((await compare(`M2 at block ${b}`, b)).M2, cum);
    }
    assert.equal(cum, 3005);
    assert.ok(matchSpec((await specOf('M2')).utxos, (await linesAt(c, sa.M2, await tOf(c, m2Blocks[m2Blocks.length - 1]))).map(parseLine)).ok);

    // The three implementations at the snapshot, where the direct read is defined.
    const tip = (await q(c, blocks, 'tip_block'))[0];
    assert.equal(Number(tip.id), snap.id, 'the database tip is the snapshot (db-sync stopped)');
    const ref = await digests(c, blocks, 'digest_ref', ids, { ...x1, block_id: { type: 'int', value: snap.id } });
    const life = await digests(c, blocks, 'digest_life', ids, { ...x1, t: { type: 'int', value: snap.t } });
    const direct = await digests(c, blocks, 'digest_direct', ids, x1);
    for (const s of SHAPES) {
      assert.deepEqual(ref.get(String(sa[s])), life.get(String(sa[s])));
      assert.deepEqual(direct.get(String(sa[s])), life.get(String(sa[s])));
    }
    out.snapshot = Object.fromEntries(SHAPES.map((s) => [s, life.get(String(sa[s]))]));

    // The three slots T7 compares with cardano-db-tool: S3's first seeding, the sweep, M2's last seeding.
    picks.push(
      ['S3 first seeding', first.block_id, first.slot_no],
      ['S3 sweep', sweep.block_id, sweep.slot_no],
      ['M2 last seeding', m2Blocks[m2Blocks.length - 1], h2[h2.length - 1].slot_no]
    );
    shapes.sa = sa;
    shapes.addr = addr;
    record('T6-T7', out);
  } finally {
    await c.end();
  }
});

// cardano-db-tool utxo-set at three slots, per-address lovelace totals for the
// shape addresses against the life table at T(B). The tool runs from the
// pinned db-sync image as the study role. If the tool itself fails, the
// comparison is reported as not run, with the tool's error.
test('T7 cardano-db-tool utxo-set agrees with the life table at three slots', { timeout: 3 * 3600 * 1000 }, async (t) => {
  assert.equal(picks.length, 3, 'the T6 test ran first');
  const image = process.env.RESEARCH_CORPUS_DBTOOL_IMAGE;
  if (!image) throw new Error('set RESEARCH_CORPUS_DBTOOL_IMAGE to the pinned db-sync image');
  const dir = ensureDir(join(resultsDir(), 'dbtool'));
  const c = await db();
  const out = [];
  try {
    for (const [label, blockId, slot] of picks) {
      const file = join(dir, `utxo-accept-${slot}.json`);
      if (!existsSync(file)) {
        const t0 = performance.now();
        try {
          const log = execFileSync('docker', ['run', '--rm', '--network', 'host', '--user', '1000:1000', '--memory', '10g', '-e', 'PGPASSFILE=/pgpass',
            '-v', `${process.env.PGPASSFILE}:/pgpass:ro`, '-v', `${dir}:/out`, '-w', '/out', '--entrypoint', 'cardano-db-tool', image,
            'utxo-set', '--slot-no', String(slot)], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });
          out.push({ label, slot, seconds: (performance.now() - t0) / 1000, summary: log.split('\n').filter((l) => /Utxo entries|supply|Supply/.test(l)).map((l) => l.trim()) });
        } catch (e) {
          const err = String(e.stderr || e.message).trim().slice(0, 600);
          out.push({ label, slot, seconds: (performance.now() - t0) / 1000, tool_failed: true, error: err });
          record('T7-dbtool', { image, not_run: true, reason: 'cardano-db-tool utxo-set failed', runs: out });
          t.skip(`cardano-db-tool utxo-set failed at slot ${slot}: ${err.slice(0, 200)}`);
          return;
        }
      }
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      const totals = new Map(doc.fund.map((f) => [f.address, BigInt(f.value)]));
      const tb = await tOf(c, blockId);
      const row = { label, slot, block_id: blockId };
      for (const s of SHAPES) {
        const lines = await linesAt(c, shapes.sa[s], tb);
        const life = lines.reduce((x, l) => x + parseLine(l).coin, 0n);
        const tool = totals.get(shapes.addr[s]) || 0n;
        assert.equal(tool, life, `${label} ${s}: cardano-db-tool total equals the life table`);
        row[s] = { lovelace: life.toString(), utxos: lines.length };
      }
      out.push(row);
    }
    record('T7-dbtool', { image, runs: out });
  } finally {
    await c.end();
  }
});
