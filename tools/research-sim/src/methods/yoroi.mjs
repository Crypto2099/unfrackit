// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Yoroi baseline, yoroi-lf: the send flow of the Yoroi mobile wallet at
// v7.0.5 (Emurgo/yoroi at d8e3d3f93fb772f0b6bd2296e45bfac7da4fb9d6; paths
// below are under mobile/packages/), over cardano-serialization-lib 14.1.2,
// the CSL build that release pins (mobile/package.json:39 for the browser and
// :159 for Node). No package publishes it: scripts/build-yoroi.mjs bundles it
// from the wallet's source at that commit (methods/yoroi-source.mjs has the
// pins and says what the bundle holds) into the gitignored build/wallets/
// yoroi, and this module refuses to load a missing build or one whose record
// differs from the pins (loadYoroi).
//
// The call, as the wallet's send screen makes it: createSendTxFromWallet
// (cardano-wallet/transaction-recipes/wallet-helpers.ts:287-322) reads five
// things from the wallet object and calls createSendTx with them. The method
// calls createSendTx with the same five, taken from the replay:
//   utxos             wallet.utxos(), which leaves the collateral UTxO out
//                     (:43-53), through convertRawUtxosToModernUtxos
//                     (transaction-recipes/helpers.ts:8-41): the state's
//                     spendable UTxOs in its order (inputOrder) as the
//                     backend's records, each token id policy.name in hex as
//                     the wallet's portfolio writes it (portfolio/
//                     validators/token-id.ts:5). The engine's set-aside UTxO
//                     is out of the state, as the wallet's collateral is out
//                     of wallet.utxos(). The addressing of each record, which
//                     only signing reads, is a placeholder.
//   protocolParams    the run's minFeeA and minFeeB as the linear fee's
//                     coefficient and constant, coinsPerUtxoByte, keyDeposit
//                     and poolDeposit
//   networkId         the network of the change address
//   slot              getAbsoluteSlotNumber (wallet-helpers.ts:25-35), of
//                     which createSendTx reads toNumber() alone
//                     (createSendTx.ts:469): the intent's TTL less the
//                     wallet's 7200-slot buffer (tx/transaction-builder/
//                     builder.ts:309-315), so that the wallet writes the
//                     observed TTL, or the intent's slot when it has none
//   change address    getChangeAddress: the state's change address
// The requested outputs are the entries (address, amounts and a datum hash),
// subtractFeeFromAmount is false (a payment of a set amount), and metadata, a
// list of labels with the JSON value of each, carries the intent's
// auxiliary data. The wallet's logger, which defaults to a no-op
// (logger/logger.ts:7-39), is set for the call through setLogger so that the
// first build failure can be read.
//
// The path, at that commit (cardano-wallet/transaction-recipes/
// createSendTx.ts):
//   :136-310  the amounts required: each output's ADA, raised for an output
//             carrying tokens to CSL's minAdaForOutput or 1 ADA, whichever is
//             larger (:165-288), and the tokens; the same raise is written
//             into the output (:440-455)
//   :314-318  a fee estimate of minFeeB + minFeeA * 500
//   :321-326  selectUtxosForAmounts (tx/transaction-builder/helpers.ts:
//             236-423): every UTxO holding a requested token, in the list's
//             order (:262-275); then, while the ADA falls short of the
//             outputs, the estimate, 0.1 ADA and an estimated change minimum
//             (1 ADA, plus 0.2 ADA per token in the change), the UTxOs
//             holding only ADA sorted by ADA descending, then the others
//             likewise (:365-379; sortUtxosByAda :189-202, a stable sort, so
//             the list's order breaks ties), each taken in turn (:380-420)
//   :338-416  for a payment with no token, the UTxOs holding tokens dropped
//             from the selection, and the first selection restored when what
//             is left holds less ADA than the outputs, the estimate and 1 ADA
//   :418-500  the build: the selection as inputs, the outputs, the change
//             address, the TTL, the metadata, then buildTransaction
//             (tx/transaction-builder/builder.ts:635-1638): a CSL
//             TransactionBuilder with maxValueSize 5000, maxTxSize 16384 and
//             prefer_pure_change set, written into the wallet (:590-633),
//             addRegularInput for each selected UTxO (:895-951), and, with no
//             manual fee, CSL's add_change_if_needed (:1083-1458, the call at
//             :1419). With metadata the wallet first sets a fee of its own
//             estimate (twice a body estimate and a 10 percent margin,
//             :1200-1275), which CSL then takes as the exact fee (set_fee and
//             min_fee in CSL's rust/src/builders/tx_builder.rs at tag 14.1.2,
//             commit 63008bf, :1136-1138 and :2599)
//   :723-812  a build error that names the change output ("Not enough ADA
//             to create change output", the wallet's own message for CSL's
//             change failure when the inputs hold tokens, builder.ts:
//             1423-1457) makes the wallet rebuild with the first output's ADA
//             lowered, step by step (:813-1082); any other error is thrown
// Nothing on the path draws at random: the method is deterministic. The
// change is CSL's add_change_if_needed with prefer_pure_change: token change
// packed under maxValueSize, and the ADA left after it as a separate
// ADA-only output when it covers that output's minimum and fee. Its code
// (tx_builder.rs:1810-2210 at 14.1.2) is the same text as at 17.0.0, the
// treatment's CSL (methods/csl.mjs describes it); the configuration differs.
//
// The amount-lowering retry pays less than the intent asks, so a spend whose
// first build failed is a failure of the class of that first failure, read
// from the wallet's log line 'createSendTx: Initial build failed'
// (:755-778) when the next line says it will retry (:796-798), whether or not
// a retry then built. Any other built transaction whose requested outputs
// differ from the intent's is class other with "requested output": the wallet
// raises a token output's coin to at least 1 ADA, and it leaves a token whose
// asset name is empty out of every value it writes (builder.ts:446-451 split
// the token id at the dot and skip an empty name). An input holding such a
// token therefore reaches CSL without it, and the transaction does not
// conserve that asset, which the kit's check fails with class balance.
//
// Errors to failure classes (setting unclassified 'other' for the rest; the
// wallet prefixes an error it does not know with "Failed to create send
// transaction: ", createSendTx.ts:1200-1206):
//   "Not enough ADA to create change output" (builder.ts:1446-1454), CSL's
//   "Not enough ADA leftover to include non-ADA assets in a change address"
//                                                      change-minimum
//   "Not enough balance for transaction" (NotEnoughMoneyToSendError,
//   types/errors.ts:108-113; builder.ts:1557-1564 when the inputs do not pay
//   the outputs and the fee), CSL's "Insufficient input in transaction" and
//   "UTxO Balance Insufficient"                        balance
//   CSL's "Maximum transaction size of ... exceeded"   tx-size
//   CSL's "Maximum value size of ... exceeded"         value-size
//
// Witnesses: the wallet returns the transaction with an empty witness set
// (builder.ts:1568-1622), its fee priced by CSL with one fake vkey witness
// per key it counts. The method writes, in CSL 14.1.2's encoding, one
// synthetic vkey witness per wallet key (kit/replay.mjs replayWitnessKeys),
// then the intent's other vkey witnesses as observed, and keeps the wallet's
// body and auxiliary data bytes as they are.
//
// Change policies: 'default' (L/own) is the wallet's own change. 'layout'
// (L/layout) makes the same call, reads the wallet inputs from the
// transaction the wallet returned (the selection, which every rebuild reuses:
// createSendTx.ts:425), drops its outputs, and builds UnFrack.It's change on
// those inputs (methods/change.mjs), assembled at its exact fee by the kit
// with the intent's parts, as the other library adapters do. When those
// inputs cannot fund that change, class change-minimum (setting
// substitutedChange 'fail'). A call that throws is the wallet's failure under
// either policy, with the class of its first failure. No other policy is
// accepted.
//
// The replay path. The send flow takes outputs, a TTL and metadata, and
// nothing else, so an intent is replayed when its parts are those:
//   requested outputs  entries with the output's address, coin and tokens,
//                      and a datum hash as { hash } (builder.ts:571-580);
//                      the wallet writes each in CSL's array form
//   validity           the TTL (body field 3), written by the wallet from the
//                      slot above; the method checks the bytes
//   auxiliary data     metadata, each label's metadatum given as the JSON CSL
//                      14.1.2 decodes it to under BasicConversions, which the
//                      wallet encodes back under the same schema
//                      (builder.ts:1463-1520); the method checks that each
//                      label's metadatum comes back byte for byte (the
//                      container form is the wallet's)
//   witnesses          the intent's other vkey witnesses, after the build,
//                      unpriced
// Not replayable (the send flow has no way to express them): fixed inputs,
// reference inputs, collateral, body fields other than 3 (certificates,
// withdrawals, field 6, a validity start, the mint, required signers, votes,
// proposals, the treasury fields), and so every implicit value; witness-set
// entries other than vkey witnesses (scripts, datums, redeemers, bootstrap
// witnesses); a requested output with an inline datum or a reference script;
// a TTL under the 7200-slot buffer, or one the wallet writes in other bytes;
// auxiliary data holding a script, or metadata whose JSON form the wallet
// encodes to other bytes (an integer beyond 2^53, a text string that reads as
// hex bytes).

