// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Blaze baseline, blaze-wd: @blaze-cardano/tx 0.15.4 with
// @blaze-cardano/sdk 0.3.3 (butaneprotocol/blaze-cardano at
// 0499975bfa4fdb324f2185657a7f17e4cea35aa1, the npm gitHead of both releases;
// paths below are under packages/), called as a dapp calls it for a payment:
// Blaze.from(provider, wallet), newTransaction(), the requested outputs, then
// complete() with no argument. The provider and the wallet are the replay's
// state: the provider gives the run's parameters, the network and the
// evaluator; the wallet gives the spendable UTxOs in the state's order
// (inputOrder), the change address and the network. Nothing reaches a network.
// Its change policies are its own ('default') and UnFrack.It's layout change on
// the inputs the library selected ('layout'); no other change policy is
// accepted.
//
// The library, at that commit:
//   blaze-sdk/src/blaze.ts:48-62, newTransaction: a TxBuilder with the
//   provider's network id and a pre-complete hook that adds the wallet's
//   getUnspentOutputs() with addUnspentOutputs (blaze-tx/src/TxBuilder.ts:
//   691-696, into a Set, :231, so in the wallet's order), sets the wallet's
//   change address and the provider's evaluator.
//   blaze-tx/src/TxBuilder.ts:269: the coin selector is micahsSelector unless
//   useCoinSelector (:446-453) replaces it, which the default call does not;
//   complete() takes useCoinSelection true by default (:2037-2045). The opt-in
//   hvfSelector is not used.
//   TxBuilder.ts:2066-2311, complete: at most 10 passes, each pricing the body
//   (calculateFees, :1759-1832), collecting the spare inputs, the wallet's
//   UTxOs not yet inputs in the Set's order, script-address ones left out
//   (:2136-2166), taking the deficit inputs less outputs less the fee
//   (getAssetSurplus, :1460-1555), recovering lovelace from the change output
//   first (:2181-2190), selecting on what is still missing (:2209-2217) and
//   putting the surplus into the change output (adjustChangeOutput,
//   :1634-1679); it stops once a pass gives the fee of the pass before
//   (:2299-2303).
//   blaze-tx/src/coinSelectors/micahsSelector.ts:122-149: wideSelection
//   (:15-58), at most 30 rounds while the goal holds two or more asset types,
//   each taking the input with the best rating; then deepSelection (:67-113),
//   at most 30 rounds, each taking the input holding most of the goal's first
//   asset (lovelace first, blaze-tx/src/value.ts:143-151). Both keep the first
//   input in list order on a tie (strict >, :36 and :91) and remove the chosen
//   one with splice, which keeps the others in order (:49, :104), so ties go
//   to the state's order. A goal still short after both phases throws
//   UTxOSelectionError "final" (:138-140); a phase that finds no input holding
//   what it needs throws "wide" or "deep" (:40-47, :95-102). It draws nothing
//   at random.
//   Change (adjustChangeOutput, splitOutputIfNeeded :1694-1750): one change
//   output at the change address, split when its whole CBOR is maxValueSize or
//   more, assets in map order, a new output starting when the next asset would
//   take the output's CBOR over 90 percent of maxValueSize, each piece at its
//   minimum and the leftover lovelace on the last.
//   Fee (:1759-1832): minFeeConstant + size * minFeeCoefficient, rounded up,
//   on the serialized draft with one placeholder vkey witness per key the
//   builder counts (buildPlaceholderWitnessSet, :1435-1458, the keys of
//   updateRequiredWitnesses, :1322-1424, and the operations below), plus the
//   reference scripts' fee and the execution units at the prices. complete()
//   checks no transaction size limit and writes no network id (:2063-2064).
//
// Witnesses (setting serialization 'own'): complete() returns the transaction
// with an empty vkey set (buildFinalWitnessSet([]), :2307); the adapter writes
// one synthetic vkey witness per wallet key (kit/replay.mjs
// replayWitnessKeys) into the library's witness set, encoded by the library,
// then the intent's other vkey witnesses as observed.
//
// Errors to failure classes (setting unclassified 'other' for the rest):
//   UTxOSelectionError "wide" or "deep" (blaze-core/src/errors.ts:5-15),
//   "No spare inputs available to add to the transaction", "A transaction
//   must have at least one input, but there are no available spare inputs"
//   (TxBuilder.ts:2232-2236, :2289-2292)                       balance
//   UTxOSelectionError "final": the selector's 30 + 30 rounds ran out on a
//   spend the engine found feasible                            max-inputs
//   "checkOutputMinAda: Failed due to max value size!" (blaze-tx/src/utils.ts:
//   317-320) on a change output                                value-size
//   "prepareCollateral: ..." (:1947-1949, :1971-1974), a UTxOSelectionError
//   raised while choosing collateral (:1952-1966), and "checkOutputMinAda:
//   collateral output does not have sufficient ADA" (utils.ts:312-316), which
//   only the collateral return can fail, since every other output's coin is
//   raised to its minimum before the check (:841-864)          collateral
// A requested output the library refuses (addOutput, :878-886) is the
// intent's, class other with "requested output: ".
//
// The replay path: every intent the history reader writes (source 'replay')
// is built with the run's parameters as the library's (blazeParams below:
// coinsPerUtxoByte, maxTxSize, the fee terms, the deposits, maxValueSize,
// the collateral terms, the execution prices and the reference-script price,
// with the range and multiplier Blaze's own providers set,
// blaze-query/src/blockfrost.ts:137-142; the cost models empty, as the run
// holds none; the fields the builder does not read are the library's
// hard-coded values, blaze-core/src/params.ts:80-196, and the redeemers'
// placeholder budget, maxExecutionUnitsPerTransaction, serves only until the
// evaluator replaces it), and its fixed parts through the library's own
// operations, before complete():
//   requested outputs   addOutput with the output's own bytes
//                       (TransactionOutput.fromCbor), the path payLovelace and
//                       payAssets take (:897-950), so a datum, a script
//                       reference and a coin raised to its minimum pass
//                       through
//   fixed inputs        addInput with the input's redeemer and, for a datum
//                       hash, its datum (:563-689); never in the wallet's UTxOs
//   reference inputs    addReferenceInput (:527-561)
//   mint and burn       addMint per policy, a burn as a negative quantity,
//                       with the policy's redeemer (:722-786)
//   certificates        the operation that writes the same certificate:
//                       addDeregisterStake (kind 1), addDelegation (2),
//                       addRegisterPool (3), addRetirePool (4), addRegisterStake
//                       (7, its deposit the run's keyDeposit), addVoteDelegation
//                       (9), addRegisterDRep (16), addUnregisterDRep (17),
//                       addUpdateDRep (18), in the intent's order, each with its
//                       redeemer. The library counts the deposits and refunds
//                       of kinds 0, 1, 3, 4, 7 and 8 and of proposals
//                       (:1498-1544), so a DRep deposit or refund is left out
//                       and a pool retirement is counted as a refund; the
//                       kit's balance check says so
//   withdrawals         addWithdrawal per reward account (:3010-3094)
//   votes               setVotingProcedures with the script DReps' redeemers
//                       (:2642-2707)
//   proposals           addProposal per proposal (:2859-2916)
//   required signers    addRequiredSigner (:3096-3116)
//   validity            setValidFrom, setValidUntil, in slots (:2965-3008)
//   auxiliary data      setAuxiliaryData with the intent's own bytes
//                       (:3118-3128), scripts included
//   donation            setDonation (:501-504), which the balance counts
//   scripts             provideScript for each native and Plutus script of
//                       the witness set (:3148-3151); the library writes those
//                       a part needs
//   datums              each spent script input's datum through addInput, the
//                       others through provideDatum (:1052-1055), which the
//                       library writes and prices
//   redeemers           with their operations; the execution units through
//                       the provider's evaluator (useEvaluator, blaze.ts:58-61;
//                       TxBuilder.ts:1066-1095), which returns the intent's
//                       observed units for each redeemer at the target the
//                       library's index names (blazeEvaluator below)
//   collateral          the UTxO the engine set aside, by provideCollateral
//                       (:706-713). With coin selection on, prepareCollateral
//                       (:1836-2015) takes it when it covers the total,
//                       ceil(fee * collateralPercentage / 100) (utils.ts:92-97),
//                       writes that total and returns the rest to the change
//                       address; when it does not, the library chooses
//                       collateral from the wallet's UTxOs (:1915-1980), which
//                       the engine refuses as not the UTxO set aside
// A part the builder can neither write nor price (unpricedParts) is written on
// the transaction it built, through the library's types, as every library's
// replay does: the certificates, all of them in the intent's order, when one
// has no operation above (a legacy registration, kind 0, a Conway
// deregistration, kind 8, the combined delegation and registration kinds
// 10 to 13, the committee certificates 14 and 15, or a genesis-delegation or
// MIR certificate); the current treasury value, which no operation sets; and
// bootstrap witnesses. The library's fee does not count such a part, and a
// value it did not balance (the deposit of a certificate written so) stays
// unbalanced; the kit's checks say which (library.unpriced names the parts).
// When the transaction then carries more vkey witnesses than the library
// priced (the count it keeps, requiredWitnesses and additionalSigners, read
// after complete()), library.unpriced names the observed ones.
// Not replayable (blazeRefusal): body field 6, as for every adapter
// (kit/replay.mjs replayRefusal); a Byron address on a fixed input, from which
// addInput reads a payment credential (:619-622); body field 15, which
// complete() never writes; certificates written after the build when one of
// them needs a redeemer, which the library could not attach; and a vote
// redeemer for a voter other than a script DRep, which setVotingProcedures
// cannot attach (:2652-2660).
//
// The layout change (opts.changePolicy 'layout'): the library builds its
// transaction exactly as for its own change; the wallet inputs it selected are
// read from that transaction, its change is dropped, and the simulator's
// layout change (methods/change.mjs) is built on those inputs, the kit
// assembling the transaction at its exact fee with the intent's fixed parts and
// the collateral the engine set aside, as for cardano-js-sdk and CSL. A library
// that fails to build fails before this point, as for its own change.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Blaze, Core } from '@blaze-cardano/sdk';
import { CLASSES } from '../kit/check.mjs';
import { passMachineErrors } from '../kit/machine.mjs';
import { unspentOutputParts, inspectTx } from '../kit/inspect.mjs';
import { replayRefusal, listItems, requiredSigners, replayWitnessKeys, redeemerKey, targetKey, syntheticVkeys } from '../kit/replay.mjs';
import { blake2b256 } from '../history/blake2b.mjs';
import { minFee } from '../kit/fee.mjs';
import { need } from '../kit/params.mjs';
import { decode, asUint, asBytes, encArray, encUint } from '../history/cbor.mjs';
import { NOT_REPLAYABLE } from './contract.mjs';
import { buildWithChange } from './change.mjs';
import { inputOrder, recordsOf, refuseUncovered, REPLAY_COVERAGE, errorText, txRecord } from './library.mjs';

