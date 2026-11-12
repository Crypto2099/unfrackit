// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Lucid Evolution baseline, lucid-lf: @lucid-evolution/lucid 0.8.9
// (Anastasia-Labs/lucid-evolution at 8db7d3c, the tag
// @lucid-evolution/lucid@0.8.9), with the packages it pins: its CML fork
// @lucid-evolution/cml 0.1.2 and @lucid-evolution/utils 0.3.0. Paths below
// are under packages/ at that commit.
//
// The call, as a dapp makes it for a payment: Lucid(provider, network,
// { presetProtocolParameters }), selectWallet.fromAddress(changeAddress,
// utxos) with the wallet's spendable UTxOs in the state's order, newTx(), the
// requested outputs through pay.ToAddress (pay.ToAddressWithData for one with
// a datum or a script reference), and complete() with no option. The
// provider answers no query (offlineProvider below); the wallet made by
// fromAddress returns the UTxOs it was given and has no getCollateral
// (wallet/src/wallet_selection.ts:422-479).
//
// The library at that commit:
//   lucid/src/tx-builder/internal/CompleteTxBuilder.ts:281-290: complete()'s
//   defaults: coinSelection true, the change at the wallet's address,
//   setCollateral 5 ADA, includeLeftoverLovelaceAsFee false, no preset wallet
//   inputs, so the wallet's UTxOs come from wallet.getUtxos() (:291-299).
//   :864-899, selectionAndEvaluation: the wallet's UTxOs less those already
//   collected and the reference inputs carrying a script go to
//   doCoinSelection (:1943-2006): the required assets are the outputs, the
//   builder's fee before any wallet input (estimateFee, :2032-2042), the
//   deposits less refunds and withdrawals, less the collected inputs and the
//   mint; the rest of that balance, where negative, is the leftover the
//   inputs already bring.
//   utils/src/utxo.ts:191-213, sortUTxOs "LargestFirst": lovelace
//   descending, compared as JavaScript Numbers; equal lovelace puts the UTxO
//   with fewer asset units first; JavaScript's stable sort keeps the given
//   order among UTxOs equal in both, so the state's order (transaction id,
//   then index, ascending) breaks the remaining ties.
//   utils/src/utxo.ts:132-163, selectUTxOs: one pass over that list, taking
//   every UTxO that holds any unit still needed (a reference-script UTxO
//   included, CompleteTxBuilder.ts:2882) and lowering each unit's remainder,
//   until none remains; [] when the list runs out.
//   CompleteTxBuilder.ts:2871-2929, recursive: after that pass, while the
//   leftover (selected less required, plus the leftover the inputs bring)
//   holds less lovelace than one output with its tokens needs
//   (calculateMinLovelace :2777-2804 at a fixed testnet address, through the
//   CML fork's with_asset_and_min_required_coin), another pass over the
//   remaining list for that shortfall. Selection runs once: the fee it
//   reserves is the builder's before the wallet inputs are added, and the
//   fee those inputs add comes out of the change.
//   CompleteTxBuilder.ts:413-430: the change by the CML fork's
//   add_change_if_needed and build(ChangeSelectionAlgo.Default): leftover
//   tokens packed into change outputs under max_value_size, each at its
//   minimum, the ADA on the last; ADA-only change under its minimum is added
//   to the fee (packages/cml/rust/chain/rust/src/builders/tx_builder.rs).
//   The builder's configuration (lucid/src/tx-builder/TxConfig.ts) sets the
//   fee, deposit, size and execution-price parameters and never sets
//   prefer_pure_change.
// Nothing in the path draws at random: the method is deterministic.
//
// Witnesses (setting serialization 'own'): the library's transaction is
// signed through its own TxSignBuilder.assemble and complete
// (tx-sign-builder/internal/Sign.ts:82-95, CompleteTxSigner.ts:14-45), given
// one synthetic vkey witness per distinct payment key of the wallet (the
// treatment's makeWitnessSet), so the size is exact before signing. The
// library prices a fake witness for every key its builder counts.
//
// Errors to failure classes (setting unclassified 'other' for the rest):
//   "Your wallet does not have enough funds to cover the required assets"
//   (recursive :2883-2889)                                       balance
//   "Your wallet does not have enough funds to cover required minimum ADA
//   for change output" (:2910-2915)                              change-minimum
//   "Your wallet does not have enough funds to cover the required ...
//   Lovelace collateral", "Selected n inputs as collateral, but max
//   collateral inputs is" (findCollateral :1912-1941), and the fork's "Max
//   collateral input count"                                      collateral
//   the fork's "Not enough ADA leftover to include non-ADA assets in a
//   change address"                                              change-minimum
//   the fork's "UTxO Balance Insufficient"                       balance
//   the fork's "Max transaction size of"                         tx-size
//   the fork's "Max value size of"                               value-size
//
// Collateral: the library chooses its own. With Plutus scripts to run,
// complete() asks the wallet for collateral (fetchWalletCollateral,
// :1855-1873), which a fromAddress wallet cannot give, and then takes it from
// the wallet's UTxOs (selectCollateral :1880-1910, findCollateral
// :1912-1941): sortUTxOs over them and recursive for setCollateral (5 ADA,
// or the collateral its fee estimate needs if more), at most
// maxCollateralInputs inputs, the rest returned to the change address
// (applyCollateral :1717-1853). No option names a collateral UTxO, so the
// library cannot be given the UTxO the engine would set aside: its script
// spends take the library's own choice (ownCollateral; methods/contract.mjs
// choosesOwnCollateral), as the Evolution SDK's do.
//
// The replay path: every intent the history reader writes (source 'replay')
// is built through the library's operations (lucid/src/tx-builder/TxBuilder.ts
// :690-947):
//   requested outputs   pay.ToAddress, or pay.ToAddressWithData with the
//                       output's datum (inline, or by hash: 'asHash' with the
//                       datum when the witness set holds it, so the library
//                       writes and prices it) and script reference; the
//                       library raises a coin under its minimum
//                       (internal/Pay.ts addOutput)
//   scripts             attach.Script for each native and Plutus script of
//                       the witness set; reference scripts through readFrom
//   reference inputs    readFrom
//   fixed inputs        collectFrom, one input per call with its redeemer;
//                       a datum-hash input carries its witness-set datum
//   mint and burn       mintAssets per policy with its redeemer
//   certificates        the operation that writes the same certificate
//                       (certificateOperation below)
//   withdrawals         withdraw per reward account with its redeemer
//   required signers    addSignerKey
//   validity            validFrom, validTo with each slot as the chain's Unix
//                       time (plutus slotToBeginUnixTime; Interval.ts takes
//                       the enclosing slot back exactly)
//   auxiliary data      attachMetadata per label, from the metadata decoded
//                       into the library's TransactionMetadata form
//   treasury            donateToTreasury with the donation and the current
//                       treasury value
//   execution units     complete()'s evaluator option, returning the intent's
//                       observed units for each redeemer at the index the
//                       library gives its target (observedEvaluator), only
//                       for an intent with redeemers: the run holds no cost
//                       models for the library's local evaluator
// Parts the library cannot write are written on the transaction it built,
// unpriced, as every library's replay does: bootstrap witnesses, through the
// same assemble as the vkey witnesses; auxiliary data whose metadata the
// library's form cannot hold (an integer key, a non-text key, an integer
// beyond 2^53, or scripts). library.unpriced names them.
//   votes               vote per voter and action, with the voter's redeemer
//   proposals           propose with the action as its observed CBOR (the
//                       library's 'Cbor' action) and the observed deposit
// Not replayable for the library (a part it has no way to express,
// lucidRefusal): body field 6 and a network id (kit/replay.mjs
// replayRefusal), a Byron address on a fixed or reference input, the legacy
// deregistration certificate and a Conway registration without a redeemer
// (the library writes the other form, internal/Stake.ts:20-67, :69-173), a
// certificate deposit or refund other than the run's parameter (the library
// takes it from the parameters), a pool registration (the library writes the
// margin as margin/margin and fetches the pool metadata to hash it,
// internal/Pool.ts), the genesis-delegation and MIR certificates, a donation
// or a current treasury value without the other (donateToTreasury writes
// both), a witness-set datum that neither a spent
// input nor a requested output needs, and a script the library reads to
// another hash.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { Lucid, CML, coreToUtxo, coreToTxOutput, credentialToRewardAddress, slotToBeginUnixTime, validatorToScriptHash, SLOT_CONFIG_NETWORK } from '@lucid-evolution/lucid';
import { CLASSES } from '../kit/check.mjs';
import { passMachineErrors } from '../kit/machine.mjs';
import { inspectTx, unspentOutputParts } from '../kit/inspect.mjs';
import { replayRefusal, listItems, requiredSigners, replayWitnessKeys, syntheticVkeys, intentScripts, targetKey } from '../kit/replay.mjs';
import { decode, raw, asUint, asBytes, head, encUint } from '../history/cbor.mjs';
import { blake2b256 } from '../history/blake2b.mjs';
import { decodeTx, redeemers as txRedeemers, redeemerTargets } from '../history/tx.mjs';
import { minFee } from '../kit/fee.mjs';
import { need } from '../kit/params.mjs';
import { NOT_REPLAYABLE } from './contract.mjs';
import { buildWithChange } from './change.mjs';
import { inputOrder, recordsOf, refuseUncovered, REPLAY_COVERAGE, errorText, txRecord } from './library.mjs';

