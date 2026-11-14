// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The one change to the installed @helios-lang/ledger 0.7.24 that the Helios
// adapter (methods/helios.mjs) runs on, and the hashes that identify the file
// before and after it. The study does not test whether a contract validates:
// every script is charged the units the intent observed (TxBuilder's build
// option modifyExBudget sets them), and a transaction is presumed to validate.
// No option of @helios-lang/tx-utils 0.6.42 keeps that presumption. Its build
// option throwBuildPhaseScriptErrors: false stops a failing script from
// throwing while the builder profiles it (TxBuilder.js:2710-2766), but build
// then ends with tx.validateUnsafe(params, { strict: true }) (TxBuilder.js:
// 608-628), whose options are the observer, the logger and the verbosity, and
// Tx.validate runs every script again in validateRedeemersExBudget (ledger
// src/tx/Tx.js:766-868), throwing when a script fails or costs more than the
// observed units. That failure comes before the total execution budget, the
// outputs' minimum, the input, reference input, mint and withdrawal order,
// the metadata and the script-data-hash checks, which build then skips; and
// buildUnsafe, which does not throw, records the one error and skips the same
// checks. scripts/patch-helios.mjs therefore makes one change to
// validateRedeemersExBudget: after each redeemer's details are looked up
// (which still fails for a redeemer with no script), the loop continues to the
// next redeemer, so no script is run in validation and none fails the build.
// Every other check of validate stays.

export const HELIOS_LEDGER_TX_PATH = '@helios-lang/ledger/src/tx/Tx.js';
export const HELIOS_TX_ORIGINAL_SHA256 = 'd23efc4620827d28f549c35aa521487b9d97cb800ebd742c567e222ed5bab426';
export const HELIOS_TX_PATCHED_SHA256 = '7098584ca84703f347a020a9b7bcdd84c872ca5609620d67fd834c587862b76c';

const ANCHOR = `            const { description, summary, script, args } =
                redeemer.getRedeemerDetailsWithArgs(this, txInfo)
`;
const INSERT = `            // research-sim: script validation presumed; the redeemer's units are
            // the observed ones, and no script runs here.
            continue
`;

// Tx.js with the one change; throws unless the anchor occurs exactly once.
export function presumeScriptValidation(text) {
  if (text.split(ANCHOR).length !== 2) throw new Error('Tx.js does not hold the redeemer lookup of validateRedeemersExBudget exactly once');
  return text.replace(ANCHOR, ANCHOR + INSERT);
}