const requireHere = createRequire(import.meta.url);
const versionOf = (pkg) => JSON.parse(readFileSync(requireHere.resolve(`${pkg}/package.json`), 'utf8')).version;
export const BLAZE_TX_VERSION = versionOf('@blaze-cardano/tx');
export const BLAZE_SDK_VERSION = versionOf('@blaze-cardano/sdk');
if (BLAZE_TX_VERSION !== '0.15.4') throw new Error(`@blaze-cardano/tx ${BLAZE_TX_VERSION} is installed; the baseline is 0.15.4`);
if (BLAZE_SDK_VERSION !== '0.3.3') throw new Error(`@blaze-cardano/sdk ${BLAZE_SDK_VERSION} is installed; the baseline is 0.3.3`);

const hexOf = (b) => Buffer.from(b).toString('hex');

export function classOfBlazeError(e) {
  const m = errorText(e);
  if (e instanceof Core.UTxOSelectionError) {
    if (/prepareCollateral/.test(String(e.stack))) return CLASSES.collateral;
    return e.phase === 'final' ? CLASSES.maxInputs : CLASSES.balance;
  }
  if (/^prepareCollateral: /.test(m)) return CLASSES.collateral;
  if (/^checkOutputMinAda: collateral output does not have sufficient ADA/.test(m)) return CLASSES.collateral;
  if (/^checkOutputMinAda: Failed due to max value size!/.test(m)) return CLASSES.valueSize;
  if (/^No spare inputs available to add to the transaction/.test(m)) return CLASSES.balance;
  if (/^A transaction must have at least one input, but there are no available spare inputs/.test(m)) return CLASSES.balance;
  return CLASSES.other;
}

