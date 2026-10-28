// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// UTxO records, states, applying a transaction, deposits, held consumption,
// the change address rule, battery and history intents, and the history file
// reader. No CSL: every record and transaction is built from CBOR here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unspentOutput, encodeOutput } from '../../../src/history/output.mjs';
import { utxoFromCbor, utxoFromRecord, utxoJson, addressTextOf } from '../../../src/state/utxo.mjs';
import { makeState, applyTx, addUtxos, removeHeld, spendable, cmpRef, latestKeyBaseAddress, withChangeAddress, annotateChangeAddresses, changeAddressGap, CHANGE_GAPS } from '../../../src/state/state.mjs';
import { batteryIntent, intentFromHistory } from '../../../src/state/intent.mjs';
import { readHistory, HISTORY_FORMAT, startChangeAddress } from '../../../src/state/history.mjs';
import { paramsFromRow } from '../../../src/history/params.mjs';
import { tx, input, out, baseAddr, scriptAddr, keyHash, STAKE } from '../../lib/txcbor.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';

const POL = 'cc'.repeat(28);
const A0 = baseAddr(keyHash(0));
const A1 = baseAddr(keyHash(1));
const EXT = baseAddr('ee'.repeat(28), 'ef'.repeat(28));
const rec = (txid, i, address, coin, assets = [], extra = {}) => unspentOutput(txid, i, encodeOutput({ address, coin, assets, ...extra }, extra.datum && extra.datum.kind === 'inline' ? 'map' : 'array')).toString('hex');
const T1 = '11'.repeat(32);
const T2 = '22'.repeat(32);
const T3 = '03'.repeat(32);

function wallet() {
  const utxos = [
    utxoFromCbor(rec(T2, 1, A0, 5000000n), { origin: 'initial' }),
    utxoFromCbor(rec(T1, 10, A1, 2000000n, [{ policy: POL, name: '4e4654', qty: 1n }]), { origin: 'initial' }),
    utxoFromCbor(rec(T1, 2, A0, 3000000n), { origin: 'initial' }),
    utxoFromCbor(rec(T3, 0, scriptAddr('ab'.repeat(28)), 4000000n), { origin: 'initial' }),
    utxoFromCbor(rec(T3, 1, A0, 2000000n, [], { datum: { kind: 'inline', cbor: '182a' } }), { origin: 'initial' })
  ];
  return makeState({ network: 'synthetic', stakeCred: STAKE, changeAddress: addressTextOf(A0), utxos });
}

test('UTxO records: fields from the CBOR, held reasons, JSON', () => {
  const s = wallet();
  const held = [...s.utxos.values()].map((u) => u.held);
  assert.deepEqual(held, ['script-payment', 'datum', null, null, null]);
  const u = s.utxos.get(`${T1}#10`);
  assert.equal(u.coin, 2000000n);
  assert.equal(u.cred, keyHash(1));
  assert.equal(u.address.startsWith('addr1'), true);
  const j = utxoJson(u);
  assert.equal(j.coin, '2000000');
  assert.deepEqual(utxoFromRecord(j), u);
  assert.throws(() => utxoFromRecord({ ...j, coin: '2000001' }), /differ from its CBOR/);
  assert.throws(() => utxoFromRecord({ ...j, held: 'datum' }), /held datum/);
  assert.equal(utxoFromRecord({ ...j, held: 'franken' }).held, 'franken');
  const byron = Buffer.from([0x82, 0xd8, 0x18]);
  assert.throws(() => addressTextOf(Buffer.concat([Buffer.from([0x80]), byron])), /Byron/);
});

test('a state keeps ref order: transaction id bytes, then the index as a number', () => {
  const s = wallet();
  assert.deepEqual([...s.utxos.keys()], [`${T3}#0`, `${T3}#1`, `${T1}#2`, `${T1}#10`, `${T2}#1`]);
  assert.ok(cmpRef(`${T1}#2`, `${T1}#10`) < 0);
  assert.equal(spendable(s).length, 3);
  assert.throws(() => makeState({ network: 'synthetic', stakeCred: STAKE, changeAddress: addressTextOf(EXT), utxos: [] }), /stake credential/);
});

