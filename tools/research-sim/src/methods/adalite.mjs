// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The AdaLite baseline, adalite-lp: the planner of the AdaLite web wallet at
// vacuumlabs/adalite e7522c2 (v7.0.2's wallet code), which no package
// publishes, compiled from the wallet's source by scripts/build-adalite.mjs
// into a gitignored bundle (methods/adalite-source.mjs holds the pins). The
// module refuses to load a missing build or one whose record differs from the
// pins (loadAdaLite). Paths below are under app/frontend/.
//
// The wallet's send action (actions/common.ts:44-52) is
// account.getTxPlan(changeAddress, { txType: SEND_ADA, address, sendAmount },
// utxos) (wallet/account.ts:348-355): arrangeUtxos, then selectMinimalTxPlan.
// Its send screen pays one output holding ADA or one token, and gives a token
// output the wallet's own minimum ADA (shelley-transaction-planner.ts:36-61).
// The study represents AdaLite by that planner driven with each spend's whole
// request (planTx): the spendable UTxOs in the state's order (inputOrder)
// arranged by the Account's own arrangeUtxos, then selectMinimalTxPlan's loop,
// written out below as the wallet writes it, over the bundle's computeTxPlan
// and validateTxPlan, with the requested outputs as they are (several
// outputs, several tokens, the requested coin) where the send action's draft
// has its one output. On a request the send action can make, the plan is
// getTxPlan's (a test compares the two). Order and selection decide the whole
// outcome:
//   arrangeUtxos (wallet/account.ts:306-340) sorts the list by transaction
//   hash (localeCompare, which for lowercase hex is byte order) then output
//   index, puts UTxOs at addresses that are not base addresses (key payment,
//   key stake; isBase, wallet/shelley/helpers/addresses.ts:106-108) before
//   base addresses, and then ADA-only UTxOs before token-bearing ones; for a
//   token send, the UTxOs holding that token come first (:325-338). The
//   arrangement is asked for a token send when the request's outputs hold
//   exactly one token between them, and for an ADA send otherwise; the wallet
//   has no order for a request of several tokens. The state's order matters
//   only through ties the sort leaves, which do not arise (each reference is
//   distinct).
//   selectMinimalTxPlan (wallet/shelley/transaction/
//   shelley-transaction-planner.ts:194-223) plans the payment with the first
//   n UTxOs for n = 0, 1, 2, ... and returns the first valid plan whose fee
//   equals its base fee, or the last plan when the list is exhausted
//   (:214-217); a plan that burns an ADA-only leftover below its minimum into
//   the fee (fee unequal to the base fee) is passed over for the next prefix.
//   planLoop below is that function with the draft (:199) replaced by the
//   request: the same change template (:200-205), the same loop (:207-220),
//   the same test of the base fee against the fee, which compares the
//   wallet's BigNumber objects by identity (computeTxPlan gives both fields
//   one object except when it burns a leftover into the fee, :156-157), and
//   the last result when the list is exhausted (:221-222). Like the send
//   action's draft, the request carries no certificate, withdrawal or
//   auxiliary data into the plan.
//   computeTxPlan (computeTxPlan.ts:37-287): no change on an exact fit
//   (:100-116); an ADA-only leftover under its minimum to the fee
//   (:141-162); otherwise one ADA-only change output (:167-183), or, with
//   tokens left over, the tokens in outputs of at most 50 tokens each
//   (MAX_OUTPUT_TOKENS, constants.ts:3; createTokenChangeOutputs,
//   utils.ts:72-89), each at its minimum, and the rest of the ADA in a
//   separate ADA-only output when it exceeds the token outputs' minimum, else
//   in the first token output (:187-286). validateTxPlan (:289-381) refuses a
//   change or requested output under its minimum and an output whose bytes
//   exceed 4,000 (MAX_TX_OUTPUT_SIZE, wallet/constants.ts:24).
//   The fee, the minimum ADA, the deposits and the size limit are the
//   wallet's own constants, not the run's parameters: 155381 + 43.946 lovelace
//   per byte rounded up (txFeeFunction, utils.ts:35-42) over an estimated size
//   (estimateTxSize.ts:36-102: every output priced with a 9-byte coin, a TTL
//   always counted, 139 bytes per input's witness, a validity start not
//   counted), 4310 lovelace per byte of the output (its coin priced at 9
//   bytes) plus 160 (computeMinUtxoLovelaceAmount, utils.ts:8-33), a 2 ADA key
//   deposit (:57-70), and 16,384 bytes (MAX_TX_SIZE, wallet/constants.ts:23;
//   estimateTxSize throws TxTooBig over it). The method keeps all of them; a
//   transaction they underprice fails the kit's checks as the wallet's own
//   failure. It draws nothing at random.
//
// The Account is made once, with what its constructor reads and neither
// arrangeUtxos nor getTxPlan reads: the gap limit of the wallet's example configuration
// (.env.example:9, 20), a crypto provider that reports a v2 derivation scheme
// and no optional feature, and no blockchain explorer. The bytes are the
// wallet's: ShelleyTxAux (wallet/shelley/shelley-transaction.ts:54-130) with
// the plan's inputs, outputs and change, fee, certificates and withdrawals and
// no auxiliary data, as Account.prepareTxAux fills it (wallet/account.ts:
// 240-268; its other work, the signing paths, is not in the bytes), then
// ShelleySignedTransactionStructured with cborizeTxWitnesses (:289-346), as
// the wallet's signer assembles it (wallet/shelley/
// shelley-js-crypto-provider.ts:225-238), encoded by the wallet's encodeCbor.
//
// Not replayable (adaliteRefusal): a requested output with a datum or a
// script reference, which the wallet's outputs cannot carry
// (wallet/types.ts:67-81); and a redeemer, since a part written after the
// build cannot take one (so no script spend and no collateral). The spend's
// validity is written by the wallet: its TTL (body field 3) and validity
// start (8) as ShelleyTxAux's ttl and validityIntervalStart (a spend with
// neither carries none). validateTxPlan holds a requested output to the
// wallet's own minimum (:338-347), which prices its coin at 9 bytes, so an
// output at the ledger's minimum fails as the wallet's OutputTooSmall.
//
// Every other fixed part is one the wallet can neither write nor price, so it
// is written on the wallet's transaction after the build, unpriced and named
// in library.unpriced (afterParts): fixed inputs (added to body field 0),
// reference inputs (18, a tag-258 set in order), certificates (4),
// withdrawals (5), the mint field (9), required signers (14), network id
// (15), votes (19), proposals (20), the treasury value (21), the donation
// (22), auxiliary data with its hash (7), and the witness set's scripts,
// datums and bootstrap witnesses. The value such a part moves (a fixed input,
// a withdrawal, a mint, a deposit) is not in the wallet's balance, so its
// transaction fails the kit's balance check; the record names the part.
//
// Witnesses (setting serialization 'own'): one synthetic vkey witness per
// wallet key (kit/replay.mjs replayWitnessKeys), then the intent's other vkey
// witnesses as observed, given to the wallet's cborizeTxWitnesses as Shelley
// witnesses. The wallet prices one 139-byte witness per input; library.unpriced
// names the observed vkey witnesses when the transaction carries more vkey
// witnesses than inputs.
//
// The wallet's outcomes to failure classes (setting unclassified 'other' for
// the rest):
//   CannotConstructTxPlan (computeTxPlan.ts:76-97, :213-221), with every UTxO
//   offered: a requested token short                             balance
//     the UTxOs leave tokens over after the outputs: the token change's
//     minimum ADA cannot be paid (:213-221)                     change-minimum
//     otherwise                                                 balance
//   ChangeOutputTooSmall (:327-336)                             change-minimum
//   OutputTooSmall (:338-347), a requested output under the wallet's own
//   minimum                                                     other
//   OutputTooBig (:349-358), an output over 4,000 bytes         value-size
//   TxTooBig thrown by estimateTxSize (estimateTxSize.ts:93)    tx-size
//   CoinAmountError (:313-324)                                  other
//
// The layout change (opts.changePolicy 'layout'): the same plan and
// transaction as for its own change; the wallet inputs are read from that
// transaction, its change is dropped, and the simulator's layout change
// (methods/change.mjs) is built on those inputs, the kit assembling the
// transaction at its exact fee with the intent's fixed parts, as for typhonjs.
// A wallet that fails to plan fails before this point, as for its own change.

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLASSES } from '../kit/check.mjs';
import { passMachineErrors } from '../kit/machine.mjs';
import { inspectTx } from '../kit/inspect.mjs';
import { replayRefusal, listItems, replayWitnessKeys, syntheticVkeys } from '../kit/replay.mjs';
import { blake2b256 } from '../history/blake2b.mjs';
import { decodeOutputBytes } from '../history/output.mjs';
import { assetMap, mergeAssets } from '../history/value.mjs';
import { minFee } from '../kit/fee.mjs';
import { decode, raw, head, encUint, encBytes, encArray, encTag, asUint, asBytes } from '../history/cbor.mjs';
import { cmpRef } from '../state/state.mjs';
import { NOT_REPLAYABLE } from './contract.mjs';
import { buildWithChange } from './change.mjs';
import { inputOrder, recordsOf, refuseUncovered, REPLAY_COVERAGE, errorText, txRecord } from './library.mjs';
import { ADALITE_COMMIT, ADALITE_REPO, ADALITE_PATHS, ADALITE_PACKAGES, OUTPUT_DIR, BUNDLE, BUILD_RECORD, BUILD_SCRIPT } from './adalite-source.mjs';

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const requireTool = createRequire(import.meta.url);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// Why the build cannot be loaded, or null when it can.
export function adaliteBuildProblem() {
  const hint = `run node ${BUILD_SCRIPT} --clone <a clone of ${ADALITE_REPO}> (or --fetch <a new directory>) in ${TOOL}`;
  const dir = join(TOOL, OUTPUT_DIR);
  const recFile = join(dir, BUILD_RECORD);
  if (!existsSync(recFile)) return `the build of AdaLite's source is missing (${join(OUTPUT_DIR, BUILD_RECORD)}); ${hint}`;
  let rec;
  try {
    rec = JSON.parse(readFileSync(recFile, 'utf8'));
  } catch (e) {
    return `the build record ${join(OUTPUT_DIR, BUILD_RECORD)} cannot be read (${e.message}); ${hint}`;
  }
  const differs = [];
  if (rec.commit !== ADALITE_COMMIT) differs.push(`commit ${rec.commit}`);
  const paths = rec.paths || {};
  if (Object.keys(paths).length !== Object.keys(ADALITE_PATHS).length) differs.push('the list of paths');
  for (const [p, [type, hash]] of Object.entries(ADALITE_PATHS)) if (!paths[p] || paths[p].type !== type || paths[p].hash !== hash) differs.push(p);
  for (const [pkg, v] of Object.entries(ADALITE_PACKAGES)) {
    if (!rec.packages || !rec.packages[pkg] || rec.packages[pkg].version !== v) differs.push(`${pkg} in the record`);
    const installed = JSON.parse(readFileSync(join(TOOL, 'node_modules', ...pkg.split('/'), 'package.json'), 'utf8')).version;
    if (installed !== v) differs.push(`${pkg} ${installed} installed, ${v} pinned`);
  }
  const bundle = join(dir, BUNDLE);
  if (!existsSync(bundle) || !rec.bundle || sha256(bundle) !== rec.bundle.sha256) differs.push('the bundle\'s SHA-256');
  if (differs.length) return `the build of AdaLite's source differs from the pins (${differs.join('; ')}); ${hint}`;
  return null;
}

