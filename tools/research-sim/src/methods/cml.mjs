// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Cardano Multiplatform Lib baselines, cml-lf and cml-ri:
// @dcspark/cardano-multiplatform-lib-nodejs 6.2.0, the WebAssembly build of
// dcSpark/cardano-multiplatform-lib at tag 6.2.0 (commit
// a34592e1e0d3c1e958d72f05c72282d788403aa5, the npm gitHead; paths below are
// under chain/rust/src/). The library is its own instance, loaded here and
// nowhere else; no code path is shared with the cardano-serialization-lib
// adapter (methods/csl.mjs), so a change to one cannot alter the other's
// records.
//
// The call, as a dapp makes it for a payment (the library has no default
// strategy, so the caller names one, and the study runs both of its
// multi-asset strategies): TransactionBuilder.new(config) with the run's
// parameters, add_output for each requested output, add_utxo for each of the
// wallet's spendable UTxOs in the state's order (inputOrder), select_utxos
// with CoinSelectionStrategyCIP2 LargestFirstMultiAsset (cml-lf) or
// RandomImproveMultiAsset (cml-ri), then build(ChangeSelectionAlgo.Default,
// change address). The library, at that commit (builders/tx_builder.rs):
//
//   select_utxos (:450-585) selects from the builder's own list, filled by
//   add_utxo (:818-820), toward the outputs plus deposits, burns and donation
//   (get_total_output, :1259-1270) plus min_fee(false) (:455-459), which
//   prices the body with fake witnesses and no execution units (:221-225,
//   :1537-1550). Unlike cardano-serialization-lib it adds no first input
//   before selecting. LargestFirstMultiAsset (:510-536) runs
//   cip2_largest_first_by (:587-630) once for each asset of that total, in
//   policy and asset-name order, then once for ADA: each pass sorts the
//   remaining UTxOs holding its asset ascending by its quantity with Rust's
//   stable sort_by_key and walks them from the end, so among equal quantities
//   the UTxO given later is taken first; each added input's fee
//   (fee_for_input, :823-838) is added to the target, and a taken UTxO is
//   removed with swap_remove (:617), which moves the list's last index into
//   its place, so later passes see the rest in a permuted order.
//   RandomImproveMultiAsset (:534-582) runs cip2_random_improve_by
//   (:632-741) for each asset, then for ADA, from rand::thread_rng() (:535),
//   which no caller can seed: for each requested output holding the asset,
//   largest first, it draws UTxOs holding it until that output's quantity is
//   covered; then, while candidates remain, an improvement phase swaps each
//   draw for a random candidate whose coin is closer to twice the output's
//   coin and under three times it (:699-726), comparing coin even on a token's
//   pass; then random UTxOs, any kind, until the coin covers the outputs and
//   the fees ("Phase 3", :560-581). A deposit, a burn or a fee alone is
//   served only by phase 3, which covers coin only.
//
//   build (:1510-1526) runs add_change_if_needed (:1713-2080) with execution
//   units counted (min_fee(true), :1537-1550, :227-275), then build_body,
//   which refuses a transaction over max_tx_size (:1474-1488). The change:
//   with no leftover asset, one output of the leftover ADA, or, under the
//   output's minimum plus its fee, the leftover burned into the fee
//   (burn_extra, :1996-2003); with leftover assets, outputs packed greedily
//   in policy and asset-name order, a new output starting when the next asset
//   would take it over max_value_size (pack_nfts_for_change), each at its own
//   minimum coin (with_asset_and_min_required_coin), the leftover ADA on the
//   last (:1970-1983); prefer_pure_change is false (:295). Leftover ADA that
//   cannot fund a token change output fails with "Not enough ADA leftover to
//   include non-ADA assets in a change address" (:1934-1936). It adds no
//   input: selection is select_utxos alone.
//
//   Fees: min_fee prices the transaction with the fee field at u64::MAX, the
//   validity flag and fake vkey witnesses for the keys the builder counts
//   (fake_full_tx, :148-158), plus the execution units at the configured
//   prices (fees.rs:38-60) and the reference scripts of reference inputs that
//   lock a script input (:231-275); its fee is a few bytes above the ledger's
//   minimum for its own size.
//
// Errors to failure classes (setting unclassified 'other' for the rest;
// TxBuilderError, :174-218):
//   "Not enough ADA leftover to include non-ADA assets in a change address"
//                                                       change-minimum
//   "UTxO Balance Insufficient. ...", "Missing input or output (possibly
//   some native asset)", and "Asset arithmetic: PolicyId ... doesn't
//   exist" (or an asset's, or an underflow; assets/utils.rs:32-40), which
//   add_change_if_needed raises when the inputs lack an asset the
//   transaction takes, as when RandomImproveMultiAsset drew nothing for a
//   token only a burn needs                             balance
//   "Max transaction size of ... exceeded. ..."         tx-size
//   "Max value size of ... exceeded. ...", "NFTs too large for change
//   output"                                             value-size
//   "Max collateral input count ... exceeded", "Collateral can only be
//   payment keys ..."                                   collateral
// A requested output the library refuses (add_output, :862-889: its value
// over max_value_size or its coin under CML's minimum) is the intent's, not
// replayable.
//
// Witnesses (setting serialization 'own'): build returns the body and the
// witness set CML's builders wrote (scripts, datums, redeemers) with no vkey
// witness; the adapter writes one synthetic vkey witness per wallet key
// (kit/replay.mjs replayWitnessKeys) into that witness set, encoded by the
// library, then the intent's other vkey witnesses and its bootstrap
// witnesses as observed, in that order. CML keeps vkey witnesses in a hash
// map (builders/witness_builder.rs:254), whose order varies from one build to
// the next, so the adapter sets the list itself and the same replay gives the
// same bytes.
//
// Change policies: 'default' (L/own) is the library's own change; 'layout'
// (L/layout) makes the same select_utxos call, keeps the inputs it chose,
// builds the body at a zero fee, so that build adds no change (a set fee
// returns before change, :1720-1722), reads the wallet inputs from it, and
// builds UnFrack.It's layout change on those inputs (methods/change.mjs),
// assembled at its exact fee by the kit with the intent's parts, as the
// cardano-serialization-lib adapter does after add_inputs_from. When those
// inputs cannot fund that change, class change-minimum (setting
// substitutedChange 'fail'). A failure of select_utxos, or of the zero-fee
// body, is the library's under either policy. No other policy is accepted.
//
// The replay path. Every intent is a replayed one (source 'replay'), built by
// CML's own builders, its fixed parts first, as select_utxos asks
// (:443-445: "called after adding all certs/outputs/etc"):
//   requested outputs  add_output with each output's own bytes
//                      (TransactionOutput.from_cbor_bytes, which keeps their
//                      encoding), so a datum, a script reference and a coin
//                      raised to its minimum pass through
//   reference inputs   add_reference_input, before anything that refers to
//                      one (:840-859)
//   fixed inputs       add_input (:743-816) with SingleInputBuilder: a key or
//                      Byron input by payment_key, a native script input by
//                      native_script with its script and its required
//                      signers as the witness keys, a Plutus input by
//                      plutus_script (its datum from the witness set, for a
//                      datum hash) or plutus_script_inline_datum, with a
//                      PlutusScriptWitness carrying the script from the
//                      witness set or, for a reference script, its hash.
//                      Inputs carrying a reference script go first, so that
//                      add_input finds a reference script among the scripts
//                      the builder has seen (:771-806)
//   mint, burn         add_mint with SingleMintBuilder per policy, its
//                      native script or Plutus witness (:1074-1111)
//   certificates       add_cert with SingleCertificateBuilder: payment_key,
//                      native_script or plutus_script (certificate_builder.rs)
//   withdrawals        add_withdrawal with SingleWithdrawalBuilder, likewise
//   votes, proposals   add_vote with VoteBuilder (with_vote,
//                      with_native_script_vote,
//                      with_plutus_vote_inline_datum), add_proposal with
//                      ProposalBuilder (with_proposal,
//                      with_native_script_proposal,
//                      with_plutus_proposal_inline_datum)
//   validity           set_ttl, set_validity_start_interval
//   required signers   add_required_signer
//   auxiliary data     set_auxiliary_data, CML reading the intent's bytes
//   treasury fields    set_current_treasury_value, set_donation
//   execution units    set_exunits for each redeemer at its observed units,
//                      keyed as CML numbers its redeemers
//                      (redeemer_builder.rs:120-165): a spend by its input's
//                      place among the fixed inputs (the only inputs before
//                      selection; a later input does not move the entry), a
//                      mint by its policy's place, a withdrawal by its reward
//                      account's place in CML's order (network, then a key
//                      credential before a script, address.rs:647-660,
//                      certs/mod.rs:206-214), a certificate by its place, a
//                      vote or proposal by its place among the script-
//                      witnessed ones, one entry per vote. Where CML's
//                      number differs from the ledger's (a script withdrawal
//                      beside a key one, a script vote or proposal after an
//                      unwitnessed one), the redeemer points elsewhere and the
//                      engine's redeemer check fails the spend, class other;
//                      CML's script data hash leaves out vote and proposal
//                      redeemers (redeemer_builder.rs:112-117)
//   collateral         the UTxO the engine set aside (opts.collateral) by
//                      add_collateral (:1143-1186), with a return output at
//                      the change address, which is how CML writes the total
//                      collateral (calc_collateral_total, :1299-1317). While
//                      CML selects and balances, the return holds the
//                      collateral's value less 65,536 lovelace, a total that
//                      encodes as wide as any total a fee can give; once
//                      build has set the fee, the total is set for that fee
//                      (collateralPercent of it, rounded up, as every
//                      method's replay carries it) and the return is the
//                      rest. Neither field grows, so CML's fee still covers
//                      its transaction. CML never chooses collateral.
//   script data hash   CML computes it from cost models (build_and_size,
//                      :1319-1459), which a history file does not carry; the
//                      configuration holds empty ones for the three Plutus
//                      languages so that the computation runs, and, as the
//                      kit writes body field 11 for every other method
//                      (kit/replay.mjs), the field is replaced after build by
//                      BLAKE2b-256 over the redeemers and datums as CML
//                      serialized them. CML writes no hash when the only
//                      redeemers are a vote's or a proposal's, or for datums
//                      without redeemers (:1329-1330); the adapter writes it
//                      then, unpriced.
//   other datums       the witness set's datums no input takes: CML's
//                      transaction builder writes one only for an output it
//                      builds itself with communication data
//                      (output_builder.rs, add_output :881-884), which would
//                      replace the requested output's own bytes, so they are
//                      added to its witness set after build, unpriced.
// The parts written after CML priced the transaction (the intent's other vkey
// witnesses and bootstrap witnesses, other datums, a script data hash CML did
// not write, and reference-script bytes CML does not count) are named in
// library.unpriced when the transaction outgrew the one CML priced, or, for
// reference scripts, when CML counts fewer bytes than the intent's.
//
// Not replayable for CML (a part it has no way to express): body field 6
// (kit/replay.mjs replayRefusal); a deposit or refund CML counts differently
// from the transaction (deposit.rs: a pool registration always at the pool
// deposit, a committee resignation refunded at the key deposit); a native
// script given only by reference, since CML takes a native script only into
// the witness set; a script, datum or redeemer a part needs that the intent
// does not hold; a
// requested output, a script or a part CML refuses or reads to another hash;
// a script in the witness set or a redeemer that no part CML builds takes.
//
// A failure CML raises by aborting rather than returning an error: a
// reference input carrying a native script reference makes min_fee(true)
// panic (raw_plutus_bytes().expect, :233-238) in build under L/own; the
// adapter records that spend as the library's failure, class other, without
// making the call, since an abort would end the worker.

