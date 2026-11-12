// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Helios baseline, helios-sf: @helios-lang/tx-utils 0.6.42
// (HeliosLang/tx-utils at fc94391, the 0.6.42 release; paths below are under
// its src/) over @helios-lang/ledger 0.7.24 (HeliosLang/ledger at 7e36667) and
// @helios-lang/uplc 0.7.20, the versions 0.6.42's ranges resolve. Helios's
// build selects no inputs for a payment, so it is called through its own
// helper: WalletHelper.selectUtxos at its default, smallest-first, chooses the
// inputs for the requested value over the wallet's UTxOs, the builder spends
// them, and build takes the wallet's UTxOs as spares for the fee and the
// change. The wallet is an offline wallet holding the replay's state: the
// spendable UTxOs in the state's order (inputOrder), the change address and
// the network; nothing reaches a network. Its change policies are its own
// ('default') and UnFrack.It's layout change on the inputs the library chose
// ('layout'); no other change policy is accepted.
//
// The library, at that commit:
//   wallets/WalletHelper.js:299-301, selectUtxos(amount, coinSelection =
//   selectSmallestFirst()): the selector over the wallet's utxos (:140-173,
//   the wallet's list as it gives it; an empty list throws "wallet returned 0
//   utxos").
//   coinselection/extremumFirst.js:23-25 and :34-187, selectSmallestFirst:
//   for each token of the amount, in the amount's policy and name order
//   (:114-134), then for lovelace (:140-178), the UTxOs not yet chosen are
//   sorted (:59-83) and taken from the front, one at a time, until the
//   quantity still needed is covered; a UTxO holding none of the asset is
//   passed over (:88-105). The sort puts UTxOs holding none of the asset
//   first, then orders those holding it by their token count, more tokens
//   first (:72-81), and among equal counts by the quantity, smallest first
//   (:76). Array.prototype.sort is stable, so UTxOs equal on both keep the
//   list's order, which is the state's. For lovelace a UTxO holding a token
//   the amount does not name is left out (:150-177). Running out throws
//   InsufficientFundsError (:93, coinselection/InsufficientFundsError.js). It
//   draws nothing at random.
//   txbuilder/TxBuilder.js:1173-1175, spendWithoutRedeemer, then
//   spendUnsafe (:1250-1310), adds each chosen UTxO with the private addInput
//   (:1510-1512), which keeps the inputs sorted.
//   TxBuilder.js:319-333 and :377-629, build({ changeAddress, spareUtxos }):
//   the spares are the list given less the inputs (:390-395); token change
//   first (balanceAssets :1864-1940, a change output every
//   maxAssetsPerChangeOutput tokens, by default the largest token count of
//   any input or spare, :422-430); the fee set to the largest Conway fee
//   (:455-457); outputs raised to their minimum lovelace (correctOutputs
//   :2846-2848); lovelace balanced (balanceLovelace :2070-2224), adding
//   spares with no tokens one at a time from the end of the list
//   (:2132-2170) while the inputs fall short of the outputs, the fee and the
//   change output's minimum; one lovelace change output; the fee lowered to
//   the exact minimum and the difference returned to the change (:548-559);
//   then the transaction validated (Tx.validateUnsafe, :608-628;
//   @helios-lang/ledger src/tx/Tx.js:401-449: the size against maxTxSize,
//   unsigned, the fee, the value conserved, the collateral, the scripts,
//   each redeemer's execution within its budget, every output's minimum),
//   build throwing the first failure (:319-333). The balance counts
//   registration deposits and deregistration refunds of stake keys only
//   (:2113-2124); withdrawals are counted nowhere, so a withdrawal of
//   rewards leaves the transaction unbalanced, which the kit's check says.
//
// Witnesses: build returns the transaction with no signature, its fee priced
// with one dummy signature per key it counts (ledger Tx.js:149-165,
// TxBody.js:376-406 countUniqueSigners: the inputs' and collateral's key
// credentials and the signers). The adapter adds one synthetic vkey witness per wallet key
// (kit/replay.mjs replayWitnessKeys), then the intent's other vkey witnesses
// as observed, through the library's addSignatures without verification.
//
// Errors to failure classes (setting unclassified 'other' for the rest):
//   InsufficientFundsError ("Insufficient funds error", the selector),
//   "wallet returned 0 utxos", "not enough input assets" (balanceAssets),
//   "UTxOs too fragmented" and "need N lovelace, but only have M"
//   (balanceLovelace), "tx not balanced" (Tx.validateConservation)  balance
//   "Unable to balance transaction, not enough spare lovelace to create two
//   change outputs", "not enough lovelace in output" (Tx.validateOutputs)
//                                                                change-minimum
//   "tx too big" (Tx.validateSize)                             tx-size
//   "fee too small" (Tx.validateFee)                           fee-minimum
//   "unable to find enough collateral input", "not enough collateral",
//   "collateral can only contain lovelace", "too many collateral inputs",
//   "collateralReturn is ..." (Tx.validateCollateral)          collateral
// A requested output the library refuses (addOutput, :702-733) is the
// intent's, class other with "requested output: ".
//
// The replay path: every intent the history reader writes (source 'replay')
// is built with the run's parameters as the library's (heliosParams below; the
// cost models are the library's defaults, as the run holds none, and serve
// only the script-data hash; the slot of each network's Shelley start and its
// time place the validity range in a script's context), and its fixed parts
// through the library's own operations before build:
//   requested outputs   addOutput with the output decoded from its own bytes,
//                       so a datum and a script reference pass through
//   fixed inputs        spendUnsafe, with the input's redeemer when it has
//                       one; a datum-hash input carries its datum from the
//                       witness set, which the library writes; never among
//                       the wallet's UTxOs
//   reference inputs    refer, which takes their reference scripts
//   mint and burn       mintPolicyTokensUnsafe per policy, a burn as a
//                       negative quantity, with the policy's redeemer
//   certificates        kinds 0 to 4, decoded by the library (decodeDCert):
//                       deregisterUnsafe (1) and delegateUnsafe (2) with
//                       their redeemers, addDCert for the others; for a key
//                       credential both add the stake key as a signer
//                       (addDCert, :680-692), which the library writes in
//                       field 14
//   withdrawals         withdrawUnsafe per reward account
//   required signers    addSigners
//   validity            validFromSlot, validToSlot
//   auxiliary data      setMetadataAttributes with the metadata the library
//                       decodes from the intent's bytes (any of the three
//                       forms, when it holds no script), which it writes as a
//                       metadata map in its own encoding
//   scripts             attachNativeScript and attachUplcProgram for each
//                       script of the witness set
//   collateral          the UTxO the engine set aside, by addCollateral
//                       (:665-678); build then adds none of its own and
//                       writes no collateral return (:1954-1956)
//   execution units     build runs every Plutus script in the library's own
//                       machine to profile it (buildRedeemerProfile,
//                       :2709-2793) and again when it validates; the build
//                       option modifyExBudget (:507, applied at :2436-2443,
//                       :2520-2527, :2599-2606, :2683-2690) gives each redeemer
//                       the intent's observed units, as every adapter's
//                       redeemers carry them. A script that fails in the
//                       library's machine, or costs it more than the observed
//                       units, fails the build; that failure is the library's.
// Not replayable (heliosRefusal), the parts the library has no way to express:
// body field 6, as for every adapter (kit/replay.mjs replayRefusal); body
// fields 19 to 22 (votes, proposals, the treasury value and the donation) and
// certificates of kinds 5 and above, which @helios-lang/ledger 0.7.24's
// transaction body and certificate types do not hold (src/tx/TxBody.js:83-160
// and :563-664 read and write body fields 0 to 18 only, src/tx/DCert.js:21-46
// certificate kinds 0 to 4); a Byron address on a fixed input, which
// spendUnsafe refuses (:1261-1263), and bootstrap witnesses, which its
// witness set does not hold; a native script or a Plutus V1 script as the reference script of
// a reference input, which refer and decodeTxOutput refuse; a fixed or
// reference input the library cannot decode, such as one whose reference
// script uses a term @helios-lang/uplc 0.7.20 does not read (the case term
// of Plutus V3); auxiliary data holding scripts, or metadata the library
// cannot decode; a witness-set datum that no spent script input takes, which
// no operation writes; a witness-set script the library cannot decode, and a
// datum or a script it reads to another hash. A requested output the library
// refuses is a failure, not a part it cannot hold: addOutput refuses an
// output to a script address with no datum unless the script is a native
// script in the transaction (:712-720), which a payment to that address from
// this library also meets.
//
// The library writes diagnostics to the console during build (a collateral
// warning, ledger Tx.js:595-597, and a note per script it runs without a
// logging copy, TxBuilder.js:2779-2781 and ledger Tx.js:832-834); they change
// nothing the method returns.
//
// The layout change (opts.changePolicy 'layout'): the library builds its
// transaction exactly as for its own change; the wallet inputs it holds, the
// ones the selector chose and any spares build drew, are read from that
// transaction, its change is dropped, and the simulator's layout change
// (methods/change.mjs) is built on those inputs, the kit assembling the
// transaction at its exact fee with the intent's fixed parts and the
// collateral the engine set aside, as for Blaze, cardano-js-sdk and CSL. A
// library that fails to build fails before this point, as for its own change.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { makeTxBuilder, makeWalletHelper, makeOfflineWallet } from '@helios-lang/tx-utils';
import { decodeTxInput, decodeTxOutput, decodeDCert, decodeStakingAddress, decodeTxMetadata, decodeNativeScript, hashNativeScript, decodeSignature, makeValue, makeAssets, makePubKeyHash, makeAddress, makeHashedTxOutputDatum, makeTxInput, makeTxOutput, DEFAULT_NETWORK_PARAMS } from '@helios-lang/ledger';
import { decodeUplcData, decodeUplcProgramV1FromCbor, decodeUplcProgramV2FromCbor, decodeUplcProgramV3FromCbor } from '@helios-lang/uplc';
import { CLASSES } from '../kit/check.mjs';
import { passMachineErrors } from '../kit/machine.mjs';
import { unspentOutputParts, inspectTx } from '../kit/inspect.mjs';
import { replayRefusal, listItems, requiredSigners, replayWitnessKeys, redeemerKey, targetKey, syntheticVkeys, fixedInputValues } from '../kit/replay.mjs';
import { blake2b224, blake2b256 } from '../history/blake2b.mjs';
import { minFee } from '../kit/fee.mjs';
import { need } from '../kit/params.mjs';
import { decode, raw, asUint, asBytes } from '../history/cbor.mjs';
import { NOT_REPLAYABLE } from './contract.mjs';
import { buildWithChange } from './change.mjs';
import { inputOrder, recordsOf, refuseUncovered, REPLAY_COVERAGE, errorText, txRecord } from './library.mjs';

