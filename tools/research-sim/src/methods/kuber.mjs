// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Kuber baseline, kuber-prune: Kuber 4.2.0 (dQuadrant/kuber at the
// release tag's commit 2c559089e394ea7bc8a9bbde968bcdfb2ef7fac5), run in the
// kuber helper (helpers/kuber, a Haskell program built by
// scripts/build-helpers.mjs kuber) through the bridge (methods/helper.mjs).
// Kuber's code is unchanged; only its package description is: the build moves
// the module that holds Kuber's transaction runner and balancer,
// Cardano.Kuber.Core.TxFramework, from other-modules to exposed-modules
// (methods/kuber-source.mjs), since no package depending on Kuber could
// otherwise run them without a node or a Kuber server.
//
// The call (helpers/kuber/Main.hs): Kuber's default for a payment, a
// TxBuilder of txPayTo for each requested output (src/Cardano/Kuber/Core/
// TxBuilder.hs:367-376), the wallet's spendable UTxOs as txWalletUtxos
// (:595-597) and the change address as txChangeAddress (:636-637), run by
// executeTxBuilder (Core/TxFramework.hs:307-311), the runner kBuildTx runs for
// a node or chain-info backend (Core/KuberAPI.hs:43-62, :62). Its backend is
// the request: the run's protocol parameters, the network, the network's
// system start and era history (fixed data, Main.hs networkTime), the UTxOs
// the request names, the key deposit as a stake credential's deposit, and an
// empty governance state. The runner (executeRawTxBuilder,
// TxFramework.hs:134-299) writes a stake registration that states no deposit
// as one that does, with the key deposit, and a deregistration that states no
// refund as one that does, with the refund its backend answers (:250-286);
// it fills a proposal's previous action and guardrail script from the
// governance state only where the proposal names none, so a replayed
// proposal stays as observed (:211-248); and it calls the balancer,
// txBuilderToTxBody (:321-329). txWalletUtxos gives the balancer the
// candidates Kuber's address query would return for txWalletAddress over the
// wallet's spendable UTxOs, and keeps out the collateral the engine set aside
// and any held UTxO at a wallet address, which the balancer would otherwise
// take back from its UTxO map by address (:578).
//
// The path (census reading, TxFramework.hs): every candidate, sorted by
// sortUtxos (:938-959: a reference script or an inline datum first, then
// more distinct units first, then lovelace ascending; explicit collateral
// last); selection by pruning from the front of that order whatever the
// running change still covers in every asset (minimizeUtxos, :1401-1407),
// then one more UTxO in order when the change's lovelace is under the
// minimum of a change output holding the whole change (:1430-1452); the fee
// recomputed and the selection redone up to ten times until the fee stops
// changing (iteratedBalancing, :507-521), the fee in the target from the
// first pass (startingChange, :1396); one change output at the change
// address holding the whole remaining value (:1353, :1373-1378). Kuber sorts
// its candidates and draws nothing at random, so the state's order does not
// reach the outcome: the method is deterministic.
//
// The replay path (Main.hs withFixedParts), each part through Kuber's
// exported builder functions where one exists, and otherwise through Kuber's
// JSON form of a builder (the Kuber server's request, decoded by Kuber's own
// instance, Data/TxBuilderAeson.hs:55-166):
//   fixed inputs        txConsumeUtxo; a Plutus script input txRedeemUtxo,
//                       txRedeemUtxoWithDatum or their reference-script
//                       forms, with the observed redeemer and units
//   reference inputs    txReferenctUtxo
//   validity            txValidFromSlot, txValidUntilSlot
//   certificates        txCertificate, each as the ledger decodes it
//   mint                txMintSimpleScript for a native policy of the witness
//                       set; Kuber's JSON mint for a Plutus policy (with its
//                       redeemer and units) or a reference-script policy
//   required signers    Kuber's JSON signatures
//   votes, proposals    Kuber's JSON votes and proposals (Data/Models.hs:
//                       819-907, 1175-1221)
//   auxiliary data      the builder's metadata (no-schema JSON) and
//                       auxiliary scripts
//   requested outputs   txPayTo, txPayToScriptWithData (inline datum),
//                       txPayToScript (datum hash), txPayToWithReferenceScript,
//                       or Kuber's JSON output for a datum hash with a script,
//                       for an inline datum with a script, and for a datum
//                       hash whose datum the witness set carries; that form
//                       takes a datum as JSON and writes cardano-api's
//                       encoding of it, so the helper uses it only for a
//                       datum whose bytes are that encoding
//   collateral          Kuber's JSON collaterals, the UTxO the engine set
//                       aside
// After the build the helper compares what Kuber wrote with the intent's
// parts: the witness set's scripts and datums, the mint, the proposals, the
// votes, the auxiliary data (a metadata map's entry order apart: Kuber's
// metadata form is JSON, whose objects keep no order, so it writes a map's
// entries in an order of its own, the size unchanged) and the requested
// outputs. Not replayable: withdrawals, the current treasury value and a
// donation, which Kuber's builder does not hold (TxBuilder.hs:169-186,
// TxFramework.hs:439, :447-449); a redeemer of a certificate, withdrawal or
// vote, and a certificate with a script credential, which Kuber writes
// without a witness (TxFramework.hs:392-415, :453-459); a proposal's redeemer
// other than the unit, which is the only one Kuber's proposal witness carries
// (:1187, :1223, :1246); a bootstrap witness; a native-script input whose script is in the
// witness set; a datum of the witness set no script input carries; an inline
// datum with a script reference on a requested output; a parameter change
// naming minFeeB or minFeeRefScriptCostPerByte, which Kuber's parameter update
// has no field for (Data/Models.hs:920-949); and auxiliary data, a proposal or a script Kuber's
// operations do not write as observed. Votes Kuber writes other than observed
// are its own failure (class other): its balancer gives every voter every
// vote of the transaction (:453-459). So is a transaction cardano-api's body
// check refuses (class other): Kuber decides that a transaction needs
// collateral from its Plutus script inputs and Plutus mints, and counts no
// Plutus mint whose script is a reference script (:639-646), so such a
// transaction has redeemers and no collateral (TxBodyEmptyTxInsCollateral);
// and a transaction whose fixed parts pay its outputs and fee keeps no input
// after the pruning (TxBodyEmptyTxIns). Kuber writes no collateral return and
// no total collateral (:430-431): the collateral set aside is spent whole if
// the scripts fail.
//
// Witnesses: the bridge has the helper write one synthetic witness per wallet
// key, then the intent's other vkey witnesses, with cardano-api's
// makeSignedTransaction as Kuber writes its own signatures (:522-527); they
// are named unpriced when they outnumber the key witnesses Kuber's fee counted
// (calculateMinTxFee with its signatory count, :1379-1382).
//
// The layout change (opts.changePolicy 'layout'): Kuber builds its
// transaction exactly as for its own change; the bridge reads the wallet
// inputs it selected, drops its change, and builds the simulator's layout
// change on them (methods/change.mjs). A build Kuber refuses fails before that
// point, as for its own change: its selection and change are one call.
//
// Errors to failure classes (the helper reports Kuber's FrameworkError as its
// type and message; the rest 'other'):
//   InsufficientInput "Missing Balance :..." (TxFramework.hs:1441)   balance
//   BalancingError "No utxo available for collateral" (:388)      collateral