import CML from '@dcspark/cardano-multiplatform-lib-nodejs';
import { createRequire } from 'node:module';
import { CLASSES } from '../kit/check.mjs';
import { passMachineErrors } from '../kit/machine.mjs';
import { buildWithChange } from './change.mjs';
import { inputOrder, recordsOf, refuseUncovered, REPLAY_COVERAGE, errorText, txRecord } from './library.mjs';
import { inspectTx, unspentOutputParts } from '../kit/inspect.mjs';
import { replayRefusal, listItems, requiredSigners, replayWitnessKeys, intentScripts, redeemerKey, targetKey, syntheticVkeys } from '../kit/replay.mjs';
import { NOT_REPLAYABLE } from './contract.mjs';
import { totalCollateralFor } from '../replay/collateral.mjs';
import { minFee } from '../kit/fee.mjs';
import { decode, raw, asBytes, asUint, asInt, setItems } from '../history/cbor.mjs';
import { blake2b224, blake2b256 } from '../history/blake2b.mjs';

export const CML_VERSION = createRequire(import.meta.url)('@dcspark/cardano-multiplatform-lib-nodejs/package.json').version;
export const CML_STRATEGIES = Object.freeze({ lf: 'LargestFirstMultiAsset', ri: 'RandomImproveMultiAsset' });

