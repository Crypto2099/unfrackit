// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The replay's parts: output records and their guard, run plans, collateral
// eligibility and, with the treatment, the replay
// assembler against CSL's assembly, spend-redeemer re-indexing, collateral
// and its witness, the negative controls on replayed transactions, and a
// required signer at a wallet key the selection does not spend, replayed by
// every builder with the validity checks on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record, assertClean, scrubText, RunOutput, IdentifierInRecord } from '../../../src/out/records.mjs';
import { windowPlan, mergePlan, expandJobs, STUDY_ROLES, TEST_ROLES, LIBRARY_ROLES, LIBRARY_TABLE } from '../../../src/arms/plan.mjs';
import { replayJobOpts } from '../../../src/replay/run.mjs';
import { BASE_ARMS, VARIANTS, checkArm } from '../../../src/arms/arms.mjs';
import { eligibleCollateral, collateralAvailability, totalCollateralFor } from '../../../src/replay/collateral.mjs';
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

test('run plans: the refocused arms, the same in both windows, 150 jobs per wallet at twenty libraries', () => {
  for (const w of ['recent', 'peak']) {
    const plan = mergePlan(windowPlan(w));
    const one = (role, change, variant = 'default') => plan.find((e) => e.role === role && e.change === change && e.variant === variant);
    assert.ok(plan.every((e) => e.arm === 'observed'), 'every arm replays the observed state');
    // Per library: its own change under Q1, UnFrack.It's change under Q1 and Q2.
    for (const [role, reps] of [['lf', 1], ['ri', 10], ['rrri', 10], ['evo', 1], ['blaze-wd', 1], ['lucid-lf', 1], ['mesh-rrri', 10], ['typhon-lp', 1], ['helios-sf', 1], ['cml-lf', 1], ['cml-ri', 10], ['cometa-lf', 1], ['lace-rrri', 10], ['adalite-lp', 1], ['yoroi-lf', 1], ['apollo-macs', 1], ['scalus-pool', 1], ['ccl-pw', 1], ['pycardano-lf', 10], ['tx3-vd', 1]]) {
      assert.equal(one(role, 'default').repetitions, reps, role);
      assert.equal(one(role, 'layout').repetitions, reps, role);
      assert.deepEqual(one(role, 'default').hypotheses, ['Q1'], role);
      assert.deepEqual(one(role, 'layout').hypotheses, ['Q1', 'Q2'], role);
      assert.equal(plan.filter((e) => e.role === role).length, 2, role);
    }
    // The rule: UnFrack.It's own change, absorption on and off, one run each.
    const on = one('h12', 'default', 'absorb-on');
    const off = one('h12', 'default', 'absorb-off');
    assert.deepEqual([on.absorb, off.absorb, on.repetitions, off.repetitions], [true, false, 1, 1]);
    assert.deepEqual([on.hypotheses, off.hypotheses], [['Q2'], ['Q2']]);
    assert.equal(plan.length, 42);
    // 150 jobs a wallet: 2 + 20 + 20 + 2 + 2 + 2 + 20 + 2 + 2 + 2 + 20 + 2 + 20 + 2 + 2 + 2 + 2 + 2 + 2 + 20 + 2 + 2.
    const jobs = expandJobs(windowPlan(w), { roles: STUDY_ROLES, needsCollateral: false });
    assert.equal(jobs.length, 150);
    assert.deepEqual(Object.fromEntries(['csl-lf', 'csl-ri', 'cjs-rrri', 'evo-lf', 'blaze-wd', 'lucid-lf', 'mesh-rrri', 'typhon-lp', 'helios-sf', 'cml-lf', 'cml-ri', 'cometa-lf', 'lace-rrri', 'adalite-lp', 'yoroi-lf', 'apollo-macs', 'scalus-pool', 'ccl-pw', 'pycardano-lf', 'tx3-vd', 'unfrackit-h12'].map((m) => [m, jobs.filter((j) => j.method === m).length])), { 'csl-lf': 2, 'csl-ri': 20, 'cjs-rrri': 20, 'evo-lf': 2, 'blaze-wd': 2, 'lucid-lf': 2, 'mesh-rrri': 20, 'typhon-lp': 2, 'helios-sf': 2, 'cml-lf': 2, 'cml-ri': 20, 'cometa-lf': 2, 'lace-rrri': 20, 'adalite-lp': 2, 'yoroi-lf': 2, 'apollo-macs': 2, 'scalus-pool': 2, 'ccl-pw': 2, 'pycardano-lf': 20, 'tx3-vd': 2, 'unfrackit-h12': 2 });
    assert.ok(jobs.every((j) => j.collateral === 'none-needed'));
    // One collateral rule: a script wallet's jobs run under it alone.
    const withScripts = expandJobs(windowPlan(w), { roles: STUDY_ROLES, needsCollateral: true, collateralRules: ['practice'] });
    assert.equal(withScripts.length, 150);
    assert.ok(withScripts.every((j) => j.collateral === 'practice'));
    // Every tidy arm, control and variant is gone.
    assert.ok(!plan.some((e) => e.arm !== 'observed' || e.hypotheses.some((h) => !['Q1', 'Q2'].includes(h))));
  }
  assert.equal(windowPlan('recent', { reps: 3 }).filter((e) => e.role === 'ri' && e.change === 'default')[0].repetitions, 3);
  assert.equal(windowPlan('recent', { reps: 3 }).filter((e) => e.role === 'lf' && e.change === 'default')[0].repetitions, 1);
  assert.throws(() => windowPlan('recent', { reps: 0 }), /positive whole number/);
  assert.throws(() => windowPlan('snapshot'), /no replay plan/);
});

