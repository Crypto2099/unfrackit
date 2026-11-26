// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Lace's transaction builder as a study library, lace-rrri: the wallet's
// TransactionBuilder from @lace-contract/cardano-context, a private package of
// input-output-hk/lace at 4d553bd (the lace-extension 2.5.1 release), which no
// registry publishes. scripts/build-lace.mjs bundles its tx-builder and
// input-selection directories and the three modules they import from a clone
// at that commit, each checked against its git object hash
// (methods/lace-source.mjs), into the gitignored build/wallets/lace; this
// module refuses to load a missing build or one whose record differs from the
// pins (loadLace). Paths below are under packages/contract/cardano-context/src/
// at that commit.
//
// The call, as the extension's send flow makes it (packages/module/
// blockchain-cardano/src/tx-executor-implementation/build-tx.ts:201-232):
// new TransactionBuilder(networkMagic, protocolParameters), setChangeAddress,
// expiresIn(7200), setUnspentOutputs with the wallet's spendable UTxOs in the
// state's order (inputOrder), one output per requested output, build(). The
// coin selector is the builder's own default, RoundRobinRandomCoinSelector
// (tx-builder/TransactionBuilder.ts:157), constructed with a seed through
// useCoinSelector (:242-245) so that its draws can be repeated; the seed is
// the selector's only option the call sets, its strategy staying 'optimal'
// (input-selection/RoundRobinRandomCoinSelector.ts:72-78). The builder keeps
// its LargeFirstCoinSelector fallback for any selector that is not
// Large-First (:878-892).
//
// The library, at that commit:
//   build() (TransactionBuilder.ts:764-906) requires a UTxO and a change
//   address, applies the parts set on the builder and calls
//   balanceTransaction (tx-builder/balancing.ts:383-406), which runs the
//   balancing loop with the selector and, on an InputSelectionError or an
//   exhausted loop, once more with LargeFirstCoinSelector.
//   runBalancingLoop (balancing.ts:211-333): at most 20 rounds; each puts the
//   current fee (and a donation and the implicit coin) into the target
//   (:236-257), calls the selector, forces one ADA-only UTxO when the
//   selection is empty (:272-290), checks every change output against its
//   minimum (:294, :175-190), and prices the transaction as tx-construction's
//   minFee of its serialization plus 101 bytes per unique signer and the
//   witness set's framing (:296-310, :152-161), until the fee stops growing and
//   the transaction balances (:312-325).
//   RoundRobinRandomCoinSelector.select (:86-120): a SplitMix64 generator
//   re-seeded from the selector's seed on every call (round-robin-random/
//   rng.ts:23-56), so the balancing rounds see the same draws; a selection
//   index with one requirement per positive target asset in the target's
//   order and lovelace last (round-robin-random/selection-index.ts:84-94), each
//   drawing at random from the UTxOs holding it, those with one asset (ADA
//   only) first, then two, then any (:96-108, :151-172); the round robin with
//   the improvement rule toward twice each minimum (round-robin.ts:110-154);
//   change built per payment output with min-ADA, value-size splits by
//   halving, and an extra lovelace UTxO drawn while the change cannot be
//   funded (round-robin-random/change.ts:191-332).
//   The draws: rng.below(n) is the next 64-bit output modulo n (rng.ts:53-55),
//   an index into the requirement's bucket, whose order is the pool's: the
//   pre-selected UTxOs, then setUnspentOutputs's list less those
//   (RoundRobinRandomCoinSelector.ts:96-101). The state's order decides which
//   UTxO a draw names; ties as such do not arise.
//
// The seed (setting rng 'mulberry32', through the selector's seed): the seed
// is a 64-bit bigint the selector takes (RoundRobinRandomCoinSelector.ts:29,
// :73). In a replay it is two draws of the job's one generator (opts.random,
// replay/engine.mjs jobOptions), the high and low 32 bits, taken once per
// build; without opts.random (a battery run), the same from a fresh
// mulberry32 generator seeded with opts.seed. The selector's default seed, from
// platform entropy (rng.ts:65-74), is never used.
//
// The TTL: expiresIn(7200) reads the wall clock (TransactionBuilder.ts:
// 406-418, common/time.ts:72-81). It is called with Date.now fixed, for the
// call, at the spend's own slot as Lace's slot configuration of the network
// counts it, so the transaction's TTL is the spend's slot plus 7200 and does
// not depend on when the simulator runs. A replayed intent with its own
// validity interval keeps it (setValidityInterval, below), which build()
// writes over the TTL (:813-824).
//
// Witnesses (setting serialization 'own'): build() returns the transaction
// with an empty vkey set; the adapter writes one synthetic vkey witness per
// wallet key (kit/replay.mjs replayWitnessKeys) into the library's witness
// set, then the intent's other vkey witnesses as observed.
//
// Errors to failure classes (setting unclassified 'other' for the rest):
//   InputSelectionError BalanceInsufficient (input-selection/
//   InputSelectionError.ts:4-16), also as the fallback's wrapped failure
//   (balancing.ts:354-363)                                       balance
//   InputSelectionError UtxoFullyDepleted                        change-minimum
//   "Change output is below the minimum UTxO value: ..." (balancing.ts:
//   175-190)                                                     change-minimum
//   "No available UTXOs to select from" (TransactionBuilder.ts:765-770)
//                                                                balance
//   InsufficientCollateralError (TransactionBuilder.ts:129-134, :1259-1362)
//                                                                collateral
//   EvaluatedFeeShortfallError (balancing.ts:49-62), the evaluated execution
//   units needing more fee than balancing funded               fee-minimum
// "Failed to balance transaction" (the 20 rounds exhausted, :327-329) and its
// fallback form, and any other error, are class other with the message. The
// builder checks no transaction size, so an oversized transaction is the
// kit's tx-size.
//
// The replay path: every intent is a replayed one (source 'replay'). The run's
// parameters are the library's (laceParams), and the intent's parts reach the
// builder through its own operations, before build():
//   requested outputs   addOutput with each output as @cardano-sdk/core reads
//                       its bytes (TransactionBuilder.ts:385-397), the
//                       operation transferValue ends in (:440-449), so a
//                       datum and a script reference pass through; the
//                       library re-encodes it
//   fixed inputs        addInput with the input's spend redeemer and, for a
//                       datum hash, its datum (:306-354); never in the
//                       wallet's UTxOs
//   reference inputs    addReferenceInput (:363-383)
//   mint and burn       mintAssets with each policy's redeemer (:473-484),
//                       when every minted policy has one
//   certificates        the operation that writes the same certificate:
//                       addStakeDelegationCertificate (kind 2),
//                       addNewStakeAddressCertificate (7),
//                       addStakeDeregistrationCertificate (8),
//                       addVoteDelegationCertificate (9),
//                       addStakeRegistrationDelegationCertificate (11),
//                       addVoteRegistrationDelegationCertificate (12), in the
//                       intent's order, kinds 2 and 7 with their redeemer
//                       (:574-704); the library's balance counts their
//                       deposits and refunds through @cardano-sdk/core's
//                       computeImplicitCoin (balancing.ts:223-226)
//   withdrawals         addRewardsWithdrawal, or addScriptWithdrawal with the
//                       account's redeemer (:706-743)
//   required signers    addRequiredSigner (:491-497)
//   validity            setValidityInterval (:426-432)
//   metadata            setMetadata per label (:550-566), from the intent's
//                       auxiliary data as @cardano-sdk/core reads it; the
//                       library re-encodes it and writes its hash (:1010-1019)
//   scripts             attachScript for each native and Plutus script of the
//                       witness set (:456-462)
//   collateral          the UTxO the engine set aside, as the builder's only
//                       collateral candidate (setCollateralUtxos,
//                       setCollateralChangeAddress at the change address,
//                       :512-529); the builder reserves it for a Plutus
//                       transaction against its own coverage target
//                       (:1224-1257) and writes its total and return
//   execution units     setPlutusContext (:286-289) with no execution-units
//                       estimate, the context's one optional field, so the
//                       library prices balancing at the per-transaction
//                       maximum (:92-95) and lowers the fee after evaluation
//                       (balancing.ts:435-583); the evaluator returns the
//                       intent's observed units for each redeemer at the target
//                       the library's index names (laceEvaluator), the input
//                       resolver answers from the state and the intent, and
//                       the cost models are empty lists, as the run holds none:
//                       they reach only the script data hash's value, never its
//                       size (script-data-hash.ts)
// A part no operation writes is written on the transaction build() returned,
// through @cardano-sdk/core's types, as every library's replay does
// (afterParts): the certificates, all of them in the intent's order, when one
// has no operation above; the mint, when a minted policy has no redeemer (a
// native script's); votes; proposals; the current treasury value; a
// donation; auxiliary data that metadata alone cannot hold (scripts, or none
// at all) with its hash; the witness set's datums no fixed input names; and
// bootstrap witnesses. The library neither prices nor balances such a part;
// the kit's checks say which (library.unpriced names the parts). When the
// transaction then carries more vkey witnesses than the library priced (its
// own count of unique signers, getUniqueSignerKeyHashes), library.unpriced
// names the observed ones.
// Not replayable (laceRefusal): body field 6, as for every adapter
// (kit/replay.mjs replayRefusal); a redeemer the library cannot attach, which
// is any vote or proposal redeemer, a certificate redeemer on a kind other
// than 2 and 7 or on certificates written after the build, and a mint
// redeemer on a mint written after the build.
//
// The layout change (opts.changePolicy 'layout'): the library builds its
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
import { replayRefusal, listItems, requiredSigners, replayWitnessKeys, redeemerKey, targetKey, syntheticVkeys } from '../kit/replay.mjs';
import { minFee } from '../kit/fee.mjs';
import { decode, asUint, asBytes, encArray, encUint } from '../history/cbor.mjs';
import { blake2b256 } from '../history/blake2b.mjs';
import { makeRng } from '../shapes/rng.mjs';
import { NOT_REPLAYABLE } from './contract.mjs';
import { buildWithChange } from './change.mjs';
import { inputOrder, recordsOf, refuseUncovered, REPLAY_COVERAGE, errorText, txRecord } from './library.mjs';
import { LACE_COMMIT, LACE_REPO, LACE_PATHS, LACE_SDK, OUTPUT_DIR, BUNDLE, BUILD_RECORD, BUILD_SCRIPT } from './lace-source.mjs';

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const requireTool = createRequire(import.meta.url);
const hexOf = (b) => Buffer.from(b).toString('hex');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// Why the build cannot be loaded, or null when it can.
export function laceBuildProblem() {
  const hint = `run node ${BUILD_SCRIPT} --clone <a clone of ${LACE_REPO}> (or --fetch <a new directory>) in ${TOOL}`;
  const dir = join(TOOL, OUTPUT_DIR);
  const recFile = join(dir, BUILD_RECORD);
  if (!existsSync(recFile)) return `the build of Lace's source is missing (${join(OUTPUT_DIR, BUILD_RECORD)}); ${hint}`;
  let rec;
  try {
    rec = JSON.parse(readFileSync(recFile, 'utf8'));
  } catch (e) {
    return `the build record ${join(OUTPUT_DIR, BUILD_RECORD)} cannot be read (${e.message}); ${hint}`;
  }
  const differs = [];
  if (rec.commit !== LACE_COMMIT) differs.push(`commit ${rec.commit}`);
  const paths = rec.paths || {};
  if (Object.keys(paths).length !== Object.keys(LACE_PATHS).length) differs.push('the list of paths');
  for (const [p, [type, hash]] of Object.entries(LACE_PATHS)) if (!paths[p] || paths[p].type !== type || paths[p].hash !== hash) differs.push(p);
  for (const [pkg, v] of Object.entries(LACE_SDK)) {
    if (!rec.sdk || rec.sdk[pkg] !== v) differs.push(`${pkg} in the record`);
    const installed = JSON.parse(readFileSync(join(TOOL, 'node_modules', ...pkg.split('/'), 'package.json'), 'utf8')).version;
    if (installed !== v) differs.push(`${pkg} ${installed} installed, ${v} pinned`);
  }
  const bundle = join(dir, BUNDLE);
  if (!existsSync(bundle) || !rec.bundle || sha256(bundle) !== rec.bundle.sha256) differs.push('the bundle\'s SHA-256');
  if (differs.length) return `the build of Lace's source differs from the pins (${differs.join('; ')}); ${hint}`;
  return null;
}