// The library's network id for the run's network; the synthetic shapes carry
// mainnet addresses.
const networkIdOf = (network) => (network === 'preprod' ? Core.NetworkId.Testnet : Core.NetworkId.Mainnet);

const ratio = (r) => (r === null ? undefined : Number(r[0]) / Number(r[1]));
const orUndefined = (x) => (x === null || x === undefined ? undefined : Number(x));
const EMPTY_COST_MODELS = new Map([[0, []], [1, []], [2, []]]);

// The run's parameters as the library's (blaze-core/src/params.ts:6-79). A
// parameter the run does not state is left undefined; the replay path asks
// for the ones a spend needs before it builds (neededParameters).
export function blazeParams(params) {
  const H = Core.hardCodedProtocolParams;
  const refPrice = ratio(params.minFeeRefScriptCostPerByte);
  return {
    ...H,
    coinsPerUtxoByte: Number(params.coinsPerUtxoByte),
    maxTxSize: params.maxTxSize,
    minFeeCoefficient: Number(params.minFeeA),
    minFeeConstant: Number(params.minFeeB),
    stakeKeyDeposit: orUndefined(params.keyDeposit),
    poolDeposit: orUndefined(params.poolDeposit),
    maxValueSize: params.maxValSize,
    collateralPercentage: params.collateralPercent,
    maxCollateralInputs: params.maxCollateralInputs,
    costModels: EMPTY_COST_MODELS,
    prices: { memory: ratio(params.priceMem), steps: ratio(params.priceStep) },
    minFeeReferenceScripts: refPrice === undefined ? undefined : { ...H.minFeeReferenceScripts, base: refPrice },
    minFeeRefScriptCostPerByte: refPrice,
    governanceActionDeposit: orUndefined(params.govActionDeposit),
    delegateRepresentativeDeposit: orUndefined(params.drepDeposit)
  };
}

