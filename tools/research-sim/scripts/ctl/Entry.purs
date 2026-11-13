-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean

-- The simulator's entry into the Cardano Transaction Lib balancer
-- (purescript-cardano-transaction-balancer, the version CTL's package set
-- pins), compiled with it by scripts/build-ctl.mjs and called by
-- src/methods/ctl.mjs. It makes the call CTL's defaultBalancerWithErr makes
-- (cardano-transaction-lib src/Internal/BalanceTx/BalanceTx.purs:73-101):
-- runBalancerAff with buildBalancerConfig mempty, a provider, the protocol
-- parameters, the network and the wallet interface, for a CIP-30 wallet whose
-- UTxOs, collateral, used addresses and change address are the request's,
-- and the extra UTxOs the caller passes (the deprecated balanceTx's
-- usedUtxos). Nothing here selects, prices or makes change; the balancer does.
--
-- withVkeys writes the given vkey witnesses into a transaction's witness set
-- in the library's own encoding (the caller's synthetic witnesses, as every
-- adapter fills its library's witness set); "" when a part cannot be decoded.
--
-- Everything crosses as hex CBOR, bech32 or decimal strings. The provider
-- answers getUtxoByOref from the request's UTxOs and evaluateTx through the
-- request's evaluate callback; its other queries are never reached by the
-- balancer and answer with an error.

module UnFrackIt.Ctl.Entry
  ( balance
  , withVkeys
  ) where

import Prelude

import Cardano.AsCbor (decodeCbor, encodeCbor)
import Cardano.Provider (Provider)
import Cardano.Provider.Error (ClientError(ClientOtherError), GetTxMetadataError(GetTxMetadataClientError))
import Cardano.Provider.OgmiosTypes (TxEvaluationR(TxEvaluationR), TxEvaluationResult(TxEvaluationResult))
import Cardano.Transaction.Balancer (runBalancerAff)
import Cardano.Transaction.Balancer.Constraints (buildBalancerConfig)
import Cardano.Transaction.Balancer.Error
  ( BalanceTxError
      ( BalanceInsufficientError
      , CouldNotConvertScriptOutputToTxInput
      , CouldNotGetCollateral
      , InsufficientCollateralUtxos
      , CouldNotGetUtxos
      , CollateralReturnError
      , CollateralReturnMinAdaValueCalcError
      , ExUnitsEvaluationFailed
      , InsufficientUtxoBalanceToCoverAsset
      , ReindexRedeemersError
      , UtxoLookupFailedFor
      , UtxoMinAdaValueCalculationFailed
      , NumericOverflowError
      , CouldNotComputeRefScriptsFee
      )
  , explainBalanceTxError
  )
import Cardano.Types
  ( Address
  , Coin(Coin)
  , ExUnitPrices(ExUnitPrices)
  , NetworkId(MainnetId, TestnetId)
  , Transaction(Transaction)
  , TransactionUnspentOutput(TransactionUnspentOutput)
  , TransactionWitnessSet(TransactionWitnessSet)
  , Vkeywitness
  , UnitInterval(UnitInterval)
  , UtxoMap
  )
import Cardano.Types.Address as Address
import Cardano.Types.BigNum (BigNum)
import Cardano.Types.BigNum as BigNum
import Cardano.Types.CborBytes (CborBytes(CborBytes))
import Cardano.Types.Rational (Rational, reduce)
import Cardano.Types.RedeemerTag (RedeemerTag(Spend, Mint, Cert, Reward, Vote, Propose))
import Control.Promise (Promise, fromAff)
import Data.ByteArray (byteArrayToHex, hexToByteArray)
import Data.Either (Either(Left, Right))
import Data.Log.Level (LogLevel(Error))
import Data.Map as Map
import Data.Maybe (Maybe(Just, Nothing))
import Data.Traversable (traverse)
import Data.Tuple.Nested ((/\))
import Data.UInt as UInt
import Effect (Effect)
import Effect.Aff (Aff, throwError)
import Effect.Class (liftEffect)
import Effect.Exception (error)
import Effect.Uncurried (EffectFn1, runEffectFn1)
import JS.BigInt as BigInt

type Ratio = { numerator :: String, denominator :: String }

type Units = { tag :: Int, index :: Int, memory :: String, steps :: String }

type Request =
  { tx :: String
  , walletUtxos :: Array String
  , extraUtxos :: Array String
  , collateral :: Array String
  , ownAddresses :: Array String
  , changeAddress :: String
  , mainnet :: Boolean
  , pparams ::
      { txFeeFixed :: String
      , txFeePerByte :: Int
      , stakeAddressDeposit :: String
      , stakePoolDeposit :: String
      , coinsPerUtxoByte :: String
      , maxCollateralInputs :: Int
      , refScriptCoinsPerByte :: Ratio
      , memPrice :: Ratio
      , stepPrice :: Ratio
      }
  , evaluate :: EffectFn1 String (Array Units)
  }

