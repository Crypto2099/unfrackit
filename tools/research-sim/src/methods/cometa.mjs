// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Cometa baseline, cometa-lf: @biglup/cometa 1.2.0 (Biglup/cometa.js at
// 15f0862, the tag v1.2.0; paths below are under src/), the WebAssembly build
// of Biglup/cardano-c, whose transaction builder does the selection and the
// change (cardano-c at 238fe34, the tag v1.2.1, paths under
// lib/src/transaction_builder/; the module reports the C library as 1.2.0,
// getLibCardanoCVersion, and no file under transaction_builder/ differs
// between the tags v1.2.0 and v1.2.1). It is called as a dapp calls it for a
// payment: TransactionBuilder.create({ params, slotConfig }), setUtxos with
// the spendable UTxOs in the state's order (inputOrder), the requested outputs
// (sendLovelace, sendValue, or addOutput for an output with a datum or a
// script reference), setChangeAddress with the state's change address, then
// build(). Nothing reaches a network. Its change policies are its own
// ('default') and UnFrack.It's layout change on the inputs the library
// selected ('layout'); no other change policy is accepted.
//
// The package is loaded through its CommonJS entry (dist/cjs/index.js, the
// "require" condition of its exports map): the ESM entry calls require('fs')
// while it loads the module and cannot load under Node. Both entries are one
// bundle of the same sources and the same compiled C library.
//
// The library, at those commits:
//   cometa.js txBuilder/TransactionBuilder.ts:134-165, create: a native
//   builder (tx_builder_new) from the parameters and slot configuration;
//   :315-324, setUtxos writes the list, in the order given, into the
//   builder's available UTxOs; :1854-1883, build calls tx_builder_build and
//   throws "Transaction build failed: <the builder's last error>". No coin
//   selector is set, so the C default stands.
//   cardano-c transaction_builder.c:922, the builder's coin selector is
//   cardano_large_first_coin_selector_new unless set_coin_selector replaces
//   it (:1001-1020). send_lovelace and send_value (:1535-1714) and add_output
//   (:2068-2096) each append one output to the body's list. build
//   (:4891-5002) needs a change address and the available UTxOs, and, when
//   the transaction carries redeemers or datums, a collateral change address
//   and collateral UTxOs (:4930-4951); it sets a placeholder script-data
//   hash, runs cardano_balance_transaction and then writes the real one.
//   balancing/transaction_balancing.c:462-955, cardano_balance_transaction:
//   a loop. Each pass takes the collateral (:525, internals/collateral.c:
//   228-372), the value the inputs must give (the outputs, less withdrawals
//   and refunds, plus deposits, the fee read from the body, the change padding
//   and the donation, the mint netted, :541-560), runs the selector on it
//   over every available UTxO (:571), sets the inputs, and adds the change
//   (selected less required plus padding) as one output at the change
//   address (add_change_output, :297-346); a change under its minimum ADA
//   adds the shortfall to the padding and restarts the pass with the inputs
//   cleared (:653-716). With redeemers it runs the evaluator (:739-814). It
//   prices the transaction (cardano_compute_transaction_fee over the
//   reference inputs only, :848, plus 3 + an array head + 101 bytes per
//   signer at minFeeA, :452-457, the signers those of
//   internals/unique_signers.c:1015); a fee above the body's is written and
//   the pass restarts with the outputs restored and the inputs cleared
//   (:867-933). Selection is therefore redone from the whole list on every
//   pass, and the fee only grows.
//   coin_selection/internals/large_first_coin_selector.c:56-239: the
//   pre-selected inputs first; for each asset of the target (the lovelace
//   first when it is non-zero, then the tokens in the asset map's order), when
//   the running total falls short, the remaining UTxOs sorted by that asset,
//   descending, with a stable insertion sort (large_first_helpers.c:311-434,
//   collections/array.c:141-161), each holding any of it taken until it is
//   covered. Ties keep the order of the list the builder was given, so the
//   state's order breaks them. It draws nothing at random.
//   Change: one output, all the leftover value; no split for maxValueSize and
//   no input cap. The builder checks no transaction size limit.
//
// Witnesses (setting serialization 'own'): build returns the transaction with
// no vkey witness; the adapter gives the library one synthetic vkey witness
// per wallet key (kit/replay.mjs replayWitnessKeys) and the intent's other
// vkey witnesses as observed, through applyVkeyWitnessSet
// (common/VkeyWitness.ts:63-82), which encodes them.
//
// Errors to failure classes (setting unclassified 'other' for the rest), on
// the message "Transaction build failed: <the builder's message> (<the
// library's name for the code>)" (buildTx below):
//   "Insufficient balance" (error.c:191-193), CARDANO_ERROR_BALANCE_
//   INSUFFICIENT from the selector (large_first_helpers.c:428) or the
//   balancing loop: the inputs offered fall short of the outputs, the fee and
//   the change padding. When the inputs offered leave tokens over after the
//   outputs, the shortfall is the token change's minimum ADA, which the
//   padding loop raised                                       change-minimum
//   otherwise                                                 balance
// The collateral selection (collateral.c:277-290) fails with the same code
// and no message of its own, so a set-aside UTxO short of the library's
// collateral is classed balance as well. A part of the intent an operation
// refuses is class other with "replay parts: ".
//
// The replay path: every intent the history reader writes (source 'replay')
// is built with the run's parameters as the library's (cometaParams below; the
// fields the builder never reads hold fixed placeholder values, and the cost
// models are empty, as the run holds none, so the script-data hash
// is 32 bytes over them, as no check reads it), and its fixed parts through
// the library's own operations, before build:
//   requested outputs   sendLovelace, sendValue, or addOutput with the output's
//                       datum (its bytes, which the library keeps) and script
//                       reference (its hash checked)
//   fixed inputs        addInput (TransactionBuilder.ts:680-717) with the
//                       UTxO written from its bytes, its redeemer
//                       and, for a datum hash, the witness set's datum
//   reference inputs    addReferenceInput (:484-499)
//   mint and burn       mintToken per asset, a burn as a negative quantity,
//                       with its policy's redeemer (:770-810)
//   certificates        the builder's operation that writes the certificate,
//                       in the intent's order, each with its redeemer:
//                       delegateStake (kind 2), registerStakeAddress (7),
//                       deregisterStakeAddress (8), delegateVotingPower (9, to
//                       a DRep credential), registerDRep (16, with an anchor),
//                       deregisterDRep (17), updateDRep (18, with an anchor)
//                       (:939-1283; certificateOp below says why the generic
//                       addCertificate is not used)
//   withdrawals         withdrawRewards per reward account (:883-925)
//   votes               vote per voter and action (:1297-1339)
//   proposals           the propose operation of the action's kind
//                       (:1424-1845): parameter change, hard fork, treasury
//                       withdrawals, no confidence, new constitution and info;
//                       the library adds a proposal's guardrail redeemer itself
//                       (transaction_builder.c:649-715, :3897, :4239)
//   required signers    addSigner (:834-842)
//   validity            setInvalidBefore, setInvalidAfter, in slots
//   auxiliary data      setMetadata per label (:744-759), with the metadatum
//                       as the JSON the library reads (auxiliary_data/
//                       metadatum.c:197-335: objects as maps with text keys,
//                       arrays as lists, strings as text, integers)
//   donation            setDonation (:302-307)
//   scripts             addScript (:1393-1408) for each witness-set script,
//                       its hash checked
//   datums              the spent inputs' through addInput, the rest through
//                       addDatum (:854-869)
//   redeemers           with their operations; the execution units through
//                       the builder's evaluator (setTxEvaluator, :205-220),
//                       which gives each of the library's redeemers the
//                       intent's observed units for the part the ledger reads
//                       its index as naming (kit/inspect.mjs and
//                       history/tx.mjs redeemerTargets)
//   collateral          the UTxO the engine set aside, as setCollateralUtxos
//                       with the change address as setCollateralChangeAddress
//                       (:258-351): the library takes it when the transaction
//                       carries redeemers, writes the total collateral and
//                       returns the rest (collateral.c:228-372). A spend that
//                       carries datums but no redeemer gets the change address
//                       and an empty list, which build requires and which adds
//                       no collateral
//   deposits            the key, DRep and governance-action deposits the
//                       spend's certificates and proposals carry, as the
//                       library's parameters for the spend (spendDeposits
//                       below): the builder's operations read them only from
//                       its parameters
// A part the library has no operation or type for is written on the
// transaction it built, through the kit's CBOR, as every library's replay
// does (unpriced): the certificates, all of them in the intent's order, when
// one has no operation above (kinds 0, 1, 3 to 6 and 10 to 15, a delegation
// to always-abstain or no-confidence, a DRep certificate with no anchor, a
// deposit unlike the spend's other deposits); the proposals when one is a
// committee update or carries a parameter the library's type lacks; auxiliary data carrying
// scripts or a metadatum the library's JSON cannot carry (bytes, a map key
// other than text, an integer outside 64 bits), with its hash; the current
// treasury value; and bootstrap witnesses. The library's fee does not count
// such a part, and a value it did not balance stays unbalanced; the kit's
// checks say which (library.unpriced names the parts). When the transaction
// then carries more vkey witnesses than the library priced (getUniqueSigners,
// marshaling/transaction.ts:103-156, cardano_transaction_get_unique_signers,
// transaction/transaction.c:621-627, the signers the balancing loop counts),
// library.unpriced names the observed ones.
// Not replayable (the plan's refusal): body field 6, as for every adapter
// (kit/replay.mjs replayRefusal); body field 15, which the builder never
// writes; a script whose hash the library's encoding changes; a part
// written after the build that needs a redeemer; and a redeemer whose part
// the library does not take.
//
// Library behavior the replay records, not alters: every output the library
// writes is in the map form, two bytes longer than the array form, and it
// neither raises nor checks a requested output's coin, so a requested output
// at its array-form minimum is under its minimum as written (the kit's
// minimum check, class other); the fee counts the reference scripts of the
// reference inputs only, not those of spent inputs
// (transaction_balancing.c:848, cardano_compute_transaction_fee given the
// reference inputs as the resolved inputs).
//
// The layout change (opts.changePolicy 'layout'): the library builds its
// transaction exactly as for its own change; the wallet inputs it selected are
// read from it, its change is dropped, and the simulator's layout change
// (methods/change.mjs) is built on those inputs, the kit assembling the
// transaction at its exact fee with the intent's fixed parts and the
// collateral the engine set aside, as for Blaze and typhonjs. A library that
// fails to build fails before this point, as for its own change.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { CLASSES } from '../kit/check.mjs';
import { passMachineErrors } from '../kit/machine.mjs';
import { unspentOutputParts, inspectTx } from '../kit/inspect.mjs';
import { replayRefusal, listItems, requiredSigners, replayWitnessKeys, targetKey, syntheticVkeys, fixedInputValues } from '../kit/replay.mjs';
import { redeemerTargets } from '../history/tx.mjs';
import { blake2b256, blake2b224 } from '../history/blake2b.mjs';
import { addressBytes } from '../history/address.mjs';
import { decodeOutputBytes } from '../history/output.mjs';
import { assetMap, mergeAssets } from '../history/value.mjs';
import { minFee } from '../kit/fee.mjs';
import { need } from '../kit/params.mjs';
import { decode, raw, head, encUint, encBytes, encArray, asUint, asInt, asBytes } from '../history/cbor.mjs';
import { NOT_REPLAYABLE } from './contract.mjs';
import { buildWithChange } from './change.mjs';
import { inputOrder, recordsOf, refuseUncovered, REPLAY_COVERAGE, errorText, txRecord } from './library.mjs';

