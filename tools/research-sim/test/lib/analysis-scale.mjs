// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A study of corpus scale for the analyze command, written wallet by wallet by
// the fixture builder: per frame (recent and peak) `sampleN` sampled wallets
// (confirmation, draw kind random) and `pilotN` pilot wallets (exploration, kind
// pilot) in the quotas' group shares, every library's two arms and the rule's
// two arms at their repetitions (10 for the eight random libraries, 192 runs a
// wallet), a census, the carried reports and one machine record. Synthetic ids
// and numbers only; the outcomes come from a deterministic hash, so a study is
// the same bytes every time.
//
// Intents per wallet are drawn across the history cap (1,000) by group:
//   B0 5 to 40, B1 30 to 150, B2 100 to 400, B3 400 to 1,000 (a wallet at 1,000
//   is capped), uniformly within each range.
// The sample's size groups follow the quotas per 1,000 (B1 100, B2 10, B3 2, B0 the
// rest) and the pilot's B1 10, B2 1, B3 1, B0 the rest, scaled to the counts asked.

import { writeStudy, fullJobs, built, failed, infeasible, TX } from './analysis-fixtures.mjs';

const HISTORY_CAP = 1000;
const RANGES = { B0: [5, 40], B1: [30, 150], B2: [100, 400], B3: [400, 1000] };

