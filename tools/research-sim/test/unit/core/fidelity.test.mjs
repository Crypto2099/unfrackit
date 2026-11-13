// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The fidelity check (src/fidelity/fidelity.mjs) over a constructed history
// file, each observed transaction written by hand in the kit's encodings
// (sets with tag 258, change in the array form, 101-byte vkey witnesses), so
// that a rebuild of the same parts has exactly the observed size:
// - a payment whose rebuilt size equals the observed one (difference 0);
// - one whose observed transaction carries a part the rebuild cannot know,
//   a second vkey witness for the same key, 101 bytes the rebuild lacks:
//   outside 2%;
// - a purchase: a non-wallet input brings a token, which the requested
//   inflow output and the observed change both carry; the rebuild writes the
//   observed change (in the map form on chain, the array form here) and not
//   the inflow output, and leaves out the network id, so it is 4 bytes
//   smaller, and 2 with the leftovers kept;
// - a script spend, left out; a body field 6, counted apart; a
//   self-reorganization, not in the check.
// Then the command: its records under the private run directory, and the
// refusal of a confirmation-split file without --analysis-freeze-tx.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { treatment, skip, TREATMENT_DIR } from '../../lib/treatment.mjs';
import { encUint, encBytes, encArray, encMap, encTag } from '../../../src/history/cbor.mjs';
import { encodeOutput, unspentOutput } from '../../../src/history/output.mjs';
import { decodeTx, assembleTx } from '../../../src/history/tx.mjs';
import { utxoFromCbor, utxoJson, addressTextOf } from '../../../src/state/utxo.mjs';
import { HISTORY_FORMAT } from '../../../src/state/history.mjs';
import { paramsFromRow } from '../../../src/history/params.mjs';
import { input, vkeyWitness, baseAddr, keyHash, STAKE } from '../../lib/txcbor.mjs';
import { fidelityOfFiles, quantiles, cmdFidelity } from '../../../src/fidelity/fidelity.mjs';

const ADA = 1000000n;
const A0 = baseAddr(keyHash(0), STAKE, 0);
const EXT = baseAddr('ee'.repeat(28), 'ef'.repeat(28), 0);
const POL = 'cc'.repeat(28);
const TOKEN = [{ policy: POL, name: '4e4654', qty: 1n }];
const txid = (n) => n.toString(16).padStart(2, '0').repeat(32);
const hex = (b) => Buffer.from(b).toString('hex');
const SET = (items) => encTag(258, encArray(items));
const PARAMS = paramsFromRow('preprod', { epoch_no: 300, protocol_major: 10, min_fee_a: 44, min_fee_b: 155381, coins_per_utxo_size: 4310, max_val_size: 5000, max_tx_size: 16384, max_collateral_inputs: 3, collateral_percent: 150, price_mem: 0.0577, price_step: 0.0000721, min_fee_ref_script_cost_per_byte: 15, key_deposit: 2000000, pool_deposit: 500000000, drep_deposit: 500000000, gov_action_deposit: 100000000000 });

// The observed transaction's ledger size, in the kit's encodings.
function observedSize({ inputs, outputs, vkeys, body = [] }) {
  const pairs = [[encUint(0), SET(inputs)], [encUint(1), encArray(outputs)], [encUint(2), encUint(200000)], ...body];
  return decodeTx(assembleTx({ body: encMap(pairs), wits: encMap([[encUint(0), SET(vkeys)]]), aux: null, isValid: true, alonzo: true })).size;
}

const startUtxo = (n, coin) => utxoFromCbor(unspentOutput(txid(n), 0, encodeOutput({ address: A0, coin, assets: [] }, 'array')).toString('hex'), { origin: 'initial' });
const requestedOut = (bytes, address, coin, assets, index, extra = {}) => ({ cbor: hex(bytes), address: addressTextOf(address), coin: String(coin), assets: assets.map((a) => ({ ...a, qty: String(a.qty) })), datum: null, scriptRef: null, raised: null, index, wallet: false, scriptPayment: false, ...extra });

