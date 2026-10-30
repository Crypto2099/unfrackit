// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The collateral a script spend sets aside before selection (replay/engine.mjs
// setAside), with the treatment, by the test method and cardano-js-sdk:
//   - a wallet whose only eligible UTxO the test method would otherwise spend
//     builds, with that UTxO as its collateral and not among its inputs;
//   - a wallet with no eligible UTxO, and one whose payment cannot be made
//     without the UTxO set aside, are each infeasible for collateral, with
//     their reasons, and never a build failure; a forfeit with no eligible
//     UTxO likewise;
//   - the choice is the smallest eligible UTxO that can carry the collateral
//     of the largest fee the spend can have;
//   - on the synthetic streams of five shapes under every collateral rule,
//     no script spend fails for collateral before the kit, and every built
//     one's collateral is the UTxO set aside, never among its inputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatment, skip } from '../../lib/treatment.mjs';
import { replay, setAside, collateralToSetAside, INFEASIBLE_COLLATERAL } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { COLLATERAL_RULES, totalCollateralFor } from '../../../src/replay/collateral.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { cjsMethod } from '../../../src/methods/cjs.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { minFee } from '../../../src/kit/fee.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { encodeOutput } from '../../../src/history/output.mjs';
import { addressBytes } from '../../../src/history/address.mjs';
import { blake2b256 } from '../../../src/history/blake2b.mjs';
import { utxoFromOutput } from '../../../src/state/utxo.mjs';
import { makeState } from '../../../src/state/state.mjs';

const T = await treatment();
const ADA = 1000000n;
const DAY = 86400;

// S1's synthetic stream: its Plutus spend (a 10 ADA script input, 12 ADA paid
// back to the script, so the wallet pays 2 ADA and the fee) and its
// phase-2-invalid spend, replayed over constructed wallets at its address.
function fixture() {
  const src = loadSource(T, { kind: 'shape', name: 'S1', stream: 'synthetic' });
  const intents = src.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
  const t6 = intents.find((it) => it.type === 'T6' && !it.invalid);
  const invalid = intents.find((it) => it.type === 'T6' && it.invalid);
  const address = src.changeAddress;
  const pure = (i, coin) => utxoFromOutput(blake2b256(Buffer.from(`collateral aside ${i}`)).toString('hex'), 0, encodeOutput({ address: addressBytes(address), coin, assets: [] }, 'array'), { origin: 'deposit' });
  const sourceOf = (utxos, list) => ({ wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: src.stakeCred, changeAddress: address, changeAddressEnd: address, franken: new Set(), start: utxos, events: list.map((intent, i) => ({ kind: 'intent', txId: i + 1, intent })), arrival: new Map(), windowStart: 0, windowEnd: 100 * DAY, params: src.params });
  const stateOf = (utxos) => makeState({ network: 'synthetic', stakeCred: src.stakeCred, changeAddress: address, utxos });
  return { src, t6, invalid, pure, sourceOf, stateOf, P: src.params };
}

const METHODS = () => [['test-largest-first', makeMethod(T, 'test-largest-first'), {}], ['cjs-rrri', cjsMethod(T), {}]];
const run = (source, method, rule, seed = 1) => replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method, opts: { seed, changePolicy: 'default', collateralRule: rule }, settleEvery: 25, keepTx: true });

test('a wallet whose only eligible UTxO the selector would otherwise spend builds with it as collateral', { skip }, async () => {
  const f = fixture();
  const five = f.pure(1, 5n * ADA);
  const utxos = [five, f.pure(2, 4n * ADA), f.pure(3, 4n * ADA)];
  // Without the set-aside the test method takes the 5 ADA UTxO first (largest
  // coin first): the same payment with no script spends it.
  const plain = { ...f.t6, collateral: { required: false, observed: null } };
  const bare = makeMethod(T, 'test-largest-first').build(f.stateOf(utxos), plain, f.P, { seed: 1, changePolicy: 'default' });
  assert.ok(bare.ok && bare.txs[0].walletInputs.includes(five.ref));
  for (const [name, m] of METHODS()) {
    for (const seed of [1, 2, 3]) {
      const r = await run(f.sourceOf(utxos, [f.t6]), m, 'ledger', seed);
      const s = r.spends[0];
      assert.equal(s.outcome, 'built', `${name} ${seed}: ${s.outcome} ${s.class} ${s.detail}`);
      const tx = inspectTx(s.built.txs[0].bytes);
      assert.deepEqual(tx.collateralInputs.map((x) => x.ref), [five.ref]);
      assert.ok(!tx.inputs.some((x) => x.ref === five.ref));
      assert.ok(!s.built.txs[0].walletInputs.includes(five.ref));
      assert.equal(r.summary.counts.infeasibleCollateral, 0);
    }
  }
});