const ERROR_CLASSES = [
  [/^Not enough ADA leftover to include non-ADA assets in a change address/, CLASSES.changeMinimum],
  [/^UTxO Balance Insufficient/, CLASSES.balance],
  [/^Missing input or output/, CLASSES.balance],
  [/^Asset arithmetic: (PolicyId .* doesn't exist|Asset .* doesn't exist|Arithmetic failed: Integer underflow)/, CLASSES.balance],
  [/^Max transaction size of \d+ exceeded/, CLASSES.txSize],
  [/^Max value size of \d+ exceeded/, CLASSES.valueSize],
  [/^NFTs too large for change output/, CLASSES.valueSize],
  [/^Max collateral input count \d+ exceeded/, CLASSES.collateral],
  [/^Collateral can only be payment keys/, CLASSES.collateral]
];

export function classOfCmlError(text) {
  for (const [re, cls] of ERROR_CLASSES) if (re.test(text)) return cls;
  return CLASSES.other;
}

// The objects a build makes, freed together. An object a call moved into the
// library has a null pointer and is skipped.
function scope() {
  const xs = [];
  return {
    k(o) {
      if (o) xs.push(o);
      return o;
    },
    free() {
      for (const o of xs.reverse()) if (o.__wbg_ptr) o.free();
      xs.length = 0;
    }
  };
}

// Empty cost models for Plutus V1 to V3, {0: [], 1: [], 2: []}: the script
// data hash CML computes from them is replaced (see above).
const EMPTY_COST_MODELS = Buffer.from('a3008001800280', 'hex');

// The builder's configuration from the run's parameters.
export function cmlConfig(params, S) {
  const k = S.k;
  if (params.poolDeposit === null || params.keyDeposit === null) throw new Error('cml: the builder needs the key and pool deposits, which this run does not state');
  const r = params.minFeeRefScriptCostPerByte;
  if (r && BigInt(r[1]) !== 1n) throw new Error(`cml: the builder takes a whole reference-script price per byte, not ${r[0]}/${r[1]}`);
  // CML requires execution prices; a run without them prices no script.
  const price = (x) => k(CML.Rational.new(BigInt(x ? x[0] : 0), BigInt(x ? x[1] : 1)));
  // Each step of the configuration builder consumes the one before.
  const cfg = CML.TransactionBuilderConfigBuilder.new()
    .fee_algo(k(CML.LinearFee.new(BigInt(params.minFeeA), BigInt(params.minFeeB), r ? BigInt(r[0]) : 0n)))
    .coins_per_utxo_byte(BigInt(params.coinsPerUtxoByte))
    .pool_deposit(BigInt(params.poolDeposit))
    .key_deposit(BigInt(params.keyDeposit))
    .max_value_size(Number(params.maxValSize))
    .max_tx_size(Number(params.maxTxSize))
    .ex_unit_prices(k(CML.ExUnitPrices.new(price(params.priceMem), price(params.priceStep))))
    .cost_models(k(CML.CostModels.from_cbor_bytes(EMPTY_COST_MODELS)))
    .collateral_percentage(Number(params.collateralPercent))
    .max_collateral_inputs(Number(params.maxCollateralInputs))
    .build();
  return k(cfg);
}