function intentJson(id, type, { requested, walletInputs, walletOutputs, walletWitnesses, size, fixed = null, script = false }) {
  return {
    id: txid(id),
    source: 'replay',
    type,
    time: { slot: id, blockTime: id * 10, blockIndex: 0, epoch: 300, block: id },
    requested,
    implicit: { withdrawals: '0', refunds: '0', deposits: '0', donation: '0', mint: [], burn: [] },
    fixed: fixed && { inputs: [], referenceInputs: [], body: {}, witnesses: {}, redeemers: [], auxiliaryData: null, scriptFee: '0', fixedBytes: 0, refScriptBytes: 0, ...fixed },
    collateral: { required: script, observed: null },
    invalid: null,
    burst: null,
    observed: { tx: txid(id), size, fee: '200000', epoch: 300, protocolMajor: 10, minFeeA: '44', minFeeB: '155381', walletInputs, walletOutputs, walletWitnesses },
    classes: {},
    derived: null
  };
}

// The constructed history file and the sizes its transactions were given.
function historyText({ split = 'exploration' } = {}) {
  const start = [10, 11, 12, 13, 14].map((n) => startUtxo(n, 10n * ADA));
  const inRec = (u) => ({ ref: u.ref, cbor: u.cbor });
  const pay = encodeOutput({ address: EXT, coin: 2n * ADA, assets: [] }, 'array');
  const change = encodeOutput({ address: A0, coin: 7800000n, assets: [] }, 'array');
  const w0 = { keyHash: keyHash(0), cbor: hex(vkeyWitness(0)) };
  const events = [];

  // A: the rebuild has the observed size.
  const sizeA = observedSize({ inputs: [input(txid(10), 0)], outputs: [pay, change], vkeys: [vkeyWitness(0)] });
  events.push(intentJson(1, 'T1', { requested: [requestedOut(pay, EXT, 2n * ADA, [], 0)], walletInputs: [inRec(start[0])], walletOutputs: [{ index: 1, cbor: hex(change) }], walletWitnesses: [w0], size: sizeA }));

  // B: a second vkey witness for the wallet's key, which the rebuild cannot
  // know.
  const sizeB = observedSize({ inputs: [input(txid(11), 0)], outputs: [pay, change], vkeys: [vkeyWitness(0), vkeyWitness(1)] });
  events.push(intentJson(2, 'T1', { requested: [requestedOut(pay, EXT, 2n * ADA, [], 0)], walletInputs: [inRec(start[1])], walletOutputs: [{ index: 1, cbor: hex(change) }], walletWitnesses: [w0, { keyHash: keyHash(0), cbor: hex(vkeyWitness(1)) }], size: sizeB }));

  // C: a script spend.
  events.push(intentJson(3, 'T6', { requested: [requestedOut(pay, EXT, 2n * ADA, [], 0)], walletInputs: [inRec(start[2])], walletOutputs: [{ index: 1, cbor: hex(change) }], walletWitnesses: [w0], size: sizeA, script: true, fixed: { redeemers: [{ tag: 0, target: { kind: 'input', ref: start[2].ref }, data: '00', exUnits: ['1000', '1000'] }] } }));

  // D: a purchase. The seller's input brings the token; the observed change
  // in the map form carries it; the transaction carries a network id.
  const sellerOut = encodeOutput({ address: EXT, coin: 3n * ADA, assets: TOKEN }, 'array');
  const seller = { ref: `${txid(30)}#0`, cbor: unspentOutput(txid(30), 0, sellerOut).toString('hex') };
  const pay3 = encodeOutput({ address: EXT, coin: 3n * ADA, assets: [] }, 'array');
  const changeMap = encodeOutput({ address: A0, coin: 9800000n, assets: TOKEN }, 'map');
  const inflow = encodeOutput({ address: A0, coin: 1200000n, assets: TOKEN }, 'array');
  const other = vkeyWitness(2);
  const sizeD = observedSize({ inputs: [input(txid(13), 0), input(txid(30), 0)], outputs: [pay3, changeMap], vkeys: [vkeyWitness(0), other], body: [[encUint(15), encUint(0)]] });
  events.push(intentJson(4, 'T2', {
    requested: [requestedOut(pay3, EXT, 3n * ADA, [], 0), requestedOut(inflow, A0, 1200000n, TOKEN, null, { wallet: true, from: 1, inflow: true })],
    walletInputs: [inRec(start[3])],
    walletOutputs: [{ index: 1, cbor: hex(changeMap) }],
    walletWitnesses: [w0],
    size: sizeD,
    fixed: { inputs: [seller], body: { 15: '00' }, witnesses: { 0: hex(encArray([other])) }, fixedBytes: 2 + 101 + 40 }
  }));

  // E: a body field 6, which no Conway transaction carries.
  events.push(intentJson(5, 'T7', { requested: [requestedOut(pay, EXT, 2n * ADA, [], 0)], walletInputs: [inRec(start[4])], walletOutputs: [{ index: 1, cbor: hex(change) }], walletWitnesses: [w0], size: sizeA, fixed: { body: { 6: 'a0' } } }));

  const lines = [
    { kind: 'header', format: HISTORY_FORMAT, network: 'preprod', wallet: 42, frame: 'recent', split, window: { first: { time: 0 }, last: { time: 1000 } }, snapshot: { block: 1, tx: 1 }, params: PARAMS, franken: [], arrival: [], latestKeyBase: { address: addressTextOf(A0), txId: 14, index: 0 }, settings: {}, source: { bytes: 'tx_cbor' } },
    { kind: 'state', at: { tx: 1 }, utxos: start.map((u, i) => ({ ...utxoJson(u), txId: 10 + i })) },
    ...events.map((intent, i) => ({ kind: 'intent', txId: 20 + i, intent })),
    { kind: 'self-reorganization', tx: txid(40), txId: 40, time: {}, burst: null, withdrawal: '0', heldConsumed: [], observed: { walletInputs: [], walletOutputs: [{ index: 0, cbor: hex(change) }] } },
    { kind: 'end', at: { tx: 41 }, utxos: 6, digest: '00', counts: { deposit: 0, 'held-consumed': 0, intent: 5, 'self-reorganization': 1, mark: 0 } }
  ];
  return { text: lines.map((l) => JSON.stringify(l)).join('\n') + '\n', sizes: { A: sizeA, B: sizeB, D: sizeD } };
}