test('applying a transaction removes its wallet inputs and keeps the outputs at the wallet\'s stake credential', () => {
  const s = wallet();
  const bytes = tx({ inputs: [input(T1, 2), input(T2, 1)], outputs: [out(EXT, 1000000n), out(A0, 6800000n)], fee: 200000n }).toString('hex');
  const { state: s2, hash } = applyTx(s, { bytes, walletInputs: [`${T1}#2`, `${T2}#1`] });
  assert.equal(hash, inspectTx(bytes).hash);
  assert.equal(s2.utxos.has(`${T1}#2`), false);
  assert.equal(s2.utxos.get(`${hash}#1`).coin, 6800000n);
  assert.equal(s2.utxos.get(`${hash}#1`).origin, 'built');
  assert.equal(s2.utxos.has(`${hash}#0`), false, 'the payment left the wallet');
  assert.equal(s.utxos.size, 5, 'the earlier state is unchanged');
  assert.throws(() => applyTx(s, { bytes, walletInputs: [`${T1}#2`] }), /did not name/);
  assert.throws(() => applyTx(s, { bytes, walletInputs: [`${T1}#2`, `${T2}#1`, `${T3}#0`] }), /held/);
  const notWallet = new Set([addressTextOf(A0)]);
  assert.equal(applyTx(s, { bytes, walletInputs: [`${T1}#2`, `${T2}#1`], notWallet }).state.utxos.size, 3);
});

test('deposits and held consumption', () => {
  const s = wallet();
  const d = addUtxos(s, [utxoFromCbor(rec('44'.repeat(32), 0, A1, 7000000n), { origin: 'deposit' })]);
  assert.equal(d.utxos.size, 6);
  assert.throws(() => addUtxos(d, [d.utxos.get(`${T1}#2`)]), /already in the state/);
  const h = removeHeld(s, [`${T3}#0`]);
  assert.equal(h.utxos.size, 4);
  assert.throws(() => removeHeld(s, [`${T1}#2`]), /not held/);
});

test('the change address rule: the latest output at a key payment credential and a base address', () => {
  const s = wallet();
  const created = new Map([[`${T3}#0`, 9], [`${T3}#1`, 9], [`${T1}#2`, 7], [`${T1}#10`, 7], [`${T2}#1`, 8]]);
  // T3's outputs are later but one is at a script payment credential and the
  // other is the datum one at A0: T3#1 wins (same tx, higher index).
  assert.equal(latestKeyBaseAddress(s.utxos.values(), created), addressTextOf(A0));
  created.set(`${T3}#1`, 1);
  assert.equal(latestKeyBaseAddress(s.utxos.values(), created), addressTextOf(A0));
  created.set(`${T2}#1`, 1);
  assert.equal(latestKeyBaseAddress(s.utxos.values(), created), addressTextOf(A1));
  assert.throws(() => latestKeyBaseAddress(s.utxos.values(), new Map()), /no creating transaction id/);
  // A franken-flagged credential is passed over, so change never lands where
  // it would be held at once.
  const fr = makeState({ network: 'synthetic', stakeCred: STAKE, changeAddress: addressTextOf(A0), utxos: [...s.utxos.values()], franken: [keyHash(1)] });
  const flagged = [...fr.utxos.values()].map((u) => (u.cred === keyHash(1) ? { ...u, held: 'franken' } : u));
  assert.equal(latestKeyBaseAddress(flagged, created), addressTextOf(A0));
});

test('battery intents carry requested outputs only', () => {
  const it = batteryIntent({ id: 'one-nft', type: 'one-nft', requested: [{ cbor: '00', address: addressTextOf(EXT), coin: 1200000n, assets: [{ policy: POL, name: '4e4654', qty: 1n }] }] });
  assert.equal(it.fixed, null);
  assert.equal(it.implicit.withdrawals, 0n);
  assert.equal(Object.isFrozen(it.requested[0]), true);
  assert.throws(() => batteryIntent({ id: 'x', source: 'replay', requested: [{}] }), /source replay/);
});

