// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The items section 7.3 reports beside the verdicts, on synthetic studies
// written by test/lib/analysis-fixtures.mjs, each expected number computed by
// hand in the test. Bootstrap resamples are kept small.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStudy } from '../../../src/analysis/read.mjs';
import { runQuestions } from '../../../src/analysis/questions.mjs';
import { runItems, chainSummary, unpricedCounts, timingSummary, restrictRun } from '../../../src/analysis/items.mjs';
import { depositParts, isDepositSubset } from '../../../src/analysis/deposits.mjs';
import { writeStudy, optionsFor, fullJobs, built, failed, RULE } from '../../lib/analysis-fixtures.mjs';

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);
const N = 100;
const LIB = ['csl-lf'];

const mk = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const ok = (fee = 100000, o = {}) => (i) => built(i, { fee, ...o });

function jobs(over = {}) {
  return fullJobs((m, arm, rep) => over[`${m}/${arm}/${rep}`] || over[`${m}/${arm}`] || mk(5, ok()), { reps: 2 });
}
const wal = (id, group, over, extra = {}) => ({ id, group, jobs: jobs(over), ...extra });
const lf = (own, layout, on, off) => ({ 'csl-lf/own': own, 'csl-lf/layout': layout, ...(on ? { [`${RULE}/on`]: on } : {}), ...(off ? { [`${RULE}/off`]: off } : {}) });

function tablesOf(wallets, desc = {}) {
  const root = mkdtempSync(join(tmpdir(), 'analysis-items-'));
  dirs.push(root);
  const w = writeStudy(root, { wallets, ...desc });
  return readStudy(optionsFor(root, w));
}
const cell = (res, name) => res.cells.find((c) => c.name === name && c.scope.kind === 'main');
const byItem = (res, item, outcome, of) => res.cells.find((c) => c.item === item && c.outcome === outcome && (of === undefined || c.of === of) && c.scope.kind === 'main');
const run1 = async (wallets, desc, extra = {}) => {
  const { wallets: tables } = await tablesOf(wallets, desc);
  return { tables, res: await runItems(tables, { resamples: N, libraries: LIB, ...extra }) };
};

test('rule against L/own, question 2 with absorption off and the absorption contrast, by hand', async () => {
  // csl-lf. Own: 10 built at 100000. Layout: intent 0 fails (10 per 100), 9 built at 110000.
  // On: intents 8 and 9 fail (20 per 100), 8 built at 150000. Off: intent 9 fails (10 per 100), 9 built at 120000.
  // Rule against own: failures 20 - 0 = 20; fees built in both = 8 intents, 8 * 150000 / (8 * 100000) - 1 = 0.5.
  // Off against layout: failures 10 - 10 = 0; built in both = intents 1..8 (off fails 9, layout fails 0):
  // 8 * 120000 / (8 * 110000) - 1 = 1/11.
  // Absorption: failures on minus off = 20 - 10 = 10; fees off against on over intents 0..7 = 120/150 - 1 = -0.2.
  const own = mk(10, ok(100000));
  const layout = mk(10, (i) => (i === 0 ? failed(i, 'change-minimum') : built(i, { fee: 110000 })));
  const on = mk(10, (i) => (i >= 8 ? failed(i, 'change-minimum') : built(i, { fee: 150000 })));
  const off = mk(10, (i) => (i === 9 ? failed(i, 'change-minimum') : built(i, { fee: 120000 })));
  const { res } = await run1([wal(101, 'B1', lf(own, layout, on, off))]);
  const at = (name) => cell(res, name);
  near(at('rule-vs-own/failures/csl-lf/on-vs-own').estimate, 20);
  near(at('rule-vs-own/fees/csl-lf/on-vs-own').estimate, 0.5);
  near(at('rule-off-vs-layout/failures/csl-lf/off-vs-layout').estimate, 0);
  near(at('rule-off-vs-layout/fees/csl-lf/off-vs-layout').estimate, 1 / 11);
  near(at('absorption/failures/on-vs-off').estimate, 10);
  near(at('absorption/fees/off-vs-on').estimate, -0.2);
  assert.equal(at('absorption/fees/off-vs-on').n, 1);
  assert.deepEqual(at('absorption/fees/off-vs-on').interval.length, 2);
});

