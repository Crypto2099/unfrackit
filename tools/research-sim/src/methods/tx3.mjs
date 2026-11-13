// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Tx3 baseline, tx3-vd: tx3-resolver 0.25.0 with tx3-cardano and tx3-lang
// 0.25.0 (crates.io, packaged from the release tag's commit
// f2cadfdb80dbdb72c111ec770e3f233fcbbff2db) over tx3-tir 0.19.0, run in the
// tx3 helper (helpers/tx3, built by scripts/build-helpers.mjs tx3) through the
// bridge (methods/helper.mjs). Tx3 has no payment call: the call is a program
// and its arguments, which a TRP server resolves with
// tx3_resolver::resolve_tx (job.rs:239-259). The helper plays that server for
// each spend, configured as Dolos v1.6.3 configures it (crates/trp/src/
// methods.rs:22-53, compiler.rs:30-83): the run's fee coefficients and coins
// per UTxO byte, tx3-cardano's default extra fee of 200,000 lovelace (lib.rs:
// 39, ops.rs:5-9), 10 optimize rounds, and a UTxO store held in memory.
//
// The program is the many-input form the study runs, generated per spend as Tx3
// source and compiled by tx3-lang (helpers/tx3/src/main.rs, `program`):
// `input* source { from: Wallet, min_amount: fees + min_utxo(change) + the
// payment and any requested tokens }`, one output per requested output, and
// `output change { to: Wallet, amount: source + the fixed inputs - the
// payment - fees }`. The program, not Tx3, writes the change: Tx3 has no
// change strategy of its own, and "everything left back to the source wallet
// as one output" is the change this program defines. The payment in the
// target is, asset by asset, what the requested outputs, the donation and the
// burn take beyond what the fixed inputs, the withdrawals and the mint bring,
// and nothing where those bring more, so the wallet always pays the fee and the
// change minimum (examples/donation.tx3:6-14 writes the target this way).
//
// The selection is Tx3's (tx3-resolver inputs/): every UTxO the store answers
// for the wallet's address is a candidate (narrow.rs:212-219; for a target
// naming a token, the holders of each requested token and then others in
// reference order up to 50, :135-158, :170); candidates are ranked by the
// log-scale vector distance of their assets to the target, ties by reference
// (approximate/rank/vector.rs:139-152); pick_many takes, in rank order, every
// candidate that holds some of what is still pending until nothing is, then
// drops, while one fits inside the excess, the first such UTxO by reference
// (assign/mod.rs:75-122). The fee enters through the program's `fees`, a pass
// late, and the selection is re-run every pass until two compiled
// transactions agree or the rounds run out (job.rs:161-237). Ties go to the
// reference, so the state's order decides nothing; nothing is drawn at
// random: deterministic.
//
// The store answers an address with the spendable UTxOs the state offers
// (library.mjs inputOrder) at that address. The program's wallet party is the
// change address, and a Tx3 query has one address, whose candidates alone the
// resolver keeps (approximate/filter.rs:15-20): Tx3 selects only from the
// wallet's UTxOs at its change address, and a UTxO at the wallet's other
// addresses is never selected.
//
// Witnesses: Tx3 writes no vkey witness and prices none by its size (it adds
// the flat extra fee instead); the bridge has the helper write one synthetic
// witness per wallet key and the intent's other vkey witnesses with pallas, as
// Dolos's trp.submit writes a signer's (crates/trp/src/methods.rs:56-97).
//
// The replay path, each part written by the program:
//   fixed inputs        `input fixedN { ref: ... }`, their value in the change
//   reference inputs    `reference refN { ref: ... }`
//   requested outputs   `output { to, amount, datum }`, an inline datum as a
//                       data argument; one with a script reference as
//                       `cardano::publish { to, amount, datum, version,
//                       script }`
//   mint and burn       one `mint` or `burn` block per policy
//   native scripts      `cardano::native_witness { script }`
//   withdrawals         `cardano::withdrawal { from, amount }`
//   certificates        `cardano::vote_delegation_certificate { drep, stake }`
//   donation            `cardano::treasury_donation { coin }`
//   required signers    `signers { ... }`
//   validity            `validity { since_slot, until_slot }`
//   metadata            `metadata { label: value }`
// Not replayable, the part named (helpers/tx3/src/main.rs `program`):
//   execution units     any redeemer: tx3-cardano writes every redeemer with
//                       fixed units, 2,000,000 memory and 2,000,000,000 steps
//                       (lib.rs:34-37), and its fee prices none of them
//                       (lib.rs:91-98, "TODO: add redeemer fees"), so the
//                       observed units cannot be written; a script spend's
//                       collateral, which a `collateral` block could name, is
//                       therefore never written
//   witness datums, bootstrap witnesses, any other witness set entry the
//                       compiler leaves empty (compile/mod.rs
//                       compile_witness_set)
//   certificates        any but a vote delegation to a key DRep
//                       (compile_certs), and so any deposit or refund
//   votes, proposals, current treasury value: no block writes them
//   auxiliary scripts, and metadata other than integers, text and bytes
//                       (coercion.rs expr_into_metadatum)
//   output datum hash   outputs carry inline datums only (compile_output_block)
// and body field 6 (kit/replay.mjs replayRefusal).
//
// The layout change (opts.changePolicy 'layout'): the library resolves the
// program exactly as for its own change; the bridge reads the wallet inputs it
// selected from that transaction, drops the program's change, and builds the
// simulator's layout change on those inputs (methods/change.mjs). A program the
// library cannot resolve fails before this point, as for its own change.
//
// Errors to failure classes (the rest 'other'):
//   "input not resolved: source" (the wallet's candidates cannot cover the
//   target; job.rs:67-77, assign/mod.rs:91-93)                  balance
// Tx3 checks neither the size of the transaction nor an output's value size
// nor the change's minimum beyond its target, so those fail the kit's checks
// as the library's own.

import { CLASSES } from '../kit/check.mjs';
import { REPLAY_COVERAGE } from './library.mjs';
import { helperMethod, helperBuild } from './helper.mjs';

export const TX3_VERSION = '0.25.0';
export const TX3_COMMIT = 'f2cadfdb80dbdb72c111ec770e3f233fcbbff2db';

const ERROR_CLASSES = [[/^input not resolved: source$/, CLASSES.balance]];

export function classOfTx3Error(text) {
  for (const [re, cls] of ERROR_CLASSES) if (re.test(text)) return cls;
  return CLASSES.other;
}

export function tx3Method(T) {
  const name = 'tx3-vd';
  const { problem, record } = helperBuild('tx3');
  if (problem) throw new Error(`${name}: ${problem}`);
  const mod = record.modules && record.modules['tx3-resolver'];
  if (!mod || mod.version !== TX3_VERSION || mod.commit !== TX3_COMMIT) throw new Error(`${name}: the tx3 helper was built with ${mod ? `tx3-resolver ${mod.version} at ${mod.commit}` : 'no tx3-resolver'}, not ${TX3_VERSION} at ${TX3_COMMIT}`);
  return helperMethod(T, {
    name,
    version: `Tx3 tx3-resolver ${TX3_VERSION} (${TX3_COMMIT.slice(0, 7)}) many-input program; helper tx3 sha256 ${record.sha256.slice(0, 16)}`,
    deterministic: true,
    seeded: true,
    library: 'tx3',
    coverage: REPLAY_COVERAGE.tx3,
    classify: classOfTx3Error,
    refused: 'the Tx3 baseline takes its program\'s change or the layout change only',
    process: { key: name, command: record.path, args: [] }
  });
}
