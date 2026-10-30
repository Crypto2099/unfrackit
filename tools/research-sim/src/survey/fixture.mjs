// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The builder survey's fixture: a wallet holding k UTxOs, each carrying 141
// tokens with 32-byte names of its own test policy, one unit each (a Value of
// 4,974 bytes at a coin of 5 bytes), and an equal amount of ADA, for k = 1 to
// 5, with and without pure-ADA UTxOs that alone cover the payment; the payment
// is 75% of the wallet's ADA to an external key address. ADA amounts are scaled
// to what the preprod faucet supplies; token bytes are not.
//
// The amounts, names and seeds are settings (SURVEY_SETTINGS), each refused
// when it is not the implemented value, as the simulator's own settings are:
//
//   tokenUtxoAda     100 ADA on each token UTxO: above the token output's
//                    minimum (22.4 ADA at 4,310 lovelace per byte), so every
//                    one leaves ADA for change, and under 4,294.97 ADA, so its
//                    coin is the 5-byte integer the 4,974-byte Value assumes
//   pureUtxos        two pure-ADA UTxOs in the variant that has them
//   pureEach         each holds 2 * k * tokenUtxoAda, so together they hold
//                    four times the token UTxOs' ADA: the payment, 75% of the
//                    whole wallet, is 3.75 times the token UTxOs' ADA, which
//                    the pure-ADA UTxOs alone cover with 0.25 times it left
//                    for the fee and a pure-ADA change output
//   faucetAda        10,000: the whole fixture, both variants and k = 1 to 5,
//                    holds 9,000 ADA, within one preprod faucet request
//   names            policies, token names, transaction ids and the wallet's
//                    keys are BLAKE2b hashes of fixed texts (below), so no key
//                    controls them; the recipient is the batteries' first
//                    external recipient (battery/recipients.mjs)
//   randomRuns       30 runs or seeds (1 to 30) of each random subject, the
//                    snapshot's repetition count
//
// Every UTxO is at the wallet's one base address (one payment key, one
// witness). The network is the synthetic shapes' (mainnet addresses,
// SYNTHETIC_PARAMS).

import { blake2b224, blake2b256 } from '../history/blake2b.mjs';
import { encode as bech32encode } from '../history/bech32.mjs';
import { unspentOutput } from '../history/output.mjs';
import { valueSize } from '../history/value.mjs';
import { outputBytes } from '../kit/assemble.mjs';
import { utxoFromCbor } from '../state/utxo.mjs';
import { makeState } from '../state/state.mjs';
import { batteryIntent } from '../state/intent.mjs';
import { recipientAddress } from '../battery/recipients.mjs';

const ADA = 1000000n;

export const SURVEY_SETTINGS = Object.freeze({
  tokenUtxoAda: 100n * ADA,
  tokensPerUtxo: 141,
  nameBytes: 32,
  pureUtxos: 2,
  pureEach: 'two-k-token-ada',
  paymentShare: Object.freeze([3n, 4n]),
  faucetAda: 10000n * ADA,
  names: 'blake2b-texts',
  randomRuns: 30,
  ks: Object.freeze([1, 2, 3, 4, 5])
});

const IMPLEMENTED = { pureEach: ['two-k-token-ada'], names: ['blake2b-texts'] };

export function surveySettings(overrides = {}) {
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in SURVEY_SETTINGS)) throw new Error(`unknown survey setting ${k}`);
    if (IMPLEMENTED[k] && !IMPLEMENTED[k].includes(v)) throw new Error(`survey setting ${k}=${v} is not implemented`);
  }
  return Object.freeze({ ...SURVEY_SETTINGS, ...overrides });
}

const text = (s) => Buffer.from(`unfrackit-research-sim survey ${s}`, 'ascii');

export const policyOf = (i) => blake2b224(text(`policy ${i}`)).toString('hex');
export const tokenNameOf = (i, j) => blake2b256(text(`token ${i} ${j}`)).toString('hex');
const txidOf = (variant, k, i) => blake2b256(text(`utxo ${variant} ${k} ${i}`)).toString('hex');

// The wallet's base address: key payment and key stake parts (CIP-0019,
// "Shelley Addresses", header type 0), network tag 1.
export function walletAddress() {
  const pay = blake2b224(text('wallet payment'));
  const stake = blake2b224(text('wallet stake'));
  return bech32encode('addr', Buffer.concat([Buffer.from([0x01]), pay, stake]));
}

export function tokensOf(i, s = SURVEY_SETTINGS) {
  const policy = policyOf(i);
  const out = [];
  for (let j = 0; j < s.tokensPerUtxo; j++) out.push({ policy, name: tokenNameOf(i, j), qty: 1n });
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// The fixture for one k and variant ('tokens' or 'pure'): { state, intent,
// meta }.
export function surveyFixture(T, k, variant, s = SURVEY_SETTINGS) {
  if (variant !== 'tokens' && variant !== 'pure') throw new Error(`survey: unknown variant ${variant}`);
  const address = walletAddress();
  const records = [];
  const add = (txid, coin, assets) => records.push(utxoFromCbor(unspentOutput(txid, 0, outputBytes(T, { address, coin, assets })).toString('hex'), { origin: 'initial' }));
  for (let i = 0; i < k; i++) {
    const assets = tokensOf(i, s);
    const vb = valueSize(s.tokenUtxoAda, assets);
    if (vb !== 4974) throw new Error(`survey: a token UTxO's Value is ${vb} bytes, not 4,974`);
    add(txidOf(variant, k, i), s.tokenUtxoAda, assets);
  }
  if (variant === 'pure') for (let i = 0; i < s.pureUtxos; i++) add(txidOf(variant, k, `pure ${i}`), 2n * BigInt(k) * s.tokenUtxoAda, []);
  const total = records.reduce((a, u) => a + u.coin, 0n);
  const amount = (total * s.paymentShare[0]) / s.paymentShare[1];
  const to = recipientAddress('synthetic', 0);
  const state = makeState({ network: 'synthetic', stakeCred: blake2b224(text('wallet stake')).toString('hex'), changeAddress: address, utxos: records, at: { slot: 0, time: 0 } });
  const intent = batteryIntent({ id: `survey-${variant}-${k}`, type: 'survey', requested: [{ cbor: outputBytes(T, { address: to, coin: amount, assets: [] }).toString('hex'), address: to, coin: amount, assets: [] }], meta: { k, variant, amount } });
  const pureCoin = records.filter((u) => !u.assets.length).reduce((a, u) => a + u.coin, 0n);
  return { state, intent, meta: { k, variant, total, amount, pureCoin, tokenUtxos: k } };
}

// The ADA the whole fixture holds, both variants and every k.
export function fixtureAda(T, s = SURVEY_SETTINGS) {
  let sum = 0n;
  for (const k of s.ks) for (const v of ['tokens', 'pure']) sum += surveyFixture(T, k, v, s).meta.total;
  return sum;
}