// The package exports no package.json; its entry point is dist/index.cjs.
const require = createRequire(import.meta.url);
export const LUCID_VERSION = JSON.parse(readFileSync(join(dirname(require.resolve('@lucid-evolution/lucid')), '..', 'package.json'), 'utf8')).version;
if (LUCID_VERSION !== '0.8.9') throw new Error(`@lucid-evolution/lucid ${LUCID_VERSION} is installed; the baseline is 0.8.9`);

const ERROR_CLASSES = [
  [/Your wallet does not have enough funds to cover the required assets/, CLASSES.balance],
  [/Your wallet does not have enough funds to cover required minimum ADA for change output/, CLASSES.changeMinimum],
  [/Your wallet does not have enough funds to cover the required \d+ Lovelace collateral/, CLASSES.collateral],
  [/Selected \d+ inputs as collateral, but max collateral inputs is/, CLASSES.collateral],
  [/Max collateral input count/, CLASSES.collateral],
  [/Not enough ADA leftover to include non-ADA assets in a change address/, CLASSES.changeMinimum],
  [/UTxO Balance Insufficient/, CLASSES.balance],
  [/Max transaction size of \d+ exceeded/, CLASSES.txSize],
  [/Max value size of \d+ exceeded/, CLASSES.valueSize]
];

