// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The carrying transaction: every pure-ADA UTxO at the identity's payment
// address in, one output back to that address (or to the sweep target), the
// exact minimum fee, a TTL, the auxiliary data and its hash, one payment
// witness. Nothing else: no scripts, no certificates, no withdrawals.

import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { sliceTxComponents, unwrapAuxiliaryData, auxiliaryDataHashFromTxBody, bindTransactionBytes } from '@cardanowall/sdk-ts/verifier';
import { reassembleLabel309Value } from '@cardanowall/poe-standard';
import { blake2b256 } from '@cardanowall/crypto-core/hash';
import { decode, mapGet, Tagged, textStrings } from './cbor.mjs';
import { nodeVerify } from './keys.mjs';
import { expectedAuxiliaryBytes, LABEL_MSG, LABEL_POE } from './record.mjs';
import { containsMarker, equalBytes, fromHex, stringContainsMarker, toHex, UserError } from './util.mjs';

export const TTL_SLOTS = 7200; // two hours of one-second slots

const big = (n) => CSL.BigNum.from_str(BigInt(n).toString());

export function feeFor(params, size) {
  return params.minFeeA * BigInt(size) + params.minFeeB;
}

// Only pure-ADA UTxOs with no datum and no reference script are spent; any
// other UTxO at the address is left untouched.
export function selectInputs(utxos) {
  const pure = utxos.filter((u) => !u.assets.length && !u.datumBytes && !u.datumHash && !u.refScript);
  pure.sort((a, b) => (a.txHash === b.txHash ? a.index - b.index : a.txHash < b.txHash ? -1 : 1));
  return { pure, skipped: utxos.length - pure.length };
}

function assemble({ inputs, outputAddress, fee, ttl, networkId, auxBytes, signer }) {
  // Transaction.new takes the auxiliary data by value, so each attempt gets its own copy.
  const aux = CSL.AuxiliaryData.from_bytes(auxBytes);
  const total = inputs.reduce((s, u) => s + u.coin, 0n);
  const outCoin = total - fee;
  const ins = CSL.TransactionInputs.new();
  for (const u of inputs) ins.add(CSL.TransactionInput.new(CSL.TransactionHash.from_bytes(fromHex(u.txHash, { lower: true, length: 32 })), u.index));
  const outs = CSL.TransactionOutputs.new();
  const output = CSL.TransactionOutput.new(outputAddress, CSL.Value.new(big(outCoin > 0n ? outCoin : 0n)));
  outs.add(output);
  const body = CSL.TransactionBody.new_tx_body(ins, outs, big(fee));
  body.set_ttl(big(ttl));
  body.set_network_id(networkId === 1 ? CSL.NetworkId.mainnet() : CSL.NetworkId.testnet());
  body.set_auxiliary_data_hash(CSL.hash_auxiliary_data(aux));
  const hash = CSL.FixedTransaction.new_from_body_bytes(body.to_bytes()).transaction_hash();
  const vkeys = CSL.Vkeywitnesses.new();
  vkeys.add(CSL.make_vkey_witness(hash, signer));
  const witnesses = CSL.TransactionWitnessSet.new();
  witnesses.set_vkeys(vkeys);
  const tx = CSL.Transaction.new(body, witnesses, aux);
  const bytes = tx.to_bytes();
  return { tx, bytes, size: bytes.length, hash: toHex(hash.to_bytes()), output, outCoin, total };
}

// Fee = min_fee_a * size + min_fee_b over the serialized signed transaction,
// iterated to a fixed point (a different fee changes the change output and so
// the size), then checked against CSL's own min_fee.
export function buildTransaction({ utxos, outputAddress, signer, networkId, params, ttl, aux }) {
  const { pure } = selectInputs(utxos);
  const auxBytes = aux.to_bytes();
  if (!pure.length) throw new UserError('the payment address holds no pure-ADA UTxO; fund it first');
  let fee = 200000n;
  let built;
  for (let i = 0; ; i++) {
    if (i >= 10) throw new Error('fee did not settle');
    built = assemble({ inputs: pure, outputAddress, fee, ttl, networkId, auxBytes, signer });
    const need = feeFor(params, built.size);
    if (need === fee) break;
    fee = need;
  }
  const minFee = BigInt(CSL.min_fee(built.tx, CSL.LinearFee.new(big(params.minFeeA), big(params.minFeeB))).to_str());
  if (minFee !== fee) throw new Error(`fee ${fee} differs from CSL min_fee ${minFee}`);
  const minAda = BigInt(CSL.min_ada_for_output(built.output, CSL.DataCost.new_coins_per_byte(big(params.coinsPerUtxoByte))).to_str());
  if (built.outCoin < minAda) {
    throw new UserError(`the output would hold ${built.outCoin} lovelace, below its minimum of ${minAda}; send at least ${minAda - built.outCoin} more lovelace to the payment address`);
  }
  return { bytes: built.bytes, hash: built.hash, size: built.size, fee, ttl, inputs: pure, total: built.total, outCoin: built.outCoin, minAda };
}

