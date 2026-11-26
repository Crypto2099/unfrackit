// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Cardano Transaction Lib balancer as a study library, ctl-rrri:
// purescript-cardano-transaction-balancer v2.0.1 (70df801) as CTL v10.0.1
// (Plutonomicon/cardano-transaction-lib at 5f960b9) pins it, PureScript
// compiled to JavaScript. scripts/build-ctl.mjs compiles it with the
// simulator's entry module (scripts/ctl/Entry.purs) from CTL's package set,
// each package checked against its commit (methods/ctl-source.mjs), into the
// gitignored build/ctl; this module refuses to load a missing build or one
// whose record differs from the pins (loadCtl). Balancer paths below are
// under src/Cardano/Transaction/Balancer/ at 70df801, CTL paths under src/ at
// 5f960b9.
//
// The call. CTL's Contract.Transaction.submitTxFromConstraints (Contract/
// Transaction.purs:409-421, deprecated) and balanceTx (:297-308, through
// balanceTxE, :274-287) end in defaultBalancerWithErr (Internal/BalanceTx/
// BalanceTx.purs:72-101) with the
// constraints mempty and extraUtxos the UTxOs the unbalanced transaction
// spends that are not the wallet's (balanceTx's usedUtxos). That function
// builds runBalancerAff's context from the Contract environment; the entry
// module builds the same context from the request: buildBalancerConfig mempty
// (Constraints.purs:106-121: Optimal, no change-value split, no source
// addresses, no non-spendable inputs), the protocol parameters, the network,
// the extra UTxOs, and the wallet interface of a CIP-30 wallet (BalanceTx.purs
// :92-100): getWalletUtxos returns the state's spendable UTxOs (and the
// collateral the engine set aside, which a CIP-30 wallet's getUtxos lists),
// getWalletCollateral the set-aside UTxO, which the balancer then keeps out of
// selection (Balancer.purs:210-225), ownAddresses the addresses of the
// spendable UTxOs and the change address (getUsedAddresses), getChangeAddress
// the state's change address, and filterLockedUtxos nothing to filter, as a
// fresh Contract environment locks nothing (Internal/Contract/Monad.purs:
// 481-485). The wallet's own syncBackendWithWallet wait before balancing
// (BalanceTx.purs:78-85) waits for a backend and decides nothing. The provider
// answers getUtxoByOref from the request's UTxOs (MinFee.purs:144-163 reads it
// for the signer count) and evaluateTx through laceEvaluator's rule (below);
// the balancer reaches no other query.
//
// The library, at 70df801:
//   runBalancer (Balancer.purs:186-249): the change address from the wallet,
//   the network id written into the body when it has none (setTxNetwork,
//   :440-443), every UTxO the wallet and the extra map hold, less those the
//   wallet's interface locks and the CIP-30 wallet's collateral (:191-225,
//   getAllUtxos :227-249), collateral set only when the transaction carries
//   redeemers (Collateral.purs setTransactionCollateral), every output raised
//   to its minimum ADA (:447-479), then mainLoop.
//   mainLoop (:330-439): PrebalanceTx selects for the value still required
//   (the outputs, the change so far, the fee and the certificates' and
//   proposals' deposits less the inputs and the mint: getRequiredValue,
//   :765-772), then makeChange; while value is still required it selects
//   again, otherwise it evaluates the transaction and sets the minimum fee,
//   repeating while the fee grows.
//   performMultiAssetSelection (CoinSelection.purs:113-149): the sufficiency
//   check, then a round robin over the required assets in the value's order
//   and lovelace last; a cover step draws from UTxOs holding exactly that
//   asset, then that asset and one other, then any (:424-429), an improve step
//   from the first only (:430-431), each draw uniform over the matching UTxOs
//   (CoinSelection/UtxoIndex.purs:252-313, Effect.Random.randomInt), an
//   improvement kept while it moves the selection toward twice the round's
//   requirement (Optimal).
//   makeChange (:513-613): change maps keyed to the outputs going to the
//   wallet's own addresses (:588-592), so a payment to another address gets
//   one change output (:556-562); no value-size split (maxChangeOutputTokenQuantity unset);
//   minimum ADA assigned to each change output even when the ADA is short,
//   which the loop then selects for.
//   The fee (MinFee.purs:113-120, :259-289): cardano-data-lite's min_fee over the
//   transaction with one fake vkey witness per required signer and per
//   payment and stake key hash of the wallet's addresses among the inputs and
//   the collateral, plus the script fee and the reference-script fee. The
//   balancer checks no transaction or value size: an oversized transaction is
//   the kit's tx-size.
//   The candidates' order: a UtxoMap is a Map keyed by TransactionInput,
//   compared by transaction id bytes then index (cardano-types
//   TransactionInput.purs:53-60, TransactionHash.purs:39-40), the state's
//   order (library.mjs inputOrder); each draw is an index into the map of the
//   matching UTxOs in that order (UtxoIndex.purs:305-313).
//
// The draws (setting rng 'mulberry32'): randomInt reads purescript-random's
// `random`, which is Math.random bound when the module loads (random v6.0.0
// src/Effect/Random.js:1). loadCtl loads the bundle with Math.random replaced
// by a router, so the balancer's `random` is the router; a build points the
// router at the replay job's generator (opts.random, replay/engine.mjs
// jobOptions) or, without one, at a mulberry32 generator seeded with opts.seed,
// and points it back at the platform's Math.random when it returns. Only the
// balancer's draws go through the router: Math.random itself is restored as
// soon as the bundle has loaded. A worker runs one job at a time and the
// engine awaits each build.
//
// The unbalanced transaction: the requested outputs as their bytes, the fixed
// inputs, a zero fee and every fixed part of the intent as its observed bytes
// (validity, certificates, withdrawals, mint, required signers, votes,
// proposals, treasury fields, reference inputs, the auxiliary data and its
// hash, the witness set's scripts, datums, bootstrap witnesses and
// redeemers, each spend redeemer's index recomputed among the sorted fixed
// inputs), as CTL's own constraint processing would produce it; the entry
// decodes it into CTL's types, so the library holds every part it can
// express. The fixed and reference inputs are the extra UTxOs. The balancer
// re-encodes the whole transaction; it writes the script-data hash itself
// (ExUnitsAndMinFee.purs:166-205), with no cost models, as the run holds
// none (they reach only the hash's value, never its size).
//
// Witnesses (setting serialization 'own'): the balanced transaction carries
// no vkey witness; the adapter writes one synthetic vkey witness per wallet
// key (kit/replay.mjs replayWitnessKeys), then the intent's other vkey
// witnesses as observed, through the library's types (the entry's
// withVkeys), and checks that the body did not change.
//
// Errors to failure classes (setting unclassified 'other' for the rest), by
// the balancer error's constructor (Error.purs:82-96):
//   BalanceInsufficientError (the sufficiency check), and
//   InsufficientUtxoBalanceToCoverAsset (a cover step with nothing left to
//   draw)                                                        balance
//   InsufficientCollateralUtxos, CouldNotGetCollateral,
//   CollateralReturnError, CollateralReturnMinAdaValueCalcError  collateral
// Any other constructor, and an exception of the library's (a decoding
// failure, the evaluator finding no observed redeemer), are class other with
// the message. So is a transaction that spends a UTxO the wallet does not
// hold: the extra UTxOs are candidates for selection like the wallet's
// (runBalancer puts them in the spendable set, Balancer.purs:227-249, and
// excludes a reference input only from a transaction running Plutus V3,
// getSpendableUtxos :286-327), so the balancer can spend a reference input it
// was given to resolve; the transaction would need a witness the wallet
// cannot give.
//
// The replay path: every intent is a replayed one (source 'replay'). Not
// replayable (ctlRefusal): body field 6, as for every adapter
// (kit/replay.mjs replayRefusal), and a certificate CTL's types cannot hold:
// cardano-types' Certificate has no constructor for the Conway registration
// and deregistration with a deposit (kinds 7 and 8; cardano-types v5.1.1,
// 1df67b7, src/Cardano/Types/Certificate.purs:49-70 and fromCdl :178-194,
// which has no case for the RegCert and UnregCert variants cardano-data-lite
// decodes), so the library cannot carry them.
//
// The layout change (opts.changePolicy 'layout'): the library balances the
// transaction exactly as for its own change; the wallet inputs it selected are
// read from that transaction, its change is dropped, and UnFrack.It's layout
// change (methods/change.mjs) is built on those inputs, the kit assembling the
// transaction at its exact fee with the intent's fixed parts and the
// collateral the engine set aside, as for the other libraries that build
// whole transactions. A library that fails to build fails before this point,
// as for its own change. No other change policy is accepted.

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLASSES } from '../kit/check.mjs';
import { passMachineErrors } from '../kit/machine.mjs';
import { unspentOutputParts, inspectTx } from '../kit/inspect.mjs';
import { replayRefusal, listItems, replayWitnessKeys, redeemerKey, targetKey, syntheticVkeys } from '../kit/replay.mjs';
import { minFee } from '../kit/fee.mjs';
import { need } from '../kit/params.mjs';
import { redeemerTargets } from '../history/tx.mjs';
import { decode, raw, head, asUint, encUint, encBytes, encArray, encTag, TRUE, NULL } from '../history/cbor.mjs';
import { blake2b256 } from '../history/blake2b.mjs';
import { addressBytes } from '../history/address.mjs';
import { cmpRef } from '../state/state.mjs';
import { makeRng } from '../shapes/rng.mjs';
import { NOT_REPLAYABLE } from './contract.mjs';
import { buildWithChange } from './change.mjs';
import { inputOrder, recordsOf, refuseUncovered, REPLAY_COVERAGE, errorText, txRecord } from './library.mjs';
import { CTL_COMMIT, CTL_REPO, CTL_RELEASE, CTL_PATHS, BALANCER, PURS, ENTRY_FILE, OUTPUT_DIR, BUNDLE, BUILD_RECORD, BUILD_SCRIPT } from './ctl-source.mjs';

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const requireTool = createRequire(import.meta.url);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// Why the build cannot be loaded, or null when it can.
export function ctlBuildProblem() {
  const hint = `run node ${BUILD_SCRIPT} --clone <a clone of ${CTL_REPO}> (or --fetch <a new directory>) in ${TOOL}`;
  const dir = join(TOOL, OUTPUT_DIR);
  const recFile = join(dir, BUILD_RECORD);
  if (!existsSync(recFile)) return `the build of the CTL balancer is missing (${join(OUTPUT_DIR, BUILD_RECORD)}); ${hint}`;
  let rec;
  try {
    rec = JSON.parse(readFileSync(recFile, 'utf8'));
  } catch (e) {
    return `the build record ${join(OUTPUT_DIR, BUILD_RECORD)} cannot be read (${e.message}); ${hint}`;
  }
  const differs = [];
  if (rec.commit !== CTL_COMMIT) differs.push(`commit ${rec.commit}`);
  const paths = rec.paths || {};
  if (Object.keys(paths).length !== Object.keys(CTL_PATHS).length) differs.push('the list of paths');
  for (const [p, [type, hash]] of Object.entries(CTL_PATHS)) if (!paths[p] || paths[p].type !== type || paths[p].hash !== hash) differs.push(p);
  if (!rec.balancer || rec.balancer.rev !== BALANCER.rev) differs.push('the balancer\'s commit');
  if (!rec.packages || !rec.packages[BALANCER.name] || rec.packages[BALANCER.name].rev !== BALANCER.rev) differs.push('the compiled balancer');
  if (!rec.purs || rec.purs.version !== PURS.version || rec.purs.binarySha256 !== PURS.binarySha256) differs.push('the compiler');
  if (!rec.entry || rec.entry.sha256 !== sha256(join(TOOL, ENTRY_FILE))) differs.push(`${ENTRY_FILE} (changed since the build)`);
  const bundle = join(dir, BUNDLE);
  if (!existsSync(bundle) || !rec.bundle || sha256(bundle) !== rec.bundle.sha256) differs.push('the bundle\'s SHA-256');
  if (differs.length) return `the build of the CTL balancer differs from the pins (${differs.join('; ')}); ${hint}`;
  return null;
}

