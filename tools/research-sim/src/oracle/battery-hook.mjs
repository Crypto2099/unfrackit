// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The oracle as the battery runner's hook (runBatteries in
// replay/run.mjs): policyOf maps a method's change to an oracle policy this
// build can evaluate, and reference runs the oracle on one spend in a worker
// and returns the result as a record field (oracleRecord).
//
//   const hook = await createBatteryOracle({ treatmentDir, pinsText, workers,
//     limitMs, settings })
//   ... runBatteries(T, pool, { ..., oracle: hook }) ...
//   await hook.close()

import { createOracle } from './oracle.mjs';
import { availablePolicies, policyOfMethod } from './policies.mjs';
import { oracleSettings, TIME_LIMIT_MS } from './settings.mjs';
import { OracleRefusal } from './spend.mjs';
import { scrubText } from '../out/records.mjs';

// What a record keeps of an oracle result: the status, its scope and bound,
// the paths that ran, which of them produced the reference, why the program
// stopped, the incumbents' outcomes, and the reference transaction's size and
// fee parts. It keeps neither the transaction's bytes nor its hash nor its
// input references: a record names no transaction (out/records.mjs).
export function oracleRecord(r) {
  const b = r.best;
  const mip = r.detail && r.detail.mip ? r.detail.mip : r.detail;
  return {
    status: r.status,
    path: r.path ?? null,
    paths: r.paths ?? null,
    scope: r.scope ?? null,
    candidates: r.candidates ?? null,
    candidateSet: r.candidateSet ?? null,
    policy: r.policy,
    fee: r.fee,
    bound: r.bound ?? null,
    bestFrom: r.bestFrom ?? null,
    bestInSpace: r.bestInSpace ?? null,
    bestInCandidates: r.bestInCandidates ?? null,
    inputs: b ? b.inputs.length : null,
    size: b ? b.size : null,
    txFee: b ? b.txFee : null,
    minFee: b ? b.minFee : null,
    changeOutputs: b ? b.k : null,
    exhaustive: r.exhaustive ?? null,
    stop: mip && mip.stop !== undefined ? mip.stop : null,
    mipBound: mip && mip.bound !== undefined ? mip.bound : null,
    terminated: r.terminated === true,
    incumbents: (r.incumbents || []).map((i) => ({ name: i.name, fee: i.fee, inputs: i.inputs, result: i.result, oracleFee: i.oracleFee ?? null, sameChange: i.sameChange ?? null, ...(i.detail ? { detail: scrubText(i.detail) } : {}) })),
    evaluations: r.evaluations ?? null,
    settings: r.settings ?? null,
    solver: r.solver ?? null,
    ms: r.ms
  };
}

export async function createBatteryOracle({ treatmentDir, pinsText, workers = 1, limitMs = TIME_LIMIT_MS, settings = oracleSettings() } = {}) {
  const available = new Set(await availablePolicies());
  const o = createOracle({ treatmentDir, ...(pinsText ? { pinsText } : {}), workers });
  return {
    policyOf(methodName, changePolicy) {
      const p = policyOfMethod(methodName, changePolicy);
      return p && available.has(p) ? p : null;
    },
    async reference(state, intent, params, policy, { incumbents }) {
      try {
        return oracleRecord(await o.oracle(state, intent, params, policy, { timeLimitMs: limitMs, incumbents, settings }));
      } catch (e) {
        // A spend the oracle does not handle is recorded as refused.
        if (e instanceof OracleRefusal) return { status: 'refused', policy, reason: scrubText(e.message) };
        throw e;
      }
    },
    stats: o.stats,
    close: o.close
  };
}
