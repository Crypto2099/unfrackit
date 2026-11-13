-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean

{-# LANGUAGE OverloadedStrings #-}

-- | The Kuber helper of the simulator's bridge (src/methods/helper.mjs, schema
-- 1): it reads one request per line on stdin, writes one response per line on
-- stdout, and exits at the end of its input.
--
-- This is the helper's stub. It answers every request with a failure, and it
-- imports the entry points of Kuber's public interface (Cardano.Kuber.Api)
-- that a payment goes through, so that the helper's dependencies build before
-- the adapter is written: a 'TxBuilder' of 'txPayTo' and 'txWalletAddress' or
-- 'txWalletUtxos' (kuber@2c55908 src/Cardano/Kuber/Core/TxBuilder.hs:367,
-- :588, :595), with 'txChangeAddress', built by 'kBuildTx' of 'HasKuberAPI'
-- and run by 'evaluateKontract' against a backend of 'HasChainQueryAPI' and
-- 'HasCardanoQueryApi'. 'kBuildTx' reaches the balancer through
-- executeTxBuilder and txBuilderToTxBody (Core/TxFramework.hs:307-311,
-- :321-329), which live in a module the package does not expose.
module Main (main) where

import Cardano.Kuber.Api
    ( FrameworkError (..)
    , HasCardanoQueryApi (..)
    , HasChainQueryAPI (..)
    , HasKuberAPI (..)
    , Kontract (..)
    , TxBuilder
    , evaluateKontract
    , txChangeAddress
    , txPayTo
    , txWalletAddress
    , txWalletUtxos
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

import qualified Data.ByteString.Char8 as B
import qualified Data.ByteString.Lazy.Char8 as BL

helperName :: String
helperName = "kuber"

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