let LOADED = null;
// The bundle, the bignumber.js it loads (the tool's copy, the same instance)
// and one Account.
export function loadAdaLite() {
  if (LOADED) return LOADED;
  const problem = adaliteBuildProblem();
  if (problem) throw new Error(`adalite: ${problem}`);
  const A = requireTool(join(TOOL, OUTPUT_DIR, BUNDLE));
  const BigNumber = requireTool('bignumber.js');
  const cryptoProvider = Object.freeze({ getDerivationScheme: () => ({ type: 'v2' }), isFeatureSupported: () => false, network: Object.freeze({}) });
  const account = A.Account({ config: { ADALITE_GAP_LIMIT: 20 }, cryptoProvider, blockchainExplorer: {}, accountIndex: 0 });
  LOADED = Object.freeze({ A, BigNumber, account });
  return LOADED;
}

const big = (L, n) => new L.BigNumber(n.toString());
const bigint = (b) => BigInt(b.toFixed());
const tokenOf = (L, a) => ({ policyId: a.policy, assetName: a.name, quantity: big(L, a.qty) });

// The wallet's UTxO for a state's record, made afresh for each build. An
// address is its text, Bech32 or, for Byron, Base58, as the wallet receives
// it from its backend or from the send form (isShelleyFormat and
// addressToHex, wallet/shelley/helpers/addresses.ts:73-75, :114-117).
const utxoOf = (L, u) => {
  const i = u.ref.indexOf('#');
  return { txHash: u.ref.slice(0, i), outputIndex: Number(u.ref.slice(i + 1)), address: u.address, coins: big(L, u.coin), tokenBundle: u.assets.map((a) => tokenOf(L, a)) };
};

