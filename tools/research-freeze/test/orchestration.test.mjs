// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The order of the steps inside `submit`, `sweep` and `build`, against a fake
// Koios: the network guard, the mainnet prompt and its facts, the journal,
// the TTL and the submission.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Store } from '../src/store.mjs';
import { submitRun, sweep } from '../src/ops.mjs';
import { build } from '../src/build.mjs';
import { MANIFEST_FORMAT } from '../src/manifest.mjs';
import { tempHome, tempDir } from './helpers.mjs';
import { testIdentity, fakeChain, fabricateRun } from './fixtures.mjs';

function streams(tty, answer) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.isTTY = tty;
  stdout.isTTY = tty;
  let shown = '';
  stdout.on('data', (b) => {
    shown += b.toString();
    if (answer !== undefined && /Type the first eight/.test(shown)) {
      stdin.write(`${answer}\n`);
      answer = undefined;
    }
  });
  return { stdin, stdout, shown: () => shown };
}

async function mainnetRun() {
  const store = new Store(tempHome());
  store.ensure();
  const identity = testIdentity(store, 'testfreeze');
  const run = await fabricateRun(store, { network: 'mainnet', identity, extra: { stage: 'final' } });
  const utxo = { txHash: run.p.tx.inputs[0].txHash, index: 0, coin: run.p.tx.inputs[0].coin };
  return { store, identity, run, utxo };
}

test('mainnet submit without a terminal: the guard runs, then the refusal; nothing is journaled or sent', async () => {
  const { store, run } = await mainnetRun();
  const f = fakeChain('mainnet');
  const koios = f.koios({ addresses: [run.report.payment_address] });
  await assert.rejects(submitRun({ store, dir: run.dir, log: () => {}, streams: streams(false), koios }), /interactive terminal/);
  assert.deepEqual(f.calls, ['/genesis']);
  assert.equal(store.readJournal('mainnet').current, null);
});

test('mainnet submit: the prompt shows the facts of the record; wrong digits send nothing', async () => {
  const { store, run } = await mainnetRun();
  const f = fakeChain('mainnet');
  const s = streams(true, '00000000');
  await assert.rejects(submitRun({ store, dir: run.dir, log: () => {}, streams: s, koios: f.koios({ addresses: [run.report.payment_address] }) }), /did not match/);
  for (const label of ['network:', 'record kind:', 'stage:', 'research-items:', 'items:', 'CIP-20 line:', 'signing key:', 'fee:', 'inputs:', 'change:', 'TTL:']) assert.ok(s.shown().includes(label), label);
  assert.match(s.shown(), /stage:\s+final/);
  assert.match(s.shown(), new RegExp(run.report.message[0]));
  assert.deepEqual(f.calls, ['/genesis']);
  assert.equal(store.readJournal('mainnet').current, null);
});

test('mainnet submit: guard, prompt, journal, TTL check, submission, in that order', async () => {
  const { store, run } = await mainnetRun();
  let journaledAtTip = null;
  const f = fakeChain('mainnet', {
    tip: { abs_slot: 1000 },
    onCall: (p) => {
      if (p === '/tip') journaledAtTip = store.readJournal('mainnet').current?.txHash ?? null;
    }
  });
  const s = streams(true, run.hash.slice(0, 8));
  const r = await submitRun({ store, dir: run.dir, log: () => {}, streams: s, koios: f.koios({ addresses: [run.report.payment_address] }) });
  assert.equal(r.outcome, 'submitted');
  assert.deepEqual(f.calls, ['/genesis', '/tip', '/submittx']);
  assert.equal(journaledAtTip, run.hash, 'the journal entry exists before the TTL check and the submission');
  const entry = store.readJournal('mainnet').current;
  assert.equal(entry.stage, 'final');
  assert.equal(entry.kind, 'freeze');
});

test('a run whose TTL has passed is not submitted', async () => {
  const { store, run } = await mainnetRun();
  const f = fakeChain('mainnet', { tip: { abs_slot: run.p.ttl + 1 } });
  await assert.rejects(submitRun({ store, dir: run.dir, log: () => {}, streams: streams(true, run.hash.slice(0, 8)), koios: f.koios({ addresses: [run.report.payment_address] }) }), /TTL .* has passed/);
  assert.ok(!f.calls.includes('/submittx'));
});

test('mainnet sweep: assertions and the guard first, then the refusal without a terminal; nothing journaled or sent', async () => {
  const store = new Store(tempHome());
  store.ensure();
  const identity = testIdentity(store, 'testfreeze');
  const f = fakeChain('mainnet', { utxos: [{ txHash: 'ab'.repeat(32), index: 0, coin: 5000000n }] });
  const to = identity.id.payment.address('mainnet').to_bech32();
  await assert.rejects(sweep({ store, network: 'mainnet', identityName: 'testfreeze', to, log: () => {}, streams: streams(false), koios: f.koios({ addresses: [identity.pub.addresses.mainnet] }) }), /interactive terminal/);
  assert.ok(!f.calls.includes('/submittx'));
  assert.equal(store.readJournal('mainnet').current, null);
});

test('build: the identity-network refusal comes first, and the network guard runs before any mnemonic is read', async () => {
  const store = new Store(tempHome());
  store.ensure();
  const { pub } = testIdentity(store, 'rehearsal');
  const dir = tempDir();
  const doi = '10.5072/test.1';
  fs.writeFileSync(path.join(dir, 'doc.md'), `DOI of this document: ${doi}\nSigning public key: ${pub.signing_public_key}\n`);
  const mpath = path.join(dir, 'm.json');
  fs.writeFileSync(mpath, JSON.stringify({ format: MANIFEST_FORMAT, kind: 'freeze', doi, items: [{ path: 'doc.md', type: 'StudyRegistration', document: true, ids: [{ id: doi, id_type: 'DOI', relation: 'IsPartOf' }] }] }));
  const cli = {};
  await assert.rejects(build({ store, koios: fakeChain('mainnet').koios(), cli, manifestPath: mpath, network: 'mainnet', identityName: 'rehearsal' }), /preprod records only/);
  // A guard failure: the endpoint reports mainnet for a preprod build.
  let mnemonicsRead = false;
  const orig = store.readMnemonics.bind(store);
  store.readMnemonics = (n) => {
    mnemonicsRead = true;
    return orig(n);
  };
  const wrong = fakeChain('mainnet');
  const koios = wrong.koios();
  koios.network = { ...koios.network, name: 'preprod', magic: 1, koiosName: 'Testnet' };
  await assert.rejects(build({ store, koios, cli, manifestPath: mpath, network: 'preprod', identityName: 'rehearsal', coreOnly: true }), /refusing to run/);
  assert.equal(mnemonicsRead, false);
});

test('temporary secrets of a process that is gone are removed at startup; a live process\'s are kept', () => {
  const store = new Store(tempHome());
  store.ensure();
  const dead = store.path('tmp', 'secret-999999999-1-aa');
  const live = store.path('tmp', `secret-${process.pid}-2-bb`);
  const other = store.path('tmp', 'notes');
  for (const f of [dead, live, other]) fs.writeFileSync(f, 'x', { mode: 0o600 });
  assert.deepEqual(store.cleanTmp(), ['secret-999999999-1-aa']);
  assert.equal(fs.existsSync(dead), false);
  assert.equal(fs.existsSync(live), true);
  assert.equal(fs.existsSync(other), true);
});