// The library's errors carry their cause as text ({ Complete: ... }).
export const lucidErrorText = (e) => (e && e.cause !== undefined && typeof e.cause !== 'object' ? String(e.cause) : e && e.cause && e.cause.message ? `${errorText(e)}: ${e.cause.message}` : errorText(e));

export function classOfLucidError(e) {
  const m = lucidErrorText(e);
  for (const [re, cls] of ERROR_CLASSES) if (re.test(m)) return cls;
  return CLASSES.other;
}

// The library's network for the run's; the synthetic shapes carry mainnet
// addresses.
const networkOf = (network) => (network === 'preprod' ? 'Preprod' : network === 'preview' ? 'Preview' : 'Mainnet');
const networkIdOf = (network) => (network === 'Mainnet' ? 1 : 0);

const ratio = (r) => (r === null || r === undefined ? 0 : Number(r[0]) / Number(r[1]));
const orZero = (x) => (x === null || x === undefined ? 0n : BigInt(x));

// The run's parameters as the library's ProtocolParameters
// (core-types/src/types.ts:5-25). The simulator holds no cost models, so each
// language's is empty; the library uses them for the script-data hash and its
// own evaluator, which the replay replaces. A deposit the run does not state
// is zero here, and an operation that would take it stops first (need); a
// reference-script price the run does not state is zero, and a spend that
// carries a reference script stops first.
export const lucidProtocolParameters = (params) => ({
  minFeeA: Number(params.minFeeA),
  minFeeB: Number(params.minFeeB),
  maxTxSize: params.maxTxSize,
  maxValSize: params.maxValSize,
  keyDeposit: orZero(params.keyDeposit),
  poolDeposit: orZero(params.poolDeposit),
  drepDeposit: orZero(params.drepDeposit),
  govActionDeposit: orZero(params.govActionDeposit),
  priceMem: ratio(params.priceMem),
  priceStep: ratio(params.priceStep),
  maxTxExMem: 0n,
  maxTxExSteps: 0n,
  coinsPerUtxoByte: BigInt(params.coinsPerUtxoByte),
  collateralPercentage: params.collateralPercent,
  maxCollateralInputs: params.maxCollateralInputs,
  minFeeRefScriptCostPerByte: ratio(params.minFeeRefScriptCostPerByte),
  costModels: { PlutusV1: [], PlutusV2: [], PlutusV3: [] }
});

const hexOf = (b) => Buffer.from(b).toString('hex');

// A provider that answers no query: the replay is offline. getDatum answers
// from the intent's witness-set datums, and for a reference input's datum
// hash the history does not hold, with a placeholder (the integer 0): the
// library resolves a reference input's datum before adding it (internal/
// Read.ts readFrom, TxUtils.ts resolveDatum), but the CML fork's
// add_reference_input keeps only the UTxO (tx_builder.rs:851-864), so that
// datum is neither written nor priced, and the evaluator here reads none.
function offlineProvider(datums, referenceHashes) {
  const no = (what) => async () => {
    throw new Error(`the replay is offline: no provider ${what}`);
  };
  return {
    getProtocolParameters: no('protocol parameters'),
    getUtxos: no('UTxOs'),
    getUtxosWithUnit: no('UTxOs'),
    getUtxoByUnit: no('UTxO'),
    getUtxosByOutRef: no('UTxOs'),
    getDelegation: no('delegation'),
    getDatum: async (hash) => {
      if (datums.has(hash)) return datums.get(hash);
      if (referenceHashes.has(hash)) return '00';
      throw new Error(`the replay is offline: no datum ${hash}`);
    },
    awaitTx: no('confirmation'),
    submitTx: no('submission'),
    evaluateTx: no('evaluation')
  };
}

// A UTxO in the library's type from its TransactionUnspentOutput bytes, a
// fresh object for each build (the library writes resolved datums into the
// UTxOs it collects).
const TEMPLATES = new Map();
export function lucidUtxo(cbor) {
  let t = TEMPLATES.get(cbor);
  if (!t) {
    const core = CML.TransactionUnspentOutput.from_cbor_hex(cbor);
    t = coreToUtxo(core);
    core.free();
    if (TEMPLATES.size > 50000) TEMPLATES.clear();
    TEMPLATES.set(cbor, t);
  }
  return { ...t, assets: { ...t.assets }, ...(t.scriptRef ? { scriptRef: { ...t.scriptRef } } : {}) };
}

// The intent's witness-set datums by hash (BLAKE2b-256 of their bytes).
function datumsOf(fixed) {
  const m = new Map();
  if (fixed && fixed.witnesses[4] !== undefined) for (const b of listItems(fixed.witnesses[4])) m.set(hexOf(blake2b256(b)), hexOf(b));
  return m;
}