// The request as the wallet's outputs ({ isChange: false, address, coins,
// tokenBundle }, wallet/types.ts:67-73), or why the planner cannot take it.
export function requestOf(L, intent) {
  const outputs = [];
  for (const [i, o] of intent.requested.entries()) {
    const d = decodeOutputBytes(Buffer.from(o.cbor, 'hex'));
    if (d.datum || d.scriptRef) return { refusal: `requested output ${i} has a datum or a script reference, which the wallet's outputs cannot carry (wallet/types.ts:67-81)` };
    outputs.push({ isChange: false, address: o.address, coins: big(L, o.coin), tokenBundle: o.assets.map((a) => tokenOf(L, a)) });
  }
  return { outputs };
}

// The arguments arrangeUtxos is given (wallet/account.ts:306-340): a token
// send when the request's outputs hold exactly one token between them, so that
// its holders come first (:325-338); an ADA send otherwise.
export function arrangeArgs(L, intent) {
  const tokens = new Map();
  for (const o of intent.requested) for (const a of o.assets) tokens.set(`${a.policy}.${a.name}`, a);
  const { TxType, AssetFamily } = L.A;
  if (tokens.size === 1) {
    const a = [...tokens.values()][0];
    return { txType: TxType.SEND_ADA, sendAmount: { assetFamily: AssetFamily.TOKEN, fieldValue: '', token: tokenOf(L, a) } };
  }
  return { txType: TxType.SEND_ADA, sendAmount: { assetFamily: AssetFamily.ADA, fieldValue: '', coins: big(L, 0) } };
}

