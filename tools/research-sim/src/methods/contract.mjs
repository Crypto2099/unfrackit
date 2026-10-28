// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The contract every selection method implements: the H-12 rule, the test
// method, and the baseline adapters.
//
//   { name, version, deterministic, build(state, intent, params, opts) }
//
//   opts     { seed, changePolicy ('default' | 'layout' | 'single' |
//            'naive'), collateralRule, absorb, collateral }
//            collateral: for a replayed script spend, the UTxO the engine set
//            aside under the arm's rule (replay/engine.mjs setAside); the
//            state the method is given does not hold it, and every
//            transaction the method assembles carries it as collateral
//   result   { ok: true, kind ('single' | 'chain'), txs [{ bytes (hex),
//            walletInputs [ref], fee, size, k, roles }] }
//            or { ok: false, class, detail }
//
// `build` may return a promise. The engine, not the method, runs the ledger
// kit's checks and applies each transaction (kit/apply.mjs); a method never
// sees the kit's verdict before it returns. A method's own exception and a
// failed kit check are both build failures; a method maps its library's
// errors to the failure classes (kit/check.mjs CLASSES), and three outcomes
// are counted apart from build failures: 'not-replayable', an intent the
// method has no way to express, and the engine's own 'infeasible' (the balance
// does not suffice) and 'infeasible-collateral' (a script spend with no
// collateral to set aside, or that cannot be paid without it).

import { CLASSES } from '../kit/check.mjs';

export const CHANGE_OPTIONS = Object.freeze(['default', 'layout', 'single', 'naive']);
export const NOT_REPLAYABLE = 'not-replayable';
export const RESULT_CLASSES = Object.freeze(new Set([...Object.values(CLASSES), NOT_REPLAYABLE]));

export function checkMethod(m) {
  if (!m || typeof m !== 'object') throw new TypeError('method: not an object');
  if (typeof m.name !== 'string' || !m.name) throw new TypeError('method: no name');
  if (typeof m.version !== 'string' || !m.version) throw new TypeError(`method ${m.name}: no version`);
  if (typeof m.deterministic !== 'boolean') throw new TypeError(`method ${m.name}: deterministic must be a boolean`);
  if (typeof m.build !== 'function') throw new TypeError(`method ${m.name}: no build function`);
  return m;
}

export function checkOptions(opts) {
  if (!CHANGE_OPTIONS.includes(opts.changePolicy)) throw new TypeError(`method options: unknown change policy ${opts.changePolicy}`);
  return opts;
}

// A result checked for its shape; a malformed one is the method's defect.
export function checkResult(m, r) {
  if (!r || typeof r.ok !== 'boolean') throw new TypeError(`method ${m.name}: the result has no ok`);
  if (!r.ok) {
    if (!RESULT_CLASSES.has(r.class)) throw new TypeError(`method ${m.name}: unknown failure class ${r.class}`);
    return r;
  }
  if (r.kind !== 'single' && r.kind !== 'chain') throw new TypeError(`method ${m.name}: kind ${r.kind}`);
  if (!Array.isArray(r.txs) || !r.txs.length) throw new TypeError(`method ${m.name}: no transactions`);
  if (r.kind === 'single' && r.txs.length !== 1) throw new TypeError(`method ${m.name}: a single answer with ${r.txs.length} transactions`);
  for (const t of r.txs) {
    if (typeof t.bytes !== 'string' || !/^[0-9a-f]+$/.test(t.bytes)) throw new TypeError(`method ${m.name}: transaction bytes are not hex`);
    if (!Array.isArray(t.walletInputs)) throw new TypeError(`method ${m.name}: no wallet inputs`);
    if (typeof t.fee !== 'bigint') throw new TypeError(`method ${m.name}: the fee is not a bigint`);
  }
  return r;
}