type Response = { ok :: Boolean, tx :: String, error :: String, message :: String }

fail :: forall a. String -> Aff a
fail = throwError <<< error

fromHex :: String -> Maybe CborBytes
fromHex = map CborBytes <<< hexToByteArray

toHex :: CborBytes -> String
toHex (CborBytes b) = byteArrayToHex b

decodeHex :: forall a. String -> (CborBytes -> Maybe a) -> String -> Aff a
decodeHex what dec hex = case dec =<< fromHex hex of
  Just a -> pure a
  Nothing -> fail ("cannot decode " <> what <> ": " <> hex)

utxoMap :: Array TransactionUnspentOutput -> UtxoMap
utxoMap = Map.fromFoldable <<< map \(TransactionUnspentOutput { input, output }) -> input /\ output

bigNum :: String -> String -> Aff BigNum
bigNum what s = case BigNum.fromString s of
  Just n -> pure n
  Nothing -> fail ("not a number: " <> what <> " " <> s)

unitInterval :: String -> Ratio -> Aff UnitInterval
unitInterval what r = do
  numerator <- bigNum what r.numerator
  denominator <- bigNum what r.denominator
  pure $ UnitInterval { numerator, denominator }

rational :: String -> Ratio -> Aff Rational
rational what r = case BigInt.fromString r.numerator, BigInt.fromString r.denominator of
  Just n, Just d | Just q <- reduce n d -> pure q
  _, _ -> fail ("not a ratio: " <> what)

address :: String -> Aff Address
address s = case Address.fromBech32 s of
  Just a -> pure a
  Nothing -> fail ("not an address: " <> s)

redeemerTag :: Int -> Aff RedeemerTag
redeemerTag = case _ of
  0 -> pure Spend
  1 -> pure Mint
  2 -> pure Cert
  3 -> pure Reward
  4 -> pure Vote
  5 -> pure Propose
  n -> fail ("redeemer tag " <> show n)

-- The constructor of a balancer error, for the caller's failure classes.
errorTag :: BalanceTxError -> String
errorTag = case _ of
  BalanceInsufficientError _ _ -> "BalanceInsufficientError"
  CouldNotConvertScriptOutputToTxInput -> "CouldNotConvertScriptOutputToTxInput"
  CouldNotGetCollateral -> "CouldNotGetCollateral"
  InsufficientCollateralUtxos _ -> "InsufficientCollateralUtxos"
  CouldNotGetUtxos -> "CouldNotGetUtxos"
  CollateralReturnError -> "CollateralReturnError"
  CollateralReturnMinAdaValueCalcError _ _ -> "CollateralReturnMinAdaValueCalcError"
  ExUnitsEvaluationFailed _ _ -> "ExUnitsEvaluationFailed"
  InsufficientUtxoBalanceToCoverAsset _ -> "InsufficientUtxoBalanceToCoverAsset"
  ReindexRedeemersError _ -> "ReindexRedeemersError"
  UtxoLookupFailedFor _ _ -> "UtxoLookupFailedFor"
  UtxoMinAdaValueCalculationFailed -> "UtxoMinAdaValueCalculationFailed"
  NumericOverflowError _ -> "NumericOverflowError"
  CouldNotComputeRefScriptsFee _ -> "CouldNotComputeRefScriptsFee"

unavailable :: forall a. String -> Aff (Either ClientError a)
unavailable what = pure $ Left $ ClientOtherError (what <> ": not available in the simulator")