// Certificates: [kind, ...fields] as decoded nodes, with each one's bytes.
const certificatesOf = (fixed) => (fixed.body[4] === undefined ? [] : listItems(fixed.body[4]).map((b) => ({ bytes: b, n: decode(b), kind: Number(asUint(decode(b).items[0], 'certificate kind')) })));

// A credential node [0 | 1, hash] as the library's Credential.
const credentialOf = (node) => ({ type: Number(asUint(node.items[0], 'credential kind')) === 0 ? 'Key' : 'Script', hash: hexOf(asBytes(node.items[1], 'credential')) });

// A DRep node as the library's DRep (core-types/src/types.ts:582-590).
function drepOf(node) {
  const k = Number(asUint(node.items[0], 'drep kind'));
  if (k === 0) return { type: 'Key', hash: hexOf(asBytes(node.items[1], 'drep')) };
  if (k === 1) return { type: 'Script', hash: hexOf(asBytes(node.items[1], 'drep')) };
  if (k === 2) return { __typename: 'AlwaysAbstain' };
  return { __typename: 'AlwaysNoConfidence' };
}

// An anchor node [url, hash] or null as the library's Anchor.
const anchorOf = (node) => (!node || node.mt === 7 ? undefined : { url: node.items[0].value, dataHash: hexOf(asBytes(node.items[1], 'anchor hash')) });

// A voter node [kind, hash] as the library's GovernanceVoter
// (core-types/src/types.ts:491-507), and a vote's number as its choice.
function voterOf(node) {
  const kind = Number(asUint(node.items[0], 'voter kind'));
  const hash = hexOf(asBytes(node.items[1], 'voter hash'));
  if (kind === 4) return { type: 'StakePool', hash };
  return { type: kind < 2 ? 'ConstitutionalCommittee' : 'DRep', credential: { type: kind % 2 === 0 ? 'Key' : 'Script', hash } };
}
const VOTES = ['No', 'Yes', 'Abstain'];

const poolIdOf = (node) => {
  const h = CML.Ed25519KeyHash.from_raw_bytes(asBytes(node, 'pool'));
  const id = h.to_bech32('pool');
  h.free();
  return id;
};

const CERTIFICATE_DEPOSITS = { 7: 'keyDeposit', 8: 'keyDeposit', 11: 'keyDeposit', 12: 'keyDeposit', 13: 'keyDeposit', 16: 'drepDeposit', 17: 'drepDeposit' };
const DEPOSIT_PLACE = { 7: 2, 8: 2, 11: 3, 12: 3, 13: 4, 16: 2, 17: 2 };

// Why the library cannot write the intent's fixed parts, or null when it can.
export function lucidRefusal(intent, params) {
  const kit = replayRefusal(intent);
  if (kit) return kit;
  const f = intent.fixed;
  if (!f) return null;
  if (f.body[15] !== undefined) return 'body field 15 (network id): no operation writes it, and a replayed intent carries none';
  if ((f.body[21] !== undefined) !== (f.body[22] !== undefined)) return 'a donation or a current treasury value without the other: donateToTreasury writes both, the treasury value fetched from the provider when not given (internal/Treasury.ts:14-75)';
  for (const x of [...f.inputs, ...f.referenceInputs]) if (unspentOutputParts(x.cbor).addr.type === 8) return `a Byron address on ${x.ref}: the library reads a payment credential from every input (internal/Collect.ts addCollectedInput)`;
  const redeemed = (i) => f.redeemers.some((r) => r.target.kind === 'certificate' && r.target.index === i);
  for (const [i, c] of certificatesOf(f).entries()) {
    if (c.kind === 5 || c.kind === 6) return 'a genesis-delegation or MIR certificate: the library has no operation for it';
    if (c.kind === 3) return 'a pool registration: the library writes the margin as margin/margin and fetches the metadata to hash it (internal/Pool.ts:176, :214-236, :239-253)';
    if (c.kind === 1) return 'a legacy stake deregistration: the library writes the Conway deregistration instead (internal/Stake.ts:69-173)';
    if (c.kind === 7 && !redeemed(i)) return 'a Conway stake registration without a redeemer: the library writes the legacy registration unless given one (internal/Stake.ts:20-67)';
    const field = CERTIFICATE_DEPOSITS[c.kind];
    if (field) {
      const coin = asUint(c.n.items[DEPOSIT_PLACE[c.kind]], 'deposit');
      if (params[field] === null || params[field] === undefined || BigInt(params[field]) !== coin) return `a certificate deposit or refund of ${coin}: the library takes ${field} from the protocol parameters (${params[field]})`;
    }
  }
  // A script the library reads to another hash: its Script form holds the
  // script doubly CBOR-wrapped (utils applyDoubleCborEncoding), so a Plutus
  // script whose bytes are not themselves a CBOR byte string is wrapped once
  // more and hashed to another script.
  for (const [hash, e] of intentScripts(f)) {
    const script = e.witness ? scriptOfEntry(e) : lucidUtxo([...f.inputs, ...f.referenceInputs].find((x) => x.ref === e.ref.ref).cbor).scriptRef;
    let h;
    try {
      h = validatorToScriptHash(script);
    } catch (err) {
      return `script ${hash}: the library cannot read it (${errorText(err)})`;
    }
    if (h !== hash) return `script ${hash}: the library reads it to another hash, ${h}`;
  }
  // A witness-set datum neither a spent input nor a requested output takes.
  const datums = datumsOf(f);
  if (datums.size) {
    const taken = new Set();
    for (const x of f.inputs) {
      const p = unspentOutputParts(x.cbor);
      if (p.datum && p.datum.kind === 'hash') taken.add(p.datum.hash);
    }
    for (const o of intent.requested) {
      const p = outputParts(o.cbor);
      if (p.datumHash) taken.add(p.datumHash);
    }
    for (const h of datums.keys()) if (!taken.has(h)) return `a witness-set datum (${h.slice(0, 16)}...) that no spent input or requested output takes: no operation writes it`;
  }
  return null;
}

