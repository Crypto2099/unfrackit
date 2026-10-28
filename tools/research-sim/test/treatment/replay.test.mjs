// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The replay engine on the synthetic intent streams (shapes/streams.mjs) of
// the 21 shapes, under every arm and variant the planner expresses (the test
// plan, arms/plan.mjs) with the test method:
//   - every replayed transaction meets the kit's checks (no kit failure on an
//     answer), CSL reads it, and the four negative controls are caught on it
//     for their own reasons; CSL's re-serialization has the transaction's
//     inputs, fee and witness count byte for byte and its outputs by decoded
//     content (CSL writes the asset names of one policy shortest first, this
//     tool by bytes, so the bytes of an output can differ; counted as
//     cslOutputBytes), and the transactions it re-encodes are counted
//     (cslReencoded);
//   - events land where they belong: the deposits before the spends that use
//     them, held consumption, the two 30-day marks, the maintained-tidy arm's
//     re-plans at exactly those marks and no other arm's, the burst pass, the
//     forfeit and the two self-reorganizations counted, the reward withdrawal
//     of one deposited at the change address the stream names at it and held
//     by the next spend's state;
//   - the change address moves once, at the deposit to the wallet's second
//     address, and every change output of a replayed spend lands at the
//     address the stream names at it;
// Needs RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatment, skip } from '../lib/treatment.mjs';
import { negativeControls, EXPECTED } from '../lib/controls.mjs';
import { SHAPE_NAMES } from '../../src/shapes/shapes.mjs';
import { loadSource } from '../../src/replay/source.mjs';
import { replay, fixedExtraWitnesses, withdrawalDeposit } from '../../src/replay/engine.mjs';
import { makeMethod } from '../../src/methods/registry.mjs';
import { testPlan, mergePlan } from '../../src/arms/plan.mjs';
import { fixedResolver } from '../../src/kit/apply.mjs';
import { inspectTx } from '../../src/kit/inspect.mjs';
import { parseAddress, addressBytes } from '../../src/history/address.mjs';
import { addressTextOf } from '../../src/state/utxo.mjs';
import { requestedIndexes } from '../../src/replay/measure.mjs';
import { settle } from '../../src/kit/heap.mjs';

const T = await treatment();
const DAY = 86400;
// Left out, and reported: on M3, the planner at the random grouping exhausts
// the JavaScript heap planning the end state for the conformity measure,
// after every intent has built. The treatment's case, not the engine's.
const LEFT_OUT = new Set(['M3 tidy-once grouping-random']);

// An output by what it holds: address, coin, assets as a set, datum and script
// reference.
const content = (o) => JSON.stringify({
  address: Buffer.from(o.address).toString('hex'),
  coin: o.coin,
  assets: [...o.assets].map((a) => ({ policy: a.policy, name: a.name, qty: a.qty })).sort((x, y) => (x.policy + x.name < y.policy + y.name ? -1 : x.policy + x.name > y.policy + y.name ? 1 : 0)),
  datum: o.datum,
  scriptRef: o.scriptRef
}, (_, v) => (typeof v === 'bigint' ? `${v}n` : v && v.type === 'Buffer' ? Buffer.from(v.data).toString('hex') : v));