import { CLASSES } from '../kit/check.mjs';
import { passMachineErrors } from '../kit/machine.mjs';
import { inspectTx } from '../kit/inspect.mjs';
import { replayRefusal, listItems, replayWitnessKeys, syntheticVkeys } from '../kit/replay.mjs';
import { minFee } from '../kit/fee.mjs';
import { decode, raw, asUint } from '../history/cbor.mjs';
import { decodeTx, assembleTx } from '../history/tx.mjs';
import { addressBytes } from '../history/address.mjs';
import { NOT_REPLAYABLE } from './contract.mjs';
import { buildWithChange } from './change.mjs';
import { inputOrder, recordsOf, refuseUncovered, REPLAY_COVERAGE, errorText, txRecord } from './library.mjs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { YOROI_REPO, YOROI_COMMIT, YOROI_RELEASE, YOROI_PATHS, YOROI_NPM, YOROI_CSL, CSL_ALIAS, OUTPUT_DIR, BUNDLE, BUILD_RECORD, BUILD_SCRIPT } from './yoroi-source.mjs';

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const requireTool = createRequire(import.meta.url);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// Why the build in `dir` (the tool's OUTPUT_DIR by default) cannot be loaded,
// or null when it can.
export function yoroiBuildProblem(dir = join(TOOL, OUTPUT_DIR)) {
  const hint = `run node ${BUILD_SCRIPT} --clone <a clone of ${YOROI_REPO}> (or --fetch <a new directory>) in ${TOOL}`;
  const recFile = join(dir, BUILD_RECORD);
  if (!existsSync(recFile)) return `the build of Yoroi's source is missing (${join(OUTPUT_DIR, BUILD_RECORD)}); ${hint}`;
  let rec;
  try {
    rec = JSON.parse(readFileSync(recFile, 'utf8'));
  } catch (e) {
    return `the build record ${join(OUTPUT_DIR, BUILD_RECORD)} cannot be read (${e.message}); ${hint}`;
  }
  const differs = [];
  if (rec.commit !== YOROI_COMMIT) differs.push(`commit ${rec.commit}`);
  const paths = rec.paths || {};
  if (Object.keys(paths).length !== Object.keys(YOROI_PATHS).length) differs.push('the list of paths');
  for (const [p, [type, hash]] of Object.entries(YOROI_PATHS)) if (!paths[p] || paths[p].type !== type || paths[p].hash !== hash) differs.push(p);
  for (const [pkg, pin] of Object.entries(YOROI_NPM)) if (!rec.npm || !rec.npm[pkg] || rec.npm[pkg].integrity !== pin.integrity) differs.push(`${pkg} in the record`);
  if (!rec.csl || rec.csl.integrity !== YOROI_CSL.integrity || rec.csl.alias !== CSL_ALIAS) differs.push('the CSL pin in the record');
  let installed = null;
  try {
    installed = JSON.parse(readFileSync(requireTool.resolve(`${CSL_ALIAS}/package.json`), 'utf8')).version;
  } catch {
    // not installed
  }
  if (installed !== YOROI_CSL.version) differs.push(`${CSL_ALIAS} ${installed || 'not'} installed, ${YOROI_CSL.version} pinned`);
  const bundle = join(dir, BUNDLE);
  if (!existsSync(bundle) || !rec.bundle || sha256(bundle) !== rec.bundle.sha256) differs.push('the bundle\'s SHA-256');
  if (differs.length) return `the build of Yoroi's source differs from the pins (${differs.join('; ')}); ${hint}`;
  return null;
}