// The router the bundle's Math.random is bound to (see the header).
const PLATFORM_RANDOM = Math.random;
let draw = null;
let draws = 0;
function routedRandom() {
  if (!draw) return PLATFORM_RANDOM();
  draws++;
  return draw();
}

let LOADED = null;
export function loadCtl() {
  if (LOADED) return LOADED;
  const problem = ctlBuildProblem();
  if (problem) throw new Error(`ctl: ${problem}`);
  const rec = JSON.parse(readFileSync(join(TOOL, OUTPUT_DIR, BUILD_RECORD), 'utf8'));
  const saved = Math.random;
  Math.random = routedRandom;
  let lib;
  try {
    lib = requireTool(join(TOOL, OUTPUT_DIR, BUNDLE));
  } finally {
    Math.random = saved;
  }
  if (typeof lib.balance !== 'function' || typeof lib.withVkeys !== 'function') throw new Error('ctl: the bundle does not export balance and withVkeys');
  LOADED = Object.freeze({ lib, bundleSha256: rec.bundle.sha256 });
  return LOADED;
}

const BALANCE_TAGS = new Set(['BalanceInsufficientError', 'InsufficientUtxoBalanceToCoverAsset']);
const COLLATERAL_TAGS = new Set(['InsufficientCollateralUtxos', 'CouldNotGetCollateral', 'CollateralReturnError', 'CollateralReturnMinAdaValueCalcError']);
export function classOfCtlError(tag) {
  if (BALANCE_TAGS.has(tag)) return CLASSES.balance;
  if (COLLATERAL_TAGS.has(tag)) return CLASSES.collateral;
  return CLASSES.other;
}