let LOADED = null;
// The bundle and the @cardano-sdk/core instance it loads (CommonJS: the
// package's ESM build would be another instance).
export function loadLace() {
  if (LOADED) return LOADED;
  const problem = laceBuildProblem();
  if (problem) throw new Error(`lace: ${problem}`);
  const lib = requireTool(join(TOOL, OUTPUT_DIR, BUNDLE));
  const core = requireTool('@cardano-sdk/core');
  LOADED = Object.freeze({ lib, Cardano: core.Cardano, Serialization: core.Serialization });
  return LOADED;
}

export function classOfLaceError(L, e) {
  const m = errorText(e);
  if (e instanceof L.lib.InputSelectionError) {
    if (e.failure === L.lib.InputSelectionFailure.BalanceInsufficient) return CLASSES.balance;
    if (e.failure === L.lib.InputSelectionFailure.UtxoFullyDepleted) return CLASSES.changeMinimum;
  }
  if (e instanceof L.lib.InsufficientCollateralError) return CLASSES.collateral;
  if (e instanceof L.lib.EvaluatedFeeShortfallError) return CLASSES.feeMinimum;
  if (/^Change output is below the minimum UTxO value/.test(m)) return CLASSES.changeMinimum;
  if (/^No available UTXOs to select from/.test(m)) return CLASSES.balance;
  return CLASSES.other;
}

