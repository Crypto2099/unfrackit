// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Arms: a wallet's starting layout at the window start, how it is maintained,
// and the planner settings it is laid out with.
//
// Starting layouts:
//   observed         the wallet as it was (untidied)
//   tidy-once        the planner's full plan at the arm's settings applied at
//                    the window start, its fees charged
//   maintained-tidy  as tidy-once, then re-planned every 30 days of block time
//                    (the history's marks), any proposed plan applied and
//                    charged
//   naive-tidy       H-1's naive-tidy control, applied once at the start with
//                    its plan fees charged: every token, classes together,
//                    packed next-fit in the wallet's UTxO order (txid#index
//                    ascending) under the count and value caps, all pure ADA
//                    into one output (planner setting control 'naive')
//   random-tidy      H-1's count-matched random control, applied once at the
//                    start with its plan fees charged: the tidy layout's token
//                    output count, tokens dealt at random under the caps,
//                    seeded with the repetition number (control 'random')
// The plan fees of every arm are recorded apart from its spends' fees.
//
// Variants are the planner's settings varied as each hypothesis names, each
// with every other setting at the decided defaults (planner2.mjs
// DEFAULT_SETTINGS2): H-2's groupings, H-3's bundle sizes, H-4's three
// layouts, H-5's reserve rules R0 to R6, H-6's thresholds and never-propose
// arm, and H-1's ablations. A variant's seed, where it has one (H-2's random
// grouping), is the repetition number, as the random control's is.

export const BASE_ARMS = Object.freeze(['observed', 'tidy-once', 'maintained-tidy', 'naive-tidy', 'random-tidy']);

const ADA_BAND = (lo, hi) => [lo, hi];

// name -> planner settings (or a function of the repetition seed).
export const VARIANTS = Object.freeze({
  default: {},
  // H-2: grouping keys, and byte-optimal packing that ignores policy.
  'grouping-arrival': { grouping: 'arrival' },
  'grouping-policy-arrival': { grouping: 'policy-arrival' },
  'grouping-random': (seed) => ({ grouping: 'random', groupingSeed: seed }),
  'byte-optimal': { maxUnlock: true },
  // H-3: bundle sizes 1, 5, 10, 30 (the default), 60 and cap, where cap is no
  // count cap with policy grouping kept (byte-optimal packing is maxUnlock).
  'bundle-1': { bundleSize: 1 },
  'bundle-5': { bundleSize: 5 },
  'bundle-10': { bundleSize: 10 },
  'bundle-30': { bundleSize: 30 },
  'bundle-60': { bundleSize: 60 },
  'bundle-cap': { bundleSize: Infinity },
  // H-4: no isolation (the default), isolation per asset, per policy.
  'isolation-asset': { isolateFungible: true, fungibleIsolation: 'asset' },
  'isolation-policy': { isolateFungible: true, fungibleIsolation: 'policy' },
  // H-5: reserve rules. R3 is the default ladder of 8.
  R0: { reserve: { count: 1 } },
  R1: { reserve: { rule: 'split' } },
  R2: { reserve: { rule: 'denominations' } },
  R3: {},
  R4: { reserve: { count: 4 } },
  R5: { reserve: { count: 12 } },
  R6: { reserve: { rule: 'none' }, rollupLovelace: false, pureAdaOnly: 'never' },
  // H-6: never propose a pure-ADA-only transaction; a 1 ADA dust threshold;
  // collateral bands of 3 to 6 and 5 to 20 ADA.
  'never-propose': { pureAdaOnly: 'never' },
  'dust-1': { dustAda: 1 },
  'band-3-6': { collateralBandAda: ADA_BAND(3, 6) },
  'band-5-20': { collateralBandAda: ADA_BAND(5, 20) }
});

// H-1's ablations (run only when H-1a is contradicted under any selector):
// tidy-once with bundle size 10, 30 and cap, byte-optimal packing in place of
// policy grouping, R0 in place of the reserve, fungible isolation on.
export const H1_ABLATIONS = Object.freeze(['bundle-10', 'bundle-30', 'bundle-cap', 'byte-optimal', 'R0', 'isolation-asset']);

// The planner settings of an arm and variant at a repetition.
export function armSettings(arm, variant, repetition) {
  if (!BASE_ARMS.includes(arm)) throw new TypeError(`unknown arm ${arm}`);
  const v = VARIANTS[variant];
  if (v === undefined) throw new TypeError(`unknown variant ${variant}`);
  const seed = repetitionSeed(repetition);
  const s = typeof v === 'function' ? v(seed) : v;
  if (arm === 'naive-tidy' || arm === 'random-tidy') {
    if (variant !== 'default') throw new TypeError(`the ${arm} control runs at the default settings only`);
    return arm === 'naive-tidy' ? { control: 'naive' } : { control: 'random', controlSeed: seed };
  }
  return s;
}

// A random layout's seed: the repetition number (mulberry32, setting rng).
export function repetitionSeed(repetition) {
  if (!Number.isSafeInteger(repetition) || repetition < 1) throw new TypeError('repetitions are numbered from 1');
  return repetition;
}

export const plansAtStart = (arm) => arm !== 'observed';
export const replansAtMarks = (arm) => arm === 'maintained-tidy';
// Whether a variant reads arrival keys (H-2), which the history's arrival
// table supplies for the tokens held at the window start.
export const needsArrival = (variant) => variant === 'grouping-arrival' || variant === 'grouping-policy-arrival';
