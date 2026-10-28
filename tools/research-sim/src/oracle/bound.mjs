// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A lower bound on the fee of any feasible transaction built from a given
// input set, whatever the change policy, and the conditions every such
// transaction must meet. It counts only bytes every transaction from the set
// must hold, each in its shortest CBOR encoding (RFC 8949 section 4.2.1),
// under the Conway CDDL (IntersectMBO/cardano-ledger at
// 391db20866113f08bc6317cb5c341304365986c6, eras/conway/impl/cddl/data/
// conway.cddl: transaction 16-17, body 107-128, output 197-202, witness set
// 760-771, vkeywitness 773):
//
//   the transaction header, the body's map header, the inputs key, header and
//   entries ([32-byte id, index], 36 to 38 bytes each), the outputs key and
//   header, the requested outputs as given, the fee key and a fee of at least
//   minFeeB; the witness set's header and one 101-byte vkey witness per
//   distinct key payment credential of the inputs (a key payment credential
//   is spent with a vkey witness; CIP-0019, "Payment part"); the auxiliary
//   data's null; and the change:
//
//   - when the inputs hold a token the requested outputs do not take whole,
//     at least one change output at the change address holding every
//     returned token entry, its coin at least the minimum of such an output
//     (eras/babbage/impl/src/Cardano/Ledger/Babbage/TxOut.hs:678-702,
//     babbageMinUTxOValue, 160 plus the serialized size times
//     coinsPerUtxoByte); splitting the tokens over several outputs only adds
//     bytes and minimums;
//   - otherwise the leftover ADA is either carried by an ADA-only output at
//     the change address, or there is no change output and the fee takes the
//     whole leftover (cardano-serialization-lib burns a leftover below the
//     change minimum; an exact leftover of zero needs no output). Under the
//     setting setFee 'ledger-minimum' the fee is scored at the ledger minimum
//     of the size, so only the bytes without a change output are counted.
//
// The fee of every transaction from the set is at least minFeeA times these
// bytes plus minFeeB; the ledger size of the transaction (without the
// validity flag) is at least these bytes; and the inputs' coin must cover the
// requested coin, that fee and the change minimum. A set that fails one of
// these conditions has no feasible transaction under any policy.
//
// Adding inputs to a set raises the bound by at least minFeeA times the
// added inputs' bytes, which is what the branch and bound's subtree bounds
// rest on; the condition that every coin covers its own input's fee bytes
// (always true at a minimum UTxO above zero) is checked, and when it fails
// the ADA-only branch falls back to the bound without a change output.

import { headSize } from '../history/cbor.mjs';
import { valueSize } from '../history/value.mjs';
import { addressBytes } from '../history/address.mjs';
import { requestedAssets } from './spend.mjs';

const key = (a) => `${a.policy}.${a.name}`;
export const VKEY_WITNESS_BYTES = 101;
// [txid (bytes .size 32), index]: array head, byte-string head, 32 bytes.
export const inputBytes = (index) => 1 + 2 + 32 + headSize(index);
export const indexOfRef = (ref) => Number(ref.slice(ref.indexOf('#') + 1));

export function makeBoundModel(state, spend, params, settings) {
  const a = BigInt(params.minFeeA);
  const b = BigInt(params.minFeeB);
  const rho = BigInt(params.coinsPerUtxoByte);
  const req = requestedAssets(spend);
  const reqCoin = spend.requested.reduce((s, o) => s + BigInt(o.coin), 0n);
  const reqBytes = spend.requested.reduce((s, o) => s + o.cbor.length / 2, 0);
  const reqCount = spend.requested.length;
  const addr = addressBytes(state.changeAddress).length;
  const addrBytes = headSize(addr) + addr;
  const feeField = headSize(b);
  // An ADA-only change output: [address, coin], the coin at least the
  // minimum of such an output.
  const pureMinLB = rho * BigInt(160 + 1 + addrBytes + headSize(rho * 160n));
  const adaOutBytes = 1 + addrBytes + headSize(pureMinLB);
  const ledgerMinimum = settings.setFee === 'ledger-minimum';
  return { a, b, rho, req, reqCoin, reqBytes, reqCount, addrBytes, feeField, pureMinLB, adaOutBytes, ledgerMinimum, maxTxSize: params.maxTxSize };
}

// The change bytes of the returned tokens in one output, and that output's
// least possible minimum.
export function tokenChange(M, returned) {
  const lb0 = BigInt(160 + 1 + M.addrBytes + valueSize(M.rho * 160n, returned));
  const coinLB = M.rho * lb0;
  const bytes = 1 + M.addrBytes + valueSize(coinLB, returned);
  return { bytes, minCoin: M.rho * BigInt(160 + bytes) };
}

// The bound for the set S (UTxO records). Returns { covers, fee, bytes,
// coinIn, need (the coin the inputs must hold at least), feasible (every
// necessary condition holds), returned (the returned token entries) }.
export function boundOf(M, S) {
  let coinIn = 0n;
  let inBytes = 0;
  const creds = new Set();
  const held = new Map();
  let coinCoversOwnInput = true;
  for (const u of S) {
    coinIn += u.coin;
    const ib = inputBytes(indexOfRef(u.ref));
    inBytes += ib;
    if (u.coin < M.a * BigInt(ib)) coinCoversOwnInput = false;
    creds.add(u.cred);
    for (const x of u.assets) {
      const k = key(x);
      const e = held.get(k);
      if (e) e.qty += x.qty;
      else held.set(k, { policy: x.policy, name: x.name, qty: x.qty });
    }
  }
  let covers = true;
  for (const [k, q] of M.req) {
    const e = held.get(k);
    if (!e || e.qty < q) covers = false;
  }
  const returned = [];
  for (const [k, e] of held) {
    const r = e.qty - (M.req.get(k) || 0n);
    if (r > 0n) returned.push({ policy: e.policy, name: e.name, qty: r });
  }
  const n = S.length;
  const kk = creds.size;
  const body = 1 + 1 + headSize(n) + inBytes + 1 + headSize(M.reqCount) + M.reqBytes + 1 + M.feeField;
  const wits = kk ? 1 + 1 + headSize(kk) + VKEY_WITNESS_BYTES * kk : 1;
  const bytes0 = 1 + body + wits + 1;
  const extraHead = headSize(M.reqCount + 1) - headSize(M.reqCount);
  let fee;
  let bytes;
  let need;
  if (returned.length) {
    const tc = tokenChange(M, returned);
    bytes = bytes0 + tc.bytes + extraHead;
    fee = M.a * BigInt(bytes) + M.b;
    need = M.reqCoin + fee + tc.minCoin;
  } else {
    const feeNo = M.a * BigInt(bytes0) + M.b;
    bytes = bytes0;
    if (M.ledgerMinimum || !coinCoversOwnInput) fee = feeNo;
    else {
      const feeAda = M.a * BigInt(bytes0 + M.adaOutBytes + extraHead) + M.b;
      const left = coinIn - M.reqCoin;
      const m = left < feeAda ? left : feeAda;
      fee = m > feeNo ? m : feeNo;
    }
    need = M.reqCoin + feeNo;
  }
  const feasible = covers && coinIn >= need && bytes <= M.maxTxSize;
  return { covers, fee, bytes, bytes0, coinIn, need, feasible, returned, inBytes, keys: kk };
}
