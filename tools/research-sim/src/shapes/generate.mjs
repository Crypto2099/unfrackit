// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The synthetic wallet shapes. Each generator is deterministic: a fixed seed
// per shape feeds mulberry32 (rng.mjs), and every choice (policy ids, names,
// quantities, splits, surplus coin, references, order) comes from it.
//
// The 17 shapes S1 to S9, S2b, M1 to M5, M7 and M8 are the preprod seeder's
// generator (tools/preprod-seeder/src/shapes.mjs in this repository, at
// commit a230e5b), which generates the same wallets as the treatment's
// measurement harness; a test compares them with the harness's own
// generators byte for byte. The four further shapes model the wallets the
// standard battery's last two spends are for:
//
//   CL1  one year of token claims (73 epochs): 73 claim UTxOs and pure-ADA
//        UTxOs of 25 and 75 ADA
//   CL3  three years: 219 claim UTxOs and pure-ADA UTxOs of 25 and 75 ADA
//   E1   a merchant with a $25 average order: 400 payment UTxOs and 5
//        pure-ADA UTxOs of 10 ADA
//   E2   a merchant with a $100 average order: 100 payment UTxOs and 5
//        pure-ADA UTxOs of 10 ADA
//
// A claim UTxO holds exactly its minimum ADA, token A (the token the holder
// claims every epoch) in an amount drawn uniformly from 1,000 to 100,000
// units, and a number of further fungible assets drawn uniformly from 0 to 9,
// taken without replacement from a pool of 30 assets (CL1) or 60 (CL3), each
// under its own policy with a name of 3 to 8 letters, in amounts drawn
// uniformly from 1 to 10,000 units. A payment UTxO holds its minimum ADA plus a
// surplus drawn uniformly from 0 to 0.5 ADA, and one stablecoin of 6 decimal
// places, priced at $1 per whole unit, in an amount equal to the average
// order times a factor drawn uniformly from 0.5 to 1.5 (drawn as whole base
// units). The tokens are drawn from seeds 521 to 524 and the wallets (their
// references, surplus coin and order) from seeds 531 to 534, for CL1, CL3, E1
// and E2 in that order, as the M shapes split their seeds.
//
// A generated shape is { name, keys, policies, utxos }: utxos are
// [{ ref: { txHash, index }, key, coin, assets, datum, scriptRef }] in final
// (shuffled) order, `key` the payment key index, assets [{ policy, name, qty }]
// with hex names and bigint quantities.

import { makeRng } from './rng.mjs';
import { cip67Prefix } from '../history/cip67.mjs';

const ADA = 1000000;
const NFT_PREFIXES = ['Bud', 'PixelHead', 'Clay', 'SpaceApe', 'Yummi', 'Chilled', 'DeadRabbit', 'Ugly', 'Mocossi', 'Pavia'];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SIZING_KEY_HASH = '40'.repeat(28);
const toHex = (b) => Buffer.from(b).toString('hex');
const asciiHex = (s) => Buffer.from(s, 'ascii').toString('hex');
const withLabel = (label, nameHex = '') => {
  const hex = cip67Prefix(label) + nameHex;
  if (hex.length > 64) throw new RangeError('asset name over 32 bytes');
  return hex;
};

const nft = (count, tokens) => ({ count, tokens, kind: 'nft' });
const ft = (count, tokens, spread = 1) => ({ count, tokens, kind: 'ft', spread });

