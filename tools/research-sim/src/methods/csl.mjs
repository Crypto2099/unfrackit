// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The cardano-serialization-lib baselines: csl-lf and csl-ri, and the
// sensitivity arm with prefer_pure_change set (csl-lf-pure, csl-ri-pure).
// cardano-serialization-lib 13.2.1 is the treatment's instance, loaded through
// its cslkit.mjs; no second CSL build is installed or imported.
//
// The library at Emurgo/cardano-serialization-lib tag 13.2.1 (commit
// 846d0f274a436403659fa7b197a09c029d7f2126), rust/src/builders/tx_builder.rs:
//
//   add_inputs_from (:412-593). LargestFirstMultiAsset runs
//   cip2_largest_first_by once for each asset of the outputs, in policy and
//   asset-name order, then once for ADA (:506-531). Each pass takes the UTxOs
//   holding its asset, sorted ascending by that asset's quantity with Rust's
//   stable sort_by_key and walked from the end, so among equal quantities the
//   UTxO given later is taken first; it adds inputs until the selected quantity
//   reaches the target, and the target grows by each added input's fee, so
//   the fee is counted in the ADA target (:595-636; CIP-0002 "Largest-First"
//   leaves fees out). A selected UTxO is removed from the shared index list
//   with swap_remove (:626), which moves the list's last index into its place,
//   so the passes after the first see the remaining UTxOs in a permuted order.
//   RandomImproveMultiAsset calls cip2_random_improve_by with pure_ada = false
//   on every pass (:532-590), so its improvement phase, guarded by pure_ada
//   (:705), never runs: it draws random UTxOs holding each asset until that
//   asset is covered, then random UTxOs, any kind, until the coin covers the
//   outputs and the fees ("Phase 3", :563-589), from rand::thread_rng(), which
//   a caller cannot seed. It is random selection, not CIP-0002
//   "Random-Improve".
//
//   add_change_if_needed (:1828-1830, :1844-2209). Every leftover asset goes
//   into change outputs packed greedily in policy and asset-name order, a new
//   output starting only when the next asset would take the output's Value, at
//   its minimum coin, over max_value_size (pack_nfts_for_change, :1911-2022);
//   each output carries its minimum coin and the leftover ADA goes to the last
//   one (:2125-2134), unless prefer_pure_change is set and the leftover after
//   one more output's fee is above the pure-ADA minimum, when it becomes a
//   separate pure-ADA output (:2097-2123). Leftover ADA that cannot fund a
//   token change output fails with "Not enough ADA leftover to include non-ADA
//   assets in a change address" (:2090). With no asset in the change, ADA
//   under an output's minimum is added to the fee (burn_extra, :2151-2167).
//
//   Fees: min_fee prices the transaction as serialized with its validity flag
//   and with fake vkey witnesses (fake_full_tx, :33-97), and with the fee
//   field at 2^32 (:2595-2599), so CSL's fee is a few bytes above the ledger's
//   minimum for its own size (the ledger's size leaves the validity flag out).
//
// Errors to failure classes (setting unclassified 'other' for the rest):
//   "Not enough ADA leftover to include non-ADA assets in a change address"
//                                                    change-minimum
//   "UTxO Balance Insufficient", "UTxO Balance Insufficient[x]",
//   "Insufficient input in transaction", "No inputs to add"   balance
//   "Maximum transaction size of ... exceeded"       tx-size
//   "Maximum value size of ... exceeded"             value-size
//
// Change substitution (H-9 and H-11; setting substitutedChange 'fail'): with a
// change policy other than 'default', the adapter keeps only the inputs
// add_inputs_from chose, before add_change_if_needed, and the simulator's
// policy builds the change (methods/change.mjs), the kit assembling the
// transaction at its exact fee.

import { CLASSES } from '../kit/check.mjs';
import { buildWithChange } from './change.mjs';
import { inputOrder, recordsOf, keyCount, refuseUncovered, REPLAY_COVERAGE, errorText, txRecord } from './library.mjs';
import { inspectTx, unspentOutputParts } from '../kit/inspect.mjs';
import { replayRefusal } from '../kit/replay.mjs';
import { NOT_REPLAYABLE } from './contract.mjs';
import { totalCollateralFor } from '../replay/collateral.mjs';
import { minFee } from '../kit/fee.mjs';
import { decode, raw, asBytes, asUint, asInt, setItems } from '../history/cbor.mjs';
import { blake2b224, blake2b256 } from '../history/blake2b.mjs';
import { decodeTx } from '../history/tx.mjs';

export const CSL_STRATEGIES = Object.freeze({ lf: 'LargestFirstMultiAsset', ri: 'RandomImproveMultiAsset' });

const ERROR_CLASSES = [
  [/^Not enough ADA leftover to include non-ADA assets in a change address/, CLASSES.changeMinimum],
  [/^UTxO Balance Insufficient/, CLASSES.balance],
  [/^Insufficient input in transaction/, CLASSES.balance],
  [/^No inputs to add/, CLASSES.balance],
  [/^Maximum transaction size of \d+ exceeded/, CLASSES.txSize],
  [/^Maximum value size of \d+ exceeded/, CLASSES.valueSize]
];

export function classOfCslError(text) {
  for (const [re, cls] of ERROR_CLASSES) if (re.test(text)) return cls;
  return CLASSES.other;
}

