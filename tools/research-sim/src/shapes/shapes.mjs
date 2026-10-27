// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The synthetic shapes as simulator states, with the planner settings each is
// run at and the settings variants it is checked under. The settings are the
// treatment harness's own for the 17 shapes it defines (S2b runs with roll-up
// off, M5 is S6 with maxUnlock on, S6 and M5 skip the maxUnlock variant);
// CL1, CL3, E1 and E2 run at the defaults.

import { generateShape, serializeShape, SHAPE_NAMES, HARNESS_SHAPES } from './generate.mjs';
import { utxoFromCbor } from '../state/utxo.mjs';
import { makeState } from '../state/state.mjs';
import { parseAddress, addressBytes } from '../history/address.mjs';

export { SHAPE_NAMES, HARNESS_SHAPES };

export const VARIANTS = Object.freeze({
  default: {},
  isolation: { isolateFungible: true, isolateNonfungible: true },
  maxUnlock: { maxUnlock: true }
});

const SHAPE_SETTINGS = {
  S2b: { rollupLovelace: false },
  M5: { maxUnlock: true }
};

export function variantsOf(name) {
  if (name === 'M5') return ['default'];
  if (name === 'S6') return ['default', 'isolation'];
  return ['default', 'isolation', 'maxUnlock'];
}

// The planner settings of a shape under a variant, as the harness builds them
// (shapes2.mjs newSettings).
export function shapeSettings(name, variant = 'default') {
  const s = { ...(name === 'M5' ? SHAPE_SETTINGS.M5 : {}), ...VARIANTS[variant] };
  if (name === 'S2b') s.rollupLovelace = false;
  return s;
}

// A shape as a state: network 'synthetic', the stake credential of the
// treatment's test addresses, the change address at payment key 0 (the
// harness's change address), every UTxO an initial one. `order` is the
// shape's generated order, which the harness's runners take.
export function shapeState(T, name) {
  const shape = generateShape(T, name);
  const hex = serializeShape(T, shape);
  const utxos = hex.map((h) => utxoFromCbor(h, { origin: 'initial' }));
  const change = T.cslkit.baseAddress(0);
  const changeAddress = change.to_bech32();
  const stakeCred = parseAddress(addressBytes(changeAddress)).stake;
  const state = makeState({ network: 'synthetic', stakeCred, changeAddress, utxos, at: { slot: 0, time: 0 } });
  return { name, shape, hex, order: utxos.map((u) => u.ref), state };
}
