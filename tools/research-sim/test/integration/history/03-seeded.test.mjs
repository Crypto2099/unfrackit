// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Seeded wallets as ground truth. Each of the 17 shapes the preprod seeder
// laid out must, as this code reconstructs it, equal the seeder's
// specification up to a one-to-one map of policy ids (the extraction tool's
// T3 rule, test/lib/spec.mjs): at the snapshot, or, for a shape that has
// spent since it was last seeded, just before its first such spend. Two of
// the shapes' own spends are then read as intents: S3's sweep, and S9's
// transfer of the whole wallet to itself in Eternl on 2026-10-23 (preprod
// transaction 67aa81ec03932fa94ff5709a18995079f5b3686f643dadabbf8ce9d54520d729),
// and how each is typed and what it holds is recorded.
//
// Anyone can send a seeded wallet a UTxO. A UTxO whose creating transaction
// spends no input of the funder or of any shape (by stake credential or by
// any address the seeder names) is not the seeding's: it is left out of the
// comparison and reported with its block, coin and asset count. Every other
// difference from the specification still fails the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { context, record, shapeWallets, seederAddresses, specOf, SHAPES, TAG } from './env.mjs';
import { q } from '../../../src/history/db.mjs';
import { loadLife, aliveAt, linesOf } from '../../../src/history/wallet.mjs';
import { walletHistory } from '../../../src/history/history.mjs';
import { recentWindow } from '../../../src/history/windows.mjs';
import { JsonLines, runDir } from '../../../src/history/paths.mjs';
import { parseLine, matchSpec } from '../../lib/spec.mjs';
import { readFileSync } from 'node:fs';

const S9_TRANSFER = '67aa81ec03932fa94ff5709a18995079f5b3686f643dadabbf8ce9d54520d729';

// The wallet's outputs that no transaction of the seeding made: those whose
// creating transaction spends no input of the funder or of a shape. A
// transaction that spends one of the wallet's own outputs is the wallet's
// spend and is never foreign. Returns Map ref -> { blockId, blockNo, coin,
// assets }, the block by db-sync's id and by its number.
async function foreignOutputs(ctx, life, ours) {
  const own = new Set(life.filter((r) => r.consumedTx !== null).map((r) => r.consumedTx));
  const ids = [...new Set(life.map((r) => r.createdTx))].filter((t) => !own.has(t)).sort((a, b) => a - b);
  const foreignTx = new Set();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const ins = await q(ctx.client, ctx.blocks, 'tx_consumed', { ids: { type: 'intarr', value: part } });
    const byTx = new Map(part.map((t) => [t, []]));
    for (const c of ins) byTx.get(Number(c.tx_in_id)).push({ h: c.src_hash, i: Number(c.src_index) });
    const refs = [...byTx.values()].flat();
    const src = new Map();
    for (let j = 0; j < refs.length; j += 1000) {
      const got = await q(ctx.client, ctx.blocks, 'resolve_outputs', { hashes: { type: 'bytearr', value: refs.slice(j, j + 1000).map((x) => x.h) }, indexes: { type: 'int4arr', value: refs.slice(j, j + 1000).map((x) => x.i) } });
      for (const o of got) src.set(`${o.tx_hash}#${Number(o.index)}`, o);
    }
    for (const [t, list] of byTx) {
      const seeded = list.some((x) => {
        const o = src.get(`${x.h}#${x.i}`);
        if (!o) throw new Error(`transaction id ${t}: input ${x.h}#${x.i} does not resolve`);
        return (o.stake_address_id !== null && ours.saIds.has(Number(o.stake_address_id))) || ours.addresses.has(o.address);
      });
      if (!seeded) foreignTx.add(t);
    }
  }
  const out = new Map();
  if (!foreignTx.size) return out;
  const blocks = new Map((await q(ctx.client, ctx.blocks, 'txs', { ids: { type: 'intarr', value: [...foreignTx] } })).map((r) => [Number(r.id), { blockId: Number(r.block_id), blockNo: Number(r.block_no) }]));
  for (const r of life) if (foreignTx.has(r.createdTx)) out.set(r.ref, { ...blocks.get(r.createdTx), coin: r.coin.toString(), assets: r.assets.length });
  return out;
}