test('chains: counts, shares as cluster ratios, the distribution, the whole-chain fees and question 2 without the chained intents', async () => {
  // Wallet 101 (B1, weight 2), the rule on: intents 0, 1, 4 to 7 built in one transaction, intent 2 in 2 (fee 500000),
  // intent 3 in 3 (fee 700000), intents 8 and 9 fail: attempted 10, built 8, chains 2.
  // Wallet 102 (B2, weight 2): 5 built, intent 4 in 2 transactions (fee 300000): attempted 5, built 5, chains 1.
  // Share of attempted = (2*2 + 2*1) / (2*10 + 2*5) = 6/30 = 0.2; of built = 6 / (2*8 + 2*5) = 6/26.
  // Distribution over built spends: one transaction 6 + 4 = 10, two 1 + 1 = 2, three 1. Totals: fee 500000 + 700000 + 300000
  // = 1,500,000 over 3 chains (mean 500000, from 300000 to 700000); the wallet-controlled fee equals the fee (no fixed parts).
  const on101 = mk(10, (i) => (i >= 8 ? failed(i, 'change-minimum') : i === 2 ? built(i, { txs: 2, fee: 500000 }) : i === 3 ? built(i, { txs: 3, fee: 700000 }) : built(i)));
  const on102 = mk(5, (i) => (i === 4 ? built(i, { txs: 2, fee: 300000 }) : built(i)));
  // Question 2's failures for wallet 101: layout fails intents 2 and 9. Rule 20 per 100, layout 20 per 100: y = 0.
  // Without the intents 2 and 3 in both arms: the rule has 8 attempted, 2 failed = 25; layout 8 attempted, 1 failed = 12.5: 12.5.
  // Wallet 102 left with 4 attempted spends does not enter.
  const lay101 = mk(10, (i) => (i === 2 || i === 9 ? failed(i, 'change-minimum') : built(i)));
  const { tables, res } = await run1([wal(101, 'B1', lf(mk(10, ok()), lay101, on101)), wal(102, 'B2', lf(mk(5, ok()), mk(5, ok()), on102))]);
  const share = cell(res, 'chains/on/share-of-attempted');
  near(share.estimate, 6 / 30);
  assert.equal(share.n, 2);
  near(cell(res, 'chains/on/share-of-built').estimate, 6 / 26);
  const c = chainSummary(tables, 'on');
  assert.deepEqual({ wallets: c.wallets, attempted: c.attempted, built: c.built, chained: c.chained, byTxs: c.byTxs }, { wallets: 2, attempted: 15, built: 13, chained: 3, byTxs: { 1: 10, 2: 2, 3: 1 } });
  assert.deepEqual({ totalFee: c.totalFee, totalWalletFee: c.totalWalletFee, perChain: c.perChain }, { totalFee: '1500000', totalWalletFee: '1500000', perChain: { meanFee: 500000, meanWalletFee: 500000, minFee: '300000', maxFee: '700000' } });
  assert.equal(chainSummary(tables, 'off').chained, 0);
  const q2 = cell(res, 'chains/q2-failures-without-chain/csl-lf/on-vs-layout');
  assert.equal(q2.n, 1);
  near(q2.estimate, 12.5);
});

test('question 1 without substituted change: the right intents leave both arms, and the fee ratio is the main one', async () => {
  // csl-lf. Layout fails intents 3 and 4 (change-minimum) and 5 (size): 3 per 10 attempted = 30. Own fails intent 6
  // (fee-minimum, no unpriced part): 10. Main failures: 30 - 10 = 20.
  // Without intents 3 and 4 in both arms: layout 8 attempted, 1 failed = 12.5; own 8 attempted, 1 failed = 12.5: 0.
  // Fees: built in both are intents 0, 1, 2, 7, 8, 9 in both readings: layout 90000, own 100000: -0.1.
  const layout = mk(10, (i) => (i === 3 || i === 4 ? failed(i, 'change-minimum') : i === 5 ? failed(i, 'size') : built(i, { fee: 90000 })));
  const own = mk(10, (i) => (i === 6 ? failed(i, 'fee-minimum') : built(i, { fee: 100000 })));
  const { tables, res } = await run1([wal(101, 'B1', lf(own, layout))]);
  near(cell(res, 'without-change-minimum/failures/csl-lf/layout-vs-own').estimate, 0);
  const fees = byItem(res, 'without-change-minimum', 'fees');
  assert.equal(fees.name, 'q1/fees/csl-lf/layout-vs-own');
  near(fees.estimate, -0.1);
  assert.equal(fees.equalsMain, true);
  const main = (await runQuestions(tables, { resamples: N, libraries: LIB })).cells.find((x) => x.name === 'q1/fees/csl-lf/layout-vs-own');
  assert.equal(fees.estimate, main.estimate);
  assert.deepEqual(fees.interval, main.intervals['0.95']);
  near((await runQuestions(tables, { resamples: N, libraries: LIB })).cells.find((x) => x.name === 'q1/failures/csl-lf/layout-vs-own').estimate, 20);
});

