// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The journal state machine against a fake Koios.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Koios, parseRetryAfter } from '../src/koios.mjs';
import { Store } from '../src/store.mjs';
import { journal, journalEntry, submitJournaled, abandon, assertNoUnresolved, waitConfirmed } from '../src/journal.mjs';
import { tempHome } from './helpers.mjs';
import { fakeBlockfrost, blockOf } from './fixtures.mjs';

const HASH = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const ADDR = 'addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz';
const INPUT = { txHash: 'ee'.repeat(32), index: 0, coin: 5000000n };

function res(status, body, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

// A scripted Koios. `submit` is a queue of responses (or 'lost' to throw).
// `status` gives the confirmations for the hash (null when unknown), `info`
// whether /tx_info has a row, `unspent` whether the journaled input is still
// unspent, and `history` the transaction hashes of the address.
function fakeKoios({ submit = [], status = () => null, info = () => status() !== null, unspent = () => true, history = () => [], spends = {}, tipSlot = 100, infoRow = {}, network = 'preprod', onSubmit = () => {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://fake.koios/api/v1', '');
    calls.push({ path, method: init.method });
    if (path === '/submittx') {
      onSubmit();
      const next = submit.shift();
      if (next === 'lost' || next === undefined) throw new Error('socket hang up');
      return next;
    }
    if (path === '/tx_status') {
      const { _tx_hashes } = JSON.parse(init.body);
      return res(200, _tx_hashes.map((h) => ({ tx_hash: h, num_confirmations: status(h) })));
    }
    if (path === '/tx_info') {
      const req = JSON.parse(init.body);
      if (req._inputs) return res(200, req._tx_hashes.filter((h) => spends[h]).map((h) => ({ tx_hash: h, inputs: spends[h].map((u) => ({ tx_hash: u.txHash, tx_index: u.index })) })));
      return res(200, info() ? [{ tx_hash: HASH, block_height: 990, block_hash: 'bb'.repeat(32), absolute_slot: 90, epoch_slot: 90, tx_timestamp: 1700000000, epoch_no: 1, ...infoRow }] : []);
    }
    if (path.startsWith('/address_utxos')) return res(200, unspent() ? [{ tx_hash: INPUT.txHash, tx_index: 0, address: ADDR, value: '5000000', asset_list: [] }] : []);
    if (path.startsWith('/address_txs')) return res(200, history().map((h) => ({ tx_hash: h, epoch_no: 1, block_height: 991, block_time: 1700000001 })));
    if (path === '/tip') return res(200, [{ epoch_no: 1, abs_slot: tipSlot, block_height: 1000, hash: '00', block_time: 1 }]);
    throw new Error(`unexpected ${path}`);
  };
  const k = new Koios(network, { baseUrl: 'https://fake.koios/api/v1', fetchImpl, sleepImpl: async () => {}, own: { addresses: [ADDR], txHashes: [HASH] }, spacingMs: 0 });
  return { k, calls };
}

function setup(hash = HASH, { network = 'preprod', kind = null, stage = null } = {}) {
  const store = new Store(tempHome());
  store.ensure();
  const entry = journal(store, journalEntry({ network, txHash: hash, cbor: '84a0a0f5f6', ttl: 500, inputs: [INPUT], run: '/nowhere', kind, stage }));
  return { store, entry };
}

// A fake clock per test: sleeping advances it.
function clock() {
  let t = 0;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps
  };
}

test('a lost response, then "All inputs are spent", then the hash is found with confirmations: submitted', async () => {
  const { store, entry } = setup();
  const c = clock();
  let seen = 0;
  const { k } = fakeKoios({ submit: ['lost', res(400, 'ApplyTxError: All inputs are spent. Transaction has probably already been included')], status: () => (++seen >= 3 ? 2 : null), info: () => false });
  const r = await submitJournaled({ koios: k, store, entry, address: ADDR, sleep: c.sleep, now: c.now, pollMs: 1000, windowMs: 600000 });
  assert.equal(r.outcome, 'submitted');
  const j = store.readJournal('preprod');
  assert.equal(j.current.state, 'submitted');
  assert.equal(j.current.attempts.length, 3);
  assert.match(j.current.attempts[0].result, /no usable response/);
});

// The review's race: the resubmission is refused because the transaction sits
// in the mempool, and it is included just after the last /tx_status poll of
// the ten-minute window, so the one /address_utxos read that follows sees its
// inputs spent. Recording that as a failure would release the journal and let
// a second freeze be built on the landed transaction's change output.
test('the transaction lands just after the last poll of the window: found, never recorded as failed', async () => {
  const { store, entry } = setup();
  const c = clock();
  const POLLS = 31; // 0 s, 20 s, ..., 600 s
  let polls = 0;
  let landed = false;
  const { k } = fakeKoios({
    submit: [res(400, '{"error":"BadInputsUTxO"}')],
    status: () => {
      if (landed) return 1;
      if (++polls === POLLS) landed = true;
      return null;
    },
    info: () => false,
    unspent: () => !landed,
    history: () => (landed ? [HASH] : [])
  });
  const r = await submitJournaled({ koios: k, store, entry, address: ADDR, sleep: c.sleep, now: c.now, pollMs: 20000, windowMs: 600000 });
  assert.equal(r.outcome, 'submitted');
  assert.equal(store.readJournal('preprod').current.state, 'submitted');
  assert.throws(() => assertNoUnresolved(store, 'preprod'), /unresolved preprod transaction/, 'a landed but unconfirmed freeze still blocks the next build');
});

test('a lagging /tx_status instance while /address_utxos shows the spend: the address history finds the transaction', async () => {
  const { store, entry } = setup();
  const c = clock();
  const { k } = fakeKoios({ submit: [res(400, 'BadInputsUTxO')], status: () => null, info: () => false, unspent: () => false, history: () => [OTHER, HASH] });
  const r = await submitJournaled({ koios: k, store, entry, address: ADDR, sleep: c.sleep, now: c.now, pollMs: 60000, windowMs: 600000 });
  assert.equal(r.outcome, 'submitted');
  assert.match(r.how, /address's transaction history/);
});

test('the hash never found while the inputs read as spent: recorded as failed, which stays unresolved', async () => {
  const { store, entry } = setup();
  const c = clock();
  const { k } = fakeKoios({ submit: [res(400, '{"error":"BadInputsUTxO"}')], status: () => null, info: () => false, unspent: () => false, history: () => [OTHER] });
  await assert.rejects(submitJournaled({ koios: k, store, entry, address: ADDR, sleep: c.sleep, now: c.now, pollMs: 60000, windowMs: 600000 }), (e) => {
    assert.match(e.message, /recorded as failed, and unresolved/);
    assert.doesNotMatch(e.message, /not on chain/);
    return true;
  });
  assert.equal(store.readJournal('preprod').current.state, 'failed');
  assert.ok(c.now() >= 1200000, 'two windows of lookups before deciding');
  assert.throws(() => assertNoUnresolved(store, 'preprod'), /state failed/);
});

test('a failed entry: submit looks again without resending; wait confirms it if it lands', async () => {
  const { store, entry } = setup();
  const c = clock();
  const { k } = fakeKoios({ submit: [res(400, 'BadInputsUTxO')], status: () => null, info: () => false, unspent: () => false });
  await assert.rejects(submitJournaled({ koios: k, store, entry, address: ADDR, sleep: c.sleep, now: c.now, pollMs: 60000, windowMs: 600000 }), /failed/);
  const failed = store.readJournal('preprod').current;
  const again = fakeKoios({ status: () => null, info: () => false, unspent: () => false });
  await assert.rejects(submitJournaled({ koios: again.k, store, entry: failed, address: ADDR, sleep: c.sleep, now: c.now }), /on this look either/);
  assert.equal(again.calls.filter((x) => x.path === '/submittx').length, 0, 'nothing is resent');
  const landed = fakeKoios({ status: () => 15 });
  const facts = await waitConfirmed({ koios: landed.k, store, entry: store.readJournal('preprod').current, sleep: c.sleep, now: c.now });
  assert.equal(facts.confirmations, 15);
  assert.equal(store.readJournal('preprod').history.at(-1).state, 'confirmed');
});

test('the hash absent but the inputs unspent after ten minutes: unresolved, the journal keeps it', async () => {
  const { store, entry } = setup();
  const c = clock();
  const { k } = fakeKoios({ submit: [res(400, 'already been included')], status: () => null, unspent: () => true });
  await assert.rejects(submitJournaled({ koios: k, store, entry, address: ADDR, sleep: c.sleep, now: c.now, pollMs: 60000, windowMs: 600000 }), /unresolved/);
  assert.equal(store.readJournal('preprod').current.state, 'unsubmitted');
  assert.throws(() => assertNoUnresolved(store, 'preprod'), /unresolved preprod transaction/);
});

test('429 then success', async () => {
  const { store, entry } = setup();
  const c = clock();
  const { k, calls } = fakeKoios({ submit: [res(429, 'slow down', { 'retry-after': '1' }), res(202, `"${HASH}"`)] });
  const r = await submitJournaled({ koios: k, store, entry, address: ADDR, sleep: c.sleep, now: c.now });
  assert.equal(r.outcome, 'submitted');
  assert.equal(calls.filter((x) => x.path === '/submittx').length, 2, 'identical bytes sent twice');
});

test('a resubmission waits for the server\'s Retry-After', async () => {
  const { store, entry } = setup();
  const c = clock();
  const { k } = fakeKoios({ submit: [res(503, 'busy', { 'retry-after': '7' }), res(429, 'slow', { 'retry-after': '11' }), res(202, `"${HASH}"`)] });
  await submitJournaled({ koios: k, store, entry, address: ADDR, sleep: c.sleep, now: c.now });
  assert.deepEqual(c.sleeps, [7000, 11000]);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 12:00:30 GMT', Date.parse('Wed, 21 Oct 2026 12:00:00 GMT')), 30000);
  assert.equal(parseRetryAfter(null), null);
});

test('a returned id that differs from the computed hash: a failure', async () => {
  const { store, entry } = setup();
  const c = clock();
  const { k } = fakeKoios({ submit: [res(202, `"${OTHER}"`)] });
  await assert.rejects(submitJournaled({ koios: k, store, entry, address: ADDR, sleep: c.sleep, now: c.now }), /different|returned the id/);
  assert.notEqual(store.readJournal('preprod').current.state, 'submitted');
});

test('any other rejection stops with the node\'s message verbatim', async () => {
  const { store, entry } = setup();
  const c = clock();
  const msg = '{"contents":{"era":"ShelleyBasedEraConway","error":["ConwayUtxowFailure (UtxoFailure (FeeTooSmallUTxO ...))"]}}';
  const { k } = fakeKoios({ submit: [res(400, msg)] });
  await assert.rejects(submitJournaled({ koios: k, store, entry, address: ADDR, sleep: c.sleep, now: c.now }), (e) => e.message.includes(msg));
});

test('no second transaction is journaled while one is unresolved', () => {
  const { store } = setup();
  assert.throws(() => journal(store, journalEntry({ network: 'preprod', txHash: OTHER, cbor: '00', ttl: 1, inputs: [INPUT], run: '/x' })), /unresolved/);
  assert.doesNotThrow(() => assertNoUnresolved(store, 'mainnet'), 'journals are per network');
});

test('a journal held by another invocation is refused, not raced', () => {
  const store = new Store(tempHome());
  store.ensure();
  fs.writeFileSync(store.lockPath('preprod'), 'pid 1 since then\n', { mode: 0o600 });
  assert.throws(() => journal(store, journalEntry({ network: 'preprod', txHash: HASH, cbor: '00', ttl: 1, inputs: [INPUT], run: '/x' })), /locked by another invocation/);
  assert.equal(store.readJournal('preprod').current, null, 'nothing was written');
  fs.rmSync(store.lockPath('preprod'));
  journal(store, journalEntry({ network: 'preprod', txHash: HASH, cbor: '00', ttl: 1, inputs: [INPUT], run: '/x' }));
  assert.equal(fs.existsSync(store.lockPath('preprod')), false, 'the lock is released');
  assert.equal(store.readJournal('preprod').current.txHash, HASH);
});

test('abandon only after the TTL, with the hash unknown and the inputs unspent', async () => {
  const { store } = setup();
  await assert.rejects(abandon({ koios: fakeKoios({ tipSlot: 400 }).k, store, network: 'preprod', address: ADDR }), /has not passed/);
  await assert.rejects(abandon({ koios: fakeKoios({ tipSlot: 600, status: () => 0 }).k, store, network: 'preprod', address: ADDR }), /known to Koios/);
  await assert.rejects(abandon({ koios: fakeKoios({ tipSlot: 600, info: () => true }).k, store, network: 'preprod', address: ADDR }), /known to Koios \/tx_info/);
  await assert.rejects(abandon({ koios: fakeKoios({ tipSlot: 600, history: () => [HASH] }).k, store, network: 'preprod', address: ADDR }), /transaction history/);
  await assert.rejects(abandon({ koios: fakeKoios({ tipSlot: 600, unspent: () => false }).k, store, network: 'preprod', address: ADDR }), /not all unspent/);
  const e = await abandon({ koios: fakeKoios({ tipSlot: 600 }).k, store, network: 'preprod', address: ADDR });
  assert.equal(e.state, 'abandoned');
  assert.doesNotThrow(() => assertNoUnresolved(store, 'preprod'));
});

test('abandon a failed entry: after its TTL, with the hash unknown everywhere, only once another transaction is found to have spent its inputs', async () => {
  const { store, entry } = setup();
  const c = clock();
  const { k } = fakeKoios({ submit: [res(400, 'BadInputsUTxO')], unspent: () => false });
  await assert.rejects(submitJournaled({ koios: k, store, entry, address: ADDR, sleep: c.sleep, now: c.now, pollMs: 60000, windowMs: 600000 }), /failed/);
  await assert.rejects(abandon({ koios: fakeKoios({ tipSlot: 400, unspent: () => false }).k, store, network: 'preprod', address: ADDR }), /has not passed/);
  await assert.rejects(abandon({ koios: fakeKoios({ tipSlot: 600, unspent: () => false, history: () => [HASH] }).k, store, network: 'preprod', address: ADDR }), /transaction history/);
  // Negative reads alone (the likeliest cause is an inconsistent provider)
  // do not release it.
  await assert.rejects(abandon({ koios: fakeKoios({ tipSlot: 600, unspent: () => false, history: () => [OTHER] }).k, store, network: 'preprod', address: ADDR }), /no other transaction in the payment address's history spends them/);
  // Nor does a second provider that knows the hash.
  const known = fakeBlockfrost('preprod', { txs: { [HASH]: { cbor: '00', block: blockOf().blockfrost } } });
  await assert.rejects(abandon({ koios: fakeKoios({ tipSlot: 600, unspent: () => false, history: () => [OTHER], spends: { [OTHER]: [INPUT] } }).k, store, network: 'preprod', address: ADDR, bf: known.bf() }), /known to Blockfrost/);
  const unknown = fakeBlockfrost('preprod');
  const e = await abandon({ koios: fakeKoios({ tipSlot: 600, unspent: () => false, history: () => [OTHER], spends: { [OTHER]: [INPUT] } }).k, store, network: 'preprod', address: ADDR, bf: unknown.bf() });
  assert.equal(e.state, 'abandoned');
  assert.equal(e.abandonedFrom, 'failed');
  assert.equal(e.inputsSpentBy, OTHER);
  assert.deepEqual(e.abandonCheckedWith, ['koios', 'blockfrost']);
  assert.doesNotThrow(() => assertNoUnresolved(store, 'preprod'));
});

// A journaled entry brought to each state a submission can leave it in.
// `sent: 'killed'` is a process killed while its request was in flight: the
// journal as it stood at that moment, with no answer recorded.
async function sentEntry({ network = 'mainnet', kind = 'freeze', stage, sent }) {
  const { store, entry } = setup(HASH, { network, kind, stage });
  const c = clock();
  const run = (koios, opts = {}) => submitJournaled({ koios, store, entry, address: ADDR, sleep: c.sleep, now: c.now, pollMs: 60000, windowMs: 600000, ...opts });
  if (sent === 'accepted') await run(fakeKoios({ network, submit: [res(202, `"${HASH}"`)] }).k);
  if (sent === 'lost') await assert.rejects(run(fakeKoios({ network, submit: ['lost'] }).k, { maxAttempts: 1 }), /no usable response/);
  if (sent === 'killed') {
    let inFlight = null;
    await run(fakeKoios({ network, submit: [res(202, `"${HASH}"`)], onSubmit: () => (inFlight = store.readJournal(network)) }).k);
    store.writeJournal(network, inFlight);
  }
  if (sent === 'failed') await assert.rejects(run(fakeKoios({ network, submit: [res(400, 'BadInputsUTxO')], unspent: () => false }).k), /recorded as failed/);
  return store;
}

// What abandon would otherwise accept: the TTL passed, the hash unknown to
// Koios and Blockfrost, the inputs unspent, or for a failed entry spent by a
// transaction that is found.
function releasable(state, network = 'mainnet') {
  const failed = state === 'failed';
  return { koios: fakeKoios({ network, tipSlot: 600, unspent: () => !failed, history: () => (failed ? [OTHER] : []), spends: failed ? { [OTHER]: [INPUT] } : {} }), bf: fakeBlockfrost(network).bf() };
}

for (const stage of ['hypotheses', 'final']) {
  test(`on mainnet a ${stage}-stage freeze that may have been sent is never abandoned, whatever the answer was; one never sent still is`, async () => {
    for (const [sent, state] of [['accepted', 'submitted'], ['lost', 'unsubmitted'], ['killed', 'unsubmitted'], ['failed', 'failed']]) {
      const store = await sentEntry({ stage, sent });
      const current = store.readJournal('mainnet').current;
      assert.equal(current.state, state, sent);
      assert.ok(current.sentAt, `${sent}: the send is recorded before the request leaves`);
      if (sent === 'killed') assert.equal(current.attempts.length, 0, 'no answer was recorded');
      const { koios, bf } = releasable(state);
      await assert.rejects(abandon({ koios: koios.k, store, network: 'mainnet', address: ADDR, bf }), (e) => {
        assert.match(e.message, new RegExp(`carries a ${stage}-stage freeze record that may have left this machine`), sent);
        assert.match(e.message, /never abandoned for a newly signed one, because a broadcast body can be replayed later/);
        assert.match(e.message, /before its TTL \(slot 500\), run "wait" if it may still land/);
        if (state === 'unsubmitted') assert.match(e.message, /or "submit" again to send the same bytes/);
        if (state === 'failed') assert.match(e.message, /or "submit" again to look the hash up/);
        if (state === 'submitted') assert.doesNotMatch(e.message, /"submit" again/, 'after an HTTP 202 submit sends nothing more');
        assert.match(e.message, new RegExp(`once the TTL has passed without it landing, "build --rebuild ${HASH} --network mainnet" builds a new transaction around the same signed record and 674 line`));
        return true;
      });
      assert.deepEqual(koios.calls, [], `${sent}: refused before anything is asked of a provider`);
      assert.equal(store.readJournal('mainnet').current.state, state, `${sent}: the entry stays unresolved`);
      assert.throws(() => assertNoUnresolved(store, 'mainnet'), new RegExp(`its record cannot be abandoned: before its TTL .*"build --rebuild ${HASH} --network mainnet" builds a new transaction`));
    }
    const store = await sentEntry({ stage, sent: null });
    const { koios, bf } = releasable('unsubmitted');
    const e = await abandon({ koios: koios.k, store, network: 'mainnet', address: ADDR, bf });
    assert.equal(e.state, 'abandoned', 'built and journaled but never sent: abandonable');
  });
}

test('the rule is mainnet\'s and the staged freezes\' only: a sent preprod final, a sent mainnet scripts record and a sent sweep are abandoned as before', async () => {
  for (const [network, kind, stage] of [['preprod', 'freeze', 'final'], ['preprod', 'freeze', 'hypotheses'], ['mainnet', 'scripts', null], ['mainnet', 'retype', null], ['mainnet', 'sweep', null]]) {
    const store = await sentEntry({ network, kind, stage, sent: 'accepted' });
    const { koios, bf } = releasable('submitted', network);
    const e = await abandon({ koios: koios.k, store, network, address: ADDR, bf });
    assert.equal(e.state, 'abandoned', `${network} ${kind} ${stage}`);
  }
});

test('a mainnet final freeze is refused inside the locked journal write while another final is journaled; an abandoned one does not count', () => {
  const store = new Store(tempHome());
  store.ensure();
  const entry = (hash, stage) => journalEntry({ network: 'mainnet', txHash: hash, cbor: '00', ttl: 1, inputs: [INPUT], run: '/x', kind: 'freeze', stage });
  journal(store, entry(HASH, 'final'));
  store.updateJournal('mainnet', (j) => {
    j.current.state = 'confirmed';
    j.history = [j.current];
    j.current = null;
  });
  assert.throws(() => journal(store, entry(OTHER, 'final')), /a final-stage freeze is already journaled on mainnet/);
  assert.equal(store.readJournal('mainnet').current, null);
  assert.doesNotThrow(() => journal(store, entry(OTHER, 'hypotheses')), 'only a second final is refused');
  store.updateJournal('mainnet', (j) => {
    j.history[0].state = 'abandoned';
    j.current.state = 'confirmed';
    j.history.push(j.current);
    j.current = null;
  });
  assert.doesNotThrow(() => journal(store, entry('ef'.repeat(32), 'final')), 'an abandoned final does not block');
  // Preprod rehearsals repeat the sequence, so the rule is mainnet's only.
  journal(store, { ...entry('aa'.repeat(32), 'final'), network: 'preprod' });
  store.updateJournal('preprod', (j) => {
    j.current.state = 'confirmed';
    j.history = [j.current];
    j.current = null;
  });
  assert.doesNotThrow(() => journal(store, { ...entry('bb'.repeat(32), 'final'), network: 'preprod' }));
});

test('wait records the block facts at 15 confirmations and resolves the entry', async () => {
  const { store, entry } = setup();
  const c = clock();
  let n = 0;
  const { k } = fakeKoios({ status: () => (n++ < 2 ? 3 : 15) });
  const facts = await waitConfirmed({ koios: k, store, entry, sleep: c.sleep, now: c.now, pollMs: 1000 });
  assert.equal(facts.confirmations, 15);
  assert.equal(facts.block_hash, 'bb'.repeat(32));
  assert.equal(facts.source, 'koios');
  const j = store.readJournal('preprod');
  assert.equal(j.current, null);
  assert.equal(j.history.at(-1).state, 'confirmed');
});

test('wait treats a missing /tx_info row after 15 confirmations as "not yet"', async () => {
  const { store, entry } = setup();
  const c = clock();
  let rows = 0;
  const { k } = fakeKoios({ status: () => 15, info: () => ++rows > 2 });
  const facts = await waitConfirmed({ koios: k, store, entry, sleep: c.sleep, now: c.now, pollMs: 1000 });
  assert.equal(facts.block_height, 990);
  assert.equal(c.sleeps.length, 2);
});

test('the Koios client refuses addresses and transactions that are not the tool\'s own', async () => {
  const { k } = fakeKoios();
  const foreign = 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae';
  await assert.rejects(k.addressUtxos(foreign), /not this identity/);
  await assert.rejects(k.addressTxs(foreign), /not this identity/);
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