test('quantiles by the nearest rank', () => {
  assert.equal(quantiles([]), null);
  const q = quantiles([3, 1, 2, 4]);
  assert.deepEqual([q.p0, q.p25, q.p50, q.p75, q.p100], [1, 1, 2, 3, 4]);
});

test('the fidelity check rebuilds each spend that runs no script and compares its minimum fee with the observed size\'s', { skip }, async () => {
  const T = await treatment();
  const dir = mkdtempSync(join(tmpdir(), 'research-sim-fidelity-'));
  try {
    const { text, sizes } = historyText();
    const path = join(dir, '42.recent.jsonl');
    writeFileSync(path, text);
    const r = fidelityOfFiles(T, [path]);
    assert.equal(r.network, 'preprod');
    const w = r.windows.recent;
    assert.equal(w.intents, 5);
    assert.equal(w.scriptSpends, 1, 'the script spend is left out');
    assert.equal(w.selfReorganizations, 1);
    assert.equal(w.spends, 4);
    assert.equal(w.rebuilt, 3);
    assert.deepEqual(w.apart, { 'body field 6 (protocol parameter updates) cannot appear in a Conway transaction': 1 });
    // A and D within 2%, B outside; the share counts the spend set apart.
    assert.equal(w.within, 2);
    assert.equal(w.outside, 1);
    assert.equal(w.share, 0.5);
    assert.equal(w.shareOfRebuilt, 2 / 3);
    assert.equal(w.reaches, false);
    // Bytes: A 0, D -4 (the network id and the map form's keys), B -101 (the
    // second witness).
    assert.deepEqual([w.byteDifference.p0, w.byteDifference.p50, w.byteDifference.p100], [-101, -4, 0]);
    assert.equal(w.relativeDifference.zero, 1);
    assert.equal(w.relativeDifference.below, 2);
    const fee = (size) => 44 * size + 155381;
    assert.equal(w.relativeDifference.quantiles.p0, Math.round((-101 * 44 / fee(sizes.B)) * 1e6) / 1e6);
    assert.ok(w.relativeDifference.quantiles.p0 < -0.02);
    // With the leftovers kept, D is 2 bytes smaller (the map form's keys).
    assert.equal(w.leftoversKept.within, 2);
    assert.equal(w.leftoversKept.quantiles.p50, Math.round((-2 * 44 / fee(sizes.D)) * 1e6) / 1e6);
    // What the spend outside has: one witness fewer than observed.
    assert.deepEqual(w.traits.outside.witnessDifference, { '-1': 1 });
    assert.deepEqual(w.traits.rebuilt.networkIdLeftOut, { false: 2, true: 1 });
    assert.deepEqual(w.traits.rebuilt.mapFormChange, { false: 2, true: 1 });
    assert.deepEqual(w.traits.rebuilt.otherVkeyWitnesses, { false: 2, true: 1 });
    // The UTxO set followed through the events ends at the file's count.
    assert.deepEqual(w.stateCheck, { files: 1, differ: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the fidelity command writes its records under the private root and refuses a confirmation-split file without the analysis-freeze transaction', { skip }, async () => {
  await treatment();
  const dir = mkdtempSync(join(tmpdir(), 'research-sim-fidelity-'));
  const home = process.env.RESEARCH_SIM_HOME;
  try {
    process.env.RESEARCH_SIM_HOME = join(dir, 'home');
    const hist = join(dir, 'history');
    mkdirSync(hist);
    writeFileSync(join(hist, '42.recent.jsonl'), historyText().text);
    const opts = { _: [], treatment: TREATMENT_DIR, ...(process.env.RESEARCH_SIM_TREATMENT_PINS ? { treatmentPins: process.env.RESEARCH_SIM_TREATMENT_PINS } : {}), history: hist, runId: 'fidelity-test' };
    const out = await cmdFidelity(opts);
    assert.deepEqual(out.print.windows.recent, { files: 1, spends: 4, rebuilt: 3, within: 2, apart: 1, share: 0.5, reaches: false });
    const rec = JSON.parse(readFileSync(join(dir, 'home', 'preprod', 'fidelity-test', 'fidelity.json'), 'utf8'));
    assert.equal(rec.tolerance, 0.02);
    assert.equal(rec.threshold, 0.99);
    assert.equal(rec.windows.recent.within, 2);
    const run = JSON.parse(readFileSync(join(dir, 'home', 'preprod', 'fidelity-test', 'run.json'), 'utf8'));
    assert.equal(run.command, 'fidelity');
    assert.equal(run.analysisFreezeTx, null);

    writeFileSync(join(hist, '42.recent.jsonl'), historyText({ split: 'confirmation' }).text);
    await assert.rejects(cmdFidelity({ ...opts, runId: 'fidelity-test-2' }), /confirmation split/);
    const freeze = 'ab'.repeat(32);
    await cmdFidelity({ ...opts, runId: 'fidelity-test-3', analysisFreezeTx: freeze });
    const run3 = JSON.parse(readFileSync(join(dir, 'home', 'preprod', 'fidelity-test-3', 'run.json'), 'utf8'));
    assert.equal(run3.analysisFreezeTx, freeze);
    assert.equal(run3.confirmationFiles, 1);
  } finally {
    if (home === undefined) delete process.env.RESEARCH_SIM_HOME;
    else process.env.RESEARCH_SIM_HOME = home;
    rmSync(dir, { recursive: true, force: true });
  }
});
