// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The JVM baselines, run in one helper process per worker (helpers/jvm,
// built by scripts/build-helpers.mjs jvm) through the bridge
// (methods/helper.mjs), the request naming the library.
//
// ccl-pw: cardano-client-lib 0.7.3 (Maven com.bloxbean.cardano:
// cardano-client-lib, the release tag's commit f113017), its QuickTx builder
// at its defaults, called as a dapp calls it to build a payment for a wallet
// to sign (helpers/jvm/src/main/scala/unfrackit/helper/Ccl.scala, whose
// header has the replay's parts):
//
//   new QuickTxBuilder(utxoSupplier, protocolParamsSupplier, processor)
//     .compose(new Tx().payToAddress(...) per requested output
//                      .from(changeAddress)[, a ScriptTx of fixed parts])
//     .build()
//
// (quicktx/.../QuickTxBuilder.java:80, :140, :299). The UtxoSupplier answers
// the wallet's address with its spendable UTxOs, 100 a page, in the state's
// order (library.mjs inputOrder), as a provider hands them over, so the
// default strategy (DefaultUtxoSelectionStrategyImpl, function/.../
// TxBuilderContext.java:69) reads them page by page: in each page the UTxOs
// holding a requested unit, in the page's order, taken whole until the unit
// is covered (coinselection/.../DefaultUtxoSelectionStrategyImpl.java:41-148),
// then LargestFirstUtxoSelectionStrategy when more than 20 inputs would be
// needed (:141-147, LargestFirstUtxoSelectionStrategy.java:59-142). The fee
// is not in the target: the change output takes everything left, and when
// the fee leaves it under its minimum ChangeOutputAdjustments adds an ADA-only
// UTxO over the shortfall plus 2 ADA (ChangeOutputAdjustments.java:139-245).
// build() writes no witness; the fee prices one vkey witness per distinct key
// of the inputs and collateral (BalanceTxBuilders.java:113-124). It draws
// nothing at random: deterministic, and the state's order is part of its
// outcome through the pages. The collateral of a script spend is the UTxO set
// aside, given by withCollateralInputs (QuickTxBuilder.java:926-955), which
// also keeps it out of the selection.
//
// scalus-pool: Scalus 1.5.0 (Maven org.scalus:scalus-cardano-ledger for Scala 3, the
// release tag's commit 5bf331b), TxBuilder.complete with the wallet's address
// as the sponsor (helpers/jvm/src/main/scala/unfrackit/helper/
// ScalusLib.scala):
//
//   TxBuilder(env, evaluator).output(o) for each requested output
//     ...the replay's fixed parts as the builder's steps...
//     .complete(availableUtxos, sponsor)
//
// (scalus-cardano-ledger/shared/src/main/scala/scalus/cardano/txbuilder/
// TxBuilder.scala:1649). complete keeps the UTxOs at the sponsor address
// (:1670-1673), so the wallet's UTxOs at its other addresses are not
// candidates; it reselects on each balancing shortfall, at most ten rounds
// (:1700-1851): token holders first, in the Map's order, then the smallest
// single ADA cover or else every UTxO from the largest down (UtxoPool.scala:
// 72-139); one change output holds every surplus asset (Change.scala:28-60).
// availableUtxos is a Scala immutable Map, the library's own type: built from
// the state's order, it keeps that order up to four entries and is in the
// hash order of its TransactionInput keys beyond (a HashMap), so the order
// Scalus sees is the hash order for any wallet of five or more UTxOs. That
// hash is the case class's MurmurHash3 over the transaction id's content hash
// (ByteString.scala:29) and the index, so the order is the same in every run
// and on every machine. It draws nothing at random: deterministic. The
// replay's fixed parts, the steps above, and the rest of the call are in
// ScalusLib.scala's header; a part no step writes is not replayable (body
// field 6, a body field outside 3, 4, 5, 8, 9, 14 and 19 to 22, a bootstrap
// witness, and a script input with no datum, which the builder refuses to
// spend, TransactionStepsProcessor.scala:285-288). Its collateral is its own: complete
// selects it from the sponsor's UTxOs whenever a redeemer is present (:1676-
// 1688, UtxoPool.scala:168-240) and has no way to take the UTxO the engine
// would set aside, so the method chooses its own collateral (contract.mjs
// OWN_COLLATERAL_METHODS).
//
// The layout change (opts.changePolicy 'layout'): the library builds its
// transaction exactly as for its own change; the bridge reads the wallet
// inputs and the collateral it selected, drops its change, and builds the
// simulator's layout change on those inputs with that collateral as the
// library wrote it (methods/change.mjs). complete selects and makes change in
// one call, so a build the library refuses fails under both policies.
//
// Witnesses: neither library writes a vkey witness here; the bridge has the
// helper write one synthetic witness per wallet key, then the intent's other
// vkey witnesses as observed, into the transaction in the library's own
// encoding.