// A requested output's parts as the library reads them.
function outputParts(cbor) {
  const out = CML.TransactionOutput.from_cbor_hex(cbor);
  const o = coreToTxOutput(out);
  out.free();
  return o;
}

// The intent's metadata in the library's TransactionMetadata form
// (internal/Metadata.ts), label by label, or null when the form cannot hold
// it: a map key other than text, an integer beyond 2^53, or scripts.
function metadataOf(fixed) {
  const b = Buffer.from(fixed.auxiliaryData, 'hex');
  const top = decode(b);
  let map = null;
  if (top.mt === 5) map = top;
  else if (top.mt === 4) {
    if (top.items[1] && top.items[1].items.length) return null;
    map = top.items[0];
  } else if (top.mt === 6) {
    for (const [k, v] of top.item.entries) {
      if (Number(k.value) === 0) map = v;
      else if (v.items.length) return null;
    }
  }
  if (!map || map.mt !== 5) return null;
  const conv = (n) => {
    if (n.mt === 0 || n.mt === 1) {
      const v = n.value;
      if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('integer');
      return Number(v);
    }
    if (n.mt === 2) return new Uint8Array(asBytes(n, 'metadata bytes'));
    if (n.mt === 3) return n.value;
    if (n.mt === 4) return n.items.map(conv);
    if (n.mt === 5) {
      const o = {};
      for (const [k, v] of n.entries) {
        if (k.mt !== 3) throw new Error('key');
        const key = k.value;
        if (Object.hasOwn(o, key)) throw new Error('duplicate');
        o[key] = conv(v);
      }
      return o;
    }
    throw new Error('kind');
  };
  try {
    return map.entries.map(([k, v]) => [Number(asUint(k, 'label')), conv(v)]);
  } catch {
    return null;
  }
}

// The parts the library cannot write, written on its transaction unpriced.
export function unpricedParts(intent) {
  const f = intent.fixed;
  if (!f) return [];
  const out = [];
  if (f.auxiliaryData && !metadataOf(f)) out.push('auxiliary data');
  if (f.witnesses[2] !== undefined) out.push('bootstrap witnesses');
  return out;
}

// The library's Script for an intent's script (kit/replay.mjs intentScripts).
const LANGS = ['Native', 'PlutusV1', 'PlutusV2', 'PlutusV3'];
const scriptOfEntry = (e) => ({ type: LANGS[e.lang], script: hexOf(e.raw) });

// The evaluator (CompleteOptions.evaluator): the intent's observed execution
// units for each redeemer of the library's draft, matched by its target (the
// history reader's resolution of the draft's pointers, history/tx.mjs
// redeemerTargets) to the intent's redeemer for the same target.
const TAGS = ['spend', 'mint', 'publish', 'withdraw', 'vote', 'propose'];
export function observedEvaluator(intent) {
  const byKey = new Map(intent.fixed.redeemers.map((r) => [targetKey(r.target), r]));
  const evaluate = async ({ tx }) => {
    const t = decodeTx(Buffer.from(tx, 'hex'));
    const target = redeemerTargets(t);
    return txRedeemers(t).map((r) => {
      const at = target(r);
      const mine = at && byKey.get(targetKey(at));
      if (!mine) throw new Error(`the library's draft has a redeemer (tag ${r.tag}, index ${r.index}) for no redeemer of the intent`);
      return { redeemer_tag: TAGS[r.tag], redeemer_index: r.index, ex_units: { mem: Number(mine.exUnits[0]), steps: Number(mine.exUnits[1]) } };
    });
  };
  return { name: 'observed', evaluate };
}