test('seeded shapes equal their specification, and their own spends as intents', { timeout: 3600 * 1000 }, async () => {
  const ctx = await context();
  const out = { shapes: {}, spends: {} };
  try {
    const sa = await shapeWallets(ctx);
    const ours = { saIds: new Set(Object.values(sa).filter((x) => x !== null)), addresses: new Set([...SHAPES, 'funder'].flatMap((s) => seederAddresses(s))) };
    const win = await recentWindow(ctx, ctx.snapshot);
    for (const s of SHAPES) {
      const life = await loadLife(ctx.client, ctx.blocks, sa[s], ctx.snapshot.tx);
      const spec = (await specOf(s)).utxos;
      const foreign = await foreignOutputs(ctx, life, ours);
      const alive = (t) => aliveAt(life, t).filter((r) => !foreign.has(r.ref));
      const at = (t) => linesOf(alive(t)).map(parseLine);
      let m = matchSpec(spec, at(ctx.snapshot.tx));
      let where = 'snapshot';
      let t = ctx.snapshot.tx;
      if (!m.ok) {
        const lastDeposit = Math.max(...life.filter((r) => !foreign.has(r.ref) && !life.some((x) => x.consumedTx === r.createdTx)).map((r) => r.createdTx));
        const spends = [...new Set(life.filter((r) => r.consumedTx !== null && r.consumedTx > lastDeposit).map((r) => r.consumedTx))].sort((a, b) => a - b);
        if (spends.length) {
          t = spends[0] - 1;
          m = matchSpec(spec, at(t));
          where = 'before its first spend after seeding';
        }
      }
      const left = aliveAt(life, t).filter((r) => foreign.has(r.ref)).map((r) => foreign.get(r.ref));
      out.shapes[s] = { ok: m.ok, where, utxos: spec.length, policies: m.policies, problems: m.problems, foreign: left };
      assert.ok(m.ok, `${s}: ${m.problems.join('; ')}`);
    }
    // The shapes' own spends in the recent window.
    for (const s of ['S3', 'S9', 'S5']) {
      const path = join(runDir('preprod', TAG), 'tests', `03-${s}.jsonl`);
      const f = new JsonLines(path);
      await walletHistory(ctx, { saId: sa[s], frame: 'recent', window: win, snapshot: { block: ctx.snapshot.id, tx: ctx.snapshot.tx }, split: null }, f);
      f.close();
      const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      out.spends[s] = lines
        .filter((e) => e.kind === 'intent' || e.kind === 'self-reorganization')
        .map((e) => {
          if (e.kind === 'self-reorganization') {
            return { kind: e.kind, tx: e.tx === S9_TRANSFER ? S9_TRANSFER : 'a seeded wallet\'s own spend', walletInputs: e.observed.walletInputs.length, walletOutputs: e.observed.walletOutputs.length, heldConsumed: e.heldConsumed.length, valueChange: e.valueChange, fee: e.observed.fee, size: e.observed.size };
          }
          const it = e.intent;
          return {
            kind: 'intent',
            type: it.type,
            requested: it.requested.map((r) => ({ wallet: r.wallet, coin: r.coin, assets: r.assets.length, raised: !!r.raised })),
            implicit: { ...it.implicit, mint: it.implicit.mint.length, burn: it.implicit.burn.length },
            fixed: it.fixed ? { inputs: it.fixed.inputs.length, body: Object.keys(it.fixed.body), witnesses: Object.keys(it.fixed.witnesses), redeemers: it.fixed.redeemers.length, auxiliaryData: !!it.fixed.auxiliaryData, scriptFee: it.fixed.scriptFee, fixedBytes: it.fixed.fixedBytes } : null,
            walletInputs: it.observed.walletInputs.length,
            walletOutputs: it.observed.walletOutputs.length,
            burst: it.burst
          };
        });
    }
    record('03-seeded', out);
    const s9 = out.spends.S9.find((x) => x.tx === S9_TRANSFER);
    assert.ok(s9, 'S9\'s Eternl transfer is read as a self-reorganization');
    assert.ok(out.spends.S3.some((x) => x.kind === 'intent' && x.type === 'T8'), 'S3\'s sweep burns, so it is a T8 intent');
  } finally {
    await ctx.client.end();
  }
});