// selectMinimalTxPlan (shelley-transaction-planner.ts:194-223) with the
// request's outputs where the draft has its outputs (:199), and the draft's
// empty certificates and withdrawals and null auxiliary data.
export function planLoop(L, utxos, outputs, changeAddress) {
  const certificates = [];
  const withdrawals = [];
  const auxiliaryData = null;
  const change = {
    isChange: false,
    address: changeAddress,
    coins: new L.BigNumber(0),
    tokenBundle: []
  };
  let txPlanResult = null;
  let numInputs = 0;
  while (numInputs <= utxos.length) {
    const inputs = utxos.slice(0, numInputs);
    txPlanResult = L.A.validateTxPlan(L.A.computeTxPlan(inputs, outputs, change, certificates, withdrawals, auxiliaryData));
    if (txPlanResult.success === true) {
      if (txPlanResult.txPlan.baseFee === txPlanResult.txPlan.fee || numInputs === utxos.length) {
        return txPlanResult;
      }
    }
    numInputs += 1;
  }
  if (txPlanResult == null) throw new Error('the planner gave no result');
  return txPlanResult;
}

// The wallet's plan for the request: its arrangement of the UTxOs, then the
// loop. Throws what the wallet throws (TxTooBig).
export function planTx(L, intent, utxos, changeAddress) {
  const { outputs } = requestOf(L, intent);
  const arranged = L.account._arrangeUtxos(utxos, arrangeArgs(L, intent));
  return planLoop(L, arranged, outputs, changeAddress);
}

