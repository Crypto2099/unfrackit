// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The oracle's readings of rules that admit more than one, each a named
// setting whose default is the reading this code implements, so that a
// different answer changes one value. A value that is not implemented is
// refused, never silently ignored. Every oracle result records the values it
// ran under.

export const ORACLE_SETTINGS = Object.freeze({
  // The search space. 'requested-plus-20': when the spendable UTxOs holding
  // any requested asset plus the 20 largest spendable pure-ADA UTxOs (by
  // coin, ties by txid#index ascending) number at most 24, exhaustive search
  // over exactly that set, followed as the setting afterExhaustive says;
  // otherwise the mixed-integer program over every spendable UTxO.
  searchSpace: 'requested-plus-20',
  // How a candidate set's change and fee are known. 'library-forced': the
  // change policy's own code builds the transaction with the set forced as
  // its inputs, and the ledger kit checks it; the exhaustive search is a
  // best-first branch and bound ordered by a proven lower bound on the fee,
  // and every set the mixed-integer program chooses is rebuilt exactly, with
  // a no-good cut on any set whose rebuild fails or whose fee is not the
  // program's.
  exactness: 'library-forced',
  // The solver of the mixed-integer program: HiGHS compiled to WebAssembly,
  // the npm package highs at exactly this version, single-threaded.
  solver: 'highs-1.15.4',
  // Incumbents. 'all-methods': each search starts from the transaction the
  // method under test built and from every other method's transaction with
  // the same change policy on the same spend, when it passed the kit's
  // checks, so the reference is never above a fee a method reached.
  incumbents: 'all-methods',
  // The fee a candidate set is scored by. 'as-built': the fee the policy's
  // transaction pays, which is the ledger minimum for every transaction the
  // ledger kit assembles (the layout-preserving change) and the library's own
  // fee for a library that sets it (cardano-serialization-lib, which counts
  // the validity flag and a 9-byte fee field in its estimate and burns an
  // ADA-only leftover below the change minimum into the fee).
  // 'ledger-minimum': minFeeA times the transaction's ledger size plus
  // minFeeB, whatever fee the transaction carries.
  setFee: 'as-built',
  // What follows an exhaustive search that completes within the limit.
  // 'mip-always': the mixed-integer program over every spendable UTxO takes
  // the rest of the time limit, starting from the best found so far (the
  // exhaustive result and the incumbents), and the lower fee is kept; the
  // status then speaks for every spendable UTxO, so a spend the candidate set
  // cannot build is not reported infeasible. 'mip': the program runs only
  // when the exhaustive search finds no feasible set. 'report': the
  // exhaustive result stands, its status speaking for the candidate set only.
  afterExhaustive: 'mip-always'
});

const IMPLEMENTED = {
  searchSpace: ['requested-plus-20'],
  exactness: ['library-forced'],
  solver: ['highs-1.15.4'],
  incumbents: ['all-methods'],
  setFee: ['as-built', 'ledger-minimum'],
  afterExhaustive: ['mip-always', 'mip', 'report']
};

// The exhaustive path's constants: the pure-ADA UTxOs it adds, and the
// largest candidate set it searches.
export const PURE_ADA_CANDIDATES = 20;
export const EXHAUSTIVE_MAX = 24;
// The time limit of one oracle run, and the margin after which the parent
// terminates a worker that has not returned.
export const TIME_LIMIT_MS = 60000;
export const TERMINATE_MARGIN_MS = 5000;

export function oracleSettings(overrides = {}) {
  const s = { ...ORACLE_SETTINGS };
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in ORACLE_SETTINGS)) throw new Error(`unknown oracle setting ${k}`);
    if (!IMPLEMENTED[k].includes(v)) throw new Error(`oracle setting ${k}=${v} is not implemented (implemented: ${IMPLEMENTED[k].join(', ')})`);
    s[k] = v;
  }
  return Object.freeze(s);
}
