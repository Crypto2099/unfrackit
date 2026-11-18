// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The typhonjs baseline, typhon-lp: @stricahq/typhonjs 4.0.0 (StricaHQ/typhonjs
// at 7190c3c67e9dc7be284842e89f06ed848b748ed2, the tag v4.0.0 and the npm
// gitHead; paths below are under src/), called as a wallet calls it for a
// payment: new Transaction({ protocolParams }).paymentTransaction({ inputs,
// outputs, changeAddress, ttl }), with the spendable UTxOs in the state's order
// (inputOrder) as `inputs`, the requested outputs, the state's change address
// and the intent's validity end as the TTL. Nothing reaches a network. Its
// change policies are its own ('default') and UnFrack.It's layout change on
// the inputs the library selected ('layout'); no other change policy is
// accepted.
//
// Its selection is a prefix of the caller's list, so the order the adapter
// hands it, the state's (transaction id bytes, then output index, ascending),
// is the whole outcome: the library neither sorts nor filters the list, and
// ties do not arise.
//
// The library, at that commit:
//   transaction/helpers/paymentTransaction.ts:4-33: a new Transaction, each
//   output added (addOutput), setTTL(ttl), then prepareTransaction({ inputs,
//   changeAddress }); Transaction.ts:1071-1092 is the same call on an
//   instance's parameters.
//   Transaction.ts:1034-1065, prepareTransaction: checks the optional
//   parameters the transaction needs (:992-1010), sets a placeholder fee and
//   runs transactionBuilder; on any error it puts the transaction back as it
//   was and rethrows.
//   transaction/helpers/transactionBuilder.ts:133-141: the candidates are the
//   caller's list less duplicates and inputs already on the transaction, in
//   the caller's order; no sort and no filter by content. :145-151: when the
//   transaction has no input yet, the first candidate is added whatever it
//   holds. :153-223: for each further candidate in order, the inputs already
//   on the transaction are tested first and the candidate is added only when
//   they fall short: with no token left over, they suffice when they pay the
//   outputs and the fee exactly (:168-170) or leave more than the ADA-only
//   minimum and at least the fee with a change output plus that minimum
//   (:171-182); with tokens left over and none short, when the leftover ADA
//   pays the fee and every change set's minimum (:184-220); with a token
//   short, never (:222). The selection is the shortest prefix (after the
//   first) that pays the outputs, the deposits, the donation, the fee and the
//   change, the fee recomputed on every candidate (feeWithCollateral,
//   :102-109).
//   Change (:225-329): with no token left over, one ADA-only output when the
//   leftover less the fee is at least the ADA-only minimum (:241-257); else a
//   leftover under 2 ADA (MAX_CHANGE_AS_FEE, :15) becomes the fee when it pays
//   the fee (:258-265); else "Not enough ADA" (:266-271). With tokens left
//   over, the tokens are split into sets under maxValueSize
//   (getMaximumTokenSets, utils/utils.ts:228-267, a set's value tested as
//   < maxValueSize), each set an output at its own minimum and the last set
//   taking the rest of the ADA (:272-326); a set whose ADA cannot be paid is
//   "Not enough ADA" (:291-299). A token short is "Not enough tokens"
//   (:327-329).
//   Size (:331-335): after the change, calculateTxSize() over maxTxSize is
//   "Tx size limit reached, try spending lesser ADA/Tokens". No input cap.
//   Fee (Transaction.ts:696-729): minFeeA * size + minFeeB, plus the
//   execution units at the prices (one ceiling over the total, :627-653) and
//   the reference scripts' fee (:673-694), on the serialized transaction with
//   one dummy vkey witness per distinct key it counts (the key credentials of
//   its inputs, collateral, certificates, withdrawals and voters, its required
//   signers and every key a native script names; :697-711). It draws nothing
//   at random.
//   Outputs are always written in the map form (utils/encoder.ts:252-273).
//
// Witnesses (setting serialization 'own'): one synthetic vkey witness per
// wallet key (kit/replay.mjs replayWitnessKeys) and the intent's other vkey
// witnesses as observed, given to the library with addWitness
// (Transaction.ts:743-745) before buildTransaction (:766-782), which encodes
// them.
//
// Errors to failure classes (setting unclassified 'other' for the rest):
//   "Not enough tokens" (transactionBuilder.ts:328), "No inputs to spend"
//   (:148)                                                     balance
//   "Not enough ADA" (:262, :267, :270, :294, :299): every candidate was added
//   and still fell short. When the inputs offered (the candidates, the fixed
//   inputs and the mint) leave tokens over after the outputs, the shortfall is
//   the token change's minimum ADA (:291-299)                  change-minimum
//   otherwise                                                  balance
//   "Tx size limit reached, try spending lesser ADA/Tokens" (:331-335)
//                                                              tx-size
//   "Token does not fit in an output within maxValueSize"
//   (utils/utils.ts:261-263)                                   value-size
//   "Not enough collateral supplied", "Tokens of the collateral don't fit in
//   a collateral return" (transactionBuilder.ts:116-124)       collateral
// A part of the intent the library's operations refuse is class other with
// "replay parts: ".
//
// The replay path: every intent the history reader writes (source 'replay')
// is built with the run's parameters as the library's (typhonParams below;
// the language views empty, as the run holds no cost models, so the
// script-data hash is 32 bytes over them, as no check reads it). A plain
// payment (no fixed parts) is the call above. An intent with fixed parts or a
// set-aside collateral is the same sequence written out, as paymentTransaction
// is: a new Transaction, the requested outputs, setTTL, setAuxiliaryData,
// then the fixed parts through the library's operations, then
// prepareTransaction({ inputs, changeAddress, collateralInputs }):
//   requested outputs   addOutput with the output's address, coin, tokens,
//                       datum and script reference read from its bytes
//                       (Transaction.ts:291-297); a hash datum whose datum the
//                       witness set holds carries it, which the library writes
//                       there (:285-289)
//   fixed inputs        addInput (:202-217): its own reference script as the
//                       input's script, the witness set's script for its
//                       payment credential on the credential, its redeemer,
//                       and for a datum hash the witness set's datum
//   reference inputs    addReferenceInput (:225-231) with the reference script
//                       the UTxO holds, which the library prices
//                       (:655-694) and keeps out of the witness set (:476-493)
//   mint and burn       addMint per policy, a burn as a negative quantity,
//                       with the policy's script and redeemer (:251-260)
//   certificates        addCertificate (:268-281), kinds 0 to 2 and 7 to 18
//                       as the library's types, in the intent's order, each
//                       with its credential's script and its redeemer; the
//                       library counts the deposits and refunds of kinds 0, 1,
//                       7, 8, 11 to 13, 16 and 17 (:903-956)
//   withdrawals         addWithdrawal per reward account (:299-316)
//   votes               addVotingProcedure per voter (:319-328)
//   proposals           addProposalProcedure (:330-338), every governance
//                       action as the library's type, the policy script and
//                       redeemer with it; the library counts the deposit
//   required signers    addRequiredSigner (:233-235)
//   validity            setTTL and setValidityIntervalStart, in slots
//   auxiliary data      setAuxiliaryData with its metadata as the library's
//                       values; the library writes the Conway form, tag 259
//                       (utils/encoder.ts:741-761)
//   donation, treasury  setDonationAmount, setTreasuryAmount (:364-378)
//   redeemers           on their parts, with the intent's observed execution
//                       units and data; the library numbers them
//                       (utils/encoder.ts:586-665)
//   collateral          the UTxO the engine set aside, as prepareTransaction's
//                       collateralInputs (transactionBuilder.ts:92-131): the
//                       library takes it when the transaction runs Plutus
//                       scripts, sets the total collateral and returns the
//                       rest to the change address, or fails with "Not enough
//                       collateral supplied" when it does not cover the fee
// A datum, a native script and an address are written by the library from its
// own types, so each is checked first: the library's encoding of the datum or
// script must give the observed bytes (createPlutusDataCbor,
// NativeScriptFactory), since another encoding is another datum hash or script
// hash, and a requested output's address must re-encode to its bytes.
// A part the library has no type for (unpricedParts) is written on the
// transaction it built, through the kit's CBOR, as every library's replay
// does: the certificates, all of them in the intent's order, when one is of
// kind 3 to 6 (pool registration and retirement, genesis delegation, MIR);
// the proposals when a governance action carries a parameter the library's
// type lacks; auxiliary data carrying scripts or a metadatum the library
// refuses (AuxiliaryData holds metadata only, types.ts:464-468), with its
// hash; witness-set datums and scripts no operation takes; and bootstrap
// witnesses. The library's fee does not count such a part, and a value it did
// not balance (a pool deposit, a proposal's deposit) stays unbalanced; the
// kit's checks say which (library.unpriced names the parts). When the
// transaction then carries more vkey witnesses than the library priced,
// library.unpriced names the observed ones.
// Not replayable (the plan's refusal): body field 6, as for every adapter
// (kit/replay.mjs replayRefusal); body field 15, which the library never
// writes; a Byron address on a fixed input, from which addInput reads a
// payment credential (Transaction.ts:206); a datum, native script or address
// the library's encoding does not reproduce (it writes every non-empty list
// and constructor field list indefinite, utils/encoder.ts:798-858); a Plutus
// script whose bytes are not a CBOR byte string, which the library refuses
// (utils/encoder.ts:126-149); a part written after the build that needs a
// redeemer; and a redeemer whose part the library does not take.
//
// The layout change (opts.changePolicy 'layout'): the library builds its
// transaction exactly as for its own change; the wallet inputs it selected are
// read from it (getInputs), its change is dropped, and the simulator's layout
// change (methods/change.mjs) is built on those inputs, the kit assembling the
// transaction at its exact fee with the intent's fixed parts and the
// collateral the engine set aside, as for cardano-js-sdk, CSL and Blaze. A
// library that fails to build fails before this point, as for its own change.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Transaction, NativeScriptFactory, utils as TU } from '@stricahq/typhonjs';
import { CLASSES } from '../kit/check.mjs';
import { passMachineErrors } from '../kit/machine.mjs';
import { unspentOutputParts, inspectTx } from '../kit/inspect.mjs';
import { replayRefusal, listItems, requiredSigners, replayWitnessKeys, targetKey, syntheticVkeys, fixedInputValues } from '../kit/replay.mjs';
import { blake2b256, blake2b224 } from '../history/blake2b.mjs';
import { addressBytes } from '../history/address.mjs';
import { decodeOutputBytes } from '../history/output.mjs';
import { assetMap, mergeAssets } from '../history/value.mjs';
import { minFee } from '../kit/fee.mjs';
import { need } from '../kit/params.mjs';
import { decode, raw, head, encUint, encBytes, asUint, asBytes } from '../history/cbor.mjs';
import { NOT_REPLAYABLE } from './contract.mjs';
import { buildWithChange } from './change.mjs';
import { inputOrder, recordsOf, refuseUncovered, REPLAY_COVERAGE, errorText, txRecord } from './library.mjs';