const BODY_KEYS_ALLOWED = new Set([0, 1, 2, 3, 7, 15]);

function setItems(v) {
  // Conway encodes a set either as a plain array or tagged 258.
  if (v instanceof Tagged) {
    if (v.tag !== 258) throw new Error(`unexpected tag ${v.tag} on a set`);
    return v.value;
  }
  return v;
}

function outputParts(o) {
  // legacy [address, amount] or post-Alonzo { 0: address, 1: amount }
  if (Array.isArray(o)) {
    if (o.length !== 2) throw new Error('an output carries more than address and amount');
    return { address: o[0], amount: o[1] };
  }
  if (o instanceof Map) {
    for (const k of o.keys()) if (k !== 0 && k !== 1) throw new Error(`an output carries field ${k}`);
    return { address: mapGet(o, 0), amount: mapGet(o, 1) };
  }
  throw new Error('unrecognized output shape');
}

function checker() {
  const checks = [];
  const ok = (name, cond, detail = '') => {
    if (!cond) throw new Error(`transaction check failed: ${name}${detail ? ` (${detail})` : ''}`);
    checks.push(name);
  };
  return { checks, ok };
}

// The body, the fee, the single output and the single payment witness: the
// part of the assertions a record transaction and a sweep share.
function assertBodyAndWitness(bytes, fixed, rawBody, txHash, expect, ok, allowedKeys) {
  ok(`no byte of the transaction contains "unfrack.it" in any letter case`, !containsMarker(bytes));
  ok('the size is within max_tx_size', bytes.length <= expect.maxTxSize, `${bytes.length} > ${expect.maxTxSize}`);

  const body = decode(rawBody);
  for (const k of body.keys()) ok(`body field ${k} is one this tool writes`, allowedKeys.has(k));
  ok('the body carries the network id', mapGet(body, 15) === expect.networkId);
  ok('the TTL is as built', BigInt(mapGet(body, 3)) === BigInt(expect.ttl));
  const fee = BigInt(mapGet(body, 2));
  ok('the fee is min_fee_a * size + min_fee_b', fee === feeFor(expect.params, bytes.length), `${fee}`);
  const tx = CSL.Transaction.from_bytes(bytes);
  ok('the fee equals CSL min_fee', fee === BigInt(CSL.min_fee(tx, CSL.LinearFee.new(big(expect.params.minFeeA), big(expect.params.minFeeB))).to_str()));
  const inputs = setItems(mapGet(body, 0)).map(([h, i]) => `${toHex(h)}#${i}`);
  const expectedInputs = expect.inputs.map((u) => `${u.txHash}#${u.index}`);
  ok('the inputs are exactly the selected pure-ADA UTxOs', inputs.length === expectedInputs.length && [...inputs].sort().join() === [...expectedInputs].sort().join());
  const outs = mapGet(body, 1);
  ok('there is exactly one output', Array.isArray(outs) && outs.length === 1);
  const out = outputParts(outs[0]);
  ok('the output pays the expected address', toHex(out.address) === toHex(CSL.Address.from_bech32(expect.outputAddress).to_bytes()));
  ok('the output address carries the network tag', (out.address[0] & 0x0f) === expect.networkId);
  ok('the output holds ADA only', typeof out.amount === 'number' || typeof out.amount === 'bigint');
  const total = expect.inputs.reduce((s, u) => s + BigInt(u.coin), 0n);
  ok('inputs = output + fee', total === BigInt(out.amount) + fee);
  const minAda = BigInt(CSL.min_ada_for_output(tx.body().outputs().get(0), CSL.DataCost.new_coins_per_byte(big(expect.params.coinsPerUtxoByte))).to_str());
  ok('the output holds at least its minimum ADA', BigInt(out.amount) >= minAda);

  const ws = decode(new Uint8Array(fixed.raw_witness_set()));
  ok('the witness set holds vkey witnesses only', [...ws.keys()].every((k) => k === 0));
  const vkeys = setItems(mapGet(ws, 0));
  ok('there is exactly one vkey witness', Array.isArray(vkeys) && vkeys.length === 1);
  const [vk, sig] = vkeys[0];
  ok('the witness key is the payment key', toHex(CSL.PublicKey.from_bytes(vk).hash().to_bytes()) === expect.paymentKeyHash);
  ok('the witness signature verifies against the body hash (CSL)', CSL.PublicKey.from_bytes(vk).verify(fromHex(txHash), CSL.Ed25519Signature.from_bytes(sig)));
  ok('the witness signature verifies against the body hash (OpenSSL)', nodeVerify(vk, fromHex(txHash), sig));
  return fee;
}