// Why the intent is not replayable by the wallet, or null.
export function adaliteRefusal(L, intent) {
  const kit = intent.source === 'replay' ? replayRefusal(intent) : null;
  if (kit) return kit;
  const r = requestOf(L, intent);
  if (r.refusal) return r.refusal;
  const f = intent.source === 'replay' ? intent.fixed : null;
  if (f && f.redeemers.length) return 'a redeemer: the wallet writes no script part, and a part written after the build cannot take one';
  if (intent.collateral && intent.collateral.required) return 'collateral: the wallet writes none';
  return null;
}

const BODY_AFTER = [[4, 'certificates'], [5, 'withdrawals'], [9, 'mint'], [14, 'required signers'], [15, 'network id'], [19, 'votes'], [20, 'proposals'], [21, 'treasury value'], [22, 'donation']];
const WITNESS_AFTER = [[1, 'native scripts'], [2, 'bootstrap witnesses'], [3, 'Plutus scripts'], [4, 'witness-set datums'], [6, 'Plutus scripts'], [7, 'Plutus scripts']];

const inputBytes = (ref) => {
  const i = ref.indexOf('#');
  return encArray([encBytes(Buffer.from(ref.slice(0, i), 'hex')), encUint(Number(ref.slice(i + 1)))]);
};

// The fixed parts written after the build: { inputs [bytes], body Map,
// witnesses Map, aux, unpriced [names] }.
export function afterParts(intent) {
  const f = intent.source === 'replay' ? intent.fixed : null;
  const out = { inputs: [], body: new Map(), witnesses: new Map(), aux: null, unpriced: [] };
  if (!f) return out;
  const name = (n) => {
    if (!out.unpriced.includes(n)) out.unpriced.push(n);
  };
  if (f.inputs.length) {
    out.inputs = f.inputs.map((x) => inputBytes(x.ref));
    name('fixed inputs');
  }
  if (f.referenceInputs.length) {
    out.body.set(18, encTag(258, encArray(f.referenceInputs.map((x) => x.ref).sort(cmpRef).map(inputBytes))));
    name('reference inputs');
  }
  for (const [k, n] of BODY_AFTER) {
    if (f.body[k] === undefined) continue;
    out.body.set(k, Buffer.from(f.body[k], 'hex'));
    name(n);
  }
  if (f.auxiliaryData) {
    out.aux = Buffer.from(f.auxiliaryData, 'hex');
    out.body.set(7, encBytes(blake2b256(out.aux)));
    name('auxiliary data');
  }
  for (const [k, n] of WITNESS_AFTER) {
    if (f.witnesses[k] === undefined) continue;
    out.witnesses.set(k, Buffer.from(f.witnesses[k], 'hex'));
    name(n);
  }
  return out;
}

