// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Evolution SDK baseline, evo-lf: @evolution-sdk/evolution 0.8.0
// (IntersectMBO/evolution-sdk at 4aaf6c3dc75a967fae168e28f42d1306c1a22a90, the
// tag @evolution-sdk/evolution@0.8.0, packages/evolution/src/sdk/builders/),
// its transaction builder at its defaults: no coinSelection option, so
// largest-first, no unfrack option, and no codecOptions, so the library's
// default encoding. The builder is made with no wallet and no provider
// (makeTxBuilder, TransactionBuilder.ts:1850-1859) and given the change
// address, the available UTxOs and the run's protocol parameters at build time
// (BuildOptions, :475-668). It serves H-7 and H-12 only, so it takes no change
// substitution.
//
// The library, at that commit:
//   CoinSelection.ts:67-113, largestFirstSelection: every available UTxO
//   sorted by its lovelace alone, descending, with a comparator that returns 0
//   for equal lovelace (JavaScript's stable sort keeps the given order among
//   them), taken in that order until the required assets are covered; a UTxO
//   holding a requested token is reached only through that order. It throws
//   CoinSelectionError when a unit is still short.
//   phases/Selection.ts:58-86: no option resolves to largestFirstSelection;
//   the names "random-improve" and "optimal" throw "not yet implemented".
//   phases/ChangeCreation.ts:263-382: every leftover asset goes into one
//   change output; when its lovelace is under that output's minimum the
//   builder selects again, up to three attempts, then fails when the leftover
//   carries tokens. The builder's ProtocolParameters (TransactionBuilder.ts:
//   303-324) carry no value-size limit, so a change output over it is built as
//   one output and the kit's value-size check fails it; the adapter never
//   splits it.
//   internal/txBuilder.ts:1272-1480: the fee is priced with one fake vkey
//   witness per distinct payment key hash among the inputs, and sizes are the
//   serialized length (:1222-1225), validity flag included.
//
// Witnesses (setting serialization 'own'): the transaction the library returns
// with its own fake witnesses (TransactionResult toTransactionWithFakeWitnesses),
// one 32-byte key and 64-byte signature per distinct payment key, as the
// library serializes them.
//
// Errors to failure classes (setting unclassified 'other' for the rest):
//   TransactionBuilderError caused by CoinSelectionError       balance
//   "Cannot balance transaction: Native assets present in leftover but
//   insufficient lovelace" (ChangeCreation.ts:309-327)          change-minimum
//   "Cannot create valid change: Insufficient funds" (the ADA-only leftover
//   under its minimum with no fallback, :329-348)               change-minimum
//   "Transaction size (...) exceeds protocol maximum" (internal/build.ts:
//   123-131)                                                    tx-size
//   "No suitable UTxOs available for collateral", "Insufficient collateral
//   available", "Collateral return (...) is below minimum UTxO requirement"
//   (phases/Collateral.ts:157-165, :203-209, :274-282): the library's own
//   collateral choice fails                                     collateral
//
// The replay path: every intent the history reader writes (source 'replay')
// is built with the run's parameters as the library's full protocol
// parameters (BuildOptions.fullProtocolParameters, TransactionBuilder.ts:
// 488-501; internal/resolve.ts:18-33 derives the fee parameters from them,
// the reference-script price included, which otherwise defaults to 44,
// phases/FeeCalculation.ts:91), and its fixed parts through the library's
// own operations (TransactionBuilder.ts:942-1610), as follows:
//   requested outputs   payToAddress with the output's address, value, datum
//                       and script reference read from its bytes, coins as
//                       written (operations/Pay.ts; autoMinUtxo off)
//   fixed inputs        collectFrom, one input per call so that each script
//                       input carries its own redeemer and, when it holds a
//                       datum hash, its datum (operations/Collect.ts:39-147;
//                       spendDatums below); never offered as available UTxOs
//   reference inputs    readFrom (operations/ReadFrom.ts:33-75)
//   mint and burn       mintAssets per policy, a burn as a negative quantity,
//                       with the policy's redeemer (operations/Mint.ts)
//   certificates        the operation that writes the same certificate:
//                       registerStakeLegacy, deregisterStakeLegacy,
//                       delegateToPool, registerPool, retirePool,
//                       registerStake, deregisterStake, delegateToDRep,
//                       delegateToPoolAndDRep, registerAndDelegateTo,
//                       authCommitteeHot, resignCommitteeCold, registerDRep,
//                       deregisterDRep, updateDRep (operations/Stake.ts,
//                       Pool.ts, Governance.ts), in the intent's order, with
//                       each certificate's redeemer. The library sets the
//                       deposit and refund of the Conway certificates from
//                       the parameters (keyDeposit, drepDeposit), and counts
//                       none for the legacy registration and deregistration
//                       (phases/Balance.ts:40-93)
//   withdrawals         withdraw per reward account (operations/Stake.ts:
//                       709-780), whose network is the chain's
//   votes, proposals    vote per voter (operations/Vote.ts), propose per
//                       proposal, its deposit govActionDeposit (operations/
//                       Propose.ts:38-123)
//   required signers    addSigner (operations/AddSigner.ts)
//   validity            setValidity with each slot as the chain's Unix time
//                       (Time.ts:35-64 converts back exactly)
//   auxiliary data      attachMetadata per label (operations/
//                       AttachMetadata.ts), which writes Conway auxiliary
//                       data in the library's encoding
//   scripts             attachScript for each native and Plutus script of
//                       the witness set, before the inputs are collected so
//                       that a native-script input needs no redeemer
//                       (Collect.ts:63-84)
//   redeemers           with their operations; the execution units through
//                       BuildOptions.evaluator, returning the intent's
//                       observed units for each redeemer at the index the
//                       library gives it (phases/Evaluation.ts:264-778)
//   witness-set datums  the datum of each fixed input that holds a datum hash
//                       at a Plutus script address, through collectFrom's
//                       datums with its observed bytes, which the library
//                       writes in the witness set and counts in its fee
//                       (internal/txBuilder.ts:351-523, :1003-1008,
//                       :1474-1475; spendDatums below)
// The transaction's vkey witnesses are the library's fake witnesses for the
// wallet's payment keys (its inputs, its held fixed inputs and required
// signers among its keys) and the intent's other vkey witnesses as observed:
// the signatures the wallet and the other parties add to the library's
// transaction. When the transaction then carries more vkey witnesses than the
// library priced, library.unpriced names the observed ones.
//
// A part the library's builder can neither write nor price (unpricedParts) is
// written on the transaction it built, through the library's own types, as
// every library's replay does: the treasury fields (TransactionBody.ts; no
// operation sets them, internal/txBuilder.ts:1159-1177), auxiliary data
// carrying scripts, which attachMetadata cannot write, the witness-set datums
// no spent input needs (an output's or a reference input's, which collectFrom
// refuses, internal/txBuilder.ts:409-425, and no operation takes), written
// with every observed datum and the script-data hash from the library's
// Redeemers.toScriptDataHash, bootstrap witnesses (:1180-1189), and the
// certificates or withdrawals when one is a script stake credential's with no
// redeemer, which the stake operations refuse (operations/Stake.ts:43-50,
// :119-126, :717-724). The library's fee does not count such a part, and a
// value it did not balance (a donation, a deposit) stays unbalanced; the kit's
// checks say which (library.unpriced names the parts). A replayed intent
// carries no network id and no auxiliary data without metadata and scripts,
// which no operation writes either: the engine leaves them out of every
// method's intent (kit/replay.mjs withoutLeftovers), and the adapter, given one
// directly, finds it not replayable. Otherwise only what the library's types
// cannot hold makes the intent not replayable (evoRefusal): body field 6, as
// for every adapter (kit/replay.mjs replayRefusal), a Byron address on a fixed
// or reference input, and the pre-Conway genesis-delegation and MIR
// certificates.
//
// Collateral: the library chooses its own (phases/Collateral.ts:116-318): the
// UTxOs among availableUtxos without a reference script, pure ADA first and
// then by lovelace, largest first (:57-69, :150-155), taken until they reach
// setCollateral (5 ADA by default, :131; internal/state.ts:11-15), at most
// three (:33, :183-200), with that fixed amount as the total collateral
// (:220) and the rest returned to the change address (:290-295); a selected
// input may serve (:147-149). No operation or build option names a
// collateral UTxO (BuildOptions, TransactionBuilder.ts:475-668), so the
// library cannot be given the UTxO the engine would set aside. Its script
// spends take the library's own choice (ownCollateral; methods/contract.mjs
// choosesOwnCollateral): the engine sets nothing aside, the library selects
// and chooses its collateral from the whole pool, the engine records that
// collateral as library-chosen, and a collateral the kit's check refuses is
// class 'collateral', charged to the library. The ledger allows a collateral
// input that is also a spent input: the Babbage UTXO rule, which Conway's
// runs (eras/conway/impl/src/Cardano/Ledger/Conway/Rules/Utxo.hs:253), checks
// the collateral UTxOs alone (feesOK and validateTotalCollateral,
// eras/babbage/impl/src/Cardano/Ledger/Babbage/Rules/Utxo.hs:195-212,
// :241-256), requires only that every input, collateral and reference input
// be in the UTxO (:388-390), and keeps only the spent and reference inputs
// disjoint (disjointRefInputs, :215-229, :371).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as E from '@evolution-sdk/evolution';
import { makeTxBuilder, voterToKey } from '@evolution-sdk/evolution/sdk/builders/TransactionBuilder';
import * as CostModel from '@evolution-sdk/evolution/CostModel';
import { CLASSES } from '../kit/check.mjs';
import { unspentOutputParts, inspectTx } from '../kit/inspect.mjs';
import { replayRefusal, emptyAuxiliaryData, listItems, requiredSigners, replayWitnessKeys, redeemerKey, targetKey, intentScripts } from '../kit/replay.mjs';
import { blake2b256 } from '../history/blake2b.mjs';
import { minFee } from '../kit/fee.mjs';
import { need } from '../kit/params.mjs';
import { decode, raw, head, encUint, asUint } from '../history/cbor.mjs';
import { NOT_REPLAYABLE } from './contract.mjs';
import { inputOrder, recordsOf, keyCount, refuseUncovered, REPLAY_COVERAGE, errorText, txRecord } from './library.mjs';