// A UTxO in the library's type from its TransactionUnspentOutput bytes: a
// state's UTxO, or a fixed or reference input of an intent. Made afresh for
// every build, since the builder holds what it is given.
const unspent = (u) => Core.TransactionUnspentOutput.fromCbor(u.cbor);
const refOfInput = (i) => `${i.transactionId()}#${Number(i.index())}`;

// The intent's certificates' kinds.
const certificateKinds = (f) => (f.body[4] === undefined ? [] : listItems(f.body[4]).map((b) => Number(asUint(decode(b).items[0], 'certificate kind'))));
const OPERATION_KINDS = new Set([1, 2, 3, 4, 7, 9, 16, 17, 18]);
// Whether the intent's certificates are written after the build: one of them
// has no operation that writes it.
const certificatesAfter = (f) => certificateKinds(f).some((k) => !OPERATION_KINDS.has(k));

// The voter kind of a vote redeemer's target (its observed bytes, [kind,
// hash]).
const voterKind = (hexVoter) => Number(asUint(decode(Buffer.from(hexVoter, 'hex')).items[0], 'voter kind'));

// Why the library cannot write the intent, or null when it can.
export function blazeRefusal(intent) {
  const kit = replayRefusal(intent);
  if (kit) return kit;
  const f = intent.fixed;
  if (!f) return null;
  for (const x of f.inputs) if (unspentOutputParts(x.cbor).addr.type === 8) return `a Byron address on ${x.ref}: addInput reads a payment credential from every input (blaze-tx/src/TxBuilder.ts:619-622)`;
  if (f.body[15] !== undefined) return 'body field 15 (network id): complete() never writes it, and a replayed intent carries none';
  if (certificatesAfter(f) && f.redeemers.some((r) => r.tag === 2)) return 'a certificate no operation writes, in a transaction whose certificates need redeemers the library could not attach';
  if (f.redeemers.some((r) => r.tag === 4 && voterKind(r.target.voter) !== 3)) return 'a vote redeemer for a voter other than a script DRep: setVotingProcedures attaches redeemers to script DReps only (blaze-tx/src/TxBuilder.ts:2652-2660)';
  return null;
}

// The parts the builder can neither write nor price, written on the
// transaction it built.
export function unpricedParts(intent) {
  const f = intent.fixed;
  if (!f) return [];
  const out = [];
  if (f.body[4] !== undefined && certificatesAfter(f)) out.push('certificates');
  if (f.body[21] !== undefined) out.push('current treasury value');
  if (f.witnesses[2] !== undefined) out.push('bootstrap witnesses');
  return out;
}