const PARAMS = paramsFromRow('preprod', { epoch_no: 300, protocol_major: 10, min_fee_a: 44, min_fee_b: 155381, coins_per_utxo_size: 4310, max_val_size: 5000, max_tx_size: 16384, max_collateral_inputs: 3, collateral_percent: 150, price_mem: 0.0577, price_step: 0.0000721, min_fee_ref_script_cost_per_byte: 15, key_deposit: 2000000, pool_deposit: 500000000, drep_deposit: 500000000, gov_action_deposit: 100000000000 });

const LKB_A1 = { address: addressTextOf(A1), txId: 1, index: 10 };

function historyText({ split = 'exploration', withEnd = true, count = 1, noTxId = false, latestKeyBase = LKB_A1, franken = [], withdrawal = '3000000' } = {}) {
  const r = (txid, i, address, coin, assets = [], origin = 'initial', held = null, txId = 1) => {
    const u = utxoFromCbor(rec(txid, i, address, coin, assets), { origin });
    const h = held !== null ? held : franken.includes(u.cred) ? 'franken' : null;
    return noTxId ? { ...utxoJson(u), held: h } : { ...utxoJson(u), held: h, txId };
  };
  const intent = {
    id: '55'.repeat(32), source: 'replay', type: 'T1', time: { slot: 10, blockTime: 1000, blockIndex: 0, epoch: 300, block: 5 },
    requested: [{ cbor: encodeOutput({ address: EXT, coin: 1000000n, assets: [] }, 'array').toString('hex'), address: addressTextOf(EXT), coin: '1000000', assets: [], datum: null, scriptRef: null, raised: null, index: 0, wallet: false, scriptPayment: false }],
    implicit: { withdrawals: '0', refunds: '0', deposits: '0', donation: '0', mint: [], burn: [] },
    fixed: { inputs: [], referenceInputs: [], body: { 3: '1a00989680', 6: 'a0' }, witnesses: {}, redeemers: [], auxiliaryData: null, scriptFee: '0', fixedBytes: 7, refScriptBytes: 0 },
    collateral: { required: false, observed: null }, invalid: null, burst: null,
    observed: { tx: '55'.repeat(32), size: 300, fee: '170000', epoch: 300, protocolMajor: 10, minFeeA: '44', minFeeB: '155381', walletInputs: [{ ref: `${T1}#2`, cbor: rec(T1, 2, A0, 3000000n) }], walletOutputs: [{ index: 1, cbor: out(A1, 1830000n).toString('hex') }], walletWitnesses: [{ keyHash: keyHash(0), cbor: '00' }] },
    classes: {}, derived: { poolDeposits: '500000000' }
  };
  const lines = [
    { kind: 'header', format: HISTORY_FORMAT, network: 'preprod', wallet: 42, frame: 'recent', split, window: null, snapshot: { block: 1, tx: 1 }, params: PARAMS, franken, arrival: [{ policy: POL, name: '4e4654', tx: T1, txId: 17, flagged: false }], ...(latestKeyBase === 'omit' ? {} : { latestKeyBase }), settings: {}, source: { bytes: 'tx_cbor' } },
    { kind: 'state', at: { tx: 1 }, utxos: [r(T1, 2, A0, 3000000n, [], 'initial', null, 0), r(T1, 10, A1, 2000000n, [{ policy: POL, name: '4e4654', qty: 1n }], 'initial', null, 1)] },
    { kind: 'deposit', tx: T2, txId: 3, time: {}, utxos: [r(T2, 0, A0, 4000000n, [], 'deposit', null, 3)] },
    { kind: 'mark', n: 1, blockTime: 900 },
    { kind: 'intent', txId: 4, intent },
    { kind: 'self-reorganization', tx: T3, txId: 5, time: {}, burst: null, ...(withdrawal === null ? {} : { withdrawal }), observed: { walletOutputs: [{ index: 0, cbor: out(A0, 2800000n).toString('hex') }] } }
  ];
  if (withEnd) lines.push({ kind: 'end', at: { tx: 9 }, utxos: 2, digest: '00', counts: { deposit: 1, 'held-consumed': 0, intent: count, 'self-reorganization': 1, mark: 1, skippedInvalid: 0, raised: 0 } });
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

test('a history file reads into parameters, the start state, events and intents', () => {
  const h = readHistory(historyText());
  assert.equal(h.params.network, 'preprod');
  assert.equal(h.params.minFeeA, 44n);
  assert.equal(h.start.length, 2);
  assert.equal(h.events.length, 4);
  const it = h.events.find((e) => e.kind === 'intent').intent;
  assert.equal(it.requested[0].coin, 1000000n);
  assert.equal(it.fixed.body[6], 'a0', 'fixed body field 6 is kept');
  assert.equal(it.observed.protocolMajor, 10);
  assert.equal(it.observed.walletWitnesses.length, 1);
  assert.deepEqual(it.derived, { poolDeposits: '500000000' });
  assert.equal(h.arrival.get(`${POL}.4e4654`).txId, 17);
  // Every record's creating transaction id is kept. The change address
  // starts at the header's latest output before the window at a key payment
  // credential and a base address (here the start state's T1#10 at A1, over
  // T1#2 at A0), and moves with every later output the wallet receives on the
  // chain, which counts from the next event on: the deposit's at A0, the
  // spend's own change at A1, the self-reorganization's at A0.
  assert.deepEqual([...h.created], [[`${T1}#2`, 0], [`${T1}#10`, 1], [`${T2}#0`, 3]]);
  assert.equal(h.changeAddress, addressTextOf(A1));
  assert.equal(startChangeAddress(h.start, h.created), addressTextOf(A1));
  assert.deepEqual(h.events.map((e) => [e.kind, e.changeAddress]), [['deposit', addressTextOf(A1)], ['mark', addressTextOf(A0)], ['intent', addressTextOf(A0)], ['self-reorganization', addressTextOf(A1)]]);
  assert.equal(h.changeAddressEnd, addressTextOf(A0));
  assert.equal(h.stakeCred, STAKE);
  assert.equal(h.events[3].walletOutputs.length, 1);
  // A self-reorganization carries its reward withdrawals, which the replay
  // deposits; a file without them is refused.
  assert.equal(h.events[3].withdrawal, 3000000n);
  assert.throws(() => readHistory(historyText({ withdrawal: null })), /carries no withdrawal/);
  // A franken-flagged credential is passed over at every step: with A1's key
  // flagged, the start falls back to A0 (the header the extraction writes
  // then names A0's latest output), and the spend's change at A1 never moves
  // it.
  const fr = readHistory(historyText({ franken: [keyHash(1)], latestKeyBase: { address: addressTextOf(A0), txId: 0, index: 2 } }));
  assert.deepEqual(fr.events.map((e) => e.changeAddress), [addressTextOf(A0), addressTextOf(A0), addressTextOf(A0), addressTextOf(A0)]);
  // The header ranges over every output before the window: one received and
  // spent before it can be later than any UTxO of the start state, and none
  // can be earlier.
  const spentBefore = { address: addressTextOf(A0), txId: 2, index: 0 };
  assert.equal(readHistory(historyText({ latestKeyBase: spentBefore })).changeAddress, addressTextOf(A0));
  assert.throws(() => readHistory(historyText({ latestKeyBase: { address: addressTextOf(A0), txId: 0, index: 2 } })), /later output/);
  assert.throws(() => readHistory(historyText({ latestKeyBase: null })), /later output/);
  assert.throws(() => readHistory(historyText({ latestKeyBase: 'omit' })), /no latestKeyBase/);
  assert.throws(() => readHistory(historyText({ noTxId: true })), /carries no creating transaction id/);
  assert.throws(() => readHistory(historyText({ withEnd: false })), /no end record/);
  assert.throws(() => readHistory(historyText({ count: 2 })), /end record says 2/);
  assert.throws(() => readHistory(historyText({ split: 'confirmation' })), /confirmation split/);
  assert.equal(readHistory(historyText({ split: 'confirmation' }), { analysisFreezeTx: 'ab'.repeat(32) }).analysisFreezeTx, 'ab'.repeat(32));
  assert.throws(() => intentFromHistory({ source: 'battery' }), /source battery/);
});

test('the change address follows the outputs received; a wallet is refused only where the rule names no address it needs', () => {
  const ptr = Buffer.concat([Buffer.from([0x41]), Buffer.from(keyHash(2), 'hex'), Buffer.from([1, 2, 3])]);
  const u = (txid, i, address, coin, extra = {}) => utxoFromCbor(rec(txid, i, address, coin, [], extra), { origin: 'deposit' });
  const s = makeState({ network: 'synthetic', stakeCred: STAKE, changeAddress: null, utxos: [] });
  assert.equal(s.changeAddress, null);
  assert.throws(() => makeState({ network: 'synthetic', stakeCred: STAKE, utxos: [] }), /no change address/);
  assert.equal(withChangeAddress(s, addressTextOf(A0)).changeAddress, addressTextOf(A0));
  assert.throws(() => withChangeAddress(s, addressTextOf(EXT)), /stake credential/);
  const intent = (txId) => ({ kind: 'intent', txId, intent: { observed: { walletOutputs: [] } } });
  const dep = (txId, utxos) => ({ kind: 'deposit', txId, utxos });
  const run = (start, events) => {
    const c = annotateChangeAddresses(null, events, new Set());
    return { gap: changeAddressGap({ changeAddress: c.start, changeAddressEnd: c.end, start, events }), at: events.map((e) => e.changeAddress), end: c.end };
  };
  // An empty start, then a deposit: the spend after it has an address.
  const a = run([], [dep(3, [u(T2, 0, A0, 5000000n)]), intent(4)]);
  assert.deepEqual(a, { gap: null, at: [null, addressTextOf(A0)], end: addressTextOf(A0) });
  // A spend before any output the rule can name, and a withdrawal the replay
  // would deposit; a self-reorganization without one needs no address.
  assert.equal(run([], [intent(4), dep(5, [u(T2, 0, A0, 5000000n)])]).gap, CHANGE_GAPS.spend);
  const reorg = (txId, withdrawal) => ({ kind: 'self-reorganization', txId, withdrawal, walletOutputs: [] });
  assert.equal(run([], [reorg(4, 2000000n), dep(5, [u(T2, 0, A0, 5000000n)])]).gap, CHANGE_GAPS.spend);
  assert.equal(run([], [reorg(4, 0n), dep(5, [u(T2, 0, A0, 5000000n)])]).gap, null);
  // A spendable UTxO at a pointer address, which the rule cannot name.
  assert.equal(run([u(T1, 0, ptr, 5000000n)], []).gap, CHANGE_GAPS.spendable);
  assert.equal(run([], [dep(3, [u(T1, 0, ptr, 5000000n)]), { kind: 'mark', n: 1 }, dep(5, [u(T2, 0, A0, 5000000n)])]).gap, CHANGE_GAPS.spendable);
  // The pointer UTxO arrives with an output the rule names: no gap.
  assert.equal(run([], [dep(3, [u(T1, 0, ptr, 5000000n), u(T1, 1, A0, 5000000n)]), intent(4)]).gap, null);
  // Held UTxOs alone at a script payment credential, and nothing else ever.
  assert.equal(run([u(T3, 0, scriptAddr('ab'.repeat(28)), 4000000n)], [dep(3, [u(T2, 0, scriptAddr('ab'.repeat(28)), 4000000n)])]).gap, CHANGE_GAPS.none);
  // A datum does not stop the rule naming an address: change goes to the
  // address without it.
  assert.equal(run([], [dep(3, [u(T2, 0, A0, 4000000n, { datum: { kind: 'inline', cbor: '182a' } })]), intent(4)]).gap, null);
  // A source without annotations keeps its start address.
  assert.equal(changeAddressGap({ changeAddress: addressTextOf(A0), start: [], events: [intent(4)] }), null);
});
