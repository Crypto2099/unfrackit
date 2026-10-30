// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Spend types and the asset classes they read.
//
// Types, assigned in this order: T6 script execution (a Plutus redeemer, or a
// phase-2-invalid transaction; native-script evaluation never counts); T8
// mint or burn; T7 certificate or governance only (certificates, votes or
// proposals); T5 fungible tokens sent (order placements at script addresses
// included); T4 NFTs of several policies sent; T3 several NFTs of one policy;
// T2 one NFT; T1 pure-ADA payment.
//
// An asset's class is the classification of cip67.mjs applied to a number of
// units: under the 'profile' setting, the largest of the wallet's holding of
// the asset at the window's start, at its end, and the units the transaction
// moved (the absolute net of the wallet's outputs less its consumed outputs,
// as the extraction tool's sql/profile-inputs.sql computes it); under
// 'at-spend', the wallet's holding just before the spend.

import { isFungible } from './cip67.mjs';
import { assetKey } from './value.mjs';

export function assetClasses(keys, { settings, holdStart, holdEnd, holdBefore, net }) {
  const out = {};
  for (const k of keys) {
    const name = k.split('.')[1];
    let units;
    if (settings.assetClass === 'profile') {
      const n = net.get(k) || 0n;
      units = [n < 0n ? -n : n, holdStart.get(k) || 0n, holdEnd.get(k) || 0n].reduce((a, b) => (b > a ? b : a), 0n);
    } else {
      units = holdBefore.get(k) || 0n;
    }
    out[k] = isFungible(name, units) ? 'FT' : 'NFT';
  }
  return out;
}

// sent: the requested outputs whose assets decide T1 to T5.
export function spendType({ script, mintOrBurn, governance, sent, classes, settings }) {
  if (script) return 'T6';
  if (mintOrBurn) return 'T8';
  if (governance) return 'T7';
  const assets = new Map();
  for (const o of sent) for (const a of o.assets) assets.set(assetKey(a), a);
  if ([...assets.keys()].some((k) => classes[k] === 'FT')) return 'T5';
  if (settings.t5ScriptOrders === 'any-script-output' && sent.some((o) => o.scriptPayment)) return 'T5';
  const nfts = [...assets.values()];
  if (!nfts.length) return 'T1';
  const policies = new Set(nfts.map((a) => a.policy));
  if (policies.size >= 2) return 'T4';
  if (nfts.length >= 2) return 'T3';
  return 'T2';
}