const LOADED = new Map();
// The bundle's exports and the CSL instance it loads, from the build in `dir`.
export function loadYoroi(dir = join(TOOL, OUTPUT_DIR)) {
  if (LOADED.has(dir)) return LOADED.get(dir);
  const problem = yoroiBuildProblem(dir);
  if (problem) throw new Error(`yoroi: ${problem}`);
  const lib = requireTool(join(dir, BUNDLE));
  const CSL = createRequire(join(dir, BUNDLE))(CSL_ALIAS);
  const loaded = Object.freeze({ ...lib, CSL });
  LOADED.set(dir, loaded);
  return loaded;
}

// Cardano's primary token id in the wallet's portfolio (portfolio/
// constants.ts:5).
export const PRIMARY_TOKEN_ID = '.';
// The slots setTTLWithBuffer adds by default (builder.ts:309-315).
export const TTL_BUFFER = 7200;
// The fixed body field the send flow writes: the TTL.
const SEND_BODY_FIELDS = new Set([3]);

const ERROR_CLASSES = [
  [/^Not enough ADA to create change output/, CLASSES.changeMinimum],
  [/^Not enough ADA leftover to include non-ADA assets in a change address/, CLASSES.changeMinimum],
  [/^Not enough balance for transaction/, CLASSES.balance],
  [/^Insufficient input in transaction/, CLASSES.balance],
  [/^UTxO Balance Insufficient/, CLASSES.balance],
  [/^Maximum transaction size of \d+ exceeded/, CLASSES.txSize],
  [/^Maximum value size of \d+ exceeded/, CLASSES.valueSize]
];
const WRAPPED = 'Failed to create send transaction: ';

