// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Parameters and fee terms, bursts, marks, spend types, settings, and the
// code manifest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rationalOf, paramsFromRow, executionFee, refScriptFee, minUtxoRule, valueLimit } from '../../../src/history/params.mjs';
import { bursts, placeMarks, replayObserved } from '../../../src/history/history.mjs';
import { spendType, assetClasses } from '../../../src/history/spendtype.mjs';
import { settingsWith, DEFAULT_SETTINGS, parseSets } from '../../../src/history/settings.mjs';
import { cip67Prefix } from '../../../src/history/cip67.mjs';
import { hashList, formatHashList, checkText } from '../../../src/hash.mjs';

test('rationals are recovered from db-sync\'s doubles', () => {
  assert.deepEqual(rationalOf(0.0577, 'p'), ['577', '10000']);
  assert.deepEqual(rationalOf(7.21e-5, 'p'), ['721', '10000000']);
  assert.deepEqual(rationalOf(15, 'p'), ['15', '1']);
  assert.deepEqual(rationalOf(0.5, 'p'), ['1', '2']);
  assert.equal(rationalOf(null, 'p'), null);
  assert.throws(() => rationalOf(1 / 3, 'p'), /decimal fraction/);
});

test('Params from an epoch_param row', () => {
  const p = paramsFromRow('preprod', {
    epoch_no: 300, protocol_major: 10, min_fee_a: 44, min_fee_b: 155381, coins_per_utxo_size: '4310', max_val_size: '5000', max_tx_size: 16384,
    max_collateral_inputs: 3, collateral_percent: 150, price_mem: 0.0577, price_step: 7.21e-5, min_fee_ref_script_cost_per_byte: 15,
    key_deposit: '2000000', pool_deposit: '500000000', drep_deposit: '500000000', gov_action_deposit: '100000000000'
  });
  assert.deepEqual(p, {
    network: 'preprod', epoch: 300, protocolMajor: 10, minFeeA: '44', minFeeB: '155381', coinsPerUtxoByte: '4310', maxValSize: 5000, maxTxSize: 16384,
    maxCollateralInputs: 3, collateralPercent: 150, priceMem: ['577', '10000'], priceStep: ['721', '10000000'], minFeeRefScriptCostPerByte: ['15', '1'],
    keyDeposit: '2000000', poolDeposit: '500000000', drepDeposit: '500000000', govActionDeposit: '100000000000'
  });
});

test('the execution term rounds up the exact sum', () => {
  const p = { priceMem: ['577', '10000'], priceStep: ['721', '10000000'] };
  // 0.0577 * 1,000,000 + 0.0000721 * 500,000,000 = 57,700 + 36,050 = 93,750
  assert.equal(executionFee(p, 1000000n, 500000000n), 93750n);
  // 0.0577 * 1 = 0.0577, rounded up to 1
  assert.equal(executionFee(p, 1n, 0n), 1n);
  assert.equal(executionFee(p, 0n, 0n), 0n);
});

test('the reference-script term grows by 1.2 every 25,600 bytes and rounds down', () => {
  const p = { minFeeRefScriptCostPerByte: ['15', '1'] };
  assert.equal(refScriptFee(p, 0), 0n);
  assert.equal(refScriptFee(p, 1000), 15000n);
  assert.equal(refScriptFee(p, 25600), 25600n * 15n);
  // 25,600 at 15, then 400 at 18
  assert.equal(refScriptFee(p, 26000), 25600n * 15n + 400n * 18n);
  // 25,600 at 15, 25,600 at 18, 10 at 21.6: 384,000 + 460,800 + 216
  assert.equal(refScriptFee(p, 51210), 384000n + 460800n + 216n);
  // A fractional tier price: 3 bytes at 21.6 is 64.8, rounded down with the rest
  assert.equal(refScriptFee(p, 51203), 384000n + 460800n + 64n);
  assert.equal(refScriptFee({ minFeeRefScriptCostPerByte: null }, 99), 0n);
});

