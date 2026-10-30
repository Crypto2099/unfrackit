// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Mesh's default against the cjs-rrri baseline, on the battery spends of the
// synthetic shapes. The study reports Mesh's default as covered by the
// baseline because both run the same input-selection code (0.14.28 and
// 0.14.35 share their source tree); but Mesh sums the requested outputs into
// one output before it calls roundRobinRandomImprove (cardano-sdk-adapter.ts
// at MeshJS/mesh c0b183ec, :139-143 and :391-408), and the library makes one
// change bundle per requested output, so on a payment with several outputs
// the two can make different change. Mesh also runs its own constraint
// callbacks, not the exact ones. Both are given the same seeded draws:
// cjs-rrri a mulberry32 generator seeded with s, Mesh Math.random replaced by
// the same generator for the build.
//
// For each spend and seed the record says whether each built, and when both
// did: whether the inputs are the same set, whether the change outputs hold
// the same assets in the same bundles, whether their coins are the same, the
// fees, and the draws each consumed. A spend with one requested output is
// 'single', one with more is 'multi'.

import { cjsMethod } from '../methods/cjs.mjs';
import { meshMethod } from '../methods/mesh.mjs';
import { inspectTx } from '../kit/inspect.mjs';
import { checkAndApply } from '../kit/apply.mjs';
import { addressTextOf } from '../state/utxo.mjs';
import { makeRng } from '../shapes/rng.mjs';
import { settle } from '../kit/heap.mjs';

const bundleKey = (o) => o.assets.map((a) => `${a.policy}.${a.name}=${a.qty}`).join(',');

function changeOf(bytes, state) {
  const t = inspectTx(bytes);
  return t.outputs.filter((o) => addressTextOf(o.address) === state.changeAddress);
}

export async function compareOne(T, state, intent, params, seed, methods = { cjs: cjsMethod(T), mesh: meshMethod() }) {
  let cjsDraws = 0;
  const rng = makeRng(seed);
  const random = () => {
    cjsDraws++;
    return rng.next();
  };
  await settle();
  const a = await methods.cjs.build(state, intent, params, { changePolicy: 'default', random });
  const b = await methods.mesh.build(state, intent, params, { changePolicy: 'default', seed });
  const shape = intent.requested.length > 1 ? 'multi' : 'single';
  const rec = { spend: intent.id, outputs: intent.requested.length, shape, seed, cjs: a.ok ? 'built' : a.class, mesh: b.ok ? 'built' : b.class, cjsDraws, meshDraws: b.ok ? b.library.draws : null };
  if (a.ok) rec.cjsKit = checkAndApply(state, params, a.txs, { implicit: intent.implicit }).ok;
  if (b.ok) rec.meshKit = checkAndApply(state, params, b.txs, { implicit: intent.implicit }).ok;
  if (!a.ok || !b.ok) return rec;
  const ia = a.txs[0].walletInputs.slice().sort();
  const ib = b.txs[0].walletInputs.slice().sort();
  rec.sameInputs = ia.join(' ') === ib.join(' ');
  const ca = changeOf(a.txs[0].bytes, state);
  const cb = changeOf(b.txs[0].bytes, state);
  rec.cjsChange = ca.length;
  rec.meshChange = cb.length;
  rec.sameBundles = ca.map(bundleKey).sort().join('|') === cb.map(bundleKey).sort().join('|');
  rec.sameCoins = ca.map((o) => o.coin).sort().join(',') === cb.map((o) => o.coin).sort().join(',');
  rec.cjsFee = a.txs[0].fee;
  rec.meshFee = b.txs[0].fee;
  return rec;
}

export function classify(rec) {
  if (rec.cjs !== 'built' || rec.mesh !== 'built') return rec.cjs === rec.mesh ? `both fail (${rec.cjs})` : `outcome differs (cjs ${rec.cjs}, mesh ${rec.mesh})`;
  if (!rec.sameInputs) return 'inputs differ';
  if (!rec.sameBundles) return 'same inputs, change bundles differ';
  if (!rec.sameCoins) return 'same inputs and bundles, change coins differ';
  return 'identical inputs and change';
}