const requireHere = createRequire(import.meta.url);
const versionOf = (pkg) => JSON.parse(readFileSync(requireHere.resolve(`${pkg}/package.json`), 'utf8')).version;
export const HELIOS_TX_UTILS_VERSION = versionOf('@helios-lang/tx-utils');
export const HELIOS_LEDGER_VERSION = versionOf('@helios-lang/ledger');
if (HELIOS_TX_UTILS_VERSION !== '0.6.42') throw new Error(`@helios-lang/tx-utils ${HELIOS_TX_UTILS_VERSION} is installed; the baseline is 0.6.42`);
if (HELIOS_LEDGER_VERSION !== '0.7.24') throw new Error(`@helios-lang/ledger ${HELIOS_LEDGER_VERSION} is installed; the baseline's tx-utils 0.6.42 resolves 0.7.24`);

const hexOf = (b) => Buffer.from(b).toString('hex');
const firstLine = (s) => String(s).split('\n')[0];

const ERROR_CLASSES = [
  [/^Insufficient funds error/, CLASSES.balance],
  [/^wallet returned 0 utxos/, CLASSES.balance],
  [/^not enough input assets/, CLASSES.balance],
  [/^UTxOs too fragmented/, CLASSES.balance],
  [/^need -?\d+ lovelace, but only have -?\d+/, CLASSES.balance],
  [/^tx not balanced/, CLASSES.balance],
  [/^Unable to balance transaction, not enough spare lovelace to create two change outputs/, CLASSES.changeMinimum],
  [/^not enough lovelace in output/, CLASSES.changeMinimum],
  [/^tx too big/, CLASSES.txSize],
  [/^fee too small/, CLASSES.feeMinimum],
  [/^unable to find enough collateral input/, CLASSES.collateral],
  [/^not enough collateral/, CLASSES.collateral],
  [/^collateral can only contain lovelace/, CLASSES.collateral],
  [/^too many collateral inputs/, CLASSES.collateral],
  [/^collateralReturn is /, CLASSES.collateral]
];

