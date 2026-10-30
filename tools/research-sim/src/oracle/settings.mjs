// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The oracle's readings of rules that admit more than one, each a named
// setting whose default is the reading this code implements, so that a
// different answer changes one value, and the work budget a call stops on.
// A value that is not implemented is refused, never silently ignored. Every
// oracle result records the values it ran under.

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
  // Incumbents. 'seeded-methods': each search starts from the transaction of
  // every run with the same change policy on the same spend that passed the
  // kit's checks, by a method whose answer is fixed by the seed it is given
  // (contract.mjs `seeded`: a deterministic method, or a random one that
  // draws from that seed), so the reference is never above a fee such a run
  // reached and does not depend on a draw no caller can repeat. An unseeded
  // run's fee is kept beside the reference and never seeds it.
  // 'all-methods': every method's passing run is an incumbent, the unseeded
  // ones included.
  incumbents: 'seeded-methods',
  // The fee a candidate set is scored by. 'as-built': the fee the policy's
  // transaction pays, which is the ledger minimum for every transaction the
  // ledger kit assembles (the layout-preserving change) and the library's own
  // fee for a library that sets it (cardano-serialization-lib, which counts
  // the validity flag and a 9-byte fee field in its estimate and burns an
  // ADA-only leftover below the change minimum into the fee).
  // 'ledger-minimum': minFeeA times the transaction's ledger size plus
  // minFeeB, whatever fee the transaction carries.
  setFee: 'as-built',
  // What follows an exhaustive search that completes within the budget.
  // 'mip-always': the mixed-integer program over every spendable UTxO takes
  // the rest of the budget, starting from the best found so far (the
  // exhaustive result and the incumbents), and the lower fee is kept; the
  // status then speaks for every spendable UTxO, so a spend the candidate set
  // cannot build is not reported infeasible. Under every value, a candidate
  // set that holds every spendable UTxO needs no program: the completed
  // exhaustive search speaks for the pool. 'mip': the program runs only
  // when the exhaustive search finds no feasible set. 'report': the
  // exhaustive result stands, its status speaking for the candidate set only.
  afterExhaustive: 'mip-always',
  // How a call stops. 'budget': on the work budget below, counted, so that a
  // call's result is the same for the same inputs and settings whatever the
  // load. 'wall-clock': at a time limit (the call's timeLimitMs, 60 seconds by
  // default), each solve capped at a tenth of it and a capped solve that finds
  // no set followed by one with all the time left; the work is still counted.
  // It is kept for measuring the work a time limit allows, in the oracle's
  // checks only.
  limit: 'budget',
  // The work budget, under limit 'budget'. maxCandidateSets: the candidate
  // sets one call evaluates exactly, the exhaustive search's evaluations and
  // the program's rebuilt sets together, so the program after a completed
  // exhaustive search takes the rest; the incumbents are evaluated apart and
  // not counted. maxSolves: the program's solves in one call. maxNodes: the
  // branch-and-bound nodes of all its solves together. maxSolveNodes: the
  // most nodes one solve takes (HiGHS mip_max_nodes) before it yields its
  // best set, unless a capped solve has found no set, when the next takes
  // every node left. Provisional values, to be sized by measurement.
  maxCandidateSets: 1500,
  maxSolves: 100,
  maxNodes: 20000,
  maxSolveNodes: 2000,
  // The guard: the parent terminates a worker whose call has not returned
  // this long after it started, a wall-clock backstop set well above any
  // budgeted call. A call it stops is undecided. Provisional.
  guardMs: 300000,
  // HiGHS's random_seed, set on every solve.
  solverSeed: 0
});

const IMPLEMENTED = {
  searchSpace: ['requested-plus-20'],
  exactness: ['library-forced'],
  solver: ['highs-1.15.4'],
  incumbents: ['seeded-methods', 'all-methods'],
  setFee: ['as-built', 'ledger-minimum'],
  afterExhaustive: ['mip-always', 'mip', 'report'],
  limit: ['budget', 'wall-clock']
};
// The numeric settings and the least value each takes; given as a string
// (from a command line or the environment), a value must be a whole number
// in decimal digits.
const NUMERIC = { maxCandidateSets: 1, maxSolves: 1, maxNodes: 1, maxSolveNodes: 1, guardMs: 1, solverSeed: 0 };
const INT32_MAX = 2147483647;

// The exhaustive path's constants: the pure-ADA UTxOs it adds, and the
// largest candidate set it searches.
export const PURE_ADA_CANDIDATES = 20;
export const EXHAUSTIVE_MAX = 24;
// Under limit 'wall-clock': the default time limit of one call, and the
// margin after which the parent terminates a worker that has not returned.
export const TIME_LIMIT_MS = 60000;
export const TERMINATE_MARGIN_MS = 5000;

function numeric(k, v) {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < NUMERIC[k] || n > INT32_MAX) throw new Error(`oracle setting ${k}=${v} is not implemented (a whole number from ${NUMERIC[k]} to ${INT32_MAX})`);
  return n;
}

export function oracleSettings(overrides = {}) {
  const s = { ...ORACLE_SETTINGS };
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in ORACLE_SETTINGS)) throw new Error(`unknown oracle setting ${k}`);
    if (k in NUMERIC) s[k] = numeric(k, v);
    else if (!IMPLEMENTED[k].includes(v)) throw new Error(`oracle setting ${k}=${v} is not implemented (implemented: ${IMPLEMENTED[k].join(', ')})`);
    else s[k] = v;
  }
  return Object.freeze(s);
}

// Whether a method's passing run may be an incumbent under the setting
// incumbents: method is { seeded } (methods/contract.mjs).
export function admitsIncumbent(settings, method) {
  if (settings.incumbents === 'all-methods') return true;
  if (settings.incumbents === 'seeded-methods') return method.seeded === true;
  throw new Error(`incumbents ${settings.incumbents} is not implemented`);
}
