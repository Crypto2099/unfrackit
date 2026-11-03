// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { confirmMainnet, requireTty } from '../src/tty.mjs';
import { Store, enclosingGitTree } from '../src/store.mjs';
import { tempHome } from './helpers.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const run = (args, env, input = '') => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, input });

function streams(tty) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.isTTY = tty;
  stdout.isTTY = tty;
  return { stdin, stdout };
}

test('the mainnet guard refuses without an interactive terminal', async () => {
  await assert.rejects(confirmMainnet('ab'.repeat(32), 'submission', streams(false)), /interactive terminal/);
  assert.throws(() => requireTty('backup', streams(false)), /interactive terminal/);
  const s = streams(true);
  s.stdin.isTTY = false;
  await assert.rejects(confirmMainnet('ab'.repeat(32), 'submission', s), /interactive terminal/);
});

test('the mainnet guard requires the first eight hex digits of the hash', async () => {
  const hash = '0123456789abcdef'.repeat(4);
  const wrong = streams(true);
  const p = confirmMainnet(hash, 'submission', wrong);
  wrong.stdin.write('01234567x\n');
  await assert.rejects(p, /did not match/);
  const right = streams(true);
  const q = confirmMainnet(hash, 'submission', right);
  right.stdin.write('01234567\n');
  await q;
});

test('init prints only public facts, writes 0600 files, and refuses an existing identity; backup refuses without a TTY', () => {
  const home = tempHome();
  const env = { RESEARCH_FREEZE_HOME: home };
  const r = run(['init', '--identity', 'rehearsal'], env);
  assert.equal(r.status, 0, r.stderr);
  const dir = path.join(home, 'identities', 'rehearsal');
  const signing = fs.readFileSync(path.join(dir, 'signing-mnemonic'), 'utf8').trim();
  const payment = fs.readFileSync(path.join(dir, 'payment-mnemonic'), 'utf8').trim();
  assert.equal(signing.split(' ').length, 24);
  // No run of three consecutive mnemonic words appears in the output (single
  // words can: "public" is both a BIP-39 word and in "signing public key").
  const out = (r.stdout + r.stderr).replace(/\s+/g, ' ');
  for (const m of [signing, payment]) {
    const w = m.split(' ');
    for (let i = 0; i + 3 <= w.length; i++) assert.ok(!out.includes(w.slice(i, i + 3).join(' ')), 'init must not print the mnemonics');
  }
  for (const f of ['signing-mnemonic', 'payment-mnemonic', 'public.json']) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const pub = JSON.parse(fs.readFileSync(path.join(dir, 'public.json'), 'utf8'));
  assert.match(r.stdout, new RegExp(pub.signing_public_key));
  assert.deepEqual(pub.networks, ['preprod']);
  const again = run(['init', '--identity', 'rehearsal'], env);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already exists/);
  assert.equal(fs.readFileSync(path.join(dir, 'signing-mnemonic'), 'utf8').trim(), signing, 'nothing was overwritten');
  const show = run(['show', '--identity', 'rehearsal'], env);
  assert.equal(show.status, 0);
  assert.match(show.stdout, new RegExp(pub.addresses.preprod));
  const backup = run(['backup', '--identity', 'rehearsal'], env);
  assert.notEqual(backup.status, 0);
  assert.match(backup.stderr, /interactive terminal/);
  assert.ok(!backup.stdout.includes(signing.split(' ')[0] + ' '), 'backup printed nothing');
});

test('a home inside a git working tree is refused before anything is written', () => {
  const inside = fileURLToPath(new URL('../.home-inside-checkout-must-not-exist', import.meta.url));
  assert.ok(enclosingGitTree(inside), 'this test runs inside a checkout');
  const r = run(['init', '--identity', 'rehearsal'], { RESEARCH_FREEZE_HOME: inside });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /inside the git working tree/);
  assert.equal(fs.existsSync(inside), false);
});

test('a secret file or directory with wider permissions is refused', () => {
  const home = tempHome();
  assert.equal(run(['init', '--identity', 'rehearsal'], { RESEARCH_FREEZE_HOME: home }).status, 0);
  const f = path.join(home, 'identities', 'rehearsal', 'payment-mnemonic');
  fs.chmodSync(f, 0o644);
  const r = run(['show', '--identity', 'rehearsal'], { RESEARCH_FREEZE_HOME: home });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /mode 644, wider than 600/);
  fs.chmodSync(f, 0o600);
  fs.chmodSync(path.join(home, 'identities'), 0o755);
  assert.match(run(['show', '--identity', 'rehearsal'], { RESEARCH_FREEZE_HOME: home }).stderr, /wider than 700/);
  fs.chmodSync(path.join(home, 'identities'), 0o700);
  assert.equal(run(['show', '--identity', 'rehearsal'], { RESEARCH_FREEZE_HOME: home }).status, 0);
});

test('the rehearsal identity cannot sign mainnet records, and other identities cannot sign preprod ones', async () => {
  const { assertIdentityNetwork } = await import('../src/build.mjs');
  assert.throws(() => assertIdentityNetwork({ name: 'rehearsal', networks: ['preprod'] }, 'mainnet'), /preprod records only/);
  assert.throws(() => assertIdentityNetwork({ name: 'freeze', networks: ['mainnet'] }, 'preprod'), /mainnet records only/);
  assert.doesNotThrow(() => assertIdentityNetwork({ name: 'freeze', networks: ['mainnet'] }, 'mainnet'));
});

test('rehearse refuses mainnet', () => {
  const home = tempHome();
  const r = run(['rehearse', 'x.json', '--network', 'mainnet'], { RESEARCH_FREEZE_HOME: home });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /preprod only/);
});

test('the store writes run directories atomically and never overwrites one', () => {
  const store = new Store(tempHome());
  store.ensure();
  const dir = store.writeRun('preprod', 'ab'.repeat(32), { 'a.txt': 'x' });
  assert.equal(fs.statSync(path.join(dir, 'a.txt')).mode & 0o777, 0o600);
  assert.throws(() => store.writeRun('preprod', 'ab'.repeat(32), { 'a.txt': 'y' }), /already exists/);
  assert.ok(store.knownTxHashes('preprod').has('ab'.repeat(32)));
});