// The draw source of one build: the job's generator, or a fresh one seeded
// with opts.seed.
export function ctlRandom(opts, name) {
  if (opts.random) return opts.random;
  if (!Number.isSafeInteger(opts.seed)) throw new Error(`${name}: a seed is required`);
  const rng = makeRng(opts.seed);
  return () => rng.next();
}

const pair = (r) => ({ numerator: String(r[0]), denominator: String(r[1]) });
const certKinds = (f) => (f && f.body[4] !== undefined ? listItems(f.body[4]).map((b) => Number(asUint(decode(b).items[0], 'certificate kind'))) : []);

// The run's parameters as the balancer's (Types/ProtocolParameters.purs:
// 11-22). A parameter the run does not state is asked for (kit/params.mjs
// need) when the spend has a part that reads it; otherwise it reaches no
// computation, and zero stands in for it: the deposits are read only for
// certificates of kinds 0, 1 and 3 (Balancer.purs getCertsBalance), the
// prices only through redeemers' units, the reference-script price only
// through a reference script's size.
export function ctlParams(params, intent, utxos) {
  const f = intent.fixed;
  const kinds = certKinds(f);
  const reds = f ? f.redeemers.length > 0 : false;
  const refScripts = utxos.some((u) => unspentOutputParts(u.cbor).scriptRef);
  const zero = [0n, 1n];
  return {
    txFeeFixed: String(params.minFeeB),
    txFeePerByte: Number(params.minFeeA),
    stakeAddressDeposit: String(kinds.some((k) => k === 0 || k === 1) ? need(params, 'keyDeposit') : params.keyDeposit ?? 0n),
    stakePoolDeposit: String(kinds.includes(3) ? need(params, 'poolDeposit') : params.poolDeposit ?? 0n),
    coinsPerUtxoByte: String(params.coinsPerUtxoByte),
    maxCollateralInputs: params.maxCollateralInputs,
    refScriptCoinsPerByte: pair(refScripts ? need(params, 'minFeeRefScriptCostPerByte') : params.minFeeRefScriptCostPerByte ?? zero),
    memPrice: pair(reds ? need(params, 'priceMem') : params.priceMem ?? zero),
    stepPrice: pair(reds ? need(params, 'priceStep') : params.priceStep ?? zero)
  };
}

