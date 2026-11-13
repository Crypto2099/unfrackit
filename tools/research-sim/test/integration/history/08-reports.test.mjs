// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The census, near-cap and collateral commands on preprod, each with its
// plain EXPLAIN plan and its run time. The census and near-cap run over the
// seeded wallets and the wallets of RESEARCH_SIM_REPORT_WALLETS (a file of
// stake-credential ids, one per line), since the extraction's frames are not
// readable through a read-only role; the collateral measurement runs over
// the whole chain for the last RESEARCH_SIM_COLLATERAL_DAYS days (default 30)
// before the snapshot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { context, record, shapeWallets, TAG, SNAPSHOT } from './env.mjs';
import { cmdCensus, cmdNearCap, cmdCollateral } from '../../../src/history/reports.mjs';
import { runDir, writePrivate } from '../../../src/history/paths.mjs';

const opts = (extra) => ({
  expectNetwork: 'preprod',
  snapshot: SNAPSHOT,
  treatment: process.env.RESEARCH_SIM_TREATMENT_DIR,
  treatmentPins: process.env.RESEARCH_SIM_TREATMENT_PINS,
  runId: `${TAG}-reports`,
  ...extra
});

test('census, near-cap and collateral on preprod, with plans and run times', { timeout: 12 * 3600 * 1000 }, async () => {
  const ctx = await context();
  let ids;
  try {
    const shapes = await shapeWallets(ctx);
    ids = [...new Set([...Object.values(shapes), ...(process.env.RESEARCH_SIM_REPORT_WALLETS ? readFileSync(process.env.RESEARCH_SIM_REPORT_WALLETS, 'utf8').trim().split('\n').map(Number) : [])])];
  } finally {
    await ctx.client.end();
  }
  const file = join(runDir('preprod', `${TAG}-reports`), 'wallets.txt');
  writePrivate(file, ids.join('\n') + '\n');
  const census = await cmdCensus(opts({ wallets: file, explain: true }));
  const nearCap = await cmdNearCap(opts({ wallets: file }));
  const collateral = await cmdCollateral(opts({ explain: true, days: Number(process.env.RESEARCH_SIM_COLLATERAL_DAYS || 30) }));
  record('08-reports', {
    census: { wallets: census.wallets, utxos: census.utxos, seconds: census.seconds, sqlSeconds: census.sqlSeconds, plan: census.plan },
    nearCap: { wallets: nearCap.wallets, boundaries: nearCap.points.length, seconds: nearCap.seconds },
    collateral: { seconds: collateral.seconds, statementSeconds: collateral.statementSeconds, result: collateral.result, practiceRuleConfirmatory: collateral.practiceRuleConfirmatory, plans: collateral.plans }
  });
  assert.equal(census.wallets, ids.length);
  assert.ok(collateral.result.measured > 0);
});