// The certificate's operation on builder b.
function certificateOperation(b, c, red, network) {
  const { n, kind } = c;
  const reward = (node) => credentialToRewardAddress(network, credentialOf(node));
  const r = red ? [red] : [];
  switch (kind) {
    case 0:
      return b.registerStake(reward(n.items[1]));
    case 2:
      return b.delegate.ToPool(reward(n.items[1]), poolIdOf(n.items[2]), ...r);
    case 4:
      return b.retire.Pool(poolIdOf(n.items[1]), asUint(n.items[2], 'epoch'));
    case 7:
      return b.register.Stake(reward(n.items[1]), red);
    case 8:
      return b.deregister.Stake(reward(n.items[1]), ...r);
    case 9:
      return b.delegate.VoteToDRep(reward(n.items[1]), drepOf(n.items[2]), ...r);
    case 10:
      return b.delegate.VoteToPoolAndDRep(reward(n.items[1]), poolIdOf(n.items[2]), drepOf(n.items[3]), ...r);
    case 11:
      return b.registerAndDelegate.ToPool(reward(n.items[1]), poolIdOf(n.items[2]), ...r);
    case 12:
      return b.registerAndDelegate.ToDRep(reward(n.items[1]), drepOf(n.items[2]), ...r);
    case 13:
      return b.registerAndDelegate.ToPoolAndDRep(reward(n.items[1]), poolIdOf(n.items[2]), drepOf(n.items[3]), ...r);
    case 14:
      return b.authCommitteeHot(reward(n.items[1]), reward(n.items[2]), ...r);
    case 15:
      return b.resignCommitteeHot(reward(n.items[1]), anchorOf(n.items[2]), ...r);
    case 16:
      return b.register.DRep(reward(n.items[1]), anchorOf(n.items[3]), ...r);
    case 17:
      return b.deregister.DRep(reward(n.items[1]), ...r);
    case 18:
      return b.updateDRep(reward(n.items[1]), anchorOf(n.items[2]), ...r);
    default:
      throw new Error(`certificate kind ${kind}: no operation`);
  }
}

// The intent's fixed parts as the library's operations on builder b.
function withFixedParts(b, intent, params, network, unpriced) {
  const f = intent.fixed;
  const reds = new Map(f.redeemers.map((r) => [targetKey(r.target), r.data]));
  const red = (t) => reds.get(targetKey(t));
  const scripts = intentScripts(f);
  for (const e of scripts.values()) {
    if (!e.witness) continue;
    b = b.attach.Script(scriptOfEntry(e));
  }
  if (f.referenceInputs.length) b = b.readFrom(f.referenceInputs.map((x) => lucidUtxo(x.cbor)));
  const datums = datumsOf(f);
  for (const x of f.inputs) {
    const u = lucidUtxo(x.cbor);
    if (u.datumHash && datums.has(u.datumHash)) u.datum = datums.get(u.datumHash);
    const d = red({ kind: 'input', ref: x.ref });
    b = d === undefined ? b.collectFrom([u]) : b.collectFrom([u], d);
  }
  if (f.body[9] !== undefined) {
    const byPolicy = new Map();
    const add = (a, q) => {
      if (!byPolicy.has(a.policy)) byPolicy.set(a.policy, {});
      byPolicy.get(a.policy)[`${a.policy}${a.name}`] = q;
    };
    for (const a of intent.implicit.mint) add(a, BigInt(a.qty));
    for (const a of intent.implicit.burn) add(a, -BigInt(a.qty));
    for (const [policy, assets] of byPolicy) {
      const d = red({ kind: 'policy', policy });
      b = d === undefined ? b.mintAssets(assets) : b.mintAssets(assets, d);
    }
  }
  certificatesOf(f).forEach((c, i) => {
    const field = CERTIFICATE_DEPOSITS[c.kind];
    if (field) need(params, field);
    b = certificateOperation(b, c, red({ kind: 'certificate', index: i }), network);
  });
  if (f.body[5] !== undefined) {
    const buf = Buffer.from(f.body[5], 'hex');
    for (const [k, v] of decode(buf).entries) {
      const accountBytes = asBytes(k, 'reward account');
      const addr = CML.Address.from_raw_bytes(accountBytes);
      const bech = addr.to_bech32();
      addr.free();
      const d = red({ kind: 'withdrawal', account: hexOf(accountBytes) });
      b = d === undefined ? b.withdraw(bech, asUint(v, 'withdrawal')) : b.withdraw(bech, asUint(v, 'withdrawal'), d);
    }
  }
  if (f.body[19] !== undefined) {
    const buf = Buffer.from(f.body[19], 'hex');
    for (const [voterNode, votes] of decode(buf).entries) {
      const voter = voterOf(voterNode);
      const d = red({ kind: 'voter', voter: hexOf(raw(buf, voterNode)) });
      for (const [idNode, proc] of votes.entries) {
        const actionId = { txHash: hexOf(asBytes(idNode.items[0], 'action id')), index: asUint(idNode.items[1], 'action index') };
        const choice = VOTES[Number(asUint(proc.items[0], 'vote'))];
        b = b.vote(voter, actionId, choice, anchorOf(proc.items[1]), ...(d === undefined ? [] : [d]));
      }
    }
  }
  if (f.body[20] !== undefined) {
    listItems(f.body[20]).forEach((bytes, i) => {
      const n = decode(bytes);
      const account = CML.Address.from_raw_bytes(asBytes(n.items[1], 'return account'));
      const returnAddress = account.to_bech32();
      account.free();
      const proposal = { deposit: asUint(n.items[0], 'proposal deposit'), returnAddress, action: { type: 'Cbor', cbor: hexOf(raw(bytes, n.items[2])) }, anchor: anchorOf(n.items[3]) };
      const d = red({ kind: 'proposal', index: i });
      b = d === undefined ? b.propose(proposal) : b.propose(proposal, d);
    });
  }
  for (const h of requiredSigners(f)) b = b.addSignerKey(h);
  const slotConfig = SLOT_CONFIG_NETWORK[network];
  const time = (k) => slotToBeginUnixTime(Number(asUint(decode(Buffer.from(f.body[k], 'hex')), 'slot')), slotConfig);
  if (f.body[8] !== undefined) b = b.validFrom(time(8));
  if (f.body[3] !== undefined) b = b.validTo(time(3));
  if (f.auxiliaryData && !unpriced.includes('auxiliary data')) for (const [label, value] of metadataOf(f)) b = b.attachMetadata(label, value);
  if (f.body[22] !== undefined) {
    const donation = asUint(decode(Buffer.from(f.body[22], 'hex')), 'donation');
    b = b.donateToTreasury(donation, asUint(decode(Buffer.from(f.body[21], 'hex')), 'treasury'));
  }
  return b;
}

