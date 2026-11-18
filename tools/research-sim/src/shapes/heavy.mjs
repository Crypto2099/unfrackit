// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The heavy synthetic wallets: a parametric family `H<k>E<e>` of wallets near
// the 20,000-UTxO ceiling, for measuring the memory and the time of a replay
// where the fixed shapes (the largest has 3,005 UTxOs and a 75-day stream of
// about 13 intents) cannot.
//
//   H<k>E<e>   about k thousand UTxOs and about e thousand events
//
// k is a whole number from 1 to 30. e is read as thousands of events: a digit
// string without a leading zero is a whole number (E1 is 1,000 events, E6 is
// 6,000), and a leading zero reads the digits after it as a decimal fraction
// (E05 is 500 events, E01 is 100, E005 is 50). The wallet has exactly
// k * 1,000 UTxOs and its stream exactly e * 1,000 events (at least 10), so
// the names H20E05, H3E6 and H20E01 are wallets of 20,000 UTxOs and 500
// events, 3,000 and 6,000, and 20,000 and 100.
//
// The wallet. 1% of the UTxOs (at least 5) are pure ADA of 20 to 100 ADA. The
// rest are 85% non-fungible and 15% fungible. A non-fungible UTxO holds one
// token of quantity 1, in policies of 100 names, at its minimum coin plus a
// surplus of 0 to 1 ADA. A fungible UTxO holds one piece of 500 to 1,500
// units of one asset; an asset has 50 pieces and a policy 5 assets (the last
// asset and policy hold what is left). Every UTxO is at the change address,
// the treatment's payment key 0, and the order is shuffled. Everything comes
// from mulberry32 seeded from the name, and every hash from BLAKE2b of the
// name and a counter, so a name always gives the same wallet.
//
// The stream. D = max(30, ceil(events / 12)) days; event i is at second
// 1 + floor(i * (D * 86400 - 1) / events), so the events are in time order
// and at least two hours apart. The intents, in the order drawn:
//
//   T1  pay 2 to 20 ADA (half of the intents)
//   T2  send one non-fungible token, drawn from the policies that have one
//       left (15%)
//   T3  send two tokens of one policy that has two left (10%)
//   T4  send one token of each of two policies (10%)
//   T5  send a quarter (rounded down, at least 1) of the units of a fungible
//       asset the wallet holds (15%)
//
// A draw the holdings cannot express becomes a T1. No intent sends a token
// the stream has already sent. Every 8 intents a deposit follows: 150 ADA
// at the change address; every fourth deposit adds one token of a new
// policy at its minimum, and every fifth a piece of 1,000 units of a
// fungible asset the wallet holds. Every 50th intent is a parallel burst
// of two T1 payments, 2 ADA and 3 ADA, 30 seconds apart. Every 100th
// intent, from the 25th, is a Plutus spend as in the fixed streams (a
// script input of 10 ADA, 12 ADA paid back to the script address, collateral
// required). A mark falls at every multiple of 30 days. Outputs are serialized
// as streams.mjs serializes them.

import { makeRng } from './rng.mjs';
import { encUint, encBytes, encArray } from '../history/cbor.mjs';
import { encodeOutput, unspentOutput } from '../history/output.mjs';
import { addressBytes, parseAddress } from '../history/address.mjs';
import { utxoFromOutput, addressTextOf } from '../state/utxo.mjs';
import { makeState } from '../state/state.mjs';
import { recipientAddress } from '../kit/recipients.mjs';
import { SYNTHETIC_PARAMS } from '../kit/params.mjs';
import { executionFee } from '../history/params.mjs';
import { blake2b224, blake2b256 } from '../history/blake2b.mjs';
import { ADA, DAY, hash32, hash28, atMinimum, requestedOut, payOut, ZERO, fixedBytesOf } from './stream-parts.mjs';

const NAME_RE = /^H([1-9][0-9]?)E(0[0-9]+|[1-9][0-9]*)$/;
const MIN_EVENTS = 10;
const MAX_K = 30;
export const NFT_POLICY_SIZE = 100;
export const FT_PIECES = 50;
export const FT_ASSETS_PER_POLICY = 5;
export const PURE_ADA_SHARE = 0.01;
export const FT_SHARE = 0.15;

