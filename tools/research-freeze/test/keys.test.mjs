// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as bip39 from 'bip39';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { blake2b224 } from '@cardanowall/crypto-core/hash';
import {
  PAYMENT_PATH,
  entropyFromMnemonic,
  mnemonicFromEntropy,
  signingKeyFromSeed,
  nodeSigningKey,
  icarusRoot,
  deriveChild,
  enterpriseAddress,
  paymentKeyFromEntropy,
  assertKeySeparation,
  deriveIdentity,
  newMnemonicPair,
  publicFacts
} from '../src/keys.mjs';
import { VECTOR_MNEMONICS, vector, hex, unhex } from './helpers.mjs';

const H = 0x80000000;

test('the vector mnemonics encode the label-309 seed-derive seeds and give their public keys, through the SDK and through Node and OpenSSL', () => {
  for (const v of VECTOR_MNEMONICS) {
    assert.equal(mnemonicFromEntropy(unhex(v.seed)), v.mnemonic.trim());
    const seed = entropyFromMnemonic(v.mnemonic);
    assert.equal(hex(seed), v.seed);
    assert.equal(hex(signingKeyFromSeed(seed).publicKey), v.pub);
    assert.equal(hex(nodeSigningKey(seed).publicKey), v.pub);
    assert.equal(vector(v.file).vectors[0].expected_ed25519_public_hex, v.pub);
  }
});

test('the signing seed is the BIP-39 entropy itself, not the PBKDF2 seed', () => {
  const m = VECTOR_MNEMONICS[0].mnemonic;
  assert.equal(hex(entropyFromMnemonic(m)), '00'.repeat(32));
  assert.notEqual(hex(bip39.mnemonicToSeedSync(m)).slice(0, 64), '00'.repeat(32));
});

test('mnemonics of other than 24 words, and bad checksums, are refused', () => {
  assert.throws(() => entropyFromMnemonic(bip39.generateMnemonic(128)), /12 words is refused/);
  assert.throws(() => entropyFromMnemonic('eight country switch draw meat scout mystery blade tip drift useless good keep usage title'), /15 words is refused/);
  const words = VECTOR_MNEMONICS[0].mnemonic.trim().split(' ');
  words[23] = 'zoo';
  assert.throws(() => entropyFromMnemonic(words.join(' ')), /checksum/);
});

test('the signing key signs identically through the SDK and OpenSSL', async () => {
  const k = signingKeyFromSeed(unhex('deadbeef'.repeat(8)));
  const msg = new TextEncoder().encode('message');
  const sig = await k.sign(msg);
  assert.equal(sig.length, 64);
  assert.ok(crypto.verify(null, Buffer.from(msg), crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(k.publicKey)]), format: 'der', type: 'spki' }), Buffer.from(sig)));
});

// CIP-3, Icarus.md "Test vectors", no passphrase (a 15-word phrase; the
// derivation below is the same function the 24-word payment mnemonic uses).
test('CIP-3 Icarus master key', () => {
  const entropy = new Uint8Array(Buffer.from(bip39.mnemonicToEntropy('eight country switch draw meat scout mystery blade tip drift useless good keep usage title'), 'hex'));
  assert.equal(
    hex(icarusRoot(entropy).as_bytes()),
    'c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620'
  );
});

// CIP-11 "Test vectors": the key at m/1852'/1815'/0'/2/0 and its reward
// address, through the same child-derivation function as PAYMENT_PATH.
test('CIP-11 staking key: the CIP-1852 derivation machinery', () => {
  const entropy = new Uint8Array(Buffer.from(bip39.mnemonicToEntropy('prevent company field green slot measure chief hero apple task eagle sunset endorse dress seed'), 'hex'));
  const key = deriveChild(icarusRoot(entropy), [H + 1852, H + 1815, H + 0, 2, 0]);
  assert.equal(
    hex(key.as_bytes()),
    'b8ab42f1aacbcdb3ae858e3a3df88142b3ed27a2d3f432024e0d943fc1e597442d57545d84c8db2820b11509d944093bc605350e60c533b8886a405bd59eed6dcf356648fe9e9219d83e989c8ff5b5b337e2897b6554c1ab4e636de791fe5427'
  );
  assert.equal(CSL.RewardAddress.new(1, CSL.Credential.from_keyhash(key.to_raw_key().to_public().hash())).to_address().to_bech32(), 'stake1uy8ykk8dzmeqxm05znz65nhr80m0k3gxnjvdngf8azh6sjc6hyh36');
});

test('the payment path is m/1852\'/1815\'/0\'/0/0', () => {
  assert.deepEqual([...PAYMENT_PATH], [H + 1852, H + 1815, H, 0, 0]);
});

// BIP-173 bech32, with checksum verification.
function bech32Decode(s) {
  const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const pos = s.lastIndexOf('1');
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => charset.indexOf(c));
  const polymod = (values) => {
    const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const b = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= G[i];
    }
    return chk;
  };
  const expand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  assert.equal(polymod(expand.concat(data)), 1, `bech32 checksum of ${s}`);
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

// CIP-19 "Test Vectors": the payment key below gives these type-6
// (enterprise, payment key hash only) addresses.
test('CIP-19 type-6 enterprise address vectors', () => {
  const pay = CSL.PublicKey.from_bytes(bech32Decode('addr_vk1w0l2sr2zgfm26ztc6nl9xy8ghsk5sh6ldwemlpmp9xylzy4dtf7st80zhd'));
  assert.equal(enterpriseAddress(1, pay.hash()).to_bech32(), 'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8');
  assert.equal(enterpriseAddress(0, pay.hash()).to_bech32(), 'addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz');
  const bytes = enterpriseAddress(1, pay.hash()).to_bytes();
  assert.equal(bytes[0], 0x61, 'header type 6, network tag 1');
  assert.equal(bytes.length, 29, 'header and a 28-byte key hash, no delegation part');
});