// The network magic Lace's builder takes; the synthetic shapes carry mainnet
// addresses.
const magicOf = (L, network) => (network === 'preprod' ? L.Cardano.NetworkMagics.Preprod : L.Cardano.NetworkMagics.Mainnet);

const ratio = (r) => (r === null || r === undefined ? undefined : Number(r[0]) / Number(r[1]));
const orUndefined = (x) => (x === null || x === undefined ? undefined : Number(x));

// The run's parameters as the library's RequiredProtocolParameters
// (src/types.ts:614-632), numbers as @cardano-sdk/core's ProtocolParameters
// hold them. A parameter the run does not state is left undefined.
export function laceParams(params) {
  return {
    coinsPerUtxoByte: Number(params.coinsPerUtxoByte),
    collateralPercentage: params.collateralPercent,
    maxCollateralInputs: params.maxCollateralInputs,
    maxTxSize: params.maxTxSize,
    maxValueSize: params.maxValSize,
    minFeeCoefficient: Number(params.minFeeA),
    minFeeConstant: Number(params.minFeeB),
    minFeeRefScriptCostPerByte: ratio(params.minFeeRefScriptCostPerByte),
    poolDeposit: orUndefined(params.poolDeposit),
    stakeKeyDeposit: orUndefined(params.keyDeposit),
    dRepDeposit: orUndefined(params.drepDeposit),
    prices: { memory: ratio(params.priceMem) ?? 0, steps: ratio(params.priceStep) ?? 0 }
  };
}

