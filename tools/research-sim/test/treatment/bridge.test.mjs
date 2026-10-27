// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The bridge reproduces the treatment. A fresh run of the harness's own
// runners (measure2.mjs for the planner, select2-check.mjs for the H-12 rule),
// in a copy of the digest-checked harness, is compared run against run with
// the simulator's own path on every shape: the planner's plans (transaction
// count, every transaction's size, fee, input and output counts, witness
// count, mode and notes, and the second and third plans after applying them),
// the H-12 rule's battery results (outcome, fees, payment size, transaction
// count, inputs by role, rungs, notes, the UTxO count after the spend and the
// plan after it), and "the balance suffices" on the same requests, with the
// rung rule on the tidied wallets. The harness takes each shape's generated
// order, so the simulator is given the same order here (treatment/wallet.mjs).
//
// The requests are the harness runner's own fixed check battery
// (select2-check.mjs battery), rebuilt here; its payees carry the shapes'
// stake key, so the simulator treats them as payments by address, as that
// runner does.
//
// Needs RESEARCH_SIM_TREATMENT_DIR; RESEARCH_SIM_HARNESS_RESULTS may name a
// directory holding measure2.json and select2.json from such a run instead of
// running the harness again (development only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { treatment, skip, TREATMENT_DIR } from '../lib/treatment.mjs';
import { harnessCopy, runHarness } from './harness-run.mjs';
import { SYNTHETIC_PARAMS } from '../../src/kit/params.mjs';
import { shapeState, shapeSettings, HARNESS_SHAPES, variantsOf } from '../../src/shapes/shapes.mjs';
import { planState, selectState } from '../../src/treatment/run.mjs';
import { checkAndApply } from '../../src/kit/apply.mjs';
import { balanceSuffices, selectAdapterFor } from '../../src/battery/suffices.mjs';
import { treatmentParams } from '../../src/treatment/bridge.mjs';
import { inspectTx } from '../../src/kit/inspect.mjs';
import { settle } from '../../src/kit/heap.mjs';
import { addressTextOf } from '../../src/state/utxo.mjs';

const T = await treatment();
const P = SYNTHETIC_PARAMS;
const ADA = 1000000n;
const sum = (xs) => xs.reduce((a, b) => a + b, 0n);
const str = (x) => (typeof x === 'bigint' ? x.toString() : x);