test('question 1 without L/own failures on other parts and on a deposit: a part other than redeemers, and D5 for several deposits', async () => {
  // csl-lf, 14 intents. Own fails intents 2 to 9 and builds 0, 1 and 10 to 13 at 100000; layout builds all at 90000.
  // Intents' deposits: 4 one certificate (2,000,000); 5, 6 and 7 two certificates (a key deposit 2,000,000 and a DRep
  // deposit 500,000,000); 8 and 9 none.
  //   2  fee-minimum naming "foo, redeemers": removed.
  //   3  fee-minimum naming "redeemers" only: kept.
  // A balance failure is short by produced minus consumed coin.
  const bal = (i, consumed, produced) => failed(i, 'balance', `kit: balance; coin: ${consumed} consumed, ${produced} produced`);
  const own = mk(14, (i) => {
    if (i === 2) return failed(i, 'fee-minimum', 'kit: fee; parts the library did not price: foo, redeemers');
    if (i === 3) return failed(i, 'fee-minimum', 'kit: fee; parts the library did not price: redeemers');
    if (i === 4) return bal(i, 10000000, 12000000); // short by 2,000,000, the one deposit: removed
    if (i === 5) return bal(i, 10000000, 12000000); // short by 2,000,000, one of the two deposits: removed
    if (i === 6) return bal(i, 10000000, 512000000); // short by 502,000,000, both deposits: removed
    if (i === 7) return bal(i, 10000000, 13000000); // short by 3,000,000, no subset: kept
    if (i === 8) return bal(i, 12000000, 10000000); // produced below consumed: kept
    if (i === 9) return bal(i, 10000000, 12000000); // short by 2,000,000, no deposit in the intent: kept
    return built(i, { fee: 100000 });
  });
  const two = { certs: [{ type: 0 }, { type: 16, coin: 500000000 }] };
  const intents = [{}, {}, {}, {}, { certs: [{ type: 7, coin: 2000000 }] }, two, two, two, {}, {}, {}, {}, {}, {}];
  // Removed: 2, 4, 5, 6. Own then has intents 0, 1, 3, 7 to 13: attempted 10, failed 4 (3, 7, 8, 9) = 40; layout 0.
  // Built in both: 0, 1 and 10 to 13, so the fee ratio is 90000 / 100000 - 1 = -0.1 as in the main cell.
  const { res } = await run1([{ ...wal(101, 'B1', lf(own, mk(14, ok(90000)))), intents }]);
  near(cell(res, 'without-own-other-parts/failures/csl-lf/layout-vs-own').estimate, -40);
  const fees = byItem(res, 'without-own-other-parts', 'fees');
  assert.equal(fees.name, 'q1/fees/csl-lf/layout-vs-own');
  assert.equal(fees.equalsMain, true);
  near(fees.estimate, -0.1);
});