function scope() {
  const xs = [];
  return {
    k(o) {
      if (o) xs.push(o);
      return o;
    },
    free() {
      for (const o of xs.reverse()) o.free();
      xs.length = 0;
    }
  };
}

// The builder's configuration from the run's parameters.
export function cslConfig(T, params, { preferPureChange = false, dedupRefInputs = false } = {}, S = scope()) {
  const C = T.CSL;
  const B = (x) => S.k(C.BigNum.from_str(String(x)));
  let b = C.TransactionBuilderConfigBuilder.new();
  const step = (f) => {
    const nb = f(b);
    b.free();
    b = nb;
  };
  step((x) => x.fee_algo(S.k(C.LinearFee.new(B(params.minFeeA), B(params.minFeeB)))));
  step((x) => x.coins_per_utxo_byte(B(params.coinsPerUtxoByte)));
  if (params.poolDeposit === null || params.keyDeposit === null) throw new Error('csl: the builder needs the key and pool deposits, which this run does not state');
  step((x) => x.pool_deposit(B(params.poolDeposit)));
  step((x) => x.key_deposit(B(params.keyDeposit)));
  step((x) => x.max_value_size(params.maxValSize));
  step((x) => x.max_tx_size(params.maxTxSize));
  if (params.priceMem && params.priceStep) {
    const u = (r) => S.k(C.UnitInterval.new(B(r[0]), B(r[1])));
    step((x) => x.ex_unit_prices(S.k(C.ExUnitPrices.new(u(params.priceMem), u(params.priceStep)))));
  }
  if (params.minFeeRefScriptCostPerByte) {
    const r = params.minFeeRefScriptCostPerByte;
    step((x) => x.ref_script_coins_per_byte(S.k(C.UnitInterval.new(B(r[0]), B(r[1])))));
  }
  step((x) => x.prefer_pure_change(!!preferPureChange));
  if (dedupRefInputs) step((x) => x.deduplicate_explicit_ref_inputs_with_regular_inputs(true));
  const cfg = b.build();
  b.free();
  return S.k(cfg);
}

// CSL's transaction with k synthetic vkey witnesses in CSL's encoding (the
// treatment's build.mjs makeWitnessSet), its body kept as CSL serializes it.
export function cslWithWitnesses(T, tx, k, S) {
  const C = T.CSL;
  const body = S.k(tx.body());
  const aux = S.k(tx.auxiliary_data());
  const ws = S.k(T.build.makeWitnessSet(k));
  const full = S.k(aux ? C.Transaction.new(body, ws, aux) : C.Transaction.new(body, ws));
  return Buffer.from(full.to_bytes()).toString('hex');
}

const refOf = (input) => `${Buffer.from(input.transaction_id().to_bytes()).toString('hex')}#${input.index()}`;

export function cslMethod(T, { strategy, preferPureChange = false }) {
  if (!CSL_STRATEGIES[strategy]) throw new Error(`csl: unknown strategy ${strategy}`);
  if (T.cslkit.CSL_VERSION !== '13.2.1') throw new Error(`csl: the treatment loads cardano-serialization-lib ${T.cslkit.CSL_VERSION}, not 13.2.1`);
  const name = `csl-${strategy}${preferPureChange ? '-pure' : ''}`;
  return {
    name,
    version: `cardano-serialization-lib ${T.cslkit.CSL_VERSION} ${CSL_STRATEGIES[strategy]}${preferPureChange ? ', prefer_pure_change' : ''}`,
    deterministic: strategy === 'lf',
    build(state, intent, params, opts) {
      refuseUncovered(name, REPLAY_COVERAGE.csl, intent);
      if (intent.source === 'replay') return cslReplay(T, { strategy, preferPureChange }, state, intent, params, opts);
      const C = T.CSL;
      const S = scope();
      try {
        const tb = S.k(C.TransactionBuilder.new(cslConfig(T, params, { preferPureChange }, S)));
        try {
          for (const o of intent.requested) tb.add_output(S.k(C.TransactionOutput.from_bytes(Buffer.from(o.cbor, 'hex'))));
        } catch (e) {
          // A requested output CSL refuses (its value over the limit, its coin
          // under the minimum) is the intent's, not the selection's.
          const t = errorText(e);
          return { ok: false, class: CLASSES.other, detail: `requested output: ${t}` };
        }
        const utxos = S.k(C.TransactionUnspentOutputs.new());
        for (const u of inputOrder(state)) utxos.add(S.k(C.TransactionUnspentOutput.from_bytes(Buffer.from(u.cbor, 'hex'))));
        try {
          tb.add_inputs_from(utxos, C.CoinSelectionStrategyCIP2[CSL_STRATEGIES[strategy]]);
        } catch (e) {
          const t = errorText(e);
          return { ok: false, class: classOfCslError(t), detail: `add_inputs_from: ${t}` };
        }
        if (opts.changePolicy !== 'default') {
          // The inputs add_inputs_from chose: the body at a zero fee. Its size
          // was checked by the library's own fee estimates while it selected.
          tb.set_fee(S.k(C.BigNum.zero()));
          let body;
          try {
            body = S.k(tb.build());
          } catch (e) {
            const t = errorText(e);
            return { ok: false, class: classOfCslError(t), detail: `the library's inputs: ${t}` };
          }
          const ins = S.k(body.inputs());
          const refs = [];
          for (let i = 0; i < ins.len(); i++) refs.push(refOf(S.k(ins.get(i))));
          const inputs = recordsOf(state, refs);
          const r = buildWithChange(T, { state, params, inputs, intent, policy: opts.changePolicy });
          if (!r.ok) return { ok: false, class: r.class, detail: `${opts.changePolicy} change on the library's inputs: ${r.detail}` };
          return { ok: true, kind: 'single', txs: [txRecord(r.bytes, inputs.map((u) => u.ref), r.fee, r.size, r.k)] };
        }
        try {
          tb.add_change_if_needed(S.k(C.Address.from_bech32(state.changeAddress)));
        } catch (e) {
          const t = errorText(e);
          return { ok: false, class: classOfCslError(t), detail: `add_change_if_needed: ${t}` };
        }
        let tx;
        try {
          tx = S.k(tb.build_tx());
        } catch (e) {
          const t = errorText(e);
          return { ok: false, class: classOfCslError(t), detail: `build_tx: ${t}` };
        }
        const body = S.k(tx.body());
        const ins = S.k(body.inputs());
        const refs = [];
        for (let i = 0; i < ins.len(); i++) refs.push(refOf(S.k(ins.get(i))));
        const inputs = recordsOf(state, refs);
        const k = keyCount(inputs);
        const bytes = cslWithWitnesses(T, tx, k, S);
        const fee = BigInt(S.k(body.fee()).to_str());
        return { ok: true, kind: 'single', txs: [txRecord(bytes, refs, fee, inspectTx(bytes).size, k)] };
      } finally {
        S.free();
      }
    }
  };
}

