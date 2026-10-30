// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The conforming share (src/replay/conform.mjs):
//   - the inputs a verdict needs from the simulator's state (Value bytes,
//     minimum coin) equal what the treatment computes with CSL, on every UTxO
//     of the 21 shapes at their start and after the tidy-once plan, and the
//     counts equal the treatment's walletLayoutReport;
//   - the class map equals the plan's classMap wherever the planner returns
//     a plan;
//   - after the tidy-once plan every counted UTxO conforms under the plan's
//     own settings (the outputs that do not are named);
//   - the observed layout of a fragmented shape is below 1;
//   - a hand-built UTxO that breaks one rule at a time is counted
//     non-conforming for that rule, and the coin-free count differs only for
//     the coin rule.
// Needs RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatment, skip } from '../lib/treatment.mjs';
import { SHAPE_NAMES, shapeState, shapeSettings } from '../../src/shapes/shapes.mjs';
import { SYNTHETIC_PARAMS } from '../../src/kit/params.mjs';
import { planState, planOnly } from '../../src/treatment/run.mjs';
import { treatmentParams } from '../../src/treatment/bridge.mjs';
import { treatmentWallet } from '../../src/treatment/wallet.mjs';
import { conformingShare, utxoVerdicts } from '../../src/replay/conform.mjs';
import { utxoMinimum } from '../../src/replay/measure.mjs';
import { valueSize } from '../../src/history/value.mjs';
import { makeState } from '../../src/state/state.mjs';
import { utxoFromOutput } from '../../src/state/utxo.mjs';
import { changeOutputBytes } from '../../src/kit/replay.mjs';
import { settle } from '../../src/kit/heap.mjs';

const T = await treatment();
const params = SYNTHETIC_PARAMS;

const sameClasses = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.has(k) && b.get(k).cls === v.cls && b.get(k).rule === v.rule && b.get(k).total === v.total && b.get(k).label === v.label);

// The treatment's own count of the state, through walletLayoutReport.
function treatmentCount(state, settings, classMap) {
  const tp = treatmentParams(T, params);
  const { wallet } = treatmentWallet(T, state);
  return T.conform.walletLayoutReport(wallet, { settings: T.planner.mergeSettings(settings), classMap, layout: [], params: tp }, tp);
}

test('the share equals the treatment\'s own count on every shape, at the start and after the tidy-once plan, and the class map equals the plan\'s', { skip, timeout: 30 * 60 * 1000 }, async () => {
  const seen = { states: 0, utxos: 0, bytesChecked: 0, minChecked: 0, plansCompared: 0, tidyNonConforming: [], tidyTokenUtxos: 0 };
  for (const name of SHAPE_NAMES) {
    await settle();
    const { state } = shapeState(T, name);
    const settings = shapeSettings(name);
    const tidy = planState(T, state, params, settings).after;
    for (const [label, st] of [['start', state], ['tidy', tidy]]) {
      seen.states++;
      // The inputs of a verdict, UTxO by UTxO, against CSL.
      for (const u of st.utxos.values()) {
        seen.utxos++;
        const tu = T.CSL.TransactionUnspentOutput.from_bytes(Buffer.from(u.cbor, 'hex'));
        const o = tu.output();
        const amount = o.amount();
        assert.equal(valueSize(u.coin, u.assets), amount.to_bytes().length, `${name} ${label} ${u.ref}: Value bytes`);
        seen.bytesChecked++;
        if (u.assets.length) {
          assert.equal(utxoMinimum(params, u), T.adapter.minAda(o, treatmentParams(T, params)), `${name} ${label} ${u.ref}: minimum`);
          seen.minChecked++;
        }
        for (const x of [amount, o, tu]) x.free();
      }
      // The class map and counts against the planner's and the harness's.
      const p = planOnly(T, st, params, settings);
      assert.ok(sameClasses(T.planner.classifyAssets([...st.utxos.values()]), p.classMap), `${name} ${label}: class map differs from the plan's`);
      seen.plansCompared++;
      const mine = conformingShare(T, st, params, settings);
      const theirs = treatmentCount(st, settings, p.classMap);
      assert.equal(mine.tokenUtxos, theirs.tokenUtxos, `${name} ${label}: token UTxOs`);
      assert.equal(mine.conforming, theirs.conforming, `${name} ${label}: conforming`);
      assert.ok(mine.conformingNoCoin >= mine.conforming);
      if (label === 'tidy') {
        seen.tidyTokenUtxos += mine.tokenUtxos;
        for (const v of utxoVerdicts(T, st, params, settings)) if (v.violations.length) seen.tidyNonConforming.push(`${name} ${v.violations.join(', ')}`);
      }
    }
  }
  console.log(JSON.stringify({ ...seen, tidyNonConforming: seen.tidyNonConforming.length, tidyNonConformingKinds: [...new Set(seen.tidyNonConforming.map((s) => s.replace(/\d+/g, 'N')))] }));
  assert.equal(seen.states, 2 * SHAPE_NAMES.length);
});