const requireHere = createRequire(import.meta.url);
const Cometa = requireHere('@biglup/cometa');
await Cometa.ready();

// The package's exports map does not export its package.json; it sits two
// directories above the CommonJS entry.
export const COMETA_VERSION = JSON.parse(readFileSync(join(dirname(requireHere.resolve('@biglup/cometa')), '..', '..', 'package.json'), 'utf8')).version;
export const CARDANO_C_VERSION = Cometa.getLibCardanoCVersion();
if (COMETA_VERSION !== '1.2.0') throw new Error(`@biglup/cometa ${COMETA_VERSION} is installed; the baseline is 1.2.0`);

const hexOf = (b) => Buffer.from(b).toString('hex');
const u8 = (b) => new Uint8Array(Buffer.from(b));

// The class of a library error. tokenChange: whether the inputs offered leave
// tokens over after the outputs.
export function classOfCometaError(e, { tokenChange = false } = {}) {
  const m = errorText(e);
  if (/^Transaction build failed: .*\(Insufficient balance\)$/.test(m)) return tokenChange ? CLASSES.changeMinimum : CLASSES.balance;
  return CLASSES.other;
}

// The run's parameters as the library's (common/ProtocolParameters.ts). The
// fields the builder never reads hold mainnet's values; a parameter the run
// does not state and a spend needs is asked for before the build
// (neededParameters).
const ratio = (r, dflt = [0n, 1n]) => {
  const x = r === null || r === undefined ? dflt : r;
  return { numerator: Number(x[0]), denominator: Number(x[1]) };
};
const num = (x, dflt = 0) => (x === null || x === undefined ? dflt : Number(x));
const UNREAD_RATIO = { numerator: 1, denominator: 2 };
const POOL_T = { motionNoConfidence: UNREAD_RATIO, committeeNormal: UNREAD_RATIO, committeeNoConfidence: UNREAD_RATIO, hardForkInitiation: UNREAD_RATIO, securityRelevantParamVotingThreshold: UNREAD_RATIO };
const DREP_T = { motionNoConfidence: UNREAD_RATIO, committeeNormal: UNREAD_RATIO, committeeNoConfidence: UNREAD_RATIO, hardForkInitiation: UNREAD_RATIO, updateConstitution: UNREAD_RATIO, ppNetworkGroup: UNREAD_RATIO, ppEconomicGroup: UNREAD_RATIO, ppTechnicalGroup: UNREAD_RATIO, ppGovernanceGroup: UNREAD_RATIO, treasuryWithdrawal: UNREAD_RATIO };
export function cometaParams(params, deposits = {}) {
  const at = (k) => (deposits[k] !== undefined ? deposits[k] : params[k]);
  return {
    minFeeA: Number(params.minFeeA),
    minFeeB: Number(params.minFeeB),
    maxBlockBodySize: 90112,
    maxTxSize: params.maxTxSize,
    maxBlockHeaderSize: 1100,
    keyDeposit: num(at('keyDeposit')),
    poolDeposit: num(params.poolDeposit),
    maxEpoch: 18,
    nOpt: 500,
    poolPledgeInfluence: { numerator: 3, denominator: 10 },
    treasuryGrowthRate: { numerator: 1, denominator: 5 },
    expansionRate: { numerator: 3, denominator: 1000 },
    decentralisationParam: { numerator: 0, denominator: 1 },
    extraEntropy: null,
    protocolVersion: { major: 10, minor: 0 },
    minPoolCost: 170000000,
    adaPerUtxoByte: Number(params.coinsPerUtxoByte),
    costModels: [{ language: 'PlutusV1', costs: [] }, { language: 'PlutusV2', costs: [] }, { language: 'PlutusV3', costs: [] }],
    executionCosts: { memory: ratio(params.priceMem), steps: ratio(params.priceStep) },
    maxTxExUnits: { memory: 14000000, steps: 10000000000 },
    maxBlockExUnits: { memory: 62000000, steps: 20000000000 },
    maxValueSize: params.maxValSize,
    collateralPercent: params.collateralPercent,
    maxCollateralInputs: params.maxCollateralInputs,
    poolVotingThresholds: POOL_T,
    drepVotingThresholds: DREP_T,
    minCommitteeSize: 7,
    committeeTermLimit: 146,
    governanceActionValidityPeriod: 6,
    governanceActionDeposit: num(at('govActionDeposit')),
    drepDeposit: num(at('drepDeposit')),
    drepInactivityPeriod: 20,
    refScriptCostPerByte: ratio(params.minFeeRefScriptCostPerByte)
  };
}