test('D5: a deposit subset of any size, priced by the history reader; pool deposits and a total with no certificates', async () => {
  assert.equal(isDepositSubset(2000000n, [2000000n, 500000000n]), true);
  assert.equal(isDepositSubset(500000000n, [2000000n, 500000000n]), true);
  assert.equal(isDepositSubset(502000000n, [2000000n, 500000000n]), true);
  assert.equal(isDepositSubset(3000000n, [2000000n, 500000000n]), false);
  assert.equal(isDepositSubset(0n, [2000000n]), false);
  assert.equal(isDepositSubset(-2000000n, [2000000n]), false);
  assert.equal(isDepositSubset(2000000n, []), false);
  // Through the reader: a Conway registration 3,000,000, a key registration (key deposit 2,000,000), a proposal 100,000,000
  // and one new pool (500,000,000), in wire order.
  const intents = [{ certs: [{ type: 7, coin: 3000000 }, { type: 0 }], proposals: [100000000], newPools: 1 }, { deposits: 7000000 }, {}, {}, {}];
  const { wallets } = await tablesOf([{ ...wal(101, 'B1', {}), intents }]);
  assert.deepEqual(wallets[0].intents[0].depositParts, [3000000n, 2000000n, 100000000n, 500000000n]);
  assert.equal(wallets[0].intents[0].deposits, 605000000n);
  // No certificates: the total stands as the one deposit; none: no deposit.
  assert.deepEqual(wallets[0].intents[1].depositParts, [7000000n]);
  assert.deepEqual(wallets[0].intents[2].depositParts, []);
  assert.deepEqual(depositParts({ fixed: null, derived: null }, { keyDeposit: 1n, poolDeposit: 1n }), []);
});