const POLICY_SHAPES = {
  S1: { seed: 101, adaOnly: { count: 3, min: 50 * ADA, max: 50 * ADA }, policies: [] },
  S2: { seed: 102, adaOnly: { count: 2, min: 2 * ADA, max: 10 * ADA }, policies: [nft(1, 60)] },
  S2b: { seed: 102, surplus: [0, 0], distribution: { bundled: 60 }, adaOnly: { count: 2, min: 2 * ADA, max: 10 * ADA }, policies: [nft(1, 60)] },
  S3: { seed: 103, adaOnly: { count: 5, min: 2 * ADA, max: 10 * ADA }, policies: [nft(9, 10)] },
  S4: { seed: 104, adaOnly: { count: 100, min: 2 * ADA, max: 3 * ADA }, policies: [ft(20, 1)] },
  S5: { seed: 105, adaOnly: { count: 20, min: 2 * ADA, max: 10 * ADA }, policies: [nft(30, 10)] },
  S6: { seed: 106, adaOnly: { count: 40, min: 2 * ADA, max: 10 * ADA }, policies: [nft(40, 10), ft(6, 1, 10)] },
  S7: { seed: 103, keys: 3, adaOnly: { count: 5, min: 2 * ADA, max: 10 * ADA }, policies: [nft(9, 10)] },
  S8: { seed: 108, adaOnly: { count: 0, min: 0, max: 0 }, policies: [nft(1, 10)], extras: { datumNft: true, scriptRef: true } },
  S9: { seed: 109, distribution: 'mixed', adaOnly: { count: 10, min: 2 * ADA, max: 10 * ADA }, policies: [nft(20, 10), ft(5, 2, 3)] }
};

export const SHAPE_NAMES = Object.freeze(['S1', 'S2', 'S2b', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'M1', 'M2', 'M3', 'M4', 'M5', 'M7', 'M8', 'CL1', 'CL3', 'E1', 'E2']);
export const HARNESS_SHAPES = Object.freeze(SHAPE_NAMES.slice(0, 17));

// Sizing: the minimum coin of an output with these assets (and datum or
// script reference) at a 57-byte base address, at 4,310 lovelace per byte,
// through CSL (the generators' own rule, unchanged from the harness's).
function sizer(T) {
  const CSL = T.CSL;
  const pay = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_bytes(new Uint8Array(28).fill(0x40)));
  const stake = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_bytes(new Uint8Array(28).fill(0x99)));
  const address = CSL.BaseAddress.new(0, pay, stake).to_address();
  const per = CSL.BigNum.from_str('4310');
  const dc = CSL.DataCost.new_coins_per_byte(per);
  const minAdaFor = (assets, flags) => {
    const o = makeOutput(T, address, 0n, assets, flags);
    const m = CSL.min_ada_for_output(o, dc);
    const v = BigInt(m.to_str());
    m.free();
    o.free();
    return v;
  };
  const valueBytesAtMinimum = (tokens) => {
    const ma = multiAsset(T, tokens);
    const b1 = CSL.TransactionOutputBuilder.new();
    const b2 = b1.with_address(address);
    const b3 = b2.next();
    const b4 = b3.with_asset_and_min_required_coin_by_utxo_cost(ma, dc);
    const o = b4.build();
    const amount = o.amount();
    const n = amount.to_bytes().length;
    for (const x of [amount, o, b4, b3, b2, b1, ma]) x.free();
    return n;
  };
  return { minAdaFor, valueBytesAtMinimum };
}

function multiAsset(T, assets) {
  const CSL = T.CSL;
  const merged = new Map();
  for (const a of assets) {
    const k = a.policy + '.' + a.name;
    merged.set(k, (merged.get(k) || 0n) + BigInt(a.qty));
  }
  const ma = CSL.MultiAsset.new();
  for (const [k, q] of merged) {
    const [p, n] = k.split('.');
    const sh = CSL.ScriptHash.from_hex(p);
    const an = CSL.AssetName.new(Buffer.from(n, 'hex'));
    const bn = CSL.BigNum.from_str(q.toString());
    const prev = ma.set_asset(sh, an, bn);
    if (prev) prev.free();
    for (const x of [sh, an, bn]) x.free();
  }
  return ma;
}

function makeValue(T, coin, assets) {
  const CSL = T.CSL;
  const c = CSL.BigNum.from_str(coin.toString());
  if (!assets.length) {
    const v = CSL.Value.new(c);
    c.free();
    return v;
  }
  const ma = multiAsset(T, assets);
  const v = CSL.Value.new_with_assets(c, ma);
  c.free();
  ma.free();
  return v;
}

