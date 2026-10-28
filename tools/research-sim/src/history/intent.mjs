// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The intent of a wallet's spend: what the wallet had to achieve,
// independent of how its builder chose inputs.
//
// A spend event is a transaction that consumes one of the wallet's outputs at
// a key payment credential. Its intent holds:
// - requested outputs (setting `requested`, see settings.mjs): every output
//   to another stake credential and every wallet output at a script payment
//   credential or carrying a datum or a reference script, as observed; and,
//   from the wallet's other outputs, the net inflow of each native asset that
//   did not come from wallet inputs, as requested wallet outputs at their
//   minimum. A requested output whose coin is below today's minimum
//   (the ledger's rule on the output's bytes as written, at the snapshot's
//   coins per UTxO byte) is raised to it, the raise recorded with the rule of its
//   transaction's era. The wallet's other outputs are change.
// - implicit values: withdrawals, refunds, deposits, the treasury donation,
//   mints and burns, read from the transaction's own fields and checked
//   against db-sync's tx.deposit, withdrawal, ma_tx_mint and
//   tx.treasury_donation.
// - fixed parts, each as its original bytes: non-wallet inputs and held
//   wallet inputs with their resolved outputs, reference inputs, the body
//   fields other than inputs, outputs, fee, the two hashes the builder
//   recomputes (7, 11) and collateral (13, 16, 17), keyed by the Conway CDDL's
//   field numbers (IntersectMBO/cardano-ledger at
//   391db20866113f08bc6317cb5c341304365986c6, eras/conway/impl/cddl/data/
//   conway.cddl:107-128), the witness-set entries other than the wallet's own
//   payment-key witnesses, keyed by witness-set key (:760-771), the
//   redeemers with the item each points at, and the auxiliary data; the
//   script fee and the bytes of the fixed parts, computed once.
// - collateral: required when the transaction carries a redeemer or is
//   phase-2-invalid; the observed collateral for reporting.
// - the observed facts of the fidelity check.
//
// Every intent is checked before it is written: db-sync's consumed inputs
// equal the transaction's (body inputs, or collateral inputs when it is
// phase-2-invalid); its outputs equal db-sync's; the implicit values agree
// with db-sync's; value is conserved; and the transaction rebuilt from the
// intent's parts and the observed wallet parts has the transaction's exact
// body hash and size. A failure stops the run with the transaction named.

import { decodeOutput, withCoin, encodeOutput, unspentOutput } from './output.mjs';
import { parseAddress } from './address.mjs';
import { assetMap, mergeAssets, sortAssets, assetKey } from './value.mjs';
import { head } from './cbor.mjs';
import { minAdaForOutput } from './csl.mjs';
import { executionFee, refScriptFee, minUtxoRule } from './params.mjs';
import { heldReason, reencode, refScriptSize } from './wallet.mjs';
import {
  inputs,
  outputs,
  collateralInputs,
  referenceInputs,
  certificates,
  withdrawals,
  mint,
  proposals,
  voters,
  vkeyWitnesses,
  redeemers,
  fee,
  donation,
  totalCollateral,
  collateralReturn
} from './tx.mjs';
import { assetClasses, spendType } from './spendtype.mjs';
import { rebuildCheck, withoutFixedSize, IntentCheck, NOT_FIXED_BODY } from './rebuild.mjs';

export { IntentCheck, NOT_FIXED_BODY };

const hex = (b) => Buffer.from(b).toString('hex');
const sum = (xs) => xs.reduce((a, b) => a + b, 0n);

function fail(tx, msg) {
  throw new IntentCheck(`transaction ${tx.hash}: ${msg}`);
}

