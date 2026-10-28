// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// One wallet of the brute-force check, in a worker thread: every standard
// battery spend of the wallet under every policy, every subset of its
// spendable UTxOs evaluated exactly (the policy's own transaction, checked by
// the ledger kit) beside the lower bound of the oracle, and the oracle's own
// answer by each path. Posts one record per spend and policy.

import { parentPort, workerData } from 'node:worker_threads';
import { loadTreatment } from '../../src/treatment/bridge.mjs';
import { shapeState } from '../../src/shapes/shapes.mjs';
import { SYNTHETIC_PARAMS as P } from '../../src/kit/params.mjs';
import { standardBattery, SHAPE_POOLS } from '../../src/battery/battery.mjs';
import { makeState, spendable } from '../../src/state/state.mjs';
import { makeRng } from '../../src/shapes/rng.mjs';
import { makeEvaluator, setKey, loadLibraryPolicies } from '../../src/oracle/policies.mjs';
import { makeBoundModel, boundOf } from '../../src/oracle/bound.mjs';
import { candidateSet } from '../../src/oracle/spend.mjs';
import { oracleSettings } from '../../src/oracle/settings.mjs';
import { searchOracle } from '../../src/oracle/search.mjs';
import { settle } from '../../src/kit/heap.mjs';

const T = await loadTreatment(workerData.treatmentDir, workerData.pinsText || undefined);
const settings = oracleSettings();
const lib = await loadLibraryPolicies();

// A sub-wallet of k spendable UTxOs, 8 <= k <= 12, drawn with mulberry32.
function subWallet(state, seed) {
  const rng = makeRng(seed);
  const pool = spendable(state);
  const k = 8 + Math.floor(rng.next() * 5);
  const idx = pool.map((_, i) => i);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng.next() * (idx.length - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const utxos = idx.slice(0, k).map((i) => pool[i]);
  return makeState({ network: state.network, stakeCred: state.stakeCred, changeAddress: state.changeAddress, utxos, at: state.at });
}

parentPort.on('message', async (job) => {
  try {
    await settle();
    const base = shapeState(T, job.shape).state;
    const state = job.seed === null ? base : subWallet(base, job.seed);
    const pool = spendable(state);
    if (pool.length > 12) throw new Error(`${job.shape}: ${pool.length} spendable UTxOs`);
    const spends = standardBattery(T, state, P, { pools: SHAPE_POOLS }).filter((b) => !b.unsettled);
    for (const spend of spends) {
      for (const policy of job.policies) {
        const M = makeBoundModel(state, spend, P, settings);
        const ev = makeEvaluator(T, { state, spend, params: P, policy, settings, lib });
        const cs = candidateSet(state, spend);
        const candKeys = new Set(cs.all.map((u) => u.ref));
        const rec = { shape: job.shape, seed: job.seed, utxos: pool.length, spend: spend.id, policy, candidates: cs.all.length, subsets: 0, feasible: 0, boundAbove: 0, boundInfeasibleButBuilt: 0, minBoundGap: null, maxBoundGap: null };
        let globalBest = null;
        let candBest = null;
        const n = pool.length;
        const t0 = performance.now();
        for (let mask = 1; mask < 1 << n; mask++) {
          const S = [];
          for (let i = 0; i < n; i++) if (mask & (1 << i)) S.push(pool[i]);
          const e = await ev.evaluate(S);
          const bd = boundOf(M, S);
          rec.subsets++;
          if (e.ok) {
            rec.feasible++;
            if (bd.fee > e.fee) {
              rec.boundAbove++;
              if (!rec.boundAboveExample) rec.boundAboveExample = { set: setKey(S), bound: bd.fee.toString(), fee: e.fee.toString() };
            }
            if (!bd.feasible) {
              rec.boundInfeasibleButBuilt++;
              if (!rec.infeasibleExample) rec.infeasibleExample = { set: setKey(S), covers: bd.covers, coinIn: bd.coinIn.toString(), need: bd.need.toString(), bytes: bd.bytes };
            }
            const gap = Number(e.fee - bd.fee);
            if (rec.minBoundGap === null || gap < rec.minBoundGap) rec.minBoundGap = gap;
            if (rec.maxBoundGap === null || gap > rec.maxBoundGap) rec.maxBoundGap = gap;
            if (!globalBest || e.fee < globalBest.fee) globalBest = e;
            if (S.every((u) => candKeys.has(u.ref)) && (!candBest || e.fee < candBest.fee)) candBest = e;
          }
        }
        rec.bruteMs = Math.round(performance.now() - t0);
        ev.dispose();
        rec.globalMin = globalBest ? globalBest.fee.toString() : null;
        rec.candidateMin = candBest ? candBest.fee.toString() : null;
        const run = async (path, mipSpace) => {
          const o = await searchOracle(T, state, spend, P, policy, { timeLimitMs: job.limitMs, path, mipSpace, settings });
          return { status: o.status, fee: o.fee === null ? null : o.fee.toString(), ms: Math.round(o.ms), candidates: o.candidates, scope: o.scope, evaluations: o.evaluations.evaluations, detail: o.detail };
        };
        rec.auto = await run('auto');
        if (cs.exhaustive) rec.exhaustive = rec.auto;
        rec.mipCandidates = await run('mip', 'candidates');
        rec.mipSpendable = await run('mip', 'spendable');
        parentPort.postMessage({ type: 'record', id: job.id, record: rec });
      }
    }
    parentPort.postMessage({ type: 'done', id: job.id });
  } catch (e) {
    parentPort.postMessage({ type: 'error', id: job.id, message: String(e && (e.stack || e.message || e)) });
  }
});
parentPort.postMessage({ type: 'ready' });