// The deposits the spend's certificates and proposals carry, as the
// parameters they were made under: { keyDeposit, drepDeposit,
// govActionDeposit }, each present when the fixed parts carry it with one
// value. The ledger requires a stake or DRep registration's deposit, a
// deregistration's refund and a proposal's deposit to equal the parameter in
// force (or the deposit paid), and the builder reads each only from its
// parameters, so the spend's own values are the parameters it was made under;
// the run's stand for the rest.
export function spendDeposits(f, params) {
  if (!f) return {};
  const seen = { keyDeposit: new Set(), drepDeposit: new Set(), govActionDeposit: new Set() };
  if (f.body[4] !== undefined) {
    for (const b of listItems(f.body[4])) {
      const n = decode(b);
      const kind = Number(asUint(n.items[0], 'certificate kind'));
      if (kind === 7 || kind === 8) seen.keyDeposit.add(asUint(n.items[2], 'deposit'));
      if (kind === 16 || kind === 17) seen.drepDeposit.add(asUint(n.items[2], 'deposit'));
    }
  }
  if (f.body[20] !== undefined) for (const b of listItems(f.body[20])) seen.govActionDeposit.add(asUint(decode(b).items[0], 'deposit'));
  const out = {};
  for (const [k, v] of Object.entries(seen)) if (v.size === 1 && [...v][0] !== (params[k] === null || params[k] === undefined ? null : BigInt(params[k]))) out[k] = [...v][0];
  return out;
}

// The slot configuration the builder is made with; it reads it only for
// validity given as a time, which the adapter never sets. The synthetic
// shapes carry mainnet addresses.
const slotConfigOf = (network) => (network === 'preprod' ? Cometa.CARDANO_PREPROD_SLOT_CONFIG : Cometa.CARDANO_MAINNET_SLOT_CONFIG);

// Why the library cannot express a part, as an error the plan turns into the
// intent's refusal.
class Inexpressible extends Error {}
const refuse = (why) => {
  throw new Inexpressible(why);
};

// The adapter hands the library its own types written from the intent's
// bytes and never reads one of the library's objects back through the
// wrapper's readers: readScript frees a native script's key hash twice
// (marshaling/script.ts:323-334, readBlake2bHashData already releases it), so
// reading a UTxO, an output or a script that holds a signature script
// (readUTxOtFromCbor, readTxOutFromCbor, cborToScript) corrupts the module's
// memory.

// Plutus data of the library's from its bytes: writePlutusData reads the cbor
// field first and parses it in the C library (marshaling/plutusData.ts,
// plutus_data_from_cbor), which keeps the bytes.
const dataOf = (bytes) => ({ cbor: hexOf(bytes), items: [] });

// A native script of the library's (common/Script.ts) from its CBOR node.
function nativeScriptOf(n) {
  const kind = Number(asUint(n.items[0], 'native script'));
  const list = (x) => x.items.map(nativeScriptOf);
  switch (kind) {
    case 0:
      return { type: 'native', kind, keyHash: hexOf(asBytes(n.items[1], 'key hash')) };
    case 1:
    case 2:
      return { type: 'native', kind, scripts: list(n.items[1]) };
    case 3:
      return { type: 'native', kind, required: Number(asUint(n.items[1], 'n')), scripts: list(n.items[2]) };
    case 4:
    case 5:
      return { type: 'native', kind, slot: Number(asUint(n.items[1], 'slot')) };
    default:
      throw new Error(`native script kind ${kind}`);
  }
}

// A script of the library's from its language and bytes (a native script's
// CBOR, or a Plutus script's bytes), whose hash as the library computes it
// must stay the one its bytes give: another encoding is another script.
function exactScript(lang, bytes, what) {
  const hash = hexOf(blake2b224(Buffer.concat([Buffer.from([lang]), Buffer.from(bytes)])));
  let s;
  try {
    s = lang === 0 ? nativeScriptOf(decode(Buffer.from(bytes))) : { type: 'plutus', bytes: hexOf(bytes), version: lang - 1 };
    if (Cometa.computeScriptHash(s) !== hash) refuse(`${what}: the library's script does not keep its hash`);
  } catch (e) {
    if (e instanceof Inexpressible) throw e;
    passMachineErrors(e);
    refuse(`${what}: ${errorText(e)}`);
  }
  return s;
}