// {k, events} of a heavy wallet's name, or null when the name is not one.
export function parseHeavyName(name) {
  const m = NAME_RE.exec(String(name));
  if (!m) return null;
  const k = Number(m[1]);
  const digits = m[2];
  const thousands = digits.length > 1 && digits[0] === '0' ? Number(`0.${digits.slice(1)}`) : Number(digits);
  const events = Math.round(thousands * 1000);
  if (k > MAX_K || events < MIN_EVENTS || !Number.isInteger(events)) return null;
  return { k, events };
}

export const isHeavyName = (name) => parseHeavyName(name) !== null;

function seedOf(name) {
  let h = 2166136261;
  for (const c of String(name)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

const hex = (s) => Buffer.from(s, 'ascii').toString('hex');
const ref = (name, kind, i) => blake2b256(Buffer.from(`unfrackit-research-sim heavy ${name} ${kind} ${i}`, 'ascii')).toString('hex');
const policyOf = (name, kind, i) => blake2b224(Buffer.from(`unfrackit-research-sim heavy ${name} policy ${kind} ${i}`, 'ascii')).toString('hex');

// A heavy wallet as shapeState returns a shape: { name, heavy, hex, order,
// state }. `heavy` holds the stream's inputs: the event count and the tokens
// the wallet holds, by policy.
export function heavyShape(T, name) {
  const p = parseHeavyName(name);
  if (!p) throw new Error(`${name} is not a heavy wallet name (H<k>E<e>, k 1 to ${MAX_K}, at least ${MIN_EVENTS} events)`);
  const rng = makeRng(seedOf(name));
  const total = p.k * 1000;
  const pure = Math.max(5, Math.round(total * PURE_ADA_SHARE));
  const tokenUtxos = total - pure;
  const ftUtxos = Math.round(tokenUtxos * FT_SHARE);
  const nftUtxos = tokenUtxos - ftUtxos;
  const changeAddress = T.cslkit.baseAddress(0).to_bech32();
  const ab = addressBytes(changeAddress);
  const stakeCred = parseAddress(ab).stake;
  const minCoin = (assets) => SYNTHETIC_PARAMS.coinsPerUtxoByte * (160n + BigInt(encodeOutput({ address: ab, coin: 2000000n, assets }, 'array').length));
  const descs = [];

  const nftPolicies = [];
  for (let i = 0; i < nftUtxos; i++) {
    const pi = Math.floor(i / NFT_POLICY_SIZE);
    const policy = policyOf(name, 'nft', pi);
    if (!nftPolicies[pi]) nftPolicies[pi] = [];
    const tok = { policy, name: hex(`Item${String(i % NFT_POLICY_SIZE).padStart(4, '0')}`), qty: 1n };
    nftPolicies[pi].push(tok);
    descs.push({ assets: [tok], surplus: true });
  }
  const ftAssets = [];
  const nAssets = Math.ceil(ftUtxos / FT_PIECES);
  for (let a = 0; a < nAssets; a++) {
    ftAssets.push({ policy: policyOf(name, 'ft', Math.floor(a / FT_ASSETS_PER_POLICY)), name: hex(`Coin${String(a).padStart(4, '0')}`), qty: 0n });
  }
  for (let i = 0; i < ftUtxos; i++) {
    const asset = ftAssets[Math.floor(i / FT_PIECES)];
    const qty = BigInt(rng.int(500, 1500));
    asset.qty += qty;
    descs.push({ assets: [{ policy: asset.policy, name: asset.name, qty }], surplus: true });
  }
  for (let i = 0; i < pure; i++) descs.push({ assets: [], coin: BigInt(rng.int(20, 100)) * ADA });
  rng.shuffle(descs);

  const utxos = descs.map((d, i) => {
    const min = minCoin(d.assets);
    const coin = d.surplus ? min + BigInt(rng.int(0, 1000000)) : d.coin;
    return utxoFromOutput(ref(name, 'utxo', i), i % 3, encodeOutput({ address: ab, coin, assets: d.assets }, 'array'), { origin: 'initial' });
  });
  const state = makeState({ network: 'synthetic', stakeCred, changeAddress, utxos, at: { slot: 0, time: 0 } });
  return {
    name,
    heavy: { events: p.events, nfts: nftPolicies, fts: ftAssets.map((a) => ({ ...a })) },
    hex: utxos.map((u) => u.cbor),
    order: utxos.map((u) => u.ref),
    state
  };
}

const PAY_RECIPIENTS = 64;
const DEPOSIT_EVERY = 8;
const BURST_EVERY = 50;
const SCRIPT_EVERY = 100;
const SCRIPT_FIRST = 25;
const MARK_EVERY = 30 * DAY;

export function heavyStream(T, shape, params) {
  const { events: total, nfts, fts } = shape.heavy;
  const state = shape.state;
  const name = shape.name;
  const change = state.changeAddress;
  const changeBytes = addressBytes(change);
  const net = changeBytes[0] & 15;
  const days = Math.max(30, Math.ceil(total / 12));
  const span = days * DAY;
  const ext = (i) => recipientAddress('synthetic', 200 + (i % PAY_RECIPIENTS));
  const rng = makeRng(seedOf(`${name} stream`));
  const events = [];
  let n = 0;
  const at = (i) => 1 + Math.floor((i * (span - 1)) / total);
  const time = (t) => ({ slot: t, blockTime: t, blockIndex: 0, epoch: params.epoch, block: t });
  const intent = (t, type, requested, over = {}) => {
    const id = hash32(`${name} ${n++}`);
    events.push({
      kind: 'intent',
      txId: n,
      intent: {
        id,
        source: 'replay',
        type,
        time: time(t),
        requested,
        implicit: ZERO(),
        fixed: null,
        collateral: { required: false, observed: null },
        invalid: null,
        burst: null,
        observed: { tx: id, size: 0, fee: 300000n, epoch: params.epoch, protocolMajor: null, minFeeA: params.minFeeA, minFeeB: params.minFeeB, walletInputs: [], walletOutputs: [], walletWitnesses: [] },
        classes: {},
        derived: null,
        meta: null,
        ...over
      }
    });
  };

  // What the wallet holds that the stream may still send. Tokens leave a
  // policy's list when sent; a fungible asset's units are counted down.
  const left = nfts.map((l) => l.slice());
  const live = left.map((_, i) => i);
  const take = (li) => {
    const pi = live[li];
    const tok = left[pi].pop();
    if (!left[pi].length) {
      live[li] = live[live.length - 1];
      live.pop();
    }
    return tok;
  };
  const units = fts.map((f) => ({ policy: f.policy, name: f.name, qty: f.qty }));
  const withTwo = () => live.map((_, li) => li).filter((li) => left[live[li]].length >= 2);
  const send = (toks, i) => payOut(params, ext(i), null, toks.map((t) => ({ policy: t.policy, name: t.name, qty: t.qty })).sort((a, b) => (a.policy + a.name < b.policy + b.name ? -1 : 1)));

  // The script input's constants, shared by every Plutus spend.
  const script = Buffer.alloc(300, 0x4d);
  const scriptHash = blake2b224(Buffer.concat([Buffer.from([2]), script])).toString('hex');
  const scriptAddr = Buffer.concat([Buffer.from([0x70 | net]), Buffer.from(scriptHash, 'hex')]);
  const scriptAddrText = addressTextOf(scriptAddr);
  const datumHash = blake2b256(Buffer.from('d87980', 'hex')).toString('hex');
  const backOut = encodeOutput({ address: scriptAddr, coin: 12n * ADA, assets: [], datum: { kind: 'inline', cbor: 'd87980' } }, 'map');
  const exUnits = [200000n, 80000000n];
  const scriptSpend = (t, j) => {
    const scriptTx = hash32(`${name} script input ${j}`);
    const scriptIn = { ref: `${scriptTx}#0`, cbor: unspentOutput(scriptTx, 0, encodeOutput({ address: scriptAddr, coin: 10n * ADA, assets: [], datum: { kind: 'hash', hash: datumHash } }, 'array')).toString('hex') };
    const fixed = {
      inputs: [scriptIn],
      referenceInputs: [],
      body: {},
      witnesses: {
        4: encArray([Buffer.from('d87980', 'hex')]).toString('hex'),
        5: encArray([encArray([encUint(0), encUint(0), Buffer.from('d87980', 'hex'), encArray([encUint(exUnits[0]), encUint(exUnits[1])])])]).toString('hex'),
        6: encArray([encBytes(script)]).toString('hex')
      },
      redeemers: [{ tag: 0, target: { kind: 'input', ref: scriptIn.ref }, data: 'd87980', exUnits }],
      auxiliaryData: null,
      scriptFee: executionFee(params, exUnits[0], exUnits[1]),
      fixedBytes: 0,
      refScriptBytes: 0
    };
    const requested = [requestedOut(scriptAddrText, backOut, 12n * ADA, [], { datum: { kind: 'inline', cbor: 'd87980' }, scriptPayment: true })];
    fixed.fixedBytes = fixedBytesOf(T, { requested, fixed, implicit: ZERO() });
    intent(t, 'T6', requested, { fixed, collateral: { required: true, observed: null } });
  };

  const deposit = (t, d) => {
    const tx = hash32(`${name} deposit ${d}`);
    const outs = [encodeOutput({ address: changeBytes, coin: 150n * ADA, assets: [] }, 'array')];
    if (d % 4 === 0) {
      const policy = hash28(`${name} deposit policy ${d}`);
      const tok = { policy, name: hex('NFT'), qty: 1n };
      outs.push(atMinimum(params, (c) => encodeOutput({ address: changeBytes, coin: c, assets: [tok] }, 'array')).bytes);
      left.push([tok]);
      live.push(left.length - 1);
    }
    if (d % 5 === 0 && units.length) {
      const f = units[d % units.length];
      f.qty += 1000n;
      const piece = { policy: f.policy, name: f.name, qty: 1000n };
      outs.push(atMinimum(params, (c) => encodeOutput({ address: changeBytes, coin: c, assets: [piece] }, 'array')).bytes);
    }
    events.push({ kind: 'deposit', tx, txId: n++, time: time(t), utxos: outs.map((b, i) => utxoFromOutput(tx, i, b, { origin: 'deposit' })) });
  };

  let m = 0;
  let deposits = 0;
  let marks = 0;
  let pending = 0;
  let pay = 0;
  while (events.length < total) {
    const t = at(events.length);
    if ((marks + 1) * MARK_EVERY <= t) {
      marks++;
      events.push({ kind: 'mark', n: marks, blockTime: Math.max(marks * MARK_EVERY, events.length ? at(events.length - 1) + 30 : 0) });
      continue;
    }
    if (pending >= DEPOSIT_EVERY) {
      pending = 0;
      deposit(t, ++deposits);
      continue;
    }
    m++;
    pending++;
    if (m % BURST_EVERY === 0 && total - events.length >= 2) {
      intent(t, 'T1', [payOut(params, ext(pay++), 2n * ADA, [])], { burst: { id: `b${m}`, parallel: true, index: 0 } });
      intent(t + 30, 'T1', [payOut(params, ext(pay++), 3n * ADA, [])], { burst: { id: `b${m}`, parallel: true, index: 1 } });
      m++;
      pending++;
      continue;
    }
    if (m % SCRIPT_EVERY === SCRIPT_FIRST) {
      scriptSpend(t, m);
      continue;
    }
    const r = rng.next();
    let done = false;
    if (r < 0.5) {
      // T1 below.
    } else if (r < 0.65) {
      if (live.length) {
        intent(t, 'T2', [send([take(rng.int(0, live.length - 1))], pay++)]);
        done = true;
      }
    } else if (r < 0.75) {
      const w = withTwo();
      if (w.length) {
        const li = w[rng.int(0, w.length - 1)];
        const a = take(li);
        const b = take(li);
        intent(t, 'T3', [send([a, b], pay++)]);
        done = true;
      }
    } else if (r < 0.85) {
      if (live.length >= 2) {
        const i = rng.int(0, live.length - 1);
        let j = rng.int(0, live.length - 2);
        if (j >= i) j++;
        const hi = Math.max(i, j);
        const lo = Math.min(i, j);
        const a = take(hi);
        const b = take(lo);
        intent(t, 'T4', [send([a, b], pay++)]);
        done = true;
      }
    } else {
      const have = units.filter((f) => f.qty >= 4n);
      if (have.length) {
        const f = have[rng.int(0, have.length - 1)];
        const q = f.qty / 4n;
        f.qty -= q;
        intent(t, 'T5', [send([{ policy: f.policy, name: f.name, qty: q }], pay++)]);
        done = true;
      }
    }
    if (!done) intent(t, 'T1', [payOut(params, ext(pay++), BigInt(rng.int(2, 20)) * ADA, [])]);
  }

  return { events, windowEnd: span };
}
