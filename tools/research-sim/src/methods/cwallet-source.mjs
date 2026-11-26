// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The pinned source of cardano-balance-tx, which the cwallet helper
// (helpers/cwallet) builds against: cardano-foundation/
// cardano-balance-transaction at 897577325745729552495a9add56c713630c497e,
// the commit cardano-wallet f293d92 pins. scripts/build-helpers.mjs cwallet
// takes the paths below from a clone of the commit, checks each one's git
// object hash against its pin, extracts them with git archive into
// SOURCE_DIR (gitignored), and makes one change, to the library's evaluation
// step (CBT_CHANGES); each edited file must hash to its pin.
// helpers/cwallet/cabal.project builds this directory as a local package in
// place of the source-repository-package cardano-wallet's cabal.project
// names. Nothing of the library's source is kept in the repository.
//
// The change. balanceTx sets each redeemer's execution units in
// assignScriptRedeemers (lib/Cardano/Balance/Tx/Redeemers.hs:137-283): it
// writes the redeemers with zero units (assignNullRedeemers, :163-193), runs
// every script of the built transaction with the ledger's evaluator
// (evaluateExecutionUnits, :197-211, Ledger.evalTxExUnits at :205), writes
// the units each run used (assignExecutionUnits, :226-251) and computes the
// script integrity hash (:255-283); a script that fails, or that the
// evaluator cannot decode, fails the build (hoistScriptFailure, :213-222).
// The study does not test whether a script validates: with the intent's
// scripts, redeemers, datums and reference inputs in place, every library's
// transaction is presumed to validate and every script is charged the
// observed units. The change makes the evaluation step answer each redeemer
// with the units it carries and run no script:
//   - the library's Redeemer type (:290-294) carries the redeemer's execution
//     units as a third field of each constructor, which the helper fills from
//     the request (the intent's observed units); the functions that take a
//     Redeemer apart (build, :296-303; redeemerData, :305-309;
//     toScriptPurpose, :311-321) skip the new field, and redeemerExUnits
//     reads it;
//   - evaluateExecutionUnits answers every redeemer of the transaction with
//     its Redeemer's units, so no script runs and none can fail;
//   - what only the evaluator used goes: the epoch information and system
//     start (:153-157), hoistScriptFailure, and the imports and arguments
//     that served them (the time translation and the UTxO stay as unused
//     arguments, so balanceTx's call is unchanged). The epoch information's
//     error text was the library's only use of the text package, so its
//     line goes from the library's build-depends
//     (cardano-balance-tx.cabal:99): the library builds with -Werror and
//     -Wunused-packages (:40-44), under which an unused dependency fails the
//     build.
// assignNullRedeemers, assignExecutionUnits, the integrity hash and every
// other module of the library are unchanged: the redeemers' pointers, their
// data, the transaction's fee (which prices the units it now carries), the
// selection, the change and the collateral are computed as before.

export const CBT_REPO = 'https://github.com/cardano-foundation/cardano-balance-transaction.git';
export const CBT_COMMIT = '897577325745729552495a9add56c713630c497e';
export const CBT_VERSION = '0.1.0';

// path -> [git object type, object hash] at CBT_COMMIT: the library's source,
// its package description, and the files the description names as extra
// files (its license, notice, readme and changelog).
export const CBT_PATHS = Object.freeze({
  lib: Object.freeze(['tree', '0c34c41d1c46c7c418103b21cb181d4124009526']),
  'cardano-balance-tx.cabal': Object.freeze(['blob', 'e7a9843d75b814ff0e7d3340778a937e9bb238c4']),
  LICENSE: Object.freeze(['blob', '261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64']),
  NOTICE: Object.freeze(['blob', '38d68e31d88c8a9830a184f5efdc07b70b74ad8b']),
  'README.md': Object.freeze(['blob', '5d20f63865bc9d4c78a5fb6c7d06d661f4a9a055']),
  'CHANGELOG.md': Object.freeze(['blob', '893f00dbb1d52fff499e4a4f5bcc2ea05af99581'])
});

// The evaluation step's file, its git blob hash at CBT_COMMIT, and its hash
// after the change.
export const CBT_REDEEMERS = 'lib/Cardano/Balance/Tx/Redeemers.hs';
export const CBT_REDEEMERS_ORIGINAL = '314acc5693bbc3bcf2adc0627a4c9347da77f86b';
export const CBT_REDEEMERS_EDITED = 'fae9037f56aff8cb14077d27884676bf6a9e5e3a';

// Under the tool's directory; helpers/cwallet/cabal.project names it as
// ../../build/helpers/cwallet/source.
export const SOURCE_DIR = 'build/helpers/cwallet/source';