export function classOfHeliosError(e) {
  const m = errorText(e);
  for (const [re, cls] of ERROR_CLASSES) if (re.test(m)) return cls;
  return CLASSES.other;
}

// The selector's message holds every UTxO it chose; the detail keeps its
// first words only.
const heliosDetail = (e) => {
  const m = firstLine(errorText(e));
  return /^Insufficient funds error/.test(m) ? 'Insufficient funds error' : m;
};

// The slot and time of each network's Shelley start, which place a slot in
// time for a script's context (Helios's refTipSlot and refTipTime); the
// synthetic shapes carry mainnet addresses.
const SHELLEY_START = { preprod: { slot: 86400, time: 1655769600000 }, mainnet: { slot: 4492800, time: 1596059091000 } };
const isMainnetOf = (network) => network !== 'preprod';

const ratio = (r) => (r === null || r === undefined ? null : Number(r[0]) / Number(r[1]));

// The run's parameters as the library's NetworkParams
// (@helios-lang/ledger src/params/NetworkParams.js:44-64). The execution and
// transaction budgets and the cost models are the library's defaults, as the
// run holds none.
export function heliosParams(params, network) {
  const D = DEFAULT_NETWORK_PARAMS();
  const start = SHELLEY_START[isMainnetOf(network) ? 'mainnet' : 'preprod'];
  const refPrice = ratio(params.minFeeRefScriptCostPerByte);
  return {
    ...D,
    txFeeFixed: Number(params.minFeeB),
    txFeePerByte: Number(params.minFeeA),
    exMemFeePerUnit: ratio(params.priceMem) ?? D.exMemFeePerUnit,
    exCpuFeePerUnit: ratio(params.priceStep) ?? D.exCpuFeePerUnit,
    utxoDepositPerByte: Number(params.coinsPerUtxoByte),
    collateralPercentage: params.collateralPercent,
    maxCollateralInputs: params.maxCollateralInputs,
    maxTxSize: params.maxTxSize,
    stakeAddrDeposit: params.keyDeposit === null ? D.stakeAddrDeposit : Number(params.keyDeposit),
    refScriptsFeePerByte: refPrice === null ? 0 : refPrice,
    secondsPerSlot: 1,
    refTipSlot: start.slot,
    refTipTime: start.time
  };
}