export function classOfYoroiError(text) {
  const t = text.startsWith(WRAPPED) ? text.slice(WRAPPED.length) : text;
  for (const [re, cls] of ERROR_CLASSES) if (re.test(t)) return cls;
  return CLASSES.other;
}

const hexOf = (b) => Buffer.from(b).toString('hex');
const tokenId = (a) => `${a.policy}.${a.name}`;

class Unexpressible extends Error {}
const nr = (m) => {
  throw new Unexpressible(m);
};

// The metadata map of an auxiliary data (hex), in any of its three forms, as
// [[label (bigint), metadatum bytes]]; throws Unexpressible when it holds a
// script.
export function metadataEntries(hex) {
  const b = Buffer.from(hex, 'hex');
  const top = decode(b);
  let map = null;
  if (top.mt === 5) map = top;
  else if (top.mt === 4) {
    if (top.items[1] && top.items[1].items.length) nr('auxiliary data holding a script');
    map = top.items[0];
  } else if (top.mt === 6 && top.tag === 259n) {
    for (const [k, v] of top.item.entries) {
      if (Number(k.value) === 0) map = v;
      else if (v.items && v.items.length) nr('auxiliary data holding a script');
    }
  } else nr('auxiliary data of a form the wallet does not read');
  if (!map) return [];
  if (map.mt !== 5) nr('auxiliary data whose metadata is not a map');
  return map.entries.map(([k, v]) => [asUint(k, 'metadata label'), Buffer.from(raw(b, v))]);
}