test('no eligible UTxO, and a payment that needs the one set aside, are infeasible for collateral', { skip }, async () => {
  const f = fixture();
  const noneEligible = [f.pure(1, 4n * ADA), f.pure(2, 4n * ADA), f.pure(3, 4n * ADA)];
  const onlyAside = [f.pure(4, 5n * ADA)];
  for (const [name, m] of METHODS()) {
    for (const [utxos, reason] of [[noneEligible, 'none-eligible'], [onlyAside, 'payment']]) {
      const r = await run(f.sourceOf(utxos, [f.t6]), m, 'ledger');
      const s = r.spends[0];
      assert.equal(s.outcome, INFEASIBLE_COLLATERAL, `${name} ${reason}`);
      assert.equal(s.reason, reason);
      assert.equal(s.class, undefined);
      const c = r.summary.counts;
      assert.deepEqual([c.infeasibleCollateral, c.failed, c.infeasible, c.built], [1, 0, 0, 0], `${name} ${reason}`);
      assert.equal(r.summary.failuresPer100, null);
    }
    // Under the token-bearing rule a 4 ADA UTxO can be set aside, and the
    // payment is made from the other two.
    const tb = await run(f.sourceOf(noneEligible, [f.t6]), m, 'token-bearing');
    assert.equal(tb.spends[0].outcome, 'built', name);
    // A forfeit with no eligible UTxO.
    const fo = await run(f.sourceOf(noneEligible, [f.invalid]), m, 'ledger');
    assert.equal(fo.spends[0].outcome, INFEASIBLE_COLLATERAL);
    assert.equal(fo.spends[0].reason, 'none-eligible');
    assert.deepEqual([fo.summary.counts.infeasibleCollateral, fo.summary.counts.failed, fo.summary.counts.forfeits], [1, 0, 0]);
  }
});

test('the set-aside is the smallest eligible UTxO that carries the collateral of the largest fee', { skip }, () => {
  const f = fixture();
  const utxos = [f.pure(1, 5n * ADA), f.pure(2, 6n * ADA), f.pure(3, 9n * ADA), f.pure(4, 30n * ADA)];
  const state = f.stateOf(utxos);
  assert.equal(collateralToSetAside(f.P, state, f.t6, 'ledger').ref, utxos[0].ref);
  assert.equal(collateralToSetAside(f.P, state, f.t6, 'practice').ref, utxos[0].ref);
  // A script fee of 3 ADA: the largest fee's collateral, 1.5 times about
  // 3.9 ADA, leaves too little of 5 or 6 ADA for a return output.
  const heavy = { ...f.t6, fixed: { ...f.t6.fixed, scriptFee: 3n * ADA } };
  const total = totalCollateralFor(f.P, minFee(f.P, f.P.maxTxSize, 3n * ADA));
  assert.ok(total > 5n * ADA && total < 9n * ADA - ADA);
  assert.equal(collateralToSetAside(f.P, state, heavy, 'ledger').ref, utxos[2].ref);
  assert.equal(collateralToSetAside(f.P, state, heavy, 'practice').ref, utxos[2].ref);
  // The spend's fixed inputs are never set aside; a spend with no script sets
  // nothing aside and keeps the whole pool.
  const fixedHere = { ...f.t6, fixed: { ...f.t6.fixed, inputs: [...f.t6.fixed.inputs, { ref: utxos[0].ref, cbor: utxos[0].cbor }] } };
  assert.equal(collateralToSetAside(f.P, state, fixedHere, 'ledger').ref, utxos[1].ref);
  const none = setAside(T, f.P, state, { ...f.t6, collateral: { required: false, observed: null } }, 'ledger');
  assert.equal(none.pool, state);
  assert.equal(none.collateral, null);
  const a = setAside(T, f.P, state, f.t6, 'ledger');
  assert.ok(a.ok && !a.pool.utxos.has(utxos[0].ref) && a.pool.utxos.size === 3);
});

