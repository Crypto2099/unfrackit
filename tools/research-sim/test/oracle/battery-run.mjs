// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The oracle on every standard battery spend of the synthetic shapes, for
// every change policy it can evaluate, seeded with the methods' transactions
// and unseeded, each call in a worker under the time limit. For each run it
// records what the checks read:
//
//   check 1  the reference transaction passes the ledger kit, and each of
//            the four negative controls is caught for its own reason
//   check 5  the reference fee is at most the fee of every method with the
//            same policy whose transaction passed the kit
//   check 6  each method's change equals the policy's change on the method's
//            own inputs, byte for byte
//   check 4  where the exhaustive path ran, the mixed-integer path over the
//            same candidates, unseeded, beside it
//   check 7  the time, the path and the status
//
// Records are JSON Lines in the output directory, bigint as decimal strings.

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOracle } from '../../src/oracle/oracle.mjs';
import { availablePolicies } from '../../src/oracle/policies.mjs';
import { shapeState } from '../../src/shapes/shapes.mjs';
import { standardBattery, SHAPE_POOLS } from '../../src/battery/battery.mjs';
import { settle } from '../../src/kit/heap.mjs';
import { negativeControls, EXPECTED } from '../lib/controls.mjs';
import { methodAnswers, incumbentsOf } from '../lib/oracle-methods.mjs';

const json = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

function controlsOk(state, params, bytes) {
  const r = negativeControls(state, params, bytes);
  const bad = Object.entries(EXPECTED).filter(([k, v]) => r[k] !== v).map(([k]) => `${k}:${r[k]}`);
  return { ok: bad.length === 0, bad };
}

function slim(o) {
  return {
    status: o.status,
    path: o.path,
    scope: o.scope,
    candidates: o.candidates,
    fee: o.fee,
    inputs: o.best ? o.best.inputs.length : null,
    bestFrom: o.bestFrom ?? null,
    bestInSpace: o.bestInSpace ?? null,
    ms: Math.round(o.ms),
    wallMs: Math.round(o.wallMs || 0),
    terminated: o.terminated,
    incumbents: o.incumbents,
    detail: o.detail,
    evaluations: o.evaluations
  };
}

// opts: { T, treatmentDir, pinsText, params, shapes, policies, limitMs,
// workers, outDir, log }
export async function runBatteryOracle(opts) {
  const { T, params: P, shapes, limitMs, outDir, log = () => {} } = opts;
  const policies = opts.policies || (await availablePolicies());
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const file = join(outDir, 'oracle-battery.jsonl');
  const oracle = createOracle({ treatmentDir: opts.treatmentDir, pinsText: opts.pinsText, workers: opts.workers || 4 });
  const records = [];
  try {
    for (const name of shapes) {
      await settle();
      const s = shapeState(T, name).state;
      const spends = standardBattery(T, s, P, { pools: SHAPE_POOLS }).filter((b) => !b.unsettled);
      const jobs = [];
      for (const spend of spends) {
        for (const policy of policies) {
          const answers = await methodAnswers(T, s, spend, P, policy);
          const incumbents = incumbentsOf(answers);
          jobs.push(
            (async () => {
              let seeded;
              let unseeded;
              try {
                [seeded, unseeded] = await Promise.all([
                  oracle.oracle(s, spend, P, policy, { timeLimitMs: limitMs, incumbents }),
                  oracle.oracle(s, spend, P, policy, { timeLimitMs: limitMs, incumbents: [] })
                ]);
              } catch (e) {
                // A call that fails is recorded and the run goes on; the
                // checks require there to be none.
                const rec = { shape: name, spend: spend.id, type: spend.type, policy, limitMs, error: String(e && (e.message || e)).slice(0, 2000) };
                appendFileSync(file, json(rec) + '\n', { mode: 0o600 });
                records.push(rec);
                log(`${name} ${spend.id} ${policy}: error ${rec.error.split('\n')[0]}`);
                return;
              }
              const rec = { shape: name, spend: spend.id, type: spend.type, policy, limitMs, methods: answers.map((a) => ({ name: a.name, ok: a.ok, kitOk: a.kitOk ?? null, fee: a.fee ?? null, class: a.class ?? null, inputs: a.walletInputs ? a.walletInputs.length : null })), seeded: slim(seeded), unseeded: slim(unseeded) };
              // Check 4: where the exhaustive path ran, the mixed-integer
              // path over the same candidates, unseeded.
              if (unseeded.path === 'exhaustive') rec.mipCandidates = slim(await oracle.oracle(s, spend, P, policy, { timeLimitMs: limitMs, incumbents: [], path: 'mip', mipSpace: 'candidates' }));
              rec.check1 = {};
              for (const [k, o] of [['seeded', seeded], ['unseeded', unseeded]]) if (o.tx) rec.check1[k] = controlsOk(s, P, o.tx);
              rec.check5 = answers.filter((a) => a.ok && a.kitOk && seeded.fee !== null && seeded.fee > a.fee).map((a) => a.name);
              rec.check5missing = answers.filter((a) => a.ok && a.kitOk).length > 0 && seeded.fee === null;
              rec.check6 = seeded.incumbents ? seeded.incumbents.map((i) => ({ name: i.name, result: i.result, sameChange: i.sameChange ?? null, methodFee: i.fee, oracleFee: i.oracleFee ?? null })) : [];
              appendFileSync(file, json(rec) + '\n', { mode: 0o600 });
              records.push(rec);
              log(`${name} ${spend.id} ${policy}: ${seeded.status}/${unseeded.status} ${seeded.path} n=${seeded.candidates} fee ${seeded.fee}/${unseeded.fee} ${Math.round(seeded.ms)}ms${seeded.terminated ? ' terminated' : ''}`);
            })()
          );
        }
      }
      await Promise.all(jobs);
    }
  } finally {
    await oracle.close();
  }
  return { records, file, stats: oracle.stats };
}
