// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Intents: what a wallet's spend had to achieve, independent of how its
// builder chose inputs.
//
//   { id, source ('replay' | 'battery' | 'h10'), type, time, requested,
//     implicit, fixed, collateral, invalid, burst, observed, classes,
//     derived, meta }
//
//   time       replay only: { slot, blockTime, blockIndex, epoch, block }
//   requested  [{ cbor (the output's bytes, hex), address (bech32), coin,
//              assets, datum, scriptRef, raised, wallet, scriptPayment,
//              index, from, inflow }]; `wallet` marks a requested output that
//              stays in the wallet (an inflow, an order at a script address
//              carrying the wallet's stake credential), `scriptPayment` one at
//              a script payment credential
//   implicit   { withdrawals, refunds, deposits, donation, mint, burn }
//   fixed      null, or the parts held constant across arms, each as its
//              original bytes: { inputs [{ ref, cbor, held?, walletKey? }],
//              referenceInputs [{ ref, cbor }], body { <field>: cbor },
//              witnesses { <key>: cbor }, redeemers [{ tag, target, data,
//              exUnits }], auxiliaryData, scriptFee, fixedBytes,
//              refScriptBytes }; body field and witness-set key numbers are
//              the Conway CDDL's (IntersectMBO/cardano-ledger at
//              391db20866113f08bc6317cb5c341304365986c6,
//              eras/conway/impl/cddl/data/conway.cddl:107-128, :760-771)
//   collateral { required, observed }
//   invalid    null, or for a phase-2-invalid transaction { forfeit,
//              heldConsumed }
//   burst      null or { id, parallel, index }
//   observed   replay only: { tx, size, fee, epoch, protocolMajor, minFeeA,
//              minFeeB, walletInputs, walletOutputs, walletWitnesses }
//   classes    replay only: each asset's class, 'FT' or 'NFT'
//   derived    replay only: null, or values the history reader derived from
//              db-sync rather than from the transaction's bytes (a pool
//              registration's deposit); carried, never relied on
//   meta       battery only: the spend's parameters (p, k, the draws)
//
// Coins and quantities are bigint; hashes, policies and names lowercase hex.

import { sortAssets } from '../history/value.mjs';

export const ZERO_IMPLICIT = Object.freeze({ withdrawals: 0n, refunds: 0n, deposits: 0n, donation: 0n, mint: Object.freeze([]), burn: Object.freeze([]) });

const big = (x) => (x === null || x === undefined ? null : BigInt(x));
const assetsOf = (list) => sortAssets((list || []).map((a) => ({ policy: a.policy, name: a.name, qty: BigInt(a.qty) })));

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// A battery spend's intent: requested outputs only, no implicit value, no
// fixed part, no script.
export function batteryIntent({ id, source = 'battery', type, requested, meta = {} }) {
  if (source !== 'battery' && source !== 'h10') throw new TypeError(`battery intent: source ${source}`);
  if (!requested.length) throw new TypeError('battery intent: no requested output');
  return deepFreeze({
    id,
    source,
    type,
    time: null,
    requested: requested.map((o) => ({ cbor: o.cbor, address: o.address, coin: BigInt(o.coin), assets: assetsOf(o.assets), datum: null, scriptRef: null, raised: null, wallet: false, scriptPayment: false })),
    implicit: ZERO_IMPLICIT,
    fixed: null,
    collateral: { required: false, observed: null },
    invalid: null,
    burst: null,
    observed: null,
    classes: null,
    derived: null,
    meta
  });
}

// An intent as the history reader writes it (history/intent.mjs), amounts as
// decimal strings, read into the simulator's form. Every field the reader
// writes is kept.
export function intentFromHistory(j) {
  if (j.source !== 'replay') throw new TypeError(`history intent ${j.id}: source ${j.source}`);
  const imp = j.implicit;
  const fixed = j.fixed
    ? {
        inputs: j.fixed.inputs.map((x) => ({ ...x })),
        referenceInputs: j.fixed.referenceInputs.map((x) => ({ ...x })),
        body: { ...j.fixed.body },
        witnesses: { ...j.fixed.witnesses },
        redeemers: j.fixed.redeemers.map((r) => ({ tag: r.tag, target: r.target, data: r.data, exUnits: [BigInt(r.exUnits[0]), BigInt(r.exUnits[1])] })),
        auxiliaryData: j.fixed.auxiliaryData,
        scriptFee: BigInt(j.fixed.scriptFee),
        fixedBytes: Number(j.fixed.fixedBytes),
        refScriptBytes: Number(j.fixed.refScriptBytes || 0)
      }
    : null;
  return deepFreeze({
    id: j.id,
    source: 'replay',
    type: j.type,
    time: { ...j.time },
    requested: j.requested.map((o) => ({
      cbor: o.cbor,
      address: o.address,
      coin: BigInt(o.coin),
      assets: assetsOf(o.assets),
      datum: o.datum,
      scriptRef: o.scriptRef,
      raised: o.raised ? { from: BigInt(o.raised.from), to: BigInt(o.raised.to), rule: o.raised.rule, original: o.raised.original } : null,
      wallet: !!o.wallet,
      scriptPayment: !!o.scriptPayment,
      index: o.index === undefined ? null : o.index,
      from: o.from === undefined ? null : o.from,
      inflow: !!o.inflow
    })),
    implicit: { withdrawals: BigInt(imp.withdrawals), refunds: BigInt(imp.refunds), deposits: BigInt(imp.deposits), donation: BigInt(imp.donation), mint: assetsOf(imp.mint), burn: assetsOf(imp.burn) },
    fixed,
    collateral: { required: !!j.collateral.required, observed: j.collateral.observed ? { inputs: j.collateral.observed.inputs.map((x) => ({ ...x })), return: j.collateral.observed.return, total: big(j.collateral.observed.total) } : null },
    invalid: j.invalid ? { forfeit: BigInt(j.invalid.forfeit), heldConsumed: [...j.invalid.heldConsumed] } : null,
    burst: j.burst ? { ...j.burst } : null,
    observed: {
      tx: j.observed.tx,
      size: Number(j.observed.size),
      fee: BigInt(j.observed.fee),
      epoch: Number(j.observed.epoch),
      protocolMajor: j.observed.protocolMajor === undefined ? null : Number(j.observed.protocolMajor),
      minFeeA: BigInt(j.observed.minFeeA),
      minFeeB: BigInt(j.observed.minFeeB),
      walletInputs: j.observed.walletInputs.map((x) => ({ ...x })),
      walletOutputs: j.observed.walletOutputs.map((x) => ({ ...x })),
      walletWitnesses: (j.observed.walletWitnesses || []).map((x) => ({ ...x }))
    },
    classes: j.classes ? { ...j.classes } : null,
    derived: j.derived || null,
    meta: null
  });
}