// ---- The replay path.
//
// Every intent the history reader writes (source 'replay') is built by CSL's
// own builders at 13.2.1 (rust/src/builders/), its fixed parts first, as the
// library asks (tx_builder.rs:405-411: add_inputs_from "should be called after
// adding all certs/outputs/etc"):
//   requested outputs  add_output with each output's own bytes
//                      (TransactionOutput.from_bytes), so a datum, a script
//                      reference and a coin raised to its minimum pass through
//   fixed inputs       one TxInputsBuilder given by set_inputs
//                      (tx_builder.rs:757-759), which add_inputs_from then
//                      extends: a key or Byron input by add_regular_input
//                      (tx_inputs_builder.rs:115-160), a native script input by
//                      add_native_script_input, a Plutus input by
//                      add_plutus_script_input with a PlutusWitness carrying
//                      its script (from the witness set, or a reference
//                      script by PlutusScriptSource.new_ref_input with its
//                      size), its datum when the UTxO holds a datum hash (the
//                      witness set's datum of that hash; none for an inline
//                      datum), and its redeemer at the observed execution
//                      units (tx_inputs_builder.rs:74-98,
//                      script_structs/plutus_witness.rs:13-47). CSL sets each
//                      spend redeemer's index from the input's place among the
//                      sorted inputs (tx_inputs_builder.rs:229-281).
//   mint, burn         MintBuilder.add_asset per asset with a MintWitness:
//                      the policy's native script, or its Plutus script and
//                      redeemer (mint_builder.rs:14-28, :96-107)
//   certificates       CertificatesBuilder: add, or add_with_native_script
//                      or add_with_plutus_witness for one that needs a script
//                      witness (certificates_builder.rs:16-78)
//   withdrawals        WithdrawalsBuilder: add, or the script variants
//                      (withdrawals_builder.rs:18-75), added in the ledger's
//                      order of reward accounts so that CSL's redeemer
//                      indexes, which follow insertion order, are the ledger's
//   votes, proposals   VotingBuilder and VotingProposalBuilder, with their
//                      script witnesses
//   reference inputs   add_reference_input, or add_script_reference_input
//                      with the script's size for one carrying a reference
//                      script (tx_builder.rs:858-873); a fixed input carrying
//                      a reference script is added the same way, with
//                      deduplicate_explicit_ref_inputs_with_regular_inputs
//                      set, so that CSL counts its size in the
//                      reference-script fee (:1679-1722) without writing it as
//                      a reference input (:1571-1613)
//   validity           set_ttl_bignum, set_validity_start_interval_bignum
//   required signers   add_required_signer
//   auxiliary data     set_auxiliary_data, CSL's encoding
//   treasury fields    set_current_treasury_value, set_donation
//   other datums       add_extra_witness_datum (:1507-1515)
//   collateral         the UTxO the engine set aside (opts.collateral) by
//                      set_collateral (:761-763). While CSL selects and
//                      balances, its whole value stands as the total
//                      collateral and as the return, as CSL's own
//                      collateral-return method sizes them
//                      (add_inputs_from_and_change_with_collateral_return,
//                      :1018-1064); once add_change_if_needed has set the fee,
//                      the total is set for that fee (collateralPercent of it,
//                      rounded up, as every method's replay carries it) and
//                      CSL derives the return (set_total_collateral_and_return,
//                      :820-856). Both fields only shrink, so CSL's fee still
//                      covers its transaction. CSL never chooses collateral.
//   script data hash   CSL computes it only from cost models
//                      (calc_script_data_hash, :2220-2300), which a history
//                      file does not carry, and build_tx refuses Plutus parts
//                      without it (:2563-2577). As the kit writes body field
//                      11 for every other method (kit/replay.mjs), it is
//                      BLAKE2b-256 over the redeemers and datums, here as CSL
//                      serializes them: 32 placeholder bytes while CSL
//                      selects and prices (set_script_data_hash, :2302-2306),
//                      the hash once build_tx has written the witness set.
// CSL prices the transaction itself (min_fee, :119-155): the size of a
// transaction with fake witnesses for the keys it counts (:11-28), plus the
// execution units at the configured prices (fees.rs:41-60) and the reference
// scripts at the configured price (fees.rs:63-113); cslConfig passes the run's
// execution prices and reference-script price. The selection is then
// add_inputs_from over the pool (the fixed inputs and the UTxO set aside are
// not in it), add_change_if_needed and build_tx, as for a battery spend.
//
// The witness set is CSL's (scripts, datums, redeemers), with the vkey
// witnesses a signer adds: one synthetic witness per distinct payment key
// among the wallet inputs, the wallet's held fixed inputs, the collateral
// input and the required signers that are wallet keys (as kit/replay.mjs
// counts them), then the intent's other vkey witnesses and its bootstrap
// witnesses as observed.
//
// Not replayable for CSL (a part its builders have no way to express): body
// field 6 (kit/replay.mjs replayRefusal) and body field 15, the network id,
// which TransactionBuilder never writes (:2337, network_id: None); a deposit
// or refund CSL counts differently from the transaction (a pool registration
// CSL always charges a pool deposit for, certificates_builder.rs:172-206); a
// script, datum or redeemer a part needs that the intent does not hold; a
// requested output, a script or a part CSL refuses or re-encodes to another
// hash; a script in the witness set or a redeemer that no part CSL builds
// takes.
//
// Change substitution: as on the battery path, the inputs add_inputs_from
// chose, the fixed inputs left out, go to the simulator's policy, and the kit
// assembles the transaction with the fixed parts and the collateral.