// A UTxO as the library's Cardano.Utxo, from its TransactionUnspentOutput
// bytes (a state's UTxO, or a fixed or reference input of the intent).
export function laceUtxo(L, cbor) {
  const [txIn, txOut] = L.Serialization.TransactionUnspentOutput.fromCbor(cbor).toCore();
  return [{ txId: txIn.txId, index: txIn.index, address: txOut.address }, txOut];
}
const refOfIn = (i) => `${i.txId}#${i.index}`;

// The seed of one build: two draws of the job's generator, or of a fresh one
// seeded with opts.seed.
export function laceSeed(opts, name) {
  let random = opts.random;
  if (!random) {
    if (!Number.isSafeInteger(opts.seed)) throw new Error(`${name}: a seed is required`);
    const rng = makeRng(opts.seed);
    random = () => rng.next();
  }
  const word = () => BigInt(Math.floor(random() * 0x100000000));
  return (word() << 32n) | word();
}

// ---- The intent's parts.

const certKinds = (f) => (f && f.body[4] !== undefined ? listItems(f.body[4]).map((b) => Number(asUint(decode(b).items[0], 'certificate kind'))) : []);
const OPERATION_KINDS = new Set([2, 7, 8, 9, 11, 12]);
const SCRIPT_KINDS = new Set([2, 7]);
const certificatesAfter = (f) => certKinds(f).some((k) => !OPERATION_KINDS.has(k));

// The intent's minted policies (positive or negative), sorted.
const mintPolicies = (intent) => [...new Set([...intent.implicit.mint, ...intent.implicit.burn].map((a) => a.policy))].sort();
const hasRedeemer = (f, target) => f.redeemers.some((r) => redeemerKey(r) === targetKey(target));
const mintAfter = (intent) => {
  const f = intent.fixed;
  if (!f || f.body[9] === undefined) return false;
  return mintPolicies(intent).some((policy) => !hasRedeemer(f, { kind: 'policy', policy }));
};

// Why the library cannot write the intent, or null when it can.
export function laceRefusal(intent) {
  const kit = replayRefusal(intent);
  if (kit) return kit;
  const f = intent.fixed;
  if (!f) return null;
  if (f.redeemers.some((r) => r.tag === 4)) return 'a vote redeemer: the builder has no operation that writes votes, so none can carry a redeemer';
  if (f.redeemers.some((r) => r.tag === 5)) return 'a proposal redeemer: the builder has no operation that writes proposals, so none can carry a redeemer';
  const kinds = certKinds(f);
  const after = certificatesAfter(f);
  for (const r of f.redeemers.filter((x) => x.tag === 2)) {
    if (after) return 'a certificate redeemer on certificates written after the build, where the library cannot attach it';
    if (!SCRIPT_KINDS.has(kinds[r.target.index])) return `a redeemer on a kind ${kinds[r.target.index]} certificate, whose operation takes none (only kinds 2 and 7 take one)`;
  }
  if (mintAfter(intent) && f.redeemers.some((r) => r.tag === 1)) return 'a mint redeemer on a mint written after the build, since another minted policy has no redeemer';
  return null;
}

// The auxiliary data as metadata labels when it is that alone, else null.
function metadataOnly(L, auxHex) {
  const core = L.Serialization.AuxiliaryData.fromCbor(auxHex).toCore();
  if (core.scripts && core.scripts.length) return null;
  if (!core.blob || core.blob.size === 0) return null;
  return core.blob;
}