export const EVO_VERSION = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('@evolution-sdk/evolution/package.json'), 'utf8')).version;
if (EVO_VERSION !== '0.8.0') throw new Error(`@evolution-sdk/evolution ${EVO_VERSION} is installed; the baseline is 0.8.0`);

export function classOfEvoError(e) {
  const m = errorText(e);
  if (e && e.cause && e.cause._tag === 'CoinSelectionError') return CLASSES.balance;
  if (/^Cannot balance transaction: Native assets present in leftover but insufficient lovelace/.test(m)) return CLASSES.changeMinimum;
  if (/^Cannot create valid change: Insufficient funds/.test(m)) return CLASSES.changeMinimum;
  if (/^Transaction size \(\d+ bytes\) exceeds protocol maximum/.test(m)) return CLASSES.txSize;
  if (/^(No suitable UTxOs available for collateral|Insufficient collateral available|Collateral return \(\d+ lovelace\) is below minimum UTxO requirement)/.test(m)) return CLASSES.collateral;
  return CLASSES.other;
}

// The library's chain descriptor for the run's network; the synthetic shapes
// carry mainnet addresses.
const chainOf = (network) => (network === 'preprod' ? E.preprod : E.mainnet);

// An output's script reference (ScriptRef, the tag-24 bytes) as the Script
// that UTxO.scriptRef and payToAddress take (UTxO.ts:30, operations/
// Operations.ts:45-53; internal/txBuilder.ts:248-259 wraps it again).
const scriptOf = (ref) => (ref ? E.Script.fromCBORHex(Buffer.from(ref.bytes).toString('hex')) : undefined);

