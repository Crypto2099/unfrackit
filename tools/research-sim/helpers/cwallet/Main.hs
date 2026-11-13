-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean

{-# LANGUAGE OverloadedStrings #-}

-- | The cardano-wallet helper of the simulator's bridge (src/methods/helper.mjs,
-- schema 1): it reads one request per line on stdin, writes one response per
-- line on stdout, and exits at the end of its input.
--
-- This is the helper's stub. It answers every request with a failure, and it
-- imports the entry points its adapter will call, so that the helper's
-- dependencies build before the adapter is written:
--
--   * 'balanceTx' (cardano-balance-tx, Cardano.Balance.Tx.Balance), the
--     balancing call cardano-wallet makes for a payment
--     (cardano-wallet@f293d92 lib/wallet/src/Cardano/Wallet.hs:2523-2570),
--     with the partial transaction, UTxO index, change generator and UTxO
--     assumptions it takes;
--   * 'performSelection' (cardano-coin-selection, Cardano.CoinSelection), the
--     selection 'balanceTx' runs;
--   * the time translation and transaction (de)serialization of
--     cardano-balance-tx;
--   * 'evalRand' and 'mkStdGen', through which the adapter seeds the
--     selection's 'MonadRandom' draws from the request's seed.
module Main (main) where

import Cardano.Balance.Tx.Balance
    ( ChangeAddressGen (..)
    , ErrBalanceTx (..)
    , PartialTx (..)
    , StakeKeyDepositLookup (..)
    , UTxOAssumptions (..)
    , UTxOIndex
    , balanceTx
    , constructUTxOIndex
    )
import Cardano.Balance.Tx.Eras
    ( Conway
    , IsRecentEra (..)
    , RecentEra (..)
    )
import Cardano.Balance.Tx.Sign
    ( TimelockKeyWitnessCounts (..)
    )
import Cardano.Balance.Tx.TimeTranslation
    ( TimeTranslation
    , timeTranslationFromEpochInfo
    )
import Cardano.Balance.Tx.Tx
    ( PParams
    , Tx
    , deserializeTx
    , serializeTx
    )
import Cardano.CoinSelection
    ( performSelection
    )
import Control.Monad.Random
    ( evalRand
    )
import Data.Aeson
    ( Value
    , eitherDecodeStrict
    , encode
    , object
    , withObject
    , (.:?)
    , (.=)
    )
import Data.Aeson.Types
    ( Parser
    , parseEither
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
    ( mkStdGen
    )

import qualified Data.ByteString.Char8 as B
import qualified Data.ByteString.Lazy.Char8 as BL

helperName :: String
helperName = "cwallet"

helperSchema :: Int
helperSchema = 1

data Request = Request
    { requestOp :: Maybe String
    , requestSchema :: Maybe Int
    , requestId :: Maybe Value
    }

parseRequest :: Value -> Parser Request
parseRequest = withObject "request" $ \o ->
    Request <$> o .:? "op" <*> o .:? "schema" <*> o .:? "id"

main :: IO ()
main = do
    hSetBuffering stdout LineBuffering
    loop
  where
    loop = do
        eof <- hIsEOF stdin
        if eof
            then pure ()
            else do
                line <- B.hGetLine stdin
                if B.null line
                    then loop
                    else case eitherDecodeStrict line >>= parseEither parseRequest of
                        Left e -> do
                            hPutStrLn stderr (helperName <> " helper: a request that is not JSON: " <> e)
                            exitWith (ExitFailure 2)
                        Right q -> do
                            BL.putStrLn (encode (answer q))
                            hFlush stdout
                            loop

-- | Every request fails: the adapter is not written yet.
answer :: Request -> Value
answer q =
    object
        [ "id" .= requestId q
        , "ok" .= False
        , "stage" .= ("helper" :: String)
        , "error" .= reason
        ]
  where
    reason :: String
    reason = case (requestSchema q, requestOp q) of
        (Just s, _)
            | s /= helperSchema ->
                "schema " <> show s <> ", the helper's " <> show helperSchema
        (_, Just op) ->
            "the " <> helperName <> " helper is a stub that builds nothing (op " <> op <> ")"
        (_, Nothing) ->
            "the " <> helperName <> " helper is a stub that builds nothing (no op)"