const hexOf = (b) => Buffer.from(b).toString('hex');
const refOf = (input) => `${input.transaction_id().to_hex()}#${input.index()}`;
const utxoOf = (cbor, S) => S.k(CML.TransactionUnspentOutput.from_cbor_bytes(Buffer.from(cbor, 'hex')));

class Unexpressible extends Error {}
const nr = (m) => {
  throw new Unexpressible(m);
};

const PLUTUS = [null, 'PlutusV1Script', 'PlutusV2Script', 'PlutusV3Script'];
const FROM = [null, 'from_v1', 'from_v2', 'from_v3'];
const BODY_PARTS = new Set([3, 4, 5, 8, 9, 14, 19, 20, 21, 22]);
const WITNESS_PARTS = new Set([0, 1, 2, 3, 4, 5, 6, 7]);

// CML's order of reward accounts (two reward addresses' bytes): network, then
// a key credential before a script one, then the hash.
function cmlRewardOrder(a, b) {
  const na = a[0] & 15;
  const nb = b[0] & 15;
  if (na !== nb) return na - nb;
  const sa = a[0] >> 4 === 15 ? 1 : 0;
  const sb = b[0] >> 4 === 15 ? 1 : 0;
  if (sa !== sb) return sa - sb;
  return Buffer.compare(a.subarray(1), b.subarray(1));
}
const cmpRefs = (a, b) => {
  const [ta, ia] = a.split('#');
  const [tb, ib] = b.split('#');
  return Buffer.compare(Buffer.from(ta, 'hex'), Buffer.from(tb, 'hex')) || Number(ia) - Number(ib);
};