// A UTxO in the library's type from its TransactionUnspentOutput bytes: a
// state's UTxO, or a fixed or reference input of an intent.
const UTXOS = new WeakMap();
export function evoUtxo(u) {
  let x = UTXOS.get(u);
  if (!x) {
    const p = unspentOutputParts(u.cbor);
    const out = E.TxOut.fromCBORHex(p.outputRaw.toString('hex'));
    x = new E.UTxO.UTxO({ transactionId: E.TransactionHash.fromHex(p.txid), index: BigInt(p.index), address: out.address, assets: out.assets, datumOption: out.datumOption, scriptRef: scriptOf(out.scriptRef) });
    UTXOS.set(u, x);
  }
  return x;
}

// The fee parameters the builder takes (the deprecated protocolParameters
// form, which needs no cost models; the battery path builds no script).
export const evoProtocolParameters = (params) => ({
  minFeeCoefficient: params.minFeeA,
  minFeeConstant: params.minFeeB,
  coinsPerUtxoByte: params.coinsPerUtxoByte,
  maxTxSize: params.maxTxSize
});

const ratio = (r) => (r === null ? undefined : Number(r[0]) / Number(r[1]));
const orUndefined = (x) => (x === null ? undefined : x);

// The run's parameters as the library's full protocol parameters
// (provider/Provider.ts:24-45), for the replay path. The simulator holds no
// cost models, so each language's is empty; the library uses them only for
// the script-data hash and the evaluation context (internal/txBuilder.ts:
// 1070-1096, phases/Evaluation.ts:44-62), and the evaluator here reads none. A
// parameter the run does not state is left out rather than filled in.
export const evoFullProtocolParameters = (params) => ({
  minFeeA: Number(params.minFeeA),
  minFeeB: Number(params.minFeeB),
  maxTxSize: params.maxTxSize,
  maxValSize: params.maxValSize,
  keyDeposit: orUndefined(params.keyDeposit),
  poolDeposit: orUndefined(params.poolDeposit),
  drepDeposit: orUndefined(params.drepDeposit),
  govActionDeposit: orUndefined(params.govActionDeposit),
  priceMem: ratio(params.priceMem),
  priceStep: ratio(params.priceStep),
  maxTxExMem: undefined,
  maxTxExSteps: undefined,
  coinsPerUtxoByte: params.coinsPerUtxoByte,
  collateralPercentage: params.collateralPercent,
  maxCollateralInputs: params.maxCollateralInputs,
  minFeeRefScriptCostPerByte: ratio(params.minFeeRefScriptCostPerByte),
  costModels: { PlutusV1: {}, PlutusV2: {}, PlutusV3: {} }
});

const EMPTY_COST_MODELS = new CostModel.CostModels({ PlutusV1: new CostModel.CostModel({ costs: [] }), PlutusV2: new CostModel.CostModel({ costs: [] }), PlutusV3: new CostModel.CostModel({ costs: [] }) });
const refOfInput = (i) => `${E.TransactionHash.toHex(i.transactionId)}#${i.index}`;
const hexOf = (b) => Buffer.from(b).toString('hex');

// The intent's witness-set entries with the given keys, decoded by the
// library, or null.
function witnessesOf(fixed, keys) {
  const entries = keys.filter((k) => fixed.witnesses[k] !== undefined).map((k) => [encUint(k), Buffer.from(fixed.witnesses[k], 'hex')]);
  if (!entries.length) return null;
  return E.TransactionWitnessSet.fromCBORHex(Buffer.concat([head(5, entries.length), ...entries.flat()]).toString('hex'));
}

// The intent's certificates' first fields (their kinds), and the library's
// reading of each.
const certificateKinds = (fixed) => (fixed.body[4] === undefined ? [] : listItems(fixed.body[4]).map((b) => Number(asUint(decode(b).items[0], 'certificate kind'))));