class Unexpressible extends Error {}
const nr = (m) => {
  throw new Unexpressible(m);
};
const hexOf = (b) => Buffer.from(b).toString('hex');
const BODY_PARTS = new Set([3, 4, 5, 8, 9, 14, 19, 20, 21, 22]);
const WITNESS_PARTS = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
const PLUTUS_KEYS = [[3, 1], [6, 2], [7, 3]];

function itemsOf(h) {
  const b = Buffer.from(h, 'hex');
  return { b, items: setItems(decode(b)) };
}

// The scripts an intent holds, by hash (BLAKE2b-224 of the language tag and
// the script: 0 native, 1 to 3 Plutus V1 to V3): the witness set's, then the
// reference scripts of its fixed and reference inputs.
export function intentScripts(fixed) {
  const m = new Map();
  const put = (hash, e) => {
    if (!m.has(hash)) m.set(hash, e);
  };
  if (fixed.witnesses[1] !== undefined) {
    const { b, items } = itemsOf(fixed.witnesses[1]);
    for (const it of items) {
      const r = Buffer.from(raw(b, it));
      put(hexOf(blake2b224(Buffer.concat([Buffer.from([0]), r]))), { lang: 0, raw: r, ref: null, witness: true, used: false });
    }
  }
  for (const [key, lang] of PLUTUS_KEYS) {
    if (fixed.witnesses[key] === undefined) continue;
    const { b, items } = itemsOf(fixed.witnesses[key]);
    for (const it of items) {
      const content = asBytes(it, 'plutus script');
      put(hexOf(blake2b224(Buffer.concat([Buffer.from([lang]), content]))), { lang, raw: Buffer.from(raw(b, it)), ref: null, witness: true, used: false });
    }
  }
  for (const x of [...fixed.inputs, ...fixed.referenceInputs]) {
    const p = unspentOutputParts(x.cbor);
    if (!p.scriptRef) continue;
    const s = Buffer.from(p.scriptRef.script, 'hex');
    put(hexOf(blake2b224(Buffer.concat([Buffer.from([p.scriptRef.lang]), s]))), { lang: p.scriptRef.lang, raw: p.scriptRef.lang === 0 ? s : null, ref: { ref: x.ref, size: p.scriptRef.size }, witness: false, used: false });
  }
  return m;
}

// A redeemer's place, as the history reader records its target.
export function redeemerKey(r) {
  const t = r.target;
  switch (t.kind) {
    case 'input':
      return `0:${t.ref}`;
    case 'policy':
      return `1:${t.policy}`;
    case 'certificate':
      return `2:${t.index}`;
    case 'withdrawal':
      return `3:${t.account}`;
    case 'voter':
      return `4:${t.voter}`;
    case 'proposal':
      return `5:${t.index}`;
    default:
      throw new Error(`unknown redeemer target ${t.kind}`);
  }
}

// The ledger's order of reward accounts: network, then a script credential
// before a key, then the hash (history/intent.mjs redeemerTargets).
function cmpAccount(ka, kb) {
  const na = ka[0] & 15;
  const nb = kb[0] & 15;
  if (na !== nb) return na - nb;
  const sa = ka[0] >> 4 === 15 ? 0 : 1;
  const sb = kb[0] >> 4 === 15 ? 0 : 1;
  if (sa !== sb) return sa - sb;
  return Buffer.compare(ka.subarray(1), kb.subarray(1));
}