// An output of the library's (common/TxOut.ts) from its parts.
function txOutOf(d, what) {
  const assets = {};
  for (const a of d.assets) assets[`${a.policy}${a.name}`] = BigInt(a.qty);
  const out = { address: Cometa.Address.fromBytes(u8(d.address)).toString(), value: { coins: d.coin, ...(d.assets.length ? { assets } : {}) } };
  if (d.datum && d.datum.kind === 'hash') out.datumHash = d.datum.hash;
  else if (d.datum) out.datum = dataOf(Buffer.from(d.datum.cbor, 'hex'));
  if (d.scriptRef) out.scriptReference = exactScript(d.scriptRef.lang, Buffer.from(d.scriptRef.script, 'hex'), `${what}'s reference script`);
  return out;
}

// A UTxO of the library's from its TransactionUnspentOutput bytes; made once
// per record.
const UTXOS = new WeakMap();
const utxoFromCbor = (cbor) => {
  const p = unspentOutputParts(cbor);
  return { input: { txId: p.txid, index: p.index }, output: txOutOf(p, p.ref) };
};
function utxoOf(u) {
  let x = UTXOS.get(u);
  if (!x) {
    x = utxoFromCbor(u.cbor);
    UTXOS.set(u, x);
  }
  return x;
}

// The witness set's scripts by hash: { lang, bytes, used }.
function witnessScripts(f) {
  const m = new Map();
  const put = (lang, bytes) => {
    const h = hexOf(blake2b224(Buffer.concat([Buffer.from([lang]), bytes])));
    if (!m.has(h)) m.set(h, { lang, bytes, used: false });
  };
  if (f.witnesses[1] !== undefined) for (const r of listItems(f.witnesses[1])) put(0, r);
  for (const [key, lang] of [[3, 1], [6, 2], [7, 3]]) {
    if (f.witnesses[key] === undefined) continue;
    for (const r of listItems(f.witnesses[key])) {
      const n = decode(r);
      if (n.mt !== 2) refuse('a witness-set Plutus script whose item is not a byte string');
      put(lang, asBytes(n, 'plutus script'));
    }
  }
  return m;
}

// The witness set's datums by hash: { bytes, used }.
function witnessDatums(f) {
  const m = new Map();
  if (!f || f.witnesses[4] === undefined) return m;
  for (const b of listItems(f.witnesses[4])) {
    const h = hexOf(blake2b256(b));
    if (!m.has(h)) m.set(h, { bytes: b, used: false });
  }
  return m;
}

// The intent's redeemers by target key, each taken once.
function redeemerTaker(f) {
  const m = new Map();
  for (const r of f ? f.redeemers : []) if (!m.has(targetKey(r.target))) m.set(targetKey(r.target), { r, used: false });
  const take = (target) => {
    const e = m.get(targetKey(target));
    if (!e) return undefined;
    e.used = true;
    return dataOf(Buffer.from(e.r.data, 'hex'));
  };
  take.peek = (target) => {
    const e = m.get(targetKey(target));
    return e ? dataOf(Buffer.from(e.r.data, 'hex')) : undefined;
  };
  take.left = () => [...m.values()].filter((e) => !e.used).map((e) => e.r);
  return take;
}

// The library's types for the parts of certificates, votes and proposals.
const credOf = (n) => ({ type: Number(asUint(n.items[0], 'credential')), hash: hexOf(asBytes(n.items[1], 'credential hash')) });
const anchorOf = (n) => (n.mt === 7 ? null : { url: n.items[0].value, dataHash: hexOf(asBytes(n.items[1], 'anchor hash')) });
const govActionIdOf = (n) => (n.mt === 7 ? undefined : { id: hexOf(asBytes(n.items[0], 'gov action id')), actionIndex: Number(asUint(n.items[1], 'gov action index')) });
const rationalOf = (n) => {
  const x = n.mt === 6 ? n.item : n;
  return { numerator: Number(asUint(x.items[0], 'numerator')), denominator: Number(asUint(x.items[1], 'denominator')) };
};

// The certificate the builder's own operation for it writes, as that
// operation on builder b, or null when no operation writes this certificate
// as it is: the builder's registerStakeAddress and deregisterStakeAddress
// write kinds 7 and 8 with the run's key deposit, registerDRep and
// deregisterDRep kinds 16 and 17 with its DRep deposit
// (transaction_builder.c:2781-2944, :3191-3493), so a certificate with
// another deposit has none; delegateVotingPower and the DRep operations take
// a DRep by its CIP-129 identifier, so an always-abstain or no-confidence
// delegation has none, and the DRep operations take an anchor, so one with
// no anchor has none. The generic addCertificate (TransactionBuilder.ts:
// 1353-1381) is not used: writeCertificate (marshaling/certificates.ts:
// 2044-2238) releases the certificate it returns (its finally unrefs the
// generic certificate it has just made), so the builder is handed a freed
// object, and the build fails with "Invalid certificate type" or the
// module's memory is corrupted.
const certKind = (b) => Number(asUint(decode(b).items[0], 'certificate kind'));
function certificateOp(n, params, networkId, redeemer) {
  const it = n.items;
  const type = Number(asUint(it[0], 'certificate kind'));
  const r = redeemer ? { redeemer } : {};
  const reward = () => Cometa.RewardAddress.fromCredentials(networkId, credOf(it[1]));
  const drepId = () => Cometa.cip129DRepFromCredential(credOf(it[1]));
  const deposit = (i) => asUint(it[i], 'deposit');
  const same = (i, x) => x !== null && x !== undefined && deposit(i) === BigInt(x);
  switch (type) {
    case 2: {
      const poolId = Cometa.Bech32.encode('pool', u8(asBytes(it[2], 'pool')));
      return (b) => b.delegateStake({ rewardAddress: reward(), poolId, ...r });
    }
    case 7:
      return same(2, params.keyDeposit) ? (b) => b.registerStakeAddress({ rewardAddress: reward(), ...r }) : null;
    case 8:
      return same(2, params.keyDeposit) ? (b) => b.deregisterStakeAddress({ rewardAddress: reward(), ...r }) : null;
    case 9: {
      const d = it[2];
      const kind = Number(asUint(d.items[0], 'drep'));
      if (kind > 1) return null;
      const target = Cometa.cip129DRepFromCredential({ type: kind, hash: hexOf(asBytes(d.items[1], 'drep')) });
      return (b) => b.delegateVotingPower({ rewardAddress: reward(), drepId: target, ...r });
    }
    case 16: {
      const anchor = anchorOf(it[3]);
      return anchor && same(2, params.drepDeposit) ? (b) => b.registerDRep({ drepId: drepId(), anchor, ...r }) : null;
    }
    case 17:
      return same(2, params.drepDeposit) ? (b) => b.deregisterDRep({ drepId: drepId(), ...r }) : null;
    case 18: {
      const anchor = anchorOf(it[2]);
      return anchor ? (b) => b.updateDRep({ drepId: drepId(), anchor, ...r }) : null;
    }
    default:
      return null;
  }
}

