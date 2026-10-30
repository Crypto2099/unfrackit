// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import { generate, SHAPE_NAMES } from './shapes.mjs';
import { walletFromMnemonic, policyFromMnemonic, sizingMnemonic } from './wallet.mjs';
import { planSeed } from './plan.mjs';
import { nativeScriptFor, DATUM_CBOR } from './outputs.mjs';
import * as store from './store.mjs';

// Each shape owns a block of 128 CIP-1855 policy indexes, so a shape's policy
// ids never change and never collide with another shape's. M3 uses 100.
export const POLICIES_PER_SHAPE = 128;

export function policiesFor(root, shapeName, placeholders) {
  const ordinal = SHAPE_NAMES.indexOf(shapeName);
  if (placeholders.length > POLICIES_PER_SHAPE) throw new Error('shape needs more policies than its block holds');
  return new Map(placeholders.map((p, i) => [p, policyFromMnemonic(root, ordinal * POLICIES_PER_SHAPE + i)]));
}

// Every policy the tool can mint under: all shapes' blocks of CIP-1855 indexes,
// keyed by policy id. Sweep burns tokens under these and returns the rest.
export function ownedPolicies(root) {
  const owned = new Map();
  for (let ix = 0; ix < SHAPE_NAMES.length * POLICIES_PER_SHAPE; ix++) {
    const p = policyFromMnemonic(root, ix);
    owned.set(p.policyId, p);
  }
  return owned;
}

export function funderWallet() {
  return walletFromMnemonic(store.readMnemonic('funder'), 1);
}

export function shapeWallet(shape) {
  return walletFromMnemonic(store.readMnemonic(shape.name), shape.keys);
}

// Plan a shape with throwaway keys and one huge virtual funding UTxO. Nothing
// secret is read, and the sizes and fees are those of the real transactions.
export function dryRun(shapeName, params) {
  const shape = generate(shapeName);
  const w = walletFromMnemonic(sizingMnemonic(), shape.keys);
  const plan = planSeed({
    shape,
    policyOf: policiesFor(w.root, shape.name, shape.policies),
    shapeKeys: w.keys,
    funder: { address: w.keys[0].address, sk: w.keys[0].sk },
    funding: [{ txHash: 'aa'.repeat(32), index: 0, coin: 10n ** 15n }],
    params
  });
  return { shape, plan };
}

// Pure-ADA funder UTxOs, largest first, enough to cover `need`.
export function pickFunding(utxos, need) {
  const pure = utxos.filter((u) => !u.assets.length && !u.refScript && !u.datumBytes && !u.datumHash).sort((a, b) => (a.coin < b.coin ? 1 : -1));
  const total = pure.reduce((s, u) => s + u.coin, 0n);
  if (total < need) return { short: need - total, total };
  const picked = [];
  let sum = 0n;
  for (const u of pure) {
    picked.push(u);
    sum += u.coin;
    if (sum >= need) break;
  }
  return { picked, total };
}

// The comparable signature of one UTxO.
function signature(keyIndex, coin, assets, datum, scriptHash) {
  const a = assets.map((x) => `${x.policy}.${x.name}:${x.qty}`).sort().join(',');
  return `key${keyIndex}|${coin}|${a}|${datum ? 'datum' : ''}|${scriptHash || ''}`;
}

// Compare what the shape wallet holds with what the generator specifies, up to
// the substitution of placeholder policy ids by the real ones.
export function compareWithShape(shape, policyOf, keys, actual) {
  const expected = new Map();
  const bump = (m, k, d) => m.set(k, (m.get(k) || 0) + d);
  for (const u of shape.utxos) {
    const assets = u.assets.map((a) => ({ policy: policyOf.get(a.policy).policyId, name: a.name, qty: a.qty }));
    const script = u.scriptRef ? nativeScriptFor(keys[u.key].hash).hash().to_hex() : null;
    bump(expected, signature(u.key, u.coin, assets, u.datum, script), 1);
  }
  const byAddress = new Map(keys.map((k) => [k.bech32, k.index]));
  const found = new Map();
  const stray = [];
  for (const u of actual) {
    const idx = byAddress.get(u.address);
    if (idx === undefined) {
      stray.push(u);
      continue;
    }
    const datum = u.datumBytes === DATUM_CBOR;
    if (u.datumBytes && !datum) stray.push(u);
    bump(found, signature(idx, u.coin, u.assets, datum, u.refScript ? u.refScript.hash : null), 1);
  }
  const missing = [];
  const unexpected = [];
  for (const [k, n] of expected) {
    const d = n - (found.get(k) || 0);
    if (d > 0) missing.push([k, d]);
  }
  for (const [k, n] of found) {
    const d = n - (expected.get(k) || 0);
    if (d > 0) unexpected.push([k, d]);
  }
  return {
    expectedCount: shape.utxos.length,
    actualCount: actual.length,
    missing,
    unexpected,
    stray: stray.length,
    ok: !missing.length && !unexpected.length && !stray.length && shape.utxos.length === actual.length
  };
}

