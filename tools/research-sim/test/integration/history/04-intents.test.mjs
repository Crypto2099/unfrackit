// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Intents of real wallets with long histories: every spend in a window of
// the last RESEARCH_SIM_TEST_WINDOW_DAYS days (default 60) before the
// snapshot, of the seeder's funder and of at least 200 further preprod wallets
// becomes an intent or a self-reorganization, and every one passes the
// reader's own checks before it is written (intent.mjs and rebuild.mjs):
// db-sync's consumed inputs and outputs are the transaction's; the implicit
// values agree with db-sync's; coin and every asset are conserved with them;
// and the transaction rebuilt from the intent's parts and the observed
// wallet inputs, change and witnesses, each part's original bytes, has
// exactly the transaction's body hash and size. The observed replay of each
// file reaches the wallet's UTxO set at the window's end. Every spend type
// must occur; a few intents of each type are written out for reading by hand.
// Each file is then read back by the simulator's reader, and every UTxO
// record's creating transaction id is checked against db-sync's. Counted from
// the files: the wallets whose start state holds no UTxO the change-address
// rule can name (the rule over the start state alone), those the rule over
// every output received still refuses, by reason, and how often the change
// address moves within the window; and the self-reorganizations that carry a
// reward withdrawal, which the replay deposits, with those that also bring
// other value in.
//
// Selection, reproducible: key stake credentials ranked by the number of
// transactions among the last 100,000 before the snapshot that consume one of
// their outputs at a key payment credential, ties by id; of those with 5 to
// 50 such transactions and at most 3,000 outputs over their whole history
// (which leaves out the bots and services whose histories run to hundreds of
// thousands of outputs, as the study's frames leave out wallets of more than
// 20,000 UTxOs), the first 200. A bounded count that does not finish within
// 60 seconds counts as over the cap, and the number skipped is recorded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { context, record, shapeWallets, TAG } from './env.mjs';
import { walletHistory } from '../../../src/history/history.mjs';
import { windowOf } from '../../../src/history/windows.mjs';
import { JsonLines, runDir, writeJson } from '../../../src/history/paths.mjs';
import { readHistory, startChangeAddress } from '../../../src/state/history.mjs';
import { changeAddressGap } from '../../../src/state/state.mjs';
import { q } from '../../../src/history/db.mjs';

const N = Number(process.env.RESEARCH_SIM_TEST_WALLETS || 200);
const DAYS = Number(process.env.RESEARCH_SIM_TEST_WINDOW_DAYS || 60);
const TYPES = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'];