// A parameter update as the library's type (ProtocolParametersUpdate, the
// parameters' own field names). A key it lacks throws.
const PPU = {
  0: ['minFeeA', 'num'], 1: ['minFeeB', 'num'], 2: ['maxBlockBodySize', 'num'], 3: ['maxTxSize', 'num'], 4: ['maxBlockHeaderSize', 'num'],
  5: ['keyDeposit', 'num'], 6: ['poolDeposit', 'num'], 7: ['maxEpoch', 'num'], 8: ['nOpt', 'num'], 9: ['poolPledgeInfluence', 'rat'],
  10: ['expansionRate', 'rat'], 11: ['treasuryGrowthRate', 'rat'], 16: ['minPoolCost', 'num'], 17: ['adaPerUtxoByte', 'num'], 18: ['costModels', 'cost'],
  19: ['executionCosts', 'prices'], 20: ['maxTxExUnits', 'exu'], 21: ['maxBlockExUnits', 'exu'], 22: ['maxValueSize', 'num'], 23: ['collateralPercent', 'num'],
  24: ['maxCollateralInputs', 'num'], 25: ['poolVotingThresholds', 'pool'], 26: ['drepVotingThresholds', 'drep'], 27: ['minCommitteeSize', 'num'],
  28: ['committeeTermLimit', 'num'], 29: ['governanceActionValidityPeriod', 'num'], 30: ['governanceActionDeposit', 'num'], 31: ['drepDeposit', 'num'],
  32: ['drepInactivityPeriod', 'num'], 33: ['refScriptCostPerByte', 'rat']
};
const POOL_KEYS = Object.keys(POOL_T);
const DREP_KEYS = Object.keys(DREP_T);
const LANGUAGES = ['PlutusV1', 'PlutusV2', 'PlutusV3'];
function paramUpdateOf(n) {
  const out = {};
  for (const [k, v] of n.entries) {
    const spec = PPU[Number(asUint(k, 'parameter'))];
    if (!spec) throw new Error(`parameter ${k.value} has no field in the library's type`);
    const [name, kind] = spec;
    if (kind === 'num') out[name] = Number(asUint(v, name));
    else if (kind === 'rat') out[name] = rationalOf(v);
    else if (kind === 'cost') {
      out[name] = v.entries.map(([l, list]) => {
        const language = LANGUAGES[Number(asUint(l, 'language'))];
        if (!language) throw new Error('cost model of an unknown language');
        return { language, costs: list.items.map((x) => Number(asInt(x, 'cost'))) };
      });
    } else if (kind === 'prices') out[name] = { memory: rationalOf(v.items[0]), steps: rationalOf(v.items[1]) };
    else if (kind === 'exu') out[name] = { memory: Number(asUint(v.items[0], 'mem')), steps: Number(asUint(v.items[1], 'steps')) };
    else out[name] = Object.fromEntries((kind === 'pool' ? POOL_KEYS : DREP_KEYS).map((t, i) => [t, rationalOf(v.items[i])]));
  }
  return out;
}

// A proposal as the library's operation on builder b: (b) => void, or a throw
// for an action the adapter does not write through the library.
function proposalOp(n) {
  const [, account, action, anchorNode] = n.items;
  const rewardAddress = Cometa.RewardAddress.fromBytes(u8(asBytes(account, 'reward account')));
  const anchor = anchorOf(anchorNode);
  const a = action.items;
  const kind = Number(asUint(a[0], 'governance action'));
  const optHash = (x) => (x.mt === 7 ? undefined : hexOf(asBytes(x, 'hash')));
  switch (kind) {
    case 0: {
      const protocolParamUpdate = paramUpdateOf(a[2]);
      const policyHash = optHash(a[3]);
      const governanceActionId = govActionIdOf(a[1]);
      return { policyHash, op: (b) => b.proposeParameterChange({ rewardAddress, anchor, protocolParamUpdate, policyHash, governanceActionId }) };
    }
    case 1: {
      const version = { major: Number(asUint(a[2].items[0], 'major')), minor: Number(asUint(a[2].items[1], 'minor')) };
      const governanceActionId = govActionIdOf(a[1]);
      return { policyHash: undefined, op: (b) => b.proposeHardfork({ rewardAddress, anchor, version, governanceActionId }) };
    }
    case 2: {
      const withdrawals = {};
      for (const [k, v] of a[1].entries) withdrawals[Cometa.RewardAddress.fromBytes(u8(asBytes(k, 'reward account'))).toBech32()] = asUint(v, 'withdrawal');
      const policyHash = optHash(a[2]);
      return { policyHash, op: (b) => b.proposeTreasuryWithdrawals({ rewardAddress, anchor, withdrawals, policyHash }) };
    }
    case 3: {
      const governanceActionId = govActionIdOf(a[1]);
      return { policyHash: undefined, op: (b) => b.proposeNoConfidence({ rewardAddress, anchor, governanceActionId }) };
    }
    case 5: {
      const c = a[2].items;
      const constitution = { anchor: anchorOf(c[0]), ...(c[1].mt === 7 ? {} : { scriptHash: hexOf(asBytes(c[1], 'script hash')) }) };
      const governanceActionId = govActionIdOf(a[1]);
      return { policyHash: undefined, op: (b) => b.proposeNewConstitution({ rewardAddress, anchor, constitution, governanceActionId }) };
    }
    case 6:
      return { policyHash: undefined, op: (b) => b.proposeInfoAction({ rewardAddress, anchor }) };
    default:
      throw new Error(`governance action ${kind}: not written through the library`);
  }
}

