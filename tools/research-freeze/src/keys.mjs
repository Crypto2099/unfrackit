// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The two keys of an identity, each from its own 24-word BIP-39 mnemonic.
//
// Signing key (CIP-190, "Seed and key derivation"): the 32-byte master seed
// is the signing mnemonic's 256-bit BIP-39 entropy, used with no passphrase
// and no PBKDF2 ("Master seed"); the Ed25519 secret seed is
// HKDF-SHA-256(IKM seed, salt empty, info "cardano-poe-ed25519-v1", 32 bytes)
// ("HKDF-SHA-256 derivation"), passed unchanged to RFC 8032 Ed25519 ("The
// derived keypairs", Ed25519). The key is derived twice, once through the
// SDK's signerFromSeed and once through Node's own HKDF and OpenSSL, and the
// two public keys must agree. The X25519 and X-Wing keys of the same seed are
// never derived here.
//
// Payment key (CIP-3 Icarus.md, "Master Key Generation"; CIP-1852
// "Specification"): the payment mnemonic's entropy goes through Icarus
// PBKDF2-HMAC-SHA512 (empty passphrase, 4096 iterations, 96 bytes, bit tweaks)
// to the BIP32-Ed25519 root, then PAYMENT_PATH below. Its address is a CIP-19
// type-6 enterprise address (payment key hash only, no delegation part).

import crypto from 'node:crypto';
import * as bip39 from 'bip39';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { signerFromSeed } from '@cardanowall/sdk-ts/identity';
import { blake2b224 } from '@cardanowall/crypto-core/hash';
import { equalBytes, toHex, UserError } from './util.mjs';

const H = 0x80000000;
// The one place the payment derivation path is written: m/1852'/1815'/0'/0/0
// (CIP-1852 purpose 1852', coin type 1815', account 0', role 0 = external
// chain, index 0).
export const PAYMENT_PATH = Object.freeze([H + 1852, H + 1815, H + 0, 0, 0]);
export const PAYMENT_PATH_TEXT = "m/1852'/1815'/0'/0/0";

export const SIGNING_INFO = 'cardano-poe-ed25519-v1';
export const MNEMONIC_WORDS = 24;

// RFC 8410 section 7: the PKCS#8 and SPKI DER prefixes for a raw Ed25519 key.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const NETWORK_ID = Object.freeze({ mainnet: 1, preprod: 0 });

// BIP-39 entropy of a 24-word English mnemonic, checksum verified. Anything
// other than 24 words encodes less than 32 bytes and is refused.
export function entropyFromMnemonic(mnemonic) {
  const words = String(mnemonic).trim().split(/\s+/);
  if (words.length !== MNEMONIC_WORDS) {
    throw new UserError(`a mnemonic of ${words.length} words is refused; identities use ${MNEMONIC_WORDS} words (256 bits of entropy)`);
  }
  const normalized = words.join(' ');
  if (!bip39.validateMnemonic(normalized)) throw new UserError('not a valid BIP-39 English mnemonic (word list or checksum)');
  const entropy = Buffer.from(bip39.mnemonicToEntropy(normalized), 'hex');
  if (entropy.length !== 32) throw new UserError('mnemonic entropy is not 32 bytes');
  return new Uint8Array(entropy);
}

export function mnemonicFromEntropy(entropy) {
  if (entropy.length !== 32) throw new Error('entropy must be 32 bytes');
  return bip39.entropyToMnemonic(Buffer.from(entropy).toString('hex'));
}

// Node's HKDF and OpenSSL's Ed25519, independent of the SDK.
export function nodeSigningKey(seed) {
  if (seed.length !== 32) throw new Error('INVALID_SEED_LENGTH: seed must be exactly 32 bytes');
  const edSeed = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(seed), Buffer.alloc(0), Buffer.from(SIGNING_INFO, 'ascii'), 32));
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, edSeed]), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  if (!spki.subarray(0, SPKI_ED25519_PREFIX.length).equals(SPKI_ED25519_PREFIX)) throw new Error('unexpected SPKI encoding');
  return { edSeed: new Uint8Array(edSeed), privateKey, publicKey: new Uint8Array(spki.subarray(SPKI_ED25519_PREFIX.length)) };
}

export function nodeVerify(publicKey, message, signature) {
  const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKey)]), format: 'der', type: 'spki' });
  return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature));
}