// The wallet's transaction with the parts written after the build: the fixed
// inputs after the wallet's in field 0, new body fields and witness-set lists
// after the wallet's in key order, and the auxiliary data.
function withPartsAfter(hexTx, after) {
  if (!after.inputs.length && !after.body.size && !after.witnesses.size && !after.aux) return hexTx;
  const buf = Buffer.from(hexTx, 'hex');
  const [bodyNode, witNode, validNode, auxNode] = decode(buf).items;
  const mapWith = (node, replace, added) => {
    const out = [];
    for (const [k, v] of node.entries) {
      const kb = raw(buf, k);
      out.push(kb, replace(Number(k.value), v) || raw(buf, v));
    }
    const keys = [...added.keys()].sort((a, b) => a - b);
    for (const k of keys) out.push(encUint(k), added.get(k));
    return Buffer.concat([head(5, out.length / 2), ...out]);
  };
  const body = mapWith(bodyNode, (k, v) => {
    if (k !== 0 || !after.inputs.length) return null;
    const items = v.items.map((x) => raw(buf, x));
    return encArray([...items, ...after.inputs]);
  }, after.body);
  const wit = mapWith(witNode, () => null, after.witnesses);
  return Buffer.concat([Buffer.from([0x84]), body, wit, raw(buf, validNode), after.aux || raw(buf, auxNode)]).toString('hex');
}

// Whether the UTxOs offered leave tokens over after the requested outputs,
// and whether one is short.
function tokenBalance(pool, intent) {
  const have = assetMap(mergeAssets(pool.flatMap((u) => u.assets), []));
  const sent = assetMap(mergeAssets(intent.requested.flatMap((o) => o.assets), []));
  let over = false;
  let short = false;
  for (const [k, q] of sent) if ((have.get(k) || 0n) < q) short = true;
  for (const [k, q] of have) if (q > (sent.get(k) || 0n)) over = true;
  return { over, short };
}

// The class of the wallet's failed plan or thrown error.
export function classOfAdaLiteFailure(L, failure, { pool = [], intent = { requested: [] } } = {}) {
  if (failure instanceof Error || (failure && failure.name && !('success' in failure))) {
    if (failure.name === L.A.InternalErrorReason.TxTooBig) return CLASSES.txSize;
    return CLASSES.other;
  }
  const code = failure && failure.error ? failure.error.code : null;
  const R = { ...L.A.InternalErrorReason, ...L.A.UnexpectedErrorReason };
  switch (code) {
    case R.CannotConstructTxPlan: {
      const t = tokenBalance(pool, intent);
      if (t.short) return CLASSES.balance;
      return t.over ? CLASSES.changeMinimum : CLASSES.balance;
    }
    case R.ChangeOutputTooSmall:
      return CLASSES.changeMinimum;
    case R.OutputTooBig:
      return CLASSES.valueSize;
    case R.TxTooBig:
      return CLASSES.txSize;
    default:
      return CLASSES.other;
  }
}

const failureText = (failure) => (failure instanceof Error ? `${failure.name}: ${errorText(failure)}` : `plan: ${failure && failure.error ? failure.error.code : 'no error code'}`);

// The parts written after the build that move value the planner does not
// see: a balance failure of the plan names them, as a failure that follows a
// part written after the build does (the engine's unpricedText).
const VALUE_PARTS = ['fixed inputs', 'withdrawals', 'mint', 'certificates', 'proposals', 'treasury value', 'donation'];
const valuePartsText = (intent, cls) => {
  if (cls !== CLASSES.balance && cls !== CLASSES.changeMinimum) return '';
  const names = afterParts(intent).unpriced.filter((n) => VALUE_PARTS.includes(n));
  return names.length ? `; parts the library did not price: ${names.join(', ')}` : '';
};

// A slot from a fixed body field, as the wallet's BigNumber, or null.
const slotOf = (L, f, k) => (f && f.body[k] !== undefined ? big(L, asUint(decode(Buffer.from(f.body[k], 'hex')), 'slot')) : null);