// The parameters a spend needs that the run must state.
function neededParameters(intent, params, available) {
  const f = intent.fixed;
  if (!f) return;
  const kinds = certificateKinds(f);
  if (!certificatesAfter(f)) {
    if (kinds.some((k) => k === 1 || k === 7)) need(params, 'keyDeposit');
    if (kinds.some((k) => k === 3 || k === 4)) need(params, 'poolDeposit');
  }
  if (f.redeemers.length) {
    need(params, 'priceMem');
    need(params, 'priceStep');
  }
  if (params.minFeeRefScriptCostPerByte === null) {
    const carried = [...available, ...f.inputs, ...f.referenceInputs].some((u) => unspentOutputParts(u.cbor).scriptRef);
    if (carried) need(params, 'minFeeRefScriptCostPerByte');
  }
}

// The intent's redeemer data for one target, by the target's key
// (kit/replay.mjs redeemerKey), as the library's PlutusData, or undefined.
function redeemerFinder(f) {
  const byKey = new Map();
  for (const r of f ? f.redeemers : []) if (!byKey.has(redeemerKey(r))) byKey.set(redeemerKey(r), r);
  const at = (target) => {
    const r = byKey.get(targetKey(target));
    return r ? Core.PlutusData.fromCbor(r.data) : undefined;
  };
  return {
    byKey,
    input: (ref) => at({ kind: 'input', ref }),
    policy: (policy) => at({ kind: 'policy', policy }),
    certificate: (index) => at({ kind: 'certificate', index }),
    withdrawal: (account) => at({ kind: 'withdrawal', account }),
    proposal: (index) => at({ kind: 'proposal', index })
  };
}

// The witness set's scripts as the library's Script: native scripts (key 1)
// and Plutus V1 to V3 (keys 3, 6, 7), each from its observed bytes.
const SCRIPT_KEYS = [[1, 0], [3, 1], [6, 2], [7, 3]];
function witnessScripts(f) {
  const out = [];
  for (const [key, lang] of SCRIPT_KEYS) {
    if (f.witnesses[key] === undefined) continue;
    for (const raw of listItems(f.witnesses[key])) out.push(Core.Script.fromCbor(encArray([encUint(lang), raw]).toString('hex')));
  }
  return out;
}

// The witness set's datums (key 4) as the library's PlutusData, each from its
// observed bytes: the one each spent Plutus input with a datum hash needs, for
// addInput (byInput), and the rest, for provideDatum.
function intentDatums(f, red) {
  const out = { byInput: new Map(), rest: [] };
  if (f.witnesses[4] === undefined) return out;
  const items = listItems(f.witnesses[4]).map((bytes) => ({ hash: hexOf(blake2b256(bytes)), datum: Core.PlutusData.fromCbor(hexOf(bytes)), used: false }));
  const byHash = new Map();
  for (const d of items) if (!byHash.has(d.hash)) byHash.set(d.hash, d);
  for (const x of f.inputs) {
    const p = unspentOutputParts(x.cbor);
    if (!p.datum || p.datum.kind !== 'hash' || !red.input(x.ref)) continue;
    const d = byHash.get(p.datum.hash);
    if (!d) continue;
    d.used = true;
    out.byInput.set(x.ref, d.datum);
  }
  out.rest = items.filter((d) => !d.used).map((d) => d.datum);
  return out;
}

// The certificate's operation on builder b.
function withCertificate(b, hexCert, redeemer) {
  const c = Core.Certificate.fromCbor(hexCert);
  const cred = (core) => Core.Credential.fromCore(core);
  switch (c.kind()) {
    case 1:
      return b.addDeregisterStake(cred(c.asStakeDeregistration().stakeCredential()), redeemer);
    case 2: {
      const d = c.asStakeDelegation();
      return b.addDelegation(cred(d.stakeCredential()), Core.PoolId.fromKeyHash(d.poolKeyHash()), redeemer);
    }
    case 3:
      return b.addRegisterPool(c.asPoolRegistration().poolParameters().toCore());
    case 4: {
      const r = c.asPoolRetirement();
      return b.addRetirePool(Core.PoolId.fromKeyHash(r.poolKeyHash()), r.epoch());
    }
    case 7:
      return b.addRegisterStake(cred(c.asRegistrationCert().stakeCredential()), redeemer);
    case 9: {
      const v = c.asVoteDelegationCert();
      const d = v.dRep().toCore();
      const drep = d.__typename === 'AlwaysAbstain' ? 'alwaysAbstain' : d.__typename === 'AlwaysNoConfidence' ? 'alwaysNoConfidence' : cred(d);
      return b.addVoteDelegation(cred(v.stakeCredential()), drep, redeemer);
    }
    case 16: {
      const r = c.asRegisterDelegateRepresentativeCert();
      return b.addRegisterDRep(cred(r.credential()), r.deposit(), r.anchor(), redeemer);
    }
    case 17: {
      const r = c.asUnregisterDelegateRepresentativeCert();
      return b.addUnregisterDRep(cred(r.credential()), r.deposit(), redeemer);
    }
    case 18: {
      const r = c.asUpdateDelegateRepresentativeCert();
      return b.addUpdateDRep(cred(r.credential()), r.anchor(), redeemer);
    }
    default:
      throw new Error(`certificate kind ${c.kind()}: no operation`);
  }
}

