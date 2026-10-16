// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The journal state machine against a fake Koios.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Koios } from '../src/koios.mjs';
import { Store } from '../src/store.mjs';
import { journal, journalEntry, submitJournaled, abandon, assertNoUnresolved, waitConfirmed } from '../src/journal.mjs';
import { tempHome } from './helpers.mjs';

const HASH = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const ADDR = 'addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz';
const INPUT = { txHash: 'ee'.repeat(32), index: 0, coin: 5000000n };

function res(status, body, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

// A scripted Koios: `submit` is a queue of responses (or 'lost' to throw);
// `status` returns confirmations for the hash (null when unknown); `utxos`
// says whether the journaled input is still unspent.
function fakeKoios({ submit = [], status = () => null, unspent = () => true, tipSlot = 100, info = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://fake.koios/api/v1', '');
    calls.push({ path, method: init.method });
    if (path === '/submittx') {
      const next = submit.shift();
      if (next === 'lost' || next === undefined) throw new Error('socket hang up');
      return next;
    }
    if (path === '/tx_status') {
      const { _tx_hashes } = JSON.parse(init.body);
      return res(200, _tx_hashes.map((h) => ({ tx_hash: h, num_confirmations: status(h) })));
    }
    if (path.startsWith('/address_utxos')) return res(200, unspent() ? [{ tx_hash: INPUT.txHash, tx_index: 0, address: ADDR, value: '5000000', asset_list: [] }] : []);
    if (path === '/tip') return res(200, [{ epoch_no: 1, abs_slot: tipSlot, block_height: 1000, hash: '00', block_time: 1 }]);
    if (path === '/tx_info') return res(200, [{ tx_hash: HASH, block_height: 990, block_hash: 'bb'.repeat(32), absolute_slot: 90, tx_timestamp: 1700000000, epoch_no: 1, ...info }]);
    throw new Error(`unexpected ${path}`);
  };
  const k = new Koios('preprod', { baseUrl: 'https://fake.koios/api/v1', fetchImpl, sleepImpl: async () => {}, own: { addresses: [ADDR], txHashes: [HASH] }, spacingMs: 0 });
  return { k, calls };
}

function setup(hash = HASH) {
  const store = new Store(tempHome());
  store.ensure();
  const entry = journal(store, journalEntry({ network: 'preprod', txHash: hash, cbor: '84a0a0f5f6', ttl: 500, inputs: [INPUT], run: '/nowhere' }));
  return { store, entry };
}

let clock = 0;
const now = () => clock;
const sleep = async (ms) => {
  clock += ms;
};

test('a lost response, then "All inputs are spent", then the hash is found with confirmations: submitted', async () => {
  const { store, entry } = setup();
  let seen = 0;
  const { k } = fakeKoios({ submit: ['lost', res(400, 'ApplyTxError: All inputs are spent. Transaction has probably already been included')], status: () => (++seen >= 3 ? 2 : null) });
  const r = await submitJournaled({ koios: k, store, entry, address: ADDR, sleep, now, pollMs: 1000, windowMs: 600000 });
  assert.equal(r.outcome, 'submitted');
  const j = store.readJournal('preprod');
  assert.equal(j.current.state, 'submitted');
  assert.equal(j.current.attempts.length, 3);
  assert.match(j.current.attempts[0].result, /no usable response/);
});

test('the same with the hash absent and the inputs spent: a failure, never a success', async () => {
  const { store, entry } = setup();
  const { k } = fakeKoios({ submit: [res(400, '{"error":"BadInputsUTxO"}')], status: () => null, unspent: () => false });
  await assert.rejects(submitJournaled({ koios: k, store, entry, address: ADDR, sleep, now, pollMs: 60000, windowMs: 600000 }), /inputs consumed by another transaction/);
  assert.equal(store.readJournal('preprod').current.state, 'failed');
});

test('the hash absent but the inputs unspent after ten minutes: unresolved, the journal keeps it', async () => {
  const { store, entry } = setup();
  const { k } = fakeKoios({ submit: [res(400, 'already been included')], status: () => null, unspent: () => true });
  await assert.rejects(submitJournaled({ koios: k, store, entry, address: ADDR, sleep, now, pollMs: 60000, windowMs: 600000 }), /unresolved/);
  assert.equal(store.readJournal('preprod').current.state, 'unsubmitted');
  assert.throws(() => assertNoUnresolved(store, 'preprod'), /unresolved preprod transaction/);
});

test('429 then success', async () => {
  const { store, entry } = setup();
  const { k, calls } = fakeKoios({ submit: [res(429, 'slow down', { 'retry-after': '1' }), res(202, `"${HASH}"`)] });
  const r = await submitJournaled({ koios: k, store, entry, address: ADDR, sleep, now });
  assert.equal(r.outcome, 'submitted');
  assert.equal(calls.filter((c) => c.path === '/submittx').length, 2, 'identical bytes sent twice');
});

test('a returned id that differs from the computed hash: a failure', async () => {
  const { store, entry } = setup();
  const { k } = fakeKoios({ submit: [res(202, `"${OTHER}"`)] });
  await assert.rejects(submitJournaled({ koios: k, store, entry, address: ADDR, sleep, now }), /different|returned the id/);
  assert.notEqual(store.readJournal('preprod').current.state, 'submitted');
});

test('any other rejection stops with the node\'s message verbatim', async () => {
  const { store, entry } = setup();
  const msg = '{"contents":{"era":"ShelleyBasedEraConway","error":["ConwayUtxowFailure (UtxoFailure (FeeTooSmallUTxO ...))"]}}';
  const { k } = fakeKoios({ submit: [res(400, msg)] });
  await assert.rejects(submitJournaled({ koios: k, store, entry, address: ADDR, sleep, now }), (e) => e.message.includes(msg));
});

test('no second transaction is journaled while one is unresolved', () => {
  const { store } = setup();
  assert.throws(() => journal(store, journalEntry({ network: 'preprod', txHash: OTHER, cbor: '00', ttl: 1, inputs: [INPUT], run: '/x' })), /unresolved/);
  assert.doesNotThrow(() => assertNoUnresolved(store, 'mainnet'), 'journals are per network');
});

test('abandon only after the TTL, with the hash unknown and the inputs unspent', async () => {
  {
    const { store } = setup();
    await assert.rejects(abandon({ koios: fakeKoios({ tipSlot: 400 }).k, store, network: 'preprod', address: ADDR }), /has not passed/);
    await assert.rejects(abandon({ koios: fakeKoios({ tipSlot: 600, status: () => 0 }).k, store, network: 'preprod', address: ADDR }), /known to Koios/);
    await assert.rejects(abandon({ koios: fakeKoios({ tipSlot: 600, unspent: () => false }).k, store, network: 'preprod', address: ADDR }), /not all unspent/);
    const e = await abandon({ koios: fakeKoios({ tipSlot: 600 }).k, store, network: 'preprod', address: ADDR });
    assert.equal(e.state, 'abandoned');
    assert.doesNotThrow(() => assertNoUnresolved(store, 'preprod'));
  }
});

test('wait records the block facts at 15 confirmations and resolves the entry', async () => {
  const { store, entry } = setup();
  let n = 0;
  const { k } = fakeKoios({ status: () => (n++ < 2 ? 3 : 15) });
  const facts = await waitConfirmed({ koios: k, store, entry, sleep, now, pollMs: 1000 });
  assert.equal(facts.confirmations, 15);
  assert.equal(facts.block_hash, 'bb'.repeat(32));
  const j = store.readJournal('preprod');
  assert.equal(j.current, null);
  assert.equal(j.history.at(-1).state, 'confirmed');
});

test('the Koios client refuses addresses and transactions that are not the tool\'s own', async () => {
  const { k } = fakeKoios();
  await assert.rejects(k.addressUtxos('addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae'), /not this identity/);
  await assert.rejects(k.txStatus(OTHER), /not one of this tool's own/);
  await assert.rejects(k.txCbor(OTHER), /not one of this tool's own/);
  await assert.rejects(k.txInfo(OTHER), /not one of this tool's own/);
});

test('the network guard refuses an endpoint that reports the other network', async () => {
  const genesis = (magic, id) => async () => res(200, [{ networkmagic: magic, networkid: id }]);
  await assert.rejects(new Koios('mainnet', { baseUrl: 'https://x', fetchImpl: genesis('1', 'Testnet'), spacingMs: 0 }).guard(), /refusing to run/);
  await assert.rejects(new Koios('preprod', { baseUrl: 'https://x', fetchImpl: genesis('764824073', 'Mainnet'), spacingMs: 0 }).guard(), /refusing to run/);
  await assert.rejects(new Koios('preprod', { baseUrl: 'https://x', fetchImpl: genesis('2', 'Testnet'), spacingMs: 0 }).guard(), /refusing to run/);
  await new Koios('preprod', { baseUrl: 'https://x', fetchImpl: genesis('1', 'Testnet'), spacingMs: 0 }).guard();
  await new Koios('mainnet', { baseUrl: 'https://x', fetchImpl: genesis('764824073', 'Mainnet'), spacingMs: 0 }).guard();
});