// Builds the intent with the wallet. It refuses nothing the method below
// refuses first.
export function buildAdaLite(T, state, intent, params, opts, { name = 'adalite-lp' } = {}) {
  const L = loadAdaLite();
  const layout = opts.changePolicy === 'layout';
  if (opts.changePolicy !== 'default' && !layout) return { ok: false, class: CLASSES.other, detail: 'the AdaLite baseline takes its own change or the layout change only' };
  const refusal = adaliteRefusal(L, intent);
  if (refusal) return { ok: false, class: NOT_REPLAYABLE, detail: refusal };
  const f = intent.source === 'replay' ? intent.fixed : null;
  const fixedRefs = new Set(f ? f.inputs.map((x) => x.ref) : []);
  const pool = inputOrder(state).filter((u) => !fixedRefs.has(u.ref));
  let result;
  try {
    result = planTx(L, intent, pool.map((u) => utxoOf(L, u)), state.changeAddress);
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: classOfAdaLiteFailure(L, e, { pool, intent }), detail: `planner: ${failureText(e)}` };
  }
  if (!result.success) {
    const cls = classOfAdaLiteFailure(L, result, { pool, intent });
    return { ok: false, class: cls, detail: `planner: ${failureText(result)}${valuePartsText(intent, cls)}` };
  }
  const plan = result.txPlan;
  let tx;
  let keys;
  let others;
  try {
    const aux = L.A.ShelleyTxAux({
      inputs: plan.inputs,
      outputs: [...plan.outputs, ...plan.change],
      fee: plan.fee,
      ttl: slotOf(L, f, 3),
      certificates: plan.certificates,
      withdrawals: plan.withdrawals,
      auxiliaryDataHash: '',
      auxiliaryData: null,
      validityIntervalStart: slotOf(L, f, 8)
    });
    const refs = plan.inputs.map((u) => `${u.txHash}#${u.outputIndex}`);
    const records = recordsOf(state, refs);
    keys = replayWitnessKeys(f, { inputs: records });
    others = f && f.witnesses[0] !== undefined ? listItems(f.witnesses[0]) : [];
    const shelley = [...syntheticVkeys(T, keys.size), ...others].map((w) => {
      const [vkey, sig] = decode(w).items;
      return { publicKey: Buffer.from(asBytes(vkey, 'vkey')), signature: Buffer.from(asBytes(sig, 'signature')) };
    });
    tx = L.A.encodeCbor(L.A.ShelleySignedTransactionStructured(aux, L.A.cborizeTxWitnesses([], shelley), null)).toString('hex');
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: CLASSES.other, detail: `the wallet's transaction: ${errorText(e)}` };
  }
  const after = afterParts(intent);
  const bytes = withPartsAfter(tx, after);
  // The wallet inputs, read from the transaction the wallet built.
  const walletRefs = inspectTx(tx).inputs.map((i) => i.ref);
  const records = recordsOf(state, walletRefs);
  if (layout) {
    const r = buildWithChange(T, { state, params, inputs: records, intent, policy: 'layout', collateral: null });
    if (!r.ok) return { ok: false, class: r.class, detail: `layout change on the library's inputs: ${r.detail}` };
    return { ok: true, kind: 'single', txs: [txRecord(r.bytes, walletRefs, r.fee, r.size, r.k)] };
  }
  const size = inspectTx(bytes).size;
  const fee = bigint(plan.fee);
  // The wallet prices one witness per input, certificate and withdrawal of
  // its plan (estimateTxSize.ts:77-78); its plan has neither of the last two.
  const priced = plan.inputs.length + plan.certificates.length + plan.withdrawals.length;
  const unpriced = others.length > 0 && keys.size + others.length > priced ? [...after.unpriced, 'observed vkey witnesses'] : after.unpriced;
  return {
    ok: true,
    kind: 'single',
    txs: [txRecord(bytes, walletRefs, fee, size, keys.size)],
    library: { fee, finalMinFee: minFee(params, size, f ? f.scriptFee : 0n), priced, unpriced }
  };
}

export function adaliteMethod(T) {
  const name = 'adalite-lp';
  loadAdaLite();
  return {
    name,
    version: `adalite ${ADALITE_COMMIT.slice(0, 7)} (v7.0.2) planner: arrangeUtxos, then selectMinimalTxPlan's loop over the request`,
    deterministic: true,
    seeded: true,
    build(state, intent, params, opts) {
      refuseUncovered(name, REPLAY_COVERAGE.adalite, intent);
      return buildAdaLite(T, state, intent, params, opts, { name });
    }
  };
}

