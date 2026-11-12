// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Apollo baseline, apollo-macs: Apollo's transaction builder at its
// defaults (Go module github.com/Salvionied/apollo/v2 v2.2.1, the release
// tag's commit 12d4a1c77cc1f991231d6ffca306ceef61dbabd0), run in the apollo
// helper (helpers/apollo, built by scripts/build-helpers.mjs apollo) through
// the bridge (methods/helper.mjs). The selector is Apollo's MACS as shipped:
// the builder is given no coin selector, so Complete() selects with
// defaultCoinSelector = NewMACSSelector() (apollo.go:2640-2643,
// coinselection.go:57, macs.go:79-85), the multi-asset coin selection of
// Ramezan, Schneider and McCann with the MinChange steer of 1.5 ADA and the
// dust sweep the library adds. It is the study's only MACS.
//
// The call (helpers/apollo/main.go): apollo.New(chain context).SetWallet(w),
// AddInputAddress for each address of the wallet's spendable UTxOs, AddPayment
// with each requested output's own bytes, the replay's fixed parts through the
// builder's operations, then Complete() (apollo.go:158, :224, :293, :260,
// :1875). The chain context is the replay's state: the run's protocol
// parameters, the network, and the UTxOs by address in the state's order
// (library.mjs inputOrder) and by reference; nothing reaches a network. The
// wallet's address is the change address, which Complete() takes for the
// change (apollo.go:3859-3864). Complete() (apollo.go:1875-2349) reserves a fee
// estimated for the known shape, selects with MACS from the loaded UTxOs not
// already inputs, re-selects at most three times when the selected shape needs
// a larger reserve, then balances: one change output at the change address
// holding every leftover asset, ADA-only change under its minimum added to the
// fee and no change output written, token change raised to its minimum or the
// build refused (evaluation_balance.go:33-104), the fee re-estimated until two
// passes agree (at most five); it refuses a transaction over maxTxSize and an
// output whose value is over maxValSize (apollo.go:2322-2347, :2352-2378).
// MACS breaks every tie by the UTxO reference (macs.go:542-560), so the state's
// order decides nothing; it draws nothing at random: deterministic.
//
// Witnesses: Complete() writes no vkey witness; the bridge has the helper
// write one synthetic witness per wallet key, then the intent's other vkey
// witnesses as observed, through AddVerificationKeyWitness (apollo.go:
// 1341-1366), which encodes them as a tag-258 set.
//
// The replay path (helpers/apollo/main.go withFixedParts), each part through
// the builder's own operation, before Complete():
//   fixed inputs        AddInput (apollo.go:283-290)
//   reference inputs    AddReferenceInput, resolved through the chain context
//                       (:444-465)
//   native scripts      AttachScript for each of the witness set (:493-532)
//   mint and burn       Mint per asset, a burn as a negative quantity
//                       (:467-491)
//   certificates        SetCertificates with the intent's certificates
//                       (:730-737); the builder counts their deposits and
//                       refunds at the run's key and pool deposits
//   withdrawals         AddWithdrawal per reward account (:1039-1081)
//   votes, proposals    AddVote per voter and action, AddProposal per
//                       proposal (:1177-1210)
//   required signers    AddRequiredSigner (:299-303)
//   validity            SetTtl, SetValidityStart (:333-351)
//   treasury, donation  SetCurrentTreasuryValue, AddTreasuryDonation
//                       (:1153-1175)
//   auxiliary data      SetShelleyMetadata with the intent's metadata,
//                       each label's value as decoded (:1132-1135); the
//                       builder writes metadata only
// Not replayable: body field 6 (kit/replay.mjs replayRefusal); a body field
// none of the operations above writes; a bootstrap witness, which no
// operation writes; auxiliary data holding scripts. The Plutus parts
// (redeemers, Plutus scripts, datums) and with them the collateral of a
// script spend are not in this adapter's replay path yet (REPLAY_COVERAGE
// leaves out 'collateral'): every intent with a redeemer requires
// collateral, so such an intent is refused before the helper is asked, as
// an uncovered part, never scored as not replayable; a Plutus witness without
// a redeemer is answered as not replayable ('plutus').
//
// The layout change (opts.changePolicy 'layout'): the library builds its
// transaction exactly as for its own change; the bridge reads the wallet
// inputs it selected from that transaction, drops its change, and builds the
// simulator's layout change on those inputs (methods/change.mjs). A build the
// library refuses fails before this point, as for its own change: Complete()
// selects and makes its change in one call, so no selection survives a
// failed build.
//
// Errors to failure classes (setting unclassified 'other' for the rest):
//   "coin selection failed: insufficient UTxOs to cover required value"
//   (macs.go:340-342), "coin selection failed: no available UTxO to spend"
//   (apollo.go:2560-2565), "insufficient funds: ..." (the selected inputs
//   short of the outputs and the fee, evaluation_balance.go:52-55)  balance
//   "insufficient funds for asset change min UTxO" (evaluation_balance.go:99)
//                                                              change-minimum
//   "transaction size N exceeds max_tx_size M" (apollo.go:2333)  tx-size
//   "output N value size N exceeds max_val_size M" (apollo.go:2369)
//                                                              value-size

import { CLASSES } from '../kit/check.mjs';
import { REPLAY_COVERAGE } from './library.mjs';
import { helperMethod, helperBuild } from './helper.mjs';

export const APOLLO_VERSION = 'v2.2.1';
export const APOLLO_COMMIT = '12d4a1c77cc1f991231d6ffca306ceef61dbabd0';

const ERROR_CLASSES = [
  [/insufficient funds for asset change min UTxO/, CLASSES.changeMinimum],
  [/^coin selection failed: insufficient UTxOs to cover required value/, CLASSES.balance],
  [/^coin selection failed: no available UTxO to spend/, CLASSES.balance],
  [/^insufficient funds: /, CLASSES.balance],
  [/^transaction size \d+ exceeds max_tx_size \d+/, CLASSES.txSize],
  [/^output \d+ value size \d+ exceeds max_val_size \d+/, CLASSES.valueSize]
];

export function classOfApolloError(text) {
  for (const [re, cls] of ERROR_CLASSES) if (re.test(text)) return cls;
  return CLASSES.other;
}

export function apolloMethod(T) {
  const name = 'apollo-macs';
  const { problem, record } = helperBuild('apollo');
  if (problem) throw new Error(`${name}: ${problem}`);
  const mod = record.modules && record.modules['github.com/Salvionied/apollo/v2'];
  if (!mod || mod.version !== APOLLO_VERSION || mod.commit !== APOLLO_COMMIT) throw new Error(`${name}: the apollo helper was built with ${mod ? `${mod.version} at ${mod.commit}` : 'no Apollo module'}, not ${APOLLO_VERSION} at ${APOLLO_COMMIT}`);
  return helperMethod(T, {
    name,
    version: `Apollo ${APOLLO_VERSION} (${APOLLO_COMMIT.slice(0, 7)}) MACSSelector; helper apollo sha256 ${record.sha256.slice(0, 16)}`,
    deterministic: true,
    seeded: true,
    library: 'apollo',
    coverage: REPLAY_COVERAGE.apollo,
    classify: classOfApolloError,
    refused: 'the Apollo baseline takes its own change or the layout change only',
    process: { key: name, command: record.path, args: [] }
  });
}