import { CLASSES } from '../kit/check.mjs';
import { REPLAY_COVERAGE } from './library.mjs';
import { helperMethod, helperBuild } from './helper.mjs';
import { KUBER_VERSION, KUBER_COMMIT, KUBER_CABAL_EDITED } from './kuber-source.mjs';

const ERROR_CLASSES = [
  [/^InsufficientInput: Missing Balance/, CLASSES.balance],
  [/^BalancingError: No utxo available for collateral/, CLASSES.collateral]
];

export function classOfKuberError(text) {
  for (const [re, cls] of ERROR_CLASSES) if (re.test(text)) return cls;
  return CLASSES.other;
}

export function kuberMethod(T) {
  const name = 'kuber-prune';
  const hint = 'run node scripts/build-helpers.mjs kuber';
  const { problem, record } = helperBuild('kuber');
  if (problem) throw new Error(`${name}: ${problem}`);
  const mod = record.modules && record.modules.kuber;
  if (!mod || mod.version !== KUBER_VERSION || mod.commit !== KUBER_COMMIT || !mod.packageDescription || mod.packageDescription.edited !== KUBER_CABAL_EDITED) {
    throw new Error(`${name}: the kuber helper was built with ${mod ? `kuber ${mod.version} at ${mod.commit}` : 'no Kuber'}, not ${KUBER_VERSION} at ${KUBER_COMMIT} with its one pinned change; ${hint}`);
  }
  return helperMethod(T, {
    name,
    version: `Kuber ${KUBER_VERSION} (${KUBER_COMMIT.slice(0, 7)}) txWalletUtxos pruning selection; helper kuber sha256 ${record.sha256.slice(0, 16)}`,
    deterministic: true,
    seeded: true,
    library: 'kuber',
    coverage: REPLAY_COVERAGE.kuber,
    classify: classOfKuberError,
    refused: 'the Kuber baseline takes its own change or the layout change only',
    process: { key: name, command: record.path, args: [] }
  });
}