// flags: { datum: bool, scriptRef: key hash hex or null }. The datum is an
// inline datum, the integer 42; the script reference a native script that
// requires the given key's signature.
function makeOutput(T, address, coin, assets, flags = {}) {
  const CSL = T.CSL;
  const v = makeValue(T, coin, assets);
  const o = CSL.TransactionOutput.new(address, v);
  v.free();
  if (flags.datum) {
    const bi = CSL.BigInt.from_str('42');
    const pd = CSL.PlutusData.new_integer(bi);
    o.set_plutus_data(pd);
    pd.free();
    bi.free();
  }
  if (flags.scriptRef) {
    const kh = CSL.Ed25519KeyHash.from_hex(flags.scriptRef);
    const sp = CSL.ScriptPubkey.new(kh);
    const ns = CSL.NativeScript.new_script_pubkey(sp);
    const sr = CSL.ScriptRef.new_native_script(ns);
    o.set_script_ref(sr);
    for (const x of [sr, ns, sp, kh]) x.free();
  }
  return o;
}

const policyId = (rng) => toHex(rng.bytes(28));

function uniqueLetters(rng, len, used) {
  let s;
  do {
    s = '';
    for (let k = 0; k < len; k++) s += LETTERS[rng.int(0, 25)];
  } while (used.has(s));
  used.add(s);
  return s;
}

function nftPolicy(rng, { count, names = { prefix: true }, label = null, policy = null }) {
  const policy_id = policy || policyId(rng);
  const prefix = rng.pick(NFT_PREFIXES);
  const used = new Set();
  const tokens = [];
  for (let i = 0; i < count; i++) {
    let body;
    if (names.bytes) body = asciiHex(uniqueLetters(rng, label === null ? names.bytes : names.bytes - 4, used));
    else body = asciiHex(prefix + String(i + 1).padStart(4, '0'));
    tokens.push({ policy: policy_id, name: label === null ? body : withLabel(label, body), qty: 1n });
  }
  return tokens;
}

function fungiblePieces(rng, { pieces, qty: [lo, hi], label = null, policy = null, name = null }) {
  const policy_id = policy || policyId(rng);
  const body = asciiHex(name || uniqueLetters(rng, rng.int(3, 8), new Set()));
  const token = label === null ? body : withLabel(label, body);
  const out = [];
  for (let i = 0; i < pieces; i++) out.push({ policy: policy_id, name: token, qty: BigInt(rng.int(lo, hi)) });
  return out;
}

const onePerUtxo = (tokens, surplus) => tokens.map((t) => ({ tokens: [t], surplus }));
const pureAda = (coins) => coins.map((c) => ({ tokens: [], coin: BigInt(c) }));

function policiesInOrder(tokens) {
  const seen = [];
  for (const t of tokens) if (!seen.includes(t.policy)) seen.push(t.policy);
  return seen;
}

function mergeAssets(group) {
  const merged = new Map();
  for (const t of group) {
    const k = t.policy + '.' + t.name;
    merged.set(k, (merged.get(k) || 0n) + BigInt(t.qty));
  }
  return [...merged].map(([k, qty]) => {
    const [policy, name] = k.split('.');
    return { policy, name, qty };
  });
}

function freshRef(rng, seen) {
  let txHash;
  let index;
  do {
    txHash = rng.bytes(32);
    index = rng.int(0, 3);
  } while (seen.has(toHex(txHash) + '#' + index));
  seen.add(toHex(txHash) + '#' + index);
  return { txHash: toHex(txHash), index };
}

function layoutDescs(sz, { rng, keys, descs, surplusDefault, shuffle = true }) {
  const seen = new Set();
  const utxos = descs.map((d, i) => {
    const key = (d.key === undefined ? i : d.key) % keys;
    const ref = freshRef(rng, seen);
    const assets = mergeAssets(d.tokens);
    const flags = { datum: !!d.datum, scriptRef: d.scriptRef ? SIZING_KEY_HASH : null };
    const min = sz.minAdaFor(assets, flags);
    let coin;
    if (!d.tokens.length && !d.datum && !d.scriptRef) coin = d.coin > min ? d.coin : min;
    else {
      const [lo, hi] = d.surplus || surplusDefault;
      coin = min + BigInt(rng.int(lo, hi));
    }
    return { ref, key, coin, assets, datum: !!d.datum, scriptRef: !!d.scriptRef };
  });
  if (shuffle) rng.shuffle(utxos);
  return utxos;
}

