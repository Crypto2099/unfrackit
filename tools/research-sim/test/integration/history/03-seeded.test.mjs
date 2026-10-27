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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { context, record, shapeWallets, specOf, SHAPES, TAG } from './env.mjs';
import { loadLife, aliveAt, linesOf } from '../../../src/history/wallet.mjs';
import { walletHistory } from '../../../src/history/history.mjs';
import { recentWindow } from '../../../src/history/windows.mjs';
import { JsonLines, runDir } from '../../../src/history/paths.mjs';
import { parseLine, matchSpec } from '../../lib/spec.mjs';
import { readFileSync } from 'node:fs';

const S9_TRANSFER = '67aa81ec03932fa94ff5709a18995079f5b3686f643dadabbf8ce9d54520d729';

test('seeded shapes equal their specification, and their own spends as intents', { timeout: 3600 * 1000 }, async () => {
  const ctx = await context();
  const out = { shapes: {}, spends: {} };
  try {
    const sa = await shapeWallets(ctx);
    const win = await recentWindow(ctx, ctx.snapshot);
    for (const s of SHAPES) {
      const life = await loadLife(ctx.client, ctx.blocks, sa[s], ctx.snapshot.tx);
      const spec = (await specOf(s)).utxos;
      const at = (t) => linesOf(aliveAt(life, t)).map(parseLine);
      let m = matchSpec(spec, at(ctx.snapshot.tx));
      let where = 'snapshot';
      if (!m.ok) {
        const lastDeposit = Math.max(...life.filter((r) => !life.some((x) => x.consumedTx === r.createdTx)).map((r) => r.createdTx));
        const spends = [...new Set(life.filter((r) => r.consumedTx !== null && r.consumedTx > lastDeposit).map((r) => r.consumedTx))].sort((a, b) => a - b);
        if (spends.length) {
          m = matchSpec(spec, at(spends[0] - 1));
          where = 'before its first spend after seeding';
        }
      }
      out.shapes[s] = { ok: m.ok, where, utxos: spec.length, policies: m.policies, problems: m.problems };
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
