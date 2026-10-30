// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Values: a coin and a multi-asset, as the Conway CDDL defines them
// (IntersectMBO/cardano-ledger at 391db20866113f08bc6317cb5c341304365986c6,
// eras/conway/impl/cddl/data/conway.cddl, `value = coin / [coin,
// multiasset<positive_coin>]` and `multiasset<a0> = {* policy_id => {+
// asset_name => a0}}`).
//
// An asset list is [{ policy, name, qty }] with lowercase hex policy and name
// and a BigInt quantity, sorted by policy bytes, then name bytes. That is the
// ledger's own order: its multi-asset is a Map of PolicyID to a Map of
// AssetName, and AssetName derives Ord from ShortByteString, which compares
// bytes (eras/mary/impl/src/Cardano/Ledger/Mary/Value.hs:108-115).

import { head, headSize, encUint, encBytes, asUint, asBytes, asInt, CborError } from './cbor.mjs';

const byHex = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const assetKey = (a) => `${a.policy}.${a.name}`;

export function sortAssets(assets) {
  return [...assets].sort((x, y) => byHex(x.policy, y.policy) || byHex(x.name, y.name));
}

// Sums quantities per asset; drops zeros.
export function mergeAssets(...lists) {
  const m = new Map();
  for (const list of lists) {
    for (const a of list) {
      const k = assetKey(a);
      const prev = m.get(k);
      m.set(k, { policy: a.policy, name: a.name, qty: (prev ? prev.qty : 0n) + BigInt(a.qty) });
    }
  }
  return sortAssets([...m.values()].filter((a) => a.qty !== 0n));
}

export const negateAssets = (list) => list.map((a) => ({ ...a, qty: -BigInt(a.qty) }));

export function assetMap(list) {
  const m = new Map();
  for (const a of list) m.set(assetKey(a), (m.get(assetKey(a)) || 0n) + BigInt(a.qty));
  return m;
}

// A multi-asset map node of quantities (unsigned for outputs, signed for a
// mint field) to an asset list. Zero quantities are dropped, as the ledger
// drops them when it decodes a multi-asset before protocol version 9 and
// refuses them from it (eras/mary/impl/src/Cardano/Ledger/Mary/Value.hs:
// 324-354, decodeMultiAsset and pruneZeroMultiAsset), so the asset list is
// the ledger's value; the original bytes are kept where bytes are used.
export function decodeMultiAsset(node, signed = false) {
  if (node.mt !== 5) throw new CborError(`multi-asset: expected a map at byte ${node.s}`);
  const out = [];
  for (const [p, inner] of node.entries) {
    const policy = asBytes(p, 'policy id');
    if (policy.length !== 28) throw new CborError(`policy id of ${policy.length} bytes`);
    if (inner.mt !== 5) throw new CborError(`assets of a policy: expected a map at byte ${inner.s}`);
    for (const [n, q] of inner.entries) {
      const qty = signed ? asInt(q, 'quantity') : asUint(q, 'quantity');
      if (qty !== 0n) out.push({ policy: policy.toString('hex'), name: asBytes(n, 'asset name').toString('hex'), qty });
    }
  }
  return sortAssets(out);
}

// A value node to { coin, assets }.
export function decodeValue(node) {
  if (node.mt === 0) return { coin: node.value, assets: [] };
  if (node.mt === 4 && node.items.length === 2) return { coin: asUint(node.items[0], 'coin'), assets: decodeMultiAsset(node.items[1]) };
  throw new CborError(`value: expected a coin or [coin, multiasset] at byte ${node.s}`);
}

function grouped(assets) {
  const g = new Map();
  for (const a of sortAssets(assets)) {
    if (!g.has(a.policy)) g.set(a.policy, []);
    g.get(a.policy).push(a);
  }
  return g;
}

// The ledger's serialization of a value: the coin alone when it carries no
// asset, else [coin, multiasset], every length definite and every integer in
// its shortest form, policies and names in the ledger's map order.
export function encodeValue(coin, assets) {
  const list = (assets || []).filter((a) => BigInt(a.qty) !== 0n);
  if (!list.length) return encUint(coin);
  const g = grouped(list);
  const parts = [head(4, 2), encUint(coin), head(5, g.size)];
  for (const [policy, xs] of g) {
    parts.push(encBytes(Buffer.from(policy, 'hex')), head(5, xs.length));
    for (const a of xs) parts.push(encBytes(Buffer.from(a.name, 'hex')), encUint(a.qty));
  }
  return Buffer.concat(parts);
}

// The length of encodeValue(coin, assets), without building it. This is the
// measure the ledger's value-size check takes, the length of the serialized
// Value (cardano-ledger, eras/alonzo/impl/src/Cardano/Ledger/Alonzo/Rules/
// Utxo.hs:425-447, validateOutputTooBigUTxO).
export function valueSize(coin, assets) {
  const list = (assets || []).filter((a) => BigInt(a.qty) !== 0n);
  if (!list.length) return headSize(coin);
  const g = grouped(list);
  let n = 1 + headSize(coin) + headSize(g.size);
  for (const [, xs] of g) {
    n += headSize(28) + 28 + headSize(xs.length);
    for (const a of xs) {
      const len = a.name.length / 2;
      n += headSize(len) + len + headSize(a.qty);
    }
  }
  return n;
}

// The canonical line of one UTxO, the extraction tool's format:
//   <tx hash hex>#<index>:<lovelace>:<policy hex>.<name hex>=<qty>,...
// with assets sorted by (policy, name) bytes.
export function canonicalLine(txHash, index, coin, assets) {
  const a = sortAssets(assets)
    .map((x) => `${x.policy}.${x.name}=${BigInt(x.qty)}`)
    .join(',');
  return `${txHash}#${Number(index)}:${BigInt(coin)}:${a}`;
}