// The intent's fixed parts put into the builder `tb`. Throws Unexpressible
// for a part CML has no way to express. Returns { datums } (the witness set's
// datums no input took, written after build).
function addFixedParts(tb, intent, S, at) {
  const k = S.k;
  const f = intent.fixed;
  const scripts = intentScripts(f);
  const reds = new Map();
  for (const r of f.redeemers) {
    const key = redeemerKey(r);
    if (Number(key[0]) !== r.tag) nr(`a redeemer with tag ${r.tag} points at a ${r.target.kind}`);
    reds.set(key, r);
  }
  const usedReds = new Set();
  const exUnits = [];
  const datums = new Map();
  if (f.witnesses[4] !== undefined) for (const r of listItems(f.witnesses[4])) datums.set(hexOf(blake2b256(r)), { raw: r, used: false });
  const field = (n) => Buffer.from(f.body[n], 'hex');
  const noSigners = () => k(CML.Ed25519KeyHashList.new());
  // The redeemer of a part, its execution units set once the part's place in
  // CML's numbering is known (`place`).
  const partial = (key, s, what) => {
    const r = reds.get(key);
    if (!r) nr(`${what}: a Plutus script without its redeemer`);
    usedReds.add(key);
    return { witness: k(CML.PartialPlutusWitness.new(s.witness, k(CML.PlutusData.from_cbor_bytes(Buffer.from(r.data, 'hex'))))), units: r.exUnits };
  };
  // The script for a script hash: { native, script } or { native: false,
  // witness }.
  const source = (hash, what) => {
    const e = scripts.get(hash);
    if (!e) nr(`${what}: no script with hash ${hash} in the witness set or a reference script`);
    e.used = true;
    if (e.lang === 0) {
      if (e.ref) nr(`${what}: native script ${hash} is given only by reference, and CML takes a native script only into the witness set`);
      const ns = k(CML.NativeScript.from_cbor_bytes(e.raw));
      if (k(ns.hash()).to_hex() !== hash) nr(`${what}: CML reads native script ${hash} to another hash`);
      return { native: true, script: ns, info: () => k(CML.NativeScriptWitnessInfo.vkeys(k(ns.get_required_signers()))) };
    }
    if (e.ref) return { native: false, witness: k(CML.PlutusScriptWitness.new_ref(k(CML.ScriptHash.from_hex(hash)))) };
    const ps = k(CML.PlutusScript[FROM[e.lang]](k(CML[PLUTUS[e.lang]].from_cbor_bytes(e.raw))));
    if (k(ps.hash()).to_hex() !== hash) nr(`${what}: CML reads Plutus script ${hash} to another hash`);
    return { native: false, witness: k(CML.PlutusScriptWitness.new_script(ps)) };
  };

  at('body and witness fields');
  for (const n of Object.keys(f.body).map(Number)) if (!BODY_PARTS.has(n)) nr(`body field ${n}`);
  for (const n of Object.keys(f.witnesses).map(Number)) if (!WITNESS_PARTS.has(n)) nr(`witness set key ${n}`);
  const fixedRefs = new Set(f.inputs.map((x) => x.ref));
  for (const x of f.referenceInputs) if (fixedRefs.has(x.ref)) nr(`${x.ref} is both an input and a reference input`);

  at('reference inputs');
  for (const x of f.referenceInputs) tb.add_reference_input(utxoOf(x.cbor, S));

  at('fixed inputs');
  const ins = f.inputs.map((x) => ({ x, p: unspentOutputParts(x.cbor) }));
  // Inputs carrying a reference script first, so that a later input's
  // reference-script witness finds it.
  ins.sort((a, b) => (b.p.scriptRef ? 1 : 0) - (a.p.scriptRef ? 1 : 0));
  const spendPlace = [...fixedRefs].sort(cmpRefs);
  for (const { x, p } of ins) {
    const b = k(CML.SingleInputBuilder.from_transaction_unspent_output(utxoOf(x.cbor, S)));
    let result;
    if (p.addr.paymentKind === 'script') {
      const s = source(p.addr.payment, `input ${x.ref}`);
      if (s.native) result = k(b.native_script(s.script, s.info()));
      else {
        const key = targetKey({ kind: 'input', ref: x.ref });
        const w = partial(key, s, `input ${x.ref}`);
        if (p.datum && p.datum.kind === 'hash') {
          const d = datums.get(p.datum.hash);
          if (!d) nr(`input ${x.ref}: the datum of hash ${p.datum.hash} is not in the witness set`);
          d.used = true;
          result = k(b.plutus_script(w.witness, noSigners(), k(CML.PlutusData.from_cbor_bytes(d.raw))));
        } else result = k(b.plutus_script_inline_datum(w.witness, noSigners()));
        exUnits.push({ tag: CML.RedeemerTag.Spend, index: spendPlace.indexOf(x.ref), units: w.units });
      }
    } else result = k(b.payment_key());
    tb.add_input(result);
  }

  if (f.body[3] !== undefined) {
    at('validity');
    tb.set_ttl(asUint(decode(field(3)), 'ttl'));
  }
  if (f.body[8] !== undefined) {
    at('validity');
    tb.set_validity_start_interval(asUint(decode(field(8)), 'validity start'));
  }

  if (f.body[4] !== undefined) {
    at('certificates');
    const buf = field(4);
    const nodes = setItems(decode(buf));
    nodes.forEach((node, i) => {
      const cert = k(CML.Certificate.from_cbor_bytes(buf.subarray(node.s, node.e)));
      const b = k(CML.SingleCertificateBuilder.new(cert));
      // A credential [0 key | 1 script, hash] in the certificate's second
      // place (a stake, committee or DRep certificate).
      const cred = node.items[1];
      const scriptCred = cred && cred.mt === 4 && cred.items.length === 2 && Number(cred.items[0].value) === 1;
      if (scriptCred) {
        const s = source(hexOf(asBytes(cred.items[1], 'credential')), `certificate ${i}`);
        if (s.native) tb.add_cert(k(b.native_script(s.script, s.info())));
        else {
          const w = partial(targetKey({ kind: 'certificate', index: i }), s, `certificate ${i}`);
          tb.add_cert(k(b.plutus_script(w.witness, noSigners())));
          exUnits.push({ tag: CML.RedeemerTag.Cert, index: i, units: w.units });
        }
      } else tb.add_cert(k(b.payment_key()));
    });
  }

  if (f.body[5] !== undefined) {
    at('withdrawals');
    const list = decode(field(5)).entries.map(([ak, ck]) => ({ account: Buffer.from(asBytes(ak, 'reward account')), coin: asUint(ck, 'withdrawal') }));
    const place = [...list].sort((a, b) => cmlRewardOrder(a.account, b.account));
    for (const e of list) {
      const ra = k(CML.RewardAddress.from_address(k(CML.Address.from_raw_bytes(e.account))));
      if (!ra) nr(`withdrawal ${hexOf(e.account)}: not a reward account`);
      const b = k(CML.SingleWithdrawalBuilder.new(ra, e.coin));
      if (e.account[0] >> 4 === 15) {
        const what = `withdrawal ${hexOf(e.account)}`;
        const s = source(hexOf(e.account.subarray(1)), what);
        if (s.native) tb.add_withdrawal(k(b.native_script(s.script, s.info())));
        else {
          const w = partial(targetKey({ kind: 'withdrawal', account: hexOf(e.account) }), s, what);
          tb.add_withdrawal(k(b.plutus_script(w.witness, noSigners())));
          exUnits.push({ tag: CML.RedeemerTag.Reward, index: place.indexOf(e), units: w.units });
        }
      } else tb.add_withdrawal(k(b.payment_key()));
    }
  }

  if (f.body[9] !== undefined) {
    at('mint');
    const policies = decode(field(9)).entries.map(([pk, assets]) => ({ policy: hexOf(asBytes(pk, 'policy')), assets }));
    const place = policies.map((x) => x.policy).sort();
    for (const { policy, assets } of policies) {
      const m = k(CML.MapAssetNameToNonZeroInt64.new());
      for (const [nk, qk] of assets.entries) m.insert(k(CML.AssetName.from_raw_bytes(asBytes(nk, 'asset name'))), asInt(qk, 'quantity'));
      const b = k(CML.SingleMintBuilder.new(m));
      const s = source(policy, `policy ${policy}`);
      if (s.native) tb.add_mint(k(b.native_script(s.script, s.info())));
      else {
        const w = partial(targetKey({ kind: 'policy', policy }), s, `policy ${policy}`);
        tb.add_mint(k(b.plutus_script(w.witness, noSigners())));
        exUnits.push({ tag: CML.RedeemerTag.Mint, index: place.indexOf(policy), units: w.units });
      }
    }
  }

  if (f.body[14] !== undefined) {
    at('required signers');
    for (const h of requiredSigners(f)) tb.add_required_signer(k(CML.Ed25519KeyHash.from_hex(h)));
  }

  if (f.body[19] !== undefined) {
    at('votes');
    // CML numbers vote redeemers by its list of script-witnessed votes, one
    // entry per vote (redeemer_builder.rs:244-253, vote_builder.rs:56-217).
    const buf = field(19);
    let vb = k(CML.VoteBuilder.new());
    let scripted = 0;
    for (const [voterNode, actions] of decode(buf).entries) {
      const voterBytes = raw(buf, voterNode);
      const what = `voter ${hexOf(voterBytes)}`;
      const voter = k(CML.Voter.from_cbor_bytes(voterBytes));
      const kind = Number(voterNode.items[0].value);
      // Voter kinds 1 and 3 are a committee member's and a DRep's script
      // credentials (conway.cddl voter).
      const script = kind === 1 || kind === 3 ? source(hexOf(asBytes(voterNode.items[1], 'voter')), what) : null;
      for (const [idNode, procNode] of actions.entries) {
        const id = k(CML.GovActionId.from_cbor_bytes(raw(buf, idNode)));
        const proc = k(CML.VotingProcedure.from_cbor_bytes(raw(buf, procNode)));
        if (!script) vb = k(vb.with_vote(voter, id, proc));
        else if (script.native) vb = k(vb.with_native_script_vote(voter, id, proc, CML.NativeScript.from_cbor_bytes(script.script.to_cbor_bytes()), script.info()));
        else {
          const w = partial(targetKey({ kind: 'voter', voter: hexOf(voterBytes) }), script, what);
          vb = k(vb.with_plutus_vote_inline_datum(voter, id, proc, w.witness, noSigners()));
          exUnits.push({ tag: CML.RedeemerTag.Voting, index: scripted, units: w.units });
        }
        if (script) scripted++;
      }
    }
    tb.add_vote(vb.build());
  }

  if (f.body[20] !== undefined) {
    at('proposals');
    // CML numbers proposal redeemers by its list of script-witnessed
    // proposals (redeemer_builder.rs:233-242, proposal_builder.rs:48-155).
    const buf = field(20);
    let pb = k(CML.ProposalBuilder.new());
    let scripted = 0;
    setItems(decode(buf)).forEach((node, i) => {
      const proposal = CML.ProposalProcedure.from_cbor_bytes(raw(buf, node));
      // The guardrail policy is the last item of a parameter change or a
      // treasury withdrawal (conway.cddl gov_action).
      const action = node.items[2];
      const kind = Number(action.items[0].value);
      const last = action.items[action.items.length - 1];
      const policy = (kind === 0 || kind === 2) && last.mt === 2 ? hexOf(asBytes(last, 'policy')) : null;
      if (!policy) pb = k(pb.with_proposal(proposal));
      else {
        const s = source(policy, `proposal ${i}`);
        if (s.native) pb = k(pb.with_native_script_proposal(proposal, CML.NativeScript.from_cbor_bytes(s.script.to_cbor_bytes()), s.info()));
        else {
          const w = partial(targetKey({ kind: 'proposal', index: i }), s, `proposal ${i}`);
          pb = k(pb.with_plutus_proposal_inline_datum(proposal, w.witness, noSigners()));
          exUnits.push({ tag: CML.RedeemerTag.Proposing, index: scripted, units: w.units });
        }
        scripted++;
      }
    });
    tb.add_proposal(pb.build());
  }

  if (f.body[21] !== undefined) {
    at('treasury value');
    tb.set_current_treasury_value(asUint(decode(field(21)), 'treasury value'));
  }
  if (f.body[22] !== undefined) {
    at('donation');
    tb.set_donation(asUint(decode(field(22)), 'donation'));
  }
  if (f.auxiliaryData) {
    at('auxiliary data');
    tb.set_auxiliary_data(k(CML.AuxiliaryData.from_cbor_bytes(Buffer.from(f.auxiliaryData, 'hex'))));
  }

  at('execution units');
  for (const e of exUnits) {
    if (e.index < 0) throw new Error(`cml: no place for a redeemer of tag ${e.tag}`);
    tb.set_exunits(k(CML.RedeemerWitnessKey.new(e.tag, BigInt(e.index))), k(CML.ExUnits.new(BigInt(e.units[0]), BigInt(e.units[1]))));
  }

  at('witnesses');
  for (const [hash, e] of scripts) if (e.witness && !e.used) nr(`the witness set's script ${hash} serves no part CML builds`);
  for (const key of reds.keys()) if (!usedReds.has(key)) nr(`the redeemer for ${key} serves no part CML builds`);
  return { datums: [...datums.values()].filter((d) => !d.used).map((d) => d.raw) };
}

