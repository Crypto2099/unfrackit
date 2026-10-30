// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The oracle on every standard battery spend of the synthetic shapes, for
// every change policy it can evaluate, seeded with the transactions of the
// methods its incumbents rule admits and unseeded, each call in a worker
// under the oracle's settings (the work budget by default; the wall-clock
// limit when the settings say so). For each run it records what the checks
// read:
//
//   check 1  the reference transaction passes the ledger kit, and each of
//            the four negative controls is caught for its own reason
//   check 5  the reference fee is at most the fee of every admitted method
//            with the same policy whose transaction passed the kit; the
//            other methods' passing answers (csl-ri and csl-ri-pure under the
//            default rule) are kept apart, each with whether its fee is below
//            the reference's
//   check 6  each method's change equals the policy's change on the method's
//            own inputs, byte for byte (an admitted method's through the
//            oracle's incumbent evaluation, the others' through an evaluation
//            in this thread)
//   check 4  where the exhaustive path ran, the mixed-integer path over the
//            same candidates, unseeded, beside the exhaustive search's own
//            result over them
//   check 7  the time, the paths, the status and its scope, the stop and the
//            work used
//
// Every field of a record but the wall-clock times and `unseededMethods`
// (answers drawn from an unseedable generator) is a function of the shapes,
// the policies and the settings, under the work budget.
//
// Records are JSON Lines in the output directory, bigint as decimal strings.

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOracle } from '../../src/oracle/oracle.mjs';
import { availablePolicies, makeEvaluator, loadLibraryPolicies, BUILT_IN_POLICIES } from '../../src/oracle/policies.mjs';
import { sameChange } from '../../src/oracle/search.mjs';
import { oracleSettings } from '../../src/oracle/settings.mjs';
import { shapeState } from '../../src/shapes/shapes.mjs';
import { standardBattery, SHAPE_POOLS } from '../../src/battery/battery.mjs';
import { settle } from '../../src/kit/heap.mjs';
import { negativeControls, EXPECTED } from '../lib/controls.mjs';
import { methodAnswers, incumbentsOf, admitted } from '../lib/oracle-methods.mjs';

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
    paths: o.paths ?? null,
    scope: o.scope,
    candidates: o.candidates,
    candidateSet: o.candidateSet ?? null,
    fee: o.fee,
    bound: o.bound ?? null,
    inputs: o.best ? o.best.inputs.length : null,
    bestFrom: o.bestFrom ?? null,
    bestInSpace: o.bestInSpace ?? null,
    bestInCandidates: o.bestInCandidates ?? null,
    exhaustive: o.exhaustive ?? null,
    stop: o.stop ?? null,
    work: o.work ?? null,
    ms: Math.round(o.ms),
    wallMs: Math.round(o.wallMs || 0),
    terminated: o.terminated,
    incumbents: o.incumbents,
    detail: o.detail,
    evaluations: o.evaluations
  };
}

const answerOf = (a) => ({ name: a.name, seeded: a.seeded, ok: a.ok, kitOk: a.kitOk ?? null, fee: a.fee ?? null, class: a.class ?? null, inputs: a.walletInputs ? a.walletInputs.length : null });

// The answers the incumbents rule leaves out, each that passed the kit with
// whether its fee is below the reference's and whether its change is the
// policy's on its own inputs, evaluated in this thread.
async function unseededAnswers(T, s, spend, P, policy, settings, answers, refFee) {
  const out = [];
  const passed = answers.filter((a) => !admitted(a, settings));
  if (!passed.length) return out;
  const lib = BUILT_IN_POLICIES.includes(policy) ? null : await loadLibraryPolicies();
  const ev = makeEvaluator(T, { state: s, spend, params: P, policy, settings, lib });
  try {
    for (const a of passed) {
      const rec = answerOf(a);
      if (a.ok && a.kitOk) {
        const e = await ev.evaluate(a.walletInputs.map((r) => s.utxos.get(r)));
        rec.oracleFee = e.ok ? e.fee : null;
        rec.sameChange = e.ok ? sameChange(a.bytes, spend.requested.length, e) : false;
        rec.belowReference = refFee === null || a.fee < refFee;
      }
      out.push(rec);
    }
  } finally {
    ev.dispose();
  }
  return out;
}

// opts: { T, treatmentDir, pinsText, params, shapes, policies, limitMs (under
// limit 'wall-clock' only), workers, outDir, settings (the oracle's, its
// defaults when absent), log }
export async function runBatteryOracle(opts) {
  const { T, params: P, shapes, limitMs, outDir, log = () => {} } = opts;
  const settings = opts.settings || oracleSettings();
  const timed = settings.limit === 'wall-clock' ? { timeLimitMs: limitMs } : {};
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
          const incumbents = incumbentsOf(answers, settings);
          jobs.push(
            (async () => {
              let seeded;
              let unseeded;
              try {
                [seeded, unseeded] = await Promise.all([
                  oracle.oracle(s, spend, P, policy, { ...timed, incumbents, settings }),
                  oracle.oracle(s, spend, P, policy, { ...timed, incumbents: [], settings })
                ]);
              } catch (e) {
                // A call that fails is recorded and the run goes on; the
                // checks require there to be none.
                const rec = { shape: name, spend: spend.id, type: spend.type, policy, limitMs: limitMs ?? null, error: String(e && (e.message || e)).slice(0, 2000) };
                appendFileSync(file, json(rec) + '\n', { mode: 0o600 });
                records.push(rec);
                log(`${name} ${spend.id} ${policy}: error ${rec.error.split('\n')[0]}`);
                return;
              }
              const kept = answers.filter((a) => admitted(a, settings));
              const rec = { shape: name, spend: spend.id, type: spend.type, policy, limitMs: limitMs ?? null, methods: kept.map(answerOf), seeded: slim(seeded), unseeded: slim(unseeded) };
              // Check 4: where the exhaustive path ran, the mixed-integer
              // path over the same candidates, unseeded.
              if (unseeded.path === 'exhaustive') rec.mipCandidates = slim(await oracle.oracle(s, spend, P, policy, { ...timed, incumbents: [], path: 'mip', mipSpace: 'candidates', settings }));
              rec.check1 = {};
              for (const [k, o] of [['seeded', seeded], ['unseeded', unseeded]]) if (o.tx) rec.check1[k] = controlsOk(s, P, o.tx);
              rec.check5 = kept.filter((a) => a.ok && a.kitOk && seeded.fee !== null && seeded.fee > a.fee).map((a) => a.name);
              rec.check5missing = kept.filter((a) => a.ok && a.kitOk).length > 0 && seeded.fee === null;
              rec.check6 = seeded.incumbents ? seeded.incumbents.map((i) => ({ name: i.name, result: i.result, sameChange: i.sameChange ?? null, methodFee: i.fee, oracleFee: i.oracleFee ?? null })) : [];
              rec.unseededMethods = await unseededAnswers(T, s, spend, P, policy, settings, answers, seeded.fee);
              appendFileSync(file, json(rec) + '\n', { mode: 0o600 });
              records.push(rec);
              log(`${name} ${spend.id} ${policy}: ${seeded.status}/${unseeded.status} over ${seeded.scope} ${seeded.paths ? seeded.paths.join('+') : seeded.path} n=${seeded.candidates} fee ${seeded.fee}/${unseeded.fee} stop ${seeded.stop}/${unseeded.stop} ${Math.round(seeded.ms)}ms${seeded.terminated ? ' terminated' : ''}`);
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