// The parts no operation writes, written on the built transaction.
export function afterParts(L, intent) {
  const f = intent.fixed;
  if (!f) return [];
  const out = [];
  if (f.body[4] !== undefined && certificatesAfter(f)) out.push('certificates');
  if (mintAfter(intent)) out.push('mint');
  if (f.body[15] !== undefined) out.push('network id');
  if (f.body[19] !== undefined) out.push('votes');
  if (f.body[20] !== undefined) out.push('proposals');
  if (f.body[21] !== undefined) out.push('current treasury value');
  if (f.body[22] !== undefined) out.push('donation');
  if (f.auxiliaryData && !metadataOnly(L, f.auxiliaryData)) out.push('auxiliary data');
  if (looseDatums(f).length) out.push('datums');
  if (f.witnesses[2] !== undefined) out.push('bootstrap witnesses');
  return out;
}

// The redeemer the intent gives a target, or undefined.
function redeemerFinder(L, f) {
  const byKey = new Map();
  for (const r of f ? f.redeemers : []) if (!byKey.has(redeemerKey(r))) byKey.set(redeemerKey(r), r);
  const data = (target) => {
    const r = byKey.get(targetKey(target));
    return r ? L.Serialization.PlutusData.fromCbor(r.data).toCore() : undefined;
  };
  return { byKey, data };
}

// The witness set's scripts as the library's Script: native (key 1) and Plutus
// V1 to V3 (keys 3, 6, 7), each from its observed bytes.
const SCRIPT_KEYS = [[1, 0], [3, 1], [6, 2], [7, 3]];
function witnessScripts(L, f) {
  const out = [];
  for (const [key, lang] of SCRIPT_KEYS) {
    if (f.witnesses[key] === undefined) continue;
    for (const raw of listItems(f.witnesses[key])) out.push(L.Serialization.Script.fromCbor(hexOf(encArray([encUint(lang), raw]))).toCore());
  }
  return out;
}

// The witness set's datums (key 4): those a spent script input names by hash
// (addInput's datum), by input, and the rest.
function intentDatums(f) {
  const out = { byInput: new Map(), rest: [] };
  if (f.witnesses[4] === undefined) return out;
  const items = listItems(f.witnesses[4]).map((bytes) => ({ hash: hexOf(blake2b256(bytes)), bytes, used: false }));
  const byHash = new Map();
  for (const d of items) if (!byHash.has(d.hash)) byHash.set(d.hash, d);
  const spent = new Set(f.redeemers.filter((r) => r.tag === 0).map((r) => r.target.ref));
  for (const x of f.inputs) {
    const p = unspentOutputParts(x.cbor);
    if (!p.datum || p.datum.kind !== 'hash' || !spent.has(x.ref)) continue;
    const d = byHash.get(p.datum.hash);
    if (!d) continue;
    d.used = true;
    out.byInput.set(x.ref, d.bytes);
  }
  out.rest = items.filter((d) => !d.used).map((d) => d.bytes);
  return out;
}
const looseDatums = (f) => intentDatums(f).rest;

// The certificate's operation on builder b.
function withCertificate(L, b, hexCert, redeemer) {
  const c = L.Serialization.Certificate.fromCbor(hexCert).toCore();
  const T = L.Cardano.CertificateType;
  const script = redeemer ? { redeemer } : undefined;
  switch (c.__typename) {
    case T.StakeDelegation:
      return b.addStakeDelegationCertificate(c.poolId, c.stakeCredential, script);
    case T.Registration:
      return b.addNewStakeAddressCertificate(c.stakeCredential, c.deposit, script);
    case T.Unregistration:
      return b.addStakeDeregistrationCertificate(c.stakeCredential, c.deposit);
    case T.VoteDelegation:
      return b.addVoteDelegationCertificate(c.stakeCredential, c.dRep);
    case T.StakeRegistrationDelegation:
      return b.addStakeRegistrationDelegationCertificate(c.poolId, c.stakeCredential, c.deposit);
    case T.VoteRegistrationDelegation:
      return b.addVoteRegistrationDelegationCertificate(c.dRep, c.stakeCredential, c.deposit);
    default:
      throw new Error(`certificate ${c.__typename}: no operation`);
  }
}

// The reward account's bytes (hex) from its bech32.
const accountHex = (L, acct) => hexOf(Buffer.from(L.Cardano.Address.fromBech32(acct).toBytes(), 'hex'));

