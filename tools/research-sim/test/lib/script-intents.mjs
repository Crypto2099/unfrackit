// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Constructed replay intents for the adapters' and the engine's tests: an
// intent of given parts, a requested payment to an external recipient, and
// two script spends whose redeemers are the integer 0 (a mint and a
// zero-amount script withdrawal).

import { ZERO_IMPLICIT } from '../../src/state/intent.mjs';
import { outputBytes } from '../../src/kit/assemble.mjs';
import { SYNTHETIC_PARAMS } from '../../src/kit/params.mjs';
import { executionFee } from '../../src/history/params.mjs';
import { addressBytes } from '../../src/history/address.mjs';
import { encUint, encInt, encBytes, encArray, encMap } from '../../src/history/cbor.mjs';
import { blake2b224 } from '../../src/history/blake2b.mjs';
import { recipientAddress } from '../../src/battery/recipients.mjs';

const ADA = 1000000n;

// A replay intent of the given parts at time t.
export function replayIntent(id, t, { type, requested = [], fixed = null, implicit = {}, collateral = false }) {
  return {
    id: id.padEnd(64, '0'),
    source: 'replay',
    type,
    time: { slot: t, blockTime: t, blockIndex: 0, epoch: 0, block: t },
    requested,
    implicit: { ...ZERO_IMPLICIT, ...implicit },
    fixed: fixed && { inputs: [], referenceInputs: [], body: {}, witnesses: {}, redeemers: [], auxiliaryData: null, scriptFee: 0n, fixedBytes: 0, refScriptBytes: 0, ...fixed },
    collateral: { required: collateral, observed: null },
    invalid: null,
    burst: null,
    observed: { tx: id, size: 0, fee: 300000n, epoch: 0, protocolMajor: null, minFeeA: 44n, minFeeB: 155381n, walletInputs: [], walletOutputs: [], walletWitnesses: [] },
    classes: {},
    derived: null,
    meta: null
  };
}

// A requested payment of `coin` to the synthetic recipient 300 + i.
export function payTo(T, i, coin, extra = {}) {
  const address = recipientAddress('synthetic', 300 + i);
  return { cbor: outputBytes(T, { address, coin, assets: [] }).toString('hex'), address, coin, assets: [], datum: null, scriptRef: null, raised: null, wallet: false, scriptPayment: false, index: null, from: null, inflow: false, ...extra };
}

// A Plutus V3 script (its bytes are never run: an evaluator returns the
// intent's units), the policy and script stake credential it hashes to, and
// redeemers whose data is the integer 0, as on the preprod mints of four V3
// policies.
export const V3 = Buffer.alloc(120, 0x5a);
export const V3_HASH = blake2b224(Buffer.concat([Buffer.from([3]), V3])).toString('hex');
export const EX_UNITS = [107086n, 32858313n];
const zeroRedeemers = (pointers) => encArray(pointers.map(([tag, index]) => encArray([encUint(tag), encUint(index), Buffer.from('00', 'hex'), encArray([encUint(EX_UNITS[0]), encUint(EX_UNITS[1])])]))).toString('hex');

// Two script spends from `state`'s wallet: a mint of one unit under the V3
// policy, and a withdrawal of zero from the V3 script's stake credential (the
// coordinator pattern), each with its redeemer the integer 0, the script in
// the witness set and a payment of 2 ADA.
export function zeroRedeemerIntents(T, state, P = SYNTHETIC_PARAMS) {
  const net = addressBytes(state.changeAddress)[0] & 15;
  const account = Buffer.concat([Buffer.from([0xf0 | net]), Buffer.from(V3_HASH, 'hex')]).toString('hex');
  const scriptFee = executionFee(P, EX_UNITS[0], EX_UNITS[1]);
  const scripts = { 7: encArray([encBytes(V3)]).toString('hex') };
  return [
    replayIntent('d1', 10, {
      type: 'T6',
      requested: [payTo(T, 10, 2n * ADA)],
      fixed: { body: { 9: encMap([[encBytes(Buffer.from(V3_HASH, 'hex')), encMap([[encBytes(Buffer.from('7a', 'hex')), encInt(1n)]])]]).toString('hex') }, witnesses: { ...scripts, 5: zeroRedeemers([[1, 0]]) }, redeemers: [{ tag: 1, target: { kind: 'policy', policy: V3_HASH }, data: '00', exUnits: EX_UNITS }], scriptFee },
      implicit: { mint: [{ policy: V3_HASH, name: '7a', qty: 1n }] },
      collateral: true
    }),
    replayIntent('d2', 20, {
      type: 'T6',
      requested: [payTo(T, 11, 2n * ADA)],
      fixed: { body: { 5: encMap([[encBytes(Buffer.from(account, 'hex')), encUint(0)]]).toString('hex') }, witnesses: { ...scripts, 5: zeroRedeemers([[3, 0]]) }, redeemers: [{ tag: 3, target: { kind: 'withdrawal', account }, data: '00', exUnits: EX_UNITS }], scriptFee },
      collateral: true
    })
  ];
}
