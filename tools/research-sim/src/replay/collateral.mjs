// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Collateral for a replayed script spend: which of an arm's UTxOs are eligible
// under each collateral rule, whether any is available at a script
// interaction, and which one a spend uses.
//
// The rules (each arm runs under one; availability is recorded under all):
//   ledger          a pure-ADA UTxO of at least 5 ADA that is not an input of
//                   the spend, with a collateral return output
//   practice        a pure-ADA UTxO of 5 to 20 ADA that is not an input of the
//                   spend, as wallets keep a dedicated collateral UTxO
//   ledger-minimum  (sensitivity) a pure-ADA UTxO whose coin is at least
//                   collateralPercent of the observed fee, not an input of the
//                   spend
//   token-bearing   (sensitivity) any spendable UTxO at a key address, its
//                   tokens given back by the return output, which the
//                   transaction pays for in full: the most the ledger allows
//
// The ledger's own conditions, which every rule's choice must also meet
// (IntersectMBO/cardano-ledger at 391db20866113f08bc6317cb5c341304365986c6,
// eras/babbage/impl/src/Cardano/Ledger/Babbage/Rules/Utxo.hs:231-308,
// validateTotalCollateral and validateCollateralContainsNonADA;
// eras/babbage/impl/src/Cardano/Ledger/Babbage/Collateral.hs:30-39,
// collAdaBalance): every collateral input at a key address, the balance
// (inputs less the return) ADA only and at least collateralPercent of the fee,
// at most maxCollateralInputs inputs, and the return output an ordinary output
// subject to the minimum and the value-size limit. Collateral inputs are
// spending inputs for the witness rule, so each needs its payment key's vkey
// witness (eras/alonzo/impl/src/Cardano/Ledger/Alonzo/TxBody.hs:307-313,
// alonzoSpendableInputsTxBodyF; eras/shelley/impl/src/Cardano/Ledger/Shelley/
// UTxO.hs:205-227, inputAuthors).
//
// The choice (setting collateralChoice 'smallest'): the smallest eligible UTxO
// by coin, ties by txid#index, one collateral input, always with a collateral
// return output and the total-collateral field, the practice CIP-30's
// deprecation notice for getCollateral asks of a dApp (CIP-0030, "(DEPRECATED)
// api.getCollateral"; CIP-0040, "Specification", for the return output). The
// total collateral is ceiling(collateralPercent * fee / 100). A UTxO whose
// return would fall under its minimum is passed over for the next, unless the
// return would be exactly zero, when the transaction carries no return output.

import { spendable, cmpRef } from '../state/state.mjs';

export const COLLATERAL_RULES = Object.freeze(['ledger', 'practice', 'ledger-minimum', 'token-bearing']);
// The two confirmatory candidates; the collateral measurement chooses one.
export const CONFIRMATORY_RULES = Object.freeze(['ledger', 'practice']);

const ADA = 1000000n;
const byCoin = (a, b) => (a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : cmpRef(a.ref, b.ref));

export function checkRule(rule) {
  if (!COLLATERAL_RULES.includes(rule)) throw new TypeError(`unknown collateral rule ${rule}`);
  return rule;
}

// The total collateral a fee needs: ceiling(collateralPercent * fee / 100).
export function totalCollateralFor(params, fee) {
  const n = BigInt(params.collateralPercent) * BigInt(fee);
  return (n + 99n) / 100n;
}

// The UTxOs of `state` eligible under `rule`, smallest first. exclude: refs
// that are inputs of the spend; observedFee: the intent's observed fee (the
// ledger-minimum rule).
export function eligibleCollateral(state, params, rule, { exclude = new Set(), observedFee = null } = {}) {
  checkRule(rule);
  const out = [];
  for (const u of spendable(state)) {
    if (exclude.has(u.ref)) continue;
    const pure = u.assets.length === 0;
    if (rule === 'ledger' && !(pure && u.coin >= 5n * ADA)) continue;
    if (rule === 'practice' && !(pure && u.coin >= 5n * ADA && u.coin <= 20n * ADA)) continue;
    if (rule === 'ledger-minimum') {
      if (observedFee === null) throw new Error('the ledger-minimum collateral rule needs the observed fee');
      if (!(pure && 100n * u.coin >= BigInt(params.collateralPercent) * BigInt(observedFee))) continue;
    }
    out.push(u);
  }
  return out.sort(byCoin);
}

// Whether any UTxO is eligible under each rule: the collateral availability
// recorded at every script interaction, before the spend.
export function collateralAvailability(state, params, { exclude = new Set(), observedFee = null } = {}) {
  const out = {};
  for (const r of COLLATERAL_RULES) {
    if (r === 'ledger-minimum' && observedFee === null) out[r] = null;
    else out[r] = eligibleCollateral(state, params, r, { exclude, observedFee }).length > 0;
  }
  return out;
}