// Why the library cannot hold the intent, or null when it can.
export function ctlRefusal(intent) {
  const kit = replayRefusal(intent);
  if (kit) return kit;
  const kinds = certKinds(intent.fixed);
  const k = kinds.find((x) => x === 7 || x === 8);
  if (k !== undefined) return `a kind ${k} certificate (Conway ${k === 7 ? 'registration' : 'deregistration'} with a deposit): cardano-types' Certificate has no constructor for it`;
  return null;
}

const SET = (items) => encTag(258, encArray(items));
const inputBytes = (ref) => {
  const i = ref.indexOf('#');
  return encArray([encBytes(Buffer.from(ref.slice(0, i), 'hex')), encUint(Number(ref.slice(i + 1)))]);
};
const FIXED_BODY = [3, 4, 5, 8, 9, 14, 15, 19, 20, 21, 22];
const FIXED_WITNESS = [1, 2, 3, 4, 6, 7];

// The intent's redeemers with each spend redeemer's index among `sorted`, the
// rest as observed.
function redeemerBytes(fixed, sorted) {
  const original = Buffer.from(fixed.witnesses[5], 'hex');
  const n = decode(original);
  const place = new Map(sorted.map((r, i) => [r, i]));
  const newIndex = (i, oldIndex) => {
    const r = fixed.redeemers[i];
    if (r.tag !== 0) return oldIndex;
    const p = place.get(r.target.ref);
    if (p === undefined) throw new Error(`a spend redeemer's target ${r.target.ref} is not a fixed input`);
    return p;
  };
  const close = n.indefinite ? Buffer.from([0xff]) : Buffer.alloc(0);
  if (n.mt === 4) {
    const items = n.items.map((it, i) => encArray([raw(original, it.items[0]), encUint(newIndex(i, Number(it.items[1].value))), raw(original, it.items[2]), raw(original, it.items[3])]));
    return Buffer.concat([original.subarray(n.s, n.items.length ? n.items[0].s : n.e - close.length), ...items, close]);
  }
  if (n.mt === 5) {
    const pairs = n.entries.map(([k, v], i) => [encArray([raw(original, k.items[0]), encUint(newIndex(i, Number(k.items[1].value)))]), raw(original, v)]);
    return Buffer.concat([original.subarray(n.s, n.entries.length ? n.entries[0][0].s : n.e - close.length), ...pairs.flat(), close]);
  }
  throw new Error('redeemers: expected an array or a map');
}

