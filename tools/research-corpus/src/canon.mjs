// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The canonical line of one UTxO, the same as the SQL builds in
// sql/utxo-at-block.sql:
//   <tx hash hex>#<index>:<lovelace>:<policy hex>.<name hex>=<qty>,...
// with assets sorted by (policy, name) bytes. Lowercase hex of equal-length
// policies, then names, sorts as the bytes do, and the lines themselves are
// compared in byte order.

const byBytes = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function line(txHash, index, lovelace, assets) {
  const a = assets
    .map((x) => ({ p: x.policy.toLowerCase(), n: (x.name || '').toLowerCase(), q: BigInt(x.qty).toString() }))
    .sort((x, y) => byBytes(x.p, y.p) || byBytes(x.n, y.n))
    .map((x) => `${x.p}.${x.n}=${x.q}`)
    .join(',');
  return `${txHash.toLowerCase()}#${Number(index)}:${BigInt(lovelace).toString()}:${a}`;
}

export function sortLines(lines) {
  return [...lines].sort(byBytes);
}

// Koios account_utxos (extended) rows.
export function fromKoios(rows) {
  return sortLines(
    rows
      .filter((u) => u.is_spent !== true)
      .map((u) => line(u.tx_hash, u.tx_index, u.value, (u.asset_list || []).map((a) => ({ policy: a.policy_id, name: a.asset_name || '', qty: a.quantity }))))
  );
}

// cardano-cli query utxo --output-json: { "<hash>#<ix>": { address, value: { lovelace, <policy>: { <name>: qty } } } }
export function fromNode(obj) {
  const out = [];
  for (const [ref, u] of Object.entries(obj)) {
    const [hash, ix] = ref.split('#');
    const assets = [];
    let lovelace = null;
    for (const [k, v] of Object.entries(u.value)) {
      if (k === 'lovelace') lovelace = v;
      else for (const [name, qty] of Object.entries(v)) assets.push({ policy: k, name, qty });
    }
    out.push(line(hash, ix, lovelace, assets));
  }
  return sortLines(out);
}

export function diff(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  return { onlyA: a.filter((x) => !sb.has(x)), onlyB: b.filter((x) => !sa.has(x)) };
}