// The wallet's metadata argument for the intent's auxiliary data: each label
// with the JSON CSL 14.1.2 decodes its metadatum to under BasicConversions.
function metadataArgument(CSL, hex) {
  const out = [];
  for (const [label, bytes] of metadataEntries(hex)) {
    let json;
    const md = CSL.TransactionMetadatum.from_bytes(bytes);
    try {
      json = CSL.decode_metadatum_to_json_str(md, CSL.MetadataJsonSchema.BasicConversions);
    } catch (e) {
      passMachineErrors(e);
      nr(`metadata label ${label}: CSL's BasicConversions has no JSON for it (${errorText(e)})`);
    } finally {
      md.free();
    }
    out.push({ label: label.toString(), data: JSON.parse(json) });
  }
  return out;
}

// Throws Unexpressible for the first part of the intent the send flow has no
// way to express. Returns the slot to give the wallet and the metadata.
function sendParts(CSL, intent) {
  const refusal = replayRefusal(intent);
  if (refusal) nr(refusal);
  if (intent.collateral.required) nr('collateral: the send flow spends no script');
  for (const o of intent.requested) {
    if (o.datum && o.datum.kind !== 'hash') nr('a requested output with an inline datum');
    if (o.scriptRef) nr('a requested output with a reference script');
  }
  const f = intent.fixed;
  let slot = intent.time ? intent.time.slot : 0;
  let metadata;
  if (!f) return { slot, metadata };
  if (f.inputs.length) nr('fixed inputs');
  if (f.referenceInputs.length) nr('reference inputs');
  for (const k of Object.keys(f.body)) if (!SEND_BODY_FIELDS.has(Number(k))) nr(`body field ${k}`);
  for (const k of Object.keys(f.witnesses)) if (Number(k) !== 0) nr(`witness-set key ${k}`);
  if (f.redeemers.length) nr('redeemers');
  if (f.body[3] !== undefined) {
    const ttl = asUint(decode(Buffer.from(f.body[3], 'hex')), 'TTL');
    if (ttl < BigInt(TTL_BUFFER)) nr(`a TTL of ${ttl}, under the wallet's buffer of ${TTL_BUFFER} slots`);
    slot = Number(ttl - BigInt(TTL_BUFFER));
  }
  if (f.auxiliaryData) metadata = metadataArgument(CSL, f.auxiliaryData);
  return { slot, metadata };
}

// The transaction the wallet built, checked against what the intent fixes:
// the TTL's bytes and each metadata label's bytes. Throws Unexpressible.
function checkFixed(intent, tx) {
  const f = intent.fixed;
  const ttl = tx.body.fields.get(3);
  if (f && f.body[3] !== undefined) {
    if (!ttl || hexOf(ttl.raw) !== f.body[3]) nr(`validity: the wallet writes the TTL as ${ttl ? hexOf(ttl.raw) : 'nothing'}, the intent ${f.body[3]}`);
  }
  const want = f && f.auxiliaryData ? new Map(metadataEntries(f.auxiliaryData).map(([l, b]) => [l, hexOf(b)])) : new Map();
  const got = tx.aux ? new Map(metadataEntries(hexOf(tx.aux.raw)).map(([l, b]) => [l, hexOf(b)])) : new Map();
  if (want.size !== got.size || [...want].some(([l, b]) => got.get(l) !== b)) nr('auxiliary data: the metadata the wallet encodes from its JSON differs from the intent\'s');
}

// The first requested output the wallet's transaction does not hold as the
// intent asks (address, coin, tokens, datum hash), in the entries' order.
function changedOutput(intent, tx) {
  const outs = inspectTx(tx.buf).outputs;
  const assetsKey = (as) => as.map((a) => `${tokenId(a)}=${BigInt(a.qty)}`).sort().join(',');
  for (let i = 0; i < intent.requested.length; i++) {
    const o = intent.requested[i];
    const w = outs[i];
    const datum = o.datum ? o.datum.hash : null;
    const got = w ? { address: hexOf(w.address), coin: w.coin, assets: assetsKey(w.assets), datum: w.datum ? w.datum.hash : null } : null;
    if (!got || got.address !== hexOf(addressBytes(o.address)) || got.coin !== BigInt(o.coin) || got.assets !== assetsKey(o.assets) || got.datum !== datum) {
      return `requested output ${i}: the wallet wrote ${got ? `coin ${got.coin} and assets [${got.assets}]` : 'no output'}, the intent asks coin ${o.coin} and assets [${assetsKey(o.assets)}]`;
    }
  }
  return null;
}