// The requested outputs on builder b.
function withRequested(b, intent, datums) {
  for (const o of intent.requested) {
    const p = outputParts(o.cbor);
    if (!p.datumHash && !p.datum && !p.scriptRef) {
      b = b.pay.ToAddress(p.address, p.assets);
      continue;
    }
    let datum;
    if (p.datum) datum = { kind: 'inline', value: p.datum };
    else if (p.datumHash) datum = datums.has(p.datumHash) ? { kind: 'asHash', value: datums.get(p.datumHash) } : { kind: 'hash', value: p.datumHash };
    b = b.pay.ToAddressWithData(p.address, datum, p.assets, p.scriptRef || undefined);
  }
  return b;
}

// A witness set holding the given vkey witnesses and bootstrap witnesses
// (their CBOR items), as the hex that TxSignBuilder.assemble takes.
function witnessSetHex(vkeys, bootstraps) {
  const entries = [];
  if (vkeys.length) entries.push([encUint(0), Buffer.concat([head(4, vkeys.length), ...vkeys])]);
  if (bootstraps.length) entries.push([encUint(2), Buffer.concat([head(4, bootstraps.length), ...bootstraps])]);
  return Buffer.concat([head(5, entries.length), ...entries.flat()]).toString('hex');
}

// The intent's auxiliary data written on the library's transaction, with its
// hash in the body, through the CML fork's types.
function withAuxiliaryData(hex, auxHex) {
  const tx = CML.Transaction.from_cbor_hex(hex);
  const body = tx.body();
  const aux = CML.AuxiliaryData.from_cbor_hex(auxHex);
  body.set_auxiliary_data_hash(CML.hash_auxiliary_data(aux));
  const ws = tx.witness_set();
  const out = CML.Transaction.new(body, ws, tx.is_valid(), aux);
  const bytes = out.to_cbor_hex();
  for (const o of [out, ws, aux, body, tx]) o.free();
  return bytes;
}

const refsOf = (t) => t.inputs.map((x) => x.ref);

// The layout change on the library's inputs (opts.changePolicy 'layout'), as
// methods/evo.mjs layoutOnLibraryInputs: the library has built its
// transaction as for its own change, with the same wallet, options and
// collateral choice; the wallet inputs it selected and the collateral it
// chose are read from that transaction, its change outputs are dropped, and
// the simulator's layout change is built on those inputs, the kit assembling
// the transaction at its exact fee with the intent's fixed parts and the
// library's collateral as the library wrote it.
function layoutOnLibraryInputs(T, state, intent, params, hex, fixedRefs, name) {
  const t = inspectTx(hex);
  const refs = refsOf(t);
  for (const x of fixedRefs) if (!refs.includes(x)) return { ok: false, class: CLASSES.other, detail: `the library left out the fixed input ${x}` };
  const inputs = recordsOf(state, refs.filter((x) => !fixedRefs.has(x)));
  let collateralFor;
  const collateralRefs = t.collateralInputs.map((x) => x.ref);
  if (collateralRefs.length) {
    const utxos = collateralRefs.map((ref) => {
      const u = state.utxos.get(ref);
      if (!u) throw new Error(`${name}: the library chose ${ref} as collateral, which is not in the state`);
      return u;
    });
    const collateral = { utxos, total: t.totalCollateral, returnBytes: t.collateralReturn ? t.collateralReturn.raw : null };
    collateralFor = () => ({ ok: true, collateral });
  } else if (intent.collateral.required) collateralFor = () => null;
  const r = buildWithChange(T, { state, params, inputs, intent, policy: 'layout', ...(collateralFor ? { collateralFor } : {}) });
  if (!r.ok) return { ok: false, class: r.class, detail: `layout change on the library's inputs: ${r.detail}` };
  return { ok: true, kind: 'single', txs: [txRecord(r.bytes, inputs.map((u) => u.ref), r.fee, r.size, r.k)], library: { collateral: collateralRefs } };
}

