// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The cardano-wallet baseline, cwallet-rrri: the balancer cardano-wallet
// calls for a payment, cardano-balance-tx's balanceTx
// (cardano-foundation/cardano-balance-transaction at
// 897577325745729552495a9add56c713630c497e) over cardano-coin-selection
// (cardano-foundation/cardano-coin-selection at
// 176611048d5b9f33df19d106cd925d63a7858bb2), as cardano-wallet pins them at
// f293d922f1930714aca7ede3cbb5ebf3fb710af6, run in the cwallet helper
// (helpers/cwallet, Haskell, built by scripts/build-helpers.mjs cwallet in
// the development shell scripts/haskell-prep.sh prepares) through the bridge
// (methods/helper.mjs). Paths below are cbt (cardano-balance-transaction),
// ccs (cardano-coin-selection) and wallet (cardano-wallet) at those commits;
// Server.hs is the wallet's lib/api/src/Cardano/Wallet/Api/Http/Shelley/
// Server.hs, Wallet.hs its lib/wallet/src/Cardano/Wallet.hs, Balance.hs
// cbt's lib/Cardano/Balance/Tx/Balance.hs.
//
// The call (helpers/cwallet/Main.hs). The wallet's transaction construction
// endpoint (Server.hs:2904-3200) turns the payments into outputs, builds the
// unbalanced transaction with W.constructTransaction (:3141-3147) and calls
// W.balanceTx (:3167-3181) with a PartialTx of that transaction, no extra
// UTxO, no redeemers, an empty stake deposit map and the mint's timelock
// witness counts (none for a payment). W.balanceTx (Wallet.hs:2523-2578)
// reads the wallet's available UTxO, indexes it, and calls cbt's balanceTx
// (Balance.hs:529-606) with the node's protocol parameters and time
// translation, AllKeyPaymentCredentials for a Shelley wallet (:2553-2554; it
// serves only Shelley and shared wallets, :2529) and the wallet's change
// address generator (:2570). The helper makes that call with
//   protocol parameters  the run's, as the ledger's PParams, with what the
//                       run does not carry and a node would give: each
//                       network's Plutus cost models, execution-unit limit
//                       per transaction and, where the run states none, its
//                       protocol version, copied from the Blockfrost
//                       snapshots Scalus 1.5.0 bundles (preprod epoch 310,
//                       mainnet epoch 645, the synthetic shapes mainnet's;
//                       helpers/cwallet/CostModels.hs)
//   time translation    the network's slot-to-time mapping from its Shelley
//                       era on (preprod slot 86,400 at 1,655,769,600 s,
//                       mainnet slot 4,492,800 at 1,596,059,091 s), a fixed
//                       epoch info of one-second slots; it reaches the
//                       transaction only through a Plutus script's context
//   UTxO assumptions    AllKeyPaymentCredentials
//   UTxO index          constructUTxOIndex of the wallet's spendable UTxOs,
//                       the intent's fixed inputs left out (the wallet's
//                       utxoIndexFromWalletUTxO); the index is keyed by the
//                       UTxOs' references, so the state's order does not
//                       reach the selection
//   change addresses    the change address for every change output, with a
//                       57-byte dummy as the maximum length, as the wallet's
//                       Shelley generator has (defaultChangeAddressGen,
//                       Wallet.hs:5362-5365; maxLengthAddressForShelley,
//                       lib/address-derivation-discovery/lib/Cardano/Wallet/
//                       Address/Constants.hs:61). The wallet derives its
//                       change addresses from its account key (Discovery/
//                       Sequential.hs:554-581); a replay has one change
//                       address, of the same length
//   partial transaction the requested outputs as their own bytes, fee 0, and
//                       the validity interval W.constructTransaction writes
//                       where the request names none: valid from slot 0
//                       (Server.hs:3003, :3505-3506, :3518-3522) until the
//                       slot two hours after the spend's time
//                       (Wallet.hs:3480-3496, transactionExpirySlot with no
//                       TTL); a replayed intent's own validity fields take
//                       their place
// cbt's balanceTx assigns any requested output without ADA its minimum, then
// balances with SelectionStrategyOptimal and, when that fails for the size
// limit, the change or the collateral, again with SelectionStrategyMinimal
// (Balance.hs:602-606, :704-745). balanceTxInner (:773-925) selects with
// ccs's performSelection (ccs lib/Cardano/CoinSelection.hs:340-346):
// round-robin over the requested assets and lovelace last, each step a
// random pick among the UTxOs holding only that asset, then that asset and
// one other, then any (ccs lib/Cardano/CoinSelection/Balance.hs:1106-1300),
// kept while it moves the total toward twice the target (Optimal) or the
// target (Minimal); then the change, one bundle per payment output, split by
// asset count and token quantity, with the minimum ADA of each
// (makeChangeRepeatedly, :978-1013); then the fee, distributing the surplus
// into fee and change (distributeSurplus), and the size limit, against its
// own estimate of the signed size (guardTxSize, Balance.hs:904-925).
//
// Randomness: the selection draws through MonadRandom; the helper runs
// balanceTx in Rand StdGen with mkStdGen of the request's seed, so the
// method is seeded and not deterministic, one seed gives the same bytes, and
// L/own and L/layout of one repetition draw alike. The wallet itself runs it
// in IO, whose generator is the process's global StdGen.
//
// Witnesses: balanceTx writes no key witness, and refuses a transaction that
// carries any (updateTx, Balance.hs:1310-1343), so the intent's other vkey
// and bootstrap witnesses are written after it. Its fee priced one vkey
// witness per distinct input that is not at a script (so one per input, not
// per key), required signer, key withdrawal and certificate witness, and a
// bootstrap witness per Byron input (estimateKeyWitnessCounts, cbt
// lib/Cardano/Balance/Tx/Sign.hs:175-234). The bridge has the helper write
// one synthetic witness per wallet key, then the intent's other vkey
// witnesses as observed; the helper adds the intent's bootstrap witnesses.
// When either outnumbers what the fee priced, the response names them
// unpriced.
//
// The replay path: every part goes into the partial transaction, which the
// library takes as a ledger transaction, as the wallet's balance endpoint
// takes the one a client sends (Server.hs:3839-3902; its request carries the
// transaction, the client's UTxOs and its redeemers, lib/api/src/Cardano/
// Wallet/Api/Types.hs:1436-1442):
//   fixed inputs        the body's inputs, their outputs as extraUTxO (the
//                       wallet looks them up from its node, Wallet.hs:2540-
//                       2545)
//   reference inputs    body field 18, their outputs as extraUTxO
//   body fields         3, 4, 5, 8, 9, 14, 19, 20, 21, 22 as their own bytes
//   auxiliary data      the transaction's, its hash in the body
//   scripts, datums     the witness set's native and Plutus scripts and
//                       datums as their own bytes
//   redeemers           PartialTx's redeemers: a spend's, a mint's and a
//                       withdrawal's with their own data. balanceTx sets
//                       their execution units by running each script with
//                       the ledger's evaluator (assignScriptRedeemers, cbt
//                       lib/Cardano/Balance/Tx/Redeemers.hs:137-283,
//                       evalTxExUnits at :205), so the transaction carries
//                       the units of its own scripts' runs, not the
//                       intent's, and a script that fails in the built
//                       transaction fails the build. The construction
//                       endpoint's request has no redeemers (Types.hs:
//                       1301-1313), so a spend with Plutus redeemers comes
//                       through the balance endpoint, which adds no validity
//                       interval: such a spend's transaction is the client's
//                       as sent
//   refunds             the stake deposit of each credential the
//                       transaction deregisters, the run's key deposit (the
//                       wallet asks its node, Wallet.hs:2547-2551)
//   collateral          balanceTx refuses a transaction with collateral
//                       (Balance.hs:645-653) and selects its own from the
//                       wallet's ADA-only UTxOs when there are redeemers
//                       (:1125-1134; ADA-only by asCollateral, cbt
//                       lib/Cardano/Balance/Tx/Balance/CoinSelection.hs:
//                       343-346 and :362-364, lib/Cardano/Balance/Tx/
//                       Primitive.hs:237-240), with no return output and no
//                       total, so the method chooses its own collateral
//                       (contract.mjs OWN_COLLATERAL_METHODS) and the engine
//                       sets nothing aside
// Not replayable: body field 6 (kit/replay.mjs replayRefusal); a body field
// outside those above; a redeemer of a certificate, a vote or a proposal,
// which the library's Redeemer type cannot hold (Redeemers.hs:290-293) and
// balanceTx would drop with the rest of the transaction's redeemers
// (:174-177); a Plutus script the ledger's evaluator cannot decode as a
// program (no evaluator can run it, and no observed transaction holds one:
// the synthetic streams' stand-in script). The library treats a pool
// registration as a re-registration, with no deposit
// (evaluateTransactionBalance, cbt lib/Cardano/Balance/Tx/Tx.hs:638-661,
// assumePoolIsReg); a transaction it so underbalances is its own failure for
// the kit to record.
//
// The layout change (opts.changePolicy 'layout'): the library builds its
// transaction exactly as for its own change; the bridge reads the wallet
// inputs it selected from that transaction, drops its change, and builds the
// simulator's layout change on those inputs (methods/change.mjs), keeping the
// collateral inputs the library chose. A build the library refuses fails
// before this point, as for its own change: balanceTx selects and makes its
// change in one call.
//
// Errors to failure classes (the helper names the error's constructor; the
// rest 'other'):
//   ErrBalanceTxAssetsInsufficient (Balance.hs:364, the wallet's UTxOs hold
//   too little of an asset), ErrBalanceTxUnableToCreateInput (:389, no UTxO
//   at all)                                                        balance
//   ErrBalanceTxUnableToCreateChange (:383, too little ADA for the change's
//   minimums and their fee, after the Minimal retry)        change-minimum
//   ErrBalanceTxMaxSizeLimitExceeded (:365, after the Minimal retry) tx-size
//   ErrBalanceTxInsufficientCollateral (:374)                   collateral