// A metadatum as the JSON the library reads (auxiliary_data/metadatum.c:
// 197-335), or null when the JSON cannot carry it: a byte string, a map key
// other than text, a repeated key, an integer outside the signed and unsigned
// 64-bit ranges, or text over 64 bytes or holding a NUL, which the library
// would cut.
const INT_MIN = -(2n ** 63n);
const UINT_MAX = 2n ** 64n - 1n;
function jsonOf(n) {
  switch (n.mt) {
    case 0:
    case 1: {
      const v = BigInt(n.value);
      return v < INT_MIN || v > UINT_MAX ? null : v.toString();
    }
    case 3: {
      const s = String(n.value);
      if (Buffer.byteLength(s, 'utf8') > 64 || s.includes('\u0000')) return null;
      return JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    }
    case 4: {
      const items = n.items.map(jsonOf);
      return items.includes(null) ? null : `[${items.join(',')}]`;
    }
    case 5: {
      const seen = new Set();
      const parts = [];
      for (const [k, v] of n.entries) {
        if (k.mt !== 3) return null;
        const key = jsonOf(k);
        const val = jsonOf(v);
        if (key === null || val === null || seen.has(key)) return null;
        seen.add(key);
        parts.push(`${key}:${val}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      return null;
  }
}

// The auxiliary data's metadata as [label, JSON] pairs, or null when it
// carries a script or a metadatum the library's JSON cannot carry.
function metadataJson(hexAux) {
  const n = decode(Buffer.from(hexAux, 'hex'));
  let meta = null;
  if (n.mt === 5) meta = n;
  else if (n.mt === 4) {
    if (n.items[1].items.length) return null;
    meta = n.items[0];
  } else if (n.mt === 6 && n.tag === 259n) {
    for (const [k, v] of n.item.entries) {
      if (Number(k.value) === 0) meta = v;
      else if ((v.mt === 6 ? v.item : v).items.length) return null;
    }
  } else return null;
  const out = [];
  for (const [k, v] of meta ? meta.entries : []) {
    const json = jsonOf(v);
    if (json === null) return null;
    out.push([asUint(k, 'label'), json]);
  }
  return out;
}

// The plan of an intent: the operations that write its requested outputs and
// fixed parts on a builder, and what goes on the transaction after the build,
// or the reason it cannot be expressed. Made afresh for every build.
export function cometaPlan(intent, params, network) {
  try {
    return makePlan(intent, params, network === 'preprod' ? Cometa.NetworkId.Testnet : Cometa.NetworkId.Mainnet);
  } catch (e) {
    if (e instanceof Inexpressible) return { refusal: e.message };
    throw e;
  }
}

function makePlan(intent, params, networkId) {
  const kit = intent.source === 'replay' ? replayRefusal(intent) : null;
  if (kit) refuse(kit);
  const f = intent.source === 'replay' ? intent.fixed : null;
  const scripts = f ? witnessScripts(f) : new Map();
  const datums = witnessDatums(f);
  const redeemer = redeemerTaker(f);
  const unpriced = [];
  const after = { body: new Map(), witnesses: new Map(), aux: null };
  const ops = [];

  // Requested outputs: the payment.
  intent.requested.forEach((o, i) => {
    const what = `requested output ${i}`;
    const d = decodeOutputBytes(Buffer.from(o.cbor, 'hex'));
    if (!d.datum && !d.scriptRef) {
      const address = Cometa.Address.fromBytes(u8(d.address));
      if (!d.assets.length) ops.push((b) => b.sendLovelace({ address, amount: d.coin }));
      else {
        const assets = {};
        for (const a of d.assets) assets[`${a.policy}${a.name}`] = BigInt(a.qty);
        ops.push((b) => b.sendValue({ address, value: { coins: d.coin, assets } }));
      }
      return;
    }
    const out = txOutOf(d, what);
    ops.push((b) => b.addOutput(out));
  });
  if (!f) return { ops, after, unpriced, collateralParts: false };

  if (f.body[15] !== undefined) refuse('body field 15 (network id): the builder never writes it, and a replayed intent carries none');

  // Witness-set scripts, which the library writes when given.
  for (const [h, s] of scripts) {
    const script = exactScript(s.lang, s.bytes, `witness-set script ${h}`);
    s.used = true;
    ops.push((b) => b.addScript(script));
  }
  // Reference inputs.
  for (const x of f.referenceInputs) {
    const utxo = utxoFromCbor(x.cbor);
    ops.push((b) => b.addReferenceInput(utxo));
  }
  // Fixed inputs, each with its redeemer and, for a datum hash, its datum.
  for (const x of f.inputs) {
    const p = unspentOutputParts(x.cbor);
    const utxo = utxoFromCbor(x.cbor);
    const red = redeemer({ kind: 'input', ref: x.ref });
    let datum;
    if (p.datum && p.datum.kind === 'hash' && datums.has(p.datum.hash)) {
      const w = datums.get(p.datum.hash);
      datum = dataOf(w.bytes);
      w.used = true;
    }
    ops.push((b) => b.addInput({ utxo, ...(red ? { redeemer: red } : {}), ...(datum ? { datum } : {}) }));
  }
  // Mint and burn, per asset with its policy's redeemer.
  if (f.body[9] !== undefined) {
    const policyRedeemers = new Map();
    const policyRedeemer = (p) => {
      if (!policyRedeemers.has(p)) policyRedeemers.set(p, redeemer({ kind: 'policy', policy: p }));
      return policyRedeemers.get(p);
    };
    for (const [list, sign] of [[intent.implicit.mint, 1n], [intent.implicit.burn, -1n]]) {
      for (const a of list) {
        const red = policyRedeemer(a.policy);
        const amount = sign * BigInt(a.qty);
        ops.push((b) => b.mintToken({ assetIdHex: `${a.policy}${a.name}`, amount, ...(red ? { redeemer: red } : {}) }));
      }
    }
  }
  // Certificates, each through the builder's operation that writes it, or
  // all of them after the build when one has none.
  if (f.body[4] !== undefined) {
    const items = listItems(f.body[4]);
    const deposits = { ...params, ...spendDeposits(f, params) };
    const certOps = items.map((bytes, i) => certificateOp(decode(bytes), deposits, networkId, redeemer.peek({ kind: 'certificate', index: i })));
    if (certOps.every(Boolean)) {
      items.forEach((_, i) => redeemer({ kind: 'certificate', index: i }));
      ops.push(...certOps);
    } else {
      if (f.redeemers.some((r) => r.tag === 2)) refuse('a certificate no operation of the builder writes, in a transaction whose certificates need redeemers it could not attach');
      after.body.set(4, Buffer.from(f.body[4], 'hex'));
      unpriced.push('certificates');
    }
  }
  // Withdrawals.
  if (f.body[5] !== undefined) {
    for (const [k, v] of decode(Buffer.from(f.body[5], 'hex')).entries) {
      const account = asBytes(k, 'reward account');
      const rewardAddress = Cometa.RewardAddress.fromBytes(u8(account));
      const amount = asUint(v, 'withdrawal');
      const red = redeemer({ kind: 'withdrawal', account: hexOf(account) });
      ops.push((b) => b.withdrawRewards({ rewardAddress, amount, ...(red ? { redeemer: red } : {}) }));
    }
  }
  // Votes, per voter and action.
  if (f.body[19] !== undefined) {
    const buf = Buffer.from(f.body[19], 'hex');
    for (const [voterNode, votes] of decode(buf).entries) {
      const type = Number(asUint(voterNode.items[0], 'voter kind'));
      const hash = hexOf(asBytes(voterNode.items[1], 'voter'));
      const voter = { type, credential: { type: type === 1 || type === 3 ? 1 : 0, hash } };
      const red = redeemer({ kind: 'voter', voter: hexOf(raw(buf, voterNode)) });
      votes.entries.forEach(([id, pv], j) => {
        const actionId = govActionIdOf(id);
        const votingProcedure = { vote: Number(asUint(pv.items[0], 'vote')), anchor: anchorOf(pv.items[1]) };
        const r = j === 0 ? red : undefined;
        ops.push((b) => b.vote({ voter, actionId, votingProcedure, ...(r ? { redeemer: r } : {}) }));
      });
    }
  }
  // Proposals, each through the operation of its action's kind; the library
  // adds a guardrail script's redeemer itself.
  if (f.body[20] !== undefined) {
    const items = listItems(f.body[20]);
    let props;
    try {
      props = items.map((b) => proposalOp(decode(b)));
    } catch (e) {
      passMachineErrors(e);
      if (f.redeemers.some((r) => r.tag === 5)) refuse(`a proposal the library has no operation for (${errorText(e)}), in a transaction whose proposals need redeemers it could not attach`);
      props = null;
    }
    if (props) {
      props.forEach((p, i) => {
        redeemer({ kind: 'proposal', index: i });
        ops.push(p.op);
      });
    } else {
      after.body.set(20, Buffer.from(f.body[20], 'hex'));
      unpriced.push('proposals');
    }
  }
  // Required signers, validity, donation.
  for (const h of requiredSigners(f)) ops.push((b) => b.addSigner(h));
  const slot = (k) => asUint(decode(Buffer.from(f.body[k], 'hex')), 'slot');
  if (f.body[8] !== undefined) {
    const s = slot(8);
    ops.push((b) => b.setInvalidBefore(s));
  }
  if (f.body[3] !== undefined) {
    const s = slot(3);
    ops.push((b) => b.setInvalidAfter(s));
  }
  if (f.body[22] !== undefined) {
    const donation = asUint(decode(Buffer.from(f.body[22], 'hex')), 'donation');
    ops.push((b) => b.setDonation(donation));
  }
  if (f.body[21] !== undefined) {
    after.body.set(21, Buffer.from(f.body[21], 'hex'));
    unpriced.push('current treasury value');
  }
  // Auxiliary data: its metadata through setMetadata, or the observed bytes
  // after the build.
  if (f.auxiliaryData) {
    const meta = metadataJson(f.auxiliaryData);
    if (meta) for (const [tag, metadata] of meta) ops.push((b) => b.setMetadata({ tag, metadata }));
    else {
      after.aux = Buffer.from(f.auxiliaryData, 'hex');
      unpriced.push('auxiliary data');
    }
  }
  // Every redeemer goes with its part.
  const leftRed = redeemer.left();
  if (leftRed.length) refuse(`a redeemer whose part the library does not take (tag ${leftRed[0].tag})`);
  // Datums no input took.
  for (const d of datums.values()) {
    if (d.used) continue;
    const datum = dataOf(d.bytes);
    ops.push((b) => b.addDatum(datum));
  }
  if (f.witnesses[2] !== undefined) {
    after.witnesses.set(2, listItems(f.witnesses[2]));
    unpriced.push('bootstrap witnesses');
  }
  return { ops, after, unpriced };
}

// The transaction the library built with the parts written after the build:
// body fields set or replaced, witness-set lists set, and the auxiliary data
// replaced with its hash. Fields keep the library's order; a new one goes
// after them.
function withPartsAfter(hexTx, after) {
  if (!after.body.size && !after.witnesses.size && !after.aux) return hexTx;
  const buf = Buffer.from(hexTx, 'hex');
  const [bodyNode, witNode, validNode, auxNode] = decode(buf).items;
  const body = new Map(after.body);
  if (after.aux) body.set(7, encBytes(blake2b256(after.aux)));
  const mapBytes = (node, replace) => {
    const entries = node.entries.map(([k, v]) => [Number(k.value), raw(buf, k), raw(buf, v)]);
    const out = [];
    const seen = new Set();
    for (const [k, kb, vb] of entries) {
      seen.add(k);
      out.push(kb, replace(k, vb) ?? vb);
    }
    const added = [...(replace.keys || [])].filter((k) => !seen.has(k)).sort((a, b) => a - b);
    for (const k of added) out.push(encUint(k), replace(k, null));
    return Buffer.concat([head(5, out.length / 2), ...out]);
  };
  const bodyReplace = (k) => body.get(k);
  bodyReplace.keys = body.keys();
  const witReplace = (k, vb) => {
    const extra = after.witnesses.get(k);
    if (!extra) return undefined;
    const items = vb ? listItems(vb) : [];
    return Buffer.concat([head(4, items.length + extra.length), ...items, ...extra]);
  };
  witReplace.keys = after.witnesses.keys();
  const aux = after.aux || raw(buf, auxNode);
  return Buffer.concat([Buffer.from([0x84]), mapBytes(bodyNode, bodyReplace), mapBytes(witNode, witReplace), raw(buf, validNode), aux]).toString('hex');
}

// The builder's evaluator (txEvaluator/TxEvaluator.ts:27-42): each of the
// library's redeemers in the draft it is given, with the intent's observed
// execution units for the part the ledger reads its tag and index as naming.
// A redeemer with no observed counterpart fails the build.
const PURPOSE = ['spend', 'mint', 'certificate', 'withdrawal', 'vote', 'propose'];
function evaluatorFor(intent) {
  const f = intent.fixed;
  const byKey = new Map();
  for (const r of f ? f.redeemers : []) if (!byKey.has(targetKey(r.target))) byKey.set(targetKey(r.target), r);
  return {
    getName: () => 'replay',
    async evaluate(tx) {
      const ins = inspectTx(tx);
      const targetOf = redeemerTargets(ins.tx);
      return ins.redeemers.map((r) => {
        const target = targetOf(r);
        const o = target ? byKey.get(targetKey(target)) : undefined;
        if (!o) throw new Error(`the library's redeemer ${r.tag}:${r.index} has no observed redeemer`);
        return { index: r.index, purpose: PURPOSE[r.tag], data: dataOf(Buffer.from(r.data, 'hex')), executionUnits: { memory: Number(o.exUnits[0]), steps: Number(o.exUnits[1]) } };
      });
    }
  };
}

