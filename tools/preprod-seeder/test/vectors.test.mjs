// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import test from 'node:test';
import assert from 'node:assert/strict';
import { CSL, toHex } from '../src/util.mjs';
import { rootKey, roleKey, baseAddress, walletFromMnemonic, policyFromMnemonic } from '../src/wallet.mjs';
import { labelPrefixHex, labelOf, withLabel } from '../src/labels.mjs';
import { assertPreprod } from '../src/koios.mjs';

// CIP-3, Icarus.md "Test vectors", no passphrase.
test('CIP-3 Icarus master key', () => {
  const root = rootKey('eight country switch draw meat scout mystery blade tip drift useless good keep usage title');
  assert.equal(
    toHex(root.as_bytes()),
    'c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620'
  );
});

// CIP-11 "Test vectors": recovery phrase, the private key at
// m/1852'/1815'/0'/2/0 (CIP-1852 role 2), and the reward address on mainnet.
test('CIP-11 staking key at m/1852\'/1815\'/0\'/2/0 and its reward address', () => {
  const root = rootKey('prevent company field green slot measure chief hero apple task eagle sunset endorse dress seed');
  const key = roleKey(root, 0, 2, 0);
  assert.equal(
    toHex(key.as_bytes()),
    'b8ab42f1aacbcdb3ae858e3a3df88142b3ed27a2d3f432024e0d943fc1e597442d57545d84c8db2820b11509d944093bc605350e60c533b8886a405bd59eed6dcf356648fe9e9219d83e989c8ff5b5b337e2897b6554c1ab4e636de791fe5427'
  );
  const reward = CSL.RewardAddress.new(1, CSL.Credential.from_keyhash(key.to_raw_key().to_public().hash())).to_address();
  assert.equal(reward.to_bech32(), 'stake1uy8ykk8dzmeqxm05znz65nhr80m0k3gxnjvdngf8azh6sjc6hyh36');
});

// Minimal bech32 payload decoder (BIP-173 charset). Only the payload is needed;
// CIP-19's keys use the CIP-5 prefixes addr_vk and stake_vk, which the
// serialization library does not parse.
function bech32Payload(s) {
  const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const data = [...s.slice(s.lastIndexOf('1') + 1, -6)].map((c) => charset.indexOf(c));
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const v of data) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

// CIP-19 "Test Vectors": the payment and stake keys below give these type-00
// (key hash, key hash) base addresses.
test('CIP-19 base address vectors', () => {
  const pay = CSL.PublicKey.from_bytes(bech32Payload('addr_vk1w0l2sr2zgfm26ztc6nl9xy8ghsk5sh6ldwemlpmp9xylzy4dtf7st80zhd'));
  const stake = CSL.PublicKey.from_bytes(bech32Payload('stake_vk1px4j0r2fk7ux5p23shz8f3y5y2qam7s954rgf3lg5merqcj6aetsft99wu'));
  assert.equal(
    baseAddress(1, pay, stake).to_bech32(),
    'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x'
  );
  assert.equal(
    baseAddress(0, pay, stake).to_bech32(),
    'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae'
  );
});

// CIP-67 "Test Vectors" and the CIP-68 label examples.
test('CIP-67 label prefixes', () => {
  const vectors = {
    0: '00000000', 1: '00001070', 23: '00017650', 99: '000632e0', 533: '00215410',
    2000: '007d0550', 4567: '011d7690', 11111: '02b670b0', 49328: '0c0b0f40', 65535: '0ffff240',
    100: '000643b0', 222: '000de140'
  };
  for (const [label, prefix] of Object.entries(vectors)) {
    assert.equal(labelPrefixHex(Number(label)), prefix);
    assert.equal(labelOf(prefix + '41'), Number(label));
  }
  // CIP-68 "Labels": (222)GiveYouUp.
  assert.equal(withLabel(222, Buffer.from('GiveYouUp').toString('hex')), '000de14047697665596f755570');
});

test('derived wallets are deterministic and on preprod', () => {
  const m = 'prevent company field green slot measure chief hero apple task eagle sunset endorse dress seed';
  const a = walletFromMnemonic(m, 3);
  const b = walletFromMnemonic(m, 3);
  assert.equal(a.keys.length, 3);
  assert.deepEqual(a.keys.map((k) => k.bech32), b.keys.map((k) => k.bech32));
  assert.ok(a.keys.every((k) => k.bech32.startsWith('addr_test1')));
  assert.equal(new Set(a.keys.map((k) => k.bech32)).size, 3);
  const p0 = policyFromMnemonic(a.root, 0);
  assert.equal(p0.policyId, policyFromMnemonic(b.root, 0).policyId);
  assert.notEqual(p0.policyId, policyFromMnemonic(a.root, 1).policyId);
});

test('anything other than preprod is refused', () => {
  assert.doesNotThrow(() => assertPreprod({ networkmagic: '1', networkid: 'Testnet' }));
  assert.throws(() => assertPreprod({ networkmagic: '764824073', networkid: 'Mainnet' }), /preprod/);
  assert.throws(() => assertPreprod({ networkmagic: '2', networkid: 'Testnet' }), /preprod/);
});