// The intent's certificates' kinds.
const certificateKinds = (f) => (f.body[4] === undefined ? [] : listItems(f.body[4]).map((b) => Number(asUint(decode(b).items[0], 'certificate kind'))));

const PLUTUS_DECODERS = { 3: decodeUplcProgramV1FromCbor, 6: decodeUplcProgramV2FromCbor, 7: decodeUplcProgramV3FromCbor };
const PLUTUS_LANG = { 3: 1, 6: 2, 7: 3 };

// The witness set's scripts as the library's: native scripts (key 1) and
// Plutus V1 to V3 (keys 3, 6, 7), each with the hash the ledger gives its
// observed bytes.
function witnessScripts(f) {
  const out = [];
  if (f.witnesses[1] !== undefined) {
    for (const r of listItems(f.witnesses[1])) out.push({ native: true, script: decodeNativeScript(r), hash: hexOf(blake2b224(Buffer.concat([Buffer.from([0]), r]))) });
  }
  for (const key of [3, 6, 7]) {
    if (f.witnesses[key] === undefined) continue;
    for (const r of listItems(f.witnesses[key])) {
      const content = asBytes(decode(r), 'plutus script');
      out.push({ native: false, script: PLUTUS_DECODERS[key](r), hash: hexOf(blake2b224(Buffer.concat([Buffer.from([PLUTUS_LANG[key]]), content]))) });
    }
  }
  return out;
}

const scriptHashOf = (s) => hexOf(s.native ? hashNativeScript(s.script) : s.script.hash());

// The witness set's datums (key 4) by hash, each as the library's UplcData.
function witnessDatums(f) {
  const m = new Map();
  if (f.witnesses[4] === undefined) return m;
  for (const b of listItems(f.witnesses[4])) m.set(hexOf(blake2b256(b)), { bytes: b, used: false });
  return m;
}