// TransactionBuilder.build (txBuilder/TransactionBuilder.ts:1854-1883), step
// for step, keeping the C result code the wrapper drops: many of the balancing
// loop's failures leave the builder's message empty, so the error carries the
// library's own name for the code (error_to_string, error.c) after the
// message.
async function buildTx(b) {
  const module = Cometa.getModule();
  const txPtrPtr = module._malloc(4);
  let txPtr = 0;
  try {
    Cometa.asyncifyStateTracker.isAsyncActive = false;
    let result = module.tx_builder_build(b.ptr, txPtrPtr);
    if (Cometa.asyncifyStateTracker.isAsyncActive) result = await module.Asyncify.whenDone();
    if (result !== 0) {
      const message = module.UTF8ToString(module.tx_builder_get_last_error(b.ptr));
      throw new Error(`Transaction build failed: ${message} (${Cometa.getErrorString(result)})`);
    }
    txPtr = module.getValue(txPtrPtr, 'i32');
    if (!txPtr) throw new Error('Transaction build returned a null pointer despite success code.');
    return Cometa.writeTransactionToCbor(txPtr);
  } finally {
    Cometa.unrefObject(txPtr);
    module._free(txPtrPtr);
  }
}

// Whether the inputs offered (the candidates, the fixed inputs and the mint)
// leave tokens over after the requested outputs and the burn.
function leavesTokens(pool, intent) {
  const fixed = fixedInputValues(intent);
  const have = assetMap(mergeAssets([...pool, ...fixed].flatMap((u) => u.assets), intent.implicit.mint || []));
  const sent = assetMap(mergeAssets(intent.requested.flatMap((o) => o.assets), intent.implicit.burn || []));
  for (const [k, q] of have) if (q > (sent.get(k) || 0n)) return true;
  return false;
}