test('section 6.4\'s broader reading: any unpriced part, in either arm, takes the intent out of both; the counts per arm', async () => {
  // csl-lf. Own fails intent 2 (size, naming "vkey witness") and intent 3 (size, no part): 20 per 100.
  // Layout fails intent 5 (other, naming "redeemers" only): 10. Main y = 10 - 20 = -10.
  // Without intent 2 in both arms: own 9 attempted, 1 failed = 100/9; layout 9 attempted, 1 failed = 100/9: 0.
  const own = mk(10, (i) => (i === 2 ? failed(i, 'size', 'kit: size; parts the library did not price: vkey witness') : i === 3 ? failed(i, 'size') : built(i, { fee: 100000 })));
  const layout = mk(10, (i) => (i === 5 ? failed(i, 'other', 'kit: other; parts the library did not price: redeemers') : built(i, { fee: 100000 })));
  const { tables, res } = await run1([wal(101, 'B1', lf(own, layout))]);
  near(cell(res, 'without-unpriced/q1/failures/csl-lf/layout-vs-own').estimate, 0);
  // The same reading for question 2 and the first two items: the rule's arms hold five built spends, so only the fee
  // ratios are checked, and they are the main ones.
  for (const of of ['q2', 'rule-vs-own', 'rule-off-vs-layout']) {
    const c = byItem(res, 'without-unpriced', 'fees', of);
    assert.equal(c.equalsMain, true, of);
    assert.ok(/^(q2|rule-vs-own|rule-off-vs-layout)\/fees\/csl-lf\//.test(c.name), c.name);
  }
  const u = unpricedCounts(tables);
  assert.deepEqual(u['csl-lf/own'], { failures: 1, wallets: 1 });
  assert.deepEqual(u['csl-lf/layout'], { failures: 0, wallets: 0 });
  assert.equal(res.counts.main.unpriced['csl-lf/own'].failures, 1);
});

test('a run restricted to some spends is counted again, minimums included', async () => {
  const spends = [...mk(6, ok()), failed(6, 'size'), failed(7, 'size', 'kit; parts the library did not price: foo')];
  const { wallets } = await tablesOf([wal(101, 'B1', lf(spends, spends))]);
  const r = wallets[0].arms.get('csl-lf/own').runs.get(1);
  const v = restrictRun(r, (s) => s.intent !== 7);
  assert.deepEqual({ attempted: v.n.attempted, built: v.n.built, failed: v.n.failed, unpriced: v.unpricedFailures, size: v.byClass.size }, { attempted: 7, built: 6, failed: 1, unpriced: 0, size: 1 });
  assert.equal(r.unpricedFailures, 1);
});

// Twenty-six wallets: twelve in B1 (fragmented), twelve in B2 and two in B3 (not). Own fails k of 10 intents, k = 1, 2 and 4
// by group, layout builds all, at 90000 against 100000: failures -10k, fee ratio -0.1. The weights are 2, 2 and 1.
const ownFails = (k) => mk(10, (i) => (i < k ? failed(i, 'change-minimum') : built(i, { fee: 100000 })));
const big = () => {
  const ws = [];
  const add = (id, group, k, fragmented) => ws.push({ ...wal(id, group, lf(ownFails(k), mk(10, ok(90000)))), flags: { fragmented } });
  for (let i = 0; i < 12; i++) add(101 + i, 'B1', 1, true);
  for (let i = 0; i < 12; i++) add(201 + i, 'B2', 2, false);
  for (let i = 0; i < 2; i++) add(301 + i, 'B3', 4, false);
  return ws;
};

test('size groups: a group under ten wallets merges with the next smaller, the primary outcomes and the items are given for each cell', async () => {
  const { res } = await run1(big());
  // B3 holds 2 wallets: it merges with B2 (12): B2+B3 = 14. B1 = 12 stands alone.
  // B1: -10. B2+B3: (12 * 2 * -20 + 2 * 1 * -40) / (24 + 2) = -560/26.
  const sizeCells = res.cells.filter((c) => c.scope.kind === 'size' && c.name.startsWith('q1/failures/csl-lf/'));
  assert.deepEqual(sizeCells.map((c) => [c.scope.label, c.n]), [['B1', 12], ['B2+B3', 14]]);
  near(sizeCells[0].estimate, -10);
  near(sizeCells[1].estimate, -560 / 26);
  assert.deepEqual(sizeCells.map((c) => c.name), ['q1/failures/csl-lf/layout-vs-own/size/B1', 'q1/failures/csl-lf/layout-vs-own/size/B2+B3']);
  assert.ok(res.cells.some((c) => c.name === 'rule-vs-own/failures/csl-lf/on-vs-own/size/B2+B3' && c.n === 14));
  assert.ok(!res.cells.some((c) => /size\/B3/.test(c.name) || /size\/B2\//.test(c.name) || /size\/B2$/.test(c.name)), 'B3 and B2 are never alone');
  // The fee ratio is -0.1 in every wallet.
  near(res.cells.find((c) => c.name === 'q1/fees/csl-lf/layout-vs-own/size/B2+B3').estimate, -0.1);
});

test('the fragmentation flag: each value is a cell of its own, from the tables of that value', async () => {
  const { res } = await run1(big());
  const yes = res.cells.find((c) => c.name === 'q1/failures/csl-lf/layout-vs-own/frag/yes');
  const no = res.cells.find((c) => c.name === 'q1/failures/csl-lf/layout-vs-own/frag/no');
  assert.deepEqual([yes.n, no.n], [12, 14]);
  near(yes.estimate, -10);
  near(no.estimate, -560 / 26);
  assert.ok(res.counts['frag/yes'] && res.counts['frag/no']);
});

test('spend types: each outcome on the spends of that type with its own minimum, cells under ten wallets written with the count only', async () => {
  // Ten wallets of B1, intents 0 to 5 of type T1 and 6 to 9 of type T2. Own fails intents 2 (T1) and 6 (T2); layout builds all.
  // Main: own 2 of 10 = 20, y = -20. T1: own 1 of 6 = 100/6, y = -100/6. T2: 4 attempted spends, under 5: no wallet enters.
  const typed = (fee, failAt = []) => mk(10, (i) => (failAt.includes(i) ? failed(i, 'change-minimum', 'kit: failed', { type: i < 6 ? 'T1' : 'T2' }) : built(i, { fee, type: i < 6 ? 'T1' : 'T2' })));
  const ws = mk(10, (i) => ({ ...wal(101 + i, 'B1', lf(typed(100000, [2, 6]), typed(90000))), flags: { fragmented: i < 3 } }));
  const { res } = await run1(ws);
  const t1 = res.cells.find((c) => c.name === 'q1/failures/csl-lf/layout-vs-own/type/T1');
  assert.equal(t1.n, 10);
  near(t1.estimate, -100 / 6);
  assert.equal(t1.suppressed, undefined);
  const t2 = res.cells.find((c) => c.name === 'q1/failures/csl-lf/layout-vs-own/type/T2');
  assert.deepEqual([t2.n, t2.suppressed, t2.estimate, t2.interval], [0, true, null, null]);
  // The chain summary and the unpriced counts are given per type too.
  assert.ok(res.counts['type/T1'] && res.counts['type/T2']);
  // The flag: 3 and 7 wallets, both under ten: counts only.
  const yes = res.cells.find((c) => c.name === 'q1/failures/csl-lf/layout-vs-own/frag/yes');
  assert.deepEqual([yes.n, yes.suppressed, yes.estimate], [3, true, null]);
  const rule = res.cells.find((c) => c.name === 'rule-vs-own/failures/csl-lf/on-vs-own/frag/no');
  assert.deepEqual([rule.n, rule.suppressed], [7, true]);
});

test('breakdown cells never reuse a main cell\'s name, and a suffix separates a second window', async () => {
  const { tables, res } = await run1(big());
  const main = await runQuestions(tables, { resamples: N, libraries: LIB });
  const mainNames = new Set([...main.cells.map((c) => c.name), main.absorption.fees.name, main.absorption.failures.name]);
  for (const c of res.cells.filter((x) => x.scope.kind !== 'main')) assert.ok(!mainNames.has(c.name), c.name);
  // Names repeat only for a "without" fee ratio reported under the main cell's name, with the same numbers.
  const seen = new Map();
  for (const c of res.cells) {
    if (seen.has(c.name)) assert.deepEqual([seen.get(c.name).estimate, seen.get(c.name).interval, seen.get(c.name).n], [c.estimate, c.interval, c.n], c.name);
    seen.set(c.name, c);
  }
  const peak = await runItems(tables, { resamples: N, libraries: LIB, suffix: 'peak' });
  assert.equal(peak.cells.length, res.cells.length);
  for (const c of peak.cells) assert.ok(c.name.endsWith('/peak') && !seen.has(c.name), c.name);
  const q = await runQuestions(tables, { resamples: 20, libraries: LIB, suffix: 'size/B2' });
  assert.ok(q.cells.every((c) => c.name.endsWith('/size/B2')));
  assert.equal(q.absorption.fees.name, 'absorption/fees/off-vs-on/size/B2');
  assert.equal(q.absorption.failures.name, 'absorption/failures/on-vs-off/size/B2');
});

test('end states: weighted mean and median per arm, null values and refused plans counted apart, capped wallets, differences', async () => {
  // csl-lf. Wallets A and B (B1, weight 2) and C (B2, weight 2, capped).
  // Own utxos 4, 8, 20: mean (2 * 4 + 2 * 8 + 2 * 20) / 6 = 32/3; weighted median: cumulative 2, 4 of 6, half is 3: 8.
  // Layout utxos 3, 6, 10: layout minus own -1, -2, -10: mean -26/6 = -13/3; median: sorted -10, -2, -1 with cumulative 2, 4: -2.
  // Locked ADA per token (own) 900000, null, 300000: B counted apart; mean (2 * 900000 + 2 * 300000) / 4 = 600000.
  // Conforming share: A 3 of 4 = 0.75, B has no token UTxO (apart), C 5 of 10 = 0.5: mean 0.625; without the coin rule 1 and 1: 1.
  // Plan fee: A proposes 300000, B proposes nothing (0), C refused (apart): mean (2 * 300000 + 2 * 0) / 4 = 150000.
  const own = (utxos, perToken, conf, plan) => ({
    end: { utxos, largestValueBytes: 10, lockedAda: '0', lockedAdaPerToken: perToken, tokens: 0 },
    conformity: { ...conf, ...plan }
  });
  const layoutEnd = (utxos) => ({ end: { utxos, largestValueBytes: 10, lockedAda: '0', lockedAdaPerToken: null, tokens: 0 } });
  const a = wal(101, 'B1', {});
  const b = wal(102, 'B1', {});
  const c = { ...wal(103, 'B2', {}), capped: true };
  const setWa = (w, method, arm, wa) => (w.jobs.find((j) => j.method === method && j.arm === arm && (j.rep || 1) === 1).wa = wa);
  setWa(a, 'csl-lf', 'own', own(4, '900000', { tokenUtxos: 4, conforming: 3, conformingNoCoin: 4 }, { proposes: true, txs: 1, fee: '300000' }));
  setWa(b, 'csl-lf', 'own', own(8, null, { tokenUtxos: 0, conforming: 0, conformingNoCoin: 0 }, { proposes: false, txs: 0, fee: '0' }));
  setWa(c, 'csl-lf', 'own', own(20, '300000', { tokenUtxos: 10, conforming: 5, conformingNoCoin: 10 }, { refused: 'boom' }));
  setWa(a, 'csl-lf', 'layout', layoutEnd(3));
  setWa(b, 'csl-lf', 'layout', layoutEnd(6));
  setWa(c, 'csl-lf', 'layout', layoutEnd(10));
  const { res } = await run1([a, b, c]);
  const e = (arm, metric, stat, pop = 'all') => res.cells.find((x) => x.name === `end-state/csl-lf/${arm}/${metric}/${stat}/${pop}`);
  near(e('own', 'utxos', 'mean').estimate, 32 / 3);
  near(e('own', 'utxos', 'median').estimate, 8);
  const d = (stat) => res.cells.find((x) => x.name === `end-state-difference/csl-lf/layout-minus-own/utxos/${stat}/all`);
  near(d('mean').estimate, -26 / 6);
  near(d('median').estimate, -2);
  const lp = e('own', 'lockedAdaPerToken', 'mean');
  near(lp.estimate, 600000);
  assert.deepEqual([lp.n, lp.apart.noValue], [2, 1]);
  near(e('own', 'conformingShare', 'mean').estimate, 0.625);
  near(e('own', 'conformingShareNoCoin', 'mean').estimate, 1);
  assert.equal(e('own', 'conformingShare', 'mean').apart.noValue, 1);
  const pf = e('own', 'planFee', 'mean');
  near(pf.estimate, 150000);
  assert.deepEqual(pf.apart, { noValue: 1, refusedRuns: 1, noChangeAddressRuns: 0 });
  // The capped wallet alone, and the others: under ten wallets each, so counts only.
  assert.deepEqual([e('own', 'utxos', 'mean', 'capped').n, e('own', 'utxos', 'mean', 'capped').suppressed], [1, true]);
  assert.deepEqual([e('own', 'utxos', 'mean', 'uncapped').n, e('own', 'utxos', 'mean', 'uncapped').estimate], [2, null]);
  // The all-wallet cell is never suppressed, and no end state is given by spend type.
  assert.equal(e('own', 'utxos', 'mean').suppressed, undefined);
  assert.ok(!res.cells.some((x) => x.scope.kind === 'type' && x.name.startsWith('end-state')));
});

test('item 8: the distribution of times', () => {
  // 10, 20, 30, 40, 100: quartiles by type 7 are 20, 30, 40; maximum 100; total 200.
  const rows = [10, 20, 30, 40, 100].map((ms) => ({ method: 'csl-lf', kind: 'own', type: 'T1', ms }));
  const s = timingSummary([...rows, { method: 'csl-lf', kind: 'layout', type: 'T2', ms: 5 }]);
  assert.deepEqual(s.byArm['csl-lf/own'], { n: 5, q1: 20, median: 30, q3: 40, max: 100, total: 200 });
  assert.deepEqual(Object.keys(s.byMethodAndType), ['csl-lf/T1', 'csl-lf/T2']);
  assert.deepEqual(s.byMethodAndType['csl-lf/T2'], { n: 1, q1: 5, median: 5, q3: 5, max: 5, total: 5 });
});

test('results are identical at one, two and four workers', async () => {
  const ws = mk(12, (i) => ({ ...wal(101 + i, i < 8 ? 'B1' : 'B2', { ...lf(ownFails(1 + (i % 3)), mk(10, ok(90000)), mk(10, (j) => (j === 9 ? failed(j, 'change-minimum') : built(j, { fee: 120000 })))), 'csl-ri/own': ownFails(1), 'csl-ri/layout': mk(10, ok(95000)) }), flags: { fragmented: i % 2 === 0 } }));
  const { wallets: tables } = await tablesOf(ws);
  const out = [];
  for (const workers of [1, 2, 4]) out.push(JSON.stringify(await runItems(tables, { resamples: 300, libraries: ['csl-lf', 'csl-ri'], workers }), (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  assert.equal(out[0], out[1]);
  assert.equal(out[0], out[2]);
  assert.equal(out[0], JSON.stringify(JSON.parse(out[0])));
  const res = JSON.parse(out[0]);
  assert.ok(res.cells.length > 200);
});