// The intent's fixed parts as the library's operations on builder b.
function withFixedParts(b, intent) {
  const f = intent.fixed;
  const red = redeemerFinder(f);
  for (const s of witnessScripts(f)) b.provideScript(s);
  for (const x of f.referenceInputs) b.addReferenceInput(unspent(x));
  const datums = intentDatums(f, red);
  for (const x of f.inputs) b.addInput(unspent(x), red.input(x.ref), datums.byInput.get(x.ref));
  for (const d of datums.rest) b.provideDatum(d);
  if (f.body[9] !== undefined) {
    const byPolicy = new Map();
    const add = (a, q) => {
      if (!byPolicy.has(a.policy)) byPolicy.set(a.policy, new Map());
      byPolicy.get(a.policy).set(a.name, q);
    };
    for (const a of intent.implicit.mint) add(a, BigInt(a.qty));
    for (const a of intent.implicit.burn) add(a, -BigInt(a.qty));
    for (const [policy, assets] of byPolicy) b.addMint(policy, assets, red.policy(policy));
  }
  if (f.body[4] !== undefined && !certificatesAfter(f)) listItems(f.body[4]).forEach((bytes, i) => withCertificate(b, hexOf(bytes), red.certificate(i)));
  if (f.body[5] !== undefined) {
    const buf = Buffer.from(f.body[5], 'hex');
    const n = decode(buf);
    for (const [k, v] of n.entries) {
      const account = hexOf(asBytes(k, 'reward account'));
      b.addWithdrawal(Core.Address.fromBytes(account).toBech32(), asUint(v, 'withdrawal'), red.withdrawal(account));
    }
  }
  if (f.body[19] !== undefined) {
    const voteRedeemers = new Map();
    for (const r of f.redeemers) if (r.tag === 4) voteRedeemers.set(r.target.voter.slice(-56).toLowerCase(), Core.PlutusData.fromCbor(r.data));
    b.setVotingProcedures(Core.VotingProcedures.fromCbor(f.body[19]), voteRedeemers);
  }
  if (f.body[20] !== undefined) {
    listItems(f.body[20]).forEach((bytes, i) => b.addProposal(Core.ProposalProcedure.fromCbor(hexOf(bytes)), red.proposal(i)));
  }
  if (f.body[14] !== undefined) for (const h of requiredSigners(f)) b.addRequiredSigner(h);
  const slot = (k) => Number(asUint(decode(Buffer.from(f.body[k], 'hex')), 'slot'));
  if (f.body[8] !== undefined) b.setValidFrom(slot(8));
  if (f.body[3] !== undefined) b.setValidUntil(slot(3));
  if (f.auxiliaryData) b.setAuxiliaryData(Core.AuxiliaryData.fromCbor(f.auxiliaryData));
  if (f.body[22] !== undefined) b.setDonation(asUint(decode(Buffer.from(f.body[22], 'hex')), 'donation'));
  return b;
}