// The parameters a spend needs that the run must state.
function neededParameters(intent, params) {
  const f = intent.source === 'replay' ? intent.fixed : null;
  if (!f) return;
  if (f.redeemers.length) {
    need(params, 'priceMem');
    need(params, 'priceStep');
  }
  if (f.referenceInputs.some((u) => unspentOutputParts(u.cbor).scriptRef)) need(params, 'minFeeRefScriptCostPerByte');
}

// Builds the intent with the library. It refuses nothing the method below
// refuses first.
export async function buildCometa(T, state, intent, params, opts, { name = 'cometa-lf' } = {}) {
  const layout = opts.changePolicy === 'layout';
  if (opts.changePolicy !== 'default' && !layout) return { ok: false, class: CLASSES.other, detail: 'the Cometa baseline takes its own change or the layout change only' };
  const replay = intent.source === 'replay';
  const f = replay ? intent.fixed : null;
  const collateral = opts.collateral || null;
  if (intent.collateral && intent.collateral.required && !collateral) throw new Error(`${name}: a script spend needs the collateral the engine sets aside`);
  let plan;
  try {
    plan = cometaPlan(intent, params, state.network);
    if (plan.refusal) return { ok: false, class: NOT_REPLAYABLE, detail: plan.refusal };
    neededParameters(intent, params);
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: CLASSES.other, detail: `replay parts: ${errorText(e)}` };
  }
  const fixedRefs = new Set(f ? f.inputs.map((x) => x.ref) : []);
  const pool = inputOrder(state).filter((u) => !fixedRefs.has(u.ref));
  let b;
  try {
    b = Cometa.TransactionBuilder.create({ params: cometaParams(params, spendDeposits(f, params)), slotConfig: slotConfigOf(state.network) });
    b.setUtxos(pool.map(utxoOf));
    for (const op of plan.ops) op(b);
    b.setChangeAddress(Cometa.Address.fromBytes(u8(addressBytes(state.changeAddress))));
    // The builder asks for a collateral change address and collateral UTxOs
    // whenever the transaction carries redeemers or datums
    // (transaction_builder.c:4929-4950); it takes collateral only when it
    // carries redeemers and the list is not empty (collateral.c:239-252).
    if (collateral || (f && (f.redeemers.length || f.witnesses[4] !== undefined))) {
      b.setCollateralUtxos(collateral ? [utxoOf(collateral)] : []);
      b.setCollateralChangeAddress(Cometa.Address.fromBytes(u8(addressBytes(state.changeAddress))));
    }
    if (f && f.redeemers.length) b.setTxEvaluator(evaluatorFor(intent));
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: CLASSES.other, detail: `replay parts: ${errorText(e)}` };
  }
  let built;
  try {
    built = await buildTx(b);
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: classOfCometaError(e, { tokenChange: leavesTokens(pool, intent) }), detail: `build: ${errorText(e)}` };
  }
  const ins = inspectTx(built);
  const refs = ins.inputs.map((i) => i.ref);
  for (const x of fixedRefs) if (!refs.includes(x)) return { ok: false, class: CLASSES.other, detail: `the library left out the fixed input ${x}` };
  const walletRefs = refs.filter((x) => !fixedRefs.has(x));
  const records = recordsOf(state, walletRefs);
  if (collateral && ins.collateralInputs.length && ins.collateralInputs.some((i) => i.ref !== collateral.ref)) return { ok: false, class: CLASSES.other, detail: 'the library took collateral other than the UTxO set aside' };
  if (layout) {
    const r = buildWithChange(T, { state, params, inputs: records, intent, policy: 'layout', collateral });
    if (!r.ok) return { ok: false, class: r.class, detail: `layout change on the library's inputs: ${r.detail}` };
    return { ok: true, kind: 'single', txs: [txRecord(r.bytes, walletRefs, r.fee, r.size, r.k)] };
  }
  // The vkey witnesses: the wallet's keys, synthetic, then the intent's other
  // vkey witnesses as observed, encoded by the library.
  const usedCollateral = ins.collateralInputs.length ? [collateral] : [];
  const keys = replayWitnessKeys(f, { inputs: records, collateral: usedCollateral });
  const others = f && f.witnesses[0] !== undefined ? listItems(f.witnesses[0]) : [];
  const vkeys = [...syntheticVkeys(T, keys.size), ...others].map((w) => {
    const [vkey, signature] = decode(w).items;
    return { vkey: hexOf(asBytes(vkey, 'vkey')), signature: hexOf(asBytes(signature, 'signature')) };
  });
  // The keys the library priced a witness for: the signers its balancing
  // loop counts over the resolved inputs and collateral.
  const resolved = [...(f ? f.inputs.map((x) => utxoFromCbor(x.cbor)) : []), ...records.map(utxoOf), ...usedCollateral.map(utxoOf)];
  let bytes;
  let priced;
  try {
    priced = Cometa.getUniqueSigners(built, resolved).length;
    bytes = withPartsAfter(vkeys.length ? Cometa.applyVkeyWitnessSet(built, vkeys) : built, plan.after);
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: CLASSES.other, detail: `witnesses: ${errorText(e)}` };
  }
  const size = inspectTx(bytes).size;
  const fee = ins.fee;
  const scriptFee = f ? f.scriptFee : 0n;
  const observedUnpriced = others.length > 0 && vkeys.length > priced;
  return {
    ok: true,
    kind: 'single',
    txs: [txRecord(bytes, walletRefs, fee, size, keys.size)],
    library: { fee, finalMinFee: minFee(params, size, scriptFee), priced, unpriced: observedUnpriced ? [...plan.unpriced, 'observed vkey witnesses'] : plan.unpriced }
  };
}

export function cometaMethod(T) {
  const name = 'cometa-lf';
  return {
    name,
    version: `@biglup/cometa ${COMETA_VERSION} (cardano-c ${CARDANO_C_VERSION}) large-first`,
    deterministic: true,
    seeded: true,
    async build(state, intent, params, opts) {
      refuseUncovered(name, REPLAY_COVERAGE.cometa, intent);
      return buildCometa(T, state, intent, params, opts, { name });
    }
  };
}
