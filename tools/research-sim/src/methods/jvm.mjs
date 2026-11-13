// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The JVM baselines, run in one helper process per worker (helpers/jvm,
// built by scripts/build-helpers.mjs jvm) through the bridge
// (methods/helper.mjs), the request naming the library.
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
// Witnesses: complete writes no vkey witness here; the bridge has the
// helper write one synthetic witness per wallet key, then the intent's other
// vkey witnesses as observed, into the transaction in the library's own
// encoding.

import { CLASSES } from '../kit/check.mjs';
import { REPLAY_COVERAGE } from './library.mjs';
import { helperMethod, helperBuild } from './helper.mjs';

export const SCALUS_VERSION = '1.5.0';
export const SCALUS_COMMIT = '5bf331b';
// Scala artifacts carry the Scala binary version after an underscore.
const SCALA_BINARY = '3';
const SCALUS_MODULE = `org.scalus:scalus-cardano-ledger_${SCALA_BINARY}`;

// The JVM's options: a serial collector keeps the helper's resident memory
// small; nothing in it changes a result.
export const JVM_OPTIONS = Object.freeze(['-XX:+UseSerialGC', '-Xss8m']);

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
export const classOfScalusError = classOf(SCALUS_ERRORS);

// The helper's build, checked for the libraries' pins.
function jvmBuild(name) {
  const { problem, record } = helperBuild('jvm');
  if (problem) throw new Error(`${name}: ${problem}`);
  for (const [id, version] of [[SCALUS_MODULE, SCALUS_VERSION]]) {
    const mod = record.modules && record.modules[id];
    if (!mod || mod.version !== version) throw new Error(`${name}: the jvm helper was built with ${mod ? `${id} ${mod.version}` : `no ${id}`}, not ${version}`);
  }
  return record;
}

const jvmProcess = (record) => ({ key: 'jvm', command: process.env.RESEARCH_SIM_JAVA || 'java', args: [...JVM_OPTIONS, '-jar', record.path] });

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
