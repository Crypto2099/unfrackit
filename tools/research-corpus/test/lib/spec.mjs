// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Matching an on-chain UTxO set to a seeder shape's specification. On-chain
// policy IDs replace the generator's placeholders one to one, so the match is
// up to that substitution: each placeholder policy and each on-chain policy is
// described by the multiset of (asset name, quantity, coin of its UTxO) it
// covers; the induced placeholder-to-policy map must be a bijection, and under
// it the specified and on-chain UTxOs must be equal as multisets of (coin,
// sorted assets).

export function parseLine(line) {
  const [ref, coin, assets] = line.split(':');
  const [hash, index] = ref.split('#');
  return {
    hash,
    index: Number(index),
    coin: BigInt(coin),
    assets: assets
      ? assets.split(',').map((a) => {
          const [pn, qty] = a.split('=');
          const [policy, name] = pn.split('.');
          return { policy, name, qty: BigInt(qty) };
        })
      : []
  };
}

const sig = (coin, assets, mapPolicy = (p) => p) =>
  `${coin}|${assets
    .map((a) => `${mapPolicy(a.policy)}.${a.name}=${a.qty}`)
    .sort()
    .join(',')}`;

function policyItems(utxos) {
  const m = new Map();
  for (const u of utxos) {
    for (const a of u.assets) {
      if (!m.has(a.policy)) m.set(a.policy, []);
      m.get(a.policy).push(`${a.name}=${a.qty}@${u.coin}`);
    }
  }
  return new Map([...m].map(([p, xs]) => [p, xs.sort().join('|')]));
}

const multiset = (xs) => {
  const m = new Map();
  for (const x of xs) m.set(x, (m.get(x) || 0) + 1);
  return m;
};

// spec: generate(shape).utxos; chain: parsed lines.
export function matchSpec(spec, chain) {
  const problems = [];
  if (spec.length !== chain.length) problems.push(`count: specified ${spec.length}, on chain ${chain.length}`);
  const sp = policyItems(spec.map((u) => ({ coin: u.coin, assets: u.assets.map((a) => ({ policy: a.policy, name: a.name, qty: BigInt(a.qty) })) })));
  const cp = policyItems(chain);
  const byItems = new Map();
  for (const [p, items] of cp) {
    if (byItems.has(items)) problems.push(`two on-chain policies cover the same items`);
    byItems.set(items, p);
  }
  const map = new Map();
  for (const [ph, items] of sp) {
    const p = byItems.get(items);
    if (!p) problems.push(`placeholder ${ph.slice(0, 8)}: no on-chain policy covers its ${items.split('|').length} items`);
    else map.set(ph, p);
  }
  const images = new Set(map.values());
  const bijection = map.size === sp.size && images.size === map.size && images.size === cp.size;
  if (!bijection) problems.push(`policy map is not a bijection (${map.size} placeholders, ${images.size} images, ${cp.size} on-chain policies)`);
  const a = multiset(spec.map((u) => sig(u.coin, u.assets.map((x) => ({ ...x, qty: BigInt(x.qty) })), (p) => map.get(p) || `?${p}`)));
  const b = multiset(chain.map((u) => sig(u.coin, u.assets)));
  let missing = 0;
  let extra = 0;
  for (const [k, n] of a) missing += Math.max(0, n - (b.get(k) || 0));
  for (const [k, n] of b) extra += Math.max(0, n - (a.get(k) || 0));
  if (missing || extra) problems.push(`${missing} specified UTxOs not on chain, ${extra} on-chain UTxOs not specified`);
  return { ok: problems.length === 0, problems, policies: map.size, bijection };
}