// 'a certificate' or 'a withdrawal' when the intent has one for a script stake
// credential with no redeemer (a legacy registration needs none on the ledger,
// and a native script witnesses one without a redeemer), or null.
const STAKE_CERTIFICATES = new Set([0, 1, 2, 7, 8, 9, 10, 11, 12, 13]);
function scriptStakeWithoutRedeemer(fixed) {
  const has = (tag, pred) => fixed.redeemers.some((r) => r.tag === tag && pred(r.target));
  if (fixed.body[4] !== undefined) {
    const items = listItems(fixed.body[4]);
    for (let i = 0; i < items.length; i++) {
      const n = decode(items[i]);
      if (!STAKE_CERTIFICATES.has(Number(asUint(n.items[0], 'certificate kind')))) continue;
      if (Number(asUint(n.items[1].items[0], 'credential kind')) === 1 && !has(2, (t) => t.index === i)) return 'a certificate';
    }
  }
  return scriptWithdrawalWithoutRedeemer(fixed);
}
function scriptWithdrawalWithoutRedeemer(fixed) {
  const has = (tag, pred) => fixed.redeemers.some((r) => r.tag === tag && pred(r.target));
  if (fixed.body[5] !== undefined) {
    const b = Buffer.from(fixed.body[5], 'hex');
    for (const [k] of decode(b).entries) {
      const account = Buffer.from(raw(b, k)).subarray(-29);
      if (account[0] >> 4 === 15 && !has(3, (t) => t.account === account.toString('hex'))) return 'a withdrawal';
    }
  }
  return null;
}

// The intent's auxiliary data's metadata, in order, or a reason the library
// cannot write it.
function metadataOf(fixed) {
  const aux = E.AuxiliaryData.fromCBORHex(fixed.auxiliaryData);
  const scripts = ['nativeScripts', 'plutusV1Scripts', 'plutusV2Scripts', 'plutusV3Scripts'].some((k) => aux[k] && aux[k].length);
  if (scripts) return { refusal: 'auxiliary data carrying scripts: attachMetadata writes metadata only (operations/AttachMetadata.ts)' };
  const entries = aux.metadata ? [...aux.metadata.entries()] : [];
  if (!entries.length) return { refusal: 'auxiliary data without metadata: no operation writes it (operations/AttachMetadata.ts)' };
  return { entries };
}

// Why the library cannot write the intent's fixed parts, or null when it can.
export function evoRefusal(intent) {
  const kit = replayRefusal(intent);
  if (kit) return kit;
  const f = intent.fixed;
  if (!f) return null;
  for (const x of [...f.inputs, ...f.referenceInputs]) if (unspentOutputParts(x.cbor).addr.type === 8) return `a Byron address on ${x.ref}: the library reads a payment credential from every input (internal/txBuilder.ts:1255-1261)`;
  if (certificateKinds(f).some((k) => k === 5 || k === 6)) return 'a genesis-delegation or MIR certificate: the library\'s certificate type has none';
  if (f.body[15] !== undefined) return 'body field 15 (network id): no operation writes it, and a replayed intent carries none';
  if (f.auxiliaryData && emptyAuxiliaryData(f.auxiliaryData)) return 'auxiliary data without metadata or scripts: no operation writes it, and a replayed intent carries none';
  return null;
}

// The intent's witness-set datums (field 4), each decoded by the library with
// its observed bytes recorded (OriginalBytes.record), as the library's own
// providers return a datum (provider/internal/KoiosEffect.ts:256), so that the
// library writes and hashes those bytes, the ones its datum hash covers
// (internal/txBuilder.ts:351-361); and the ones the library takes through
// collectFrom's datums (byInput): the datum of each fixed input that holds a
// datum hash at a script address whose script is not a native script, once
// per hash, which is the library's own test of the datums a spend needs
// (requiredDatums, :369-381; a script it cannot classify counts as Plutus).
// `rest` counts the datums no spent input needs (an output's or a reference
// input's): the library refuses them in collectFrom (:409-425), so they are
// written after the build, unpriced. A datum whose input is missing from the
// witness set fails the library's build (:394-407).
const DATUMS = new WeakMap();
export function spendDatums(fixed) {
  if (DATUMS.has(fixed)) return DATUMS.get(fixed);
  const out = { all: [], byInput: new Map(), rest: 0 };
  if (fixed.witnesses[4] !== undefined) {
    const items = listItems(fixed.witnesses[4]);
    const byHash = new Map();
    out.all = items.map((bytes) => {
      const d = E.Data.fromCBORHex(hexOf(bytes));
      if (typeof d !== 'bigint') E.OriginalBytes.record(d, bytes);
      const h = hexOf(blake2b256(bytes));
      if (!byHash.has(h)) byHash.set(h, d);
      return d;
    });
    const scripts = intentScripts(fixed);
    const taken = new Set();
    for (const x of fixed.inputs) {
      const p = unspentOutputParts(x.cbor);
      if (!p.datum || p.datum.kind !== 'hash' || p.addr.paymentKind !== 'script') continue;
      const script = scripts.get(p.addr.payment);
      if (script && script.lang === 0) continue;
      if (taken.has(p.datum.hash) || !byHash.has(p.datum.hash)) continue;
      taken.add(p.datum.hash);
      out.byInput.set(x.ref, [byHash.get(p.datum.hash)]);
    }
    out.rest = items.filter((bytes) => !taken.has(hexOf(blake2b256(bytes)))).length;
  }
  DATUMS.set(fixed, out);
  return out;
}