// The reference-script bytes CML counts in min_fee(true) (:231-275): for each
// fixed input locked by a script, the size of the reference input's script of
// that hash, if a reference input carries it.
function cmlRefScriptBytes(f) {
  if (!f) return 0;
  const sizes = new Map();
  for (const x of f.referenceInputs) {
    const p = unspentOutputParts(x.cbor);
    if (p.scriptRef) sizes.set(hexOf(scriptHashOf(p.scriptRef)), p.scriptRef.size);
  }
  let n = 0;
  for (const x of f.inputs) {
    const p = unspentOutputParts(x.cbor);
    if (p.addr.paymentKind === 'script' && sizes.has(p.addr.payment)) n += sizes.get(p.addr.payment);
  }
  return n;
}
const scriptHashOf = (s) => blake2b224(Buffer.concat([Buffer.from([s.lang]), Buffer.from(s.script, 'hex')]));

// Whether a reference input carries a native script reference, on which
// CML's min_fee(true) aborts (:233-238).
const nativeReference = (f) => !!f && f.referenceInputs.some((x) => {
  const p = unspentOutputParts(x.cbor);
  return p.scriptRef && p.scriptRef.lang === 0;
});

// The collateral placeholder total while CML selects and balances: the
// widest a total of a 32-bit fee's collateral encodes.
const COLLATERAL_PLACEHOLDER = 65536n;