// The provider's evaluator (TxBuilder.ts:1066-1095): the draft's redeemers
// with the intent's observed execution units, each found by the target the
// library's index names. The library numbers a spend redeemer by its input's
// place among the inputs sorted by transaction id and index written as one
// string (insertSorted, blaze-tx/src/utils.ts:231-240, called at
// TxBuilder.ts:606), a mint redeemer among the policies sorted, a reward
// redeemer among the withdrawals' credential hashes sorted (:3022-3025) and a
// vote redeemer among the script DReps' hashes sorted (:2673); a certificate
// or proposal redeemer by its place in its list. A redeemer with no observed
// counterpart fails the build.
export function blazeEvaluator(intent) {
  const f = intent.fixed;
  const red = redeemerFinder(f);
  const cmp = (a, b) => a.localeCompare(b);
  return (tx) => {
    const body = tx.body();
    const ins = [...body.inputs().values()].map((i) => ({ ref: refOfInput(i), key: `${i.transactionId()}${Number(i.index())}` })).sort((a, b) => cmp(a.key, b.key));
    const policies = body.mint() ? [...new Set([...body.mint().keys()].map((id) => Core.AssetId.getPolicyId(id)))].sort(cmp) : [];
    const wds = body.withdrawals() ? [...body.withdrawals().keys()].map((a) => String(Core.Address.fromBech32(a).toBytes())).sort((a, b) => cmp(a.slice(2), b.slice(2))) : [];
    const voters = f ? [...new Set(f.redeemers.filter((r) => r.tag === 4).map((r) => r.target.voter.slice(-56).toLowerCase()))].sort(cmp) : [];
    const out = [];
    const ws = tx.witnessSet().redeemers();
    for (const r of ws ? ws.values() : []) {
      const tag = Number(r.tag());
      const idx = Number(r.index());
      let o;
      if (tag === 0) o = ins[idx] && red.byKey.get(targetKey({ kind: 'input', ref: ins[idx].ref }));
      else if (tag === 1) o = policies[idx] && red.byKey.get(targetKey({ kind: 'policy', policy: policies[idx] }));
      else if (tag === 2) o = red.byKey.get(targetKey({ kind: 'certificate', index: idx }));
      else if (tag === 3) o = wds[idx] && red.byKey.get(targetKey({ kind: 'withdrawal', account: wds[idx] }));
      else if (tag === 4) o = voters[idx] && f.redeemers.find((x) => x.tag === 4 && x.target.voter.slice(-56).toLowerCase() === voters[idx]);
      else if (tag === 5) o = red.byKey.get(targetKey({ kind: 'proposal', index: idx }));
      if (!o) throw new Error(`the library's redeemer ${tag}:${idx} has no observed redeemer`);
      const c = Core.Redeemer.fromCbor(r.toCbor());
      c.setExUnits(new Core.Serialization.ExUnits(BigInt(o.exUnits[0]), BigInt(o.exUnits[1])));
      out.push(c);
    }
    const rs = Core.Redeemers.fromCore([]);
    rs.setValues(out);
    return rs;
  };
}

// The library's builder for the spend, from Blaze.from with the state as the
// provider and the wallet (blaze-sdk/src/blaze.ts:36-63).
async function newTransaction(state, intent, params, available) {
  const network = networkIdOf(state.network);
  const bp = blazeParams(params);
  const evaluate = blazeEvaluator(intent);
  const provider = { network, getParameters: async () => bp, evaluateTransaction: async (tx) => evaluate(tx) };
  const changeAddress = Core.Address.fromBech32(state.changeAddress);
  const wallet = { getUnspentOutputs: async () => available, getChangeAddress: async () => changeAddress, getNetworkId: async () => network };
  const blaze = await Blaze.from(provider, wallet);
  return blaze.newTransaction();
}