// The wallet's records of the state's spendable UTxOs, in the state's order.
function rawUtxos(state) {
  return inputOrder(state).map((u) => {
    const i = u.ref.indexOf('#');
    const txHash = u.ref.slice(0, i);
    const txIndex = Number(u.ref.slice(i + 1));
    return {
      amount: u.coin.toString(),
      receiver: u.address,
      tx_hash: txHash,
      tx_index: txIndex,
      utxo_id: `${txHash}:${txIndex}`,
      assets: u.assets.map((a) => ({ amount: a.qty.toString(), tokenId: tokenId(a), policyId: a.policy, name: a.name }))
    };
  });
}

const amountsOf = (o) => {
  const m = { [PRIMARY_TOKEN_ID]: BigInt(o.coin).toString() };
  for (const a of o.assets) m[tokenId(a)] = BigInt(a.qty).toString();
  return m;
};

// A logger that keeps the wallet's debug lines (logger/types.ts).
function captureLogger(noOp) {
  const lines = [];
  return {
    lines,
    logger: { ...noOp, trail: [], debug: (message, metadata) => lines.push({ message, metadata }) }
  };
}

// One call of the send flow. Returns { ok, tx (decoded), cbor } or
// { ok: false, class, detail, notReplayable }.
async function send(Y, state, intent, params) {
  let parts;
  try {
    parts = sendParts(Y.CSL, intent);
  } catch (e) {
    passMachineErrors(e);
    if (e instanceof Unexpressible) return { ok: false, class: NOT_REPLAYABLE, detail: `yoroi: ${e.message}` };
    throw e;
  }
  if (params.keyDeposit === null || params.poolDeposit === null) throw new Error('yoroi: the wallet needs the key and pool deposits, which this run does not state');
  const utxos = Y.convertRawUtxosToModernUtxos(rawUtxos(state), () => ({ path: [], startLevel: 0 }), PRIMARY_TOKEN_ID);
  const entries = intent.requested.map((o) => ({ address: o.address, amounts: amountsOf(o), ...(o.datum ? { datum: { hash: o.datum.hash } } : {}) }));
  const cap = captureLogger(Y.noOpLogger);
  Y.setLogger(cap.logger);
  let cbor;
  let thrown = null;
  try {
    ({ cbor } = await Y.createSendTx({
      utxos,
      entries,
      primaryTokenId: PRIMARY_TOKEN_ID,
      protocolParams: {
        coinsPerUtxoByte: String(params.coinsPerUtxoByte),
        keyDeposit: String(params.keyDeposit),
        linearFee: { constant: String(params.minFeeB), coefficient: String(params.minFeeA) },
        poolDeposit: String(params.poolDeposit)
      },
      networkId: addressBytes(state.changeAddress)[0] & 15,
      getAbsoluteSlotNumber: async () => ({ toNumber: () => parts.slot }),
      getChangeAddress: () => state.changeAddress,
      addressMode: 'single',
      metadata: parts.metadata
    }));
  } catch (e) {
    passMachineErrors(e);
    thrown = errorText(e);
  } finally {
    Y.setLogger(Y.noOpLogger);
  }
  const first = cap.lines.find((l) => l.message === 'createSendTx: Initial build failed');
  const retried = cap.lines.some((l) => l.message === 'createSendTx: Initial build failed, will retry with reduced amount');
  const firstText = first && first.metadata ? String(first.metadata.errorMessage) : null;
  if (thrown !== null) {
    const t = firstText !== null && retried ? firstText : thrown;
    return { ok: false, class: classOfYoroiError(t), detail: retried ? `createSendTx: ${t} (then: ${thrown})` : `createSendTx: ${t}` };
  }
  const tx = decodeTx(Buffer.from(cbor, 'hex'));
  try {
    checkFixed(intent, tx);
  } catch (e) {
    if (e instanceof Unexpressible) return { ok: false, class: NOT_REPLAYABLE, detail: `yoroi: ${e.message}` };
    throw e;
  }
  const changed = changedOutput(intent, tx);
  return {
    ok: true,
    tx,
    cbor,
    // L/own's verdict on the wallet's transaction: the first failure when
    // the wallet lowered the amount, a requested output it changed.
    own: retried ? { ok: false, class: classOfYoroiError(firstText), detail: `createSendTx: ${firstText} (the wallet then lowered the first output's ADA)` } : changed ? { ok: false, class: CLASSES.other, detail: changed } : null
  };
}