const REDEEMER_TAGS = ['new_spend', 'new_mint', 'new_cert', 'new_reward', 'new_vote', 'new_voting_proposal'];
const LANGUAGES = [null, 'new_plutus_v1', 'new_plutus_v2', 'new_plutus_v3'];

// The intent's fixed parts put into the builder `tb`. Throws Unexpressible
// for a part CSL has no way to express.
function addFixedParts(T, tb, intent, S, at) {
  const C = T.CSL;
  const k = S.k;
  const B = (x) => k(C.BigNum.from_str(String(x)));
  const f = intent.fixed;
  const scripts = intentScripts(f);
  const reds = new Map();
  for (const r of f.redeemers) {
    const key = redeemerKey(r);
    if (Number(key[0]) !== r.tag) nr(`a redeemer with tag ${r.tag} points at a ${r.target.kind}`);
    reds.set(key, r);
  }
  const usedReds = new Set();
  const datums = new Map();
  if (f.witnesses[4] !== undefined) {
    const { b, items } = itemsOf(f.witnesses[4]);
    for (const it of items) {
      const r = Buffer.from(raw(b, it));
      datums.set(hexOf(blake2b256(r)), { raw: r, used: false });
    }
  }
  const field = (n) => Buffer.from(f.body[n], 'hex');
  const txIn = (ref) => {
    const i = ref.indexOf('#');
    return k(C.TransactionInput.new(k(C.TransactionHash.from_hex(ref.slice(0, i))), Number(ref.slice(i + 1))));
  };
  const redeemer = (key, what) => {
    const r = reds.get(key);
    if (!r) nr(`${what}: a Plutus script without its redeemer`);
    usedReds.add(key);
    return k(C.Redeemer.new(k(C.RedeemerTag[REDEEMER_TAGS[r.tag]]()), k(C.BigNum.zero()), k(C.PlutusData.from_bytes(Buffer.from(r.data, 'hex'))), k(C.ExUnits.new(B(r.exUnits[0]), B(r.exUnits[1])))));
  };
  // The script source for a script hash: { native, src }.
  const source = (hash, what) => {
    const e = scripts.get(hash);
    if (!e) nr(`${what}: no script with hash ${hash} in the witness set or a reference script`);
    e.used = true;
    if (e.lang === 0) {
      const ns = k(C.NativeScript.from_bytes(e.raw));
      if (e.ref) {
        const src = k(C.NativeScriptSource.new_ref_input(k(C.ScriptHash.from_hex(hash)), txIn(e.ref.ref), e.ref.size));
        src.set_required_signers(k(ns.get_required_signers()));
        return { native: true, src };
      }
      if (k(ns.hash()).to_hex() !== hash) nr(`${what}: CSL re-encodes native script ${hash} to another hash`);
      return { native: true, src: k(C.NativeScriptSource.new(ns)) };
    }
    const lang = k(C.Language[LANGUAGES[e.lang]]());
    if (e.ref) return { native: false, src: k(C.PlutusScriptSource.new_ref_input(k(C.ScriptHash.from_hex(hash)), txIn(e.ref.ref), lang, e.ref.size)) };
    const ps = k(C.PlutusScript.from_bytes_with_version(e.raw, lang));
    if (k(ps.hash()).to_hex() !== hash) nr(`${what}: CSL reads Plutus script ${hash} to another hash`);
    return { native: false, src: k(C.PlutusScriptSource.new(ps)) };
  };
  const plutusOnly = (key, s, what) => k(C.PlutusWitness.new_with_ref_without_datum(s.src, redeemer(key, what)));

  for (const n of Object.keys(f.body).map(Number)) {
    if (n === 15) nr('body field 15 (network id): CSL\'s transaction builder never writes it');
    if (!BODY_PARTS.has(n)) nr(`body field ${n}`);
  }
  for (const n of Object.keys(f.witnesses).map(Number)) if (!WITNESS_PARTS.has(n)) nr(`witness set key ${n}`);
  const fixedRefs = new Set(f.inputs.map((x) => x.ref));
  for (const x of f.referenceInputs) if (fixedRefs.has(x.ref)) nr(`${x.ref} is both an input and a reference input`);

  at('fixed inputs');
  const ib = k(C.TxInputsBuilder.new());
  const spentScripts = [];
  for (const x of f.inputs) {
    const p = unspentOutputParts(x.cbor);
    const u = k(C.TransactionUnspentOutput.from_bytes(Buffer.from(x.cbor, 'hex')));
    const out = k(u.output());
    const input = k(u.input());
    const amount = k(out.amount());
    if (p.addr.paymentKind === 'script') {
      const s = source(p.addr.payment, `input ${x.ref}`);
      if (s.native) ib.add_native_script_input(s.src, input, amount);
      else {
        let w;
        if (p.datum && p.datum.kind === 'hash') {
          const d = datums.get(p.datum.hash);
          if (!d) nr(`input ${x.ref}: the datum of hash ${p.datum.hash} is not in the witness set`);
          d.used = true;
          w = k(C.PlutusWitness.new_with_ref(s.src, k(C.DatumSource.new(k(C.PlutusData.from_bytes(d.raw)))), redeemer(`0:${x.ref}`, `input ${x.ref}`)));
        } else w = plutusOnly(`0:${x.ref}`, s, `input ${x.ref}`);
        ib.add_plutus_script_input(w, input, amount);
      }
    } else {
      ib.add_regular_input(k(out.address()), input, amount);
    }
    if (p.scriptRef) spentScripts.push({ input, size: p.scriptRef.size });
  }
  tb.set_inputs(ib);

  at('reference inputs');
  for (const x of f.referenceInputs) {
    const p = unspentOutputParts(x.cbor);
    if (p.scriptRef) tb.add_script_reference_input(txIn(x.ref), p.scriptRef.size);
    else tb.add_reference_input(txIn(x.ref));
  }
  for (const s of spentScripts) tb.add_script_reference_input(s.input, s.size);

  if (f.body[3] !== undefined) {
    at('validity');
    tb.set_ttl_bignum(B(asUint(decode(field(3)), 'ttl')));
  }
  if (f.body[8] !== undefined) {
    at('validity');
    // Taken by value (tx_builder.rs:1192), so not freed here.
    tb.set_validity_start_interval_bignum(C.BigNum.from_str(String(asUint(decode(field(8)), 'validity start'))));
  }

  if (f.body[4] !== undefined) {
    at('certificates');
    const certs = k(C.Certificates.from_bytes(field(4)));
    const nodes = setItems(decode(field(4)));
    if (certs.len() !== nodes.length) nr(`certificates: CSL reads ${certs.len()} of ${nodes.length}`);
    const cb = k(C.CertificatesBuilder.new());
    for (let i = 0; i < certs.len(); i++) {
      const cert = k(certs.get(i));
      if (cert.has_required_script_witness()) {
        const cred = nodes[i].items[1];
        const s = source(hexOf(asBytes(cred.items[1], 'credential')), `certificate ${i}`);
        if (s.native) cb.add_with_native_script(cert, s.src);
        else cb.add_with_plutus_witness(cert, plutusOnly(`2:${i}`, s, `certificate ${i}`));
      } else cb.add(cert);
    }
    tb.set_certs_builder(cb);
  }

  if (f.body[5] !== undefined) {
    at('withdrawals');
    const ws = k(C.Withdrawals.from_bytes(field(5)));
    const keys = k(ws.keys());
    const list = [];
    for (let i = 0; i < keys.len(); i++) {
      const ra = k(keys.get(i));
      list.push({ ra, account: Buffer.from(k(ra.to_address()).to_bytes()), coin: k(ws.get(ra)) });
    }
    list.sort((a, b) => cmpAccount(a.account, b.account));
    const wb = k(C.WithdrawalsBuilder.new());
    for (const e of list) {
      const cred = k(e.ra.payment_cred());
      if (cred.has_script_hash()) {
        const what = `withdrawal ${hexOf(e.account)}`;
        const s = source(k(cred.to_scripthash()).to_hex(), what);
        if (s.native) wb.add_with_native_script(e.ra, e.coin, s.src);
        else wb.add_with_plutus_witness(e.ra, e.coin, plutusOnly(`3:${hexOf(e.account)}`, s, what));
      } else wb.add(e.ra, e.coin);
    }
    tb.set_withdrawals_builder(wb);
  }

  if (f.body[9] !== undefined) {
    at('mint');
    const mb = k(C.MintBuilder.new());
    for (const [pk, assets] of decode(field(9)).entries) {
      const policy = hexOf(asBytes(pk, 'policy'));
      const s = source(policy, `policy ${policy}`);
      const w = s.native ? k(C.MintWitness.new_native_script(s.src)) : k(C.MintWitness.new_plutus_script(s.src, redeemer(`1:${policy}`, `policy ${policy}`)));
      for (const [nk, qk] of assets.entries) mb.add_asset(w, k(C.AssetName.new(asBytes(nk, 'asset name'))), k(C.Int.from_str(String(asInt(qk, 'quantity')))));
    }
    tb.set_mint_builder(mb);
  }

  if (f.body[14] !== undefined) {
    at('required signers');
    const { items } = itemsOf(f.body[14]);
    for (const it of items) tb.add_required_signer(k(C.Ed25519KeyHash.from_bytes(asBytes(it, 'required signer'))));
  }

  if (f.body[19] !== undefined) {
    at('votes');
    const vp = k(C.VotingProcedures.from_bytes(field(19)));
    const voters = k(vp.get_voters());
    const vb = k(C.VotingBuilder.new());
    for (let i = 0; i < voters.len(); i++) {
      const voter = k(voters.get(i));
      const what = `voter ${hexOf(voter.to_bytes())}`;
      let wit = null;
      if (voter.has_script_credentials()) {
        const cred = k(voter.to_constitutional_committee_hot_credential() || voter.to_drep_credential());
        const s = source(k(cred.to_scripthash()).to_hex(), what);
        wit = s.native ? { native: s.src } : { plutus: plutusOnly(`4:${hexOf(voter.to_bytes())}`, s, what) };
      }
      const ids = k(vp.get_governance_action_ids_by_voter(voter));
      for (let j = 0; j < ids.len(); j++) {
        const id = k(ids.get(j));
        const proc = k(vp.get(voter, id));
        if (!wit) vb.add(voter, id, proc);
        else if (wit.native) vb.add_with_native_script(voter, id, proc, wit.native);
        else vb.add_with_plutus_witness(voter, id, proc, wit.plutus);
      }
    }
    tb.set_voting_builder(vb);
  }

  if (f.body[20] !== undefined) {
    at('proposals');
    const ps = k(C.VotingProposals.from_bytes(field(20)));
    const nodes = setItems(decode(field(20)));
    if (ps.len() !== nodes.length) nr(`proposals: CSL reads ${ps.len()} of ${nodes.length}`);
    const pb = k(C.VotingProposalBuilder.new());
    for (let i = 0; i < ps.len(); i++) {
      const p = k(ps.get(i));
      if (reds.has(`5:${i}`)) {
        // The guardrail policy is the last item of a parameter change or a
        // treasury withdrawal (conway.cddl gov_action).
        const action = nodes[i].items[2];
        const last = action.items[action.items.length - 1];
        if (last.mt !== 2) nr(`proposal ${i}: a redeemer without a policy`);
        const s = source(hexOf(asBytes(last, 'policy')), `proposal ${i}`);
        if (s.native) nr(`proposal ${i}: a native policy`);
        pb.add_with_plutus_witness(p, plutusOnly(`5:${i}`, s, `proposal ${i}`));
      } else pb.add(p);
    }
    tb.set_voting_proposal_builder(pb);
  }

  if (f.body[21] !== undefined) {
    at('treasury value');
    tb.set_current_treasury_value(B(asUint(decode(field(21)), 'treasury value')));
  }
  if (f.body[22] !== undefined) {
    at('donation');
    tb.set_donation(B(asUint(decode(field(22)), 'donation')));
  }
  if (f.auxiliaryData) {
    at('auxiliary data');
    tb.set_auxiliary_data(k(C.AuxiliaryData.from_bytes(Buffer.from(f.auxiliaryData, 'hex'))));
  }

  at('witnesses');
  for (const d of datums.values()) if (!d.used) tb.add_extra_witness_datum(k(C.PlutusData.from_bytes(d.raw)));
  for (const [hash, e] of scripts) if (e.witness && !e.used) nr(`the witness set's script ${hash} serves no part CSL builds`);
  for (const key of reds.keys()) if (!usedReds.has(key)) nr(`the redeemer for ${key} serves no part CSL builds`);
}

