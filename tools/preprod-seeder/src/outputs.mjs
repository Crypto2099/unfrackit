// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import { CSL, fromHex } from './util.mjs';

// Preprod's coins-per-UTxO-byte at the time of writing. The shape generator uses
// it to size each output; `budget` and `seed` re-check every output against the
// live value from the network.
export const GENERATOR_COINS_PER_BYTE = '4310';

export function dataCost(coinsPerByte) {
  return CSL.DataCost.new_coins_per_byte(CSL.BigNum.from_str(String(coinsPerByte)));
}

// A base address with fixed dummy credentials, used only to size outputs.
export function sizingAddress() {
  const pay = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_bytes(new Uint8Array(28).fill(0x40)));
  const stake = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_bytes(new Uint8Array(28).fill(0x99)));
  return CSL.BaseAddress.new(0, pay, stake).to_address();
}

export function nativeScriptFor(keyHashHex) {
  return CSL.NativeScript.new_script_pubkey(CSL.ScriptPubkey.new(CSL.Ed25519KeyHash.from_hex(keyHashHex)));
}

// The inline datum carried by S8's datum UTxO: the integer 42, CBOR 182a.
export const DATUM_VALUE = '42';
export const DATUM_CBOR = '182a';

// assets: [{ policy, name, qty }] with hex policy and name and bigint qty. Assets
// repeated within one output are summed.
export function makeValue(coin, assets) {
  const merged = new Map();
  for (const a of assets) {
    const k = a.policy + '.' + a.name;
    merged.set(k, (merged.get(k) || 0n) + BigInt(a.qty));
  }
  const c = CSL.BigNum.from_str(coin.toString());
  if (merged.size === 0) return CSL.Value.new(c);
  const ma = CSL.MultiAsset.new();
  for (const [k, q] of merged) {
    const [p, n] = k.split('.');
    ma.set_asset(CSL.ScriptHash.from_hex(p), CSL.AssetName.new(fromHex(n)), CSL.BigNum.from_str(q.toString()));
  }
  return CSL.Value.new_with_assets(c, ma);
}

// flags: { datum: bool, scriptRef: keyHashHex | null }. A script reference is a
// native script requiring the signature of the given payment key hash.
export function makeOutput(address, coin, assets, flags = {}) {
  const out = CSL.TransactionOutput.new(address, makeValue(coin, assets));
  if (flags.datum) out.set_plutus_data(CSL.PlutusData.new_integer(CSL.BigInt.from_str(DATUM_VALUE)));
  if (flags.scriptRef) out.set_script_ref(CSL.ScriptRef.new_native_script(nativeScriptFor(flags.scriptRef)));
  return out;
}

export function minAdaOf(output, coinsPerByte = GENERATOR_COINS_PER_BYTE) {
  return BigInt(CSL.min_ada_for_output(output, dataCost(coinsPerByte)).to_str());
}

// Minimum-coin output holding the given tokens, built through the output builder.
// Used to find how many tokens fit under a value-size target.
export function minimumOutput(address, tokens, coinsPerByte = GENERATOR_COINS_PER_BYTE) {
  const ma = CSL.MultiAsset.new();
  for (const t of tokens) {
    ma.set_asset(CSL.ScriptHash.from_hex(t.policy), CSL.AssetName.new(fromHex(t.name)), CSL.BigNum.from_str(t.qty.toString()));
  }
  return CSL.TransactionOutputBuilder.new()
    .with_address(address)
    .next()
    .with_asset_and_min_required_coin_by_utxo_cost(ma, dataCost(coinsPerByte))
    .build();
}

export const valueBytes = (output) => output.amount().to_bytes().length;
