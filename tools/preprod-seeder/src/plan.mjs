// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import { CSL, toHex } from './util.mjs';
import { makeOutput, minAdaOf, minimumOutput, valueBytes } from './outputs.mjs';
import { assemble, settle } from './tx.mjs';

// ---- seeding ----------------------------------------------------------------

// Pure-ADA output at the funder's address: the smallest change worth keeping.
function minPureAda(params, address) {
  return minAdaOf(makeOutput(address, 0n, []), params.coinsPerUtxoByte);
}

// Plan the chain of transactions that lays out one shape.
//   shape      generated shape (placeholder policies)
//   policyOf   Map placeholder policy id -> { policyId, script, sk }
//   shapeKeys  the shape wallet's keys ({ address, hash })
//   funder     { address, sk }
//   funding    [{ txHash, index, coin }] pure-ADA funder UTxOs spent by the first
//              transaction; each later transaction spends the previous change
//
// Each transaction mints the tokens its outputs need and creates those outputs
// at the shape wallet's addresses. Entries are ordered by policy so a
// transaction touches few policies (each one costs a script and a witness).
export function planSeed({ shape, policyOf, shapeKeys, funder, funding, params }) {
  const policyOrder = new Map(shape.policies.map((p, i) => [p, i]));
  const entries = shape.utxos.map((u, i) => ({ u, i }));
  const rank = (e) => (e.u.assets.length ? policyOrder.get(e.u.assets[0].policy) : Infinity);
  entries.sort((a, b) => rank(a) - rank(b) || a.i - b.i);

  const outputCache = new Map();
  const outputOf = (e) => {
    if (!outputCache.has(e.i)) {
      const u = e.u;
      const assets = u.assets.map((a) => ({ policy: policyOf.get(a.policy).policyId, name: a.name, qty: a.qty }));
      const key = shapeKeys[u.key];
      outputCache.set(e.i, makeOutput(key.address, u.coin, assets, { datum: u.datum, scriptRef: u.scriptRef ? key.hash : null }));
    }
    return outputCache.get(e.i);
  };

  const minPure = minPureAda(params, funder.address);
  const stats = { locked: 0n, fees: 0n, maxTxSize: 0, maxValueBytes: 0, outputs: 0 };
  const problems = [];
  const txs = [];

  const buildChunk = (chunk, inputs, inputCoin, fee, probe) => {
    const outputs = chunk.map(outputOf);
    let sum = 0n;
    for (const e of chunk) sum += e.u.coin;
    let change = inputCoin - sum - fee;
    // A probe only measures size, so a short balance is padded to a same-width value.
    if (change < minPure) {
      if (!probe) return { short: true, change };
      change = 2000000n;
    }
    const mint = new Map();
    const signers = new Map([[toHex(funder.sk.to_public().hash().to_bytes()), funder.sk]]);
    for (const e of chunk) {
      for (const a of e.u.assets) {
        const p = policyOf.get(a.policy);
        if (!mint.has(p.policyId)) mint.set(p.policyId, { script: p.script, assets: new Map() });
        const m = mint.get(p.policyId).assets;
        m.set(a.name, (m.get(a.name) || 0n) + a.qty);
        signers.set(p.policyId, p.sk);
      }
    }
    const all = [...outputs, makeOutput(funder.address, change, [])];
    const built = assemble({
      inputs,
      outputs: all,
      fee,
      mint: [...mint.values()].map((p) => ({ script: p.script, assets: [...p.assets] })),
      signers: [...signers.values()]
    });
    return { ...built, change, changeIndex: all.length - 1, mintedAssets: [...mint.values()].reduce((s, p) => s + p.assets.size, 0) };
  };

  let pos = 0;
  let current = funding.map((f) => ({ txHash: f.txHash, index: f.index }));
  let currentCoin = funding.reduce((s, f) => s + f.coin, 0n);
  let hint = 64;
  while (pos < entries.length) {
    const left = entries.length - pos;
    const fits = (k) => buildChunk(entries.slice(pos, pos + k), current, currentCoin, 250000n, true).size <= params.maxTxSize;
    // Grow from the previous transaction's count, then bisect.
    let lo = 1;
    let hi = Math.min(left, Math.max(1, hint));
    if (!fits(1)) throw new Error('a single output does not fit in a transaction');
    while (hi < left && fits(hi)) {
      lo = hi;
      hi = Math.min(left, hi * 2);
    }
    if (hi === left && fits(hi)) lo = hi;
    else {
      let l = lo;
      let h = hi;
      while (l < h) {
        const mid = (l + h + 1) >> 1;
        if (fits(mid)) l = mid;
        else h = mid - 1;
      }
      lo = l;
    }
    let k = lo;
    let done;
    for (;;) {
      const chunk = entries.slice(pos, pos + k);
      done = settle(params, (fee) => buildChunk(chunk, current, currentCoin, fee, false));
      if (done.short) throw new Error(`funding is short by ${(minPure - done.change).toString()} lovelace or more`);
      if (done.size <= params.maxTxSize) break;
      k--;
    }
    const chunk = entries.slice(pos, pos + k);
    for (const e of chunk) {
      const out = outputOf(e);
      stats.locked += e.u.coin;
      const vb = valueBytes(out);
      stats.maxValueBytes = Math.max(stats.maxValueBytes, vb);
      if (vb > params.maxValSize) problems.push(`output value of ${vb} bytes exceeds the maximum ${params.maxValSize}`);
      const min = minAdaOf(out, params.coinsPerUtxoByte);
      if (e.u.coin < min) problems.push(`an output holds ${e.u.coin} lovelace, below the minimum ${min}`);
    }
    stats.outputs += chunk.length;
    stats.fees += done.fee;
    stats.maxTxSize = Math.max(stats.maxTxSize, done.size);
    txs.push({ hash: done.hash, bytes: done.bytes, size: done.size, fee: done.fee, outputs: chunk.length, mintedAssets: done.mintedAssets });
    current = [{ txHash: done.hash, index: done.changeIndex }];
    currentCoin = done.change;
    pos += k;
    hint = k;
  }
  if (problems.length) throw new Error(problems.slice(0, 5).join('\n'));
  return { txs, ...stats, finalChange: currentCoin, minPure };
}