test('every built script spend\'s collateral is the UTxO set aside, never among its inputs', { skip }, async () => {
  let checked = 0;
  for (const name of ['S1', 'S7', 'S8', 'M1', 'M7']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const intents = source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
    for (const [mname, m] of METHODS()) {
      for (const rule of COLLATERAL_RULES) {
        const r = await run(source, m, rule);
        for (const s of r.spends) {
          const it = intents[s.intent];
          if (!it.collateral.required) continue;
          assert.ok(!(s.outcome === 'failed' && s.class === CLASSES.collateral && !/^kit:/.test(s.detail)), `${name} ${mname} ${rule}: ${s.detail}`);
          if (s.outcome !== 'built') continue;
          const want = collateralToSetAside(source.params, s.built.before, it, rule);
          for (const t of s.built.txs) {
            const tx = inspectTx(t.bytes);
            assert.deepEqual(tx.collateralInputs.map((x) => x.ref), [want.ref], `${name} ${mname} ${rule}`);
            assert.ok(!tx.inputs.some((x) => x.ref === want.ref));
          }
          checked++;
        }
      }
    }
  }
  assert.ok(checked >= 30, `${checked} script spends built`);
});

// The collateral available under each rule, recorded for H-5 and H-6, agrees
// with the set-aside: none where a spend would be infeasible for collateral.
test('collateral availability under each rule is the set-aside\'s', { skip }, async () => {
  const f = fixture();
  const m = makeMethod(T, 'test-largest-first');
  const cases = [
    [[f.pure(1, 5n * ADA), f.pure(2, 4n * ADA), f.pure(3, 4n * ADA)], { ledger: true, practice: true, 'token-bearing': true }],
    [[f.pure(1, 4n * ADA), f.pure(2, 4n * ADA), f.pure(3, 4n * ADA)], { ledger: false, practice: false, 'token-bearing': true }],
    [[f.pure(4, 5n * ADA)], { ledger: false, practice: false, 'token-bearing': false }],
    // 25 ADA is eligible under the ledger rule but not the practice rule, and
    // the payment can be made without it.
    [[f.pure(5, 25n * ADA), f.pure(2, 4n * ADA)], { ledger: true, practice: false, 'token-bearing': true }]
  ];
  for (const [utxos, want] of cases) {
    const r = await run(f.sourceOf(utxos, [f.t6]), m, 'ledger');
    const got = r.spends[0].collateralAvailable;
    for (const [rule, v] of Object.entries(want)) assert.equal(got[rule], v, `${rule} over ${utxos.map((u) => u.coin).join(', ')}`);
    assert.equal(got.ledger === false, r.spends[0].outcome === INFEASIBLE_COLLATERAL);
  }
  // A spend infeasible by balance: a UTxO to set aside is enough.
  const poor = { ...f.t6, requested: f.t6.requested.map((o) => ({ ...o, coin: 40n * ADA })) };
  const r = await run(f.sourceOf([f.pure(1, 5n * ADA), f.pure(2, 4n * ADA)], [poor]), m, 'ledger');
  assert.equal(r.spends[0].outcome, 'infeasible');
  assert.equal(r.spends[0].collateralAvailable.ledger, true);
  // On the synthetic streams, under every rule, the arm's own rule is
  // unavailable exactly where the spend is infeasible for collateral.
  for (const name of ['S1', 'S7', 'S8', 'M1', 'M7']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    const intents = source.events.filter((e) => e.kind === 'intent').map((e) => e.intent);
    for (const rule of COLLATERAL_RULES) {
      const x = await run(source, m, rule);
      for (const s of x.spends) {
        const it = intents[s.intent];
        if (!it.collateral.required || it.invalid || s.outcome === 'infeasible') continue;
        assert.equal(s.collateralAvailable[rule] === false, s.outcome === INFEASIBLE_COLLATERAL, `${name} ${rule}`);
      }
    }
  }
});