test('an identity: separate keys, enterprise addresses with the right network tags', () => {
  const s = mnemonicFromEntropy(crypto.randomBytes(32));
  const p = mnemonicFromEntropy(crypto.randomBytes(32));
  const id = deriveIdentity(s, p);
  const facts = publicFacts('rehearsal', id);
  assert.deepEqual(facts.networks, ['preprod']);
  assert.deepEqual(publicFacts('freeze', id).networks, ['mainnet']);
  assert.ok(facts.addresses.mainnet.startsWith('addr1v'));
  assert.ok(facts.addresses.preprod.startsWith('addr_test1v'));
  assert.equal(CSL.Address.from_bech32(facts.addresses.preprod).to_bytes()[0], 0x60);
  assert.equal(facts.payment_key_hash, hex(blake2b224(id.payment.publicKey)));
  assert.notEqual(facts.signing_public_key, facts.payment_public_key);
});

test('init refuses two equal entropies', () => {
  const same = crypto.randomBytes(32);
  assert.throws(() => newMnemonicPair(() => same), /entropies are equal/);
  const m = mnemonicFromEntropy(same);
  assert.throws(() => deriveIdentity(m, m), /equal entropy/);
  const pair = newMnemonicPair();
  assert.notEqual(pair.signingMnemonic, pair.paymentMnemonic);
  assert.equal(pair.signingMnemonic.split(' ').length, 24);
});

test('key separation: each vector signing mnemonic with an independent payment mnemonic', () => {
  for (const [i, v] of VECTOR_MNEMONICS.entries()) {
    const payment = mnemonicFromEntropy(crypto.createHash('sha256').update(`independent payment entropy ${i}`).digest());
    const id = deriveIdentity(v.mnemonic, payment);
    assert.equal(hex(id.signing.publicKey), v.pub);
    assert.notEqual(hex(id.signing.publicKey), hex(id.payment.publicKey));
    assert.notEqual(hex(blake2b224(id.signing.publicKey)), hex(id.payment.keyHash));
  }
});

test('key separation: equal public keys or a matching key hash are refused', () => {
  const a = new Uint8Array(32).fill(1);
  const b = new Uint8Array(32).fill(2);
  const pub = new Uint8Array(32).fill(3);
  assert.throws(() => assertKeySeparation({ signingEntropy: a, paymentEntropy: a, signingPublicKey: pub, paymentPublicKey: b, paymentKeyHash: new Uint8Array(28) }), /equal entropy/);
  assert.throws(() => assertKeySeparation({ signingEntropy: a, paymentEntropy: b, signingPublicKey: pub, paymentPublicKey: pub, paymentKeyHash: new Uint8Array(28) }), /public keys are equal/);
  assert.throws(() => assertKeySeparation({ signingEntropy: a, paymentEntropy: b, signingPublicKey: pub, paymentPublicKey: b, paymentKeyHash: blake2b224(pub) }), /BLAKE2b-224/);
  assert.doesNotThrow(() => assertKeySeparation({ signingEntropy: a, paymentEntropy: b, signingPublicKey: pub, paymentPublicKey: b, paymentKeyHash: new Uint8Array(28) }));
});

test('the payment key from the payment mnemonic alone matches a CSL restore of the same path', () => {
  const entropy = crypto.randomBytes(32);
  const k = paymentKeyFromEntropy(entropy);
  const again = CSL.Bip32PrivateKey.from_bip39_entropy(entropy, new Uint8Array(0)).derive(H + 1852).derive(H + 1815).derive(H).derive(0).derive(0).to_raw_key().to_public();
  assert.equal(hex(k.publicKey), hex(again.as_bytes()));
});

// An independent implementation at 24 words, where CIP-3 Icarus.md ("Trezor")
// says derivations diverge. The mnemonic is a throwaway made from the
// SHA-256 of a label; the public key was computed by cardano-signer 1.32.0,
// `keygen --path 1852H/1815H/0H/0/0 --mnemonics "<mnemonic>"`, which reports
// derivation type "icarus".
test('a 24-word payment key matches cardano-signer at m/1852\'/1815\'/0\'/0/0', () => {
  const mnemonic = bip39.entropyToMnemonic(crypto.createHash('sha256').update('research-freeze cardano-signer payment vector').digest('hex'));
  assert.equal(mnemonic.split(' ').length, 24);
  assert.equal(mnemonic, 'antenna live position asthma ability spatial fringe case version test endorse truth roast exclude thank proud neglect link glare soup wing hammer load move');
  const k = paymentKeyFromEntropy(entropyFromMnemonic(mnemonic));
  assert.equal(hex(k.publicKey), '78bceb923ad8aa673ae7dfdd78a3140f3200011316b977795214cf8ff3eabce2');
  assert.equal(hex(k.keyHash), '3129e4a18edfc1c35b2a8f2b9d5699b0e7de0da8eb70b3535166bac6');
  assert.equal(k.address('preprod').to_bech32(), 'addr_test1vqcjne9p3m0urs6m928jh82knxcw0hsd4r4hpv6n29nt43swclamr');
});
