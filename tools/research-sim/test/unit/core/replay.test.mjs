// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The replay's parts: output records and their guard, run plans, collateral
// eligibility, H-6's rescue join, and, with the treatment, the replay
// assembler against CSL's assembly, spend-redeemer re-indexing, collateral
// and its witness, and the negative controls on replayed transactions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record, assertClean, scrubText, RunOutput, IdentifierInRecord } from '../../../src/out/records.mjs';
import { windowPlan, mergePlan, expandJobs, testPlan, STUDY_ROLES, batteryPlan } from '../../../src/arms/plan.mjs';
import { armSettings, VARIANTS } from '../../../src/arms/arms.mjs';
import { eligibleCollateral, collateralAvailability, totalCollateralFor } from '../../../src/replay/collateral.mjs';
import { rescueOutcomes } from '../../../src/replay/run.mjs';
import { makeState, cmpRef } from '../../../src/state/state.mjs';
import { utxoFromCbor, addressTextOf } from '../../../src/state/utxo.mjs';
import { unspentOutput, encodeOutput } from '../../../src/history/output.mjs';
import { baseAddr, keyHash, STAKE } from '../../lib/txcbor.mjs';
import { paramsFromRow } from '../../../src/history/params.mjs';
import { normalizeParams } from '../../../src/kit/params.mjs';
import { treatment, skip } from '../../lib/treatment.mjs';

const ADA = 1000000n;
const P = normalizeParams(paramsFromRow('preprod', { epoch_no: 300, protocol_major: 10, min_fee_a: 44, min_fee_b: 155381, coins_per_utxo_size: 4310, max_val_size: 5000, max_tx_size: 16384, max_collateral_inputs: 3, collateral_percent: 150, price_mem: 0.0577, price_step: 0.0000721, min_fee_ref_script_cost_per_byte: 15, key_deposit: 2000000, pool_deposit: 500000000, drep_deposit: 500000000, gov_action_deposit: 100000000000 }));
const POL = 'cc'.repeat(28);
const A0 = baseAddr(keyHash(0));
const T1 = '11'.repeat(32);
const u = (i, coin, assets = []) => utxoFromCbor(unspentOutput(T1, i, encodeOutput({ address: A0, coin, assets }, 'array')).toString('hex'), { origin: 'initial' });
const KEY = { wallet: 42, window: 'recent', arm: 'observed', variant: 'default', method: 'test-largest-first', change: 'default', collateral: 'ledger', repetition: 1 };

test('records carry their key and name no address, hash or credential', () => {
  const r = record('spend', KEY, { intent: 3, fee: 170000n, policies: [{ policy: POL, bytes: 40 }], meta: { asset: `${POL}.4e4654` } });
  assert.equal(r.wallet, 42);
  assert.equal(r.intent, 3);
  assert.throws(() => record('spend', KEY, { tx: 'ab'.repeat(32) }), IdentifierInRecord);
  assert.throws(() => record('spend', KEY, { where: addressTextOf(A0) }), IdentifierInRecord);
  assert.throws(() => record('spend', KEY, { cred: keyHash(0) }), IdentifierInRecord);
  assert.throws(() => record('spend', { ...KEY, wallet: 'addr1x' }, {}), /shape name/);
  assert.throws(() => record('spend', { ...KEY, repetition: undefined }, {}), /no repetition/);
  // Free text is scrubbed rather than refused.
  const d = record('spend', KEY, { detail: `input ${'ab'.repeat(32)}#0 at ${addressTextOf(A0)} with ${keyHash(1)}` });
  assert.equal(d.detail, 'input <hash>#0 at <address> with <hash28>');
  assert.equal(scrubText('fine'), 'fine');
  assert.doesNotThrow(() => assertClean({ policy: POL, name: 'ab'.repeat(32) }));
});