import { CLASSES } from '../kit/check.mjs';
import { REPLAY_COVERAGE } from './library.mjs';
import { helperMethod, helperBuild } from './helper.mjs';

export const CWALLET_COMMIT = 'f293d922f1930714aca7ede3cbb5ebf3fb710af6';
export const CWALLET_GHC = '9.12.3';
export const CWALLET_PINS = Object.freeze({
  'cardano-balance-tx': Object.freeze({ commit: '897577325745729552495a9add56c713630c497e' }),
  'cardano-coin-selection': Object.freeze({ commit: '176611048d5b9f33df19d106cd925d63a7858bb2' })
});

const ERROR_CLASSES = [
  [/^ErrBalanceTxAssetsInsufficient\b/, CLASSES.balance],
  [/^ErrBalanceTxUnableToCreateInput\b/, CLASSES.balance],
  [/^ErrBalanceTxUnableToCreateChange\b/, CLASSES.changeMinimum],
  [/^ErrBalanceTxMaxSizeLimitExceeded\b/, CLASSES.txSize],
  [/^ErrBalanceTxInsufficientCollateral\b/, CLASSES.collateral]
];

export function classOfCwalletError(text) {
  for (const [re, cls] of ERROR_CLASSES) if (re.test(text)) return cls;
  return CLASSES.other;
}