function cmlReplay(strategy, T, state, intent, params, opts) {
  const notReplayable = (detail) => ({ ok: false, class: NOT_REPLAYABLE, detail });
  const refusal = replayRefusal(intent);
  if (refusal) return notReplayable(refusal);
  const S = scope();
  const k = S.k;
  const f = intent.fixed;
  const fixedRefs = new Set(f ? f.inputs.map((x) => x.ref) : []);
  const collateral = intent.collateral.required ? opts.collateral || null : null;
  if (intent.collateral.required && !collateral) throw new Error('cml: a script spend needs the collateral the engine sets aside');
  const layout = opts.changePolicy === 'layout';
  try {
    const tb = k(CML.TransactionBuilder.new(cmlConfig(params, S)));
    const changeAddress = k(CML.Address.from_bech32(state.changeAddress));
    // The collateral return for a total collateral.
    const returnFor = (total) => {
      const out = k(k(CML.TransactionUnspentOutput.from_cbor_bytes(Buffer.from(collateral.cbor, 'hex'))).output());
      const amount = k(out.amount());
      return k(CML.TransactionOutput.new(changeAddress, k(CML.Value.new(BigInt(collateral.coin) - total, k(amount.multi_asset())))));
    };
    let part = 'requested outputs';
    let extraDatums = [];
    try {
      for (const o of intent.requested) tb.add_output(k(CML.SingleOutputBuilderResult.new(k(CML.TransactionOutput.from_cbor_bytes(Buffer.from(o.cbor, 'hex'))))));
      if (f) extraDatums = addFixedParts(tb, intent, S, (p) => (part = p)).datums;
      part = 'implicit values';
      const imp = intent.implicit;
      const dep = tb.get_deposit();
      if (dep !== imp.deposits) nr(`CML counts ${dep} lovelace of deposits, the transaction ${imp.deposits}`);
      const back = k(tb.get_implicit_input()).coin();
      if (back !== imp.withdrawals + imp.refunds) nr(`CML counts ${back} lovelace of withdrawals and refunds, the transaction ${imp.withdrawals + imp.refunds}`);
      if (collateral) {
        part = 'collateral';
        tb.add_collateral(k(k(CML.SingleInputBuilder.from_transaction_unspent_output(utxoOf(collateral.cbor, S))).payment_key()));
        tb.set_collateral_return(returnFor(COLLATERAL_PLACEHOLDER));
      }
    } catch (e) {
      passMachineErrors(e);
      if (e instanceof Unexpressible) return notReplayable(`cml: ${part}: ${e.message}`);
      return notReplayable(`cml: ${part}: CML refuses it: ${errorText(e)}`);
    }

    for (const u of inputOrder(state)) if (!fixedRefs.has(u.ref)) tb.add_utxo(k(k(CML.SingleInputBuilder.from_transaction_unspent_output(utxoOf(u.cbor, S))).payment_key()));
    try {
      tb.select_utxos(CML.CoinSelectionStrategyCIP2[CML_STRATEGIES[strategy]]);
    } catch (e) {
      passMachineErrors(e);
      const t = errorText(e);
      return { ok: false, class: classOfCmlError(t), detail: `select_utxos: ${t}` };
    }
    const walletRefsOf = (body) => {
      const ins = k(body.inputs());
      const refs = [];
      for (let i = 0; i < ins.len(); i++) refs.push(refOf(k(ins.get(i))));
      return refs.filter((r) => !fixedRefs.has(r));
    };
    if (layout) {
      // The inputs select_utxos chose: the body at a zero fee, which build
      // writes without change.
      tb.set_fee(0n);
      let body;
      try {
        body = k(k(tb.build(CML.ChangeSelectionAlgo.Default, changeAddress)).body());
      } catch (e) {
        passMachineErrors(e);
        const t = errorText(e);
        return { ok: false, class: classOfCmlError(t), detail: `the library's inputs: ${t}` };
      }
      const inputs = recordsOf(state, [...new Set(walletRefsOf(body))]);
      const r = buildWithChange(T, { state, params, inputs, intent, policy: 'layout', collateral });
      if (!r.ok) return { ok: false, class: r.class, detail: `layout change on the library's inputs: ${r.detail}` };
      return { ok: true, kind: 'single', txs: [txRecord(r.bytes, inputs.map((u) => u.ref), r.fee, r.size, r.k)] };
    }
    if (nativeReference(f)) return { ok: false, class: CLASSES.other, detail: 'build: CML aborts on a reference input carrying a native script reference (raw_plutus_bytes().expect in min_fee)' };
    let signed;
    try {
      signed = k(tb.build(CML.ChangeSelectionAlgo.Default, changeAddress));
    } catch (e) {
      passMachineErrors(e);
      const t = errorText(e);
      return { ok: false, class: classOfCmlError(t), detail: `build: ${t}` };
    }
    const priced = tb.full_size();
    const body = k(signed.body());
    const fee = body.fee();
    if (collateral) {
      const total = totalCollateralFor(params, fee);
      if (total > BigInt(collateral.coin)) return { ok: false, class: CLASSES.collateral, detail: `the collateral holds ${collateral.coin} lovelace, under the total ${total}` };
      body.set_total_collateral(total);
      body.set_collateral_return(returnFor(total));
    }
    const walletRefs = walletRefsOf(body);
    const inputs = recordsOf(state, walletRefs);
    const n = replayWitnessKeys(f, { inputs, collateral: collateral ? [collateral] : [] }).size;
    const wsb = k(signed.witness_set());
    for (const d of extraDatums) wsb.add_plutus_datum(CML.PlutusData.from_cbor_bytes(d));
    const ws = k(wsb.build());
    const vk = k(CML.VkeywitnessList.new());
    for (const w of syntheticVkeys(T, n)) vk.add(k(CML.Vkeywitness.from_cbor_bytes(w)));
    if (f && f.witnesses[0] !== undefined) for (const w of listItems(f.witnesses[0])) vk.add(k(CML.Vkeywitness.from_cbor_bytes(w)));
    if (vk.len()) ws.set_vkeywitnesses(vk);
    if (f && f.witnesses[2] !== undefined) {
      const bw = k(CML.BootstrapWitnessList.new());
      for (const w of listItems(f.witnesses[2])) bw.add(k(CML.BootstrapWitness.from_cbor_bytes(w)));
      ws.set_bootstrap_witnesses(bw);
    }
    const unpriced = [];
    const needsHash = !!f && (f.redeemers.length > 0 || f.witnesses[5] !== undefined || f.witnesses[4] !== undefined);
    if (needsHash) {
      // The redeemers and datums as they sit in CML's witness set.
      if (!body.script_data_hash()) unpriced.push('script data hash');
      const wb = Buffer.from(ws.to_cbor_bytes());
      const w = new Map(decode(wb).entries.map(([key, v]) => [Number(key.value), raw(wb, v)]));
      const at = (x) => (w.has(x) ? Buffer.from(w.get(x)) : Buffer.alloc(0));
      body.set_script_data_hash(k(CML.ScriptDataHash.from_raw_bytes(blake2b256(Buffer.concat([at(5), at(4)])))));
    }
    const aux = signed.auxiliary_data();
    const tx = k(CML.Transaction.new(body, ws, true, aux));
    const bytes = Buffer.from(tx.to_cbor_bytes()).toString('hex');
    const size = inspectTx(bytes).size;
    if (f && bytes.length / 2 > priced) {
      if (f.witnesses[0] !== undefined) unpriced.push('observed vkey witnesses');
      if (f.witnesses[2] !== undefined) unpriced.push('observed bootstrap witnesses');
      if (extraDatums.length) unpriced.push('other datums');
    }
    if (f && f.refScriptBytes > cmlRefScriptBytes(f)) unpriced.push('reference scripts');
    return { ok: true, kind: 'single', txs: [txRecord(bytes, walletRefs, fee, size, n)], library: { fee, finalMinFee: minFee(params, size, f ? f.scriptFee : 0n), unpriced } };
  } finally {
    S.free();
  }
}

export function cmlMethod(T, { strategy }) {
  if (!CML_STRATEGIES[strategy]) throw new Error(`cml: unknown strategy ${strategy}`);
  if (CML_VERSION !== '6.2.0') throw new Error(`cml: the installed Cardano Multiplatform Lib is ${CML_VERSION}, not 6.2.0`);
  const name = `cml-${strategy}`;
  return {
    name,
    version: `@dcspark/cardano-multiplatform-lib-nodejs ${CML_VERSION} ${CML_STRATEGIES[strategy]}`,
    deterministic: strategy === 'lf',
    // RandomImproveMultiAsset draws from rand::thread_rng(), which no caller
    // can seed.
    seeded: strategy === 'lf',
    build(state, intent, params, opts) {
      refuseUncovered(name, REPLAY_COVERAGE.cml, intent);
      if (intent.source !== 'replay') throw new Error(`${name} builds replayed intents only`);
      if (opts.changePolicy !== 'default' && opts.changePolicy !== 'layout') return { ok: false, class: CLASSES.other, detail: `${name} takes its own change or the layout change only` };
      return cmlReplay(strategy, T, state, intent, params, opts);
    }
  };
}
