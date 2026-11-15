// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Published identifiers (HMAC against a fixed test key, expected values from
// OpenSSL), CIP-19 address decoding (the CIP's own test vectors,
// cardano-foundation/CIPs@befcdb75, CIP-0019/README.md "Test Vectors"), the
// password-file parser, and the init-secret command in a temporary home.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, statSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identifier, initSecret, loadKey } from '../../src/hmac.mjs';
import { decode, encode, parseAddress, rewardAddressOf } from '../../src/bech32.mjs';
import { pgpassLookup } from '../../src/db.mjs';

const KEY = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');

test('HMAC-SHA256 truncated to 16 hex characters, over the 29-byte reward address and over bech32', () => {
  const raw = Buffer.from('e0337b62cfff6403a06a3acbc34f8c46003c69fe79a3628cefa9c47251', 'hex');
  // openssl dgst -sha256 -mac HMAC -macopt hexkey:0001..1f over the 29 bytes
  assert.equal(identifier(KEY, raw), '1cf8a38be8522a71');
  // and over the bech32 text (the x15_bech32 reading)
  assert.equal(identifier(KEY, 'stake_test1uqehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gssrtvn'), '42fe2932ad8da5fc');
  assert.throws(() => identifier(Buffer.alloc(16), raw));
});

test('RFC 4231 test case 2 through the same primitive', () => {
  const mac = createHmac('sha256', Buffer.from('Jefe')).update('what do ya want for nothing?').digest('hex');
  assert.equal(mac, '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
});

test('CIP-19 testnet vectors: base address type 0 and its reward address type 14', () => {
  const base = 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae';
  const a = parseAddress(base);
  assert.equal(a.type, 0);
  assert.equal(a.network, 0);
  assert.equal(a.bytes.length, 57);
  const r = rewardAddressOf(base);
  assert.equal(r.bech, 'stake_test1uqehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gssrtvn');
  assert.equal(r.raw.subarray(1).toString('hex'), a.stakeHash);
  const main = rewardAddressOf('addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x');
  assert.equal(main.bech, 'stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw');
  const s = parseAddress('stake_test17rphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtcljw6kf');
  assert.equal(s.type, 15);
  assert.equal(s.stakeIsScript, true);
  const { hrp, bytes } = decode(base);
  assert.equal(encode(hrp, bytes), base);
  assert.throws(() => decode(base.slice(0, -1) + (base.endsWith('e') ? 'q' : 'e')));
});

test('pgpass parser: first match, wildcards, escapes', () => {
  const text = 'other:5433:db:study:wrong\n127.0.0.1:5433:dbsync_preprod_r:study:a\\:b\\\\c\n*:*:*:*:fallback\n';
  assert.equal(pgpassLookup(text, { host: '127.0.0.1', port: 5433, database: 'dbsync_preprod_r', user: 'study' }), 'a:b\\c');
  assert.equal(pgpassLookup(text, { host: 'x', port: 1, database: 'y', user: 'z' }), 'fallback');
  assert.equal(pgpassLookup('h:1:d:u:p\n', { host: 'h', port: 2, database: 'd', user: 'u' }), null);
});

test('init-secret makes a 32-byte key once, mode 0600, in a 0700 directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'rc-'));
  const prev = process.env.RESEARCH_CORPUS_HOME;
  process.env.RESEARCH_CORPUS_HOME = home;
  try {
    const p = initSecret();
    assert.equal(statSync(p).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, 'secret')).mode & 0o777, 0o700);
    assert.equal(readFileSync(p).length, 32);
    assert.equal(loadKey().length, 32);
    assert.throws(() => initSecret(), /already exists/);
  } finally {
    if (prev === undefined) delete process.env.RESEARCH_CORPUS_HOME;
    else process.env.RESEARCH_CORPUS_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