function splitQuantity(rng, q, parts) {
  if (parts <= 1) return [q];
  const cuts = new Set();
  while (cuts.size < parts - 1) cuts.add(rng.int(1, q - 1));
  const sorted = [...cuts].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const c of sorted) {
    out.push(c - prev);
    prev = c;
  }
  out.push(q - prev);
  return out;
}

function groupPieces(rng, pieces, distribution) {
  if (distribution === 'one-per-utxo') return pieces.map((p) => [p]);
  if (distribution && typeof distribution === 'object' && distribution.bundled) {
    const n = distribution.bundled;
    const groups = [];
    for (let i = 0; i < pieces.length; i += n) groups.push(pieces.slice(i, i + n));
    return groups;
  }
  if (distribution === 'mixed') {
    const shuffled = rng.shuffle(pieces.slice());
    const groups = [];
    let i = 0;
    while (i < shuffled.length) {
      const n = rng.int(1, 6);
      groups.push(shuffled.slice(i, i + n));
      i += n;
    }
    return groups;
  }
  throw new Error('unknown distribution ' + JSON.stringify(distribution));
}

function generatePolicyShape(sz, name, spec) {
  const rng = makeRng(spec.seed);
  const keys = spec.keys || 1;
  const policies = [];
  for (const p of spec.policies) {
    for (let c = 0; c < p.count; c++) {
      const policy = policyId(rng);
      const prefix = p.kind === 'nft' ? rng.pick(NFT_PREFIXES) : null;
      const tokens = [];
      const used = new Set();
      for (let t = 0; t < p.tokens; t++) {
        let tokenName;
        if (p.kind === 'nft') tokenName = prefix + String(t + 1).padStart(4, '0');
        else {
          do {
            const len = rng.int(3, 8);
            tokenName = '';
            for (let k = 0; k < len; k++) tokenName += LETTERS[rng.int(0, 25)];
          } while (used.has(tokenName));
        }
        used.add(tokenName);
        const quantity = p.kind === 'nft' ? 1 : rng.int(1000, 1000000000);
        tokens.push({ policy, name: asciiHex(tokenName), quantity, spread: p.kind === 'nft' ? 1 : p.spread || 1 });
      }
      policies.push({ policy, prefix, tokens });
    }
  }
  const pieces = [];
  for (const pol of policies) {
    for (const t of pol.tokens) {
      for (const q of splitQuantity(rng, t.quantity, t.spread)) pieces.push({ policy: t.policy, name: t.name, qty: BigInt(q) });
    }
  }
  const groups = groupPieces(rng, pieces, spec.distribution || 'one-per-utxo');
  const descs = groups.map((g) => ({ tokens: g }));
  const ada = spec.adaOnly;
  for (let i = 0; i < ada.count; i++) descs.push({ tokens: [], coin: BigInt(rng.int(ada.min, ada.max)) });
  const allPolicies = policies.map((p) => p.policy);
  if (spec.extras && spec.extras.datumNft) {
    const pol = policies.find((p) => p.prefix) || { policy: policyId(rng), prefix: 'Datum' };
    if (!allPolicies.includes(pol.policy)) allPolicies.push(pol.policy);
    descs.push({ tokens: [{ policy: pol.policy, name: asciiHex(pol.prefix + 'D001'), qty: 1n }], datum: true });
  }
  if (spec.extras && spec.extras.scriptRef) descs.push({ tokens: [], scriptRef: true });
  const utxos = layoutDescs(sz, { rng, keys, descs, surplusDefault: spec.surplus || [0, 5000000] });
  return { name, keys, policies: allPolicies, utxos };
}