export const TYPHON_VERSION = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('@stricahq/typhonjs/package.json'), 'utf8')).version;
if (TYPHON_VERSION !== '4.0.0') throw new Error(`@stricahq/typhonjs ${TYPHON_VERSION} is installed; the baseline is 4.0.0`);

const hexOf = (b) => Buffer.from(b).toString('hex');
const u8 = (b) => new Uint8Array(Buffer.from(b));
const u8hex = (h) => new Uint8Array(Buffer.from(h, 'hex'));

// The library's credential and script types (types.ts:19-22, 24-28).
const KEY = 0;
const SCRIPT = 1;
const PLUTUS_TYPE = { 1: 'PlutusScriptV1', 2: 'PlutusScriptV2', 3: 'PlutusScriptV3' };

// The class of a library error. tokenChange: whether the inputs offered leave
// tokens over after the outputs.
export function classOfTyphonError(e, { tokenChange = false } = {}) {
  const m = errorText(e);
  if (/^Not enough ADA$/.test(m)) return tokenChange ? CLASSES.changeMinimum : CLASSES.balance;
  if (/^Not enough tokens$/.test(m)) return CLASSES.balance;
  if (/^No inputs to spend$/.test(m)) return CLASSES.balance;
  if (/^Tx size limit reached/.test(m)) return CLASSES.txSize;
  if (/^Token does not fit in an output within maxValueSize$/.test(m)) return CLASSES.valueSize;
  if (/^Not enough collateral supplied$/.test(m)) return CLASSES.collateral;
  if (/^Tokens of the collateral don't fit in a collateral return$/.test(m)) return CLASSES.collateral;
  return CLASSES.other;
}

// The run's parameters as the library's (types.ts:543-555). A parameter the
// run does not state is left undefined; the plan asks for those a spend needs
// before it builds.
const orUndefined = (x) => (x === null || x === undefined ? undefined : x);
const pair = (r) => (r === null ? undefined : [r[0], r[1]]);
export function typhonParams(params) {
  return {
    minFeeA: params.minFeeA,
    minFeeB: params.minFeeB,
    stakeKeyDeposit: orUndefined(params.keyDeposit),
    utxoCostPerByte: params.coinsPerUtxoByte,
    maxValueSize: params.maxValSize,
    maxTxSize: params.maxTxSize,
    minFeeRefScriptCostPerByte: pair(params.minFeeRefScriptCostPerByte),
    collateralPercent: params.collateralPercent,
    priceMem: pair(params.priceMem),
    priceSteps: pair(params.priceStep),
    languageView: { PlutusScriptV1: [], PlutusScriptV2: [], PlutusScriptV3: [] }
  };
}

// Why the library cannot express a part, as an error the plan turns into the
// intent's refusal.
class Inexpressible extends Error {}
const refuse = (why) => {
  throw new Inexpressible(why);
};

const tokensOf = (assets) => assets.map((a) => ({ policyId: a.policy, assetName: a.name, amount: BigInt(a.qty) }));

// An address of the library's from its bytes (utils/utils.ts:124-222).
const addressOf = (bytes) => TU.getAddressFromHex(u8(bytes));

// Plutus data of the library's (types.ts:475-486) from a CBOR node: integers
// as bigint, bignums (tags 2 and 3) as bigint, byte strings, lists, maps and
// constructors (tags 121 to 127, 1280 to 1400, and 102).
function plutusDataOf(n) {
  const fields = (x) => {
    if (x.mt !== 4) throw new Error('constructor fields: expected a list');
    return x.items.map(plutusDataOf);
  };
  switch (n.mt) {
    case 0:
    case 1:
      return n.value;
    case 2:
      return u8(n.value);
    case 4:
      return n.items.map(plutusDataOf);
    case 5:
      return new Map(n.entries.map(([k, v]) => [plutusDataOf(k), plutusDataOf(v)]));
    case 6: {
      const t = Number(n.tag);
      if (t >= 121 && t <= 127) return { constructor: t - 121, fields: fields(n.item) };
      if (t >= 1280 && t <= 1400) return { constructor: t - 1280 + 7, fields: fields(n.item) };
      if (t === 102 && n.item.mt === 4 && n.item.items.length === 2) return { constructor: Number(asUint(n.item.items[0], 'constructor')), fields: fields(n.item.items[1]) };
      if ((t === 2 || t === 3) && n.item.mt === 2) {
        const v = n.item.value.length ? BigInt(`0x${hexOf(n.item.value)}`) : 0n;
        return t === 2 ? v : -1n - v;
      }
      break;
    }
    default:
      break;
  }
  throw new Error(`not Plutus data (major type ${n.mt})`);
}

// The datum's bytes as the library's Plutus data, which its encoding
// (createPlutusDataCbor, utils/utils.ts:274-277; utils/encoder.ts:830-867)
// must give back exactly: another encoding is another datum.
function exactPlutusData(bytes, what) {
  const b = Buffer.from(bytes);
  let d;
  try {
    d = plutusDataOf(decode(b));
  } catch (e) {
    refuse(`${what}: ${errorText(e)}`);
  }
  if (hexOf(TU.createPlutusDataCbor(d)) !== hexOf(b)) refuse(`${what}: the library's Plutus data encoding does not reproduce its bytes`);
  return d;
}

// Redeemer data, which no hash covers: the library writes it in its own
// encoding.
const redeemerDataOf = (hex) => plutusDataOf(decode(Buffer.from(hex, 'hex')));

// A native script of the library's (types.ts:70-101) from its bytes, which
// the library's encoding must give back exactly (NativeScriptFactory,
// misc/NativeScriptFactory.ts:12-16): another encoding is another script hash.
function nativeScriptOf(n) {
  const kind = Number(asUint(n.items[0], 'native script'));
  const list = (x) => x.items.map(nativeScriptOf);
  switch (kind) {
    case 0:
      return { pubKeyHash: hexOf(asBytes(n.items[1], 'key hash')) };
    case 1:
      return { all: list(n.items[1]) };
    case 2:
      return { any: list(n.items[1]) };
    case 3:
      return { n: Number(asUint(n.items[1], 'n')), k: list(n.items[2]) };
    case 4:
      return { invalidBefore: Number(asUint(n.items[1], 'slot')) };
    case 5:
      return { invalidAfter: Number(asUint(n.items[1], 'slot')) };
    default:
      throw new Error(`native script kind ${kind}`);
  }
}
function exactNativeScript(bytes, what) {
  const b = Buffer.from(bytes);
  let s;
  try {
    s = nativeScriptOf(decode(b));
  } catch (e) {
    refuse(`${what}: ${errorText(e)}`);
  }
  if (hexOf(new NativeScriptFactory(s).cbor()) !== hexOf(b)) refuse(`${what}: the library's native script encoding does not reproduce its bytes`);
  return s;
}

// A script as the library takes it on a credential, an input, a mint or a
// proposal: { plutusScript: { cborHex, type } } or { nativeScript }. A Plutus
// script is given as the bytes the ledger hashes (types.ts:142-150).
function scriptFields(lang, bytes, what) {
  if (lang === 0) return { nativeScript: exactNativeScript(bytes, what) };
  // The library reads a Plutus script's bytes as a CBOR byte string and
  // refuses any other (utils/encoder.ts:126-149).
  let n = null;
  try {
    n = decode(Buffer.from(bytes));
  } catch (e) {
    passMachineErrors(e);
  }
  if (!n || n.mt !== 2) refuse(`${what}: a Plutus script whose bytes are not a CBOR byte string, which the library refuses (utils/encoder.ts:126-149)`);
  return { plutusScript: { cborHex: hexOf(bytes), type: PLUTUS_TYPE[lang] } };
}

// A UTxO's reference script as the library's script fields, or {}.
function ownScript(p, what) {
  if (!p.scriptRef) return {};
  return scriptFields(p.scriptRef.lang, Buffer.from(p.scriptRef.script, 'hex'), `${what}'s reference script`);
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
    for (const r of listItems(f.witnesses[key])) put(lang, asBytes(decode(r), 'plutus script'));
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
    return { plutusData: redeemerDataOf(e.r.data), exUnits: { mem: Number(e.r.exUnits[0]), steps: Number(e.r.exUnits[1]) } };
  };
  take.left = () => [...m.values()].filter((e) => !e.used).map((e) => e.r);
  return take;
}

