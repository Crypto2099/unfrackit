// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// `restore --identity <name>`: recreating an identity from its typed
// mnemonics, only in a terminal, never over existing secrets, and checked
// against public.json or an expected signing key.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { restoreIdentity, normalizeTyped } from '../src/restore.mjs';
import { tempHome } from './helpers.mjs';
import { testIdentity, seededMnemonic } from './fixtures.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

// A terminal that types `answers` in turn, each after its prompt appears.
function terminal(answers, tty = true) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.isTTY = tty;
  stdout.isTTY = tty;
  let shown = '';
  const queue = [...answers];
  stdout.on('data', (b) => {
    shown += b.toString();
    if (/mnemonic \(24 words, one line\): $/.test(shown) && queue.length) setImmediate(() => stdin.write(`${queue.shift()}\n`));
  });
  return { stdin, stdout, shown: () => shown };
}

function source(label = 'restore source') {
  const store = new Store(tempHome());
  store.ensure();
  return testIdentity(store, 'rehearsal', label);
}

test('restore refuses without an interactive terminal, in the module and from the command line', async () => {
  const store = new Store(tempHome());
  await assert.rejects(restoreIdentity({ store, name: 'rehearsal', streams: terminal([], false) }), /interactive terminal/);
  const home = tempHome();
  const r = spawnSync(process.execPath, [CLI, 'restore', '--identity', 'rehearsal'], { encoding: 'utf8', env: { ...process.env, RESEARCH_FREEZE_HOME: home }, input: 'abandon\n' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /interactive terminal/);
  assert.equal(fs.existsSync(path.join(home, 'identities', 'rehearsal')), false);
});

test('restore writes both mnemonics (0600) and the public facts, without echoing the words', async () => {
  const src = source();
  const store = new Store(tempHome());
  const t = terminal([src.signingMnemonic, src.paymentMnemonic]);
  const r = await restoreIdentity({ store, name: 'rehearsal', expectSigningKey: src.pub.signing_public_key, streams: t });
  assert.equal(r.facts.signing_public_key, src.pub.signing_public_key);
  const dir = path.join(store.home, 'identities', 'rehearsal');
  assert.equal(fs.readFileSync(path.join(dir, 'signing-mnemonic'), 'utf8').trim(), src.signingMnemonic);
  assert.equal(fs.readFileSync(path.join(dir, 'payment-mnemonic'), 'utf8').trim(), src.paymentMnemonic);
  for (const f of ['signing-mnemonic', 'payment-mnemonic', 'public.json']) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
  const pub = store.readPublic('rehearsal');
  assert.deepEqual(pub.networks, ['preprod']);
  assert.equal(pub.addresses.preprod, src.pub.addresses.preprod);
  assert.ok(!t.shown().includes(src.signingMnemonic.split(' ').slice(0, 3).join(' ')), 'the words are not echoed');
});

test('restore never overwrites an existing mnemonic file', async () => {
  const src = source();
  const store = new Store(tempHome());
  store.ensure();
  testIdentity(store, 'rehearsal', 'already here');
  const before = fs.readFileSync(path.join(store.home, 'identities', 'rehearsal', 'signing-mnemonic'), 'utf8');
  await assert.rejects(restoreIdentity({ store, name: 'rehearsal', streams: terminal([src.signingMnemonic, src.paymentMnemonic]) }), /refusing to overwrite/);
  assert.equal(fs.readFileSync(path.join(store.home, 'identities', 'rehearsal', 'signing-mnemonic'), 'utf8'), before);
});

test('with only public.json left, restore checks the typed mnemonics against it', async () => {
  const store = new Store(tempHome());
  store.ensure();
  const kept = testIdentity(store, 'rehearsal', 'kept public file');
  const dir = path.join(store.home, 'identities', 'rehearsal');
  fs.rmSync(path.join(dir, 'signing-mnemonic'));
  fs.rmSync(path.join(dir, 'payment-mnemonic'));
  const publicBefore = fs.readFileSync(path.join(dir, 'public.json'), 'utf8');
  const wrong = source('a different pair');
  await assert.rejects(restoreIdentity({ store, name: 'rehearsal', streams: terminal([wrong.signingMnemonic, wrong.paymentMnemonic]) }), /do not give this identity's public\.json/);
  assert.equal(fs.existsSync(path.join(dir, 'signing-mnemonic')), false, 'nothing was written');
  // Swapped mnemonics give other keys too.
  await assert.rejects(restoreIdentity({ store, name: 'rehearsal', streams: terminal([kept.paymentMnemonic, kept.signingMnemonic]) }), /public\.json/);
  const r = await restoreIdentity({ store, name: 'rehearsal', streams: terminal([kept.signingMnemonic, kept.paymentMnemonic]) });
  assert.deepEqual(r.checkedAgainst, ['public.json']);
  assert.equal(fs.readFileSync(path.join(dir, 'public.json'), 'utf8'), publicBefore, 'public.json is left as it was');
});

test('restore checks the signing key passed with --signing-key, and refuses short or mistyped mnemonics', async () => {
  const src = source();
  await assert.rejects(restoreIdentity({ store: new Store(tempHome()), name: 'rehearsal', expectSigningKey: 'ab'.repeat(32), streams: terminal([src.signingMnemonic, src.paymentMnemonic]) }), /not the expected/);
  const ok = await restoreIdentity({ store: new Store(tempHome()), name: 'rehearsal', expectSigningKey: src.pub.signing_public_key, streams: terminal([src.signingMnemonic, src.paymentMnemonic]) });
  assert.deepEqual(ok.checkedAgainst, ['--signing-key']);
  const key = src.pub.signing_public_key;
  const short = src.signingMnemonic.split(' ').slice(0, 23).join(' ');
  await assert.rejects(restoreIdentity({ store: new Store(tempHome()), name: 'rehearsal', expectSigningKey: key, streams: terminal([short, src.paymentMnemonic]) }), /23 words is refused/);
  const typo = src.signingMnemonic.replace(/^\S+/, 'zoo');
  await assert.rejects(restoreIdentity({ store: new Store(tempHome()), name: 'rehearsal', expectSigningKey: key, streams: terminal([typo, src.paymentMnemonic]) }), /checksum/);
  await assert.rejects(restoreIdentity({ store: new Store(tempHome()), name: 'rehearsal', expectSigningKey: key, streams: terminal([src.signingMnemonic, src.signingMnemonic]) }), /equal entropy/);
  // Swapped mnemonics give other keys, which --signing-key catches.
  await assert.rejects(restoreIdentity({ store: new Store(tempHome()), name: 'rehearsal', expectSigningKey: key, streams: terminal([src.paymentMnemonic, src.signingMnemonic]) }), /not the expected/);
});

test('without public.json, restore requires --signing-key, before any word is asked for', async () => {
  const src = source();
  const t = terminal([src.signingMnemonic, src.paymentMnemonic]);
  await assert.rejects(restoreIdentity({ store: new Store(tempHome()), name: 'rehearsal', streams: t }), /has no public\.json .* pass --signing-key/);
  assert.doesNotMatch(t.shown(), /mnemonic \(24 words/);
});

test('restore refuses keys that another identity of the home already has: the real words under the rehearsal name', async () => {
  const store = new Store(tempHome());
  store.ensure();
  const real = testIdentity(store, 'testfreeze', 'the real identity');
  await assert.rejects(
    restoreIdentity({ store, name: 'rehearsal', expectSigningKey: real.pub.signing_public_key, streams: terminal([real.signingMnemonic, real.paymentMnemonic]) }),
    /give the keys of identity "testfreeze"/
  );
  assert.equal(store.hasIdentity('rehearsal'), false, 'nothing was written');
});

test('the terminal is in raw mode, with a muted interface, before each prompt is shown', async () => {
  const src = source();
  const events = [];
  const t = terminal([src.signingMnemonic, src.paymentMnemonic]);
  t.stdin.setRawMode = (mode) => {
    events.push(`raw ${mode}`);
    return t.stdin;
  };
  const write = t.stdout.write.bind(t.stdout);
  t.stdout.write = (chunk, ...rest) => {
    if (/mnemonic \(24 words/.test(String(chunk))) events.push('prompt');
    return write(chunk, ...rest);
  };
  await restoreIdentity({ store: new Store(tempHome()), name: 'rehearsal', expectSigningKey: src.pub.signing_public_key, streams: t });
  assert.deepEqual(events, ['raw true', 'prompt', 'raw false', 'raw true', 'prompt', 'raw false']);
  assert.ok(!t.shown().includes(src.signingMnemonic.split(' ')[0] + ' ' + src.signingMnemonic.split(' ')[1]), 'nothing typed is echoed');
});

test('a restore whose second write fails leaves no mnemonic file behind, so the next attempt is not blocked', async () => {
  const src = source();
  const store = new Store(tempHome());
  store.ensure();
  const realRename = fs.renameSync;
  let n = 0;
  fs.renameSync = (a, b) => {
    if (/payment-mnemonic/.test(String(b)) && n++ === 0) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return realRename(a, b);
  };
  try {
    await assert.rejects(restoreIdentity({ store, name: 'rehearsal', expectSigningKey: src.pub.signing_public_key, streams: terminal([src.signingMnemonic, src.paymentMnemonic]) }), /ENOSPC/);
  } finally {
    fs.renameSync = realRename;
  }
  const dir = path.join(store.home, 'identities', 'rehearsal');
  assert.deepEqual(fs.readdirSync(dir), [], 'no mnemonic file and no temporary file');
  const again = await restoreIdentity({ store, name: 'rehearsal', expectSigningKey: src.pub.signing_public_key, streams: terminal([src.signingMnemonic, src.paymentMnemonic]) });
  assert.equal(again.facts.signing_public_key, src.pub.signing_public_key, 'the next attempt succeeds');
});

test('typed words are normalized: case, spacing and the numbers of a numbered list', () => {
  const m = seededMnemonic('normalize');
  const numbered = m.split(' ').map((w, i) => `${i + 1}. ${w.toUpperCase()}`).join('   ');
  assert.equal(normalizeTyped(numbered), m);
});