test('after the tidy-once plan every counted UTxO conforms under the plan\'s own settings, except the outputs a plan deliberately leaves off the layout', { skip, timeout: 30 * 60 * 1000 }, async () => {
  const off = [];
  let counted = 0;
  for (const name of SHAPE_NAMES) {
    await settle();
    const { state } = shapeState(T, name);
    const settings = shapeSettings(name);
    const p = planState(T, state, params, settings);
    const verdicts = utxoVerdicts(T, p.after, params, settings);
    counted += verdicts.length;
    for (const v of verdicts) if (v.violations.length) off.push(`${name}: ${v.violations.join(', ')}`);
  }
  // The one output that does not conform is M7's partial-split remainder
  // (kind "rest": 111 tokens against a bundle of 30, and the 489541 lovelace
  // of dust change it absorbed above its minimum), which checkBuiltTx exempts
  // from the layout and the share counts as non-conforming.
  console.log(`token UTxOs after the plan ${counted}, not conforming ${off.length}: ${JSON.stringify(off)}`);
  assert.ok(counted > 0);
  assert.equal(off.length, 1);
  assert.match(off[0], /^M7: count 111 > bundle 30, coin \d+ != min \d+$/);
});

test('the observed layout of a fragmented shape is below 1', { skip }, () => {
  let below = 0;
  for (const name of SHAPE_NAMES) {
    const { state } = shapeState(T, name);
    const s = conformingShare(T, state, params, {});
    if (s.tokenUtxos && s.conforming < s.tokenUtxos) below++;
  }
  console.log(`shapes at the observed layout with a share below 1: ${below} of ${SHAPE_NAMES.length}`);
  assert.ok(below > 0);
  const { state } = shapeState(T, 'S7');
  const s = conformingShare(T, state, params, {});
  assert.ok(s.tokenUtxos > 0 && s.conforming < s.tokenUtxos, `S7 observed: ${JSON.stringify(s)}`);
});

// A hand-built state: every UTxO is a token UTxO at the change address with
// its coin as given (or its minimum), under a txid of its own.
function built(base, specs) {
  const mk = (coin, assets, i) => utxoFromOutput(String(i).padStart(64, '0'), 0, changeOutputBytes({ address: base.changeAddress, coin, assets }), { origin: 'initial' });
  const utxos = specs.map((sp, i) => {
    let u = mk(5_000_000n, sp.assets, i + 1);
    for (let k = 0; k < 4; k++) {
      const min = utxoMinimum(params, u);
      u = mk(sp.over ? min + 1_000_000n : min, sp.assets, i + 1);
    }
    return u;
  });
  return makeState({ network: base.network, stakeCred: base.stakeCred, changeAddress: base.changeAddress, utxos, at: base.at });
}
const policy = (n) => String(n).padStart(2, '0').repeat(28);
const tok = (p, n, qty) => ({ policy: policy(p), name: Buffer.from(`tok${n}`).toString('hex'), qty: BigInt(qty) });
const sortT = (l) => l.sort((a, b) => (a.policy + a.name < b.policy + b.name ? -1 : 1));

test('a UTxO that breaks one rule at a time is counted non-conforming for that rule, and the coin-free count differs only for the coin rule', { skip }, () => {
  const { state: base } = shapeState(T, 'S7');
  // Fungible tokens (total over 1) and non-fungible (total 1) across the state.
  const ok = [tok(1, 1, 1)];
  const cases = [
    { name: 'conforming', assets: ok, settings: {}, expect: [] },
    { name: 'mixed classes', assets: sortT([tok(2, 1, 1), tok(2, 2, 100)]), settings: {}, expect: ['mixed classes'] },
    { name: 'over the bundle size', assets: sortT([tok(3, 1, 1), tok(3, 2, 1), tok(3, 3, 1)]), settings: { bundleSize: 2 }, expect: ['count'] },
    { name: 'coin above its minimum', assets: [tok(4, 1, 1)], over: true, settings: {}, expect: ['coin'] },
    { name: 'Value over V', assets: sortT(Array.from({ length: 200 }, (_, i) => ({ policy: policy(5 + (i % 2)), name: Buffer.from(`token-with-a-long-asset-name-${String(i).padStart(3, '0')}`).toString('hex'), qty: 1n }))), settings: { bundleSize: Infinity }, expect: ['value bytes'] },
    { name: 'policy isolation (fungible isolation on)', assets: sortT([tok(7, 1, 100), tok(7, 2, 100)]), settings: { isolateFungible: true }, expect: ['fungible isolation'] }
  ];
  for (const c of cases) {
    const st = built(base, [c]);
    const v = utxoVerdicts(T, st, params, c.settings);
    assert.equal(v.length, 1, c.name);
    const kinds = v[0].violations.map((x) => x.replace(/ .*/, '')).join();
    if (c.expect.length === 0) assert.deepEqual(v[0].violations, [], c.name);
    else {
      const text = v[0].violations.join('; ');
      for (const e of c.expect) assert.ok(text.startsWith(e) || text.includes(e), `${c.name}: expected ${e} in "${text}" (${kinds})`);
      assert.equal(v[0].violations.length, c.expect.length, `${c.name}: only the named rule breaks, got "${text}"`);
    }
    // The coin-free count differs only for the coin rule.
    const without = v[0].violations.filter((x) => !x.startsWith('coin'));
    assert.deepEqual(v[0].violationsNoCoin, without, `${c.name}: coin-free violations`);
    const s = conformingShare(T, st, params, c.settings);
    assert.equal(s.tokenUtxos, 1);
    assert.equal(s.conforming, c.expect.length ? 0 : 1, c.name);
    assert.equal(s.conformingNoCoin, c.name === 'coin above its minimum' || !c.expect.length ? 1 : 0, c.name);
  }
});
