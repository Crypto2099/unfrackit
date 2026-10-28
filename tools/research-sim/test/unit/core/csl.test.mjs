// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The parts that need CSL, loaded only through the treatment's cslkit.mjs:
// the treatment's pins and parameters, the shapes against the harness's own
// generators, output and transaction sizes against CSL, witness counting over
// several payment keys, the negative controls on every form of transaction
// the kit assembles or receives, the change policies and the battery intents.
// Skipped unless RESEARCH_SIM_TREATMENT_DIR names the treatment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { treatment, skip, TREATMENT_DIR } from '../../lib/treatment.mjs';
import { loadTreatment, treatmentParams, TREATMENT_FILES, DEFAULT_PINS } from '../../../src/treatment/bridge.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { shapeState, shapeSettings, HARNESS_SHAPES, SHAPE_NAMES } from '../../../src/shapes/shapes.mjs';
import { generateShape } from '../../../src/shapes/generate.mjs';
import { planState, selectState } from '../../../src/treatment/run.mjs';
import { checkTx, CLASSES, outputMinimum } from '../../../src/kit/check.mjs';
import { checkAndApply } from '../../../src/kit/apply.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { minFee } from '../../../src/kit/fee.mjs';
import { valueSize } from '../../../src/history/value.mjs';
import { unspentOutputParts } from '../../../src/kit/inspect.mjs';
import { buildWithChange } from '../../../src/methods/change.mjs';
import { testLargestMethod } from '../../../src/methods/test-largest.mjs';
import { h12Method, h12Request } from '../../../src/methods/h12.mjs';
import { standardBattery, h10Battery, SHAPE_POOLS, spreadFungible, drawSeed } from '../../../src/battery/battery.mjs';
import { recipientAddress, RECIPIENT_STAKE } from '../../../src/battery/recipients.mjs';
import { spendable, cmpRef } from '../../../src/state/state.mjs';
import { settle } from '../../../src/kit/heap.mjs';
import { withoutOneWitness } from '../../lib/txcbor.mjs';
import { negativeControls, EXPECTED } from '../../lib/controls.mjs';
import { parseAddress, addressBytes } from '../../../src/history/address.mjs';
import { createHash } from 'node:crypto';

const T = await treatment();
const P = SYNTHETIC_PARAMS;