// Every post-build assertion, on the serialized bytes alone. Throws on the
// first failure; returns the list of checks that passed.
export function assertTransaction(bytes, expect) {
  const { checks, ok } = checker();

  const fixed = CSL.FixedTransaction.from_bytes(bytes);
  const rawBody = new Uint8Array(fixed.raw_body());
  const rawAux = fixed.raw_auxiliary_data() ? new Uint8Array(fixed.raw_auxiliary_data()) : null;
  const parts = sliceTxComponents(bytes);
  ok('the SDK and CSL slice the same body bytes', equalBytes(parts.txBody, rawBody));
  ok('the SDK and CSL slice the same auxiliary-data bytes', rawAux !== null && parts.auxiliaryData !== null && equalBytes(parts.auxiliaryData, rawAux));

  const txHash = toHex(blake2b256(rawBody));
  ok('BLAKE2b-256 of the raw body equals the transaction hash', txHash === toHex(fixed.transaction_hash().to_bytes()) && (!expect.txHash || txHash === expect.txHash), txHash);
  const committed = auxiliaryDataHashFromTxBody(rawBody);
  ok('BLAKE2b-256 of the raw auxiliary data equals the body\'s auxiliary_data_hash', committed !== null && equalBytes(blake2b256(rawAux), committed));
  ok('the SDK transaction binding accepts the bytes', bindTransactionBytes({ requestedTxHashHex: txHash, txBody: rawBody, auxiliaryData: rawAux }).ok);

  ok('the auxiliary data is an untagged map with definite lengths, exactly as expected', equalBytes(rawAux, expectedAuxiliaryBytes(expect.chunks, expect.lines)));
  const unwrapped = unwrapAuxiliaryData(rawAux);
  ok('the metadata labels are exactly {309, 674}', unwrapped.metadataLabels.length === 2 && unwrapped.metadataLabels[0] === LABEL_POE && unwrapped.metadataLabels[1] === LABEL_MSG);
  const aux = decode(rawAux);
  const poe = mapGet(aux, LABEL_POE);
  ok('every label-309 chunk is a byte string of 1 to 64 bytes', Array.isArray(poe) && poe.every((c) => c instanceof Uint8Array && c.length >= 1 && c.length <= 64));
  const back = reassembleLabel309Value(unwrapped.label309);
  ok('the label-309 value reassembles to the record body byte for byte', back.ok && equalBytes(back.body, expect.recordBody));
  ok('no byte of the reassembled record contains "unfrack.it" in any letter case (a string can straddle two chunks)', !containsMarker(back.body));
  ok('no text string in the record contains "unfrack.it" in any letter case', ![...textStrings(decode(back.body))].some(stringContainsMarker));
  const msg = mapGet(mapGet(aux, LABEL_MSG), 'msg');
  ok('the 674 message is exactly the expected digest line(s)', Array.isArray(msg) && msg.length === expect.lines.length && msg.every((l, i) => l === expect.lines[i]));
  ok('no text string in the auxiliary data contains "unfrack.it" in any letter case', ![...textStrings(aux)].some(stringContainsMarker));
  let refused = false;
  try {
    CSL.TransactionMetadatum.new_bytes(new Uint8Array(65));
  } catch {
    refused = true;
  }
  ok('CSL refuses a 65-byte metadata byte string', refused);

  const fee = assertBodyAndWitness(bytes, fixed, rawBody, txHash, expect, ok, BODY_KEYS_ALLOWED);
  return { txHash, fee, size: bytes.length, checks };
}

// The same assertions for a sweep: no auxiliary data at all, one output to
// the sweep target, no change.
const SWEEP_BODY_KEYS = new Set([0, 1, 2, 3, 15]);

export function assertSweep(bytes, expect) {
  const { checks, ok } = checker();
  const fixed = CSL.FixedTransaction.from_bytes(bytes);
  const rawBody = new Uint8Array(fixed.raw_body());
  const parts = sliceTxComponents(bytes);
  ok('the SDK and CSL slice the same body bytes', equalBytes(parts.txBody, rawBody));
  ok('the transaction carries no auxiliary data', !fixed.raw_auxiliary_data() && parts.auxiliaryData === null);
  const txHash = toHex(blake2b256(rawBody));
  ok('BLAKE2b-256 of the raw body equals the transaction hash', txHash === toHex(fixed.transaction_hash().to_bytes()) && (!expect.txHash || txHash === expect.txHash), txHash);
  ok('the body carries no auxiliary_data_hash', auxiliaryDataHashFromTxBody(rawBody) === null);
  const fee = assertBodyAndWitness(bytes, fixed, rawBody, txHash, expect, ok, SWEEP_BODY_KEYS);
  return { txHash, fee, size: bytes.length, checks };
}
