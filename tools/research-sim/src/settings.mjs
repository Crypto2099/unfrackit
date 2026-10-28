// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The simulator's readings of rules that admit more than one: each is a named
// setting whose default is the reading this code implements, so a different
// answer changes one value. A value that is not implemented is refused, never
// silently ignored. The history reader keeps its own readings in
// history/settings.mjs, recorded in each history file's header; these are the
// replay's and the batteries'. A phase-2-invalid transaction is the history
// reader's to write or leave out (its setting phase2Invalid); the replay
// engine replays every one a history holds as a forfeit.
//
// Every run records the values it ran under.

export const SIM_SETTINGS = Object.freeze({
  // The change address of every arm and method. 'latest-key-base-received':
  // the address of the latest output (largest creating transaction id, then
  // output index) at a key payment credential and a base address, its
  // credential not franken-flagged, among every output the wallet has
  // received on the chain up to the point of use, the real wallet's own
  // change included, so it moves as later outputs arrive and is the same in
  // every arm; a wallet that spends or holds a spendable UTxO before the
  // first such output, or never receives one, is refused.
  changeAddress: 'latest-key-base-received',
  // Serialization. 'own': a method that returns whole transaction bytes keeps
  // its own serialization, with synthetic witnesses in the same encoding; a
  // selection-only method is assembled by the ledger kit with CSL.
  serialization: 'own',
  // Battery draws. 'pool': the ADA amounts and fungible shares are drawn from
  // a pool frozen with the simulator (for the study, the pooled spends of the
  // exploration split's recent window), one mulberry32 generator per wallet
  // and spend kind, seeded from the first four bytes, read big-endian, of
  // SHA-256("battery" || 28-byte stake credential || the spend kind's ASCII
  // name); choices only among spendable holdings.
  batteryDraws: 'pool',
  // External recipients. 'synthetic-base': fixed synthetic base addresses
  // with key payment and key stake parts, distinct per payroll recipient,
  // identical for every method and wallet, with a stake part that is no
  // wallet's.
  recipients: 'synthetic-base',
  // A requested token output over the value-size limit. 'split': as many
  // requested outputs as needed, in policy and asset-name order, each at its
  // minimum, identical for every method.
  oversizeRequest: 'split',
  // Infeasible by balance. 'exact': the exact test of the H-12 rule's
  // "balance suffices", for every battery.
  infeasible: 'exact',
  // H-10's payment on the tidy layout. 'observed': p of the observed layout's
  // ADA balance in both layouts, so both build the same intent.
  h10Amount: 'observed',
  // A build failure that fits none of the named classes. 'other': its own
  // class, with the error text.
  unclassified: 'other',
  // Substituted change the selector's inputs cannot fund. 'fail': the spend
  // fails with class change-minimum.
  substitutedChange: 'fail',
  // Random sources. 'mulberry32': seeded with the seed number for a
  // selector; random layouts seeded with the repetition number.
  rng: 'mulberry32',
  // Which collateral a replayed script spend uses. 'smallest': the smallest
  // UTxO eligible under the arm's rule that is not a fixed input of the spend
  // and covers the collateral of the largest fee the spend can have, ties by
  // txid#index, set aside before selection so that no method spends it as an
  // input, always with a collateral return output and the total-collateral
  // field. The Evolution SDK's methods have nothing set aside: their library
  // chooses its own collateral (methods/contract.mjs choosesOwnCollateral).
  collateralChoice: 'smallest',
  // Where the in-burst constraint applies. 'separate': only in a separate
  // pass at each parallel burst, from the state at its start, for burst
  // feasibility and H-6's rescue test; the sequential replay continues for
  // fees.
  burstPass: 'separate',
  // What H-3's replay records per policy. 'per-spend-and-window': per spend
  // and policy, the bytes and fee of the policy's tokens recreated in change;
  // per window, the time-averaged minimum ADA of the outputs holding it,
  // shared pro rata by its bytes in mixed outputs.
  policyRecord: 'per-spend-and-window',
  // Minimum and value bytes of UTxOs already held. 'ledger': value bytes by
  // the ledger's re-serialization of the Value, the minimum by CSL on the
  // output.
  heldBytes: 'ledger',
  // The order in which a wallet's UTxOs are given to the treatment.
  // 'ref': transaction id bytes, then output index, ascending, the ledger's
  // UTxO order and the order the naive-tidy control is decided to take. The
  // planner's plans depend on this order where coins tie.
  treatmentOrder: 'ref',
  // Held UTxOs and the treatment. 'flagged': they are given to the planner
  // and the H-12 rule marked held, which neither ever spends, so that asset
  // classification counts them as the study's rules require.
  heldToTreatment: 'flagged',
  // cardano-js-sdk's tokenBundleSizeExceedsLimit callback is given a token
  // bundle without its coin. 'widest': the bundle's Value is measured with its
  // coin at the widest encoding (9 bytes), as the library's own default
  // constraint measures it, so a bundle it accepts fits whatever coin the
  // change output then carries.
  cjsBundleCoin: 'widest'
});

const IMPLEMENTED = {
  changeAddress: ['latest-key-base-received'],
  serialization: ['own'],
  batteryDraws: ['pool'],
  recipients: ['synthetic-base'],
  oversizeRequest: ['split'],
  infeasible: ['exact'],
  h10Amount: ['observed'],
  unclassified: ['other'],
  substitutedChange: ['fail'],
  rng: ['mulberry32'],
  collateralChoice: ['smallest'],
  burstPass: ['separate'],
  policyRecord: ['per-spend-and-window'],
  heldBytes: ['ledger'],
  treatmentOrder: ['ref'],
  heldToTreatment: ['flagged'],
  cjsBundleCoin: ['widest']
};

export function simSettings(overrides = {}) {
  const s = { ...SIM_SETTINGS };
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in SIM_SETTINGS)) throw new Error(`unknown setting ${k}`);
    if (!IMPLEMENTED[k].includes(v)) throw new Error(`setting ${k}=${v} is not implemented (implemented: ${IMPLEMENTED[k].join(', ')})`);
    s[k] = v;
  }
  return Object.freeze(s);
}