-- The provider: UTxO lookups from the request, evaluation through its
-- callback, nothing else.
provider :: Request -> UtxoMap -> Provider
provider req known =
  { getDatumByHash: \_ -> unavailable "getDatumByHash"
  , getScriptByHash: \_ -> unavailable "getScriptByHash"
  , getTxAuxiliaryData: \_ -> pure $ Left $ GetTxMetadataClientError $ ClientOtherError "getTxAuxiliaryData: not available in the simulator"
  , getUtxoByOref: \oref -> pure $ Right $ Map.lookup oref known
  , getOutputAddressesByTxHash: \_ -> unavailable "getOutputAddressesByTxHash"
  , doesTxExist: \_ -> unavailable "doesTxExist"
  , utxosAt: \_ -> unavailable "utxosAt"
  , getChainTip: unavailable "getChainTip"
  , getCurrentEpoch: fail "getCurrentEpoch: not available in the simulator"
  , submitTx: \_ -> unavailable "submitTx"
  , evaluateTx: \tx _ -> do
      units <- liftEffect $ runEffectFn1 req.evaluate (toHex (encodeCbor tx))
      entries <- traverse entry units
      pure $ TxEvaluationR $ Right $ TxEvaluationResult $ Map.fromFoldable entries
  , getEraSummaries: unavailable "getEraSummaries"
  , getPoolIds: unavailable "getPoolIds"
  , getPubKeyHashDelegationsAndRewards: \_ _ -> unavailable "getPubKeyHashDelegationsAndRewards"
  , getValidatorHashDelegationsAndRewards: \_ _ -> unavailable "getValidatorHashDelegationsAndRewards"
  , getProposalById: \_ -> unavailable "getProposalById"
  , getVotesOnProposal: \_ -> unavailable "getVotesOnProposal"
  , getRegisteredDrepInfo: \_ -> unavailable "getRegisteredDrepInfo"
  }
  where
  entry u = do
    redeemerTag' <- redeemerTag u.tag
    memory <- bigNum "memory" u.memory
    steps <- bigNum "steps" u.steps
    pure $ { redeemerTag: redeemerTag', redeemerIndex: UInt.fromInt u.index } /\ { memory, steps }

run :: Request -> Aff Response
run req = do
  tx <- decodeHex "transaction" decodeCbor req.tx :: Aff Transaction
  wallet <- traverse (decodeHex "wallet UTxO" decodeCbor) req.walletUtxos
  extra <- traverse (decodeHex "extra UTxO" decodeCbor) req.extraUtxos
  collateral <- traverse (decodeHex "collateral UTxO" decodeCbor) req.collateral
  ownAddresses <- traverse address req.ownAddresses
  changeAddress <- address req.changeAddress
  txFeeFixed <- bigNum "txFeeFixed" req.pparams.txFeeFixed
  stakeAddressDeposit <- bigNum "stakeAddressDeposit" req.pparams.stakeAddressDeposit
  stakePoolDeposit <- bigNum "stakePoolDeposit" req.pparams.stakePoolDeposit
  coinsPerUtxoByte <- bigNum "coinsPerUtxoByte" req.pparams.coinsPerUtxoByte
  refScriptCoinsPerByte <- rational "refScriptCoinsPerByte" req.pparams.refScriptCoinsPerByte
  memPrice <- unitInterval "memPrice" req.pparams.memPrice
  stepPrice <- unitInterval "stepPrice" req.pparams.stepPrice
  let
    walletMap = utxoMap wallet
    extraMap = utxoMap extra
    known = Map.unions [ walletMap, extraMap, utxoMap collateral ]
    pparams =
      { txFeeFixed: Coin txFeeFixed
      , txFeePerByte: UInt.fromInt req.pparams.txFeePerByte
      , stakeAddressDeposit: Coin stakeAddressDeposit
      , stakePoolDeposit: Coin stakePoolDeposit
      , coinsPerUtxoByte: Coin coinsPerUtxoByte
      , costModels: Map.empty
      , prices: ExUnitPrices { memPrice, stepPrice }
      , maxCollateralInputs: UInt.fromInt req.pparams.maxCollateralInputs
      , refScriptCoinsPerByte
      }
  result <- runBalancerAff Error (Just \_ _ -> pure unit) tx
    { balancerConstraints: buildBalancerConfig mempty
    , provider: provider req known
    , pparams
    , network: if req.mainnet then MainnetId else TestnetId
    , walletInterface:
        { isCip30Wallet: true
        , ownAddresses
        , getWalletUtxos: pure $ Just $ Map.union walletMap (utxoMap collateral)
        , filterLockedUtxos: pure
        , getChangeAddress: pure changeAddress
        , getWalletCollateral: pure $ Just collateral
        }
    , extraUtxos: extraMap
    }
  pure case result of
    Right balanced -> { ok: true, tx: toHex (encodeCbor balanced), error: "", message: "" }
    Left e -> { ok: false, tx: "", error: errorTag e, message: explainBalanceTxError e }

balance :: Request -> Effect (Promise Response)
balance = fromAff <<< run

withVkeys :: String -> Array String -> String
withVkeys txHex vkeyHexes =
  case decodeCbor =<< fromHex txHex, traverse (\h -> decodeCbor =<< fromHex h) vkeyHexes of
    Just (Transaction tx), Just (vkeys :: Array Vkeywitness) ->
      let
        TransactionWitnessSet ws = tx.witnessSet
      in
        toHex $ encodeCbor $ Transaction tx { witnessSet = TransactionWitnessSet ws { vkeys = vkeys } }
    _, _ -> ""
