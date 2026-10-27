// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The simulator's readings of rules that admit more than one: each is a named
// setting whose default is the reading this code implements, so a different
// answer changes one value. A value that is not implemented is refused, never
// silently ignored. The history reader keeps its own readings in
// history/settings.mjs; these are the replay's and the batteries'.
//
// Every run records the values it ran under.

export const SIM_SETTINGS = Object.freeze({
  // The change address of every arm and method. 'latest-key-base': the
  // address of the wallet's most recently created output (largest creating
  // transaction id, then output index) at a key payment credential and a base
  // address, at the arm's start.
  changeAddress: 'latest-key-base',
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
  heldToTreatment: 'flagged'
});

const IMPLEMENTED = {
  changeAddress: ['latest-key-base'],
  serialization: ['own'],
  batteryDraws: ['pool'],
  recipients: ['synthetic-base'],
  oversizeRequest: ['split'],
  infeasible: ['exact'],
  h10Amount: ['observed'],
  unclassified: ['other'],
  substitutedChange: ['fail'],
  rng: ['mulberry32'],
  heldBytes: ['ledger'],
  treatmentOrder: ['ref'],
  heldToTreatment: ['flagged']
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