// The parts of the intent the library's builder can neither write nor price,
// which go on the transaction it built through its own types (unpriced): the
// treasury fields, which its transaction body carries (TransactionBody.ts) but
// no operation sets (internal/txBuilder.ts:1159-1177); auxiliary data carrying
// scripts, which attachMetadata cannot write; the witness-set datums no spent
// input needs (spendDatums) and bootstrap witnesses (:1180-1189); and the
// certificates or withdrawals when one of them is a script stake credential's
// with no redeemer, which the stake operations refuse (operations/Stake.ts:
// 43-50, :119-126, :717-724).
export function unpricedParts(intent) {
  const f = intent.fixed;
  if (!f) return [];
  const out = [];
  if (f.body[21] !== undefined) out.push('current treasury value');
  if (f.body[22] !== undefined) out.push('treasury donation');
  if (f.auxiliaryData && metadataOf(f).refusal) out.push('auxiliary data');
  if (f.witnesses[4] !== undefined && spendDatums(f).rest > 0) out.push('witness-set datums');
  if (f.witnesses[2] !== undefined) out.push('bootstrap witnesses');
  const unredeemed = scriptStakeWithoutRedeemer(f);
  if (unredeemed === 'a certificate') out.push('certificates');
  if (unredeemed === 'a withdrawal') out.push('withdrawals');
  return out;
}

// The intent's redeemer data for one target, found by the target's key
// (kit/replay.mjs redeemerKey): the library's objects give an input's
// reference, a policy, a certificate's or proposal's place and a withdrawal's
// reward account (RewardAccount.toHex) in full. A voter they give only as its
// key hash (voterToKey), so a voter's redeemer is the one whose recorded voter
// ends with that hash.
export function redeemerFinder(fixed) {
  const reds = fixed ? fixed.redeemers : [];
  const byKey = new Map();
  for (const r of reds) {
    const key = redeemerKey(r);
    if (!byKey.has(key)) byKey.set(key, r);
  }
  const arg = (r) => (r ? { redeemer: E.Data.fromCBORHex(r.data) } : {});
  const at = (target) => arg(byKey.get(targetKey(target)) || null);
  return {
    input: (ref) => at({ kind: 'input', ref }),
    policy: (policy) => at({ kind: 'policy', policy }),
    certificate: (index) => at({ kind: 'certificate', index }),
    withdrawal: (account) => at({ kind: 'withdrawal', account }),
    voter: (hash) => arg(reds.find((r) => r.tag === 4 && r.target.voter.endsWith(hash)) || null),
    proposal: (index) => at({ kind: 'proposal', index })
  };
}

// The certificate's operation on builder b.
function withCertificate(b, c, red, params) {
  const cred = { stakeCredential: c.stakeCredential, ...red };
  // A deposit or refund the library takes from the parameters, which the run
  // must state; where it differs from the certificate's, the transaction
  // carries the library's (evoImplicit).
  const stated = (field) => need(params, field);
  switch (c._tag) {
    case 'StakeRegistration':
      return b.registerStakeLegacy(cred);
    case 'StakeDeregistration':
      return b.deregisterStakeLegacy(cred);
    case 'StakeDelegation':
      return b.delegateToPool({ ...cred, poolKeyHash: c.poolKeyHash });
    case 'PoolRegistration':
      need(params, 'poolDeposit');
      return b.registerPool({ poolParams: c.poolParams });
    case 'PoolRetirement':
      return b.retirePool({ poolKeyHash: c.poolKeyHash, epoch: c.epoch });
    case 'RegCert':
      stated('keyDeposit');
      return b.registerStake(cred);
    case 'UnregCert':
      stated('keyDeposit');
      return b.deregisterStake(cred);
    case 'VoteDelegCert':
      return b.delegateToDRep({ ...cred, drep: c.drep });
    case 'StakeVoteDelegCert':
      return b.delegateToPoolAndDRep({ ...cred, poolKeyHash: c.poolKeyHash, drep: c.drep });
    case 'StakeRegDelegCert':
      stated('keyDeposit');
      return b.registerAndDelegateTo({ ...cred, poolKeyHash: c.poolKeyHash });
    case 'VoteRegDelegCert':
      stated('keyDeposit');
      return b.registerAndDelegateTo({ ...cred, drep: c.drep });
    case 'StakeVoteRegDelegCert':
      stated('keyDeposit');
      return b.registerAndDelegateTo({ ...cred, poolKeyHash: c.poolKeyHash, drep: c.drep });
    case 'AuthCommitteeHotCert':
      return b.authCommitteeHot({ coldCredential: c.committeeColdCredential, hotCredential: c.committeeHotCredential, ...red });
    case 'ResignCommitteeColdCert':
      return b.resignCommitteeCold({ coldCredential: c.committeeColdCredential, anchor: c.anchor ?? undefined, ...red });
    case 'RegDrepCert':
      stated('drepDeposit');
      return b.registerDRep({ drepCredential: c.drepCredential, anchor: c.anchor ?? undefined, ...red });
    case 'UnregDrepCert':
      stated('drepDeposit');
      return b.deregisterDRep({ drepCredential: c.drepCredential, ...red });
    case 'UpdateDrepCert':
      return b.updateDRep({ drepCredential: c.drepCredential, anchor: c.anchor ?? undefined, ...red });
    default:
      throw new Error(`certificate ${c._tag}: no operation`);
  }
}