// The wallet's transaction with one synthetic vkey witness per wallet key and
// the intent's other vkey witnesses, its body and auxiliary data as the
// wallet wrote them; the witness set in CSL 14.1.2's encoding.
function withWitnesses(T, CSL, tx, n, fixed) {
  const vk = CSL.Vkeywitnesses.new();
  const ws = CSL.TransactionWitnessSet.new();
  const made = [];
  try {
    for (const w of syntheticVkeys(T, n)) {
      const x = CSL.Vkeywitness.from_bytes(w);
      made.push(x);
      vk.add(x);
    }
    if (fixed && fixed.witnesses[0] !== undefined) {
      for (const w of listItems(fixed.witnesses[0])) {
        const x = CSL.Vkeywitness.from_bytes(w);
        made.push(x);
        vk.add(x);
      }
    }
    if (vk.len()) ws.set_vkeys(vk);
    const wits = Buffer.from(ws.to_bytes());
    return assembleTx({ body: tx.body.raw, wits, aux: tx.aux ? tx.aux.raw : null, isValid: true, alonzo: true }).toString('hex');
  } finally {
    for (const x of made) x.free();
    vk.free();
    ws.free();
  }
}

export function yoroiMethod(T) {
  const Y = loadYoroi();
  const name = 'yoroi-lf';
  return {
    name,
    version: `Yoroi ${YOROI_RELEASE} (${YOROI_COMMIT.slice(0, 7)}) createSendTx over cardano-serialization-lib ${YOROI_CSL.version}`,
    deterministic: true,
    seeded: true,
    async build(state, intent, params, opts) {
      refuseUncovered(name, REPLAY_COVERAGE.yoroi, intent);
      if (intent.source !== 'replay') throw new Error(`${name} builds replayed intents only`);
      if (opts.changePolicy !== 'default' && opts.changePolicy !== 'layout') return { ok: false, class: CLASSES.other, detail: `${name} takes its own change or the layout change only` };
      const r = await send(Y, state, intent, params);
      if (!r.ok) return { ok: false, class: r.class, detail: r.detail };
      const refs = inspectTx(r.tx.buf).inputs.map((x) => x.ref);
      const inputs = recordsOf(state, refs);
      if (opts.changePolicy === 'layout') {
        const c = buildWithChange(T, { state, params, inputs, intent, policy: 'layout' });
        if (!c.ok) return { ok: false, class: c.class, detail: `layout change on the wallet's inputs: ${c.detail}` };
        return { ok: true, kind: 'single', txs: [txRecord(c.bytes, inputs.map((u) => u.ref), c.fee, c.size, c.k)] };
      }
      if (r.own) return r.own;
      const f = intent.fixed;
      const n = replayWitnessKeys(f, { inputs }).size;
      const bytes = withWitnesses(T, Y.CSL, r.tx, n, f);
      const t = inspectTx(bytes);
      const fee = t.fee;
      const unpriced = f && f.witnesses[0] !== undefined ? ['observed vkey witnesses'] : [];
      return { ok: true, kind: 'single', txs: [txRecord(bytes, refs, fee, t.size, n)], library: { fee, finalMinFee: minFee(params, t.size, 0n), unpriced } };
    }
  };
}
