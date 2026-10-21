// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Blockfrost client and the Koios/Blockfrost cross-check, against fakes:
// agreement, divergence, 404, 403, 418 and 429, and the project id never
// leaving the request header.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Blockfrost, BlockfrostError, BLOCKFROST_HOSTS, blockfrostFor } from '../src/blockfrost.mjs';
import { crossCheck } from '../src/verify.mjs';
import { Store } from '../src/store.mjs';
import { tempHome } from './helpers.mjs';
import { fakeChain, fakeBlockfrost, blockOf, TEST_PROJECT_ID } from './fixtures.mjs';

const H = 'ab'.repeat(32);
const CBOR = '84a40081825820' + 'ee'.repeat(32) + '00';

function both({ kBlock = blockOf(), bBlock = blockOf(), kCbor = CBOR, bCbor = CBOR, override = {} } = {}) {
  const k = fakeChain('preprod', { txs: { [H]: { cbor: kCbor, confirmations: 20, block: kBlock.koios } } });
  const b = fakeBlockfrost('preprod', { txs: { [H]: { cbor: bCbor, block: bBlock.blockfrost } }, override });
  return { koios: k.koios({ txHashes: [H] }), bf: b.bf({ txHashes: [H] }), b };
}

test('the host is chosen by network, and the project id travels only in the project_id header', async () => {
  assert.equal(BLOCKFROST_HOSTS.mainnet, 'https://cardano-mainnet.blockfrost.io/api/v0');
  assert.equal(BLOCKFROST_HOSTS.preprod, 'https://cardano-preprod.blockfrost.io/api/v0');
  assert.equal(new Blockfrost('mainnet', { projectId: 'x' }).base, BLOCKFROST_HOSTS.mainnet);
  const { b, bf } = both();
  await bf.guard();
  assert.equal(b.headers[0].project_id, TEST_PROJECT_ID);
  assert.ok(!b.calls.some((p) => p.includes(TEST_PROJECT_ID)));
  assert.ok(!JSON.stringify(bf).includes(TEST_PROJECT_ID), 'the id is not an enumerable property');
});

test('cross-check: agreement on the transaction CBOR and every block fact', async () => {
  const { koios, bf } = both();
  const r = await crossCheck({ koios, bf, txHash: H });
  assert.equal(r.ok, true, r.issues.join('; '));
  assert.equal(r.koios.block_hash, r.blockfrost.block_hash);
  assert.equal(r.depth.koios, 5319315 - 5319000 + 1);
  assert.ok(r.blockfrost_calls.every((c) => !c.includes(TEST_PROJECT_ID)));
});

test('cross-check: a different block hash, slot or CBOR fails, naming both values', async () => {
  for (const [kBlock, bBlock, re] of [
    [blockOf(), blockOf({ hash: 'cc'.repeat(32) }), /block_hash: Koios b{64}, Blockfrost c{64}/],
    [blockOf(), blockOf({ slot: 136700001 }), /slot: Koios 136700000, Blockfrost 136700001/],
    [blockOf(), blockOf({ epochSlot: 101601 }), /epoch_slot/]
  ]) {
    const { koios, bf } = both({ kBlock, bBlock });
    const r = await crossCheck({ koios, bf, txHash: H });
    assert.equal(r.ok, false);
    assert.match(r.issues.join('; '), re);
  }
  const { koios, bf } = both({ bCbor: CBOR.replace(/00$/, '01') });
  const r = await crossCheck({ koios, bf, txHash: H });
  assert.match(r.issues.join('; '), /CBOR differs/);
});

test('cross-check: a transaction Blockfrost does not know (404) fails; it is never skipped', async () => {
  const k = fakeChain('preprod', { txs: { [H]: { cbor: CBOR, confirmations: 20, block: blockOf().koios } } });
  const b = fakeBlockfrost('preprod');
  const r = await crossCheck({ koios: k.koios({ txHashes: [H] }), bf: b.bf({ txHashes: [H] }), txHash: H });
  assert.equal(r.ok, false);
  assert.match(r.issues.join('; '), /Blockfrost does not have it/);
});

test('403, 418 and 402 stop with what they mean, and the error never carries the project id', async () => {
  for (const [status, re] of [[403, /not accepted for this network/], [418, /banned/], [402, /daily request limit/]]) {
    const b = fakeBlockfrost('preprod', { override: { '/genesis': { status, body: `{"error":"echo ${TEST_PROJECT_ID}"}` } } });
    await assert.rejects(b.bf().guard(), (e) => {
      assert.ok(e instanceof BlockfrostError);
      assert.match(e.message, re);
      assert.ok(!e.message.includes(TEST_PROJECT_ID), 'redacted');
      return true;
    });
  }
});

test('429 is retried after Retry-After, then succeeds; exhausted retries fail', async () => {
  let n = 0;
  const sleeps = [];
  const b = fakeBlockfrost('preprod', { override: { '/genesis': () => (n++ < 2 ? { status: 429, body: '{}', headers: { 'retry-after': '3' } } : null) } });
  const bf = b.bf({}, { sleepImpl: async (ms) => sleeps.push(ms) });
  await bf.guard();
  assert.deepEqual(sleeps, [3000, 3000]);
  const always = fakeBlockfrost('preprod', { override: { '/genesis': { status: 429, body: '{}' } } });
  await assert.rejects(always.bf({}, { retries: 2 }).guard(), /HTTP 429 \(the rate limit is exceeded\)/);
});

test('the network guard refuses a project of the other network', async () => {
  const b = fakeBlockfrost('preprod', { genesis: { network_magic: 764824073 } });
  await assert.rejects(b.bf().guard(), /expects network magic 1/);
});

test('only the tool\'s own transactions and their blocks are queried', async () => {
  const { bf } = both();
  await assert.rejects(bf.tx('cd'.repeat(32)), /not one of this tool's own/);
  await assert.rejects(bf.block('bb'.repeat(32)), /does not hold one of this tool's own/);
  await bf.tx(H);
  assert.equal((await bf.block('bb'.repeat(32))).hash, 'bb'.repeat(32));
});

test('the project id is read from secrets/blockfrost-<network>.token at 0600; no file means no client', () => {
  const store = new Store(tempHome());
  store.ensure();
  assert.equal(blockfrostFor(store, 'preprod'), null);
  const f = store.path('secrets', 'blockfrost-preprod.token');
  fs.writeFileSync(f, `${TEST_PROJECT_ID}\n`, { mode: 0o600 });
  const bf = blockfrostFor(store, 'preprod');
  assert.equal(bf.base, BLOCKFROST_HOSTS.preprod);
  assert.equal(blockfrostFor(store, 'mainnet'), null);
  fs.chmodSync(f, 0o644);
  assert.throws(() => blockfrostFor(store, 'preprod'), /wider than 600/);
});