// The unbalanced transaction (see the header), hex.
export function unbalancedTx(intent) {
  const f = intent.fixed;
  const sorted = f ? f.inputs.map((x) => x.ref).sort(cmpRef) : [];
  const body = [[0, SET(sorted.map(inputBytes))], [1, encArray(intent.requested.map((o) => Buffer.from(o.cbor, 'hex')))], [2, encUint(0)]];
  if (f) for (const k of FIXED_BODY) if (f.body[k] !== undefined) body.push([k, Buffer.from(f.body[k], 'hex')]);
  const aux = f && f.auxiliaryData ? Buffer.from(f.auxiliaryData, 'hex') : null;
  if (aux) body.push([7, encBytes(blake2b256(aux))]);
  if (f && f.referenceInputs.length) body.push([18, SET(f.referenceInputs.map((x) => x.ref).sort(cmpRef).map(inputBytes))]);
  body.sort((a, b) => a[0] - b[0]);
  const wits = [];
  if (f) for (const k of FIXED_WITNESS) if (f.witnesses[k] !== undefined) wits.push([k, Buffer.from(f.witnesses[k], 'hex')]);
  if (f && f.witnesses[5] !== undefined) wits.push([5, redeemerBytes(f, sorted)]);
  wits.sort((a, b) => a[0] - b[0]);
  const enc = (m) => Buffer.concat([head(5, m.length), ...m.flatMap(([k, v]) => [encUint(k), v])]);
  return Buffer.concat([Buffer.from([0x84]), enc(body), enc(wits), TRUE, aux || NULL]).toString('hex');
}

// The evaluator: each redeemer of the library's transaction with the intent's
// observed execution units, found by the target its pointer names in that
// transaction (history/tx.mjs redeemerTargets, the ledger's order of each
// list). A redeemer with no observed counterpart fails the build.
export function ctlEvaluator(intent) {
  const byKey = new Map();
  for (const r of intent.fixed ? intent.fixed.redeemers : []) if (!byKey.has(redeemerKey(r))) byKey.set(redeemerKey(r), r);
  return (txHex) => {
    const t = inspectTx(txHex);
    const targetOf = redeemerTargets(t.tx);
    return t.redeemers.map((r) => {
      const target = targetOf(r);
      const o = target && byKey.get(targetKey(target));
      if (!o) throw new Error(`the library's redeemer ${r.tag}:${r.index} has no observed redeemer`);
      return { tag: r.tag, index: r.index, memory: String(o.exUnits[0]), steps: String(o.exUnits[1]) };
    });
  };
}

// The network the change address names (CIP-0019, "Network Tag").
const mainnetOf = (address) => (addressBytes(address)[0] & 15) === 1;