let fresh = null;
function results() {
  if (fresh) return fresh;
  if (process.env.RESEARCH_SIM_HARNESS_RESULTS) {
    const d = process.env.RESEARCH_SIM_HARNESS_RESULTS;
    fresh = { measure2: JSON.parse(readFileSync(join(d, 'measure2-fresh.json'), 'utf8')), select2: JSON.parse(readFileSync(join(d, 'select2-fresh.json'), 'utf8')), from: d };
    return fresh;
  }
  const copy = harnessCopy(TREATMENT_DIR);
  try {
    fresh = { measure2: runHarness(copy, 'measure2.mjs', 'measure2.json'), select2: runHarness(copy, 'select2-check.mjs', 'select2.json'), from: 'a fresh run' };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
  return fresh;
}

// The order the harness's applyTxs leaves: the wallet's order less the spent
// UTxOs, then each transaction's outputs in order; `drop` names outputs the
// runner removes afterwards (its payments).
function appliedOrder(order, txs, drop = new Set()) {
  const out = order.slice();
  for (const t of txs) {
    const d = inspectTx(t.bytes);
    const spent = new Set(d.inputs.map((x) => x.ref));
    for (let i = out.length - 1; i >= 0; i--) if (spent.has(out[i])) out.splice(i, 1);
    d.outputs.forEach((o, i) => out.push(`${d.hash}#${i}`));
  }
  return out.filter((r) => !drop.has(r));
}

test('the planner\'s plans equal a fresh run of the harness\'s measure2.mjs', { skip, timeout: 60 * 60 * 1000 }, async (t) => {
  const { measure2 } = results();
  let rows = 0;
  let txs = 0;
  for (const name of HARNESS_SHAPES) {
    const s = shapeState(T, name);
    for (const variant of variantsOf(name)) {
      await settle();
      const row = measure2.rows.find((r) => r.shape === name && r.variant === variant);
      assert.ok(row, `${name}/${variant} in the harness's results`);
      const settings = shapeSettings(name, variant);
      const p = planState(T, s.state, P, settings, { refs: s.order });
      const mine = p.plan.txs.map((x) => ({ size: x.size, fee: str(x.fee), inputs: x.inputs.length, outputs: x.outputs.length, k: x.k, freed: str(x.freed), mode: x.mode, notes: x.notes }));
      const theirs = row.txs.map((x) => ({ size: x.size, fee: x.fee, inputs: x.inputs, outputs: x.outputs, k: x.k, freed: x.freed, mode: x.mode, notes: x.notes }));
      assert.deepEqual(mine, theirs, `${name}/${variant}`);
      assert.equal(str(sum(p.plan.txs.map((x) => x.fee))), row.totalFee);
      assert.deepEqual(p.txs.map((x) => x.plannedSize), p.txs.map((x) => x.serializedSize), `${name}/${variant}: planned sizes are the built sizes`);
      // The second plan, on the wallet the first leaves, in the harness's order.
      const order2 = appliedOrder(s.order, p.txs);
      const p2 = planState(T, p.after, P, settings, { refs: order2 });
      assert.equal(p2.plan.txs.length, row.secondPlan.txs, `${name}/${variant}: second plan`);
      assert.equal(str(sum(p2.plan.txs.map((x) => x.fee))), row.secondPlan.fee);
      if (row.thirdPlan) {
        const p3 = planState(T, p2.after, P, settings, { refs: appliedOrder(order2, p2.txs) });
        assert.equal(p3.plan.txs.length, row.thirdPlan.txs, `${name}/${variant}: third plan`);
        assert.equal(str(sum(p3.plan.txs.map((x) => x.fee))), row.thirdPlan.fee);
      }
      rows++;
      txs += p.txs.length;
    }
  }
  assert.equal(rows, measure2.rows.length);
  t.diagnostic(`${rows} plans (${txs} transactions) equal the harness's ${measure2.rows.length}, from ${fresh.from}`);
});

// select2-check.mjs's fixed check battery, rebuilt.
function harnessBattery(utxos, adapter, EXT, payee) {
  const spend = utxos.filter((u) => !u.held);
  const adaBalance = sum(spend.map((u) => u.coin));
  const classes = T.planner.classifyAssets(utxos);
  const hold = new Map();
  for (const u of spend) for (const a of u.assets) {
    const k = `${a.policy}.${a.name}`;
    const h = hold.get(k) || { policy: a.policy, name: a.name, qty: 0n, utxos: 0, key: k };
    h.qty += a.qty;
    h.utxos++;
    hold.set(k, h);
  }
  const all = [...hold.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  const nfts = all.filter((h) => classes.get(h.key).cls === 'nft');
  const fts = all.filter((h) => classes.get(h.key).cls === 'ft');
  const minCoinFor = (address, tokens) => {
    let coin = ADA;
    for (let i = 0; i < 10; i++) {
      const m = adapter.paymentOutput(address, coin, tokens).minCoin;
      if (m === coin) break;
      coin = m;
    }
    return coin;
  };
  const reqs = [];
  const one = (label, tokens, coin) => reqs.push({ label, request: { outputs: [{ address: EXT, coin: coin ?? minCoinFor(EXT, tokens), tokens }] } });
  for (const a of [2n, 20n, 200n]) one(`pay ${a} ADA`, [], a * ADA);
  for (const p of [25n, 50n, 75n, 90n]) one(`pay ${p}% of the ADA balance`, [], (adaBalance * p) / 100n);
  const firstLast = (xs) => (xs.length > 1 ? [xs[0], xs[xs.length - 1]] : xs);
  for (const h of firstLast(nfts)) one(`send one NFT (${h.key.slice(0, 6)}..${h.name.slice(-6)})`, [{ policy: h.policy, name: h.name, qty: 1n }]);
  const spread = fts.length ? fts.reduce((m, h) => (h.utxos > m.utxos ? h : m), fts[0]) : null;
  const ftPicks = [...new Set([fts[0], spread].filter(Boolean))];
  for (const h of ftPicks) for (const p of [10n, 50n, 100n]) {
    const q = (h.qty * p) / 100n;
    one(`send ${p}% of a fungible (${h.key.slice(0, 6)}, ${h.utxos} UTxOs)`, [{ policy: h.policy, name: h.name, qty: q > 0n ? q : 1n }]);
  }
  const byPolicy = new Map();
  for (const h of nfts) byPolicy.set(h.policy, [...(byPolicy.get(h.policy) || []), h]);
  const pols = [...byPolicy.keys()].sort();
  const most = pols.length ? pols.reduce((m, p) => (byPolicy.get(p).length > byPolicy.get(m).length ? p : m), pols[0]) : null;
  for (const pol of [...new Set([pols[0], most].filter(Boolean))]) {
    const items = byPolicy.get(pol).map((h) => ({ policy: h.policy, name: h.name, qty: 1n }));
    const outputs = [];
    let cur = [];
    for (const tk of items) {
      const cand = cur.concat([tk]);
      if (adapter.paymentOutput(EXT, 10n * ADA, cand).valueBytes <= P.maxValSize) cur = cand;
      else {
        outputs.push(cur);
        cur = [tk];
      }
    }
    if (cur.length) outputs.push(cur);
    reqs.push({ label: `send all ${items.length} NFTs of a policy (${pol.slice(0, 6)}) in ${outputs.length} outputs`, request: { outputs: outputs.map((ts) => ({ address: EXT, coin: minCoinFor(EXT, ts), tokens: ts })) } });
  }
  for (const k of [5, 50]) reqs.push({ label: `payroll: ${k} recipients of 5 ADA`, request: { outputs: Array.from({ length: k }, (_, i) => ({ address: payee(i), coin: 5n * ADA, tokens: [] })) } });
  if (spread) for (const k of [5, 50]) {
    const each = spread.qty / 2n / BigInt(k);
    if (each < 1n) continue;
    const tk = [{ policy: spread.policy, name: spread.name, qty: each }];
    reqs.push({ label: `payroll: ${k} recipients of a fungible's half (${spread.key.slice(0, 6)})`, request: { outputs: Array.from({ length: k }, (_, i) => ({ address: payee(i), coin: minCoinFor(payee(i), tk), tokens: tk })) } });
  }
  return reqs;
}

const asIntent = (request) => ({ requested: request.outputs.map((o) => ({ address: o.address, coin: o.coin, assets: o.tokens })) });

function rungsOf(utxos, settings) {
  const s = T.planner.mergeSettings(settings);
  const col = BigInt(Math.round(s.reserve.collateralAda * 1e6));
  const pure = utxos.filter((u) => !u.held && !u.assets.length);
  const total = sum(pure.map((u) => u.coin));
  const target = Math.min(4, Math.floor(s.reserve.count / 2), Number(total / col));
  const byRef = (a, b) => { const x = a.ref.split('#'); const y = b.ref.split('#'); return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : Number(x[1]) - Number(y[1]); };
  return new Set(pure.filter((u) => u.coin === col).sort(byRef).slice(0, target).map((u) => u.ref));
}

test('the H-12 rule\'s battery results and "the balance suffices" equal a fresh run of select2-check.mjs', { skip, timeout: 60 * 60 * 1000 }, async (t) => {
  const { select2 } = results();
  const EXT = T.cslkit.baseAddress(9).to_bech32();
  const payee = (i) => T.cslkit.baseAddress(20 + i).to_bech32();
  const tp = treatmentParams(T, P);
  let runs = 0;
  let suffices = 0;
  let sufficesErrors = 0;
  const tidied = [];
  for (const name of HARNESS_SHAPES) {
    await settle();
    const s = shapeState(T, name);
    const settings = shapeSettings(name, 'default');
    const adapter = selectAdapterFor(T, s.state, tp);
    const utxos = T.adapter.decodeWallet(s.hex.map((h) => T.adapter.decodeUtxo(h)));
    for (const { label, request } of harnessBattery(utxos, adapter, EXT, payee)) {
      const suf = balanceSuffices(T, s.state, P, asIntent(request), { settings });
      for (const absorb of [false, true]) {
        const row = select2.rows.find((r) => r.shape === name && r.request === label && r.absorb === absorb);
        assert.ok(row, `${name}: ${label}, absorb ${absorb} in the harness's results`);
        assert.equal(suf.suffices, row.suffices, `${name}: ${label}: balance suffices`);
        if (suf.suffices) suffices++;
        await settle();
        const r = selectState(T, s.state, request, P, { absorb, settings, refs: s.order });
        runs++;
        if (!r.ok) {
          assert.equal(r.result.error, row.outcome, `${name}: ${label}, absorb ${absorb}`);
          assert.equal(r.result.detail, row.detail);
          if (suf.suffices) sufficesErrors++;
          continue;
        }
        const label2 = `${name}: ${label}, absorb ${absorb}`;
        assert.equal(r.result.kind, row.outcome, label2);
        assert.equal(row.check, true, `${label2}: the harness's checks`);
        assert.equal(str(sum(r.result.txs.map((x) => x.fee))), row.fee, label2);
        const pay = r.result.txs[r.result.payment.index];
        assert.equal(str(pay.fee), row.paymentFee, label2);
        assert.equal(pay.size, row.paymentSize, label2);
        assert.equal(r.txs[r.txs.length - 1].serializedSize, row.paymentSize, `${label2}: built size`);
        assert.equal(r.result.txs.length, row.txs, label2);
        assert.deepEqual(r.result.payment.inputs, row.inputs, label2);
        assert.equal(r.result.payment.rungs, row.rungs, label2);
        assert.deepEqual(pay.notes, row.notes, label2);
        const payTo = new Set(request.outputs.map((o) => o.address));
        const applied = checkAndApply(s.state, P, r.txs, { notWallet: payTo });
        assert.equal(applied.ok, true, label2);
        assert.equal(applied.state.utxos.size, row.utxosAfter, `${label2}: UTxOs after`);
        const drop = new Set();
        for (const x of r.txs) {
          const d = inspectTx(x.bytes);
          d.outputs.forEach((o, i) => { if (payTo.has(addressTextOf(o.address))) drop.add(`${d.hash}#${i}`); });
        }
        const tidy = planState(T, applied.state, P, settings, { refs: appliedOrder(s.order, r.txs, drop) });
        assert.equal(tidy.plan.txs.length, row.tidyTxs, `${label2}: the plan after`);
        assert.equal(str(sum(tidy.plan.txs.map((x) => x.fee))), row.tidyFee, `${label2}: the plan after`);
      }
    }
    // The rung rule on the tidied wallet.
    const plan = planState(T, s.state, P, settings, { refs: s.order });
    const tw = plan.after;
    const tOrder = appliedOrder(s.order, plan.txs);
    const tu = T.adapter.decodeWallet(tOrder.map((ref) => T.adapter.decodeUtxo(tw.utxos.get(ref).cbor)));
    const rungs = rungsOf(tu, settings);
    const tr = { shape: name, utxos: tu.length, rungs: rungs.size, runs: 0, single: 0, chain: 0, errors: 0, pass: 0, built: 0, rungSpent: 0, orderBroken: 0 };
    const tadapter = selectAdapterFor(T, tw, tp);
    for (const { request } of harnessBattery(tu, tadapter, EXT, payee).filter((q) => q.request.outputs.length === 1 && !q.request.outputs[0].tokens.length)) for (const absorb of [false, true]) {
      tr.runs++;
      await settle();
      const r = selectState(T, tw, request, P, { absorb, settings, refs: tOrder });
      if (!r.ok) {
        tr.errors++;
        continue;
      }
      if (r.result.kind === 'single') tr.single++;
      else tr.chain++;
      tr.built++;
      tr.pass++;
      const spent = new Set(r.result.txs[r.result.payment.index].inputs.filter((i) => i.source === 'wallet').map((i) => i.ref));
      const usedRung = [...rungs].some((x) => spent.has(x));
      if (usedRung) tr.rungSpent++;
      if (usedRung && tu.some((u) => !u.held && !u.assets.length && !rungs.has(u.ref) && !spent.has(u.ref))) tr.orderBroken++;
    }
    const theirs = select2.tidied.find((x) => x.shape === name);
    for (const k of ['utxos', 'rungs', 'runs', 'single', 'chain', 'errors', 'pass', 'built', 'rungSpent', 'orderBroken']) assert.equal(tr[k], theirs[k], `${name}, tidied: ${k}`);
    tidied.push(tr);
  }
  assert.equal(runs, select2.rows.length);
  const theirSuffices = select2.rows.filter((r) => r.suffices).length;
  assert.equal(suffices, theirSuffices);
  const theirErrors = select2.rows.filter((r) => r.check === undefined && r.suffices).length;
  assert.equal(sufficesErrors, theirErrors);
  t.diagnostic(`${runs} H-12 runs equal the harness's ${select2.rows.length}; the balance suffices on ${suffices} (harness ${theirSuffices}), errors where it suffices ${sufficesErrors} (harness ${theirErrors}); tidied wallets: ${tidied.reduce((n, x) => n + x.runs, 0)} runs, ${tidied.reduce((n, x) => n + x.rungSpent, 0)} spending a rung, ${tidied.reduce((n, x) => n + x.orderBroken, 0)} too early; from ${fresh.from}`);
});