// The deposits and refunds the library counts for the intent's certificates
// and proposals (phases/Balance.ts:40-127): the run's keyDeposit, drepDeposit,
// poolDeposit and govActionDeposit for the Conway registrations,
// deregistrations, pool registrations and proposals, and nothing for the legacy
// registration and deregistration. The intent's own values can differ.
export function evoImplicit(intent, params) {
  const f = intent.fixed;
  let deposits = 0n;
  let refunds = 0n;
  if (!f) return { deposits, refunds };
  const p = (k) => params[k] ?? 0n;
  for (const k of certificateKinds(f)) {
    if ([7, 11, 12, 13].includes(k)) deposits += p('keyDeposit');
    else if (k === 16) deposits += p('drepDeposit');
    else if (k === 3) deposits += p('poolDeposit');
    else if (k === 8) refunds += p('keyDeposit');
    else if (k === 17) refunds += p('drepDeposit');
  }
  if (f.body[20] !== undefined) deposits += BigInt(listItems(f.body[20]).length) * p('govActionDeposit');
  return { deposits, refunds };
}

// The intent's fixed parts as the library's operations on builder b.
function withFixedParts(b, intent, params, chain, unpriced) {
  const f = intent.fixed;
  const red = redeemerFinder(f);
  const ws = witnessesOf(f, [1, 3, 6, 7]);
  if (ws) for (const k of ['nativeScripts', 'plutusV1Scripts', 'plutusV2Scripts', 'plutusV3Scripts']) for (const script of ws[k] || []) b = b.attachScript({ script });
  if (f.referenceInputs.length) b = b.readFrom({ referenceInputs: f.referenceInputs.map(evoUtxo) });
  const datums = spendDatums(f).byInput;
  for (const x of f.inputs) b = b.collectFrom({ inputs: [evoUtxo(x)], ...red.input(x.ref), ...(datums.has(x.ref) ? { datums: datums.get(x.ref) } : {}) });
  if (f.body[9] !== undefined) {
    const byPolicy = new Map();
    const add = (a, q) => {
      if (!byPolicy.has(a.policy)) byPolicy.set(a.policy, {});
      byPolicy.get(a.policy)[`${a.policy}${a.name}`] = q;
    };
    for (const a of intent.implicit.mint) add(a, a.qty);
    for (const a of intent.implicit.burn) add(a, -a.qty);
    for (const [policy, record] of byPolicy) b = b.mintAssets({ assets: E.Assets.fromRecord(record), ...red.policy(policy) });
  }
  if (f.body[4] !== undefined && !unpriced.includes('certificates')) {
    listItems(f.body[4]).forEach((bytes, i) => {
      b = withCertificate(b, E.Certificate.fromCBORHex(hexOf(bytes)), red.certificate(i), params);
    });
  }
  if (f.body[5] !== undefined && !unpriced.includes('certificates') && !unpriced.includes('withdrawals')) {
    for (const [account, amount] of E.Withdrawals.fromCBORHex(f.body[5]).withdrawals) {
      if (account.networkId !== chain.id) throw new Error(`a withdrawal from network ${account.networkId} on chain ${chain.id}`);
      b = b.withdraw({ stakeCredential: account.stakeCredential, amount, ...red.withdrawal(E.RewardAccount.toHex(account)) });
    }
  }
  if (f.body[19] !== undefined) {
    for (const [voter, votes] of E.VotingProcedures.fromCBORHex(f.body[19]).procedures) {
      const key = voterToKey(voter);
      b = b.vote({ votingProcedures: new E.VotingProcedures.VotingProcedures({ procedures: new Map([[voter, votes]]) }), ...red.voter(key.slice(key.indexOf(':') + 1)) });
    }
  }
  if (f.body[20] !== undefined) {
    listItems(f.body[20]).map((x) => E.ProposalProcedure.fromCBORHex(hexOf(x))).forEach((p, i) => {
      need(params, 'govActionDeposit');
      b = b.propose({ governanceAction: p.governanceAction, rewardAccount: p.rewardAccount, anchor: p.anchor, ...red.proposal(i) });
    });
  }
  if (f.body[14] !== undefined) for (const h of requiredSigners(f)) b = b.addSigner({ keyHash: E.KeyHash.fromHex(h) });
  if (f.body[3] !== undefined || f.body[8] !== undefined) {
    const time = (k) => (f.body[k] === undefined ? undefined : E.Time.slotToUnixTime(asUint(decode(Buffer.from(f.body[k], 'hex')), 'slot'), chain.slotConfig));
    b = b.setValidity({ from: time(8), to: time(3) });
  }
  if (f.auxiliaryData && !unpriced.includes('auxiliary data')) for (const [label, metadata] of metadataOf(f).entries) b = b.attachMetadata({ label, metadata });
  return b;
}