test('the run directory is private and the records are JSON Lines', () => {
  const home = mkdtempSync(join(tmpdir(), 'research-sim-records-'));
  const prev = process.env.RESEARCH_SIM_HOME;
  process.env.RESEARCH_SIM_HOME = home;
  try {
    const out = new RunOutput('synthetic', 'unit', { command: 'test' });
    out.write(record('wallet-arm', KEY, { fee: 5n }));
    out.close();
    const lines = readFileSync(join(out.dir, 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].fee, '5');
    assert.equal(JSON.parse(readFileSync(join(out.dir, 'run.json'), 'utf8')).runId, 'unit');
    assert.equal(statSync(out.dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(out.dir, 'records.jsonl')).mode & 0o777, 0o600);
  } finally {
    if (prev === undefined) delete process.env.RESEARCH_SIM_HOME;
    else process.env.RESEARCH_SIM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('run plans: arms per window, repetitions by selector, collateral rules when a script runs', () => {
  const recent = mergePlan(windowPlan('recent'));
  const one = (arm, variant, role, change = 'default') => recent.find((e) => e.arm === arm && e.variant === variant && e.role === role && e.change === change);
  assert.equal(one('observed', 'default', 'rrri').repetitions, 30);
  assert.equal(one('observed', 'default', 'lf').repetitions, 1);
  assert.equal(one('observed', 'default', 'evo').repetitions, 1);
  assert.equal(one('maintained-tidy', 'R1', 'rrri').repetitions, 10);
  assert.equal(one('tidy-once', 'bundle-60', 'rrri').policyLock, true);
  assert.deepEqual(one('tidy-once', 'default', 'rrri').hypotheses.sort(), ['H-1', 'H-2', 'H-4', 'H-9']);
  assert.equal(one('observed', 'default', 'rrri', 'layout'), undefined, 'H-11 runs in the peak window only');
  const peak = mergePlan(windowPlan('peak'));
  assert.ok(peak.find((e) => e.hypotheses.includes('H-11') && e.change === 'naive' && e.role === 'ri'));
  assert.ok(!peak.find((e) => e.hypotheses.includes('H-2')));
  const jobs = expandJobs(windowPlan('peak'), { roles: STUDY_ROLES, needsCollateral: false });
  assert.ok(jobs.every((j) => j.collateral === 'none-needed'));
  const withScripts = expandJobs(windowPlan('peak'), { roles: STUDY_ROLES, needsCollateral: true });
  assert.equal(withScripts.length, 4 * jobs.length);
  assert.throws(() => windowPlan('snapshot'), /no replay plan/);
  assert.ok(testPlan().length > 20);
  const b = batteryPlan();
  assert.deepEqual(b.map((m) => [m.name, m.repetitions]), [['csl-lf', 1], ['csl-ri', 30], ['cjs-rrri', 30], ['evo-lf', 1], ['unfrackit-h12', 1]]);
});

test('arm settings: variants, controls and seeds', () => {
  assert.deepEqual(armSettings('tidy-once', 'grouping-random', 7), { grouping: 'random', groupingSeed: 7 });
  assert.deepEqual(armSettings('random-tidy', 'default', 3), { control: 'random', controlSeed: 3 });
  assert.deepEqual(armSettings('naive-tidy', 'default', 3), { control: 'naive' });
  assert.deepEqual(armSettings('maintained-tidy', 'R6', 1), { reserve: { rule: 'none' }, rollupLovelace: false, pureAdaOnly: 'never' });
  assert.equal(armSettings('tidy-once', 'bundle-cap', 1).bundleSize, Infinity);
  assert.throws(() => armSettings('naive-tidy', 'R1', 1), /default settings only/);
  assert.throws(() => armSettings('tidy-once', 'nope', 1), /unknown variant/);
  assert.throws(() => armSettings('tidy-once', 'default', 0), /numbered from 1/);
  assert.equal(Object.keys(VARIANTS).length, 24);
});

test('collateral eligibility under each rule, smallest first', () => {
  const s = makeState({ network: 'preprod', stakeCred: STAKE, changeAddress: addressTextOf(A0), utxos: [u(0, 30n * ADA), u(1, 5n * ADA), u(2, 12n * ADA), u(3, 1n * ADA), u(4, 3n * ADA, [{ policy: POL, name: '4e4654', qty: 1n }])] });
  const refs = (list) => list.map((x) => Number(x.ref.split('#')[1]));
  assert.deepEqual(refs(eligibleCollateral(s, P, 'ledger')), [1, 2, 0]);
  assert.deepEqual(refs(eligibleCollateral(s, P, 'practice')), [1, 2]);
  assert.deepEqual(refs(eligibleCollateral(s, P, 'ledger', { exclude: new Set([`${T1}#1`]) })), [2, 0]);
  assert.deepEqual(refs(eligibleCollateral(s, P, 'ledger-minimum', { observedFee: 600000n })), [3, 1, 2, 0]);
  assert.deepEqual(refs(eligibleCollateral(s, P, 'token-bearing')), [3, 4, 1, 2, 0]);
  assert.deepEqual(collateralAvailability(s, P), { ledger: true, practice: true, 'ledger-minimum': null, 'token-bearing': true });
  assert.equal(totalCollateralFor(P, 200001n), 300002n);
  assert.equal(totalCollateralFor(P, 200000n), 300000n);
});

test('H-6\'s rescue: a trigger rescues when the never-propose arm cannot serve a script spend or a burst within 30 days', () => {
  const DAY = 86400;
  const rule = {
    triggers: [{ at: 'mark 1', t: 30 * DAY }, { at: 'mark 2', t: 60 * DAY }],
    spends: [{ intent: 4, t: 40 * DAY, collateralAvailable: { ledger: true, practice: true } }, { intent: 9, t: 95 * DAY, collateralAvailable: { ledger: true, practice: true } }],
    bursts: [{ id: 'b2', t: 70 * DAY, feasible: true }]
  };
  const never = {
    spends: [{ intent: 4, t: 40 * DAY, collateralAvailable: { ledger: true, practice: false } }, { intent: 9, t: 95 * DAY, collateralAvailable: { ledger: false, practice: false } }],
    bursts: [{ id: 'b2', t: 70 * DAY, feasible: false }]
  };
  const r = rescueOutcomes(rule, never);
  assert.deepEqual(r[0].rescue, { ledger: false, practice: true });
  assert.deepEqual(r[1].rescue, { ledger: true, practice: true }, 'the burst rescues under both rules; intent 9 is past 30 days');
});

const T = await treatment();

test('the replay assembler: a plain intent assembles to CSL\'s bytes; spend redeemers re-indexed; collateral witnessed', { skip }, async () => {
  const { assembleReplayOnce, assembleReplayAtMinimumFee, collateralFrom } = await import('../../../src/kit/replay.mjs');
  const { assembleOnce } = await import('../../../src/kit/assemble.mjs');
  const { inspectTx } = await import('../../../src/kit/inspect.mjs');
  const { checkAndApply } = await import('../../../src/kit/apply.mjs');
  const { negativeControls, EXPECTED } = await import('../../lib/controls.mjs');
  const { shapeState } = await import('../../../src/shapes/shapes.mjs');
  const { syntheticStream } = await import('../../../src/shapes/streams.mjs');
  const { SYNTHETIC_PARAMS } = await import('../../../src/kit/params.mjs');
  const { fixedResolver } = await import('../../../src/kit/apply.mjs');
  const { fixedExtraWitnesses } = await import('../../../src/replay/engine.mjs');
  const { parseAddress, addressBytes } = await import('../../../src/history/address.mjs');
  const SP = SYNTHETIC_PARAMS;
  const sh = shapeState(T, 'S7');
  const ins = [...sh.state.utxos.values()].filter((x) => x.held === null).slice(0, 3);
  const change = [{ address: sh.state.changeAddress, coin: 2n * ADA, assets: [] }];
  const plain = { source: 'replay', requested: [], fixed: null, implicit: {}, collateral: { required: false } };
  const a = assembleReplayOnce(T, { intent: plain, inputs: ins, change, collateral: null, fee: 200000n });
  const b = assembleOnce(T, ins, change, 200000n);
  assert.equal(a.bytes, b.bytes, 'the kit\'s raw assembly is CSL\'s for the same parts');

  // The stream's script spend: its redeemer points at the script input's
  // place among the sorted inputs, and the collateral's key signs.
  const st = syntheticStream(T, sh, SP);
  const t6 = st.events.find((e) => e.kind === 'intent' && e.intent.type === 'T6' && !e.intent.invalid).intent;
  // S7 holds no pure-ADA UTxO of 5 ADA, so the token-bearing rule's smallest
  // UTxO serves, its tokens given back by the return output.
  const coll = eligibleCollateral(sh.state, SP, 'token-bearing', { exclude: new Set(ins.map((x) => x.ref)) });
  const built = assembleReplayAtMinimumFee(T, SP, {
    intent: t6,
    inputs: ins,
    changeFor: (fee) => ({ ok: true, change: [{ address: sh.state.changeAddress, coin: ins.reduce((s, x) => s + x.coin, 0n) + 10n * ADA - 12n * ADA - fee, assets: ins.flatMap((x) => x.assets) }] }),
    collateralFor: collateralFrom(SP, coll, sh.state.changeAddress)
  });
  assert.ok(built.ok, built.detail);
  const d = inspectTx(built.bytes);
  const sorted = d.inputs.map((x) => x.ref);
  assert.deepEqual(sorted, sorted.slice().sort(cmpRef));
  assert.equal(d.redeemers[0].index, sorted.indexOf(t6.fixed.inputs[0].ref));
  assert.equal(d.collateralInputs.length, 1);
  // The smallest eligible UTxO that can carry the collateral and a return at
  // its minimum; every smaller one cannot.
  const { changeOutputBytes } = await import('../../../src/kit/replay.mjs');
  const { outputMinimum } = await import('../../../src/kit/check.mjs');
  const can = (x) => x.coin - d.totalCollateral >= outputMinimum(SP, changeOutputBytes({ address: sh.state.changeAddress, coin: x.coin - d.totalCollateral, assets: x.assets }).length);
  const at = coll.findIndex((x) => x.ref === d.collateralInputs[0].ref);
  assert.ok(at >= 0 && can(coll[at]) && coll.slice(0, at).every((x) => !can(x)));
  assert.deepEqual(d.collateralReturn.assets, coll[at].assets);
  assert.equal(d.totalCollateral, totalCollateralFor(SP, d.fee));
  assert.equal(d.fee, SP.minFeeA * BigInt(d.size) + SP.minFeeB + t6.fixed.scriptFee, 'the fee is the minimum with the script fee');
  const keys = new Set([...ins.map((x) => x.cred), built.collateral.utxo.cred]);
  assert.equal(d.vkeys.length, keys.size);
  const fixed = fixedResolver(t6.fixed);
  const view = (x) => x && { coin: x.coin, assets: x.assets, addr: parseAddress(addressBytes(x.address)) };
  const resolve = (ref) => view(sh.state.utxos.get(ref)) || fixed.get(ref);
  const ctrl = negativeControls(sh.state, SP, built.bytes, { resolve, scriptFee: t6.fixed.scriptFee, extraWitnesses: fixedExtraWitnesses(t6) });
  assert.deepEqual(ctrl, { ...EXPECTED });
  const applied = checkAndApply(sh.state, SP, [{ bytes: built.bytes, walletInputs: ins.map((x) => x.ref) }], { scriptFee: t6.fixed.scriptFee, fixed: t6.fixed });
  assert.ok(applied.ok, JSON.stringify(applied.failure));
  // CSL reads the transaction, and its body back to the same bytes. CSL
  // re-encodes a witness set's lists as tagged sets in its own key order, so
  // fixed witnesses kept as their original bytes need not come back
  // byte-identical; the body, and so the transaction id, does.
  const ctx = T.CSL.Transaction.from_bytes(Buffer.from(built.bytes, 'hex'));
  const again = inspectTx(Buffer.from(ctx.to_bytes()).toString('hex'));
  ctx.free();
  assert.equal(again.hash, d.hash);
  assert.equal(again.vkeys.length, d.vkeys.length);
  assert.deepEqual(again.redeemers, d.redeemers);
});
