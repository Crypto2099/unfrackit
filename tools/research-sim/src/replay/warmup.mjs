// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The warm-up build. A method's first build in a process pays costs that no
// library owns: a helper method's helper process starts on it (methods/
// helper.mjs), and every library's first calls in a fresh Node process
// initialize modules and WebAssembly and compile code. The replay times each
// build (replay/engine.mjs buildOne), so before a method's first build in a
// process the engine makes one throwaway build of a fixed, tiny wallet with
// one plain payment, outside every spend's timed span, and keeps nothing of
// it but its time.
//
// The wallet is the same for every method: four UTxOs of ADA alone and one
// holding one token, at a base address whose parts no key controls, under
// references no wallet can hold (the transaction ids are hashes of fixed
// text); the intent pays 2 ADA to the synthetic recipient 0 and carries no
// part, no script and no collateral. Addresses carry the run's network id
// (params.network: 1 for mainnet and the synthetic shapes, 0 for preprod).
// The build gets the job's own options, so the code the job will run is the
// code warmed, except for randomness: the job's generator is never drawn
// from, and the warm-up has a generator of its own and a fixed seed.
//
// The result is discarded, success or failure; a StopPoint, a RunError and a
// machine error pass as they do from a real build. warmUp is the whole
// operation; warmedOnce is what the engine calls, which makes it once per
// method name in a process.

import { createHash } from 'node:crypto';
import { encArray, encBytes, encUint } from '../history/cbor.mjs';
import { encodeValue } from '../history/value.mjs';
import { unspentOutput } from '../history/output.mjs';
import { addressBytes } from '../history/address.mjs';
import { encode as bech32encode } from '../history/bech32.mjs';
import { blake2b224 } from '../history/blake2b.mjs';
import { makeState } from '../state/state.mjs';
import { utxoFromCbor } from '../state/utxo.mjs';
import { ZERO_IMPLICIT } from '../state/intent.mjs';
import { recipientAddress } from '../kit/recipients.mjs';
import { passMachineErrors } from '../kit/machine.mjs';
import { RunError } from '../methods/contract.mjs';
import { StopPoint } from '../treatment/run.mjs';
import { makeRng } from '../shapes/rng.mjs';

const ADA = 1000000n;
const text = (s) => Buffer.from(s, 'ascii');
const sha = (s) => createHash('sha256').update(text(s)).digest();
const PAYMENT = blake2b224(text('unfrackit-research-sim warm-up wallet payment'));
const STAKE = blake2b224(text('unfrackit-research-sim warm-up wallet stake'));
const POLICY = blake2b224(text('unfrackit-research-sim warm-up wallet policy')).toString('hex');
const TOKEN_NAME = Buffer.from('warm', 'ascii').toString('hex');

// The fixed seed of the warm-up's own generator.
export const WARM_SEED = 1;

// The coin of each UTxO of the wallet; the last holds the token.
const COINS = [5n * ADA, 7n * ADA, 11n * ADA, 20n * ADA, 10n * ADA];
// What the intent pays.
const PAYMENT_COIN = 2n * ADA;

const networkId = (params) => (params.network === 'preprod' ? 0 : 1);
const addressOf = (net, pay, stake) => bech32encode(net === 1 ? 'addr' : 'addr_test', Buffer.concat([Buffer.from([net]), pay, stake]));

// The warm-up wallet's state and its one payment intent for the run's
// parameters; `time` is the intent's time (the spend's slot and block time,
// as an intent carries them), which a library that turns a slot into a date
// needs to lie in the network's range: the engine gives the time of the
// build it precedes, and a caller with none gets slot 0.
export function warmUpCase(params, { time = null } = {}) {
  const net = networkId(params);
  const address = addressOf(net, PAYMENT, STAKE);
  const utxos = COINS.map((coin, i) => {
    const assets = i === COINS.length - 1 ? [{ policy: POLICY, name: TOKEN_NAME, qty: 100n }] : [];
    const out = encArray([encBytes(addressBytes(address)), encodeValue(coin, assets)]);
    const id = sha(`unfrackit-research-sim warm-up wallet ${i}`).toString('hex');
    return utxoFromCbor(unspentOutput(id, i, out).toString('hex'), { origin: 'initial' });
  });
  const state = makeState({ network: params.network, stakeCred: STAKE.toString('hex'), changeAddress: address, utxos, at: { slot: null, time: null } });
  const to = recipientAddress(net === 0 ? 'preprod' : 'mainnet', 0);
  const toBytes = addressBytes(to);
  const cbor = encArray([encBytes(toBytes), encUint(PAYMENT_COIN)]).toString('hex');
  const t = time || { slot: 0, blockTime: 0, blockIndex: 0, epoch: 0, block: 0 };
  const intent = Object.freeze({
    id: sha('unfrackit-research-sim warm-up intent').toString('hex'),
    source: 'replay',
    type: 'payment',
    time: Object.freeze({ ...t }),
    requested: Object.freeze([Object.freeze({ cbor, address: to, coin: PAYMENT_COIN, assets: Object.freeze([]), datum: null, scriptRef: null, raised: null, wallet: false, scriptPayment: false, index: null, from: null, inflow: false })]),
    implicit: ZERO_IMPLICIT,
    fixed: null,
    collateral: Object.freeze({ required: false, observed: null }),
    invalid: null,
    burst: null,
    observed: null,
    classes: null,
    derived: null,
    meta: null
  });
  return { state, intent };
}

// One throwaway build by `method` of the warm-up case, with the job's
// options `opts` (their own random replaced by the warm-up's generator and
// their seed by the fixed one). Returns { ms, ok }: the build's wall time and
// whether it returned a transaction. A failed build, thrown or returned, is
// { ok: false }; a StopPoint, a RunError and a machine error are thrown.
export async function warmUp(method, params, opts, { time = null } = {}) {
  const { state, intent } = warmUpCase(params, { time });
  const rng = makeRng(WARM_SEED);
  const own = { ...opts, seed: WARM_SEED, random: () => rng.next() };
  delete own.collateral;
  const t0 = performance.now();
  let ok = false;
  try {
    const r = await method.build(state, intent, params, own);
    ok = !!(r && r.ok === true);
  } catch (e) {
    if (e instanceof StopPoint || e instanceof RunError) throw e;
    passMachineErrors(e);
    ok = false;
  }
  return { ms: performance.now() - t0, ok };
}

// The method names this process has warmed, and whether warm-ups are made
// at all (off only for tests that count a method's builds).
const WARMED = new Set();
let enabled = true;

// Test hooks: forget what the process has warmed; switch the warm-up off or
// on. Neither is a run option, and nothing of either reaches a record.
export const resetWarmUp = () => WARMED.clear();
export const setWarmUp = (on) => {
  enabled = !!on;
};

// The engine's call, immediately before a method's first build in this
// process: warms `method` once per process and returns { ms, ok }, or null
// when it has been warmed (or the warm-up is off). onBuild: told when the
// build starts and ends, as for a real build.
export async function warmedOnce(method, params, opts, { time = null, onBuild = null } = {}) {
  if (!enabled || WARMED.has(method.name)) return null;
  WARMED.add(method.name);
  if (onBuild) onBuild(true);
  try {
    return await warmUp(method, params, opts, { time });
  } finally {
    if (onBuild) onBuild(false);
  }
}
