// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Phase-2-invalid transactions. Each is read as an intent whose only effect
// is the loss of its total collateral: type T6, no requested output, no
// fixed parts, collateral required, the forfeit equal to db-sync's fee for
// the transaction (its total collateral, or its collateral inputs less the
// return). The wallet's body inputs stay in its state: the observed replay of
// the history file, which the reader runs before the file is complete,
// would fail otherwise.
//
// Selection, reproducible, as the extraction tool's T9: the newest two
// phase-2-invalid transactions whose collateral return sits at index 2, the
// newest whose return sits at index 3 or more, and the newest two with no
// return; for each, the first wallet (by stake-credential id) whose output at
// a key payment credential it consumes; a window of the eleven blocks around
// it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { context, record, TAG } from './env.mjs';
import { walletHistory } from '../../../src/history/history.mjs';
import { windowOf } from '../../../src/history/windows.mjs';
import { JsonLines, runDir } from '../../../src/history/paths.mjs';

test('phase-2-invalid transactions forfeit their collateral', { timeout: 6 * 3600 * 1000 }, async () => {
  const ctx = await context();
  const out = [];
  try {
    const pick = (await ctx.client.query(
      `WITH inv AS MATERIALIZED (SELECT t.id, t.block_id, t.fee::text AS fee FROM public.tx t WHERE NOT t.valid_contract AND t.id <= $1),
       r AS (SELECT inv.*, (SELECT min(o.index) FROM public.tx_out o WHERE o.tx_id = inv.id) AS ret_index FROM inv)
       (SELECT * FROM r WHERE ret_index = 2 ORDER BY id DESC LIMIT 2)
       UNION ALL (SELECT * FROM r WHERE ret_index >= 3 ORDER BY id DESC LIMIT 1)
       UNION ALL (SELECT * FROM r WHERE ret_index IS NULL ORDER BY id DESC LIMIT 2)`,
      [ctx.snapshot.tx]
    )).rows;
    assert.equal(pick.length, 5);
    for (const p of pick) {
      const w = (await ctx.client.query(
        `SELECT min(o.stake_address_id) AS sa FROM public.tx_in i
           JOIN public.tx_out o ON o.tx_id = i.tx_out_id AND o.index = i.tx_out_index
           JOIN public.stake_address s ON s.id = o.stake_address_id AND s.script_hash IS NULL
          WHERE i.tx_in_id = $1 AND NOT o.address_has_script`, [p.id])).rows[0].sa;
      if (w === null) {
        out.push({ returnIndex: p.ret_index, wallet: null, note: 'no wallet: no collateral input at a key payment credential with a stake credential' });
        continue;
      }
      const win = await windowOf(ctx, Number(p.block_id) - 5, Number(p.block_id) + 5);
      const path = join(runDir('preprod', TAG), 'tests', `06-${p.id}.jsonl`);
      const f = new JsonLines(path);
      await walletHistory(ctx, { saId: Number(w), frame: `blocks:${Number(p.block_id) - 5}-${Number(p.block_id) + 5}`, window: win, snapshot: { block: ctx.snapshot.id, tx: ctx.snapshot.tx }, split: null }, f);
      f.close();
      const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const ev = lines.find((e) => e.kind === 'intent' && e.txId === Number(p.id));
      assert.ok(ev, `the invalid transaction is an intent of wallet ${w}`);
      const it = ev.intent;
      assert.equal(it.type, 'T6');
      assert.deepEqual(it.requested, []);
      assert.equal(it.fixed, null);
      assert.equal(it.collateral.required, true);
      assert.equal(it.invalid.forfeit, p.fee);
      out.push({
        returnIndex: p.ret_index === null ? null : Number(p.ret_index),
        type: it.type,
        forfeit: it.invalid.forfeit,
        collateralInputs: it.collateral.observed.inputs.length,
        totalCollateralField: it.collateral.observed.total !== null,
        returnToWallet: it.observed.walletOutputs.length,
        walletCollateralInputs: it.observed.walletInputs.length
      });
    }
    record('06-invalid', out);
  } finally {
    await ctx.client.end();
  }
});