// The keys a replayed spend's synthetic witnesses stand for, as kit/replay.mjs
// counts them.
function walletKeys(state, intent, inputs, collateral) {
  const f = intent.fixed;
  const keys = new Set(inputs.map((u) => u.cred));
  if (f) for (const x of f.inputs) if (x.walletKey) keys.add(x.walletKey);
  if (collateral) keys.add(collateral.cred);
  if (f && f.body[14] !== undefined) {
    const creds = new Set([...state.utxos.values()].map((u) => u.cred));
    if (collateral) creds.add(collateral.cred);
    for (const it of itemsOf(f.body[14]).items) {
      const h = hexOf(asBytes(it, 'required signer'));
      if (creds.has(h)) keys.add(h);
    }
  }
  return keys.size;
}

function cslReplay(T, { strategy, preferPureChange }, state, intent, params, opts) {
  const notReplayable = (detail) => ({ ok: false, class: NOT_REPLAYABLE, detail });
  const refusal = replayRefusal(intent);
  if (refusal) return notReplayable(refusal);
  const C = T.CSL;
  const S = scope();
  const k = S.k;
  const B = (x) => k(C.BigNum.from_str(String(x)));
  const f = intent.fixed;
  const fixedRefs = new Set(f ? f.inputs.map((x) => x.ref) : []);
  const collateral = intent.collateral.required ? opts.collateral || null : null;
  if (intent.collateral.required && !collateral) throw new Error('csl: a script spend needs the collateral the engine sets aside');
  try {
    const dedupRefInputs = !!f && f.inputs.some((x) => unspentOutputParts(x.cbor).scriptRef);
    const tb = k(C.TransactionBuilder.new(cslConfig(T, params, { preferPureChange, dedupRefInputs }, S)));
    let part = 'requested outputs';
    try {
      for (const o of intent.requested) tb.add_output(k(C.TransactionOutput.from_bytes(Buffer.from(o.cbor, 'hex'))));
      if (f) addFixedParts(T, tb, intent, S, (p) => (part = p));
      part = 'implicit values';
      const imp = intent.implicit;
      const dep = BigInt(k(tb.get_deposit()).to_str());
      if (dep !== imp.deposits) nr(`CSL counts ${dep} lovelace of deposits, the transaction ${imp.deposits}`);
      const back = BigInt(k(k(tb.get_implicit_input()).coin()).to_str());
      if (back !== imp.withdrawals + imp.refunds) nr(`CSL counts ${back} lovelace of withdrawals and refunds, the transaction ${imp.withdrawals + imp.refunds}`);
      if (collateral) {
        part = 'collateral';
        const cu = k(C.TransactionUnspentOutput.from_bytes(Buffer.from(collateral.cbor, 'hex')));
        const out = k(cu.output());
        const cb = k(C.TxInputsBuilder.new());
        cb.add_regular_input(k(out.address()), k(cu.input()), k(out.amount()));
        tb.set_collateral(cb);
        tb.set_total_collateral(B(collateral.coin));
        tb.set_collateral_return(k(C.TransactionOutput.new(k(C.Address.from_bech32(state.changeAddress)), k(out.amount()))));
      }
    } catch (e) {
      if (e instanceof Unexpressible) return notReplayable(`csl: ${part}: ${e.message}`);
      return notReplayable(`csl: ${part}: CSL refuses it: ${errorText(e)}`);
    }
    const needsHash = !!f && (f.redeemers.length > 0 || f.witnesses[5] !== undefined || f.witnesses[4] !== undefined);
    if (needsHash) tb.set_script_data_hash(k(C.ScriptDataHash.from_bytes(Buffer.alloc(32))));

    const utxos = k(C.TransactionUnspentOutputs.new());
    for (const u of inputOrder(state)) if (!fixedRefs.has(u.ref)) utxos.add(k(C.TransactionUnspentOutput.from_bytes(Buffer.from(u.cbor, 'hex'))));
    try {
      tb.add_inputs_from(utxos, C.CoinSelectionStrategyCIP2[CSL_STRATEGIES[strategy]]);
    } catch (e) {
      const t = errorText(e);
      return { ok: false, class: classOfCslError(t), detail: `add_inputs_from: ${t}` };
    }
    const walletRefsOf = (body) => {
      const ins = k(body.inputs());
      const refs = [];
      for (let i = 0; i < ins.len(); i++) refs.push(refOf(k(ins.get(i))));
      return refs.filter((r) => !fixedRefs.has(r));
    };
    if (opts.changePolicy !== 'default') {
      tb.set_fee(k(C.BigNum.zero()));
      let body;
      try {
        body = k(tb.build());
      } catch (e) {
        const t = errorText(e);
        return { ok: false, class: classOfCslError(t), detail: `the library's inputs: ${t}` };
      }
      const inputs = recordsOf(state, walletRefsOf(body));
      const r = buildWithChange(T, { state, params, inputs, intent, policy: opts.changePolicy, collateral });
      if (!r.ok) return { ok: false, class: r.class, detail: `${opts.changePolicy} change on the library's inputs: ${r.detail}` };
      return { ok: true, kind: 'single', txs: [txRecord(r.bytes, inputs.map((u) => u.ref), r.fee, r.size, r.k)] };
    }
    try {
      tb.add_change_if_needed(k(C.Address.from_bech32(state.changeAddress)));
    } catch (e) {
      const t = errorText(e);
      return { ok: false, class: classOfCslError(t), detail: `add_change_if_needed: ${t}` };
    }
    if (collateral) {
      const fee = BigInt(k(tb.get_fee_if_set()).to_str());
      tb.remove_collateral_return();
      tb.remove_total_collateral();
      try {
        tb.set_total_collateral_and_return(B(totalCollateralFor(params, fee)), k(C.Address.from_bech32(state.changeAddress)));
      } catch (e) {
        return { ok: false, class: CLASSES.collateral, detail: `set_total_collateral_and_return: ${errorText(e)}` };
      }
    }
    let tx;
    try {
      tx = k(tb.build_tx());
      if (needsHash) {
        // The redeemers and datums as they sit in CSL's witness set.
        const w = decodeTx(Buffer.from(tx.to_bytes())).wits.fields;
        const at = (n) => (w.has(n) ? Buffer.from(w.get(n).raw) : Buffer.alloc(0));
        tb.set_script_data_hash(k(C.ScriptDataHash.from_bytes(blake2b256(Buffer.concat([at(5), at(4)])))));
        tx = k(tb.build_tx());
      }
    } catch (e) {
      const t = errorText(e);
      return { ok: false, class: classOfCslError(t), detail: `build_tx: ${t}` };
    }
    const body = k(tx.body());
    const walletRefs = walletRefsOf(body);
    const inputs = recordsOf(state, walletRefs);
    const n = walletKeys(state, intent, inputs, collateral);
    const ws = k(tx.witness_set());
    const synthetic = k(T.build.makeWitnessSet(n));
    const vk = synthetic.vkeys() ? k(synthetic.vkeys()) : k(C.Vkeywitnesses.new());
    if (f && f.witnesses[0] !== undefined) {
      const { b, items } = itemsOf(f.witnesses[0]);
      for (const it of items) vk.add(k(C.Vkeywitness.from_bytes(Buffer.from(raw(b, it)))));
    }
    if (vk.len()) ws.set_vkeys(vk);
    if (f && f.witnesses[2] !== undefined) ws.set_bootstraps(k(C.BootstrapWitnesses.from_bytes(Buffer.from(f.witnesses[2], 'hex'))));
    // Transaction.new takes the auxiliary data by value, so it is not freed here.
    const aux = tx.auxiliary_data();
    const full = k(aux ? C.Transaction.new(body, ws, aux) : C.Transaction.new(body, ws));
    const bytes = Buffer.from(full.to_bytes()).toString('hex');
    const fee = BigInt(k(body.fee()).to_str());
    const size = inspectTx(bytes).size;
    return { ok: true, kind: 'single', txs: [txRecord(bytes, walletRefs, fee, size, n)], library: { fee, finalMinFee: minFee(params, size, f ? f.scriptFee : 0n) } };
  } finally {
    S.free();
  }
}