export function cwalletMethod(T) {
  const name = 'cwallet-rrri';
  const hint = 'run node scripts/build-helpers.mjs cwallet';
  const { problem, record } = helperBuild('cwallet');
  if (problem) throw new Error(`${name}: ${problem}`);
  const mods = record.modules || {};
  for (const [pkg, pin] of Object.entries(CWALLET_PINS)) {
    if (!mods[pkg] || mods[pkg].commit !== pin.commit) throw new Error(`${name}: the cwallet helper was built with ${mods[pkg] ? `${pkg} at ${mods[pkg].commit}` : `no ${pkg}`}, not ${pin.commit}; ${hint}`);
  }
  const cbt = mods['cardano-balance-tx'];
  const ccs = mods['cardano-coin-selection'];
  return helperMethod(T, {
    name,
    version: `cardano-balance-tx ${cbt.version} (${cbt.commit.slice(0, 7)}) over cardano-coin-selection ${ccs.version} (${ccs.commit.slice(0, 7)}), as cardano-wallet ${CWALLET_COMMIT.slice(0, 7)} pins them, balanceTx; helper cwallet sha256 ${record.sha256.slice(0, 16)}`,
    deterministic: false,
    seeded: true,
    library: 'cwallet',
    coverage: REPLAY_COVERAGE.cwallet,
    classify: classOfCwalletError,
    refused: 'the cardano-wallet baseline takes its own change or the layout change only',
    ownCollateral: true,
    process: { key: name, command: record.path, args: [] }
  });
}