// The auxiliary data's metadata as the library's TxMetadata, which it writes
// as a metadata map (Tx.js:349-363): the data is a metadata map, or one of the
// two later forms (conway.cddl:802-833) holding metadata and no script. A
// script in the auxiliary data is a part the library cannot hold.
function metadataOf(f) {
  if (!f.auxiliaryData) return null;
  const b = Buffer.from(f.auxiliaryData, 'hex');
  const n = decode(b);
  const noScripts = (x) => x.mt === 4 && x.items.length === 0;
  let map = null;
  if (n.mt === 5) map = n;
  else if (n.mt === 4 && n.items.length === 2 && n.items[0].mt === 5 && noScripts(n.items[1])) map = n.items[0];
  else if (n.mt === 6 && n.tag === 259n && n.item.mt === 5) {
    for (const [k, v] of n.item.entries) {
      if (Number(k.value) === 0) map = v;
      else if (!noScripts(v)) throw new Error('auxiliary data holding scripts');
    }
    if (!map) return null;
  } else throw new Error('auxiliary data holding scripts');
  return decodeTxMetadata(raw(b, map));
}

// Why the library cannot write the intent, or null when it can.
export function heliosRefusal(intent) {
  const kit = replayRefusal(intent);
  if (kit) return kit;
  const f = intent.fixed;
  if (!f) return null;
  for (const k of [19, 20, 21, 22]) if (f.body[k] !== undefined) return `body field ${k}: @helios-lang/ledger 0.7.24's transaction body holds no such field (src/tx/TxBody.js:83-160, :563-664)`;
  for (const k of certificateKinds(f)) if (k > 4) return `a certificate of kind ${k}: @helios-lang/ledger 0.7.24 decodes kinds 0 to 4 only (src/tx/DCert.js:21-46)`;
  for (const x of f.inputs) if (unspentOutputParts(x.cbor).addr.type === 8) return `a Byron address on ${x.ref}: spendUnsafe spends Shelley inputs only (txbuilder/TxBuilder.js:1261-1263)`;
  if (f.witnesses[2] !== undefined) return 'bootstrap witnesses: the library\'s witness set holds none';
  for (const x of f.referenceInputs) {
    const p = unspentOutputParts(x.cbor);
    if (p.scriptRef && (p.scriptRef.lang === 0 || p.scriptRef.lang === 1)) return `a ${p.scriptRef.lang === 0 ? 'native' : 'Plutus V1'} reference script on ${x.ref}: refer and decodeTxOutput take Plutus V2 and V3 reference scripts only`;
  }
  for (const x of [...f.inputs, ...f.referenceInputs]) {
    try {
      decodeTxInput(x.cbor);
    } catch (e) {
      passMachineErrors(e);
      return `an input the library cannot read, ${x.ref}: ${firstLine(errorText(e))}`;
    }
  }
  try {
    metadataOf(f);
  } catch (e) {
    passMachineErrors(e);
    return `auxiliary data the library's metadata cannot hold: ${firstLine(errorText(e))}`;
  }
  let scripts;
  try {
    scripts = witnessScripts(f);
  } catch (e) {
    passMachineErrors(e);
    return `a witness-set script the library cannot read: ${firstLine(errorText(e))}`;
  }
  for (const s of scripts) if (scriptHashOf(s) !== s.hash) return `a witness-set script the library reads to another hash (${s.hash})`;
  const datums = witnessDatums(f);
  for (const x of f.inputs) {
    const p = unspentOutputParts(x.cbor);
    if (p.datum && p.datum.kind === 'hash' && datums.has(p.datum.hash) && f.redeemers.some((r) => r.tag === 0 && r.target.ref === x.ref)) {
      const d = datums.get(p.datum.hash);
      d.used = true;
      if (hexOf(makeHashedTxOutputDatum(decodeUplcData(d.bytes)).hash.bytes) !== p.datum.hash) return `the datum of ${x.ref}, which the library re-encodes to another hash`;
    }
  }
  for (const d of datums.values()) if (!d.used) return 'a witness-set datum that no spent script input takes: no operation writes one';
  return null;
}