test('the treatment loads only under its pins', { skip }, () => {
  const pins = readFileSync(DEFAULT_PINS, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'research-sim-pins-'));
  try {
    for (const f of TREATMENT_FILES) copyFileSync(join(TREATMENT_DIR, f), join(dir, f));
    writeFileSync(join(dir, 'conform.mjs'), readFileSync(join(dir, 'conform.mjs'), 'utf8') + '\n');
    return Promise.all([
      assert.rejects(loadTreatment(dir, pins), /conform\.mjs: SHA-256 [0-9a-f]{64}, pinned 2d9db3a8/),
      assert.rejects(loadTreatment(dir, pins.split('\n').filter((l) => !l.endsWith('apply.mjs')).join('\n')), /does not name the treatment file apply\.mjs/),
      assert.rejects(loadTreatment(dir, pins + `${'0'.repeat(64)}  measure2.mjs\n`), /measure2\.mjs, which is not a treatment file/)
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the run\'s parameters reach the treatment unchanged, and what it cannot take is refused', { skip }, () => {
  const tp = treatmentParams(T, P);
  assert.equal(tp.minFeeA, 44);
  assert.equal(tp.coinsPerUtxoByte, 4310n);
  assert.throws(() => treatmentParams(T, { ...P, protocolMajor: 6 }), /protocol major 6/);
  assert.throws(() => treatmentParams(T, { ...P, minFeeA: 262144n }), /2\^32/);
  assert.equal(treatmentParams(T, { ...P, protocolMajor: 10 }).maxTxSize, 16384);
});

test('the 17 shapes equal the harness\'s generators byte for byte', { skip }, async () => {
  const { SHAPES2 } = await import(pathToFileURL(join(TREATMENT_DIR, 'shapes2.mjs')).href);
  let utxos = 0;
  for (const name of HARNESS_SHAPES) {
    const s = shapeState(T, name);
    const h = SHAPES2.find((x) => x.name === name).build();
    assert.deepEqual(s.hex, h.utxoHex, name);
    utxos += s.hex.length;
    await settle();
  }
  assert.equal(utxos, 8337);
});

test('CL1, CL3, E1 and E2 follow their rules, deterministically', { skip }, () => {
  for (const [name, claims, pool] of [['CL1', 73, 30], ['CL3', 219, 60]]) {
    const s = shapeState(T, name);
    const u = [...s.state.utxos.values()];
    const pure = u.filter((x) => !x.assets.length).map((x) => x.coin).sort();
    assert.deepEqual(pure, [25000000n, 75000000n], name);
    const claimU = u.filter((x) => x.assets.length);
    assert.equal(claimU.length, claims);
    const counts = new Map();
    for (const x of claimU) for (const a of x.assets) counts.set(`${a.policy}.${a.name}`, (counts.get(`${a.policy}.${a.name}`) || 0) + 1);
    const a = [...counts].find(([, n]) => n === claims)[0];
    assert.ok(counts.size <= pool + 1);
    for (const x of claimU) {
      assert.ok(x.assets.length >= 1 && x.assets.length <= 10);
      const p = unspentOutputParts(x.cbor);
      assert.equal(x.coin, outputMinimum(P, p.outputRaw.length), 'exactly its minimum');
      for (const t of x.assets) {
        const max = `${t.policy}.${t.name}` === a ? 100000n : 10000n;
        const min = `${t.policy}.${t.name}` === a ? 1000n : 1n;
        assert.ok(t.qty >= min && t.qty <= max);
        assert.ok(t.name.length >= 6 && t.name.length <= 16);
      }
    }
    assert.deepEqual(generateShape(T, name), generateShape(T, name));
  }
  for (const [name, payments, order] of [['E1', 400, 25n], ['E2', 100, 100n]]) {
    const s = shapeState(T, name);
    const u = [...s.state.utxos.values()];
    assert.deepEqual(u.filter((x) => !x.assets.length).map((x) => x.coin), Array(5).fill(10000000n));
    const pay = u.filter((x) => x.assets.length);
    assert.equal(pay.length, payments);
    let total = 0n;
    for (const x of pay) {
      assert.equal(x.assets.length, 1);
      const q = x.assets[0].qty;
      assert.ok(q >= (order * 1000000n) / 2n && q <= (order * 3000000n) / 2n);
      total += q;
      const min = outputMinimum(P, unspentOutputParts(x.cbor).outputRaw.length);
      assert.ok(x.coin >= min && x.coin <= min + 500000n);
    }
    assert.ok(total > 9000n * 1000000n && total < 11000n * 1000000n, `about $10,000 (${total})`);
  }
});

test('output sizes, Values and minimums against CSL on every UTxO of the 21 shapes', { skip }, async () => {
  const CSL = T.CSL;
  const per = CSL.BigNum.from_str('4310');
  const dc = CSL.DataCost.new_coins_per_byte(per);
  let n = 0;
  for (const name of SHAPE_NAMES) {
    for (const u of shapeState(T, name).state.utxos.values()) {
      const p = unspentOutputParts(u.cbor);
      const tu = CSL.TransactionUnspentOutput.from_bytes(Buffer.from(u.cbor, 'hex'));
      const o = tu.output();
      const amount = o.amount();
      assert.equal(Buffer.from(o.to_bytes()).toString('hex'), p.outputRaw.toString('hex'));
      assert.equal(valueSize(p.coin, p.assets), amount.to_bytes().length);
      const m = CSL.min_ada_for_output(o, dc);
      assert.equal(outputMinimum(P, p.outputRaw.length), BigInt(m.to_str()));
      for (const x of [m, amount, o, tu]) x.free();
      n++;
    }
    await settle();
  }
  assert.equal(n, 8337 + 75 + 221 + 405 + 105);
});

test('transaction sizes: the ledger size is the serialized length less the validity flag; the treatment pays the ledger\'s minimum, and CSL\'s fee counts the flag', { skip }, () => {
  const CSL = T.CSL;
  const p = planState(T, shapeState(T, 'S3').state, P, {});
  const t = p.txs[0];
  const tx = CSL.Transaction.from_bytes(Buffer.from(t.bytes, 'hex'));
  const lf = CSL.LinearFee.new(CSL.BigNum.from_str('44'), CSL.BigNum.from_str('155381'));
  const cslMin = BigInt(CSL.min_fee(tx, lf).to_str());
  assert.equal(t.serializedSize, tx.to_bytes().length);
  assert.equal(t.size, t.serializedSize - 1);
  assert.equal(cslMin, minFee(P, t.serializedSize));
  assert.equal(t.fee, minFee(P, t.size), 'the treatment pays the ledger\'s minimum');
  assert.equal(cslMin - t.fee, P.minFeeA, 'CSL\'s minimum is one byte above it');
  tx.free();
  lf.free();
});

test('witness counting over several payment keys (S7)', { skip }, () => {
  const s = shapeState(T, 'S7');
  const creds = new Set(spendable(s.state).map((u) => u.cred));
  assert.equal(creds.size, 3);
  const p = planState(T, s.state, P, {});
  assert.equal(p.txs[0].k, 3);
  assert.equal(p.kitChecks[0].facts.required, 3);
  assert.equal(p.kitChecks[0].facts.vkeys, 3);
  const r = checkTx(withoutOneWitness(p.txs[0].bytes), { params: P, resolve: (ref) => { const u = s.state.utxos.get(ref); return u && { coin: u.coin, assets: u.assets, addr: parseAddress(addressBytes(u.address)) }; } });
  assert.deepEqual(r.failures.map((f) => f.check), ['witnesses']);
});

function controls(state, bytes, label) {
  assert.deepEqual(negativeControls(state, P, bytes), EXPECTED, label);
}

test('negative controls on every form: a plan transaction, a chain\'s planner transaction and payment, a single payment, a kit-assembled spend', { skip }, async () => {
  // A plan transaction (with the planner's label-674 auxiliary data).
  const s3 = shapeState(T, 'S3').state;
  const plan = planState(T, s3, P, {});
  assert.equal(inspectTx(plan.txs[0].bytes).hasAux, true);
  controls(s3, plan.txs[0].bytes, 'plan');
  // A chain: M4 paying 90% of its ADA needs the planner first.
  const m4 = shapeState(T, 'M4').state;
  const h10 = h10Battery(T, m4, P).find((x) => x.id === 'h10-0.9');
  const chain = selectState(T, m4, h12Request(h10), P, { absorb: true });
  assert.equal(chain.result.kind, 'chain');
  controls(m4, chain.txs[0].bytes, 'chain planner transaction');
  const afterFirst = checkAndApply(m4, P, chain.txs.slice(0, 1)).state;
  assert.equal(inspectTx(chain.txs[1].bytes).hasAux, false);
  controls(afterFirst, chain.txs[1].bytes, 'chain payment');
  // A single payment.
  const pay = standardBattery(T, s3, P, { pools: SHAPE_POOLS }).find((x) => x.id === 'one-nft');
  const single = selectState(T, s3, h12Request(pay), P, { absorb: false });
  assert.equal(single.result.kind, 'single');
  controls(s3, single.txs[0].bytes, 'single payment');
  // A transaction the kit assembles.
  const a = testLargestMethod(T).build(s3, pay, P, { changePolicy: 'layout' });
  assert.equal(a.ok, true);
  controls(s3, a.txs[0].bytes, 'kit-assembled');
  await settle();
});

test('the change policies: layout groups by class and policy, naive mixes classes, single holds everything', { skip }, () => {
  const s = shapeState(T, 'S6').state;
  const spend = spendable(s);
  const ft = spend.filter((u) => u.assets.length && u.assets[0].qty > 1n).slice(0, 2);
  const nft = spend.filter((u) => u.assets.length && u.assets[0].qty === 1n).slice(0, 3);
  const pure = spend.filter((u) => !u.assets.length).sort((x, y) => (x.coin > y.coin ? -1 : 1))[0];
  const intent = standardBattery(T, s, P, { pools: { t1: [3000000n], t5: [] } }).find((x) => x.id === 'ada-payment');
  const inputs = [...ft, ...nft, pure];
  const outs = (policy) => {
    const r = buildWithChange(T, { state: s, params: P, inputs, intent, policy });
    assert.equal(r.ok, true, `${policy}: ${r.detail}`);
    const check = checkTx(r.bytes, { params: P, resolve: (ref) => { const u = s.utxos.get(ref); return { coin: u.coin, assets: u.assets, addr: parseAddress(addressBytes(u.address)) }; } });
    assert.equal(check.ok, true, `${policy}: ${JSON.stringify(check.failures)}`);
    return inspectTx(r.bytes).outputs.slice(1);
  };
  const layout = outs('layout');
  const tokenOuts = layout.filter((o) => o.assets.length);
  for (const o of tokenOuts) {
    const kinds = new Set(o.assets.map((a) => (a.qty > 1n ? 'ft' : 'nft')));
    assert.equal(kinds.size, 1, 'classes are not mixed');
  }
  assert.equal(layout.filter((o) => !o.assets.length).length, 1, 'one pure-ADA change output');
  const naive = outs('naive');
  assert.equal(naive.filter((o) => o.assets.length).length, 1, 'naive packs both classes into one output');
  const single = outs('single');
  assert.equal(single.length, 1);
  assert.equal(single[0].assets.length, new Set(inputs.flatMap((u) => u.assets.map((x) => `${x.policy}.${x.name}`))).size);
  // The single output over the value-size limit, and inputs that cannot fund
  // the change.
  const m1 = shapeState(T, 'M1').state;
  const big = spendable(m1).filter((u) => u.assets.length);
  const sixNft = spend.filter((u) => u.assets.length && u.assets[0].qty === 1n).slice(0, 1);
  const mixed = { ...m1, utxos: new Map([...m1.utxos, ...sixNft.map((u) => [u.ref, u])].sort((x, y) => cmpRef(x[0], y[0]))) };
  const over = buildWithChange(T, { state: mixed, params: P, inputs: [...big, ...sixNft, ...spendable(m1).filter((u) => !u.assets.length)], intent, policy: 'single' });
  assert.equal(over.class, CLASSES.valueSize);
  const big200 = standardBattery(T, s, P, { pools: { t1: [200000000n], t5: [] } }).find((x) => x.id === 'ada-payment');
  const short = buildWithChange(T, { state: s, params: P, inputs: nft.slice(0, 1), intent: big200, policy: 'layout' });
  assert.equal(short.class, CLASSES.changeMinimum);
});

test('battery intents: deterministic draws, the spread fungible, payrolls, oversize splits, H-10', { skip }, async () => {
  const cred = 'ab'.repeat(28);
  const h = createHash('sha256').update('battery').update(Buffer.from(cred, 'hex')).update('one-nft').digest();
  assert.equal(drawSeed(cred, 'one-nft'), h.readUInt32BE(0));
  const s6 = shapeState(T, 'S6').state;
  const a = standardBattery(T, s6, P, { pools: SHAPE_POOLS });
  const b = standardBattery(T, s6, P, { pools: SHAPE_POOLS });
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((x) => x.id), ['ada-payment', 'one-nft', 'fungible-share', 'policy-nfts', 'fungible-p-0.25', 'fungible-p-0.5', 'fungible-p-0.75', 'fungible-p-0.9', 'payroll-10', 'payroll-100']);
  for (const it of a) for (const o of it.requested) {
    const pa = parseAddress(addressBytes(o.address));
    assert.equal(pa.stake, RECIPIENT_STAKE, 'recipients carry no wallet\'s stake credential');
    assert.equal(o.coin >= outputMinimum(P, Buffer.from(o.cbor, 'hex').length), true);
  }
  const pay100 = a.find((x) => x.id === 'payroll-100');
  assert.equal(new Set(pay100.requested.map((o) => o.address)).size, 100);
  assert.equal(pay100.requested[0].address, recipientAddress('synthetic', 0));
  // The spread fungible: most UTxOs, then the larger total, then the lower
  // policy and name.
  const f = (policy, name, qty, utxos) => ({ policy, name, qty, utxos });
  assert.equal(spreadFungible([f('bb', '01', 5n, 3), f('aa', '01', 9n, 2)]).policy, 'bb');
  assert.equal(spreadFungible([f('bb', '01', 5n, 3), f('aa', '01', 6n, 3)]).policy, 'aa');
  assert.equal(spreadFungible([f('bb', '01', 6n, 3), f('aa', '02', 6n, 3), f('aa', '01', 6n, 3)]).name, '01');
  // p of the spread fungible, at least one unit.
  const fp = a.filter((x) => x.type === 'fungible-p').map((x) => x.meta.units);
  assert.deepEqual(fp, [...fp].sort((x, y) => (x < y ? -1 : 1)));
  // All 3,000 NFTs of M2's one policy, split at the value-size limit.
  const m2 = shapeState(T, 'M2').state;
  const pn = standardBattery(T, m2, P, { pools: SHAPE_POOLS }).find((x) => x.id === 'policy-nfts');
  assert.ok(pn.requested.length > 1);
  assert.equal(pn.requested.reduce((n, o) => n + o.assets.length, 0), 3000);
  for (const o of pn.requested) assert.ok(valueSize(o.coin, o.assets) <= P.maxValSize);
  // H-10: the observed layout's amounts in every layout; token-laden flags.
  const tidy = planState(T, s6, P, {}).after;
  const obs = h10Battery(T, s6, P);
  const td = h10Battery(T, tidy, P, { observed: s6 });
  assert.deepEqual(obs.map((x) => x.meta.amount), td.map((x) => x.meta.amount));
  assert.equal(obs.find((x) => x.id === 'h10-0.9').meta.tokenLaden, true);
  await settle();
});

test('the H-12 method refuses what its request cannot carry', { skip }, () => {
  const s = shapeState(T, 'S1').state;
  const m = h12Method(T);
  const it = standardBattery(T, s, P, { pools: SHAPE_POOLS })[0];
  assert.equal(m.build(s, { ...it, source: 'replay' }, P, { changePolicy: 'default', absorb: true }).class, 'not-replayable');
  assert.equal(m.build(s, it, P, { changePolicy: 'layout', absorb: true }).class, CLASSES.other);
  assert.equal(m.build(s, it, P, { changePolicy: 'default', absorb: true }).ok, true);
});