// Builds the intent with the library. It refuses nothing the method below
// refuses first.
export async function buildBlaze(T, state, intent, params, opts, { name = 'blaze-wd' } = {}) {
  const layout = opts.changePolicy === 'layout';
  if (opts.changePolicy !== 'default' && !layout) return { ok: false, class: CLASSES.other, detail: 'the Blaze baseline takes its own change or the layout change only' };
  const replay = intent.source === 'replay';
  if (replay) {
    const refusal = blazeRefusal(intent);
    if (refusal) return { ok: false, class: NOT_REPLAYABLE, detail: refusal };
  }
  const f = replay ? intent.fixed : null;
  const collateral = opts.collateral || null;
  if (intent.collateral && intent.collateral.required && !collateral) throw new Error(`${name}: a script spend needs the collateral the engine sets aside`);
  const fixedRefs = new Set(f ? f.inputs.map((x) => x.ref) : []);
  const pool = inputOrder(state).filter((u) => !fixedRefs.has(u.ref));
  const unpriced = replay ? unpricedParts(intent) : [];
  let b;
  try {
    neededParameters(intent, params, pool);
    b = await newTransaction(state, intent, params, pool.map(unspent));
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: CLASSES.other, detail: `replay parts: ${errorText(e)}` };
  }
  for (const o of intent.requested) {
    try {
      b.addOutput(Core.TransactionOutput.fromCbor(o.cbor));
    } catch (e) {
      passMachineErrors(e);
      return { ok: false, class: CLASSES.other, detail: `requested output: ${errorText(e)}` };
    }
  }
  try {
    if (f) withFixedParts(b, intent);
    if (collateral) b.provideCollateral([unspent(collateral)]);
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: CLASSES.other, detail: `replay parts: ${errorText(e)}` };
  }
  let tx;
  try {
    tx = await b.complete();
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: classOfBlazeError(e), detail: `complete: ${errorText(e)}` };
  }
  const refs = [...tx.body().inputs().values()].map(refOfInput);
  for (const x of fixedRefs) if (!refs.includes(x)) return { ok: false, class: CLASSES.other, detail: `the library left out the fixed input ${x}` };
  const walletRefs = refs.filter((x) => !fixedRefs.has(x));
  const inputs = recordsOf(state, walletRefs);
  if (layout) {
    const r = buildWithChange(T, { state, params, inputs, intent, policy: 'layout', collateral });
    if (!r.ok) return { ok: false, class: r.class, detail: `layout change on the library's inputs: ${r.detail}` };
    return { ok: true, kind: 'single', txs: [txRecord(r.bytes, walletRefs, r.fee, r.size, r.k)] };
  }
  // The parts the builder could not write, on the transaction it built.
  const after = (part) => unpriced.includes(part);
  if (unpriced.length) {
    const body = tx.body();
    if (after('certificates')) body.setCerts(Core.CborSet.fromCbor(f.body[4], Core.Certificate.fromCbor));
    if (after('current treasury value')) body.setCurrentTreasuryValue(asUint(decode(Buffer.from(f.body[21], 'hex')), 'treasury value'));
    tx.setBody(body);
  }
  // The vkey witnesses: the wallet's keys, synthetic, then the intent's
  // other vkey witnesses as observed.
  const keys = replayWitnessKeys(f, { inputs, collateral: collateral ? [collateral] : [] });
  const others = f && f.witnesses[0] !== undefined ? listItems(f.witnesses[0]) : [];
  const vkeys = [...syntheticVkeys(T, keys.size), ...others].map((x) => Core.VkeyWitness.fromCbor(hexOf(x)));
  const ws = tx.witnessSet();
  const set = Core.CborSet.fromCore([], Core.VkeyWitness.fromCore);
  set.setValues(vkeys);
  ws.setVkeys(set);
  if (after('bootstrap witnesses')) ws.setBootstraps(Core.CborSet.fromCbor(f.witnesses[2], Core.BootstrapWitness.fromCbor));
  tx.setWitnessSet(ws);
  const bytes = tx.toCbor();
  const size = inspectTx(bytes).size;
  const fee = tx.body().fee();
  const scriptFee = f ? f.scriptFee : 0n;
  // The keys the library priced a placeholder witness for (TxBuilder.ts:
  // 1435-1458), read from its own count after complete().
  const priced = b.requiredWitnesses.size + b.additionalSigners;
  const observedUnpriced = others.length > 0 && vkeys.length > priced;
  return {
    ok: true,
    kind: 'single',
    txs: [txRecord(bytes, walletRefs, fee, size, keys.size)],
    library: { fee, finalMinFee: minFee(params, size, scriptFee), priced, unpriced: observedUnpriced ? [...unpriced, 'observed vkey witnesses'] : unpriced }
  };
}

export function blazeMethod(T) {
  const name = 'blaze-wd';
  return {
    name,
    version: `@blaze-cardano/tx ${BLAZE_TX_VERSION} with @blaze-cardano/sdk ${BLAZE_SDK_VERSION} micahsSelector`,
    deterministic: true,
    seeded: true,
    async build(state, intent, params, opts) {
      refuseUncovered(name, REPLAY_COVERAGE.blaze, intent);
      return buildBlaze(T, state, intent, params, opts, { name });
    }
  };
}