test('the minimum-UTxO rule of an era and the value-size limit in force', () => {
  assert.deepEqual([4, 5, 6, 7, 9].map(minUtxoRule), ['mary', 'alonzo', 'alonzo', 'babbage-conway', 'babbage-conway']);
  assert.equal(valueLimit({ protocol_major: 4, max_val_size: null }), 4000);
  assert.equal(valueLimit({ protocol_major: 7, max_val_size: '5000' }), 5000);
  assert.equal(valueLimit({ protocol_major: 3, max_val_size: null }), null);
});

const S = DEFAULT_SETTINGS;
const spend = (txId, hash, blockTime, consumed = []) => ({ txId, hash, blockTime, consumed });

test('bursts: a chained pair in one block', () => {
  const b = bursts([spend(1, 'aa', 100), spend(2, 'bb', 100, ['aa#1'])], S);
  assert.deepEqual(b.get(1), { id: 'b1', parallel: false, index: 0 });
  assert.deepEqual(b.get(2), { id: 'b1', parallel: false, index: 1 });
});

test('bursts: 59 seconds apart join, 61 seconds apart do not, and the boundary is 60', () => {
  const b = bursts([spend(1, 'aa', 1000), spend(2, 'bb', 1059), spend(3, 'cc', 1120), spend(4, 'dd', 1180)], S);
  assert.deepEqual([b.get(1).id, b.get(2).id], ['b1', 'b1']);
  assert.equal(b.get(3).id, 'b2', '61 seconds after the second spend starts a new burst');
  assert.equal(b.get(4).id, 'b2', 'exactly 60 seconds stays in the burst');
  const lone = bursts([spend(1, 'aa', 0), spend(2, 'bb', 61)], S);
  assert.equal(lone.size, 0, 'a lone spend carries no burst');
});

test('bursts: a parallel burst, and spending an earlier burst\'s output does not chain', () => {
  const b = bursts([spend(1, 'aa', 0), spend(2, 'bb', 20, ['zz#0']), spend(3, 'cc', 40, ['yy#3'])], S);
  assert.deepEqual([...b.values()].map((x) => x.parallel), [true, true, true]);
  const c = bursts([spend(1, 'aa', 0), spend(2, 'bb', 10), spend(3, 'cc', 500, ['aa#0']), spend(4, 'dd', 510)], S);
  assert.equal(c.get(3).parallel, true);
  // A later spend consumed by an earlier one cannot chain.
  const d = bursts([spend(1, 'aa', 0, ['bb#0']), spend(2, 'bb', 10)], S);
  assert.equal(d.get(1).parallel, true);
});

test('marks every 30 days from the window start, before ties', () => {
  const ev = (t) => ({ kind: 'deposit', time: { blockTime: t } });
  const day = 86400;
  const out = placeMarks([ev(10), ev(30 * day), ev(61 * day)], 0, 95 * day, S);
  assert.deepEqual(out.map((e) => (e.kind === 'mark' ? `m${e.n}` : e.time.blockTime / day)), [10 / day, 'm1', 30, 'm2', 61, 'm3']);
  const after = placeMarks([ev(30 * day)], 0, 31 * day, settingsWith({ markBeforeTies: false }));
  assert.deepEqual(after.map((e) => e.kind), ['deposit', 'mark']);
});

test('the observed replay', () => {
  const start = ['t0#0', 't0#1'];
  const events = [
    { kind: 'deposit', utxos: [{ ref: 't1#0' }] },
    { kind: 'intent', intent: { id: 't2', observed: { walletInputs: [{ ref: 't0#0' }], walletOutputs: [{ index: 1 }] }, fixed: { inputs: [{ ref: 't0#1', held: 'datum' }] }, invalid: null } },
    { kind: 'held-consumed', tx: 't3', refs: ['t1#0'] }
  ];
  assert.deepEqual([...replayObserved(start, events)], ['t2#1']);
  assert.throws(() => replayObserved([], events.slice(2)), /not in the state/);
});

