// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import * as bip39 from 'bip39';
import { CSL, toHex } from './util.mjs';

const H = 0x80000000;
const hard = (n) => (H + n) >>> 0;

// Preprod is network id 0 (CIP-19 "Network Tag": testnet). Mainnet is 1.
export const PREPROD_NETWORK_ID = 0;
export const PREPROD_PROTOCOL_MAGIC = 1;

export function newMnemonic() {
  return bip39.generateMnemonic(256);
}

export function checkMnemonic(mnemonic) {
  const m = mnemonic.trim().split(/\s+/).join(' ');
  if (!bip39.validateMnemonic(m)) throw new Error('not a valid BIP39 mnemonic');
  return m;
}

// CIP-3 "Master Key Generation" (Icarus): the BIP39 entropy, with an empty
// passphrase, is the input to the master key derivation.
export function rootKey(mnemonic, passphrase = '') {
  const entropy = Buffer.from(bip39.mnemonicToEntropy(checkMnemonic(mnemonic)), 'hex');
  return CSL.Bip32PrivateKey.from_bip39_entropy(entropy, Buffer.from(passphrase, 'utf8'));
}

// CIP-1852 "Specification": m / 1852' / 1815' / account' / role / index, with
// role 0 the external chain and role 2 the staking key.
export function roleKey(root, account, role, index) {
  return root.derive(hard(1852)).derive(hard(1815)).derive(hard(account)).derive(role).derive(index);
}

// CIP-19 "Shelley Addresses", header type 0: a payment key hash and a stake key
// hash. The network tag is the low nibble of the header (0 testnet, 1 mainnet).
export function baseAddress(networkId, paymentPub, stakePub) {
  return CSL.BaseAddress.new(
    networkId,
    CSL.Credential.from_keyhash(paymentPub.hash()),
    CSL.Credential.from_keyhash(stakePub.hash())
  ).to_address();
}

// A wallet restored from a mnemonic the way an extension restores it: account 0,
// external payment keys 0 .. keyCount-1, stake key at role 2 index 0.
export function walletFromMnemonic(mnemonic, keyCount = 1, networkId = PREPROD_NETWORK_ID) {
  const root = rootKey(mnemonic);
  const stakeSk = roleKey(root, 0, 2, 0).to_raw_key();
  const stakePk = stakeSk.to_public();
  const keys = [];
  for (let i = 0; i < keyCount; i++) {
    const sk = roleKey(root, 0, 0, i).to_raw_key();
    const pk = sk.to_public();
    const address = baseAddress(networkId, pk, stakePk);
    keys.push({ index: i, sk, pk, hash: pk.hash().to_hex(), address, bech32: address.to_bech32() });
  }
  return { root, keys, stakeSk, stakePk };
}

// CIP-1855 "HD Derivation": m / 1855' / 1815' / policy_ix', every level hardened.
// The policy is a native script that requires the signature of that key.
export function policyFromMnemonic(root, policyIx) {
  const sk = root.derive(hard(1855)).derive(hard(1815)).derive(hard(policyIx)).to_raw_key();
  const pk = sk.to_public();
  const script = CSL.NativeScript.new_script_pubkey(CSL.ScriptPubkey.new(pk.hash()));
  return { sk, pk, script, policyId: script.hash().to_hex(), keyHash: toHex(pk.hash().to_bytes()) };
}

// A throwaway mnemonic (all-zero entropy) for dry runs: sizes and fees do not
// depend on which keys sign, so `budget` never touches real secrets.
export function sizingMnemonic() {
  return bip39.entropyToMnemonic('00'.repeat(32));
}