// The change as [before, after] pairs, applied in order; each `before` must
// occur exactly once in the text it is applied to.
export const PRESUME_VALIDATION = Object.freeze([
  [
    `import Cardano.Balance.Tx.TimeTranslation
    ( TimeTranslation
    , epochInfo
    , systemStartTime
    )
`,
    `import Cardano.Balance.Tx.TimeTranslation
    ( TimeTranslation
    )
`
  ],
  [
    `import Cardano.Slotting.EpochInfo
    ( EpochInfo
    , hoistEpochInfo
    )
`,
    ''
  ],
  [
    `import Control.Arrow
    ( left
    )
`,
    ''
  ],
  [
    `import Data.Map.Strict
    ( Map
    , (!)
    )
`,
    `import Data.Map.Strict
    ( Map
    )
`
  ],
  [
    `import qualified Data.Set as Set
import qualified Data.Text as T
`,
    `import qualified Data.Set as Set
`
  ],
  [
    `assignScriptRedeemers pparams timeTranslation utxo redeemers tx = do`,
    `assignScriptRedeemers pparams _timeTranslation _utxo redeemers tx = do`
  ],
  [
    `  where
    epochInformation :: EpochInfo (Either T.Text)
    epochInformation =
        hoistEpochInfo (left (T.pack . show)) $ epochInfo timeTranslation

    systemStart = systemStartTime timeTranslation

    -- \\| Assign redeemers`,
    `  where
    -- \\| Assign redeemers`
  ],
  [
    `    -- \\| Evaluate execution units of each script/redeemer in the transaction.
    -- This may fail for each script.
`,
    `    -- \\| The execution units of each script/redeemer in the transaction: the
    -- units its 'Redeemer' carries. No script is run, so none fails.
`
  ],
  [
    `    evaluateExecutionUnits indexedRedeemers ledgerTx =
        Ledger.evalTxExUnits
            pparams
            ledgerTx
            utxo
            epochInformation
            systemStart
            & hoistScriptFailure indexedRedeemers

    hoistScriptFailure
        :: Map (Alonzo.PlutusPurpose Alonzo.AsIx era) Redeemer
        -> Map
            (Alonzo.PlutusPurpose Alonzo.AsIx era)
            (Either (TransactionScriptFailure era) a)
        -> Map
            (Alonzo.PlutusPurpose Alonzo.AsIx era)
            (Either (ErrAssignRedeemers era) a)
    hoistScriptFailure indexedRedeemers = Map.mapWithKey $ \\ptr -> left $ \\e ->
        ErrAssignRedeemersScriptFailure (indexedRedeemers ! ptr) e
`,
    `    evaluateExecutionUnits indexedRedeemers _ledgerTx =
        Map.map (Right . redeemerExUnits) indexedRedeemers
`
  ],
  [
    `data Redeemer
    = RedeemerSpending ByteString TxIn
    | RedeemerMinting ByteString PolicyId
    | RedeemerRewarding ByteString RewardAccount
`,
    `data Redeemer
    = RedeemerSpending ByteString TxIn Alonzo.ExUnits
    | RedeemerMinting ByteString PolicyId Alonzo.ExUnits
    | RedeemerRewarding ByteString RewardAccount Alonzo.ExUnits
`
  ],
  [
    `        RedeemerSpending _ input ->
            "spending(" <> build (show input) <> ")"
        RedeemerMinting _ pid ->
            "minting(" <> build (show pid) <> ")"
        RedeemerRewarding _ acc ->
            "rewarding(" <> build (show acc) <> ")"
`,
    `        RedeemerSpending _ input _ ->
            "spending(" <> build (show input) <> ")"
        RedeemerMinting _ pid _ ->
            "minting(" <> build (show pid) <> ")"
        RedeemerRewarding _ acc _ ->
            "rewarding(" <> build (show acc) <> ")"
`
  ],
  [
    `    RedeemerSpending bytes _ -> bytes
    RedeemerMinting bytes _ -> bytes
    RedeemerRewarding bytes _ -> bytes
`,
    `    RedeemerSpending bytes _ _ -> bytes
    RedeemerMinting bytes _ _ -> bytes
    RedeemerRewarding bytes _ _ -> bytes

redeemerExUnits :: Redeemer -> Alonzo.ExUnits
redeemerExUnits = \\case
    RedeemerSpending _ _ units -> units
    RedeemerMinting _ _ units -> units
    RedeemerRewarding _ _ units -> units
`
  ],
  [
    `    RedeemerSpending _ txin ->
        mkSpendingPurpose $ AsItem txin
    RedeemerMinting _ pid ->
        mkMintingPurpose $ AsItem pid
    RedeemerRewarding _ acc ->
        mkRewardingPurpose $ AsItem acc
`,
    `    RedeemerSpending _ txin _ ->
        mkSpendingPurpose $ AsItem txin
    RedeemerMinting _ pid _ ->
        mkMintingPurpose $ AsItem pid
    RedeemerRewarding _ acc _ ->
        mkRewardingPurpose $ AsItem acc
`
  ]
]);

// The package description: the text package's line in the library's
// build-depends goes with its only use.
export const CBT_CABAL_EDITS = Object.freeze([
  ['    , text                       >=1.2      && <2.2\n', '']
]);

// Each file the change edits: its git blob hash at CBT_COMMIT, its edits, and
// its hash after them.
export const CBT_CHANGES = Object.freeze({
  [CBT_REDEEMERS]: Object.freeze({ original: CBT_REDEEMERS_ORIGINAL, edits: PRESUME_VALIDATION, edited: CBT_REDEEMERS_EDITED }),
  'cardano-balance-tx.cabal': Object.freeze({ original: 'e7a9843d75b814ff0e7d3340778a937e9bb238c4', edits: CBT_CABAL_EDITS, edited: '07f9c64a87b7e4fa29f634e43cfe5663cb828eab' })
});

// A file's text with its edits made; throws unless each text an edit
// replaces occurs exactly once.
export function applyEdits(path, text) {
  let out = text;
  for (const [before, after] of CBT_CHANGES[path].edits) {
    const n = out.split(before).length - 1;
    if (n !== 1) throw new Error(`${path}: the text the change replaces occurs ${n} times, not once:\n${before.split('\n')[0]}`);
    out = out.replace(before, () => after);
  }
  return out;
}