// The parameters a spend needs that the run must state.
function neededParameters(intent, params, available) {
  const f = intent.fixed;
  if (!f) return;
  if (certificateKinds(f).some((k) => k === 0 || k === 1)) need(params, 'keyDeposit');
  if (f.redeemers.length) {
    need(params, 'priceMem');
    need(params, 'priceStep');
  }
  if (params.minFeeRefScriptCostPerByte === null) {
    const carried = [...available, ...f.inputs, ...f.referenceInputs].some((u) => unspentOutputParts(u.cbor).scriptRef);
    if (carried) need(params, 'minFeeRefScriptCostPerByte');
  }
}

// The intent's redeemers by target key, each with its data as the library's
// UplcData.
function redeemerFinder(f) {
  const byKey = new Map();
  for (const r of f ? f.redeemers : []) if (!byKey.has(redeemerKey(r))) byKey.set(redeemerKey(r), r);
  const at = (target) => byKey.get(targetKey(target));
  const data = (target) => {
    const r = at(target);
    return r ? decodeUplcData(r.data) : undefined;
  };
  return { at, data };
}

const cmpHex = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The value the selector is asked for: the requested outputs' value, the
// deposits, the donation and the burn, less what the transaction's own parts
// supply (the fixed inputs, the withdrawals, the refunds and the mint), each
// asset at zero or more. For a payment with no fixed parts it is the
// requested outputs' value.
export function requestedValue(intent) {
  const imp = intent.implicit || {};
  const fixedIns = fixedInputValues(intent);
  let coin = 0n;
  const q = new Map();
  const add = (a, sign) => {
    const k = `${a.policy}.${a.name}`;
    const e = q.get(k) || { policy: a.policy, name: a.name, qty: 0n };
    e.qty += sign * BigInt(a.qty);
    q.set(k, e);
  };
  for (const o of intent.requested) {
    coin += BigInt(o.coin);
    for (const a of o.assets) add(a, 1n);
  }
  for (const a of imp.burn || []) add(a, 1n);
  for (const a of imp.mint || []) add(a, -1n);
  for (const x of fixedIns) {
    coin -= x.coin;
    for (const a of x.assets) add(a, -1n);
  }
  coin += BigInt(imp.deposits || 0n) + BigInt(imp.donation || 0n) - BigInt(imp.withdrawals || 0n) - BigInt(imp.refunds || 0n);
  const byPolicy = new Map();
  for (const e of [...q.values()].filter((x) => x.qty > 0n).sort((a, b) => cmpHex(a.policy, b.policy) || cmpHex(a.name, b.name))) {
    if (!byPolicy.has(e.policy)) byPolicy.set(e.policy, []);
    byPolicy.get(e.policy).push([e.name, e.qty]);
  }
  return makeValue(coin > 0n ? coin : 0n, makeAssets([...byPolicy.entries()]));
}

// The intent's fixed parts as the library's operations on builder b.
function withFixedParts(b, intent) {
  const f = intent.fixed;
  const red = redeemerFinder(f);
  for (const s of witnessScripts(f)) {
    if (s.native) b.attachNativeScript(s.script);
    else b.attachUplcProgram(s.script);
  }
  for (const x of f.referenceInputs) b.refer(decodeTxInput(x.cbor));
  const datums = witnessDatums(f);
  for (const x of f.inputs) {
    let input = decodeTxInput(x.cbor);
    const r = red.data({ kind: 'input', ref: x.ref });
    const p = unspentOutputParts(x.cbor);
    if (r && p.datum && p.datum.kind === 'hash' && datums.has(p.datum.hash)) {
      const o = input.output;
      input = makeTxInput(input.id, makeTxOutput(o.address, o.value, makeHashedTxOutputDatum(decodeUplcData(datums.get(p.datum.hash).bytes)), o.refScript));
    }
    b.spendUnsafe(input, r);
  }
  if (f.body[9] !== undefined) {
    const byPolicy = new Map();
    const put = (a, qty) => {
      if (!byPolicy.has(a.policy)) byPolicy.set(a.policy, []);
      byPolicy.get(a.policy).push([a.name, qty]);
    };
    for (const a of intent.implicit.mint) put(a, BigInt(a.qty));
    for (const a of intent.implicit.burn) put(a, -BigInt(a.qty));
    for (const [policy, tokens] of byPolicy) b.mintPolicyTokensUnsafe(policy, tokens, red.data({ kind: 'policy', policy }));
  }
  if (f.body[4] !== undefined) {
    listItems(f.body[4]).forEach((bytes, i) => {
      const c = decodeDCert(bytes);
      const r = red.data({ kind: 'certificate', index: i });
      if (c.kind === 'DeregistrationDCert') b.deregisterUnsafe(c.credential, r);
      else if (c.kind === 'DelegationDCert') b.delegateUnsafe(c.credential, c.poolId, r);
      else b.addDCert(c);
    });
  }
  if (f.body[5] !== undefined) {
    const n = decode(Buffer.from(f.body[5], 'hex'));
    for (const [k, v] of n.entries) {
      const account = hexOf(asBytes(k, 'reward account'));
      b.withdrawUnsafe(decodeStakingAddress(account), asUint(v, 'withdrawal'), red.data({ kind: 'withdrawal', account }));
    }
  }
  if (f.body[14] !== undefined) b.addSigners(...requiredSigners(f).map((h) => makePubKeyHash(h)));
  const slot = (k) => Number(asUint(decode(Buffer.from(f.body[k], 'hex')), 'slot'));
  if (f.body[8] !== undefined) b.validFromSlot(slot(8));
  if (f.body[3] !== undefined) b.validToSlot(slot(3));
  const metadata = metadataOf(f);
  if (metadata) b.setMetadataAttributes(metadata.attributes);
  return b;
}