test(`every spend of the funder and ${N} preprod wallets is an intent that rebuilds its transaction`, { timeout: 24 * 3600 * 1000 }, async () => {
  const ctx = await context();
  const out = { wallets: 0, intents: 0, selfReorganizations: 0, withdrawals: { selfReorganizations: 0, withOtherValue: 0, lovelace: 0n }, types: {}, raised: 0, phase2Invalid: 0, fixedNull: 0, withRedeemers: 0, perWallet: [], created: { records: 0, differ: 0 }, changeAddress: { startStateNone: 0, beforeWindowNone: 0, refused: 0, reasons: {}, moves: 0, walletsMoving: 0 } };
  // Bursts on real histories: their count by kind, the chained bursts with
  // two spends in one block, and every pair of consecutive spends 59 to 61
  // seconds apart with whether they share a burst.
  const bursts = { total: 0, chained: 0, parallel: 0, chainedSameBlock: 0, nearGap: [] };
  const examples = {};
  try {
    const sa = await shapeWallets(ctx);
    const ranked = (await ctx.client.query(
      `SELECT o.stake_address_id AS id, count(DISTINCT i.tx_in_id) AS n
         FROM public.tx_in i
         JOIN public.tx_out o ON o.tx_id = i.tx_out_id AND o.index = i.tx_out_index
         JOIN public.stake_address s ON s.id = o.stake_address_id AND s.script_hash IS NULL
        WHERE i.tx_in_id > $1 - 100000 AND i.tx_in_id <= $1 AND NOT o.address_has_script
        GROUP BY 1 ORDER BY 2 DESC, 1`, [ctx.snapshot.tx])).rows;
    const chosen = [];
    let overCap = 0;
    await ctx.client.query("SET statement_timeout = '60s'");
    for (const r of ranked) {
      if (chosen.length >= N) break;
      if (Number(r.n) < 5 || Number(r.n) > 50) continue;
      let n;
      try {
        n = Number((await ctx.client.query('SELECT count(*) AS n FROM (SELECT 1 FROM public.tx_out WHERE stake_address_id = $1 LIMIT 3001) x', [Number(r.id)])).rows[0].n);
      } catch {
        n = Infinity;
      }
      if (n > 3000) overCap++;
      else chosen.push(Number(r.id));
    }
    await ctx.client.query('SET statement_timeout = 0');
    out.selection = { ranked: ranked.length, chosen: chosen.length, overCap };
    const wallets = [sa.funder, ...chosen.filter((x) => x !== sa.funder)];
    const first = Number((await ctx.client.query(
      `SELECT b.id FROM public.block b WHERE b.time >= (SELECT s.time FROM public.block s WHERE s.id = $1) - make_interval(days => $2) ORDER BY b.time, b.id LIMIT 1`,
      [ctx.snapshot.id, DAYS])).rows[0].id);
    const win = await windowOf(ctx, first, ctx.snapshot.id);
    out.window = { days: DAYS, firstBlock: first, lastBlock: ctx.snapshot.id, lo: win.lo, hi: win.hi };
    const dir = join(runDir('preprod', TAG), 'tests', '04-histories');
    for (const w of wallets) {
      const path = join(dir, `${w}.recent.jsonl`);
      const f = new JsonLines(path);
      const t0 = performance.now();
      const r = await walletHistory(ctx, { saId: w, frame: `last-${DAYS}-days`, window: win, snapshot: { block: ctx.snapshot.id, tx: ctx.snapshot.tx }, split: null }, f);
      f.close();
      const seconds = (performance.now() - t0) / 1000;
      out.wallets++;
      out.perWallet.push({ wallet: w === sa.funder ? 'funder' : 'random', spends: r.spends, seconds, utxosEnd: r.utxosEnd });
      const spendsSeen = [];
      for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
        const e = JSON.parse(line);
        if (e.kind === 'intent' || e.kind === 'self-reorganization') spendsSeen.push({ time: e.kind === 'intent' ? e.intent.time : e.time, burst: e.kind === 'intent' ? e.intent.burst : e.burst });
        if (e.kind === 'self-reorganization') {
          out.selfReorganizations++;
          if (BigInt(e.withdrawal) > 0n) {
            out.withdrawals.selfReorganizations++;
            out.withdrawals.lovelace += BigInt(e.withdrawal);
            if (BigInt(e.valueChange.coin) !== 0n || e.valueChange.assets.length) out.withdrawals.withOtherValue++;
          }
        }
        if (e.kind !== 'intent') continue;
        const it = e.intent;
        out.intents++;
        out.types[it.type] = (out.types[it.type] || 0) + 1;
        out.raised += it.requested.filter((x) => x.raised).length;
        if (it.invalid) out.phase2Invalid++;
        if (!it.fixed) out.fixedNull++;
        if (it.fixed && it.fixed.redeemers.length) out.withRedeemers++;
        if (!examples[it.type]) examples[it.type] = [];
        if (examples[it.type].length < 4) examples[it.type].push({ wallet: w, intent: it });
      }
      // Read back: every record carries its creating transaction id (the
      // reader refuses one without), equal to db-sync's.
      const h = readHistory(readFileSync(path, 'utf8'));
      const recs = [...h.created];
      for (let i = 0; i < recs.length; i += 1000) {
        const part = recs.slice(i, i + 1000);
        const got = await q(ctx.client, ctx.blocks, 'resolve_outputs', { hashes: { type: 'bytearr', value: part.map(([r]) => r.split('#')[0]) }, indexes: { type: 'int4arr', value: part.map(([r]) => Number(r.split('#')[1])) } });
        const ids = new Map(got.map((o) => [`${o.tx_hash}#${Number(o.index)}`, Number(o.tx_id)]));
        for (const [r, id] of part) if (ids.get(r) !== id) out.created.differ++;
      }
      out.created.records += recs.length;
      const ca = out.changeAddress;
      if (startChangeAddress(h.start, h.created) === null) ca.startStateNone++;
      if (h.changeAddress === null) ca.beforeWindowNone++;
      const gap = changeAddressGap(h);
      if (gap) {
        ca.refused++;
        ca.reasons[gap] = (ca.reasons[gap] || 0) + 1;
      }
      let moves = 0;
      let at = h.changeAddress;
      for (const e of [...h.events, { changeAddress: h.changeAddressEnd }]) {
        if (at !== null && e.changeAddress !== at) moves++;
        at = e.changeAddress;
      }
      ca.moves += moves;
      if (moves) ca.walletsMoving++;
      const byBurst = new Map();
      spendsSeen.forEach((s, i) => {
        if (s.burst) {
          if (!byBurst.has(s.burst.id)) byBurst.set(s.burst.id, []);
          byBurst.get(s.burst.id).push(s);
        }
        if (i > 0) {
          const gap = s.time.blockTime - spendsSeen[i - 1].time.blockTime;
          if (gap >= 59 && gap <= 61) bursts.nearGap.push({ gap, sameBurst: !!(s.burst && spendsSeen[i - 1].burst && s.burst.id === spendsSeen[i - 1].burst.id) });
        }
      });
      for (const ss of byBurst.values()) {
        bursts.total++;
        if (ss[0].burst.parallel) bursts.parallel++;
        else {
          bursts.chained++;
          if (new Set(ss.map((x) => x.time.block)).size < ss.length) bursts.chainedSameBlock++;
        }
      }
    }
    out.bursts = bursts;
    out.seconds = out.perWallet.reduce((s, x) => s + x.seconds, 0);
    out.longest = out.perWallet.reduce((a, b) => (b.spends > a.spends ? b : a), { spends: -1 });
    writeJson(join(runDir('preprod', TAG), 'tests', '04-examples.json'), examples);
    record('04-intents', out);
    for (const t of TYPES) assert.ok(out.types[t] > 0, `no ${t} spend among the wallets`);
    assert.equal(out.created.differ, 0, 'a record\'s creating transaction id differs from db-sync\'s');
  } finally {
    await ctx.client.end();
  }
});