// The intent's fixed parts through the builder's operations. Returns whether
// the transaction runs Plutus scripts the library must evaluate.
function withFixedParts(L, b, intent) {
  const f = intent.fixed;
  const red = redeemerFinder(L, f);
  for (const s of witnessScripts(L, f)) b.attachScript(s);
  for (const x of f.referenceInputs) b.addReferenceInput(laceUtxo(L, x.cbor));
  const datums = intentDatums(f);
  for (const x of f.inputs) {
    const redeemer = red.data({ kind: 'input', ref: x.ref });
    const datum = datums.byInput.get(x.ref);
    b.addInput(laceUtxo(L, x.cbor), redeemer ? { redeemer, ...(datum ? { datum: L.Serialization.PlutusData.fromCbor(hexOf(datum)).toCore() } : {}) } : undefined);
  }
  if (f.body[9] !== undefined && !mintAfter(intent)) {
    for (const policy of mintPolicies(intent)) {
      const assets = new Map();
      for (const a of intent.implicit.mint) if (a.policy === policy) assets.set(`${a.policy}${a.name}`, BigInt(a.qty));
      for (const a of intent.implicit.burn) if (a.policy === policy) assets.set(`${a.policy}${a.name}`, (assets.get(`${a.policy}${a.name}`) || 0n) - BigInt(a.qty));
      b.mintAssets(assets, red.data({ kind: 'policy', policy }));
    }
  }
  if (f.body[4] !== undefined && !certificatesAfter(f)) listItems(f.body[4]).forEach((bytes, i) => withCertificate(L, b, hexOf(bytes), red.data({ kind: 'certificate', index: i })));
  if (f.body[5] !== undefined) {
    const n = decode(Buffer.from(f.body[5], 'hex'));
    for (const [k, v] of n.entries) {
      const account = hexOf(asBytes(k, 'reward account'));
      const acct = L.Cardano.Address.fromBytes(account).toBech32();
      const redeemer = red.data({ kind: 'withdrawal', account });
      if (redeemer) b.addScriptWithdrawal(acct, asUint(v, 'withdrawal'), redeemer);
      else b.addRewardsWithdrawal(acct, asUint(v, 'withdrawal'));
    }
  }
  for (const h of requiredSigners(f)) b.addRequiredSigner(h);
  const slot = (k) => Number(asUint(decode(Buffer.from(f.body[k], 'hex')), 'slot'));
  if (f.body[3] !== undefined || f.body[8] !== undefined) {
    b.setValidityInterval({ ...(f.body[8] !== undefined ? { invalidBefore: slot(8) } : {}), ...(f.body[3] !== undefined ? { invalidHereafter: slot(3) } : {}) });
  }
  if (f.auxiliaryData) {
    const blob = metadataOnly(L, f.auxiliaryData);
    if (blob) for (const [label, metadatum] of blob) b.setMetadata(label, metadatum);
  }
  return f.redeemers.length > 0;
}

// The evaluator (tx-construction's TxEvaluator): each redeemer of the
// library's draft with the intent's observed execution units, found by the
// target the library's index names (TransactionBuilder.ts:1101-1179): a spend
// by its input's place among the inputs sorted by transaction id
// (localeCompare) and index, a mint by its policy among the sorted policies,
// a certificate by its place in the list, a withdrawal by its account among
// the redeemed accounts sorted by credential hash. A redeemer with no
// observed counterpart fails the build.
export function laceEvaluator(L, intent) {
  const f = intent.fixed;
  const red = redeemerFinder(L, f);
  const cmpHex = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
  return {
    evaluate: async (tx) => {
      const ins = [...tx.body.inputs].sort((a, b) => {
        const c = a.txId.localeCompare(b.txId);
        return c === 0 ? a.index - b.index : c;
      });
      const policies = [...new Set([...(tx.body.mint ? tx.body.mint.keys() : [])].map((id) => L.Cardano.AssetId.getPolicyId(id)))].sort(cmpHex);
      const redeemed = new Set(f.redeemers.filter((r) => r.tag === 3).map((r) => r.target.account));
      const accounts = (tx.body.withdrawals || []).map((w) => accountHex(L, w.stakeAddress)).filter((a) => redeemed.has(a)).sort((a, b) => cmpHex(a.slice(2), b.slice(2)));
      return (tx.witness.redeemers || []).map((r) => {
        let target;
        if (r.purpose === 'spend') target = ins[r.index] && { kind: 'input', ref: refOfIn(ins[r.index]) };
        else if (r.purpose === 'mint') target = policies[r.index] && { kind: 'policy', policy: policies[r.index] };
        else if (r.purpose === 'certificate') target = { kind: 'certificate', index: r.index };
        else if (r.purpose === 'withdrawal') target = accounts[r.index] && { kind: 'withdrawal', account: accounts[r.index] };
        const o = target && red.byKey.get(targetKey(target));
        if (!o) throw new Error(`the library's redeemer ${r.purpose}:${r.index} has no observed redeemer`);
        return { purpose: r.purpose, index: r.index, budget: { memory: Number(o.exUnits[0]), steps: Number(o.exUnits[1]) } };
      });
    }
  };
}