// The evaluator (BuildOptions.evaluator, TransactionBuilder.ts:202-214): the
// intent's observed execution units for each of its redeemers, at the index
// the library's transaction gives the redeemer's target (the sorted inputs,
// the sorted mint policies, the certificates in order, the withdrawals sorted
// by credential and the voters by key as the library sorts them,
// internal/txBuilder.ts:782-852, and the proposals in order).
export function observedEvaluator(intent) {
  const reds = intent.fixed ? intent.fixed.redeemers : [];
  const TAGS = ['spend', 'mint', 'cert', 'reward', 'vote', 'propose'];
  return {
    evaluate: (tx) => {
      const ins = tx.body.inputs.map(refOfInput);
      const policies = tx.body.mint ? [...tx.body.mint.map.keys()].map((p) => E.PolicyId.toHex(p)).sort() : [];
      const wds = tx.body.withdrawals ? [...tx.body.withdrawals.withdrawals.keys()].map((a) => hexOf(a.stakeCredential.hash)).sort((x, y) => x.localeCompare(y)) : [];
      const voters = tx.body.votingProcedures ? [...tx.body.votingProcedures.procedures.keys()].map(voterToKey).sort() : [];
      const out = [];
      for (const r of reds) {
        const t = r.target;
        const index = [
          () => ins.indexOf(t.ref),
          () => policies.indexOf(t.policy),
          () => t.index,
          () => wds.indexOf(t.account.slice(2)),
          () => voters.findIndex((k) => t.voter.endsWith(k.slice(k.indexOf(':') + 1))),
          () => t.index
        ][r.tag]();
        if (index < 0) return E.Effect.fail(new Error(`the library's transaction has no target for the redeemer ${JSON.stringify(t)}`));
        out.push({ redeemer_tag: TAGS[r.tag], redeemer_index: index, ex_units: new E.Redeemer.ExUnits({ mem: r.exUnits[0], steps: r.exUnits[1] }) });
      }
      return E.Effect.succeed(out);
    }
  };
}

// The wallet's payment keys a replayed transaction needs a synthetic witness
// for (kit/replay.mjs replayWitnessKeys): the collateral is the library's own
// collateral inputs, read from its transaction, and the wallet's credentials
// those of the pool, which holds that collateral.
function walletKeysOf(state, intent, inputs, collateralRefs) {
  const f = intent.fixed;
  const collateral = collateralRefs.map((r) => state.utxos.get(r)).filter(Boolean);
  return replayWitnessKeys(f, { inputs, collateral, walletCreds: f ? new Set([...state.utxos.values()].map((u) => u.cred)) : null });
}