// A deterministic hash to [0, 1).
function unit(...parts) {
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

// The wallets' groups in order: the quotas scaled to n, the rest in B0.
export function groupsFor(n, quotaPer1000 = { B1: 100, B2: 10, B3: 2 }, atLeastOne = false) {
  const counts = {};
  let rest = n;
  for (const g of ['B1', 'B2', 'B3']) {
    const c = Math.max(atLeastOne ? 1 : 0, Math.floor((quotaPer1000[g] * n) / 1000 + 0.5));
    counts[g] = c;
    rest -= c;
  }
  counts.B0 = rest;
  return counts;
}

function draw(sample, pilot) {
  const mk = (counts, scale) => ({
    B0: { quota: null, nDrawn: counts.B0 * 100, nTaken: counts.B0 },
    B1: { quota: Math.round(scale.B1), nDrawn: counts.B1 * 90, nTaken: counts.B1 },
    B2: { quota: Math.round(scale.B2), nDrawn: counts.B2 * 80, nTaken: counts.B2 },
    B3: { quota: Math.round(scale.B3), nDrawn: Math.max(counts.B3, 1) * 75, nTaken: Math.max(counts.B3, 1) }
  });
  return {
    quotaScale: '1',
    sampleN: sample.B0 + sample.B1 + sample.B2 + sample.B3,
    historyCap: HISTORY_CAP,
    groups: mk(sample, { B1: sample.B1, B2: sample.B2, B3: sample.B3 }),
    pilot: { quotaScale: '1', sampleN: pilot.B0 + pilot.B1 + pilot.B2 + pilot.B3, historyCap: HISTORY_CAP, groups: mk(pilot, { B1: pilot.B1, B2: pilot.B2, B3: pilot.B3 }) }
  };
}

const TYPES = ['T1', 'T2', 'T3', 'T4'];

// One wallet's spends of one job: a built spend with a fee that depends on the
// arm and the wallet, some failures, a few infeasible intents.
function spendsOf(wid, method, arm, rep, n) {
  const failRate = arm === 'own' ? 0.06 : arm === 'layout' ? 0.04 : arm === 'on' ? 0.03 : 0.035;
  const out = [];
  for (let k = 0; k < n; k++) {
    const u = unit(wid, method, arm, rep, k);
    const type = TYPES[Math.floor(unit(wid, 'type', k) * TYPES.length)];
    if (u < 0.02) out.push(infeasible(k));
    else if (u < 0.02 + failRate) out.push(failed(k, ['change-minimum', 'fee-minimum', 'balance', 'tx-size'][Math.floor(unit(wid, method, arm, rep, k, 'c') * 4)], 'kit: failed', { type }));
    else {
      const base = 180000 + Math.floor(unit(wid, 'fee', k) * 60000);
      const shift = arm === 'own' ? 12000 : arm === 'layout' ? 0 : arm === 'on' ? -9000 : -3000;
      const chained = arm === 'on' && unit(wid, 'chain', k) < 0.02;
      out.push(built(k, { type, fee: base + shift + rep, ...(chained ? { txs: 2, walletFee: base - 20000 } : {}), consumed: 1 + Math.floor(unit(wid, 'in', k) * 3), changeCount: 1 + Math.floor(unit(wid, 'ch', k) * 3), utxos: 3 + (k % 40), bytesAfter: 200 + (k % 500), locked: 1000000 * (k % 9), perToken: k % 3 === 0 ? null : 500000 + 1000 * (k % 50), tokens: k % 11, ms: 5 + Math.floor(unit(wid, method, arm, rep, k, 'ms') * 400), spendable: 2 + (k % 120) }));
    }
  }
  return out;
}

function* walletsOf(frame, split, kind, counts, firstId) {
  let id = firstId;
  for (const g of ['B0', 'B1', 'B2', 'B3']) {
    for (let i = 0; i < counts[g]; i++, id++) {
      const [lo, hi] = RANGES[g];
      const n = Math.min(HISTORY_CAP, lo + Math.floor(unit(id, 'n') * (hi - lo + 1)));
      yield {
        id,
        split,
        kind,
        group: g,
        capped: n >= HISTORY_CAP,
        flags: { fragmented: unit(id, 'frag') < 0.3, franken_any: unit(id, 'fr') < 0.05, franken_no_cospend: unit(id, 'nc') < 0.04, prior_treated: unit(id, 'pt') < 0.03 },
        intents: Array.from({ length: n }, () => ({})),
        jobs: fullJobs(() => [], { reps: 10 }).map((j) => ({ ...j, spends: () => spendsOf(id, j.method, j.arm, j.rep, n) }))
      };
    }
  }
}

// Writes the study under root as preprod/<runId>. Returns the counts.
export function writeScaleStudy(root, { runId = 'scale', sampleN = 1000, pilotN = 100, censusN = 20000, windows = ['recent', 'peak'], say = () => {} } = {}) {
  const sample = groupsFor(sampleN);
  const pilot = groupsFor(pilotN, { B1: 100, B2: 10, B3: 10 }, true);
  const d = draw(sample, pilot);
  const census = Array.from({ length: censusN }, (_, i) => ({ wallet: 5000000 + i, utxos: 1 + Math.floor(unit(i, 'u') * 400), tokenUtxos: Math.floor(unit(i, 't') * 20), largestValueBytes: 80 + Math.floor(unit(i, 'b') * 4800), nearCap50: unit(i, 'n50') < 0.05, nearCap80: unit(i, 'n80') < 0.01, nearCap90: unit(i, 'n90') < 0.004, lockedAda: String(Math.floor(unit(i, 'l') * 300) * 1000000), excessAda: String(Math.floor(unit(i, 'e') * 50) * 1000000), coin: String(Math.floor(unit(i, 'c') * 20000) * 1000000) }));
  let firstId = 7000000;
  for (const window of windows) {
    const wallets = (function* () {
      yield* walletsOf(window, 'exploration', 'pilot', pilot, firstId);
      yield* walletsOf(window, 'confirmation', 'random', sample, firstId + 100000);
    })();
    say(`writing ${window}: ${sampleN} sampled and ${pilotN} pilot wallets`);
    writeStudy(root, {
      network: 'preprod',
      runId,
      window,
      draw: d,
      analysisFreezeTx: TX,
      wallets,
      census: window === 'recent' ? census : undefined,
      carried: window === 'recent' ? true : undefined,
      machines: [{ label: 'scale', invocations: [{ workers: 4, cpuModel: 'Scale CPU', logicalCores: 8, completed: [] }], log: [] }]
    });
  }
  return { sample, pilot, windows };
}