// The input resolver of the Plutus context: the state's UTxOs, the intent's
// fixed and reference inputs and the collateral set aside.
function laceResolver(L, state, intent, collateral) {
  const cbors = new Map();
  for (const u of state.utxos.values()) cbors.set(u.ref, u.cbor);
  if (intent.fixed) for (const x of [...intent.fixed.inputs, ...intent.fixed.referenceInputs]) cbors.set(x.ref, x.cbor);
  if (collateral) cbors.set(collateral.ref, collateral.cbor);
  return { resolveInput: async (txIn) => (cbors.has(refOfIn(txIn)) ? laceUtxo(L, cbors.get(refOfIn(txIn)))[1] : null) };
}

// The part written after the build, on transaction tx (Serialization).
function writeAfter(L, tx, intent, parts) {
  const f = intent.fixed;
  const S = L.Serialization;
  const body = tx.body();
  const has = (p) => parts.includes(p);
  if (has('certificates')) body.setCerts(S.CborSet.fromCbor(f.body[4], S.Certificate.fromCbor));
  if (has('mint')) {
    const m = new Map();
    for (const a of intent.implicit.mint) m.set(`${a.policy}${a.name}`, BigInt(a.qty));
    for (const a of intent.implicit.burn) m.set(`${a.policy}${a.name}`, (m.get(`${a.policy}${a.name}`) || 0n) - BigInt(a.qty));
    body.setMint(m);
  }
  if (has('network id')) body.setNetworkId(Number(asUint(decode(Buffer.from(f.body[15], 'hex')), 'network id')));
  if (has('votes')) body.setVotingProcedures(S.VotingProcedures.fromCbor(f.body[19]));
  if (has('proposals')) body.setProposalProcedures(S.CborSet.fromCbor(f.body[20], S.ProposalProcedure.fromCbor));
  if (has('current treasury value')) body.setCurrentTreasuryValue(asUint(decode(Buffer.from(f.body[21], 'hex')), 'treasury value'));
  if (has('donation')) body.setDonation(asUint(decode(Buffer.from(f.body[22], 'hex')), 'donation'));
  if (has('auxiliary data')) {
    tx.setAuxiliaryData(S.AuxiliaryData.fromCbor(f.auxiliaryData));
    body.setAuxiliaryDataHash(hexOf(blake2b256(Buffer.from(f.auxiliaryData, 'hex'))));
  }
  tx.setBody(body);
  const ws = tx.witnessSet();
  if (has('datums')) {
    const kept = ws.plutusData() ? [...ws.plutusData().values()] : [];
    const set = S.CborSet.fromCore([], S.PlutusData.fromCore);
    set.setValues([...kept, ...looseDatums(f).map((d) => S.PlutusData.fromCbor(hexOf(d)))]);
    ws.setPlutusData(set);
  }
  if (has('bootstrap witnesses')) ws.setBootstraps(S.CborSet.fromCbor(f.witnesses[2], S.BootstrapWitness.fromCbor));
  tx.setWitnessSet(ws);
}

