-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean

{-# LANGUAGE OverloadedStrings #-}

-- | The Atlas helper of the simulator's bridge (src/methods/helper.mjs, schema
-- 1): it reads one request per line on stdin, writes one response per line on
-- stdout, and exits at the end of its input.
--
-- This is the helper's stub. It answers every request with a failure, and it
-- imports the entry points its adapter will call, so that the helper's
-- dependencies build before the adapter is written:
--
--   * 'buildTxBody' with a 'GYTxSkeleton' of 'mustHaveOutput's, run by
--     'runGYTxBuilderMonadIO' over 'GYProviders' that answer from the request
--     (atlas@62e37ab src/GeniusYield/TxBuilder/Class.hs:157-210, the default
--     call, which reaches buildTxCore in TxBuilder/Common.hs:233-355);
--   * 'buildUnsignedTxBody' with its 'GYBuildTxEnv' and the default
--     'GYCoinSelectionStrategy' (Transaction.hs:141-165,
--     Transaction/CoinSelection.hs:65-72), the balancing loop that call
--     reaches;
--   * 'evalRand' and 'mkStdGen', through which the adapter seeds the
--     random-improve selection's 'MonadRandom' draws from the request's seed.
module Main (main) where

import GeniusYield.Transaction
    ( GYBuildTxEnv (..)
    , GYBuildTxError (..)
    , GYCoinSelectionStrategy (..)
    , buildUnsignedTxBody
    )
import GeniusYield.TxBuilder
    ( GYTxSkeleton
    , buildTxBody
    , mustHaveOutput
    , runGYTxBuilderMonadIO
    )
import GeniusYield.Types
    ( GYNetworkId (..)
    , GYProviders (..)
    , GYTxBody
    , GYUTxOs
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
helperName = "atlas"

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