// The signing key from a 32-byte CIP-190 master seed, derived by both paths.
export function signingKeyFromSeed(seed) {
  const signer = signerFromSeed(seed);
  const node = nodeSigningKey(seed);
  if (!equalBytes(signer.signerPubkey, node.publicKey)) {
    throw new Error('the SDK and OpenSSL derive different signing public keys from the same seed; refusing to sign');
  }
  return {
    publicKey: new Uint8Array(signer.signerPubkey),
    // The SDK's signer (noble Ed25519) and OpenSSL's, over the same bytes;
    // Ed25519 is deterministic, so the two signatures must be identical.
    async sign(message) {
      const a = new Uint8Array(await signer.sign(message));
      const b = new Uint8Array(crypto.sign(null, Buffer.from(message), node.privateKey));
      if (!equalBytes(a, b)) throw new Error('the SDK and OpenSSL produced different Ed25519 signatures; refusing to continue');
      return a;
    }
  };
}

export function deriveChild(root, path) {
  let k = root;
  for (const index of path) k = k.derive(index);
  return k;
}

// CIP-3 Icarus master key from BIP-39 entropy (no passphrase).
export function icarusRoot(entropy) {
  return CSL.Bip32PrivateKey.from_bip39_entropy(Buffer.from(entropy), new Uint8Array(0));
}

export function enterpriseAddress(networkId, keyHash) {
  return CSL.EnterpriseAddress.new(networkId, CSL.Credential.from_keyhash(keyHash)).to_address();
}

export function paymentKeyFromEntropy(entropy) {
  const raw = deriveChild(icarusRoot(entropy), PAYMENT_PATH).to_raw_key();
  const pub = raw.to_public();
  const keyHash = pub.hash();
  return {
    privateKey: raw,
    publicKey: new Uint8Array(pub.as_bytes()),
    keyHash: new Uint8Array(keyHash.to_bytes()),
    address: (network) => enterpriseAddress(NETWORK_ID[network], keyHash)
  };
}

// Why the two keys cannot collide is argued in the README; this is the check
// that it did not happen. Equal entropies, equal public keys, or a signing key
// whose BLAKE2b-224 equals the payment key hash are all refused.
export function assertKeySeparation({ signingEntropy, paymentEntropy, signingPublicKey, paymentPublicKey, paymentKeyHash }) {
  if (equalBytes(signingEntropy, paymentEntropy)) throw new UserError('the signing and payment mnemonics have equal entropy; refusing');
  if (equalBytes(signingPublicKey, paymentPublicKey)) throw new UserError('the signing and payment public keys are equal; refusing');
  if (equalBytes(blake2b224(signingPublicKey), paymentKeyHash)) {
    throw new UserError('the BLAKE2b-224 of the signing public key equals the payment key hash; refusing');
  }
}

// Every derived fact of an identity, from its two mnemonics.
export function deriveIdentity(signingMnemonic, paymentMnemonic) {
  const signingEntropy = entropyFromMnemonic(signingMnemonic);
  const paymentEntropy = entropyFromMnemonic(paymentMnemonic);
  if (equalBytes(signingEntropy, paymentEntropy)) throw new UserError('the signing and payment mnemonics have equal entropy; refusing');
  const signing = signingKeyFromSeed(signingEntropy);
  const payment = paymentKeyFromEntropy(paymentEntropy);
  assertKeySeparation({
    signingEntropy,
    paymentEntropy,
    signingPublicKey: signing.publicKey,
    paymentPublicKey: payment.publicKey,
    paymentKeyHash: payment.keyHash
  });
  return { signingSeed: signingEntropy, signing, payment };
}

// Two independent 256-bit entropies. `random` is injectable for the test that
// equal entropies are refused.
export function newMnemonicPair(random = crypto.randomBytes) {
  const a = new Uint8Array(random(32));
  const b = new Uint8Array(random(32));
  if (a.length !== 32 || b.length !== 32) throw new Error('entropy source returned the wrong length');
  if (equalBytes(a, b)) throw new UserError('the two generated entropies are equal; refusing to create the identity');
  return { signingMnemonic: mnemonicFromEntropy(a), paymentMnemonic: mnemonicFromEntropy(b) };
}

export function publicFacts(name, identity) {
  return {
    format: 'research-freeze-identity-v1',
    name,
    networks: name === 'rehearsal' ? ['preprod'] : ['mainnet'],
    signing_public_key: toHex(identity.signing.publicKey),
    signing_derivation: `CIP-190 HKDF-SHA-256, salt empty, info "${SIGNING_INFO}"; seed = entropy of a ${MNEMONIC_WORDS}-word BIP-39 mnemonic, no passphrase`,
    payment_public_key: toHex(identity.payment.publicKey),
    payment_key_hash: toHex(identity.payment.keyHash),
    payment_path: PAYMENT_PATH_TEXT,
    addresses: {
      mainnet: identity.payment.address('mainnet').to_bech32(),
      preprod: identity.payment.address('preprod').to_bech32()
    }
  };
}