// Builds the intent with the library: its own change, or with
// opts.changePolicy 'layout' the layout change on the inputs it selected.
export async function buildLucid(state, intent, params, opts, { name = 'lucid-lf', T = null } = {}) {
  const layout = opts.changePolicy === 'layout';
  if (opts.changePolicy !== 'default' && !layout) return { ok: false, class: CLASSES.other, detail: 'the Lucid Evolution baseline takes its own change or the layout change only' };
  if (layout && !T) throw new Error(`${name}: the layout change needs the treatment`);
  if (!T) throw new Error(`${name}: the witnesses need the treatment`);
  if (opts.collateral) throw new Error(`${name}: the library chooses its own collateral and cannot be given a UTxO set aside`);
  const replay = intent.source === 'replay';
  const f = replay ? intent.fixed : null;
  if (replay) {
    const refusal = lucidRefusal(intent, params);
    if (refusal) return { ok: false, class: NOT_REPLAYABLE, detail: refusal };
  }
  const network = networkOf(state.network);
  const fixedRefs = new Set(f ? f.inputs.map((x) => x.ref) : []);
  const unpriced = replay ? unpricedParts(intent) : [];
  const datums = datumsOf(f);
  const referenceHashes = new Set();
  if (f) {
    for (const x of f.referenceInputs) {
      const p = unspentOutputParts(x.cbor);
      if (p.datum && p.datum.kind === 'hash') referenceHashes.add(p.datum.hash);
    }
  }
  let sb;
  try {
    if (params.minFeeRefScriptCostPerByte === null) {
      const carried = [...inputOrder(state), ...(f ? [...f.inputs, ...f.referenceInputs] : [])].some((u) => unspentOutputParts(u.cbor).scriptRef);
      if (carried) need(params, 'minFeeRefScriptCostPerByte');
    }
    const lucid = await Lucid(offlineProvider(datums, referenceHashes), network, { presetProtocolParameters: lucidProtocolParameters(params) });
    lucid.selectWallet.fromAddress(state.changeAddress, inputOrder(state).filter((u) => !fixedRefs.has(u.ref)).map((u) => lucidUtxo(u.cbor)));
    let b = lucid.newTx();
    b = withRequested(b, intent, datums);
    if (f) b = withFixedParts(b, intent, params, network, unpriced);
    const options = f && f.redeemers.length ? { evaluator: observedEvaluator(intent) } : {};
    sb = await b.complete(options);
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: classOfLucidError(e), detail: `complete: ${lucidErrorText(e).split('\n')[0]}` };
  }
  const unsigned = sb.toCBOR();
  if (layout) return layoutOnLibraryInputs(T, state, intent, params, unsigned, fixedRefs, name);
  const t = inspectTx(unsigned);
  const refs = refsOf(t);
  for (const x of fixedRefs) if (!refs.includes(x)) return { ok: false, class: CLASSES.other, detail: `the library left out the fixed input ${x}` };
  const walletRefs = refs.filter((x) => !fixedRefs.has(x));
  const inputs = recordsOf(state, walletRefs);
  const collateralRefs = t.collateralInputs.map((x) => x.ref);
  const collateral = collateralRefs.map((r) => state.utxos.get(r)).filter(Boolean);
  const keys = replay ? replayWitnessKeys(f, { inputs, collateral }) : new Set(inputs.map((u) => u.cred));
  const others = f && f.witnesses[0] !== undefined ? listItems(f.witnesses[0]) : [];
  const bootstraps = f && f.witnesses[2] !== undefined ? listItems(f.witnesses[2]) : [];
  let bytes;
  try {
    const signed = await sb.assemble([witnessSetHex([...syntheticVkeys(T, keys.size), ...others], bootstraps)]).complete();
    bytes = signed.toCBOR();
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: CLASSES.other, detail: `sign: ${lucidErrorText(e).split('\n')[0]}` };
  }
  if (unpriced.includes('auxiliary data')) bytes = withAuxiliaryData(bytes, f.auxiliaryData);
  const signedTx = inspectTx(bytes);
  if (!replay) return { ok: true, kind: 'single', txs: [txRecord(bytes, walletRefs, t.fee, signedTx.size, keys.size)] };
  const scriptFee = f ? f.scriptFee : 0n;
  // The intent's other vkey witnesses as observed, written after the library
  // priced the transaction, are named unpriced when its fee falls short of
  // the signed transaction's minimum (the library prices a fake witness for
  // each key its builder counts, which need not include them all).
  const observedUnpriced = others.length > 0 && t.fee < minFee(params, signedTx.size, scriptFee);
  return {
    ok: true,
    kind: 'single',
    txs: [txRecord(bytes, walletRefs, t.fee, signedTx.size, keys.size)],
    library: { fee: t.fee, finalMinFee: minFee(params, signedTx.size, scriptFee), collateral: collateralRefs, unpriced: observedUnpriced ? [...unpriced, 'observed vkey witnesses'] : unpriced }
  };
}

export function lucidMethod({ T = null } = {}) {
  const name = 'lucid-lf';
  return {
    name,
    version: `@lucid-evolution/lucid ${LUCID_VERSION} LargestFirst`,
    deterministic: true,
    seeded: true,
    ownCollateral: true,
    async build(state, intent, params, opts) {
      refuseUncovered(name, REPLAY_COVERAGE.lucid, intent);
      return buildLucid(state, intent, params, opts, { name, T });
    }
  };
}