test('spend types in their order', () => {
  const ft = { policy: '11'.repeat(28), name: '41', qty: 5n };
  const n1 = { policy: '22'.repeat(28), name: '01', qty: 1n };
  const n2 = { policy: '22'.repeat(28), name: '02', qty: 1n };
  const n3 = { policy: '33'.repeat(28), name: '01', qty: 1n };
  const cls = { [`${ft.policy}.41`]: 'FT', [`${n1.policy}.01`]: 'NFT', [`${n2.policy}.02`]: 'NFT', [`${n3.policy}.01`]: 'NFT' };
  const t = (o) => spendType({ script: false, mintOrBurn: false, governance: false, sent: [], classes: cls, settings: S, ...o });
  assert.equal(t({ script: true, mintOrBurn: true }), 'T6');
  assert.equal(t({ mintOrBurn: true, governance: true }), 'T8');
  assert.equal(t({ governance: true, sent: [{ assets: [ft] }] }), 'T7');
  assert.equal(t({ sent: [{ assets: [n1, ft] }] }), 'T5');
  assert.equal(t({ sent: [{ assets: [n1] }, { assets: [n3] }] }), 'T4');
  assert.equal(t({ sent: [{ assets: [n1, n2] }] }), 'T3');
  assert.equal(t({ sent: [{ assets: [n1] }] }), 'T2');
  assert.equal(t({ sent: [{ assets: [] }] }), 'T1');
  assert.equal(t({ sent: [{ assets: [], scriptPayment: true }] }), 'T1');
  assert.equal(spendType({ script: false, mintOrBurn: false, governance: false, sent: [{ assets: [], scriptPayment: true }], classes: cls, settings: settingsWith({ t5ScriptOrders: 'any-script-output' }) }), 'T5');
});

test('asset classes under the profile rule', () => {
  const k333 = `${'aa'.repeat(28)}.${cip67Prefix(333)}01`;
  const k222 = `${'aa'.repeat(28)}.${cip67Prefix(222)}01`;
  const plain = `${'bb'.repeat(28)}.41`;
  const moved = `${'cc'.repeat(28)}.41`;
  const c = assetClasses([k333, k222, plain, moved], {
    settings: S,
    holdStart: new Map([[k222, 1n], [plain, 1n]]),
    holdEnd: new Map([[plain, 3n]]),
    net: new Map([[moved, -2n]])
  });
  assert.deepEqual(c, { [k333]: 'FT', [k222]: 'NFT', [plain]: 'FT', [moved]: 'FT' });
  const at = assetClasses([plain], { settings: settingsWith({ assetClass: 'at-spend' }), holdBefore: new Map([[plain, 1n]]) });
  assert.deepEqual(at, { [plain]: 'NFT' });
});

test('settings: defaults, overrides, and refusals of what is not implemented', () => {
  assert.equal(settingsWith().requested, 'a');
  assert.equal(settingsWith({ burstGapSeconds: '90' }).burstGapSeconds, 90);
  assert.throws(() => settingsWith({ nosuch: 1 }), /unknown setting/);
  assert.throws(() => settingsWith({ scriptFee: 'observed' }), /not implemented/);
  assert.deepEqual(parseSets(['requested=c', 'markBeforeTies=false']), { requested: 'c', markBeforeTies: 'false' });
});

test('the code manifest lists every hashed file and refuses a CR', () => {
  const files = hashList().map((f) => f.path);
  assert.ok(files.includes('package.json') && files.includes('package-lock.json'));
  assert.ok(files.includes('src/history/intent.mjs') && files.includes('sql/history.sql'));
  assert.ok(!files.some((f) => f.startsWith('test/')));
  assert.match(formatHashList(), /^SHA-256 +file\n[0-9a-f]{64} {2}\S+/);
  assert.throws(() => checkText('x', Buffer.from('a\r\n')), /CR/);
  assert.throws(() => checkText('x', Buffer.from('﻿a\n')), /byte-order mark/);
  assert.throws(() => checkText('x', Buffer.from('a')), /final newline/);
});
