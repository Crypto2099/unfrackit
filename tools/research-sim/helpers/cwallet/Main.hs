-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean

{-# LANGUAGE DataKinds #-}
{-# LANGUAGE LambdaCase #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE TypeApplications #-}

-- | The cardano-wallet helper of the simulator's bridge (src/methods/helper.mjs,
-- schema 1): it reads one request per line on stdin, writes one response per
-- line on stdout, and exits at the end of its input. src/methods/cwallet.mjs
-- describes the method; this file is the call.
--
-- A build request runs cardano-balance-tx's 'balanceTx'
-- (cardano-balance-transaction at 8975773, lib/Cardano/Balance/Tx/Balance.hs:
-- 529-606) over cardano-coin-selection at 1766110, with the arguments
-- cardano-wallet gives it for a payment (cardano-wallet at f293d92,
-- lib/wallet/src/Cardano/Wallet.hs:2523-2578, called from the transaction
-- construction endpoint, lib/api/src/Cardano/Wallet/Api/Http/Shelley/
-- Server.hs:3167-3181):
--
--   * the protocol parameters: the run's, with the cost models, execution-unit
--     limit and protocol version a node would give (CostModels.hs);
--   * the time translation: the network's slot-to-time mapping
--     ('timeTranslation');
--   * the UTxO assumptions 'AllKeyPaymentCredentials', the wallet's for a
--     Shelley wallet (Wallet.hs:2553-2554; the wallet's balanceTx serves only
--     Shelley and shared wallets, :2529);
--   * the UTxO index of the wallet's spendable UTxOs ('constructUTxOIndex', as
--     the wallet's utxoIndexFromWalletUTxO);
--   * a change address generator that gives the request's change address for
--     every change output, with the 57-byte maximum length of the wallet's
--     Shelley generator ('changeAddressGen');
--   * the partial transaction: the requested outputs, the validity interval
--     the wallet's construction writes, and the replay's fixed parts
--     ('partialTxBytes'); its redeemers; the stake deposits of the
--     credentials it deregisters; no timelock witness counts.
--
-- The selection's draws come through 'MonadRandom'; the helper runs
-- 'balanceTx' in 'Rand StdGen' with the generator 'mkStdGen' makes from the
-- request's seed, so one seed gives one transaction.
--
-- A witness request writes the vkey witnesses it is given, and the intent's
-- bootstrap witnesses, into the witness set of the transaction last built.
module Main (main) where

import Cardano.Balance.Tx.Balance
    ( ChangeAddressGen (..)
    , ErrAssignRedeemers (..)
    , ErrBalanceTx (..)
    , ErrBalanceTxAssetsInsufficientError (..)
    , ErrBalanceTxInsufficientCollateralError (..)
    , ErrBalanceTxInternalError (..)
    , ErrBalanceTxOutputError (..)
    , ErrBalanceTxOutputErrorInfo (..)
    , ErrBalanceTxUnableToCreateChangeError (..)
    , PartialTx (..)
    , Redeemer (..)
    , StakeKeyDepositLookup (..)
    , UTxOAssumptions (..)
    , balanceTx
    , constructUTxOIndex
    , stakeCredentialsWithRefunds
    )
import Cardano.Balance.Tx.Eras
    ( Conway
    )
import Cardano.Balance.Tx.Primitive
    ( TxSize (..)
    )
import Cardano.Balance.Tx.Sign
    ( estimateKeyWitnessCounts
    )
import Cardano.Balance.Tx.TimeTranslation
    ( TimeTranslation
    , timeTranslationFromEpochInfo
    )
import Cardano.Balance.Tx.Tx
    ( KeyWitnessCounts (..)
    , PParams
    , Tx
    , TxOut
    , UTxO (..)
    , serializeTx
    )
import Cardano.Crypto.Hash
    ( hashFromBytes
    , hashToBytes
    )
import Cardano.Ledger.Api
    ( AccountAddress
    , Addr
    , BootstrapWitness
    , CoinPerByte (..)
    , Language (..)
    , WitVKey
    , addrTxWitsL
    , auxDataHashTxBodyL
    , auxDataTxL
    , bodyTxL
    , bootAddrTxWitsL
    , decodeAddr
    , deserialiseAccountAddress
    , serialiseAccountAddress
    , eraProtVerLow
    , emptyPParams
    , hashTxAuxData
    , ppCoinsPerUTxOByteL
    , ppCollateralPercentageL
    , ppCostModelsL
    , ppKeyDepositL
    , ppMaxCollateralInputsL
    , ppMaxTxExUnitsL
    , ppMaxTxSizeL
    , ppMaxValSizeL
    , ppPoolDepositL
    , ppPricesL
    , ppProtocolVersionL
    , referenceScriptTxOutL
    , witsTxL
    )
import Cardano.Ledger.Api.Tx
    ( TransactionScriptFailure (..)
    )
import Cardano.Ledger.BaseTypes
    ( ProtVer (..)
    , StrictMaybe (..)
    , boundRational
    , mkVersion64
    , strictMaybeToMaybe
    )
import Cardano.Ledger.Binary
    ( Version
    , decCBOR
    , decodeFull'
    , decodeFullAnnotator
    , serialize'
    )
import Cardano.Ledger.Coin
    ( Coin (..)
    )
import Cardano.Ledger.Compactible
    ( toCompactPartial
    )
import Cardano.Ledger.Conway.PParams
    ( ppDRepDepositL
    , ppGovActionDepositL
    , ppMinFeeRefScriptCostPerByteL
    )
import Cardano.Ledger.Core
    ( ppTxFeeFixedL
    , ppTxFeePerByteL
    )
import Cardano.Ledger.Hashes
    ( ScriptHash (..)
    , extractHash
    )
import Cardano.Ledger.TxIn
    ( TxId (..)
    , TxIn (..)
    )
import Cardano.Ledger.BaseTypes
    ( TxIx (..)
    )
import Cardano.Ledger.Keys
    ( KeyRole (..)
    )
import Cardano.Ledger.Mary.Value
    ( MaryValue (..)
    , MultiAsset (..)
    , PolicyID (..)
    )
import Cardano.Ledger.Plutus.CostModels
    ( mkCostModel
    , mkCostModels
    )
import Cardano.Ledger.Plutus.ExUnits
    ( ExUnits (..)
    , Prices (..)
    )
import Cardano.Slotting.EpochInfo
    ( fixedEpochInfo
    )
import Cardano.Slotting.Slot
    ( EpochSize (..)
    )
import Cardano.Slotting.Time
    ( SystemStart (..)
    , slotLengthFromSec
    )
import Codec.Binary.Bech32
    ( dataPartToBytes
    , decodeLenient
    )
import Control.Exception
    ( SomeException
    , displayException
    , evaluate
    , try
    )
import Control.Monad
    ( forM
    , unless
    )
import Control.Monad.Random
    ( evalRand
    )
import Control.Monad.Trans.Except
    ( runExceptT
    )
import CostModels
    ( NetworkData (..)
    , mainnetData
    , preprodData
    )
import Data.Aeson
    ( Object
    , Value (..)
    , eitherDecodeStrict
    , encode
    , object
    , (.:)
    , (.:?)
    , (.=)
    )
import Data.Aeson.Types
    ( Parser
    , parseEither
    )
import Data.Bits
    ( shiftL
    , shiftR
    , (.|.)
    )
import Data.IORef
    ( IORef
    , newIORef
    , readIORef
    , writeIORef
    )
import Data.List
    ( sortOn
    )
import Data.Map.Strict
    ( Map
    )
import Data.Maybe
    ( fromMaybe
    , isJust
    , isNothing
    )
import Data.Ratio
    ( (%)
    )
import Data.Text
    ( Text
    )
import Data.Time.Clock.POSIX
    ( posixSecondsToUTCTime
    )
import Data.Word
    ( Word64
    , Word8
    )
import PlutusLedgerApi.Common
    ( EvaluationError (..)
    )
import Lens.Micro
    ( (&)
    , (.~)
    , (^.)
    )
import System.Exit
    ( ExitCode (..)
    , exitWith
    )
import System.IO
    ( BufferMode (..)
    , hFlush
    , hIsEOF
    , hPutStrLn
    , hSetBuffering
    , stderr
    , stdin
    , stdout
    )
import System.Random
    ( StdGen
    , mkStdGen
    )

import qualified Data.Aeson.Key as Key
import qualified Data.ByteString as BS
import qualified Data.ByteString.Base16 as B16
import qualified Data.ByteString.Char8 as B8
import qualified Data.ByteString.Lazy as BL
import qualified Data.ByteString.Lazy.Char8 as BL8
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import qualified Data.Text as T
import qualified Data.Text.Encoding as TE

helperName :: String
helperName = "cwallet"

helperSchema :: Int
helperSchema = 1

--------------------------------------------------------------------------------
-- The helper's state
--------------------------------------------------------------------------------

-- | The decoded UTxO of every reference the helper has been sent (the bridge
-- sends a reference's bytes once per process), and the last transaction built.
data St = St
    { stUtxos :: IORef (Map Text (TxIn, TxOut Conway))
    , stLast :: IORef (Maybe Last)
    }

-- | What a witness request needs of the build before it: the transaction,
-- the UTxOs it spends and references (for the witness count its fee priced)
-- and the intent's bootstrap witnesses.
data Last = Last (Tx Conway) (UTxO Conway) [BootstrapWitness]

-- | A failure: a stage and the error text, or a part the library cannot
-- express.
data Failure
    = Failed String String
    | NotReplayable String String

--------------------------------------------------------------------------------
-- Main loop
--------------------------------------------------------------------------------

main :: IO ()
main = do
    hSetBuffering stdout LineBuffering
    st <- St <$> newIORef Map.empty <*> newIORef Nothing
    let loop = do
            eof <- hIsEOF stdin
            unless eof $ do
                line <- B8.hGetLine stdin
                unless (B8.all (`elem` (" \t\r" :: String)) line) $
                    case eitherDecodeStrict line of
                        Left e -> do
                            hPutStrLn stderr (helperName <> " helper: a request that is not JSON: " <> e)
                            exitWith (ExitFailure 2)
                        Right (Object q) -> do
                            r <- answer st q
                            BL8.putStrLn (encode r)
                            hFlush stdout
                        Right _ -> do
                            hPutStrLn stderr (helperName <> " helper: a request that is not a JSON object")
                            exitWith (ExitFailure 2)
                loop
    loop

answer :: St -> Object -> IO Value
answer st q = do
    let field :: (Object -> Parser a) -> Either String a
        field p = parseEither p q
        reqId = either (const Null) id (field (.: "id"))
        reply kvs = object (("id" .= reqId) : kvs)
    case (field (.:? "schema"), field (.:? "op")) of
        (Right (Just (s :: Int)), _)
            | s /= helperSchema ->
                pure $ reply ["ok" .= False, "error" .= ("schema " <> show s <> ", the helper's " <> show helperSchema)]
        (_, Right (Just ("build" :: Text))) -> do
            r <- try (build st q)
            pure $ case r of
                Left (e :: SomeException) ->
                    reply ["ok" .= False, "stage" .= ("balanceTx" :: String), "error" .= firstLine (displayException e)]
                Right (Left (Failed stage e)) ->
                    reply ["ok" .= False, "stage" .= stage, "error" .= e]
                Right (Left (NotReplayable part e)) ->
                    reply ["ok" .= False, "notReplayable" .= part, "error" .= e]
                Right (Right tx) ->
                    reply ["ok" .= True, "tx" .= tx]
        (_, Right (Just ("witness" :: Text))) -> do
            r <- try (witness st q)
            pure $ case r of
                Left (e :: SomeException) -> reply ["ok" .= False, "error" .= firstLine (displayException e)]
                Right (Left e) -> reply ["ok" .= False, "error" .= e]
                Right (Right (tx, unpriced)) ->
                    reply $ ["ok" .= True, "tx" .= tx] <> ["unpriced" .= unpriced | not (null unpriced)]
        (_, op) -> pure $ reply ["ok" .= False, "error" .= ("unknown op " <> either id show op)]

firstLine :: String -> String
firstLine = take 2000 . takeWhile (/= '\n')

--------------------------------------------------------------------------------
-- Build
--------------------------------------------------------------------------------

build :: St -> Object -> IO (Either Failure Text)
build st q = do
    writeIORef (stLast st) Nothing
    -- The wallet's spendable UTxOs, each decoded once per process and kept
    -- whatever becomes of this build, since the bridge sends a reference's
    -- bytes only once.
    known <- readIORef (stUtxos st)
    let utxoList = case parseEither (.: "utxos") q of
            Left _ -> []
            Right us -> [either (const ("", Nothing)) id (parseEither (\x -> (,) <$> x .: "ref" <*> x .:? "cbor") u) | u <- us :: [Object]]
    case decodeRefs "wallet UTxO" known utxoList of
        Left f -> pure (Left f)
        Right (known', walletPairs) -> do
            writeIORef (stUtxos st) known'
            either (pure . Left) (balance st) (prepare walletPairs q)

-- | The library's call, in 'Rand StdGen' seeded from the request.
balance :: St -> BuildArgs -> IO (Either Failure Text)
balance st b = case run of
    Left e -> case renderError e of
        NotReplayable part msg -> do
            _ <- evaluate (forceString msg)
            pure (Left (NotReplayable part msg))
        Failed stage msg -> do
            _ <- evaluate (forceString msg)
            pure (Left (Failed stage msg))
    Right (tx, ()) -> do
        let bytes = serializeTx tx
        _ <- evaluate (BS.length bytes)
        writeIORef (stLast st) (Just (Last tx (UTxO (Map.union (utxoMap (baExtra b)) (utxoMap (baIndex b)))) (baBootstrap b)))
        pure (Right (hexText bytes))
  where
    run =
        evalRand
            ( runExceptT $
                balanceTx
                    (baPParams b)
                    (baTime b)
                    AllKeyPaymentCredentials
                    (constructUTxOIndex (baIndex b))
                    (changeAddressGen (baChange b))
                    ()
                    (baPartial b)
            )
            (mkStdGen (fromIntegral (baSeed b)) :: StdGen)
    utxoMap (UTxO m) = m

forceString :: String -> String
forceString s = length (filter (== '\0') s) `seq` s

-- | Everything 'balanceTx' takes, read from a request.
data BuildArgs = BuildArgs
    { baPParams :: PParams Conway
    , baTime :: TimeTranslation
    , baIndex :: UTxO Conway
    , baExtra :: UTxO Conway
    , baChange :: Addr
    , baPartial :: PartialTx Conway
    , baSeed :: Word64
    , baBootstrap :: [BootstrapWitness]
    }

type Known = Map Text (TxIn, TxOut Conway)

prepare :: [(Text, (TxIn, TxOut Conway))] -> Object -> Either Failure BuildArgs
prepare walletPairs q = do
    let get :: (Object -> Parser a) -> String -> Either Failure a
        get p what = either (Left . Failed "request" . ((what <> ": ") <>)) Right (parseEither p q)
    network <- get (.: "network") "network"
    changeText <- get (.: "changeAddress") "changeAddress"
    outputsHex <- get (.: "outputs") "outputs"
    paramsObj <- get (.: "params") "params"
    seedText <- get (.:? "seed") "seed"
    at <- get (.: "at") "at"
    slot <- either (Left . Failed "request") Right (parseEither (\o -> o .:? "slot") at)
    intent <- get (.: "intent") "intent"
    fixedM <- either (Left . Failed "request") Right (parseEither (\o -> o .:? "fixed") intent)

    let fixedOf :: (Object -> Parser a) -> String -> Either Failure a
        fixedOf p what = case fixedM of
            Nothing -> either (Left . Failed "replay parts" . ((what <> ": ") <>)) Right (parseEither p mempty)
            Just f -> either (Left . Failed "replay parts" . ((what <> ": ") <>)) Right (parseEither p f)
    fixedInputs <- fixedOf (\o -> fromMaybe [] <$> o .:? "inputs") "inputs"
    referenceInputs <- fixedOf (\o -> fromMaybe [] <$> o .:? "referenceInputs") "referenceInputs"
    bodyFields <- fixedOf (\o -> fromMaybe mempty <$> o .:? "body") "body"
    witnessFields <- fixedOf (\o -> fromMaybe mempty <$> o .:? "witnesses") "witnesses"
    redeemerList <- fixedOf (\o -> fromMaybe [] <$> o .:? "redeemers") "redeemers"
    auxHex <- fixedOf (\o -> o .:? "auxiliaryData") "auxiliaryData"
    (_, fixedPairs) <- decodeRefs "fixed input" Map.empty [(r, Just c) | (r, c) <- map refCbor fixedInputs]
    (_, refPairs) <- decodeRefs "reference input" Map.empty [(r, Just c) | (r, c) <- map refCbor referenceInputs]

    -- Parts the library has no way to express.
    body <- forM (Map.toList (bodyFields :: Map Text Text)) $ \(k, v) -> do
        n <- maybe (Left (Failed "replay parts" ("body field " <> T.unpack k))) Right (readInt k)
        unless (n `elem` bodyKeysHeld) $
            Left (NotReplayable ("body field " <> show n) ("body field " <> show n <> ": the partial transaction holds no such field"))
        bytes <- unhex "replay parts" v
        pure (n, bytes)
    witnesses <- forM (Map.toList (witnessFields :: Map Text Text)) $ \(k, v) -> do
        n <- maybe (Left (Failed "replay parts" ("witness key " <> T.unpack k))) Right (readInt k)
        bytes <- unhex "replay parts" v
        pure (n, bytes)
    redeemers <- forM redeemerList (redeemerOf (Map.fromList [(r, i) | (r, (i, _)) <- fixedPairs]))
    bootstrap <- case lookup 2 witnesses of
        Nothing -> Right []
        Just bytes ->
            either (Left . Failed "replay parts" . ("bootstrap witnesses: " <>) . show) (Right . Set.toList) $
                decodeFull' @(Set.Set BootstrapWitness) version bytes

    -- The protocol parameters, the change address, the time.
    nd <- networkData network
    let refScriptHeld = any (\(_, (_, o)) -> isJust (strictMaybeToMaybe (o ^. referenceScriptTxOutL))) (walletPairs <> fixedPairs <> refPairs)
        needsPrices = not (null redeemers)
    pp <- pparams nd paramsObj refScriptHeld needsPrices
    change <- changeAddress changeText
    seed <- case seedText of
        Nothing -> Left (Failed "request" "a seed is required: the selection draws at random")
        Just s -> maybe (Left (Failed "request" ("seed " <> T.unpack s))) Right (readWord64 s)

    -- The partial transaction.
    outputs <- mapM (unhex "requested output") outputsHex
    aux <- traverse (unhex "replay parts") auxHex
    -- The validity interval of the wallet's transaction construction, for a
    -- spend it can construct: from slot 0 unless the intent names a start,
    -- until two hours after the spend's time unless it names an expiry. A
    -- spend with Plutus redeemers comes through the balance endpoint
    -- instead, whose transaction is the client's as sent.
    let validity
            | not (null redeemers) = []
            | otherwise =
                [(8, encUint 0) | isNothing (lookup 8 body)]
                    <> [(3, encUint (fromIntegral s + ttlSeconds)) | isNothing (lookup 3 body), Just (s :: Integer) <- [slot]]
        txBytes =
            partialTxBytes
                (map (fst . snd) fixedPairs)
                (map (fst . snd) refPairs)
                outputs
                (body <> validity)
                [(k, v) | (k, v) <- witnesses, k `elem` [1, 3, 4, 6, 7]]
                aux
    tx0 <- either (Left . Failed "replay parts" . ("the partial transaction: " <>) . show) Right $
        decodeFullAnnotator version "Tx" decCBOR (BL.fromStrict txBytes)
    let tx :: Tx Conway
        tx = case strictMaybeToMaybe (tx0 ^. auxDataTxL) of
            Nothing -> tx0
            Just a -> tx0 & bodyTxL . auxDataHashTxBodyL .~ SJust (hashTxAuxData a)
        refunds = stakeCredentialsWithRefunds tx
    deposits <-
        if Set.null refunds
            then Right Map.empty
            else do
                d <- needCoin paramsObj "keyDeposit"
                Right (Map.fromSet (const d) refunds)
    let extra = UTxO (Map.fromList (map snd (fixedPairs <> refPairs)))
        partial =
            PartialTx
                { tx = tx
                , extraUTxO = extra
                , redeemers = redeemers
                , stakeKeyDeposits = StakeKeyDepositMap deposits
                , timelockKeyWitnessCounts = mempty
                }
    pure
        BuildArgs
            { baPParams = pp
            , baTime = timeTranslation network
            , baIndex = UTxO (Map.fromList (map snd walletPairs))
            , baExtra = extra
            , baChange = change
            , baPartial = partial
            , baSeed = seed
            , baBootstrap = bootstrap
            }
  where
    refCbor :: Object -> (Text, Text)
    refCbor o = either (const ("", "")) id (parseEither (\x -> (,) <$> x .: "ref" <*> x .: "cbor") o)

-- | The body fields of the replay's fixed parts the partial transaction
-- holds (the bridge's schema: validity, certificates, withdrawals, mint,
-- required signers, votes, proposals, treasury value, donation).
bodyKeysHeld :: [Int]
bodyKeysHeld = [3, 4, 5, 8, 9, 14, 19, 20, 21, 22]

-- | The wallet's default time to live: the expiry slot two hours after the
-- current time (cardano-wallet Wallet.hs:3480-3496, transactionExpirySlot
-- with no TTL given; Server.hs:3505-3522), 7200 slots of one second. The
-- construction endpoint writes it, and the start of slot 0, on every
-- transaction it constructs (Server.hs:3003, mkValidityInterval at
-- lib/wallet/src/Cardano/Wallet/Shelley/Transaction/Unsigned.hs:466-472).
-- Its request has no redeemers (ApiConstructTransactionData, lib/api/src/
-- Cardano/Wallet/Api/Types.hs:1301-1313), so a dapp's
-- Plutus spend is balanced through the balance endpoint, which takes the
-- client's transaction with its redeemers and adds no validity interval
-- (Server.hs:3839-3902).
ttlSeconds :: Integer
ttlSeconds = 7200

version :: Version
version = eraProtVerLow @Conway

decodeRefs :: String -> Known -> [(Text, Maybe Text)] -> Either Failure (Known, [(Text, (TxIn, TxOut Conway))])
decodeRefs what known0 = go known0 []
  where
    go k acc [] = Right (k, reverse acc)
    go k acc ((ref, mcbor) : rest) = case mcbor of
        Nothing -> case Map.lookup ref k of
            Just p -> go k ((ref, p) : acc) rest
            Nothing -> Left (Failed "request" (what <> " " <> T.unpack ref <> ": no bytes were sent for it"))
        Just c -> do
            bytes <- unhex "request" c
            p <- either (Left . Failed "request" . (\e -> what <> " " <> T.unpack ref <> ": " <> show e)) Right $
                decodeFull' @(TxIn, TxOut Conway) version bytes
            go (Map.insert ref p k) ((ref, p) : acc) rest

-- | A redeemer of the replay as the library's 'Redeemer': a spend's, a
-- mint's or a withdrawal's. The type has no constructor for a certificate's,
-- a vote's or a proposal's (cardano-balance-transaction
-- lib/Cardano/Balance/Tx/Redeemers.hs:290-293), and 'balanceTx' replaces
-- every redeemer of the partial transaction with its own list (:174-177).
redeemerOf :: Map Text TxIn -> Object -> Either Failure Redeemer
redeemerOf inputs o = do
    let get :: (Object -> Parser a) -> String -> Either Failure a
        get p what = either (Left . Failed "replay parts" . (("redeemer " <> what <> ": ") <>)) Right (parseEither p o)
    tag <- get (.: "tag") "tag"
    target <- get (.: "target") "target"
    dataHex <- get (.: "data") "data"
    bytes <- unhex "replay parts" dataHex
    let tget :: (Object -> Parser a) -> String -> Either Failure a
        tget p what = either (Left . Failed "replay parts" . (("redeemer target " <> what <> ": ") <>)) Right (parseEither p target)
    case (tag :: Int) of
        0 -> do
            ref <- tget (.: "ref") "ref"
            i <- maybe (Left (Failed "replay parts" ("a spend redeemer of " <> T.unpack ref <> ", which is not a fixed input"))) Right (Map.lookup ref inputs)
            pure (RedeemerSpending bytes i)
        1 -> do
            p <- tget (.: "policy") "policy"
            h <- unhex "replay parts" p
            sh <- maybe (Left (Failed "replay parts" ("policy " <> T.unpack p))) Right (hashFromBytes h)
            pure (RedeemerMinting bytes (PolicyID (ScriptHash sh)))
        3 -> do
            a <- tget (.: "account") "account"
            h <- unhex "replay parts" a
            acct <- maybe (Left (Failed "replay parts" ("reward account " <> T.unpack a))) Right (deserialiseAccountAddress h :: Maybe AccountAddress)
            pure (RedeemerRewarding bytes acct)
        t ->
            Left $
                NotReplayable
                    "redeemers"
                    ( "a redeemer with tag "
                        <> show t
                        <> " ("
                        <> purpose t
                        <> "): the library's Redeemer type holds spends, mints and withdrawals only"
                    )
  where
    purpose = \case
        2 -> "a certificate"
        4 -> "a vote"
        5 -> "a proposal"
        _ -> "unknown"

-- | The partial transaction's bytes: the body (fixed inputs, requested
-- outputs, fee 0, the fixed fields and the validity interval, reference
-- inputs), the witness set's scripts and datums, valid, and the auxiliary
-- data. Its key witnesses are left out, since 'balanceTx' refuses a
-- transaction that has any (Balance.hs:1310-1343); the auxiliary data hash
-- is set after decoding.
partialTxBytes :: [TxIn] -> [TxIn] -> [BS.ByteString] -> [(Int, BS.ByteString)] -> [(Int, BS.ByteString)] -> Maybe BS.ByteString -> BS.ByteString
partialTxBytes ins refs outs fields wits aux =
    BS.concat
        [ cborHead 4 4
        , cborMap $
            sortOn fst $
                [ (0, cborSet (map (serialize' version) ins))
                , (1, BS.concat (cborHead 4 (fromIntegral (length outs)) : outs))
                , (2, encUint 0)
                ]
                    <> fields
                    <> [(18, cborSet (map (serialize' version) refs)) | not (null refs)]
        , cborMap wits
        , BS.singleton 0xf5
        , fromMaybe (BS.singleton 0xf6) aux
        ]

cborHead :: Word8 -> Word64 -> BS.ByteString
cborHead major n
    | n < 24 = BS.singleton (m .|. fromIntegral n)
    | n < 0x100 = BS.pack [m .|. 24, fromIntegral n]
    | n < 0x10000 = BS.pack ((m .|. 25) : be 2)
    | n < 0x100000000 = BS.pack ((m .|. 26) : be 4)
    | otherwise = BS.pack ((m .|. 27) : be 8)
  where
    m = major `shiftL` 5
    be :: Int -> [Word8]
    be k = [fromIntegral (n `shiftR` (8 * i)) | i <- [k - 1, k - 2 .. 0]]

encUint :: Integer -> BS.ByteString
encUint = cborHead 0 . fromIntegral

cborMap :: [(Int, BS.ByteString)] -> BS.ByteString
cborMap kvs = BS.concat (cborHead 5 (fromIntegral (length kvs)) : concat [[encUint (fromIntegral k), v] | (k, v) <- kvs])

cborSet :: [BS.ByteString] -> BS.ByteString
cborSet xs = BS.concat (cborHead 6 258 : cborHead 4 (fromIntegral (length xs)) : xs)

--------------------------------------------------------------------------------
-- Arguments
--------------------------------------------------------------------------------

networkData :: Text -> Either Failure NetworkData
networkData = \case
    "preprod" -> Right preprodData
    "mainnet" -> Right mainnetData
    "synthetic" -> Right mainnetData
    n -> Left (Failed "request" ("unknown network " <> T.unpack n))

-- | The run's protocol parameters as the ledger's, with the cost models, the
-- execution-unit limit and, where the run states none, the protocol version
-- of the network's snapshot (CostModels.hs). A parameter the run leaves
-- unstated is an error where the transaction needs it: the reference-script
-- price when a UTxO of the request carries a reference script, the prices of
-- execution units when it has redeemers.
pparams :: NetworkData -> Object -> Bool -> Bool -> Either Failure (PParams Conway)
pparams nd p refScriptHeld needsPrices = do
    minFeeA <- needCoin p "minFeeA"
    minFeeB <- needCoin p "minFeeB"
    coinsPerByte <- needCoin p "coinsPerUtxoByte"
    maxValSize <- needNat p "maxValSize"
    maxTxSize <- needNat p "maxTxSize"
    maxColl <- needNat p "maxCollateralInputs"
    collPct <- needNat p "collateralPercent"
    keyDeposit <- optCoin p "keyDeposit"
    poolDeposit <- optCoin p "poolDeposit"
    drepDeposit <- optCoin p "drepDeposit"
    govDeposit <- optCoin p "govActionDeposit"
    priceMem <- optRational p "priceMem"
    priceStep <- optRational p "priceStep"
    refPrice <- optRational p "minFeeRefScriptCostPerByte"
    major <- either (Left . Failed "params") Right (parseEither (.:? "protocolMajor") p)
    prices <- case (priceMem, priceStep) of
        (Just m, Just s) -> do
            m' <- maybe (Left (Failed "params" "priceMem")) Right (boundRational m)
            s' <- maybe (Left (Failed "params" "priceStep")) Right (boundRational s)
            Right (Just (Prices m' s'))
        _
            | needsPrices -> Left (Failed "params" "the prices of execution units are not stated for this run")
            | otherwise -> Right Nothing
    refCost <- case refPrice of
        Just r -> maybe (Left (Failed "params" "minFeeRefScriptCostPerByte")) (Right . Just) (boundRational r)
        Nothing
            | refScriptHeld -> Left (Failed "params" "protocol parameter minFeeRefScriptCostPerByte is not stated for this run")
            | otherwise -> Right Nothing
    pv <- maybe (Left (Failed "params" "protocol version")) Right $
        mkVersion64 (maybe (ndProtocolMajor nd) fromIntegral (major :: Maybe Integer))
    costModels <- either (Left . Failed "params" . ("cost models: " <>) . show) Right $ do
        v1 <- mkCostModel PlutusV1 (ndCostModelsV1 nd)
        v2 <- mkCostModel PlutusV2 (ndCostModelsV2 nd)
        v3 <- mkCostModel PlutusV3 (ndCostModelsV3 nd)
        pure (mkCostModels (Map.fromList [(PlutusV1, v1), (PlutusV2, v2), (PlutusV3, v3)]))
    let set' :: Maybe a -> (PParams Conway -> a -> PParams Conway) -> PParams Conway -> PParams Conway
        set' v f x = maybe x (f x) v
    pure $
        emptyPParams
            & ppTxFeePerByteL .~ CoinPerByte (toCompactPartial minFeeA)
            & ppTxFeeFixedL .~ minFeeB
            & ppCoinsPerUTxOByteL .~ CoinPerByte (toCompactPartial coinsPerByte)
            & ppMaxValSizeL .~ fromIntegral maxValSize
            & ppMaxTxSizeL .~ fromIntegral maxTxSize
            & ppMaxCollateralInputsL .~ fromIntegral maxColl
            & ppCollateralPercentageL .~ fromIntegral collPct
            & ppCostModelsL .~ costModels
            & ppMaxTxExUnitsL .~ ExUnits (ndMaxTxExMem nd) (ndMaxTxExSteps nd)
            & ppProtocolVersionL .~ ProtVer pv (if isJust major then 0 else fromIntegral (ndProtocolMinor nd))
            & set' keyDeposit (\x v -> x & ppKeyDepositL .~ v)
            & set' poolDeposit (\x v -> x & ppPoolDepositL .~ v)
            & set' drepDeposit (\x v -> x & ppDRepDepositL .~ v)
            & set' govDeposit (\x v -> x & ppGovActionDepositL .~ v)
            & set' prices (\x v -> x & ppPricesL .~ v)
            & set' refCost (\x v -> x & ppMinFeeRefScriptCostPerByteL .~ v)

needCoin :: Object -> String -> Either Failure Coin
needCoin p k = optCoin p k >>= maybe (Left (Failed "params" ("protocol parameter " <> k <> " is not stated for this run"))) Right

optCoin :: Object -> String -> Either Failure (Maybe Coin)
optCoin p k = do
    v <- either (Left . Failed "params") Right (parseEither (.:? fromStringKey k) p)
    case v of
        Nothing -> Right Nothing
        Just Null -> Right Nothing
        Just (String s) -> maybe (Left (Failed "params" k)) (Right . Just . Coin . fromIntegral) (readWord64 s)
        Just (Number n) -> Right (Just (Coin (truncate n)))
        Just _ -> Left (Failed "params" k)

needNat :: Object -> String -> Either Failure Integer
needNat p k = do
    c <- needCoin p k
    pure (unCoin c)

optRational :: Object -> String -> Either Failure (Maybe Rational)
optRational p k = do
    v <- either (Left . Failed "params") Right (parseEither (.:? fromStringKey k) p)
    case v of
        Nothing -> Right Nothing
        Just Null -> Right Nothing
        Just (Array _) -> do
            (n, d) <- either (Left . Failed "params") Right (parseEither (\x -> fromValuePair x) v)
            Right (Just (n % d))
        Just _ -> Left (Failed "params" k)
  where
    fromValuePair :: Maybe Value -> Parser (Integer, Integer)
    fromValuePair = \case
        Just (Array a) -> case foldr (:) [] a of
            [String n, String d] | Just n' <- readWord64 n, Just d' <- readWord64 d, d' /= 0 -> pure (fromIntegral n', fromIntegral d')
            _ -> fail k
        _ -> fail k

fromStringKey :: String -> Key.Key
fromStringKey = Key.fromString

-- | The network's slot-to-time mapping from its Shelley era on: slot s is at
-- t0 + (s - s0) seconds, where s0 is the first Shelley slot and t0 its time,
-- each derived from the network's Byron genesis (start time, 20-second slots,
-- 21,600-slot epochs) and the epoch its Shelley era began: preprod epoch 4,
-- slot 86,400 at 1,655,769,600 s (2022-06-21T00:00:00Z); mainnet epoch 208,
-- slot 4,492,800 at 1,596,059,091 s (2020-07-29T21:44:51Z), the values
-- src/methods/helios.mjs SHELLEY_START holds. As a fixed epoch info with
-- one-second slots it is a system start of t0 - s0. The synthetic shapes
-- take mainnet's. A node's era history would also bound it by the safe zone
-- ahead of the tip, which this mapping has not; it reaches the transaction
-- only through the validity interval a Plutus script's context sees.
timeTranslation :: Text -> TimeTranslation
timeTranslation network =
    timeTranslationFromEpochInfo
        (SystemStart (posixSecondsToUTCTime (fromIntegral (t0 - s0))))
        (fixedEpochInfo (EpochSize 432000) (slotLengthFromSec 1))
  where
    (s0, t0) :: (Integer, Integer) = case network of
        "preprod" -> (86400, 1655769600)
        _ -> (4492800, 1596059091)

-- | The change address for every change output; the dummy of the maximum
-- length is the wallet's for a Shelley wallet, 57 zero bytes
-- (cardano-wallet lib/address-derivation-discovery/lib/Cardano/Wallet/
-- Address/Constants.hs:61, used by defaultChangeAddressGen at
-- lib/wallet/src/Cardano/Wallet.hs:5362-5365).
changeAddressGen :: Addr -> ChangeAddressGen ()
changeAddressGen a = ChangeAddressGen (\s -> (a, s)) maxLengthAddress

maxLengthAddress :: Addr
maxLengthAddress = case decodeAddr (BS.replicate 57 0) of
    Just a -> a
    Nothing -> error "the 57-byte dummy address does not decode"

changeAddress :: Text -> Either Failure Addr
changeAddress t = case decodeLenient t of
    Left e -> Left (Failed "request" ("change address " <> T.unpack t <> ": " <> show e))
    Right (_, dp) -> case dataPartToBytes dp >>= decodeAddr of
        Just a -> Right a
        Nothing -> Left (Failed "request" ("change address " <> T.unpack t <> " does not decode"))

--------------------------------------------------------------------------------
-- Errors
--------------------------------------------------------------------------------

-- | The library's error, named by its constructor, which the method's table
-- classifies (src/methods/cwallet.mjs). A Plutus script that the ledger's
-- evaluator cannot decode as a program is not replayable: no evaluator can
-- run it, and an observed transaction cannot hold one (the synthetic shapes'
-- stand-in script is such bytes).
renderError :: ErrBalanceTx Conway -> Failure
renderError = \case
    ErrBalanceTxAssignRedeemers (ErrAssignRedeemersScriptFailure r (ValidationFailure _ (CodecError e) _ _)) ->
        NotReplayable "plutus scripts" ("the script of " <> purposeOf r <> " is not a program the ledger's evaluator can decode: " <> flat (show e))
    ErrBalanceTxAssignRedeemers (ErrAssignRedeemersScriptFailure r f) ->
        Failed "balanceTx" ("ErrBalanceTxAssignRedeemers: the script of " <> purposeOf r <> " fails in the built transaction: " <> scriptFailure f)
    e -> Failed "balanceTx" (renderOther e)

-- | What a redeemer redeems, for an error's text.
purposeOf :: Redeemer -> String
purposeOf = \case
    RedeemerSpending _ i -> "the spend of " <> showTxIn i
    RedeemerMinting _ (PolicyID (ScriptHash h)) -> "the mint under " <> T.unpack (hexText (hashToBytes h))
    RedeemerRewarding _ a -> "the withdrawal from " <> T.unpack (hexText (serialiseAccountAddress a))
  where
    showTxIn (TxIn (TxId h) (TxIx ix)) = T.unpack (hexText (hashToBytes (extractHash h))) <> "#" <> show ix

-- | A script failure as one line: the evaluation error and the script's
-- logs.
scriptFailure :: TransactionScriptFailure Conway -> String
scriptFailure = \case
    ValidationFailure _ e logs _ -> take 1500 (flat (show e)) <> (if null logs then "" else "; logs: " <> take 500 (T.unpack (T.intercalate " | " logs)))
    f -> take 1500 (flat (show f))

flat :: String -> String
flat = unwords . words

renderOther :: ErrBalanceTx Conway -> String
renderOther = \case
    ErrBalanceTxAssetsInsufficient (ErrBalanceTxAssetsInsufficientError _ _ (MaryValue (Coin c) (MultiAsset m))) ->
        "ErrBalanceTxAssetsInsufficient: shortfall " <> show c <> " lovelace and " <> show (sum (map Map.size (Map.elems m))) <> " assets"
    ErrBalanceTxMaxSizeLimitExceeded (TxSize s) (TxSize m) ->
        "ErrBalanceTxMaxSizeLimitExceeded: size " <> show s <> " over the limit " <> show m
    ErrBalanceTxExistingKeyWitnesses n ->
        "ErrBalanceTxExistingKeyWitnesses: " <> show n
    ErrBalanceTxExistingCollateral -> "ErrBalanceTxExistingCollateral"
    ErrBalanceTxExistingTotalCollateral -> "ErrBalanceTxExistingTotalCollateral"
    ErrBalanceTxExistingReturnCollateral -> "ErrBalanceTxExistingReturnCollateral"
    ErrBalanceTxInsufficientCollateral (ErrBalanceTxInsufficientCollateralError _ minimumAmount) ->
        "ErrBalanceTxInsufficientCollateral: minimum " <> show (unCoin minimumAmount)
    ErrBalanceTxAssignRedeemers e ->
        "ErrBalanceTxAssignRedeemers: " <> take 1500 (flat (show e))
    ErrBalanceTxInternalError (ErrUnderestimatedFee c _ _) ->
        "ErrBalanceTxInternalError: ErrUnderestimatedFee " <> show (unCoin c)
    ErrBalanceTxInternalError (ErrFailedBalancing v) ->
        "ErrBalanceTxInternalError: ErrFailedBalancing " <> firstLine (show v)
    ErrBalanceTxInputResolutionConflicts cs ->
        "ErrBalanceTxInputResolutionConflicts: " <> show (length cs)
    ErrBalanceTxUnresolvedInputs ins ->
        "ErrBalanceTxUnresolvedInputs: " <> firstLine (show ins)
    ErrBalanceTxUnresolvedRefunds cs ->
        "ErrBalanceTxUnresolvedRefunds: " <> firstLine (show cs)
    ErrBalanceTxOutputError (ErrBalanceTxOutputErrorOf ix info) ->
        "ErrBalanceTxOutputError: output " <> show ix <> ": " <> case info of
            ErrBalanceTxOutputAdaQuantityInsufficient c _ -> "ErrBalanceTxOutputAdaQuantityInsufficient: minimum " <> show (unCoin c)
            ErrBalanceTxOutputSizeExceedsLimit _ -> "ErrBalanceTxOutputSizeExceedsLimit"
            ErrBalanceTxOutputTokenQuantityExceedsLimit{} -> "ErrBalanceTxOutputTokenQuantityExceedsLimit"
    ErrBalanceTxUnableToCreateChange (ErrBalanceTxUnableToCreateChangeError _ short) ->
        "ErrBalanceTxUnableToCreateChange: shortfall " <> show (unCoin short)
    ErrBalanceTxUnableToCreateInput -> "ErrBalanceTxUnableToCreateInput"

--------------------------------------------------------------------------------
-- Witness
--------------------------------------------------------------------------------

-- | The last transaction built with the given vkey witnesses and the intent's
-- bootstrap witnesses in its witness set, and the parts its fee did not price:
-- more vkey witnesses than 'estimateKeyWitnessCounts' counted, or more
-- bootstrap witnesses.
witness :: St -> Object -> IO (Either String (Text, [Text]))
witness st q = do
    l <- readIORef (stLast st)
    pure $ do
        Last tx utxo boot <- maybe (Left "no transaction built") Right l
        vkeysHex <- parseEither (.: "vkeys") q
        observed <- parseEither (\o -> fromMaybe (0 :: Int) <$> o .:? "observed") q
        ws <- forM vkeysHex $ \h -> do
            b <- either (Left . ("not hex: " <>)) Right (B16.decode (TE.encodeUtf8 h))
            either (Left . show) Right (decodeFull' @(WitVKey Witness) version b)
        let tx' =
                tx
                    & witsTxL . addrTxWitsL .~ Set.fromList ws
                    & witsTxL . bootAddrTxWitsL .~ Set.fromList boot
            KeyWitnessCounts nKeys nBoot = estimateKeyWitnessCounts utxo tx mempty
            unpriced =
                ["observed vkey witnesses" | observed > 0, length ws > fromIntegral nKeys]
                    <> ["observed bootstrap witnesses" | length boot > fromIntegral nBoot]
        pure (hexText (serializeTx tx'), unpriced)

--------------------------------------------------------------------------------
-- Small helpers
--------------------------------------------------------------------------------

unhex :: String -> Text -> Either Failure BS.ByteString
unhex stage t = either (Left . Failed stage . ("not hex: " <>)) Right (B16.decode (TE.encodeUtf8 t))

hexText :: BS.ByteString -> Text
hexText = TE.decodeUtf8 . B16.encode

readInt :: Text -> Maybe Int
readInt t = case reads (T.unpack t) of
    [(n, "")] -> Just n
    _ -> Nothing

readWord64 :: Text -> Maybe Word64
readWord64 t
    | T.null t || T.any (`notElem` ['0' .. '9']) t = Nothing
    | otherwise =
        let n = read (T.unpack t) :: Integer
        in  if n <= fromIntegral (maxBound :: Word64) then Just (fromIntegral n) else Nothing