// The jobs of the six libraries the study ran before the role table and of
// the rule, unchanged by the table: their list, in order, as the plan made it
// at 59b3f30 (the role maps written out by hand), by count and the first 16
// hex digits of the SHA-256 of its JSON, for the study and the test roles,
// both windows, with and without collateral rules (ledger and practice), at
// 10 and at 2 repetitions.
test('run plans: the role table leaves the existing roles\' jobs as they were', () => {
  const BEFORE = {
    study: { false: { 10: [50, 'df83381402fc354c'], 2: [18, 'd81ac2761d7e3f3f'] }, true: { 10: [100, 'ee4aff781e8c94a4'], 2: [36, 'b84583da527bc181'] } },
    test: { false: { 10: [50, '2fd4ef0a71f486d3'], 2: [18, '67a8b5fafb1b8148'] }, true: { 10: [100, '3c48ad2944f573ab'], 2: [36, '2f65e541f688e8cb'] } }
  };
  const existing = new Set(['lf', 'ri', 'rrri', 'evo', 'blaze-wd', 'lucid-lf', 'h12']);
  for (const [label, roles] of [['study', STUDY_ROLES], ['test', TEST_ROLES]]) {
    for (const w of ['recent', 'peak']) {
      for (const needsCollateral of [false, true]) {
        for (const reps of [10, 2]) {
          const jobs = expandJobs(windowPlan(w, { reps }), { roles, needsCollateral, collateralRules: ['ledger', 'practice'] }).filter((j) => existing.has(j.role));
          const got = [jobs.length, createHash('sha256').update(JSON.stringify(jobs)).digest('hex').slice(0, 16)];
          assert.deepEqual(got, BEFORE[label][needsCollateral][reps], `${label} ${w} ${needsCollateral} ${reps}`);
        }
      }
    }
  }
  // The tables come from the one library table, and every library role is
  // in each.
  assert.deepEqual(LIBRARY_ROLES, LIBRARY_TABLE.map((r) => r.role));
  assert.deepEqual(Object.keys(STUDY_ROLES), [...LIBRARY_ROLES, 'h12']);
  assert.deepEqual(Object.keys(TEST_ROLES), [...LIBRARY_ROLES, 'h12']);
  for (const r of LIBRARY_TABLE) assert.equal(STUDY_ROLES[r.role], r.method);
  for (const r of LIBRARY_TABLE) assert.equal(mergePlan(windowPlan('recent')).find((e) => e.role === r.role).repetitions, r.random ? 10 : 1, r.role);
});

test('run plans: L/own and L/layout of one repetition draw the same seed; the rule\'s jobs carry the absorption setting and differ in their keys', () => {
  const jobs = expandJobs(windowPlan('recent'), { roles: STUDY_ROLES, needsCollateral: true, collateralRules: ['practice'] });
  for (const method of ['csl-lf', 'csl-ri', 'cjs-rrri', 'evo-lf', 'blaze-wd', 'lucid-lf', 'mesh-rrri', 'helios-sf', 'cml-lf', 'cml-ri', 'lace-rrri', 'yoroi-lf']) {
    const own = jobs.filter((j) => j.method === method && j.change === 'default');
    const layout = jobs.filter((j) => j.method === method && j.change === 'layout');
    assert.equal(own.length, layout.length, method);
    assert.deepEqual(own.map((j) => j.repetition), layout.map((j) => j.repetition), method);
    own.forEach((j, i) => {
      assert.equal(replayJobOpts(j).seed, replayJobOpts(layout[i]).seed, `${method} repetition ${j.repetition}`);
      assert.equal(replayJobOpts(j).seed, j.repetition);
    });
  }
  const rule = jobs.filter((j) => j.method === 'unfrackit-h12');
  assert.deepEqual(rule.map((j) => replayJobOpts(j).absorb).sort(), [false, true]);
  assert.equal(new Set(rule.map((j) => `${j.variant}|${j.change}|${j.repetition}`)).size, 2, 'the keys differ');
  assert.deepEqual(rule.map((j) => [j.variant, replayJobOpts(j).absorb]).sort(), [['absorb-off', false], ['absorb-on', true]]);
  assert.ok(jobs.filter((j) => j.method !== 'unfrackit-h12').every((j) => !('absorb' in replayJobOpts(j))));
  assert.equal(replayJobOpts({ repetition: 4, change: 'layout', collateral: 'none-needed' }).collateralRule, 'ledger');
});