// Certificate kinds with a type of the library's (types.ts:166-182).
const CERT_KINDS = new Set([0, 1, 2, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
const certKind = (b) => Number(asUint(decode(b).items[0], 'certificate kind'));

const anchorOf = (n) => (n.mt === 7 ? null : { url: n.items[0].value, hash: u8(asBytes(n.items[1], 'anchor hash')) });
const govActionIdOf = (n) => (n.mt === 7 ? null : { txId: u8(asBytes(n.items[0], 'gov action id')), index: Number(asUint(n.items[1], 'gov action index')) });
const rationalOf = (n) => {
  const x = n.mt === 6 ? n.item : n;
  return [asUint(x.items[0], 'numerator'), asUint(x.items[1], 'denominator')];
};
const optHash = (n) => (n.mt === 7 ? null : u8(asBytes(n, 'hash')));

// The parameter update of a parameter-change action as the library's type
// (types.ts:563-620; utils/encoder.ts:1014-1101). A key the type lacks throws.
const PPU = {
  0: ['minFeeA', 'big'], 1: ['minFeeB', 'big'], 2: ['maxBlockBodySize', 'num'], 3: ['maxTransactionSize', 'num'], 4: ['maxBlockHeaderSize', 'num'],
  5: ['stakeKeyDeposit', 'big'], 6: ['poolDeposit', 'big'], 7: ['poolRetireMaxEpoch', 'num'], 8: ['n', 'num'], 9: ['pledgeInfluence', 'rat'],
  10: ['expansionRate', 'rat'], 11: ['treasuryGrowthRate', 'rat'], 16: ['minPoolCost', 'big'], 17: ['adaPerUtxoByte', 'big'], 18: ['costMdls', 'cost'],
  19: ['exUnitPrices', 'prices'], 20: ['maxTxExUnits', 'exu'], 21: ['maxBlockExUnits', 'exu'], 22: ['maxValueSize', 'num'], 23: ['collateralPercent', 'num'],
  24: ['maxCollateralInputs', 'num'], 25: ['poolVotingThreshold', 'pool'], 26: ['dRepVotingThreshold', 'drep'], 27: ['minCommitteeSize', 'num'],
  28: ['committeeTermLimit', 'num'], 29: ['govActionValidity', 'num'], 30: ['govActionDeposit', 'big'], 31: ['dRepDeposit', 'big'], 32: ['dRepInactivity', 'num'],
  33: ['refScriptCostByte', 'rat']
};
const POOL_T = ['motionNoConfidence', 'committeeNormal', 'committeeNoConfidence', 'hfInitiation', 'securityParamVoting'];
const DREP_T = ['motionNoConfidence', 'committeeNormal', 'committeeNoConfidence', 'updateConstitution', 'hfInitiation', 'networkParamVoting', 'economicParamVoting', 'technicalParamVoting', 'govParamVoting', 'treasuryWithdrawal'];
function paramUpdateOf(n) {
  const out = {};
  for (const [k, v] of n.entries) {
    const spec = PPU[Number(asUint(k, 'parameter'))];
    if (!spec) throw new Error(`parameter ${k.value} has no field in the library's type`);
    const [name, kind] = spec;
    if (kind === 'big') out[name] = asUint(v, name);
    else if (kind === 'num') out[name] = Number(asUint(v, name));
    else if (kind === 'rat') out[name] = rationalOf(v);
    else if (kind === 'cost') {
      const c = {};
      for (const [l, list] of v.entries) {
        const key = ['plutusV1', 'plutusV2', 'plutusV3'][Number(asUint(l, 'language'))];
        if (!key) throw new Error('cost model of an unknown language');
        c[key] = list.items.map((x) => Number(x.value));
      }
      out[name] = c;
    } else if (kind === 'prices') out[name] = { mem: rationalOf(v.items[0]), steps: rationalOf(v.items[1]) };
    else if (kind === 'exu') out[name] = { mem: Number(asUint(v.items[0], 'mem')), steps: Number(asUint(v.items[1], 'steps')) };
    else out[name] = Object.fromEntries((kind === 'pool' ? POOL_T : DREP_T).map((t, i) => [t, rationalOf(v.items[i])]));
  }
  return out;
}

// The plan of an intent: the library's requested outputs and TTL, and the
// operations that write its fixed parts, or the reason it cannot be
// expressed. Made afresh for every build, since the library holds and
// adjusts what it is given.
export function typhonPlan(intent, params) {
  try {
    return makePlan(intent, params);
  } catch (e) {
    if (e instanceof Inexpressible) return { refusal: e.message };
    throw e;
  }
}

function makePlan(intent, params) {
  const kit = intent.source === 'replay' ? replayRefusal(intent) : null;
  if (kit) refuse(kit);
  const f = intent.source === 'replay' ? intent.fixed : null;
  const scripts = f ? witnessScripts(f) : new Map();
  const datums = witnessDatums(f);
  const redeemer = redeemerTaker(f);
  const unpriced = [];
  const after = { body: new Map(), witnesses: new Map(), aux: null };
  // The witness set's script for a credential hash, or {}.
  const scriptFor = (hash, what) => {
    const s = scripts.get(hash);
    if (!s) return {};
    s.used = true;
    return scriptFields(s.lang, s.bytes, what);
  };
  const credentialOf = (n, what) => {
    const kind = Number(asUint(n.items[0], 'credential'));
    const hash = asBytes(n.items[1], 'credential hash');
    return kind === 0 ? { type: KEY, hash: u8(hash) } : { type: SCRIPT, hash: u8(hash), ...scriptFor(hexOf(hash), what) };
  };

  // Requested outputs.
  const outputs = intent.requested.map((o, i) => {
    const d = decodeOutputBytes(Buffer.from(o.cbor, 'hex'));
    const what = `requested output ${i}`;
    let address;
    try {
      address = addressOf(d.address);
    } catch (e) {
      refuse(`${what}: ${errorText(e)}`);
    }
    if (hexOf(address.getBytes()) !== hexOf(d.address)) refuse(`${what}: the library re-encodes its address to other bytes`);
    const out = { address, amount: BigInt(o.coin), tokens: tokensOf(d.assets) };
    if (d.datum && d.datum.kind === 'hash') {
      out.plutusDataHash = d.datum.hash;
      const w = datums.get(d.datum.hash);
      if (w) {
        out.plutusData = exactPlutusData(w.bytes, `${what}'s datum`);
        w.used = true;
      }
    } else if (d.datum) out.plutusData = exactPlutusData(Buffer.from(d.datum.cbor, 'hex'), `${what}'s inline datum`);
    if (d.scriptRef) Object.assign(out, scriptFields(d.scriptRef.lang, Buffer.from(d.scriptRef.script, 'hex'), `${what}'s reference script`));
    return out;
  });
  const ttl = f && f.body[3] !== undefined ? Number(asUint(decode(Buffer.from(f.body[3], 'hex')), 'ttl')) : undefined;
  if (!f) return { outputs, ttl, aux: undefined, ops: [], after, unpriced, plain: true };

  if (f.body[15] !== undefined) refuse('body field 15 (network id): the library never writes it, and a replayed intent carries none');
  const ops = [];

  // Fixed inputs.
  for (const x of f.inputs) {
    const p = unspentOutputParts(x.cbor);
    if (p.addr.type === 8) refuse(`a Byron address on ${x.ref}: addInput reads a payment credential from every input (Transaction.ts:206)`);
    const address = addressOf(p.address);
    const cred = address.paymentCredential;
    if (cred.type === SCRIPT) Object.assign(cred, scriptFor(hexOf(cred.hash), `the script of ${x.ref}`));
    const input = { txId: p.txid, index: p.index, amount: p.coin, tokens: tokensOf(p.assets), address, ...ownScript(p, x.ref) };
    const red = redeemer({ kind: 'input', ref: x.ref });
    if (red) input.redeemer = red;
    if (p.datum && p.datum.kind === 'hash' && datums.has(p.datum.hash)) {
      const w = datums.get(p.datum.hash);
      input.plutusData = exactPlutusData(w.bytes, `the datum of ${x.ref}`);
      w.used = true;
    }
    ops.push((tx) => tx.addInput(input));
  }
  // Reference inputs: only their reference scripts matter to the library.
  for (const x of f.referenceInputs) {
    const p = unspentOutputParts(x.cbor);
    const r = { txId: p.txid, index: p.index, ...ownScript(p, x.ref) };
    ops.push((tx) => tx.addReferenceInput(r));
  }
  // Mint and burn, per policy.
  if (f.body[9] !== undefined) {
    const byPolicy = new Map();
    const add = (a, q) => {
      if (!byPolicy.has(a.policy)) byPolicy.set(a.policy, []);
      byPolicy.get(a.policy).push({ assetName: a.name, amount: q });
    };
    for (const a of intent.implicit.mint) add(a, BigInt(a.qty));
    for (const a of intent.implicit.burn) add(a, -BigInt(a.qty));
    for (const [policyId, assets] of byPolicy) {
      const mint = { policyId, assets, ...scriptFor(policyId, `policy ${policyId}`) };
      const red = redeemer({ kind: 'policy', policy: policyId });
      if (red) mint.redeemer = red;
      ops.push((tx) => tx.addMint(mint));
    }
  }
  // Certificates.
  if (f.body[4] !== undefined) {
    const items = listItems(f.body[4]);
    if (items.every((b) => CERT_KINDS.has(certKind(b)))) {
      items.forEach((b, i) => {
        const c = certificateOf(decode(b), credentialOf);
        const red = redeemer({ kind: 'certificate', index: i });
        if (red) c.redeemer = red;
        ops.push((tx) => tx.addCertificate(c));
      });
    } else {
      if (f.redeemers.some((r) => r.tag === 2)) refuse('a certificate of a kind the library has no type for, in a transaction whose certificates need redeemers it could not attach');
      after.body.set(4, Buffer.from(f.body[4], 'hex'));
      unpriced.push('certificates');
    }
  }
  // Withdrawals.
  if (f.body[5] !== undefined) {
    for (const [k, v] of decode(Buffer.from(f.body[5], 'hex')).entries) {
      const account = asBytes(k, 'reward account');
      const rewardAccount = addressOf(account);
      const cred = rewardAccount.stakeCredential;
      if (cred.type === SCRIPT) Object.assign(cred, scriptFor(hexOf(cred.hash), `reward account ${hexOf(account)}`));
      const w = { rewardAccount, amount: asUint(v, 'withdrawal') };
      const red = redeemer({ kind: 'withdrawal', account: hexOf(account) });
      if (red) w.redeemer = red;
      ops.push((tx) => tx.addWithdrawal(w));
    }
  }
  // Votes, per voter.
  if (f.body[19] !== undefined) {
    const buf = Buffer.from(f.body[19], 'hex');
    for (const [voterNode, votes] of decode(buf).entries) {
      const type = Number(asUint(voterNode.items[0], 'voter kind'));
      const hash = asBytes(voterNode.items[1], 'voter');
      const scriptVoter = type === 1 || type === 3;
      const key = scriptVoter ? { type: SCRIPT, hash: u8(hash), ...scriptFor(hexOf(hash), `voter ${hexOf(hash)}`) } : { type: KEY, hash: u8(hash) };
      const vp = { voter: { type, key }, votes: votes.entries.map(([id, pv]) => ({ govActionId: govActionIdOf(id), vote: Number(asUint(pv.items[0], 'vote')), anchor: anchorOf(pv.items[1]) })) };
      const red = redeemer({ kind: 'voter', voter: hexOf(raw(buf, voterNode)) });
      if (red) vp.redeemer = red;
      ops.push((tx) => tx.addVotingProcedure(vp));
    }
  }
  // Proposals.
  if (f.body[20] !== undefined) {
    const items = listItems(f.body[20]);
    let proposals;
    try {
      proposals = items.map((b) => proposalOf(decode(b)));
    } catch (e) {
      if (f.redeemers.some((r) => r.tag === 5)) refuse(`a proposal the library has no type for (${errorText(e)}), in a transaction whose proposals need redeemers it could not attach`);
      proposals = null;
    }
    if (proposals) {
      proposals.forEach((pp, i) => {
        if (pp.policyHash) Object.assign(pp.p, scriptFor(hexOf(pp.policyHash), `the policy of proposal ${i}`));
        const red = redeemer({ kind: 'proposal', index: i });
        if (red) pp.p.redeemer = red;
        ops.push((tx) => tx.addProposalProcedure(pp.p));
      });
    } else {
      after.body.set(20, Buffer.from(f.body[20], 'hex'));
      unpriced.push('proposals');
    }
  }
  // Required signers.
  for (const h of requiredSigners(f)) ops.push((tx) => tx.addRequiredSigner({ type: KEY, hash: u8hex(h) }));
  if (f.body[8] !== undefined) {
    const start = Number(asUint(decode(Buffer.from(f.body[8], 'hex')), 'validity start'));
    ops.push((tx) => tx.setValidityIntervalStart(start));
  }
  if (f.body[22] !== undefined) {
    const donation = asUint(decode(Buffer.from(f.body[22], 'hex')), 'donation');
    ops.push((tx) => tx.setDonationAmount(donation));
  }
  if (f.body[21] !== undefined) {
    const treasury = asUint(decode(Buffer.from(f.body[21], 'hex')), 'treasury value');
    ops.push((tx) => tx.setTreasuryAmount(treasury));
  }
  // Auxiliary data: its metadata as the library's, or the observed bytes
  // after the build.
  let aux;
  if (f.auxiliaryData) {
    aux = metadataOnly(f.auxiliaryData);
    if (!aux) {
      after.aux = Buffer.from(f.auxiliaryData, 'hex');
      unpriced.push('auxiliary data');
    }
  }
  // Every redeemer goes with its part.
  const leftRed = redeemer.left();
  if (leftRed.length) refuse(`a redeemer whose part the library does not take (tag ${leftRed[0].tag})`);
  // Witness-set entries no operation took, after the build.
  const restScripts = [...scripts.values()].filter((s) => !s.used);
  if (restScripts.length) {
    for (const s of restScripts) {
      const key = s.lang === 0 ? 1 : { 1: 3, 2: 6, 3: 7 }[s.lang];
      const item = s.lang === 0 ? Buffer.from(s.bytes) : encBytes(s.bytes);
      if (!after.witnesses.has(key)) after.witnesses.set(key, []);
      after.witnesses.get(key).push(item);
    }
    unpriced.push('witness-set scripts');
  }
  const restDatums = [...datums.values()].filter((d) => !d.used);
  if (restDatums.length) {
    after.witnesses.set(4, restDatums.map((d) => Buffer.from(d.bytes)));
    unpriced.push('witness-set datums');
  }
  if (f.witnesses[2] !== undefined) {
    after.witnesses.set(2, listItems(f.witnesses[2]));
    unpriced.push('bootstrap witnesses');
  }
  return { outputs, ttl, aux, ops, after, unpriced, plain: false };
}

// A certificate of the library's (types.ts:280-439) from its CBOR node.
// credentialOf(node, what) gives a credential with its witness-set script.
const DREP = (n) => {
  const kind = Number(asUint(n.items[0], 'drep'));
  return kind <= 1 ? { type: kind, key: u8(asBytes(n.items[1], 'drep')) } : { type: kind, key: undefined };
};
function certificateOf(n, credentialOf) {
  const kind = Number(asUint(n.items[0], 'certificate kind'));
  const it = n.items;
  const cred = (i) => credentialOf(it[i], `certificate ${kind}`);
  const pool = (i) => u8(asBytes(it[i], 'pool'));
  const coin = (i) => asUint(it[i], 'deposit');
  switch (kind) {
    case 0:
    case 1:
      return { type: kind, cert: { stakeCredential: cred(1) } };
    case 2:
      return { type: kind, cert: { stakeCredential: cred(1), poolHash: hexOf(asBytes(it[2], 'pool')) } };
    case 7:
    case 8:
      return { type: kind, cert: { stakeCredential: cred(1), deposit: coin(2) } };
    case 9:
      return { type: kind, cert: { stakeCredential: cred(1), dRep: DREP(it[2]) } };
    case 10:
      return { type: kind, cert: { stakeCredential: cred(1), poolKeyHash: pool(2), dRep: DREP(it[3]) } };
    case 11:
      return { type: kind, cert: { stakeCredential: cred(1), poolKeyHash: pool(2), deposit: coin(3) } };
    case 12:
      return { type: kind, cert: { stakeCredential: cred(1), dRep: DREP(it[2]), deposit: coin(3) } };
    case 13:
      return { type: kind, cert: { stakeCredential: cred(1), poolKeyHash: pool(2), dRep: DREP(it[3]), deposit: coin(4) } };
    case 14:
      return { type: kind, cert: { coldCredential: cred(1), hotCredential: cred(2) } };
    case 15:
      return { type: kind, cert: { coldCredential: cred(1), anchor: anchorOf(it[2]) } };
    case 16:
      return { type: kind, cert: { dRepCredential: cred(1), deposit: coin(2), anchor: anchorOf(it[3]) } };
    case 17:
      return { type: kind, cert: { dRepCredential: cred(1), deposit: coin(2) } };
    case 18:
      return { type: kind, cert: { dRepCredential: cred(1), anchor: anchorOf(it[2]) } };
    default:
      throw new Error(`certificate kind ${kind}: no type of the library's`);
  }
}

// A proposal of the library's (types.ts:622-724) from its CBOR node:
// { p, policyHash }.
function proposalOf(n) {
  const [deposit, account, action, anchor] = n.items;
  const a = action.items;
  const kind = Number(asUint(a[0], 'governance action'));
  const credOf = (c) => ({ type: Number(asUint(c.items[0], 'credential')), hash: u8(asBytes(c.items[1], 'credential hash')) });
  let govAction;
  let policyHash = null;
  switch (kind) {
    case 0:
      policyHash = optHash(a[3]);
      govAction = { type: 0, action: { prevActionId: govActionIdOf(a[1]), protocolParamUpdate: paramUpdateOf(a[2]), policyHash } };
      break;
    case 1:
      govAction = { type: 1, action: { prevActionId: govActionIdOf(a[1]), protocolVersion: [Number(asUint(a[2].items[0], 'major')), Number(asUint(a[2].items[1], 'minor'))] } };
      break;
    case 2:
      policyHash = optHash(a[2]);
      govAction = { type: 2, action: { withdrawals: a[1].entries.map(([k, v]) => ({ rewardAccount: addressOf(asBytes(k, 'reward account')), amount: asUint(v, 'withdrawal') })), policyHash } };
      break;
    case 3:
      govAction = { type: 3, action: { prevActionId: govActionIdOf(a[1]) } };
      break;
    case 4: {
      const removed = (a[2].mt === 6 ? a[2].item : a[2]).items.map(credOf);
      govAction = { type: 4, action: { prevActionId: govActionIdOf(a[1]), removeColdCreds: removed, addColdCreds: a[3].entries.map(([c, e]) => ({ credential: credOf(c), epoch: Number(asUint(e, 'epoch')) })), threshold: rationalOf(a[4]) } };
      break;
    }
    case 5:
      govAction = { type: 5, action: { prevActionId: govActionIdOf(a[1]), constitution: { anchor: anchorOf(a[2].items[0]), scriptHash: optHash(a[2].items[1]) } } };
      break;
    case 6:
      govAction = { type: 6 };
      break;
    default:
      throw new Error(`governance action ${kind}`);
  }
  return { p: { deposit: asUint(deposit, 'deposit'), rewardAccount: u8(asBytes(account, 'reward account')), govAction, anchor: anchorOf(anchor) }, policyHash };
}

// A metadatum of the library's (types.ts:450-457).
function metadatumOf(n) {
  switch (n.mt) {
    case 0:
    case 1:
      return n.value;
    case 2:
      return u8(n.value);
    case 3:
      return n.value;
    case 4:
      return n.items.map(metadatumOf);
    case 5:
      return new Map(n.entries.map(([k, v]) => [metadatumOf(k), metadatumOf(v)]));
    default:
      throw new Error(`metadatum of major type ${n.mt}`);
  }
}

// The auxiliary data as the library's (metadata only, types.ts:464-468), or
// null when it carries a script or a metadatum the library refuses
// (createAuxiliaryDataCbor runs its checks, utils/helpers.ts:54-92).
function metadataOnly(hexAux) {
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
  try {
    const aux = { metadata: (meta ? meta.entries : []).map(([k, v]) => ({ label: Number(asUint(k, 'label')), data: metadatumOf(v) })) };
    TU.createAuxiliaryDataCbor(aux);
    return aux;
  } catch (e) {
    passMachineErrors(e);
    return null;
  }
}

// The transaction the library built with the parts written after the build:
// body fields set or replaced, witness-set lists extended or set, and the
// auxiliary data replaced with its hash. Fields keep the library's order; a
// new one goes after them.
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
    return Buffer.concat([head(5, (out.length / 2)), ...out]);
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

// The library's input for a state's UTxO, made once per record; the library
// copies the inputs it is given (transactionBuilder.ts:141).
const INPUTS = new WeakMap();
function inputOf(u) {
  let x = INPUTS.get(u);
  if (!x) {
    const i = u.ref.indexOf('#');
    x = Object.freeze({ txId: u.ref.slice(0, i), index: Number(u.ref.slice(i + 1)), amount: u.coin, tokens: Object.freeze(tokensOf(u.assets)), address: addressOf(addressBytes(u.address)) });
    INPUTS.set(u, x);
  }
  return x;
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
  if (f.body[4] !== undefined && listItems(f.body[4]).some((b) => certKind(b) <= 1)) need(params, 'keyDeposit');
  if (f.redeemers.length) {
    need(params, 'priceMem');
    need(params, 'priceStep');
  }
  if ([...f.inputs, ...f.referenceInputs].some((u) => unspentOutputParts(u.cbor).scriptRef)) need(params, 'minFeeRefScriptCostPerByte');
}

// Builds the intent with the library. It refuses nothing the method below
// refuses first.
export function buildTyphon(T, state, intent, params, opts, { name = 'typhon-lp' } = {}) {
  const layout = opts.changePolicy === 'layout';
  if (opts.changePolicy !== 'default' && !layout) return { ok: false, class: CLASSES.other, detail: 'the typhonjs baseline takes its own change or the layout change only' };
  const replay = intent.source === 'replay';
  const f = replay ? intent.fixed : null;
  const collateral = opts.collateral || null;
  if (intent.collateral && intent.collateral.required && !collateral) throw new Error(`${name}: a script spend needs the collateral the engine sets aside`);
  let plan;
  try {
    plan = typhonPlan(intent, params);
    if (plan.refusal) return { ok: false, class: NOT_REPLAYABLE, detail: plan.refusal };
    neededParameters(intent, params);
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: CLASSES.other, detail: `replay parts: ${errorText(e)}` };
  }
  const fixedRefs = new Set(f ? f.inputs.map((x) => x.ref) : []);
  const pool = inputOrder(state).filter((u) => !fixedRefs.has(u.ref));
  const protocolParams = typhonParams(params);
  const inputs = pool.map(inputOf);
  const changeAddress = addressOf(addressBytes(state.changeAddress));
  let tx;
  if (plan.plain && !collateral) {
    try {
      tx = new Transaction({ protocolParams }).paymentTransaction({ inputs, outputs: plan.outputs, changeAddress, ttl: plan.ttl });
    } catch (e) {
      passMachineErrors(e);
      return { ok: false, class: classOfTyphonError(e, { tokenChange: leavesTokens(pool, intent) }), detail: `paymentTransaction: ${errorText(e)}` };
    }
  } else {
    // paymentTransaction's steps (transaction/helpers/paymentTransaction.ts:
    // 19-32), the fixed parts and the collateral before prepareTransaction.
    tx = new Transaction({ protocolParams });
    try {
      for (const o of plan.outputs) tx.addOutput(o);
      tx.setTTL(plan.ttl);
      if (plan.aux) tx.setAuxiliaryData(plan.aux);
      for (const op of plan.ops) op(tx);
    } catch (e) {
      passMachineErrors(e);
      return { ok: false, class: CLASSES.other, detail: `replay parts: ${errorText(e)}` };
    }
    try {
      tx.prepareTransaction({ inputs, changeAddress, collateralInputs: collateral ? [inputOf(collateral)] : [] });
    } catch (e) {
      passMachineErrors(e);
      return { ok: false, class: classOfTyphonError(e, { tokenChange: leavesTokens(pool, intent) }), detail: `prepareTransaction: ${errorText(e)}` };
    }
  }
  const refs = tx.getInputs().map((i) => `${i.txId.toLowerCase()}#${i.index}`);
  for (const x of fixedRefs) if (!refs.includes(x)) return { ok: false, class: CLASSES.other, detail: `the library left out the fixed input ${x}` };
  const walletRefs = refs.filter((x) => !fixedRefs.has(x));
  const records = recordsOf(state, walletRefs);
  if (layout) {
    const r = buildWithChange(T, { state, params, inputs: records, intent, policy: 'layout', collateral });
    if (!r.ok) return { ok: false, class: r.class, detail: `layout change on the library's inputs: ${r.detail}` };
    return { ok: true, kind: 'single', txs: [txRecord(r.bytes, walletRefs, r.fee, r.size, r.k)] };
  }
  // The vkey witnesses: the wallet's keys, synthetic, then the intent's other
  // vkey witnesses as observed, encoded by the library.
  const keys = replayWitnessKeys(f, { inputs: records, collateral: collateral ? [collateral] : [] });
  const others = f && f.witnesses[0] !== undefined ? listItems(f.witnesses[0]) : [];
  for (const w of [...syntheticVkeys(T, keys.size), ...others]) {
    const [vkey, sig] = decode(w).items;
    tx.addWitness({ publicKey: u8(asBytes(vkey, 'vkey')), signature: u8(asBytes(sig, 'signature')) });
  }
  // The keys the library priced a dummy witness for (Transaction.ts:697-711).
  const priced = new Set([...tx.getRequiredNativeScriptWitnesses().keys(), ...tx.getRequiredSigners().keys(), ...tx.getRequiredWitnesses().keys()]).size;
  let bytes;
  try {
    bytes = withPartsAfter(tx.buildTransaction().payload, plan.after);
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: CLASSES.other, detail: `buildTransaction: ${errorText(e)}` };
  }
  const size = inspectTx(bytes).size;
  const fee = tx.getFee();
  const scriptFee = f ? f.scriptFee : 0n;
  const observedUnpriced = others.length > 0 && keys.size + others.length > priced;
  return {
    ok: true,
    kind: 'single',
    txs: [txRecord(bytes, walletRefs, fee, size, keys.size)],
    library: { fee, finalMinFee: minFee(params, size, scriptFee), priced, unpriced: observedUnpriced ? [...plan.unpriced, 'observed vkey witnesses'] : plan.unpriced }
  };
}

export function typhonMethod(T) {
  const name = 'typhon-lp';
  return {
    name,
    version: `@stricahq/typhonjs ${TYPHON_VERSION} paymentTransaction`,
    deterministic: true,
    seeded: true,
    build(state, intent, params, opts) {
      refuseUncovered(name, REPLAY_COVERAGE.typhon, intent);
      return buildTyphon(T, state, intent, params, opts, { name });
    }
  };
}