// The longest prefix of `tokens` whose minimum-coin output has a serialized
// Value at or under `target` bytes (binary search).
function prefixAtValueSize(sz, tokens, target) {
  const vb = (n) => sz.valueBytesAtMinimum(tokens.slice(0, n));
  let lo = 1;
  let hi = tokens.length;
  if (vb(hi) <= target) return { count: hi, valueBytes: vb(hi) };
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (vb(mid) <= target) lo = mid;
    else hi = mid - 1;
  }
  return { count: lo, valueBytes: vb(lo) };
}

function m1Tokens(sz) {
  const rng = makeRng(501);
  const all = nftPolicy(rng, { count: 200, names: { bytes: 32 } });
  const { count } = prefixAtValueSize(sz, all, 5000);
  return all.slice(0, count);
}

function wallet(sz, name, seed, descs, tokens, keys = 1, surplusDefault = [0, 0]) {
  const rng = makeRng(seed);
  const utxos = layoutDescs(sz, { rng, keys, descs, surplusDefault });
  return { name, keys, policies: policiesInOrder(tokens), utxos };
}

function claimShape(sz, name, { tokenSeed, walletSeed, claims, poolSize }) {
  const rng = makeRng(tokenSeed);
  const a = { policy: policyId(rng), name: asciiHex(uniqueLetters(rng, rng.int(3, 8), new Set())) };
  const pool = [];
  for (let i = 0; i < poolSize; i++) pool.push({ policy: policyId(rng), name: asciiHex(uniqueLetters(rng, rng.int(3, 8), new Set())) });
  const descs = [];
  const all = [];
  for (let c = 0; c < claims; c++) {
    const tokens = [{ ...a, qty: BigInt(rng.int(1000, 100000)) }];
    const m = rng.int(0, 9);
    const picks = rng.shuffle(pool.map((_, i) => i)).slice(0, m).sort((x, y) => x - y);
    for (const i of picks) tokens.push({ ...pool[i], qty: BigInt(rng.int(1, 10000)) });
    descs.push({ tokens, surplus: [0, 0] });
    all.push(...tokens);
  }
  descs.push(...pureAda([25 * ADA, 75 * ADA]));
  return wallet(sz, name, walletSeed, descs, all);
}

function merchantShape(sz, name, { tokenSeed, walletSeed, payments, orderUsd }) {
  const rng = makeRng(tokenSeed);
  const coin = { policy: policyId(rng), name: asciiHex(uniqueLetters(rng, rng.int(3, 8), new Set())) };
  const unit = 1000000;
  const lo = (orderUsd * unit) / 2;
  const hi = (orderUsd * unit * 3) / 2;
  const descs = [];
  const all = [];
  for (let i = 0; i < payments; i++) {
    const t = { ...coin, qty: BigInt(rng.int(lo, hi)) };
    descs.push({ tokens: [t], surplus: [0, ADA / 2] });
    all.push(t);
  }
  descs.push(...pureAda(Array(5).fill(10 * ADA)));
  return wallet(sz, name, walletSeed, descs, all);
}

