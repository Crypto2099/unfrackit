// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The 17 wallet shapes. Each generator is deterministic: a fixed seed per shape
// feeds a small PRNG, and every choice (policy placeholders, names, quantities,
// splits, surplus coin, order) comes from it.
//
// A generated shape is { name, keys, policies, utxos }:
//   keys      number of payment keys the UTxOs are spread over (round robin)
//   policies  placeholder policy ids in order of creation; `seed` replaces each
//             with the id of a real minting policy, one to one
//   utxos     [{ ref, key, coin, assets, datum, scriptRef }] in final (shuffled)
//             order. `ref` is a generator-local identifier; on chain every UTxO
//             gets its real transaction id. `key` is the external payment key
//             index the UTxO belongs to. `coin` is a bigint in lovelace, `assets`
//             is [{ policy, name, qty }] with hex names and bigint quantities,
//             `datum` marks an inline datum and `scriptRef` marks a reference
//             script held at the UTxO's own key.

import { makeRng, toHex, asciiHex } from './util.mjs';
import { labelPrefixHex, withLabel } from './labels.mjs';
import { sizingAddress, makeOutput, minAdaOf, minimumOutput, valueBytes } from './outputs.mjs';

const ADA = 1000000;
const NFT_PREFIXES = ['Bud', 'PixelHead', 'Clay', 'SpaceApe', 'Yummi', 'Chilled', 'DeadRabbit', 'Ugly', 'Mocossi', 'Pavia'];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SIZING_KEY_HASH = '40'.repeat(28);

const nft = (count, tokens) => ({ count, tokens, kind: 'nft' });
const ft = (count, tokens, spread = 1) => ({ count, tokens, kind: 'ft', spread });

// Shapes described by a policy list and an ADA-only range.
const POLICY_SHAPES = {
  S1: { seed: 101, adaOnly: { count: 3, min: 50 * ADA, max: 50 * ADA }, policies: [] },
  S2: { seed: 102, adaOnly: { count: 2, min: 2 * ADA, max: 10 * ADA }, policies: [nft(1, 60)] },
  S2b: {
    seed: 102,
    surplus: [0, 0],
    distribution: { bundled: 60 },
    adaOnly: { count: 2, min: 2 * ADA, max: 10 * ADA },
    policies: [nft(1, 60)]
  },
  S3: { seed: 103, adaOnly: { count: 5, min: 2 * ADA, max: 10 * ADA }, policies: [nft(9, 10)] },
  S4: { seed: 104, adaOnly: { count: 100, min: 2 * ADA, max: 3 * ADA }, policies: [ft(20, 1)] },
  S5: { seed: 105, adaOnly: { count: 20, min: 2 * ADA, max: 10 * ADA }, policies: [nft(30, 10)] },
  S6: { seed: 106, adaOnly: { count: 40, min: 2 * ADA, max: 10 * ADA }, policies: [nft(40, 10), ft(6, 1, 10)] },
  S7: { seed: 103, keys: 3, adaOnly: { count: 5, min: 2 * ADA, max: 10 * ADA }, policies: [nft(9, 10)] },
  S8: {
    seed: 108,
    adaOnly: { count: 0, min: 0, max: 0 },
    policies: [nft(1, 10)],
    extras: { datumNft: true, scriptRef: true }
  },
  S9: {
    seed: 109,
    distribution: 'mixed',
    adaOnly: { count: 10, min: 2 * ADA, max: 10 * ADA },
    policies: [nft(20, 10), ft(5, 2, 3)]
  }
};

// The order is part of the interface: a shape's position fixes the range of
// minting-policy indexes it uses.
export const SHAPE_NAMES = ['S1', 'S2', 'S2b', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'M1', 'M2', 'M3', 'M4', 'M5', 'M7', 'M8'];

export function canonicalShape(name) {
  const hit = SHAPE_NAMES.find((n) => n.toLowerCase() === String(name).toLowerCase());
  if (!hit) throw new Error(`unknown shape "${name}"; shapes are ${SHAPE_NAMES.join(', ')}`);
  return hit;
}

// ---- token helpers ---------------------------------------------------------

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

// One policy of NFTs (quantity 1). names.bytes gives fixed-length random letters;
// otherwise a collection prefix plus a 4-digit serial. `label` puts a CIP-67
// label in front of the name bytes.
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

// One fungible asset whose total is `pieces` pieces, each drawn from qty [lo, hi].
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

// ---- layout ----------------------------------------------------------------

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

function minAdaFor(assets, flags) {
  const probe = makeOutput(sizingAddress(), 0n, assets, flags);
  const min = minAdaOf(probe);
  probe.free();
  return min;
}