test('arm checks: only the observed arm, its three variants and repetitions from 1', () => {
  assert.deepEqual([...BASE_ARMS], ['observed']);
  assert.deepEqual([...VARIANTS], ['default', 'absorb-on', 'absorb-off']);
  for (const v of VARIANTS) checkArm('observed', v, 1);
  for (const arm of ['tidy-once', 'maintained-tidy', 'naive-tidy', 'random-tidy']) assert.throws(() => checkArm(arm, 'default', 1), /unknown arm/);
  assert.throws(() => checkArm('observed', 'bundle-5', 1), /unknown variant/);
  assert.throws(() => checkArm('observed', 'default', 0), /numbered from 1/);
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

// A required signer that is a wallet key, with no fixed witness (the history
// reader keeps none for the keys of the wallet inputs the observed
// transaction spent), when the selection takes no UTxO at that key: every
// builder writes a witness for it and the kit requires one, so the witness
// control is caught. The wallet holds UTxOs at two payment keys under one
// stake key; the payment needs the second key's UTxO, which the
// largest-first methods take alone. Then the same with no UTxO left at the
// signer's key: its witness is still written.
test('a required signer at a wallet key the selection does not spend: witnessed by every builder, and the validity checks pass', { skip, timeout: 5 * 60 * 1000 }, async () => {
  const { replay } = await import('../../../src/replay/engine.mjs');
  const { makeMethod, BASELINE_METHODS } = await import('../../../src/methods/registry.mjs');
  const { laceBuildProblem } = await import('../../../src/methods/lace.mjs');
  const { adaliteBuildProblem } = await import('../../../src/methods/adalite.mjs');
  const { shapeState } = await import('../../../src/shapes/shapes.mjs');
  const { SYNTHETIC_PARAMS } = await import('../../../src/kit/params.mjs');
  const { outputBytes } = await import('../../../src/kit/assemble.mjs');
  const { inspectTx } = await import('../../../src/kit/inspect.mjs');
  const { utxoFromOutput } = await import('../../../src/state/utxo.mjs');
  const { addressBytes } = await import('../../../src/history/address.mjs');
  const { recipientAddress } = await import('../../../src/kit/recipients.mjs');
  const { blake2b224, blake2b256 } = await import('../../../src/history/blake2b.mjs');
  const { encBytes, encArray, encTag } = await import('../../../src/history/cbor.mjs');
  const { ZERO_IMPLICIT } = await import('../../../src/state/intent.mjs');
  const SP = SYNTHETIC_PARAMS;
  const state = shapeState(T, 'S1').state;
  const first = addressBytes(state.changeAddress);
  const signer = first.subarray(1, 29).toString('hex');
  const second = Buffer.concat([first.subarray(0, 1), blake2b224(Buffer.from('second payment key')), first.subarray(29)]);
  const utxo = (label, address, coin) => utxoFromOutput(blake2b256(Buffer.from(label)).toString('hex'), 0, outputBytes(T, { address: addressTextOf(address), coin, assets: [] }), { origin: 'deposit' });
  const atFirst = utxo('signer key utxo', first, 3n * ADA);
  const atSecond = utxo('second key utxo', second, 50n * ADA);
  assert.notEqual(atFirst.cred, atSecond.cred);
  assert.equal(atFirst.cred, signer);
  const payee = recipientAddress('synthetic', 500);
  const coin = 10n * ADA;
  const intent = {
    id: 'a5'.repeat(32),
    source: 'replay',
    type: 'T1',
    time: { slot: 10, blockTime: 10, blockIndex: 0, epoch: 0, block: 10 },
    requested: [{ cbor: outputBytes(T, { address: payee, coin, assets: [] }).toString('hex'), address: payee, coin, assets: [], datum: null, scriptRef: null, raised: null, wallet: false, scriptPayment: false, index: null, from: null, inflow: false }],
    implicit: { ...ZERO_IMPLICIT },
    fixed: { inputs: [], referenceInputs: [], body: { 14: encTag(258, encArray([encBytes(Buffer.from(signer, 'hex'))])).toString('hex') }, witnesses: {}, redeemers: [], auxiliaryData: null, scriptFee: 0n, fixedBytes: 0, refScriptBytes: 0 },
    collateral: { required: false, observed: null },
    invalid: null,
    burst: null,
    observed: { tx: 'a5'.repeat(32), size: 0, fee: 300000n, epoch: 0, protocolMajor: null, minFeeA: 44n, minFeeB: 155381n, walletInputs: [], walletOutputs: [], walletWitnesses: [] },
    classes: {},
    derived: null,
    meta: null
  };
  const sourceOf = (start) => ({ wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: state.stakeCred, changeAddress: state.changeAddress, changeAddressEnd: state.changeAddress, franken: new Set(), start, events: [{ kind: 'intent', txId: 1, intent }], windowStart: 0, windowEnd: 20, params: SP });
  const LARGEST_FIRST = new Set(['csl-lf', 'cml-lf', 'evo-lf', 'lucid-lf', 'test-largest-first']);
  // Lace's, AdaLite's and Yoroi's methods run only with the builds of the
  // wallets' source. Yoroi's send flow writes no required signer, so the
  // intent is not replayable for it.
  const { yoroiBuildProblem } = await import('../../../src/methods/yoroi.mjs');
  const NO_SIGNER = new Set(['yoroi-lf']);
  // Apollo's, Scalus's, cardano-client-lib's and Tx3's methods run only with
  // their helpers built.
  const { helperBuild } = await import('../../../src/methods/helper.mjs');
  const names = [...BASELINE_METHODS.filter((n) => (n !== 'lace-rrri' || !laceBuildProblem()) && (n !== 'adalite-lp' || !adaliteBuildProblem()) && (n !== 'yoroi-lf' || !yoroiBuildProblem()) && (n !== 'apollo-macs' || !helperBuild('apollo').problem) && (n !== 'scalus-pool' || !helperBuild('jvm').problem) && (n !== 'ccl-pw' || !helperBuild('jvm').problem) && (n !== 'tx3-vd' || !helperBuild('tx3').problem)), 'test-largest-first'];
  for (const [label, start] of [['both keys', [atFirst, atSecond]], ['second key only', [atSecond]]]) {
    const source = sourceOf(start);
    for (const name of names) {
      const r = await replay(T, SP, source, { arm: 'observed', variant: 'default', repetition: 1, method: makeMethod(T, name), opts: { seed: 1, changePolicy: 'default', collateralRule: 'ledger' }, settleEvery: 25, keepTx: true, validity: true });
      const s = r.spends[0];
      if (name === 'adalite-lp' && label === 'second key only') {
        // AdaLite writes no required signer, so the adapter adds it after
        // the build, unpriced; the wallet prices one witness for its one
        // input (estimateTxSize.ts:77-78), and the signer's second witness
        // takes the transaction past the wallet's fee. The record names the
        // part.
        assert.deepEqual([s.outcome, s.class], ['failed', 'fee-minimum'], `${label} ${name}: ${s.detail}`);
        assert.match(s.detail, /parts the library did not price: required signers$/);
        continue;
      }
      if (name === 'scalus-pool') {
        // Scalus's complete takes only the UTxOs at the sponsor address
        // (TxBuilder.scala:1670-1673), and the change address holds the
        // first key's UTxO alone, too little for the payment.
        assert.deepEqual([s.outcome, s.class], ['failed', 'balance'], `${label} ${name}: ${s.detail}`);
        assert.match(s.detail, /^complete: InsufficientAdaException/);
        continue;
      }
      if (name === 'tx3-vd') {
        // A Tx3 query has one address, the change address, which holds the
        // first key's UTxO alone, too little for the payment.
        assert.deepEqual([s.outcome, s.class, s.detail], ['failed', 'balance', 'resolve: input not resolved: source'], `${label} ${name}`);
        continue;
      }
      if (NO_SIGNER.has(name)) {
        assert.deepEqual([s.outcome, s.detail], ['not-replayable', 'yoroi: body field 14'], `${label} ${name}`);
        continue;
      }
      assert.equal(s.outcome, 'built', `${label} ${name}: ${s.outcome} ${s.class} ${s.detail}`);
      const v = r.summary.validity;
      assert.equal(v.failed, 0, `${label} ${name}: ${JSON.stringify(v.failures)}`);
      assert.equal(v.controls.witnesses, v.txs, `${label} ${name}`);
      const t = s.built.txs[s.built.txs.length - 1];
      const d = inspectTx(t.bytes);
      const keys = new Set([...t.walletInputs.map((ref) => s.built.before.utxos.get(ref).cred), signer]);
      assert.equal(d.vkeys.length, keys.size, `${label} ${name}: one witness per input key and the signer`);
      if (LARGEST_FIRST.has(name)) {
        assert.deepEqual(t.walletInputs, [atSecond.ref], `${label} ${name}: the second key's UTxO alone`);
        assert.equal(d.vkeys.length, 2);
      }
    }
  }
});