function sameSet(a, b) {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

// Raises an output's coin to its minimum (on the bytes as written), re-checking after the coin's own
// encoding grows. Returns { bytes, coin, raisedFrom }.
export function raiseToMinimum(bytes, coin, coinsPerUtxoByte) {
  let min = minAdaForOutput(bytes, coinsPerUtxoByte);
  if (coin >= min) return { bytes, coin, raisedFrom: null };
  let b = bytes;
  for (let k = 0; k < 8; k++) {
    b = withCoin(bytes, min);
    const again = minAdaForOutput(b, coinsPerUtxoByte);
    if (again <= min) return { bytes: b, coin: min, raisedFrom: coin };
    min = again;
  }
  throw new Error('the minimum coin did not settle');
}

// The coin of a new output at its minimum.
export function atMinimum(out, form, coinsPerUtxoByte) {
  let coin = 0n;
  for (let k = 0; k < 8; k++) {
    const b = encodeOutput({ ...out, coin }, form);
    const min = minAdaForOutput(b, coinsPerUtxoByte);
    if (min <= coin) return { bytes: b, coin };
    coin = min;
  }
  throw new Error('the minimum coin did not settle');
}

function deposits(tx, ep, row) {
  // Per certificate, the deposit or refund the ledger charges (the Conway
  // CDDL's certificate, lines 30-48 and 429-540): Shelley-era registration
  // and deregistration at the epoch's key deposit; Conway registration and
  // deregistration with their stated coin; DRep registration and
  // deregistration with theirs; proposals with their deposit. A pool
  // registration pays the pool deposit only when the pool is new, which the
  // bytes do not say; it is taken from db-sync's net deposit (tx.deposit) as
  // the remainder, which must be a whole number of pool deposits.
  let dep = 0n;
  let ref = 0n;
  let poolRegs = 0;
  const key = BigInt(ep.key_deposit);
  const coinAt = (c, i) => BigInt(c.items[i].value);
  for (const c of certificates(tx)) {
    switch (c.type) {
      case 0:
        dep += key;
        break;
      case 1:
        ref += key;
        break;
      case 3:
        poolRegs++;
        break;
      case 7:
        dep += coinAt(c, 2);
        break;
      case 8:
        ref += coinAt(c, 2);
        break;
      case 11:
      case 12:
        dep += coinAt(c, 3);
        break;
      case 13:
        dep += coinAt(c, 4);
        break;
      case 16:
        dep += coinAt(c, 2);
        break;
      case 17:
        ref += coinAt(c, 2);
        break;
      default:
        break;
    }
  }
  for (const p of proposals(tx)) dep += p.deposit;
  let poolDerived = null;
  const dbNet = row.deposit === null || row.deposit === undefined ? null : BigInt(row.deposit);
  if (poolRegs) {
    if (dbNet === null) fail(tx, 'a pool registration whose deposit cannot be read: db-sync records no net deposit');
    const rest = dbNet - (dep - ref);
    const pd = BigInt(ep.pool_deposit);
    if (rest < 0n || rest % pd !== 0n || rest / pd > BigInt(poolRegs)) fail(tx, `pool registrations: the remainder ${rest} of the net deposit is not a whole number of pool deposits`);
    dep += rest;
    poolDerived = { registrations: poolRegs, newPools: Number(rest / pd) };
  }
  return { deposits: dep, refunds: ref, dbNet, poolDerived };
}

// The ledger's order of redeemer pointers: inputs as a Set of TxIn (by
// transaction id bytes, then index), policies as Map keys (by bytes), reward
// accounts by network, then credential (a script credential before a key,
// cardano-ledger libs/cardano-ledger-core/src/Cardano/Ledger/Credential.hs:
// 98-101), then hash; voters by constructor (committee, DRep, pool,
// eras/conway/impl/src/Cardano/Ledger/Conway/Governance/Procedures.hs:351-355)
// and credential; certificates and proposals in their listed order.
function redeemerTargets(tx) {
  const ins = inputs(tx).sort((a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.index - b.index));
  const policies = [...new Set(mint(tx).map((a) => a.policy))].sort();
  const wds = withdrawals(tx).sort((a, b) => {
    const ka = Buffer.from(a.account, 'hex');
    const kb = Buffer.from(b.account, 'hex');
    const na = ka[0] & 15;
    const nb = kb[0] & 15;
    if (na !== nb) return na - nb;
    const sa = ka[0] >> 4 === 15 ? 0 : 1;
    const sb = kb[0] >> 4 === 15 ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return Buffer.compare(ka.subarray(1), kb.subarray(1));
  });
  const RANK = { 1: 0, 0: 1, 3: 2, 2: 3, 4: 4 };
  const vs = voters(tx).sort((a, b) => RANK[a.kind] - RANK[b.kind] || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const nCerts = certificates(tx).length;
  const nProps = proposals(tx).length;
  return (r) => {
    const miss = () => fail(tx, `a redeemer (tag ${r.tag}, index ${r.index}) points past its list`);
    switch (r.tag) {
      case 0:
        return ins[r.index] ? { kind: 'input', ref: ins[r.index].ref } : miss();
      case 1:
        return policies[r.index] ? { kind: 'policy', policy: policies[r.index] } : miss();
      case 2:
        return r.index < nCerts ? { kind: 'certificate', index: r.index } : miss();
      case 3:
        return wds[r.index] ? { kind: 'withdrawal', account: wds[r.index].account } : miss();
      case 4:
        return vs[r.index] ? { kind: 'voter', voter: hex(vs[r.index].raw) } : miss();
      case 5:
        return r.index < nProps ? { kind: 'proposal', index: r.index } : miss();
      default:
        return fail(tx, `unknown redeemer tag ${r.tag}`);
    }
  };
}

export function timeOf(row) {
  return { slot: Number(row.slot_no), blockTime: Number(row.time), blockIndex: Number(row.block_index), epoch: Number(row.epoch_no), block: Number(row.block_no) };
}

const recordCbor = (ctx, r) => unspentOutput(r.txHash, r.index, reencode(ctx, r).bytes).toString('hex');

// w: { saId, franken, holdStart, holdEnd, holdBefore(txId) }.
// Returns { kind: 'intent', intent } or { kind: 'self-reorganization', ... }
// or null (a phase-2-invalid spend under the 'skip' setting).
export function spendEvent(ctx, w, b) {
  const { tx, row } = b;
  const settings = ctx.settings;
  const snap = ctx.params;
  const cpb = snap.coinsPerUtxoByte;
  const ep = b.ep;
  const wal = (r) => r.stakeAddressId === w.saId;

  // What db-sync says this transaction consumed.
  const bodyIns = inputs(tx);
  const collIns = collateralInputs(tx);
  const consumedRefs = tx.isValid ? bodyIns.map((x) => x.ref) : collIns.map((x) => x.ref);
  if (!sameSet(b.consumed, consumedRefs)) fail(tx, `db-sync's consumed inputs differ from the transaction's ${tx.isValid ? 'body' : 'collateral'} inputs`);
  const consumedRows = consumedRefs.map((ref) => ctx.resolved.get(ref));
  const walletConsumed = consumedRows.filter(wal);
  if (!walletConsumed.some((r) => !r.scriptPay)) fail(tx, 'not a spend event of the wallet');
  if (b.lifeConsumed && !sameSet(b.lifeConsumed, walletConsumed.map((r) => r.ref))) fail(tx, 'the wallet outputs it consumes differ between the wallet\'s rows and the transaction\'s inputs');
  const walletKeys = new Set(walletConsumed.filter((r) => !r.scriptPay).map((r) => r.paymentCred));

  // Outputs, against db-sync's.
  const outs = outputs(tx).map((o) => ({ ...o, dec: decodeOutput(tx.buf, o.node) }));
  if (tx.isValid) {
    if (b.outputs.size !== outs.length) fail(tx, `db-sync has ${b.outputs.size} outputs, the bytes ${outs.length}`);
    for (const o of outs) {
      const r = b.outputs.get(o.index);
      if (!r || r.coin !== o.dec.coin || !sameSet(r.assets.map((a) => `${assetKey(a)}=${a.qty}`), o.dec.assets.map((a) => `${assetKey(a)}=${a.qty}`))) fail(tx, `output ${o.index} differs from db-sync's`);
      o.row = r;
    }
  }
  const time = timeOf(row);
  const observedBase = {
    tx: tx.hash,
    size: Number(row.size),
    fee: BigInt(row.fee),
    epoch: Number(row.epoch_no),
    protocolMajor: Number(ep.protocol_major),
    minFeeA: BigInt(ep.min_fee_a),
    minFeeB: BigInt(ep.min_fee_b)
  };
  const vks = vkeyWitnesses(tx);
  const walletWitnesses = vks.filter((v) => walletKeys.has(v.keyHash));

  if (!tx.isValid) return invalidSpend(ctx, w, b, { time, observedBase, collIns, walletConsumed, walletWitnesses });

  // Inputs: the wallet's selectable inputs, and fixed ones.
  const selectable = [];
  const fixedInputs = [];
  for (const x of bodyIns) {
    const r = ctx.resolved.get(x.ref);
    if (wal(r)) {
      const held = heldReason(r, w.franken);
      if (held === null) selectable.push(r);
      else fixedInputs.push({ ref: x.ref, cbor: recordCbor(ctx, r), held, ...(r.scriptPay ? {} : { walletKey: r.paymentCred }) });
    } else {
      fixedInputs.push({ ref: x.ref, cbor: recordCbor(ctx, r) });
    }
  }

  // Requested outputs.
  const protocolMajor = Number(ep.protocol_major);
  const rule = minUtxoRule(protocolMajor);
  const requested = [];
  const plain = [];
  for (const o of outs) {
    const isWallet = wal(o.row);
    const asObserved = !isWallet || (settings.requested === 'a' && (o.row.scriptPay || o.dec.datum || o.dec.scriptRef));
    if (asObserved) {
      const r = raiseToMinimum(o.raw, o.dec.coin, cpb);
      requested.push({
        cbor: hex(r.bytes),
        address: o.row.address,
        coin: r.coin,
        assets: o.dec.assets,
        datum: o.dec.datum,
        scriptRef: o.dec.scriptRef ? o.dec.scriptRef.cbor : null,
        raised: r.raisedFrom === null ? null : { from: r.raisedFrom, to: r.coin, rule, original: hex(o.raw) },
        index: o.index,
        wallet: isWallet,
        scriptPayment: parseAddress(o.dec.address).paymentKind === 'script'
      });
    } else if (isWallet) {
      plain.push(o);
    }
  }
  if (settings.requested === 'a') {
    if (settings.inflowIncludesAda) throw new Error('setting inflowIncludesAda=true is not implemented');
    const win = assetMap(walletConsumed.flatMap((r) => r.assets));
    const out = assetMap(plain.flatMap((o) => o.dec.assets));
    const left = new Map();
    for (const [k, q] of out) {
      const d = q - (win.get(k) || 0n);
      if (d > 0n) left.set(k, d);
    }
    for (const o of plain) {
      const take = [];
      for (const a of o.dec.assets) {
        const k = assetKey(a);
        const rem = left.get(k) || 0n;
        if (rem <= 0n) continue;
        const t = rem < a.qty ? rem : a.qty;
        take.push({ policy: a.policy, name: a.name, qty: t });
        left.set(k, rem - t);
      }
      if (!take.length) continue;
      const m = atMinimum({ address: o.dec.address, assets: take }, o.dec.form, cpb);
      requested.push({
        cbor: hex(m.bytes),
        address: o.row.address,
        coin: m.coin,
        assets: sortAssets(take),
        datum: null,
        scriptRef: null,
        raised: null,
        index: null,
        from: o.index,
        inflow: true,
        wallet: true,
        scriptPayment: false
      });
    }
    for (const [k, q] of left) if (q > 0n) fail(tx, `inflow of ${k} not placed`);
  }

  // Implicit values, against db-sync's.
  const wds = withdrawals(tx);
  const wSum = sum(wds.map((x) => x.coin));
  if (!sameSet(wds.map((x) => `${x.account}=${x.coin}`), b.withdrawals.map((x) => `${x.account}=${x.coin}`))) fail(tx, 'withdrawals differ from db-sync\'s');
  const dep = deposits(tx, ep, row);
  if (dep.dbNet !== null && dep.deposits - dep.refunds !== dep.dbNet) fail(tx, `deposits ${dep.deposits} less refunds ${dep.refunds} differ from db-sync's net deposit ${dep.dbNet}`);
  const don = donation(tx);
  if (don !== BigInt(row.treasury_donation || 0)) fail(tx, 'the treasury donation differs from db-sync\'s');
  const mints = mint(tx);
  if (!sameSet(mints.map((a) => `${assetKey(a)}=${a.qty}`), b.mints.map((a) => `${assetKey(a)}=${a.qty}`))) fail(tx, 'mints differ from db-sync\'s');
  const implicit = {
    withdrawals: wSum,
    refunds: dep.refunds,
    deposits: dep.deposits,
    donation: don,
    mint: mints.filter((a) => a.qty > 0n),
    burn: mints.filter((a) => a.qty < 0n).map((a) => ({ ...a, qty: -a.qty }))
  };

  // Value conservation, coin and every asset.
  const inRows = bodyIns.map((x) => ctx.resolved.get(x.ref));
  const coinIn = sum(inRows.map((r) => r.coin)) + wSum + dep.refunds;
  const coinOut = sum(outs.map((o) => o.dec.coin)) + fee(tx) + dep.deposits + don;
  if (coinIn !== coinOut) fail(tx, `coin is not conserved: ${coinIn} in, ${coinOut} out`);
  const aIn = mergeAssets(inRows.flatMap((r) => r.assets), mints);
  const aOut = mergeAssets(outs.flatMap((o) => o.dec.assets));
  if (!sameSet(aIn.map((a) => `${assetKey(a)}=${a.qty}`), aOut.map((a) => `${assetKey(a)}=${a.qty}`))) fail(tx, 'assets are not conserved');
  if (BigInt(row.fee) !== fee(tx)) fail(tx, 'the fee differs from db-sync\'s');

  // Fixed parts.
  const body = {};
  for (const k of tx.body.order) if (!NOT_FIXED_BODY.has(k)) body[k] = hex(tx.body.fields.get(k).raw);
  const otherW = vks.filter((v) => !walletKeys.has(v.keyHash));
  const witnesses = {};
  if (otherW.length) witnesses[0] = hex(Buffer.concat([head(4, otherW.length), ...otherW.map((v) => v.raw)]));
  for (const k of tx.wits.order) if (k !== 0) witnesses[k] = hex(tx.wits.fields.get(k).raw);
  const target = redeemerTargets(tx);
  const reds = redeemers(tx).map((r) => ({ tag: r.tag, target: target(r), data: r.data, exUnits: r.exUnits }));
  const refIns = referenceInputs(tx).map((x) => ({ ref: x.ref, cbor: recordCbor(ctx, ctx.resolved.get(x.ref)) }));
  const refRows = new Map();
  for (const x of [...bodyIns, ...referenceInputs(tx)]) refRows.set(x.ref, ctx.resolved.get(x.ref));
  const refSize = sum([...refRows.values()].map((r) => BigInt(refScriptSize(ctx, r))));
  const mem = sum(reds.map((r) => r.exUnits[0]));
  const steps = sum(reds.map((r) => r.exUnits[1]));
  const scriptFee = (reds.length && snap.priceMem ? executionFee(snap, mem, steps) : 0n) + refScriptFee(snap, Number(refSize));
  const hasFixed = fixedInputs.length || refIns.length || Object.keys(body).length || Object.keys(witnesses).length || reds.length || tx.aux;
  const selectableRefs = new Set(selectable.map((r) => r.ref));
  const fixedBytes = tx.size - withoutFixedSize(tx, { selectableRefs, walletWitnesses });
  const fixed = hasFixed
    ? {
        inputs: fixedInputs,
        referenceInputs: refIns,
        body,
        witnesses,
        redeemers: reds,
        auxiliaryData: tx.aux ? hex(tx.aux.raw) : null,
        scriptFee,
        fixedBytes,
        refScriptBytes: Number(refSize)
      }
    : null;

  // Collateral.
  const ret = collateralReturn(tx);
  const collateral = {
    required: reds.length > 0,
    observed:
      collIns.length || ret || totalCollateral(tx) !== null
        ? { inputs: collIns.map((x) => ({ ref: x.ref, cbor: recordCbor(ctx, ctx.resolved.get(x.ref)) })), return: ret ? hex(ret.raw) : null, total: totalCollateral(tx) }
        : null
  };

  const walletOutputs = outs.filter((o) => wal(o.row)).map((o) => ({ index: o.index, cbor: hex(o.raw) }));
  const observed = {
    ...observedBase,
    walletInputs: selectable.map((r) => ({ ref: r.ref, cbor: recordCbor(ctx, r) })),
    walletOutputs,
    walletWitnesses: walletWitnesses.map((v) => ({ keyHash: v.keyHash, cbor: hex(v.raw) }))
  };

  // Asset classes and the type.
  const net = assetMap([...outs.filter((o) => wal(o.row)).flatMap((o) => o.dec.assets), ...walletConsumed.flatMap((r) => r.assets.map((a) => ({ ...a, qty: -a.qty })))]);
  const keys = new Set([...walletConsumed.flatMap((r) => r.assets), ...outs.flatMap((o) => o.dec.assets), ...requested.flatMap((o) => o.assets)].map(assetKey));
  const classes = assetClasses(keys, { settings, holdStart: w.holdStart, holdEnd: w.holdEnd, holdBefore: settings.assetClass === 'at-spend' ? w.holdBefore(b.id) : null, net });
  const certs = certificates(tx);
  const governance = certs.length > 0 || voters(tx).length > 0 || proposals(tx).length > 0;
  const outflow = requested.filter((o) => !o.inflow);
  const sent = settings.typeAssets === 'outflow' && outflow.length ? outflow : requested;
  const type = spendType({ script: reds.length > 0, mintOrBurn: mints.length > 0, governance, sent, classes, settings });

  // The rebuild check: the parts reproduce the transaction.
  rebuildCheck(tx, { fixedInputs, selectable, requested, walletOutputs, fixed, collateral, walletWitnesses, otherWitnesses: otherW });

  // A self-reorganization: no requested output, no certificate or
  // governance action, no mint or burn, no script. Its reward withdrawals,
  // which its outputs, all the wallet's change, received, are replayed as a
  // deposit of the withdrawn ADA (`withdrawal`); its reshuffle of the wallet's
  // inputs is not replayed.
  if (!requested.length && !governance && !mints.length && !reds.length) {
    return {
      kind: 'self-reorganization',
      tx: tx.hash,
      txId: b.id,
      time,
      implicit,
      heldConsumed: fixedInputs.filter((x) => x.held).map((x) => x.ref),
      fixedInputs: fixedInputs.filter((x) => !x.held).map((x) => x.ref),
      withdrawal: implicit.withdrawals,
      valueChange: implicitValueChange(implicit, fixedInputs, ctx),
      observed
    };
  }

  return {
    kind: 'intent',
    intent: {
      id: tx.hash,
      source: 'replay',
      type,
      time,
      requested,
      implicit,
      fixed,
      collateral,
      invalid: null,
      burst: null,
      observed,
      classes,
      derived: dep.poolDerived ? { poolDeposits: dep.poolDerived } : null
    }
  };
}

// Whether a self-reorganization changed the wallet's value beyond its fee and
// its withdrawals (which are replayed apart): non-wallet inputs, refunds,
// deposits or a donation.
function implicitValueChange(implicit, fixedInputs, ctx) {
  const nonWallet = fixedInputs.filter((x) => !x.held).map((x) => ctx.resolved.get(x.ref));
  const coin = sum(nonWallet.map((r) => r.coin)) + implicit.refunds - implicit.deposits - implicit.donation;
  return { coin, assets: mergeAssets(nonWallet.flatMap((r) => r.assets)) };
}

// A phase-2-invalid transaction: its only effect is the loss of the total
// collateral (cardano-ledger, eras/babbage/impl/src/Cardano/Ledger/Babbage/
// Collateral.hs:30-39, collAdaBalance: collateral inputs less the return).
function invalidSpend(ctx, w, b, { time, observedBase, collIns, walletConsumed, walletWitnesses }) {
  if (ctx.settings.phase2Invalid === 'skip') return null;
  const { tx, row } = b;
  const ret = collateralReturn(tx);
  const nBody = outputs(tx).length;
  const collRows = collIns.map((x) => ctx.resolved.get(x.ref));
  let retCoin = 0n;
  let retAssets = [];
  if (ret) {
    const d = decodeOutput(tx.buf, ret.node);
    retCoin = d.coin;
    retAssets = d.assets;
    const r = b.outputs.get(nBody);
    if (!r || b.outputs.size !== 1 || r.coin !== d.coin) fail(tx, 'db-sync\'s collateral return differs from the bytes');
  } else if (b.outputs.size !== 0) {
    fail(tx, 'db-sync records outputs for a phase-2-invalid transaction with no collateral return');
  }
  const inCoin = sum(collRows.map((r) => r.coin));
  const forfeit = totalCollateral(tx) !== null ? totalCollateral(tx) : inCoin - retCoin;
  if (inCoin - retCoin !== forfeit) fail(tx, 'collateral inputs less the return differ from the total collateral');
  if (!sameSet(mergeAssets(collRows.flatMap((r) => r.assets)).map((a) => `${assetKey(a)}=${a.qty}`), retAssets.map((a) => `${assetKey(a)}=${a.qty}`))) fail(tx, 'the collateral return does not give back every collateral asset');
  if (BigInt(row.fee) !== forfeit) fail(tx, `db-sync's fee ${row.fee} differs from the forfeited collateral ${forfeit}`);
  const retRow = ret ? b.outputs.get(nBody) : null;
  const wal = (r) => r.stakeAddressId === w.saId;
  return {
    kind: 'intent',
    intent: {
      id: tx.hash,
      source: 'replay',
      type: 'T6',
      time,
      requested: [],
      implicit: { withdrawals: 0n, refunds: 0n, deposits: 0n, donation: 0n, mint: [], burn: [] },
      fixed: null,
      collateral: {
        required: true,
        observed: { inputs: collIns.map((x) => ({ ref: x.ref, cbor: recordCbor(ctx, ctx.resolved.get(x.ref)) })), return: ret ? hex(ret.raw) : null, total: totalCollateral(tx) }
      },
      invalid: {
        forfeit,
        heldConsumed: walletConsumed.filter((r) => heldReason(r, w.franken) !== null).map((r) => r.ref)
      },
      burst: null,
      observed: {
        ...observedBase,
        walletInputs: walletConsumed.filter((r) => heldReason(r, w.franken) === null).map((r) => ({ ref: r.ref, cbor: recordCbor(ctx, r) })),
        walletOutputs: retRow && wal(retRow) ? [{ index: nBody, cbor: hex(ret.raw) }] : [],
        walletWitnesses: walletWitnesses.map((v) => ({ keyHash: v.keyHash, cbor: hex(v.raw) }))
      },
      classes: {},
      derived: null
    }
  };
}