// The build option modifyExBudget (TxBuilder.js:2265-2296): each redeemer the
// library profiles gets the intent's observed execution units, found by the
// target the library's index names. The library numbers a spend redeemer by
// its input's place among the sorted inputs (:2460), a mint redeemer by its
// policy's place among the minted policies (:2399-2401), a reward redeemer by
// its account's place among the sorted withdrawals (:2550-2552) and a
// certificate redeemer by its certificate's place among the certificates
// (:2641-2646), which the adapter adds in the intent's order.
function observedBudget(b, intent) {
  const red = redeemerFinder(intent.fixed);
  const refOf = (input) => `${input.id.txId.toHex()}#${input.id.index}`;
  return (_txInfo, purpose, i) => {
    let r;
    if (purpose === 'spending') r = red.at({ kind: 'input', ref: refOf(b.inputs[i]) });
    else if (purpose === 'minting') r = red.at({ kind: 'policy', policy: b.mintedTokens.getPolicies()[i].toHex() });
    else if (purpose === 'rewarding') r = red.at({ kind: 'withdrawal', account: hexOf(b.withdrawals[i][0].bytes) });
    else if (purpose === 'certifying') r = red.at({ kind: 'certificate', index: i });
    if (!r) throw new Error(`the library's ${purpose} redeemer ${i} has no observed redeemer`);
    return { mem: BigInt(r.exUnits[0]), cpu: BigInt(r.exUnits[1]) };
  };
}

const refOfInput = (input) => `${input.id.txId.toHex()}#${input.id.index}`;