test('the synthetic streams replay under every arm the planner expresses, every transaction checked, every event in place', { skip, timeout: 3 * 3600 * 1000 }, async (t) => {
  const method = makeMethod(T, 'test-largest-first');
  const entries = mergePlan(testPlan({ reps: 1 }));
  const counts = { shapes: 0, replays: 0, refused: {}, outcomes: {}, classes: {}, kitFailures: 0, txs: 0, controls: 0, plans: { start: 0, marks: 0 }, bursts: { passes: 0, feasible: 0 }, forfeits: 0, triggers: 0, collateralRecorded: 0 };
  const bad = [];
  for (const name of SHAPE_NAMES) {
    const src = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    counts.shapes++;
    for (const e of entries) {
      if (LEFT_OUT.has(`${name} ${e.arm} ${e.variant}`)) {
        counts.leftOut = (counts.leftOut || 0) + 1;
        continue;
      }
      await settle();
      for (const collateralRule of ['ledger', 'practice']) {
        const r = await replay(T, src.params, src, { arm: e.arm, variant: e.variant, repetition: 1, method, opts: { seed: 1, changePolicy: e.change, collateralRule }, settleEvery: 25, policyLock: e.policyLock, keepTx: true });
        counts.replays++;
        if (r.refused) {
          counts.refused[r.refused.slice(0, 60)] = (counts.refused[r.refused.slice(0, 60)] || 0) + 1;
          continue;
        }
        const label = `${name} ${e.arm}/${e.variant}/${e.change}/${collateralRule}`;
        // Events in place.
        const s = r.summary.counts;
        if (s.deposits !== 2 || s.marks !== 2 || s.selfReorganizations !== 2 || s.withdrawalDeposits !== 1) bad.push(`${label}: deposits ${s.deposits}, marks ${s.marks}, reorganizations ${s.selfReorganizations}, withdrawal deposits ${s.withdrawalDeposits}`);
        // The withdrawal's deposit, as the first built spend after it sees it.
        const wd = src.events.find((ev) => ev.kind === 'self-reorganization' && ev.withdrawal);
        const after = r.spends.find((x) => x.outcome === 'built' && x.t > wd.time.blockTime);
        if (after) {
          const want = withdrawalDeposit({ changeAddress: wd.changeAddress, franken: new Set() }, wd);
          const got = after.built.before.utxos.get(want.ref);
          if (!got || got.coin !== wd.withdrawal || got.address !== wd.changeAddress) bad.push(`${label}: the withdrawal's deposit is not in the state of the next spend`);
          else counts.withdrawalsSeen = (counts.withdrawalsSeen || 0) + 1;
        }
        if (s.changeAddressMoves !== 1) bad.push(`${label}: the change address moved ${s.changeAddressMoves} times`);
        if (s.heldConsumed + s.heldMissing !== 1) bad.push(`${label}: the held UTxO is consumed ${s.heldConsumed} times and missing ${s.heldMissing}`);
        const ts = r.spends.map((x) => x.t);
        if (ts.some((x, i) => i && x < ts[i - 1])) bad.push(`${label}: spends out of order`);
        const atMarks = r.plans.filter((p) => p.at.startsWith('mark')).map((p) => p.t);
        if (e.arm === 'maintained-tidy') {
          if (atMarks.join() !== [30 * DAY, 60 * DAY].join()) bad.push(`${label}: re-plans at ${atMarks.join()}`);
        } else if (atMarks.length) bad.push(`${label}: an arm other than maintained-tidy re-planned`);
        const starts = r.plans.filter((p) => p.at === 'start').length;
        if ((e.arm === 'observed') !== (starts === 0)) bad.push(`${label}: ${starts} start plans`);
        counts.plans.start += starts;
        counts.plans.marks += atMarks.length;
        counts.bursts.passes += r.bursts.length;
        counts.bursts.feasible += r.bursts.filter((b) => b.feasible).length;
        counts.triggers += r.triggers.length;
        if (r.bursts.length !== 1 || r.bursts[0].spends !== 2) bad.push(`${label}: burst passes ${JSON.stringify(r.bursts)}`);
        for (const x of r.spends) {
          counts.outcomes[x.outcome] = (counts.outcomes[x.outcome] || 0) + 1;
          if (x.class) counts.classes[x.class] = (counts.classes[x.class] || 0) + 1;
          if (x.outcome === 'forfeit') counts.forfeits++;
          if (x.collateralAvailable) counts.collateralRecorded++;
          if (x.detail && /^kit:/.test(x.detail)) {
            counts.kitFailures++;
            bad.push(`${label} intent ${x.intent}: ${x.detail}`);
          }
          if (x.outcome !== 'built') continue;
          const event = src.events.filter((ev) => ev.kind === 'intent')[x.intent];
          const intent = event.intent;
          const spendTx = inspectTx(x.built.txs[x.built.txs.length - 1].bytes);
          const req = requestedIndexes(intent, spendTx);
          for (const o of spendTx.outputs) {
            if (req.has(o.index) || parseAddress(o.address).stake !== src.stakeCred) continue;
            counts.changeOutputs = (counts.changeOutputs || 0) + 1;
            if (addressTextOf(o.address) !== event.changeAddress) bad.push(`${label} intent ${x.intent}: change output ${o.index} is not at the change address the stream names`);
          }
          const fixed = fixedResolver(intent.fixed);
          const view = (u) => u && { coin: u.coin, assets: u.assets, addr: parseAddress(addressBytes(u.address)) };
          for (const tx of x.built.txs) {
            counts.txs++;
            const resolve = (ref) => view(x.built.before.utxos.get(ref)) || fixed.get(ref);
            const c = negativeControls(x.built.before, src.params, tx.bytes, { resolve, implicit: intent.implicit, scriptFee: intent.fixed ? intent.fixed.scriptFee : 0n, extraWitnesses: fixedExtraWitnesses(intent) });
            counts.controls++;
            for (const [k, v] of Object.entries(EXPECTED)) if (c[k] !== v) bad.push(`${label} intent ${x.intent}: control ${k} gave '${c[k]}'`);
            // CSL reads it. CSL writes some lists of fixed parts (certificates,
            // witness lists) as tagged sets, so its re-serialization may encode
            // a fixed part differently; the inputs, outputs and fee it writes
            // must be the transaction's.
            const ctx = T.CSL.Transaction.from_bytes(Buffer.from(tx.bytes, 'hex'));
            const again = inspectTx(Buffer.from(ctx.to_bytes()).toString('hex'));
            ctx.free();
            const mine = inspectTx(tx.bytes);
            if (again.hash !== mine.hash) counts.cslReencoded = (counts.cslReencoded || 0) + 1;
            const sameOutputs = again.outputs.length === mine.outputs.length && again.outputs.every((o, i) => content(o) === content(mine.outputs[i]));
            if (again.outputs.map((o) => o.raw.toString('hex')).join() !== mine.outputs.map((o) => o.raw.toString('hex')).join()) counts.cslOutputBytes = (counts.cslOutputBytes || 0) + 1;
            const same = again.fee === mine.fee && again.inputs.map((i) => i.ref).join() === mine.inputs.map((i) => i.ref).join() && sameOutputs && again.vkeys.length === mine.vkeys.length;
            if (!same) counts.cslDiffers = (counts.cslDiffers || 0) + 1;
          }
        }
      }
    }
  }
  t.diagnostic(JSON.stringify(counts));
  assert.deepEqual(bad.slice(0, 20), []);
  assert.equal(counts.kitFailures, 0);
  assert.equal(counts.cslDiffers || 0, 0, 'CSL re-serializes every replayed transaction with its inputs, fee, witness count and outputs by content');
});