import { CLASSES } from '../kit/check.mjs';
import { REPLAY_COVERAGE } from './library.mjs';
import { helperMethod, helperBuild } from './helper.mjs';

export const CCL_VERSION = '0.7.3';
export const CCL_COMMIT = 'f113017';
export const SCALUS_VERSION = '1.5.0';
export const SCALUS_COMMIT = '5bf331b';
const CCL_MODULE = 'com.bloxbean.cardano:cardano-client-lib';
// Scala artifacts carry the Scala binary version after an underscore.
const SCALA_BINARY = '3';
const SCALUS_MODULE = `org.scalus:scalus-cardano-ledger_${SCALA_BINARY}`;

// The JVM's options: a serial collector keeps the helper's resident memory
// small; nothing in it changes a result.
export const JVM_OPTIONS = Object.freeze(['-XX:+UseSerialGC', '-Xss8m']);

// cardano-client-lib's errors (the text after the build: stage):
//   InsufficientBalanceException, "Not enough funds for ..." (coinselection/
//   .../DefaultUtxoSelectionStrategyImpl.java:136-139, LargestFirst...java:
//   111-113)                                                   balance
//   ApiRuntimeException "No utxo found at address ..." (DefaultUtxoSelector.
//   java and InputBuilders.java's selection for a unit no UTxO covers)
//                                                              balance
//   InputsLimitExceededException (the 20-input cap of both strategies,
//   CoinselectionConfig.java:6)                                max-inputs
const CCL_ERRORS = [
  [/^InsufficientBalanceException/, CLASSES.balance],
  [/^ApiRuntimeException: No utxo found at address/, CLASSES.balance],
  [/^InputsLimitExceededException/, CLASSES.maxInputs]
];

const SCALUS_ERRORS = [
  [/^InsufficientAdaException/, CLASSES.balance],
  [/^InsufficientTokensException/, CLASSES.balance],
  [/Max iterations exceeded while trying to balance transaction/, CLASSES.balance],
  [/InsufficientCollateral/, CLASSES.collateral],
  [/TooManyCollateralInputs/, CLASSES.collateral],
  // complete can return a change output holding a negative quantity of an
  // asset when its lovelace meets the minimum (Change.scala:28-60 tests the
  // lovelace only); the helper refuses that transaction with this text.
  [/complete returned output \d+ holding a negative quantity/, CLASSES.balance]
];

const classOf = (table) => (text) => {
  for (const [re, cls] of table) if (re.test(text)) return cls;
  return CLASSES.other;
};
export const classOfCclError = classOf(CCL_ERRORS);
export const classOfScalusError = classOf(SCALUS_ERRORS);

// The helper's build, checked for the libraries' pins.
function jvmBuild(name) {
  const { problem, record } = helperBuild('jvm');
  if (problem) throw new Error(`${name}: ${problem}`);
  for (const [id, version] of [[CCL_MODULE, CCL_VERSION], [SCALUS_MODULE, SCALUS_VERSION]]) {
    const mod = record.modules && record.modules[id];
    if (!mod || mod.version !== version) throw new Error(`${name}: the jvm helper was built with ${mod ? `${id} ${mod.version}` : `no ${id}`}, not ${version}`);
  }
  return record;
}

const jvmProcess = (record) => ({ key: 'jvm', command: process.env.RESEARCH_SIM_JAVA || 'java', args: [...JVM_OPTIONS, '-jar', record.path] });

export function cclMethod(T) {
  const name = 'ccl-pw';
  const record = jvmBuild(name);
  return helperMethod(T, {
    name,
    version: `cardano-client-lib ${CCL_VERSION} (${CCL_COMMIT}) QuickTx, DefaultUtxoSelectionStrategyImpl; helper jvm sha256 ${record.sha256.slice(0, 16)}`,
    deterministic: true,
    seeded: true,
    library: 'ccl',
    coverage: REPLAY_COVERAGE.ccl,
    classify: classOfCclError,
    refused: 'the cardano-client-lib baseline takes its own change or the layout change only',
    process: jvmProcess(record)
  });
}

export function scalusMethod(T) {
  const name = 'scalus-pool';
  const record = jvmBuild(name);
  return helperMethod(T, {
    name,
    version: `Scalus ${SCALUS_VERSION} (${SCALUS_COMMIT}) TxBuilder.complete; helper jvm sha256 ${record.sha256.slice(0, 16)}`,
    deterministic: true,
    seeded: true,
    ownCollateral: true,
    library: 'scalus',
    coverage: REPLAY_COVERAGE.scalus,
    classify: classOfScalusError,
    refused: 'the Scalus baseline takes its own change or the layout change only',
    process: jvmProcess(record)
  });
}