// Builds the intent with the library. It refuses nothing the method below
// refuses first.
export async function buildHelios(T, state, intent, params, opts, { name = 'helios-sf' } = {}) {
  const layout = opts.changePolicy === 'layout';
  if (opts.changePolicy !== 'default' && !layout) return { ok: false, class: CLASSES.other, detail: 'the Helios baseline takes its own change or the layout change only' };
  const replay = intent.source === 'replay';
  if (replay) {
    const refusal = heliosRefusal(intent);
    if (refusal) return { ok: false, class: NOT_REPLAYABLE, detail: refusal };
  }
  const f = replay ? intent.fixed : null;
  const collateral = opts.collateral || null;
  if (intent.collateral && intent.collateral.required && !collateral) throw new Error(`${name}: a script spend needs the collateral the engine sets aside`);
  const fixedRefs = new Set(f ? f.inputs.map((x) => x.ref) : []);
  const pool = inputOrder(state).filter((u) => !fixedRefs.has(u.ref));
  const isMainnet = isMainnetOf(state.network);
  let b;
  let utxos;
  let helper;
  let networkParams;
  try {
    neededParameters(intent, params, pool);
    networkParams = heliosParams(params, state.network);
    utxos = pool.map((u) => decodeTxInput(u.cbor));
    const changeAddress = makeAddress(state.changeAddress);
    const wallet = makeOfflineWallet({ isMainnet, usedAddresses: [changeAddress], unusedAddresses: [], utxos, collateral: collateral ? [decodeTxInput(collateral.cbor)] : [], stakingAddresses: [] });
    helper = makeWalletHelper(wallet);
    b = makeTxBuilder({ isMainnet });
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: CLASSES.other, detail: `wallet: ${firstLine(errorText(e))}` };
  }
  for (const o of intent.requested) {
    try {
      b.addOutput(decodeTxOutput(Buffer.from(o.cbor, 'hex')));
    } catch (e) {
      passMachineErrors(e);
      return { ok: false, class: CLASSES.other, detail: `requested output: ${firstLine(errorText(e))}` };
    }
  }
  try {
    if (f) withFixedParts(b, intent);
    if (collateral) b.addCollateral(decodeTxInput(collateral.cbor));
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: CLASSES.other, detail: `replay parts: ${firstLine(errorText(e))}` };
  }
  let tx;
  try {
    const selected = await helper.selectUtxos(requestedValue(intent));
    if (selected.length) b.spendWithoutRedeemer(...selected);
    tx = await b.build({ changeAddress: state.changeAddress, spareUtxos: utxos, networkParams, ...(f && f.redeemers.length ? { modifyExBudget: observedBudget(b, intent) } : {}) });
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: classOfHeliosError(e), detail: `build: ${heliosDetail(e)}` };
  }
  const refs = tx.body.inputs.map(refOfInput);
  for (const x of fixedRefs) if (!refs.includes(x)) return { ok: false, class: CLASSES.other, detail: `the library left out the fixed input ${x}` };
  const walletRefs = refs.filter((x) => !fixedRefs.has(x));
  const inputs = recordsOf(state, walletRefs);
  if (layout) {
    const r = buildWithChange(T, { state, params, inputs, intent, policy: 'layout', collateral });
    if (!r.ok) return { ok: false, class: r.class, detail: `layout change on the library's inputs: ${r.detail}` };
    return { ok: true, kind: 'single', txs: [txRecord(r.bytes, walletRefs, r.fee, r.size, r.k)] };
  }
  // The vkey witnesses: the wallet's keys, synthetic, then the intent's other
  // vkey witnesses as observed.
  const keys = replay ? replayWitnessKeys(f, { inputs, collateral: collateral ? [collateral] : [] }) : new Set(inputs.map((u) => u.cred));
  const others = f && f.witnesses[0] !== undefined ? listItems(f.witnesses[0]) : [];
  try {
    tx.addSignatures([...syntheticVkeys(T, keys.size), ...others].map((x) => decodeSignature(x)), false);
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: CLASSES.other, detail: `sign: ${firstLine(errorText(e))}` };
  }
  const bytes = hexOf(tx.toCbor());
  const size = inspectTx(bytes).size;
  const fee = tx.body.fee;
  if (!replay) return { ok: true, kind: 'single', txs: [txRecord(bytes, walletRefs, fee, size, keys.size)] };
  const scriptFee = f ? f.scriptFee : 0n;
  // The keys the library priced a dummy signature for (Tx.js:149-165), read
  // from its own count; the intent's other vkey witnesses are named unpriced
  // when the transaction carries more.
  const priced = tx.body.countUniqueSigners();
  const observedUnpriced = others.length > 0 && keys.size + others.length > priced;
  return {
    ok: true,
    kind: 'single',
    txs: [txRecord(bytes, walletRefs, fee, size, keys.size)],
    library: { fee, finalMinFee: minFee(params, size, scriptFee), priced, unpriced: observedUnpriced ? ['observed vkey witnesses'] : [] }
  };
}

export function heliosMethod(T) {
  const name = 'helios-sf';
  return {
    name,
    version: `@helios-lang/tx-utils ${HELIOS_TX_UTILS_VERSION} with @helios-lang/ledger ${HELIOS_LEDGER_VERSION} selectSmallestFirst`,
    deterministic: true,
    seeded: true,
    async build(state, intent, params, opts) {
      refuseUncovered(name, REPLAY_COVERAGE.helios, intent);
      return buildHelios(T, state, intent, params, opts, { name });
    }
  };
}