// Builds the intent with the library: the battery path for a battery spend,
// the replay path for a replayed intent. It refuses nothing: the method below
// refuses what its coverage leaves out first.
export async function buildEvo(state, intent, params, opts, { name = 'evo-lf', unfrack = null } = {}) {
  if (opts.changePolicy !== 'default') return { ok: false, class: CLASSES.other, detail: 'the Evolution SDK baseline takes no change substitution' };
  if (opts.collateral) throw new Error(`${name}: the library chooses its own collateral and cannot be given a UTxO set aside`);
  const replay = intent.source === 'replay';
  if (replay) {
    const refusal = evoRefusal(intent);
    if (refusal) return { ok: false, class: NOT_REPLAYABLE, detail: refusal };
  }
  const chain = chainOf(state.network);
  const fixedRefs = new Set(replay && intent.fixed ? intent.fixed.inputs.map((x) => x.ref) : []);
  const unpriced = replay ? unpricedParts(intent) : [];
  let b = makeTxBuilder({ chain });
  let options;
  try {
    for (const o of intent.requested) {
      const out = E.TxOut.fromCBORHex(o.cbor);
      const extra = replay ? { ...(out.datumOption ? { datum: out.datumOption } : {}), ...(out.scriptRef ? { script: scriptOf(out.scriptRef) } : {}) } : {};
      b = b.payToAddress({ address: out.address, assets: out.assets, ...extra });
    }
    if (replay && intent.fixed) b = withFixedParts(b, intent, params, chain, unpriced);
    const available = inputOrder(state).filter((u) => !fixedRefs.has(u.ref)).map(evoUtxo);
    options = { changeAddress: E.Address.fromBech32(state.changeAddress), availableUtxos: available };
    if (replay) {
      if (params.minFeeRefScriptCostPerByte === null) {
        const carried = [...available, ...(intent.fixed ? [...intent.fixed.inputs, ...intent.fixed.referenceInputs].map(evoUtxo) : [])].some((u) => u.scriptRef);
        if (carried) need(params, 'minFeeRefScriptCostPerByte');
      }
      options.fullProtocolParameters = evoFullProtocolParameters(params);
      options.evaluator = observedEvaluator(intent);
    } else {
      options.protocolParameters = evoProtocolParameters(params);
    }
  } catch (e) {
    return { ok: false, class: CLASSES.other, detail: `replay parts: ${errorText(e)}` };
  }
  if (unfrack) options.unfrack = unfrack;
  let r;
  try {
    r = await b.buildEither(options);
  } catch (e) {
    return { ok: false, class: classOfEvoError(e), detail: `build: ${errorText(e)}` };
  }
  if (r._tag === 'Left') {
    const e = r.left;
    const cause = e && e.cause && e.cause.message ? ` (${e.cause.message})` : '';
    return { ok: false, class: classOfEvoError(e), detail: `build: ${errorText(e).split('\n')[0]}${cause}` };
  }
  if (!replay) {
    const tx = await r.right.toTransactionWithFakeWitnesses();
    const refs = tx.body.inputs.map(refOfInput);
    const inputs = recordsOf(state, refs);
    const vkeys = tx.witnessSet.vkeyWitnesses ? tx.witnessSet.vkeyWitnesses.length : 0;
    const k = keyCount(inputs);
    if (vkeys !== k) throw new Error(`${name}: the library's fake witness set has ${vkeys} vkey witnesses for ${k} payment keys`);
    const bytes = E.Transaction.toCBORHex(tx);
    return { ok: true, kind: 'single', txs: [txRecord(bytes, refs, tx.body.fee, inspectTx(bytes).size, k)] };
  }
  // The replayed transaction: the library's body, scripts and redeemers, and
  // the vkey witnesses of the wallet's keys and of the other signers.
  const tx = await r.right.toTransaction();
  const fake = await r.right.toTransactionWithFakeWitnesses();
  const refs = tx.body.inputs.map(refOfInput);
  for (const x of fixedRefs) if (!refs.includes(x)) return { ok: false, class: CLASSES.other, detail: `the library left out the fixed input ${x}` };
  const walletRefs = refs.filter((x) => !fixedRefs.has(x));
  const inputs = recordsOf(state, walletRefs);
  const collateralRefs = (tx.body.collateralInputs || []).map(refOfInput);
  const keys = walletKeysOf(state, intent, inputs, collateralRefs);
  const mine = (fake.witnessSet.vkeyWitnesses || []).filter((w) => keys.has(hexOf(w.vkey.bytes).slice(0, 56)));
  if (mine.length !== keys.size) throw new Error(`${name}: the library's fake witness set has ${mine.length} of the wallet's ${keys.size} payment keys`);
  const f = intent.fixed;
  const others = f ? witnessesOf(f, [0, 2]) : null;
  const ws = tx.witnessSet;
  const after = (part) => unpriced.includes(part);
  const witnessSet = new E.TransactionWitnessSet.TransactionWitnessSet({
    vkeyWitnesses: [...mine, ...(others && others.vkeyWitnesses ? others.vkeyWitnesses : [])],
    nativeScripts: ws.nativeScripts,
    bootstrapWitnesses: after('bootstrap witnesses') ? others.bootstrapWitnesses : ws.bootstrapWitnesses,
    plutusV1Scripts: ws.plutusV1Scripts,
    plutusData: after('witness-set datums') ? spendDatums(f).all : ws.plutusData,
    redeemers: ws.redeemers,
    plutusV2Scripts: ws.plutusV2Scripts,
    plutusV3Scripts: ws.plutusV3Scripts
  });
  // The parts the builder could not write, on the transaction it built.
  let body = tx.body;
  let auxiliaryData = tx.auxiliaryData;
  if (unpriced.length) {
    const set = { ...body };
    const uint = (k) => asUint(decode(Buffer.from(f.body[k], 'hex')), `body field ${k}`);
    if (after('current treasury value')) set.currentTreasuryValue = uint(21);
    if (after('treasury donation')) set.donation = uint(22);
    if (after('certificates')) set.certificates = listItems(f.body[4]).map((x) => E.Certificate.fromCBORHex(hexOf(x)));
    if ((after('certificates') || after('withdrawals')) && f.body[5] !== undefined) set.withdrawals = E.Withdrawals.fromCBORHex(f.body[5]);
    if (after('auxiliary data')) {
      auxiliaryData = E.AuxiliaryData.fromCBORHex(f.auxiliaryData);
      set.auxiliaryDataHash = E.AuxiliaryData.toHash(auxiliaryData);
    }
    // With witness-set datums it did not take, every observed datum and the
    // script-data hash by the library's own function (Redeemers.ts:692-729)
    // over its redeemers, those datums and the empty cost models the run
    // holds.
    if (after('witness-set datums')) set.scriptDataHash = E.Redeemers.toScriptDataHash(ws.redeemers ?? E.Redeemers.makeRedeemerMap([]), EMPTY_COST_MODELS, spendDatums(f).all);
    body = new E.TransactionBody.TransactionBody(set);
  }
  const bytes = E.Transaction.toCBORHex(new E.Transaction.Transaction({ body, witnessSet, isValid: tx.isValid, auxiliaryData }));
  const size = inspectTx(bytes).size;
  const scriptFee = intent.fixed ? intent.fixed.scriptFee : 0n;
  // The intent's other vkey witnesses as observed, written after the library
  // priced the transaction, are unpriced when the transaction carries more
  // vkey witnesses than the fake witness set the library priced (it counts no
  // DRep or committee key).
  const observedUnpriced = !!(others && others.vkeyWitnesses && others.vkeyWitnesses.length) && witnessSet.vkeyWitnesses.length > (fake.witnessSet.vkeyWitnesses || []).length;
  return {
    ok: true,
    kind: 'single',
    txs: [txRecord(bytes, walletRefs, tx.body.fee, size, keys.size)],
    library: { fee: tx.body.fee, finalMinFee: minFee(params, size, scriptFee), collateral: collateralRefs, implicit: evoImplicit(intent, params), unpriced: observedUnpriced ? [...unpriced, 'observed vkey witnesses'] : unpriced }
  };
}

// unfrack: the library's unfrack option ({} for its defaults), for the
// builder survey only; the baseline runs without it.
export function evoMethod({ unfrack = null } = {}) {
  const name = unfrack ? 'evo-unfrack' : 'evo-lf';
  return {
    name,
    version: `@evolution-sdk/evolution ${EVO_VERSION} largest-first${unfrack ? ', unfrack' : ''}`,
    deterministic: true,
    ownCollateral: true,
    async build(state, intent, params, opts) {
      refuseUncovered(name, REPLAY_COVERAGE.evo, intent);
      return buildEvo(state, intent, params, opts, { name, unfrack });
    }
  };
}