// Lay out descriptors { tokens, coin?, surplus?, datum?, scriptRef?, key? } as
// UTxOs. Pure-ADA descriptors carry `coin`, raised to the minimum if below it;
// every other descriptor carries its minimum plus a surplus drawn from `surplus`.
function layoutDescs({ rng, keys, descs, surplusDefault, shuffle = true }) {
  const seen = new Set();
  const utxos = descs.map((d, i) => {
    const key = (d.key === undefined ? i : d.key) % keys;
    const ref = freshRef(rng, seen);
    const assets = mergeAssets(d.tokens);
    const flags = { datum: !!d.datum, scriptRef: d.scriptRef ? SIZING_KEY_HASH : null };
    const min = minAdaFor(assets, flags);
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

// ---- grouping used by the policy-described shapes --------------------------

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

function generatePolicyShape(name, spec) {
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

  const utxos = layoutDescs({ rng, keys, descs, surplusDefault: spec.surplus || [0, 5000000] });
  return { name, keys, policies: allPolicies, utxos };
}

// ---- M shapes ---------------------------------------------------------------

// The longest prefix of `tokens` whose minimum-coin output has a serialized value
// at or under `target` bytes (binary search).
function prefixAtValueSize(tokens, target) {
  const address = sizingAddress();
  const vb = (n) => valueBytes(minimumOutput(address, tokens.slice(0, n)));
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

// 5,000 is the protocol's maximum serialized value size on preprod.
export const VALUE_CAP = 5000;

function m1Tokens() {
  const rng = makeRng(501);
  const all = nftPolicy(rng, { count: 200, names: { bytes: 32 } });
  const { count } = prefixAtValueSize(all, VALUE_CAP);
  return all.slice(0, count);
}

function wallet(name, seed, descs, tokens, keys = 1) {
  const rng = makeRng(seed);
  const utxos = layoutDescs({ rng, keys, descs, surplusDefault: [0, 0] });
  return { name, keys, policies: policiesInOrder(tokens), utxos };
}

const M_SHAPES = {
  M1() {
    const t = m1Tokens();
    return wallet('M1', 511, [{ tokens: t, surplus: [0, 0] }, ...pureAda([12 * ADA, 8 * ADA])], t);
  },
  M2() {
    const rng = makeRng(502);
    const t = nftPolicy(rng, { count: 3000 });
    return wallet('M2', 512, [...onePerUtxo(t, [0, ADA]), ...pureAda(Array(5).fill(10 * ADA))], t);
  },
  M3() {
    const rng = makeRng(503);
    const t = [];
    for (let p = 0; p < 100; p++) t.push(...nftPolicy(rng, { count: 30 }));
    return wallet('M3', 513, [...onePerUtxo(t, [0, ADA]), ...pureAda(Array(5).fill(10 * ADA))], t);
  },
  M4() {
    const rng = makeRng(504);
    const t = [];
    for (let a = 0; a < 5; a++) t.push(...fungiblePieces(rng, { pieces: 100, qty: [500, 1500] }));
    const pure = Array.from({ length: 10 }, () => rng.int(2 * ADA, 5 * ADA));
    return wallet('M4', 514, [...onePerUtxo(t, [0, ADA]), ...pureAda(pure)], t);
  },
  M5() {
    return { ...generatePolicyShape('M5', POLICY_SHAPES.S6), name: 'M5' };
  },
  M7() {
    const t = m1Tokens();
    return wallet('M7', 517, [{ tokens: t, surplus: [0, 0] }, ...pureAda([ADA, ADA])], t);
  },
  M8() {
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
    return wallet('M8', 518, onePerUtxo(t, [0, ADA]), t);
  }
};

export function generate(name) {
  const n = canonicalShape(name);
  if (M_SHAPES[n]) return M_SHAPES[n]();
  return generatePolicyShape(n, POLICY_SHAPES[n]);
}

// What each shape is meant to exercise in the app, for listings.
export const SHAPE_NOTES = {
  S1: 'three pure-ADA UTxOs of 50 ADA',
  S2: '60 NFTs of one policy, one per UTxO, and 2 pure-ADA UTxOs',
  S2b: 'the 60 NFTs of S2 in one UTxO at its exact minimum, and 2 pure-ADA UTxOs',
  S3: '90 NFTs over 9 policies, one per UTxO, and 5 pure-ADA UTxOs',
  S4: '20 fungible tokens of 20 policies and 100 pure-ADA UTxOs of 2 to 3 ADA',
  S5: '300 NFTs over 30 policies, one per UTxO, and 20 pure-ADA UTxOs',
  S6: '400 NFTs over 40 policies, 60 fungible UTxOs of 6 policies, and 40 pure-ADA UTxOs',
  S7: 'the layout of S3 spread over 3 payment keys',
  S8: '10 NFTs, an NFT on a UTxO carrying an inline datum, and a UTxO carrying a reference script',
  S9: '200 NFTs over 20 policies and 10 fungibles of 5 policies, each fungible split over three pieces, shuffled into 61 UTxOs, and 10 pure-ADA UTxOs',
  M1: 'one UTxO of NFTs of one policy (32-byte names) at the value-size cap and at its minimum coin, and pure-ADA UTxOs of 12 and 8 ADA',
  M2: '3,000 NFTs of one policy, one per UTxO, and 5 pure-ADA UTxOs of 10 ADA',
  M3: '3,000 NFTs over 100 policies, one per UTxO, and 5 pure-ADA UTxOs of 10 ADA',
  M4: '5 fungible assets of 5 policies, each over 100 UTxOs, and 10 pure-ADA UTxOs of 2 to 5 ADA',
  M5: 'the layout of S6, meant for the setting that packs outputs to the value cap',
  M7: 'the layout of M1 with only 2 ADA of pure ADA',
  M8: 'CIP-67 labeled tokens (20 NFTs with label 222, 3 fungibles with label 333, 2 with label 444) and 5 unlabeled NFTs, one per UTxO'
};

export { labelPrefixHex };