// ---- sweeping ---------------------------------------------------------------

// Plan transactions that move everything a wallet holds to `funderAddress`.
//   utxos       Koios-normalized UTxOs at the wallet's addresses
//   signerOf    Map address (bech32) -> PrivateKey
//   funderAddr  CSL.Address
//   owned       Map policy id -> { script, sk } for the tool's own policies
//
// Tokens under an owned policy are burned (the funder holds the policy keys), so
// a reseed mints a supply of exactly one per NFT again. Tokens under any other
// policy are returned to the funder unburned.
// Pure-ADA inputs come first, so the first transaction carries the ADA that pays
// for the repacking of foreign tokens. They are repacked into outputs under the
// value-size limit; the ADA left after fees and minimums goes to one more
// output, or into the last token output when it is below the minimum.
export function planSweep({ utxos, signerOf, funderAddr, params, owned = new Map() }) {
  const pure = utxos.filter((u) => !u.assets.length && !u.refScript).sort((a, b) => (a.coin < b.coin ? 1 : -1));
  const firstPolicy = (u) => (u.assets.length ? u.assets[0].policy : '');
  const rest = utxos.filter((u) => u.assets.length || u.refScript).sort((a, b) => (firstPolicy(a) < firstPolicy(b) ? -1 : firstPolicy(a) > firstPolicy(b) ? 1 : 0));
  const inputsAll = [...pure, ...rest];
  const minPure = minPureAda(params, funderAddr);
  const limit = params.maxValSize - 16;
  const cpb = params.coinsPerUtxoByte;

  const pack = (assets) => {
    const outs = [];
    const todo = assets.slice();
    while (todo.length) {
      let lo = 1;
      let hi = todo.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (valueBytes(minimumOutput(funderAddr, todo.slice(0, mid), cpb)) <= limit) lo = mid;
        else hi = mid - 1;
      }
      outs.push(todo.splice(0, lo));
    }
    return outs;
  };

  const build = (chunk, fee, probe) => {
    const totals = new Map();
    let coinIn = 0n;
    let refBytes = 0;
    const signers = new Map();
    for (const u of chunk) {
      coinIn += u.coin;
      if (u.refScript) refBytes += u.refScript.size;
      for (const a of u.assets) totals.set(a.policy + '.' + a.name, (totals.get(a.policy + '.' + a.name) || 0n) + a.qty);
      const sk = signerOf.get(u.address);
      if (!sk) throw new Error(`no signing key for ${u.address}`);
      signers.set(toHex(sk.to_public().hash().to_bytes()), sk);
    }
    const burn = new Map();
    const kept = [...totals].filter(([k, qty]) => {
      const policy = k.split('.')[0];
      if (!owned.has(policy)) return true;
      if (!burn.has(policy)) burn.set(policy, []);
      burn.get(policy).push([k.split('.')[1], -qty]);
      signers.set(policy, owned.get(policy).sk);
      return false;
    });
    const assets = kept
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, qty]) => {
        const [policy, name] = k.split('.');
        return { policy, name, qty };
      });
    const groups = pack(assets);
    const coins = groups.map((g) => minAdaOf(minimumOutput(funderAddr, g, cpb), cpb));
    let left = coinIn - coins.reduce((s, c) => s + c, 0n) - fee;
    if (left < 0n) {
      if (!probe) return { short: true, refBytes };
      left = 0n;
    }
    const extra = [];
    if (groups.length === 0) {
      if (left < minPure) {
        if (!probe) return { short: true, refBytes };
        left = minPure;
      }
      extra.push(left);
    } else if (left >= minPure) extra.push(left);
    else coins[coins.length - 1] += left;
    const outputs = groups.map((g, i) => makeOutput(funderAddr, coins[i], g));
    for (const c of extra) outputs.push(makeOutput(funderAddr, c, []));
    const built = assemble({
      inputs: chunk.map((u) => ({ txHash: u.txHash, index: u.index })),
      outputs,
      fee,
      mint: [...burn].map(([policy, list]) => ({ script: owned.get(policy).script, assets: list })),
      signers: [...signers.values()]
    });
    return { ...built, refBytes, burned: [...burn.values()].reduce((s, l) => s + l.length, 0) };
  };

  const txs = [];
  let pos = 0;
  let hint = 128;
  while (pos < inputsAll.length) {
    const left = inputsAll.length - pos;
    const fits = (k) => build(inputsAll.slice(pos, pos + k), 250000n, true).size <= params.maxTxSize;
    let lo = 1;
    let hi = Math.min(left, hint);
    if (!fits(1)) throw new Error('a single input does not fit in a transaction');
    while (hi < left && fits(hi)) {
      lo = hi;
      hi = Math.min(left, hi * 2);
    }
    if (hi === left && fits(hi)) lo = hi;
    else {
      let l = lo;
      let h = hi;
      while (l < h) {
        const mid = (l + h + 1) >> 1;
        if (fits(mid)) l = mid;
        else h = mid - 1;
      }
      lo = l;
    }
    let k = lo;
    let done;
    for (;;) {
      const chunk = inputsAll.slice(pos, pos + k);
      const refBytes = chunk.reduce((s, u) => s + (u.refScript ? u.refScript.size : 0), 0);
      done = settle(params, (fee) => build(chunk, fee, false), refBytes);
      if (done.short) throw new Error('the next group of UTxOs holds too little ADA to pay for its own transaction');
      if (done.size <= params.maxTxSize) break;
      k--;
    }
    txs.push({ hash: done.hash, bytes: done.bytes, size: done.size, fee: done.fee, inputs: k, burned: done.burned });
    pos += k;
    hint = k;
  }
  return { txs, fees: txs.reduce((s, t) => s + t.fee, 0n) };
}

export { CSL };