const M_SHAPES = {
  M1(sz) {
    const t = m1Tokens(sz);
    return wallet(sz, 'M1', 511, [{ tokens: t, surplus: [0, 0] }, ...pureAda([12 * ADA, 8 * ADA])], t);
  },
  M2(sz) {
    const rng = makeRng(502);
    const t = nftPolicy(rng, { count: 3000 });
    return wallet(sz, 'M2', 512, [...onePerUtxo(t, [0, ADA]), ...pureAda(Array(5).fill(10 * ADA))], t);
  },
  M3(sz) {
    const rng = makeRng(503);
    const t = [];
    for (let p = 0; p < 100; p++) t.push(...nftPolicy(rng, { count: 30 }));
    return wallet(sz, 'M3', 513, [...onePerUtxo(t, [0, ADA]), ...pureAda(Array(5).fill(10 * ADA))], t);
  },
  M4(sz) {
    const rng = makeRng(504);
    const t = [];
    for (let a = 0; a < 5; a++) t.push(...fungiblePieces(rng, { pieces: 100, qty: [500, 1500] }));
    const pure = Array.from({ length: 10 }, () => rng.int(2 * ADA, 5 * ADA));
    return wallet(sz, 'M4', 514, [...onePerUtxo(t, [0, ADA]), ...pureAda(pure)], t);
  },
  M5(sz) {
    return { ...generatePolicyShape(sz, 'M5', POLICY_SHAPES.S6), name: 'M5' };
  },
  M7(sz) {
    const t = m1Tokens(sz);
    return wallet(sz, 'M7', 517, [{ tokens: t, surplus: [0, 0] }, ...pureAda([ADA, ADA])], t);
  },
  M8(sz) {
    const rng = makeRng(508);
    const t = [];
    t.push(...nftPolicy(rng, { count: 20, label: 222 }));
    const p333 = '33'.repeat(28);
    t.push(...fungiblePieces(rng, { pieces: 1, qty: [1000000, 1000000], label: 333, policy: p333, name: 'GOLD' }));
    t.push(...fungiblePieces(rng, { pieces: 1, qty: [250000, 250000], label: 333, policy: p333, name: 'SILVER' }));
    t.push(...fungiblePieces(rng, { pieces: 1, qty: [1, 1], label: 333, policy: p333, name: 'BRONZE' }));
    const p444 = '44'.repeat(28);
    t.push(...fungiblePieces(rng, { pieces: 1, qty: [100, 100], label: 444, policy: p444, name: 'Share' }));
    t.push(...fungiblePieces(rng, { pieces: 1, qty: [1, 1], label: 444, policy: p444, name: 'Shard' }));
    t.push(...nftPolicy(rng, { count: 5 }));
    return wallet(sz, 'M8', 518, onePerUtxo(t, [0, ADA]), t);
  },
  CL1: (sz) => claimShape(sz, 'CL1', { tokenSeed: 521, walletSeed: 531, claims: 73, poolSize: 30 }),
  CL3: (sz) => claimShape(sz, 'CL3', { tokenSeed: 522, walletSeed: 532, claims: 219, poolSize: 60 }),
  E1: (sz) => merchantShape(sz, 'E1', { tokenSeed: 523, walletSeed: 533, payments: 400, orderUsd: 25 }),
  E2: (sz) => merchantShape(sz, 'E2', { tokenSeed: 524, walletSeed: 534, payments: 100, orderUsd: 100 })
};

export function generateShape(T, name) {
  if (!SHAPE_NAMES.includes(name)) throw new Error(`unknown shape ${name}; shapes are ${SHAPE_NAMES.join(', ')}`);
  const sz = sizer(T);
  if (M_SHAPES[name]) return M_SHAPES[name](sz);
  return generatePolicyShape(sz, name, POLICY_SHAPES[name]);
}

// Every UTxO of a generated shape as a real serialized CIP-30
// TransactionUnspentOutput, in the shape's order, at the treatment's fixed
// test addresses (cslkit.mjs baseAddress: payment key `key`, one stake key),
// the script reference requiring payment key 0, as the harness serializes
// them.
export function serializeShape(T, shape) {
  const CSL = T.CSL;
  const addrs = [];
  for (let i = 0; i < shape.keys; i++) addrs.push(T.cslkit.baseAddress(i));
  const scriptKey = T.cslkit.paymentKey(0).hash().to_hex();
  return shape.utxos.map((u) => {
    const out = makeOutput(T, addrs[u.key], u.coin, u.assets, { datum: u.datum, scriptRef: u.scriptRef ? scriptKey : null });
    const th = CSL.TransactionHash.from_hex(u.ref.txHash);
    const ti = CSL.TransactionInput.new(th, u.ref.index);
    const tu = CSL.TransactionUnspentOutput.new(ti, out);
    const hex = toHex(tu.to_bytes());
    for (const x of [tu, ti, th, out]) x.free();
    return hex;
  });
}
