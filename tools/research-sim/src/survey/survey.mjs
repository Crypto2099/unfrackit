// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The library part of the builder survey, descriptive only: each subject
// builds the fixture's payment (survey/fixture.mjs) for k = 1 to 5, with and
// without pure-ADA UTxOs, and every transaction it builds goes through the
// ledger kit's checks. One record per subject, variant, k and run:
//
//   outcome        'built', 'built-invalid' (the library built it and the kit
//                  rejects it; the reason is recorded) or 'failed' (the
//                  library refused, with its error text and class)
//   fee, minFee    the transaction's fee and the ledger's minimum for its size
//   size           the ledger's size; serializedSize, the bytes as built
//   inputs         input count, and how many carry tokens and how many are
//                  pure ADA
//   change         the outputs at the wallet's address: how many, how many
//                  carry tokens, how many are pure ADA, the largest Value bytes
//   splitsOverV    when the tokens the inputs return exceed the value-size
//                  limit in one Value: whether the change spreads them over
//                  more than one output (null when they fit one Value)
//   separates      whether the change holds the tokens in outputs at their
//                  minimum coin and the surplus ADA in a pure-ADA output (null
//                  when the change returns no token)
//   prefersPure    in the variant with pure-ADA UTxOs: whether the inputs are
//                  pure ADA only (null in the other variant)
//
// Subjects: cardano-serialization-lib with both strategies, with and without
// prefer_pure_change; cardano-js-sdk 0.14.35 as cjs-rrri; Mesh 1.9.1 at its
// default and with its LargestFirstInputSelector, with Mesh's own callbacks;
// the Evolution SDK 0.6.0 at its default and with its unfrack option at the
// option's defaults. A random subject runs randomRuns times (csl-ri cannot be
// seeded; cjs-rrri and mesh-default take seeds 1 to randomRuns).

import { checkAndApply } from '../kit/apply.mjs';
import { inspectTx } from '../kit/inspect.mjs';
import { valueSize } from '../history/value.mjs';
import { SYNTHETIC_PARAMS } from '../kit/params.mjs';
import { cslMethod } from '../methods/csl.mjs';
import { cjsMethod } from '../methods/cjs.mjs';
import { evoMethod } from '../methods/evo.mjs';
import { meshMethod } from '../methods/mesh.mjs';
import { addressTextOf } from '../state/utxo.mjs';
import { surveyFixture, SURVEY_SETTINGS } from './fixture.mjs';
import { settle } from '../kit/heap.mjs';

export function surveySubjects(T) {
  return [
    { id: 'csl-lf', method: cslMethod(T, { strategy: 'lf' }) },
    { id: 'csl-lf-pure', method: cslMethod(T, { strategy: 'lf', preferPureChange: true }) },
    { id: 'csl-ri', method: cslMethod(T, { strategy: 'ri' }) },
    { id: 'csl-ri-pure', method: cslMethod(T, { strategy: 'ri', preferPureChange: true }) },
    { id: 'cjs-rrri', method: cjsMethod(T), seeded: true },
    { id: 'mesh-default', method: meshMethod(), seeded: true },
    { id: 'mesh-lf', method: meshMethod({ selector: 'largest-first' }) },
    { id: 'evo-lf', method: evoMethod() },
    { id: 'evo-unfrack', method: evoMethod({ unfrack: {} }) }
  ];
}

function minimumOf(T, raw, coinsPerUtxoByte) {
  const C = T.CSL;
  const o = C.TransactionOutput.from_bytes(raw);
  const dc = C.DataCost.new_coins_per_byte(C.BigNum.from_str(coinsPerUtxoByte.toString()));
  const m = C.min_ada_for_output(o, dc);
  const v = BigInt(m.to_str());
  for (const x of [m, dc, o]) x.free();
  return v;
}

// What one built transaction shows, read from its bytes.
export function describeBuilt(T, fx, bytes, params) {
  const t = inspectTx(bytes);
  const wallet = fx.state.changeAddress;
  const byRef = fx.state.utxos;
  const ins = t.inputs.map((x) => byRef.get(x.ref));
  const change = t.outputs.filter((o) => addressTextOf(o.address) === wallet);
  const tokenChange = change.filter((o) => o.assets.length);
  const pureChange = change.filter((o) => !o.assets.length);
  const returned = ins.flatMap((u) => u.assets);
  // The returned tokens exceed the limit in one Value when they do at the
  // narrowest coin.
  const returnedOverV = returned.length ? valueSize(0n, returned) > params.maxValSize : false;
  const atMinimum = tokenChange.every((o) => o.coin === minimumOf(T, o.raw, params.coinsPerUtxoByte));
  return {
    size: t.size,
    serializedSize: t.serializedSize,
    fee: t.fee,
    inputs: ins.length,
    tokenInputs: ins.filter((u) => u.assets.length).length,
    pureInputs: ins.filter((u) => !u.assets.length).length,
    change: change.length,
    tokenChange: tokenChange.length,
    pureChange: pureChange.length,
    largestChangeValue: change.reduce((m, o) => Math.max(m, valueSize(o.coin, o.assets)), 0),
    splitsOverV: returnedOverV ? tokenChange.length > 1 : null,
    separates: returned.length ? pureChange.length > 0 && atMinimum : null,
    prefersPure: fx.meta.variant === 'pure' ? ins.every((u) => !u.assets.length) : null
  };
}

export async function surveyOne(T, subject, fx, run, params = SYNTHETIC_PARAMS) {
  const opts = { changePolicy: 'default', ...(subject.seeded ? { seed: run } : {}) };
  await settle();
  const t0 = performance.now();
  let r;
  try {
    r = await subject.method.build(fx.state, fx.intent, params, opts);
  } catch (e) {
    r = { ok: false, class: 'other', detail: `exception: ${String(e && (e.message || e))}` };
  }
  const ms = performance.now() - t0;
  const base = { subject: subject.id, variant: fx.meta.variant, k: fx.meta.k, run, ms };
  if (!r.ok) return { ...base, outcome: 'failed', class: r.class, detail: r.detail };
  const tx = r.txs[0];
  const kit = checkAndApply(fx.state, params, r.txs, { implicit: fx.intent.implicit });
  const d = describeBuilt(T, fx, tx.bytes, params);
  const minFee = kit.checks[0].facts ? kit.checks[0].facts.minFee : null;
  if (!kit.ok) return { ...base, outcome: 'built-invalid', class: kit.failure.cls, detail: `${kit.failure.check}: ${kit.failure.detail}`, failures: kit.checks[0].failures.map((f) => `${f.check}: ${f.detail}`), minFee, ...d };
  return { ...base, outcome: 'built', minFee, ...d };
}

export async function runSurvey(T, { settings = SURVEY_SETTINGS, params = SYNTHETIC_PARAMS, subjects = surveySubjects(T), onRecord = null } = {}) {
  const records = [];
  for (const variant of ['tokens', 'pure']) {
    for (const k of settings.ks) {
      const fx = surveyFixture(T, k, variant, settings);
      for (const subject of subjects) {
        const runs = subject.method.deterministic ? 1 : settings.randomRuns;
        for (let run = 1; run <= runs; run++) {
          const rec = await surveyOne(T, subject, fx, run, params);
          records.push(rec);
          if (onRecord) onRecord(rec);
        }
      }
    }
  }
  return records;
}