// Builds the intent with the library: { ok, tx (Serialization), selected
// refs, ... } or a failure.
export async function buildLace(T, state, intent, params, opts, { name = 'lace-rrri' } = {}) {
  const L = loadLace();
  const layout = opts.changePolicy === 'layout';
  if (opts.changePolicy !== 'default' && !layout) return { ok: false, class: CLASSES.other, detail: 'Lace\'s builder takes its own change or the layout change only' };
  if (intent.source !== 'replay') throw new Error(`${name}: builds replayed intents only`);
  const refusal = laceRefusal(intent);
  if (refusal) return { ok: false, class: NOT_REPLAYABLE, detail: refusal };
  const f = intent.fixed;
  const collateral = opts.collateral || null;
  if (intent.collateral && intent.collateral.required && !collateral) throw new Error(`${name}: a script spend needs the collateral the engine sets aside`);
  const fixedRefs = new Set(f ? f.inputs.map((x) => x.ref) : []);
  const pool = inputOrder(state).filter((u) => !fixedRefs.has(u.ref));
  const after = afterParts(L, intent);
  const seed = laceSeed(opts, name);
  const magic = magicOf(L, state.network);
  let b;
  try {
    b = new L.lib.TransactionBuilder(magic, laceParams(params));
    b.setChangeAddress(state.changeAddress);
    // expiresIn(7200) at the spend's own slot (see the header).
    const cfg = L.lib.SLOT_CONFIG_NETWORK[magic];
    const at = cfg.zeroTime + (intent.time.slot - cfg.zeroSlot) * cfg.slotLength;
    const now = Date.now;
    Date.now = () => at;
    try {
      b.expiresIn(7200);
    } finally {
      Date.now = now;
    }
    b.setUnspentOutputs(pool.map((u) => laceUtxo(L, u.cbor)));
    b.useCoinSelector(new L.lib.RoundRobinRandomCoinSelector({ seed }));
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: CLASSES.other, detail: `builder: ${errorText(e)}` };
  }
  for (const o of intent.requested) {
    try {
      b.addOutput(L.Serialization.TransactionOutput.fromCbor(o.cbor).toCore());
    } catch (e) {
      passMachineErrors(e);
      return { ok: false, class: CLASSES.other, detail: `requested output: ${errorText(e)}` };
    }
  }
  try {
    const plutus = f ? withFixedParts(L, b, intent) : false;
    if (collateral) b.setCollateralUtxos([laceUtxo(L, collateral.cbor)]).setCollateralChangeAddress(state.changeAddress);
    if (plutus) b.setPlutusContext({ costModels: new Map([[0, []], [1, []], [2, []]]), txEvaluator: laceEvaluator(L, intent), inputResolver: laceResolver(L, state, intent, collateral) });
  } catch (e) {
    passMachineErrors(e);
    return { ok: false, class: CLASSES.other, detail: `replay parts: ${errorText(e)}` };
  }
  let tx;
  try {
    tx = await b.build();
  } catch (e) {
    passMachineErrors(e);
    // A part the library was not given (afterParts) can be what fails the
    // build, as a mint under a native script does: named, as the engine
    // names it for a failed check (replay/engine.mjs unpricedText).
    return { ok: false, class: classOfLaceError(L, e), detail: `build: ${errorText(e)}${after.length ? `; parts the library did not price: ${after.join(', ')}` : ''}` };
  }
  const refs = [...tx.body().inputs().values()].map((i) => `${i.transactionId()}#${Number(i.index())}`);
  for (const x of fixedRefs) if (!refs.includes(x)) return { ok: false, class: CLASSES.other, detail: `the library left out the fixed input ${x}` };
  const walletRefs = refs.filter((x) => !fixedRefs.has(x));
  const inputs = recordsOf(state, walletRefs);
  if (layout) {
    const r = buildWithChange(T, { state, params, inputs, intent, policy: 'layout', collateral });
    if (!r.ok) return { ok: false, class: r.class, detail: `layout change on the library's inputs: ${r.detail}` };
    return { ok: true, kind: 'single', txs: [txRecord(r.bytes, walletRefs, r.fee, r.size, r.k)], library: { seed: seed.toString() } };
  }
  // The keys the library priced a vkey witness for (balancing.ts:296-305),
  // counted on its own transaction before anything is written after it.
  const coreTx = tx.toCore();
  const resolved = [...inputs.map((u) => laceUtxo(L, u.cbor)), ...(f ? f.inputs.map((x) => laceUtxo(L, x.cbor)) : []), ...(collateral ? [laceUtxo(L, collateral.cbor)] : [])];
  const priced = L.lib.getUniqueSignerKeyHashes(coreTx, resolved).size;
  if (after.length) writeAfter(L, tx, intent, after);
  // The vkey witnesses: the wallet's keys, synthetic, then the intent's
  // other vkey witnesses as observed.
  const keys = replayWitnessKeys(f, { inputs, collateral: collateral && coreTx.body.collaterals && coreTx.body.collaterals.length ? [collateral] : [] });
  const others = f && f.witnesses[0] !== undefined ? listItems(f.witnesses[0]) : [];
  const S = L.Serialization;
  const vkeys = [...syntheticVkeys(T, keys.size), ...others].map((x) => S.VkeyWitness.fromCbor(hexOf(x)));
  const ws = tx.witnessSet();
  const set = S.CborSet.fromCore([], S.VkeyWitness.fromCore);
  set.setValues(vkeys);
  ws.setVkeys(set);
  tx.setWitnessSet(ws);
  const bytes = tx.toCbor();
  const size = inspectTx(bytes).size;
  const fee = tx.body().fee();
  const unpriced = others.length > 0 && vkeys.length > priced ? [...after, 'observed vkey witnesses'] : after;
  return {
    ok: true,
    kind: 'single',
    txs: [txRecord(bytes, walletRefs, fee, size, keys.size)],
    library: { seed: seed.toString(), fee, finalMinFee: minFee(params, size, f ? f.scriptFee : 0n), priced, unpriced }
  };
}

export function laceMethod(T) {
  const name = 'lace-rrri';
  loadLace();
  return {
    name,
    version: `lace ${LACE_COMMIT.slice(0, 7)} (lace-extension 2.5.1) @lace-contract/cardano-context TransactionBuilder with RoundRobinRandomCoinSelector`,
    deterministic: false,
    // Its draws come from the selector's seed, two draws of opts.random or of
    // a generator seeded with opts.seed.
    seeded: true,
    async build(state, intent, params, opts) {
      refuseUncovered(name, REPLAY_COVERAGE.lace, intent);
      return buildLace(T, state, intent, params, opts, { name });
    }
  };
}