// Balances the intent with the library: { ok, bytes, ... } or a failure.
export async function buildCtl(T, state, intent, params, opts, { name = 'ctl-rrri' } = {}) {
  const C = loadCtl();
  const layout = opts.changePolicy === 'layout';
  if (opts.changePolicy !== 'default' && !layout) return { ok: false, class: CLASSES.other, detail: 'the CTL balancer takes its own change or the layout change only' };
  if (intent.source !== 'replay') throw new Error(`${name}: builds replayed intents only`);
  const refusal = ctlRefusal(intent);
  if (refusal) return { ok: false, class: NOT_REPLAYABLE, detail: refusal };
  const f = intent.fixed;
  const collateral = opts.collateral || null;
  if (intent.collateral && intent.collateral.required && !collateral) throw new Error(`${name}: a script spend needs the collateral the engine sets aside`);
  const fixedRefs = new Set(f ? f.inputs.map((x) => x.ref) : []);
  const pool = inputOrder(state).filter((u) => !fixedRefs.has(u.ref));
  const extra = f ? [...f.inputs, ...f.referenceInputs] : [];
  const own = [...new Set([state.changeAddress, ...pool.map((u) => u.address)])];
  let request;
  try {
    request = {
      tx: unbalancedTx(intent),
      walletUtxos: pool.map((u) => u.cbor),
      extraUtxos: extra.map((x) => x.cbor),
      collateral: collateral ? [collateral.cbor] : [],
      ownAddresses: own,
      changeAddress: state.changeAddress,
      mainnet: mainnetOf(state.changeAddress),
      pparams: ctlParams(params, intent, [...pool, ...extra]),
      evaluate: ctlEvaluator(intent)
    };
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: CLASSES.other, detail: `request: ${errorText(e)}` };
  }
  const source = ctlRandom(opts, name);
  let res;
  draws = 0;
  draw = source;
  try {
    res = await C.lib.balance(request)();
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: CLASSES.other, detail: `balance: ${errorText(e)}` };
  } finally {
    draw = null;
  }
  const used = draws;
  if (!res.ok) return { ok: false, class: classOfCtlError(res.error), detail: `balance: ${res.error}: ${res.message}` };
  const built = inspectTx(res.tx);
  const refs = built.inputs.map((i) => i.ref);
  for (const x of fixedRefs) if (!refs.includes(x)) return { ok: false, class: CLASSES.other, detail: `the library left out the fixed input ${x}` };
  const walletRefs = refs.filter((x) => !fixedRefs.has(x));
  const strays = walletRefs.filter((x) => !state.utxos.has(x) || state.utxos.get(x).held !== null);
  if (strays.length) return { ok: false, class: CLASSES.other, detail: `the library spent ${strays.join(', ')}, not a spendable UTxO of the wallet (an extra UTxO it was given to resolve the intent's parts)` };
  const inputs = recordsOf(state, walletRefs);
  if (layout) {
    const r = buildWithChange(T, { state, params, inputs, intent, policy: 'layout', collateral });
    if (!r.ok) return { ok: false, class: r.class, detail: `layout change on the library's inputs: ${r.detail}` };
    return { ok: true, kind: 'single', txs: [txRecord(r.bytes, walletRefs, r.fee, r.size, r.k)], library: { draws: used } };
  }
  // The vkey witnesses: the wallet's keys, synthetic, then the intent's other
  // vkey witnesses as observed.
  const keys = replayWitnessKeys(f, { inputs, collateral: collateral && built.collateralInputs.length ? [collateral] : [] });
  const others = f && f.witnesses[0] !== undefined ? listItems(f.witnesses[0]) : [];
  const vkeys = [...syntheticVkeys(T, keys.size), ...others].map((b) => Buffer.from(b).toString('hex'));
  const bytes = C.lib.withVkeys(res.tx)(vkeys);
  if (!bytes) throw new Error(`${name}: the library's transaction or a vkey witness cannot be decoded`);
  const t = inspectTx(bytes);
  if (t.hash !== built.hash) throw new Error(`${name}: writing the vkey witnesses changed the body`);
  return {
    ok: true,
    kind: 'single',
    txs: [txRecord(bytes, walletRefs, t.fee, t.size, keys.size)],
    library: { draws: used, fee: t.fee, finalMinFee: minFee(params, t.size, f ? f.scriptFee : 0n), unpriced: others.length ? ['observed vkey witnesses'] : [] }
  };
}

export function ctlMethod(T) {
  const name = 'ctl-rrri';
  const C = loadCtl();
  return {
    name,
    version: `ctl ${CTL_RELEASE} (${CTL_COMMIT.slice(0, 7)}) purescript-cardano-transaction-balancer ${BALANCER.version} (${BALANCER.rev.slice(0, 7)}) runBalancerAff as defaultBalancerWithErr calls it, purs ${PURS.version}, bundle ${C.bundleSha256.slice(0, 12)}`,
    deterministic: false,
    // Its draws come from opts.random or a generator seeded with opts.seed,
    // through the Math.random its bundle was loaded with.
    seeded: true,
    async build(state, intent, params, opts) {
      refuseUncovered(name, REPLAY_COVERAGE.ctl, intent);
      return buildCtl(T, state, intent, params, opts, { name });
    }
  };
}
