// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Which wallets a command may read under a scope (src/history/commands.mjs
// allowedWallets, historyWallets, resolveWallets; src/history/reports.mjs
// walletSet), with the query layer stubbed: a client that answers the study
// tables, the stake-address lookups and the wallet sets from constructed
// rows, and records each query, so a test sees that a refusal comes before any
// wallet row is read. After the final freeze, every wallet a command reads on
// mainnet is in the gate's run's sample (study.sample), the census's
// recent-frame population aside; in a live-fire run, on any network, only the
// pick's wallets, with no study table read. Synthetic ids and addresses only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAll } from '../../../src/history/sqlfile.mjs';
import { Refusal } from '../../../src/history/db.mjs';
import { historyWallets, allowedWallets, scopeOf } from '../../../src/history/commands.mjs';
import { walletSet } from '../../../src/history/reports.mjs';
import { stakeAddress } from '../../lib/live-fire.mjs';

const blocks = loadAll();
const FINAL = { path: 'final-freeze', run: { network: 'mainnet', runId: 'study-1' } };
// The sample: 1 and 2 exploration, 3 confirmation. 7 and 8 are in the
// recent frame, outside the sample. Stake addresses map to ids by k.
const SAMPLE = [
  { sa_id: 1, random: true, random_recent: true, random_peak: false, split: 'exploration', excluded: false },
  { sa_id: 2, random: true, random_recent: false, random_peak: true, split: 'exploration', excluded: false },
  { sa_id: 3, random: true, random_recent: true, random_peak: false, split: 'confirmation', excluded: false }
];
const VIEWS = new Map([1, 2, 3, 7, 8, 9].map((k) => [stakeAddress('mainnet', k), k]));

function fakeCtx(scope, { readable = true } = {}) {
  const seen = [];
  const client = {
    async query(sql) {
      const s = String(sql);
      const hit = (name, rows) => {
        seen.push(name);
        return { rows };
      };
      if (s.includes('AS has_frame')) return hit('study_readable', [{ usage: readable, has_frame: readable }]);
      if (s.includes('bool_or(s.kind')) return hit('study_samples', SAMPLE);
      if (s.includes('WHERE sa.view')) {
        const m = /sa\.view = '([^']+)'/.exec(s);
        const id = m && VIEWS.get(m[1]);
        return hit('wallet_by_view', id ? [{ id: String(id), is_script: false }] : []);
      }
      if (s.includes('WHERE sa.id = ANY')) {
        const ids = [...s.matchAll(/\d+/g)].map((x) => Number(x[0]));
        return hit('wallets_by_id', ids.map((id) => ({ id: String(id), is_script: false })));
      }
      if (s.includes("f.frame = 'recent' AND f.eligible")) return hit('study_recent_eligible', [1, 2, 3, 7, 8].map((id) => ({ id })));
      if (s.includes("s.kind = 'random'")) return hit('study_random_samples', [1, 2, 3].map((id) => ({ id })));
      if (s.includes('key_wallets_with_outputs') || s.includes('sa.script_hash IS NULL')) return hit('key_wallets', [1, 2, 3, 7, 8, 9].map((id) => ({ id })));
      throw new Error(`unexpected query: ${s.slice(0, 80)}`);
    }
  };
  return { ctx: { client, blocks, scope, snapshot: { tx: 100 } }, seen };
}

const outside = (re = /study sample/) => (e) => e instanceof Refusal && re.test(e.message) && !/\b[789]\b/.test(e.message);

test('after the final freeze, history reads only wallets of the study sample, refused before their rows are read', async () => {
  const a = fakeCtx(FINAL);
  await assert.rejects(historyWallets(a.ctx, { wallet: ['1', '7'] }), outside());
  assert.ok(!a.seen.includes('wallets_by_id'), 'refused before the wallets\' rows are read');
  const b = fakeCtx(FINAL);
  await assert.rejects(historyWallets(b.ctx, { wallet: [stakeAddress('mainnet', 8)] }), outside());
  assert.ok(!b.seen.includes('wallets_by_id'));
  const c = fakeCtx(FINAL);
  const r = await historyWallets(c.ctx, { wallet: ['1', stakeAddress('mainnet', 2)] });
  assert.deepEqual(r.wallets, [1, 2]);
  assert.equal(r.samples.get(2).split, 'exploration');
  // The confirmation split still needs the analysis-freeze transaction.
  await assert.rejects(historyWallets(fakeCtx(FINAL).ctx, { wallet: ['3'] }), /confirmation split/);
  assert.deepEqual((await historyWallets(fakeCtx(FINAL).ctx, { wallet: ['3'], analysisFreezeTx: 'f'.repeat(64) })).wallets, [3]);
  // --from-study reads the sample itself.
  assert.deepEqual((await historyWallets(fakeCtx(FINAL).ctx, { fromStudy: 'all', analysisFreezeTx: 'f'.repeat(64) })).wallets, [1, 2, 3]);
  // A role that cannot read study.sample reads no wallet on mainnet.
  await assert.rejects(historyWallets(fakeCtx(FINAL, { readable: false }).ctx, { wallet: ['1'] }), (e) => e instanceof Refusal && /cannot read study.sample/.test(e.message));
});

test('after the final freeze, census and near-cap: --all-wallets and wallets outside the sample are refused; the census reads its frame', async () => {
  await assert.rejects(walletSet(fakeCtx(FINAL).ctx, { allWallets: true }, 'study_recent_eligible'), outside(/--all-wallets is for a test network/));
  const a = fakeCtx(FINAL);
  await assert.rejects(walletSet(a.ctx, { wallet: ['2', '9'] }, 'study_random_samples'), outside());
  assert.ok(!a.seen.includes('wallets_by_id'));
  assert.deepEqual((await walletSet(fakeCtx(FINAL).ctx, { wallet: ['2'] }, 'study_random_samples')).ids, [2]);
  assert.deepEqual((await walletSet(fakeCtx(FINAL).ctx, { fromStudy: true }, 'study_random_samples')).ids, [1, 2, 3]);
  // The census population is the gate's run's eligible recent frame.
  assert.deepEqual((await walletSet(fakeCtx(FINAL).ctx, { fromStudy: true }, 'study_recent_eligible')).ids, [1, 2, 3, 7, 8]);
});

test('a live-fire run reads only its pick\'s wallets and no study table, on mainnet and on a test network', async () => {
  const pick = { network: 'mainnet', snapshot: { block_no: 4000, hash: 'a1'.repeat(32) }, wallets: [1, 2].map((k) => ({ stake_address: stakeAddress('mainnet', k), conditions: [k], frames: ['recent'] })) };
  const LIVE = { path: 'live-fire', pick };
  const a = fakeCtx(LIVE);
  assert.deepEqual([...(await allowedWallets(a.ctx))], [1, 2]);
  const b = fakeCtx(LIVE);
  const r = await historyWallets(b.ctx, { wallet: pick.wallets.map((w) => w.stake_address) });
  assert.deepEqual(r.wallets, [1, 2]);
  assert.equal(r.samples, null);
  assert.ok(!b.seen.includes('study_samples') && !b.seen.includes('study_readable'), 'no study table is read');
  const c = fakeCtx(LIVE);
  await assert.rejects(historyWallets(c.ctx, { wallet: ['1', '7'] }), outside(/picked/));
  assert.ok(!c.seen.includes('wallets_by_id'));
  await assert.rejects(historyWallets(fakeCtx(LIVE).ctx, { fromStudy: 'all' }), (e) => e instanceof Refusal && /no --from-study/.test(e.message));
  await assert.rejects(walletSet(fakeCtx(LIVE).ctx, { allWallets: true }, 'study_recent_eligible'), /no --all-wallets/);
  await assert.rejects(walletSet(fakeCtx(LIVE).ctx, { fromStudy: true }, 'study_random_samples'), /no --from-study/);
  // On a test network the pick sets the scope; a pick for another network is refused.
  assert.deepEqual(scopeOf({ network: 'mainnet', gate: null }, pick), LIVE);
  assert.throws(() => scopeOf({ network: 'preprod', gate: null }, pick), (e) => e instanceof Refusal && /pick is for mainnet, the database preprod/.test(e.message));
  // The gate's grant, when there is one, is the scope.
  assert.equal(scopeOf({ network: 'mainnet', gate: FINAL }, null), FINAL);
});

test('a test network outside a live-fire run restricts nothing', async () => {
  const a = fakeCtx(null);
  assert.equal(await allowedWallets(a.ctx), null);
  assert.deepEqual((await historyWallets(a.ctx, { wallet: ['7', '9'] })).wallets, [7, 9]);
  assert.deepEqual((await walletSet(fakeCtx(null).ctx, { allWallets: true }, 'study_recent_eligible')).ids, [1, 2, 3, 7, 8, 9]);
});
