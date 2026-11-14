-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean

{-# LANGUAGE DataKinds #-}
{-# LANGUAGE FlexibleContexts #-}
{-# LANGUAGE GADTs #-}
{-# LANGUAGE InstanceSigs #-}
{-# LANGUAGE LambdaCase #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE RankNTypes #-}
{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE TypeApplications #-}

-- | The Kuber helper of the simulator's bridge (src/methods/helper.mjs,
-- schema 1): it reads one request per line on stdin, writes one response per
-- line on stdout, and exits at the end of its input.
--
-- A build is Kuber's default call for a payment (kuber@2c55908
-- src/Cardano/Kuber/Core/TxBuilder.hs): a 'TxBuilder' of 'txPayTo' for each
-- requested output, the wallet's spendable UTxOs as 'txWalletUtxos', and
-- 'txChangeAddress' for the change address, run by Kuber's own runner
-- 'executeTxBuilder' (Core/TxFramework.hs:307-311), which is what 'kBuildTx'
-- runs for a node or chain-info backend (Core/KuberAPI.hs:43-62). The runner
-- queries its backend, fills deposits and governance roots
-- ('executeRawTxBuilder', :134-299) and calls the balancer
-- 'txBuilderToTxBody' (:321-329). The backend here is the request itself
-- ('Replay'): the run's protocol parameters, the network, the network's system
-- start and era history, and the UTxOs the request names; nothing reaches a
-- node. Kuber draws nothing at random.
--
-- The replay's fixed parts go through Kuber's own operations: its exported
-- builder functions where one exists, and otherwise its JSON form of a
-- builder (the Kuber server's request, Data/TxBuilderAeson.hs:55-166), decoded
-- by Kuber's own instance. A part neither can hold is answered
-- 'notReplayable', naming the part.
module Main (main) where

import Cardano.Api hiding (txAuxScripts, txCertificates, txFee)
import qualified Cardano.Api as Api
import qualified Cardano.Api.Ledger as L
import Cardano.Kuber.Api
import Cardano.Kuber.Core.TxFramework (executeTxBuilder)
import Cardano.Kuber.Data.Parsers (parseAddress, parseTxOut, parseUtxoCbor)
import qualified Cardano.Crypto.Hash as Crypto
import qualified Cardano.Ledger.Address as LA
import qualified Cardano.Ledger.Alonzo.Scripts as Alonzo
import qualified Cardano.Ledger.Api as Ledger
import qualified Cardano.Ledger.Conway.PParams as ConwayPP
import Cardano.Ledger.Core (TxLevel (TopTx))
import qualified Cardano.Ledger.Credential as LC
import qualified Cardano.Ledger.Hashes as LH
import qualified Cardano.Ledger.Mary.Value as Mary
import Ouroboros.Consensus.Cardano.Block (CardanoEras)
import Cardano.Slotting.Time (RelativeTime (..), mkSlotLength)
import qualified Codec.CBOR.Encoding as E
import qualified Codec.CBOR.Write as W
import Control.Exception (SomeException, evaluate, try)
import Control.Monad (forM, forM_, unless, when)
import Data.Aeson (object, (.=))
import qualified Data.Aeson as A
import qualified Data.Aeson.Key as AK
import qualified Data.Aeson.KeyMap as AKM
import Data.Aeson.Types (Pair, Parser, parseEither, parseMaybe)
import qualified Data.ByteString as BS
import qualified Data.ByteString.Base16 as B16
import qualified Data.ByteString.Char8 as B8
import qualified Data.ByteString.Lazy as BL
import qualified Data.ByteString.Lazy.Char8 as BL8
import qualified Data.ByteString.Short as SBS
import Data.Foldable (toList)
import Data.IORef
import Data.List (find, sortOn)
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import Data.Maybe (fromMaybe, isJust)
import qualified Data.SOP.NonEmpty as SOP
import qualified Data.Set as Set
import qualified Data.Text as T
import qualified Data.Text.Encoding as TE
import Data.Time.Clock.POSIX (posixSecondsToUTCTime)
import Data.Word (Word64)
import Lens.Micro ((&), (.~), (^.))
import qualified Ouroboros.Consensus.HardFork.History as History
import System.Exit (ExitCode (..), exitWith)
import System.IO

helperName :: String
helperName = "kuber"

helperSchema :: Int
helperSchema = 1

type UtxoMap = Map TxIn (TxOut CtxUTxO ConwayEra)

-- ---- The failures a build answers.

data Failure
  = -- | A part Kuber's operations cannot hold: the part, the reason.
    NotReplayable String String
  | -- | A failure at a stage: the stage, the error.
    Stage String String
  | -- | A failure the helper classifies itself: the class, the stage, the error.
    Classified String String String

type Build a = Either Failure a

stageOf :: String -> Either String a -> Build a
stageOf s = either (Left . Stage s) Right

notReplayable :: String -> String -> Build a
notReplayable p why = Left (NotReplayable p why)

-- ---- Hex and CBOR.

unhex :: Text -> Either String BS.ByteString
unhex t = B16.decode (TE.encodeUtf8 t)

hexText :: BS.ByteString -> Text
hexText = TE.decodeUtf8 . B16.encode

-- ---- The backend: the request as Kuber's chain query interface.

-- | Everything Kuber's runner asks its backend for, from the request.
data Replay = Replay
  { rpParams :: LedgerProtocolParameters ConwayEra
  , rpNetwork :: NetworkId
  , rpStart :: SystemStart
  , rpHistory :: EraHistory
  , rpUtxo :: UtxoMap
  , rpKeyDeposit :: L.Coin
  }

conwayOnly :: String -> Kontract Replay w FrameworkError a
conwayOnly what = kError EraMisMatch ("the replay answers " <> what <> " in the Conway era only")

instance HasChainQueryAPI Replay where
  kQueryProtocolParams :: forall era w. IsTxBuilderEra era => Kontract Replay w FrameworkError (LedgerProtocolParameters era)
  kQueryProtocolParams = do
    r <- kGetBackend
    case bCardanoEra @era of
      ConwayEra -> pure (rpParams r)
      _ -> conwayOnly "protocol parameters"
  kQueryUtxoByAddress :: forall era w. IsTxBuilderEra era => Set.Set AddressAny -> Kontract Replay w FrameworkError (UTxO era)
  kQueryUtxoByAddress addrs = do
    r <- kGetBackend
    case bCardanoEra @era of
      ConwayEra -> pure (UTxO (Map.filter (\(TxOut a _ _ _) -> Set.member (serialiseAddress a) (Set.map serialiseAddress addrs)) (rpUtxo r)))
      _ -> conwayOnly "UTxOs"
  kQueryUtxoByTxin :: forall era w. IsTxBuilderEra era => Set.Set TxIn -> Kontract Replay w FrameworkError (UTxO era)
  kQueryUtxoByTxin tins = do
    r <- kGetBackend
    case bCardanoEra @era of
      ConwayEra -> pure (UTxO (Map.restrictKeys (rpUtxo r) tins))
      _ -> conwayOnly "UTxOs"
  kQueryChainPoint = kError NodeQueryError "the replay has no chain point"

instance HasCardanoQueryApi Replay where
  kQuerySystemStart = rpStart <$> kGetBackend
  kGetNetworkId = rpNetwork <$> kGetBackend
  kQueryGenesisParams = kError NodeQueryError "the replay has no genesis parameters"
  kQueryCurrentEra = pure (AnyCardanoEra ConwayEra)
  kQueryEraHistory = rpHistory <$> kGetBackend
  -- Asked for a stake deregistration that states no refund: the key
  -- deposit, which is what a stake registration has cost on every network
  -- the study replays.
  kQueryStakeDeposit creds = do
    r <- kGetBackend
    pure (Map.fromSet (const (rpKeyDeposit r)) creds)
  kQueryDrepState _ = kError NodeQueryError "the replay has no DRep state"
  -- The runner reads the governance state for proposals only: the roots of
  -- earlier actions where a proposal names none, and the constitution's
  -- guardrail script where a proposal names none. A replayed proposal
  -- carries both as the chain accepted them, so the empty state leaves it
  -- as it was observed.
  kQueryGovState :: forall era w. IsTxBuilderEra era => Kontract Replay w FrameworkError (L.GovState (ShelleyLedgerEra era))
  kQueryGovState = case bCardanoEra @era of
    ConwayEra -> pure Ledger.emptyGovState
    _ -> conwayOnly "the governance state"
  kQueryDRepDistribution _ = kError NodeQueryError "the replay has no DRep distribution"

-- ---- The networks' system start and era history.

-- | The system start and era history of the run's network. Preprod's and
-- mainnet's are fixed data: the era bounds and parameters are Atlas's
-- (geniusyield/atlas@62e37ab src/GeniusYield/Providers/Common.hs:174-227 for
-- preprod, :284-337 for mainnet), whose preprod bounds up to Babbage equal
-- cardano-js-sdk's fixture (input-output-hk/cardano-js-sdk@48019e4
-- packages/core/test/util/slotCalc.test.ts:40-65), and the system starts are
-- the genesis start times, 2022-06-01T00:00:00Z for preprod (the same fixture,
-- :43) and 2017-09-23T21:44:51Z for mainnet (Shelley's start at slot 4492800
-- less Byron's 4492800 slots of 20 s). A synthetic run uses preprod's.
-- Kuber's balancer reads them only to turn a POSIX validity time into a slot
-- (the replay gives slots) and to evaluate scripts whose units are missing
-- (the replay gives every redeemer's units).
networkTime :: Text -> (SystemStart, EraHistory)
networkTime "mainnet" = (SystemStart (posixSecondsToUTCTime 1506203091), EraHistory (history mainnetEras))
networkTime _ = (SystemStart (posixSecondsToUTCTime 1654041600), EraHistory (history preprodEras))

-- | (start time s, start slot, start epoch, epoch size, slot length s, safe zone)
type EraRow = (Integer, Word64, Word64, Word64, Integer, Word64)

preprodEras :: [EraRow]
preprodEras =
  [ (0, 0, 0, 21600, 20, 4320)
  , (1728000, 86400, 4, 432000, 1, 129600)
  , (2160000, 518400, 5, 432000, 1, 129600)
  , (2592000, 950400, 6, 432000, 1, 129600)
  , (3024000, 1382400, 7, 432000, 1, 129600)
  , (5184000, 3542400, 12, 432000, 1, 129600)
  , (70416000, 68774400, 163, 432000, 1, 129600)
  ]

mainnetEras :: [EraRow]
mainnetEras =
  [ (0, 0, 0, 21600, 20, 4320)
  , (89856000, 4492800, 208, 432000, 1, 129600)
  , (101952000, 16588800, 236, 432000, 1, 129600)
  , (108432000, 23068800, 251, 432000, 1, 129600)
  , (125280000, 39916800, 290, 432000, 1, 129600)
  , (157680000, 72316800, 365, 432000, 1, 129600)
  , (219024000, 133660800, 507, 432000, 1, 129600)
  ]

-- | Byron to Conway, the last era unbounded.
history :: [EraRow] -> History.Interpreter (CardanoEras L.StandardCrypto)
history rows = case rows of
  [byron, shelley, allegra, mary, alonzo, babbage, conway] ->
    History.mkInterpreter
      . History.Summary
      . SOP.NonEmptyCons (era byron (Just shelley))
      . SOP.NonEmptyCons (era shelley (Just allegra))
      . SOP.NonEmptyCons (era allegra (Just mary))
      . SOP.NonEmptyCons (era mary (Just alonzo))
      . SOP.NonEmptyCons (era alonzo (Just babbage))
      . SOP.NonEmptyCons (era babbage (Just conway))
      $ SOP.NonEmptyOne (era conway Nothing)
  _ -> error "seven eras"
  where
    bound (t, s, e, _, _, _) = History.Bound (RelativeTime (fromInteger t)) (SlotNo s) (EpochNo e) History.NoPerasEnabled
    era row@(_, _, _, size, len, zone) next =
      History.EraSummary
        { History.eraStart = bound row
        , History.eraEnd = maybe History.EraUnbounded (History.EraEnd . bound) next
        , History.eraParams =
            History.EraParams
              { History.eraEpochSize = EpochSize size
              , History.eraSlotLength = mkSlotLength (fromInteger len)
              , History.eraSafeZone = History.StandardSafeZone zone
              , History.eraGenesisWin = fromIntegral zone
              , History.eraPerasRoundLength = History.NoPerasEnabled
              }
        }

-- ---- The request.

data Request = Request
  { qOp :: Maybe String
  , qSchema :: Maybe Int
  , qId :: Maybe A.Value
  , qBody :: A.Object
  }

parseRequest :: A.Value -> Parser Request
parseRequest = A.withObject "request" $ \o ->
  Request <$> o A..:? "op" <*> o A..:? "schema" <*> o A..:? "id" <*> pure o

field :: A.FromJSON a => A.Object -> Text -> Build a
field o k = case AKM.lookup (AK.fromText k) o of
  Nothing -> Left (Stage "request" ("no field " <> T.unpack k))
  Just v -> case A.fromJSON v of
    A.Success x -> Right x
    A.Error e -> Left (Stage "request" (T.unpack k <> ": " <> e))

optField :: A.FromJSON a => A.Object -> Text -> Build (Maybe a)
optField o k = case AKM.lookup (AK.fromText k) o of
  Nothing -> Right Nothing
  Just A.Null -> Right Nothing
  Just v -> case A.fromJSON v of
    A.Success x -> Right (Just x)
    A.Error e -> Left (Stage "request" (T.unpack k <> ": " <> e))

-- | An integer the bridge writes as a decimal string or a number.
intOf :: A.Value -> Maybe Integer
intOf (A.String s) = case reads (T.unpack s) of
  [(n, "")] -> Just n
  _ -> Nothing
intOf (A.Number n) = Just (round n)
intOf _ = Nothing

paramInt :: A.Object -> Text -> Build (Maybe Integer)
paramInt o k = case AKM.lookup (AK.fromText k) o of
  Nothing -> Right Nothing
  Just A.Null -> Right Nothing
  Just v -> maybe (Left (Stage "replay parts" ("protocol parameter " <> T.unpack k <> " is not an integer"))) (Right . Just) (intOf v)

paramRat :: A.Object -> Text -> Build (Maybe Rational)
paramRat o k = case AKM.lookup (AK.fromText k) o of
  Nothing -> Right Nothing
  Just A.Null -> Right Nothing
  Just (A.Array xs) | [a, b] <- toList xs, Just n <- intOf a, Just d <- intOf b, d /= 0 -> Right (Just (fromInteger n / fromInteger d))
  Just _ -> Left (Stage "replay parts" ("protocol parameter " <> T.unpack k <> " is not a rational"))

required :: Text -> Maybe a -> Build a
required k = maybe (Left (Stage "replay parts" ("protocol parameter " <> T.unpack k <> " is missing"))) Right

-- | The run's protocol parameters as Conway's. The fields Kuber's balancer
-- and cardano-api's body checks never read (block limits, pool and expansion
-- rates, cost models) keep their empty values; a parameter the run states
-- as null is zero, but for the protocol version, which is 10.
protocolParams :: A.Object -> Build (LedgerProtocolParameters ConwayEra)
protocolParams p = do
  minFeeA <- paramInt p "minFeeA" >>= required "minFeeA"
  minFeeB <- paramInt p "minFeeB" >>= required "minFeeB"
  perByte <- paramInt p "coinsPerUtxoByte" >>= required "coinsPerUtxoByte"
  maxVal <- paramInt p "maxValSize" >>= required "maxValSize"
  maxTx <- paramInt p "maxTxSize" >>= required "maxTxSize"
  maxColl <- paramInt p "maxCollateralInputs" >>= required "maxCollateralInputs"
  collPct <- paramInt p "collateralPercent" >>= required "collateralPercent"
  priceMem <- paramRat p "priceMem"
  priceStep <- paramRat p "priceStep"
  refCost <- paramRat p "minFeeRefScriptCostPerByte"
  keyDep <- paramInt p "keyDeposit"
  poolDep <- paramInt p "poolDeposit"
  drepDep <- paramInt p "drepDeposit"
  govDep <- paramInt p "govActionDeposit"
  major <- paramInt p "protocolMajor"
  ver <- maybe (Left (Stage "replay parts" "protocol version")) Right (L.mkVersion (fromMaybe 10 major))
  let nonNeg r = fromMaybe (error "a negative price") (L.boundRational r)
      pp =
        Ledger.emptyPParams @Ledger.ConwayEra
          & Ledger.ppTxFeePerByteL .~ L.CoinPerByte (L.toCompactPartial (L.Coin minFeeA))
          & Ledger.ppTxFeeFixedL .~ L.Coin minFeeB
          & Ledger.ppCoinsPerUTxOByteL .~ L.CoinPerByte (L.toCompactPartial (L.Coin perByte))
          & Ledger.ppMaxValSizeL .~ fromInteger maxVal
          & Ledger.ppMaxTxSizeL .~ fromInteger maxTx
          & Ledger.ppMaxCollateralInputsL .~ fromInteger maxColl
          & Ledger.ppCollateralPercentageL .~ fromInteger collPct
          & Ledger.ppPricesL .~ L.Prices (nonNeg (fromMaybe 0 priceMem)) (nonNeg (fromMaybe 0 priceStep))
          & ConwayPP.ppMinFeeRefScriptCostPerByteL .~ nonNeg (fromMaybe 0 refCost)
          & Ledger.ppKeyDepositL .~ L.Coin (fromMaybe 0 keyDep)
          & Ledger.ppPoolDepositL .~ L.Coin (fromMaybe 0 poolDep)
          & ConwayPP.ppDRepDepositL .~ L.Coin (fromMaybe 0 drepDep)
          & ConwayPP.ppGovActionDepositL .~ L.Coin (fromMaybe 0 govDep)
          & Ledger.ppProtocolVersionL .~ L.ProtVer ver 0
  Right (LedgerProtocolParameters pp)

-- ---- UTxOs, as Kuber parses them.

-- | A TransactionUnspentOutput [input, output] by Kuber's own parser.
utxoOf :: Text -> Either String (TxIn, TxOut CtxUTxO ConwayEra)
utxoOf h = do
  bs <- unhex h
  UTxO m <- parseUtxoCbor (BL.fromStrict bs)
  case Map.toList m of
    [x] -> Right x
    _ -> Left "expected one UTxO"

-- ---- Scripts and data.

scriptOfAny :: ScriptInAnyLang -> TxScript
scriptOfAny (ScriptInAnyLang _ s) = case s of
  SimpleScript ss -> TxScriptSimple ss
  PlutusScript PlutusScriptV1 ps -> TxScriptPlutus (TxPlutusScriptV1 ps)
  PlutusScript PlutusScriptV2 ps -> TxScriptPlutus (TxPlutusScriptV2 ps)
  PlutusScript PlutusScriptV3 ps -> TxScriptPlutus (TxPlutusScriptV3 ps)
  PlutusScript _ _ -> error "a Plutus script of a language Conway does not have"

-- | A ledger script of the observed witness set, as Kuber's script type.
txScriptOfLedger :: Ledger.Script Ledger.ConwayEra -> TxScript
txScriptOfLedger s = case fromShelleyBasedScript ShelleyBasedEraConway s of
  ScriptInEra _ sc -> scriptOfAny (toScriptInAnyLang sc)

-- | A Plutus script as Kuber's JSON form takes it (Data/TxBuilderAeson.hs:
-- 438-463): its type and its CBOR.
plutusJson :: TxPlutusScript -> A.Value
plutusJson = \case
  TxPlutusScriptV1 ps -> object ["type" .= ("PlutusScriptV1" :: Text), "cborHex" .= hexText (serialiseToCBOR ps)]
  TxPlutusScriptV2 ps -> object ["type" .= ("PlutusScriptV2" :: Text), "cborHex" .= hexText (serialiseToCBOR ps)]
  TxPlutusScriptV3 ps -> object ["type" .= ("PlutusScriptV3" :: Text), "cborHex" .= hexText (serialiseToCBOR ps)]

scriptJson :: TxScript -> A.Value
scriptJson (TxScriptPlutus p) = plutusJson p
scriptJson (TxScriptSimple s) = A.toJSON s

hashableOf :: Text -> Either String HashableScriptData
hashableOf h = do
  bs <- unhex h
  either (Left . show) Right (deserialiseFromCBOR AsHashableScriptData bs)

exUnitsOf :: [A.Value] -> Either String ExecutionUnits
exUnitsOf [m, s] | Just mem <- intOf m, Just steps <- intOf s = Right (ExecutionUnits (fromInteger steps) (fromInteger mem))
exUnitsOf _ = Left "expected [mem, steps]"

exUnitsJson :: ExecutionUnits -> A.Value
exUnitsJson (ExecutionUnits steps mem) = object ["steps" .= steps, "memory" .= mem]

isUnitRedeemer :: HashableScriptData -> Bool
isUnitRedeemer d = getScriptData d == ScriptDataConstructor 0 []

-- ---- The replay's fixed parts.

data Redeemer = Redeemer
  { rdKind :: Text
  , rdTarget :: A.Object
  , rdData :: HashableScriptData
  , rdUnits :: ExecutionUnits
  }

redeemerOf :: A.Value -> Build Redeemer
redeemerOf = \case
  A.Object o -> do
    target <- field o "target"
    kind <- field target "kind"
    d <- field o "data" >>= stageOf "replay parts" . hashableOf
    units <- field o "exUnits" >>= stageOf "replay parts" . exUnitsOf
    Right (Redeemer kind target d units)
  _ -> Left (Stage "replay parts" "a redeemer that is not an object")

targetText :: Redeemer -> Text -> Maybe Text
targetText r k = parseMaybe (A..: AK.fromText k) (rdTarget r)

targetInt :: Redeemer -> Text -> Maybe Int
targetInt r k = parseMaybe (A..: AK.fromText k) (rdTarget r)

-- | The observed fixed parts, read by cardano-api from a transaction made of
-- them: the fixed body fields with no inputs, outputs or fee, the fixed
-- witness set and the auxiliary data, each as its observed bytes.
observedTx :: A.Object -> Build (Ledger.Tx TopTx Ledger.ConwayEra)
observedTx fixed = do
  body <- fromMaybe Map.empty <$> optField fixed "body" :: Build (Map Text Text)
  wits <- fromMaybe Map.empty <$> optField fixed "witnesses" :: Build (Map Text Text)
  aux <- optField fixed "auxiliaryData" :: Build (Maybe Text)
  let entries m = forM (Map.toList m) $ \(k, v) -> do
        n <- maybe (Left (Stage "replay parts" ("a field key " <> T.unpack k))) Right (intOf (A.String k))
        bs <- stageOf "replay parts" (unhex v)
        Right (n, bs)
  bodyFields <- entries body
  witFields <- entries wits
  auxBytes <- traverse (stageOf "replay parts" . unhex) aux
  let mapOf kvs = E.encodeMapLen (fromIntegral (length kvs)) <> mconcat [E.encodeInteger k <> E.encodePreEncoded v | (k, v) <- sortOn fst kvs]
      emptyParts = [(0, W.toStrictByteString (E.encodeListLen 0)), (1, W.toStrictByteString (E.encodeListLen 0)), (2, W.toStrictByteString (E.encodeWord 0))]
      bytes =
        W.toStrictByteString $
          E.encodeListLen 4
            <> mapOf (emptyParts ++ bodyFields)
            <> mapOf witFields
            <> E.encodeBool True
            <> maybe E.encodeNull E.encodePreEncoded auxBytes
  case deserialiseFromCBOR (AsTx AsConwayEra) bytes of
    Left e -> Left (Stage "replay parts" ("the fixed parts do not decode: " <> show e))
    Right (ShelleyTx _ tx) -> Right tx

-- | The intent's fixed parts as one builder, and what the transaction Kuber
-- builds must carry of them.
data Fixed = Fixed
  { fxBuilder :: TxBuilder
  , fxJson :: [(Text, [A.Value])]
  , fxObserved :: Maybe (Ledger.Tx TopTx Ledger.ConwayEra)
  , fxUtxo :: UtxoMap
  , fxDatums :: Map BS.ByteString HashableScriptData
  }

noFixed :: Fixed
noFixed = Fixed mempty [] Nothing Map.empty Map.empty

txInText :: TxIn -> Text
txInText = renderTxIn

govIdText :: L.GovActionId -> Text
govIdText (L.GovActionId (L.TxId h) (L.GovActionIx ix)) = hashHex (L.extractHash h) <> "#" <> T.pack (show ix)

hashHex :: Crypto.Hash h a -> Text
hashHex = hexText . Crypto.hashToBytes

-- | The redeemer target of an input reference.
withFixedParts :: A.Object -> Build Fixed
withFixedParts fixed = do
  inputs <- fromMaybe [] <$> optField fixed "inputs" :: Build [A.Object]
  refs <- fromMaybe [] <$> optField fixed "referenceInputs" :: Build [A.Object]
  redeemers <- fromMaybe [] <$> optField fixed "redeemers" >>= mapM redeemerOf
  wits <- fromMaybe Map.empty <$> optField fixed "witnesses" :: Build (Map Text Text)
  when (Map.member "2" wits) $ notReplayable "bootstrap witnesses" "a bootstrap witness: Kuber writes no witness of its own but the key witnesses of its signing keys (TxFramework.hs:522-527), and the helper writes vkey witnesses only"
  forM_ (Map.keys wits) $ \k -> unless (k `elem` ["0", "1", "2", "3", "4", "5", "6", "7"]) $ notReplayable ("witness set key " <> T.unpack k) ("witness set key " <> T.unpack k <> ": no operation of Kuber writes it")
  tx <- observedTx fixed
  let body = tx ^. Ledger.bodyTxL
      ws = tx ^. Ledger.witsTxL
      scripts = Map.mapKeys fromShelleyScriptHash (ws ^. Ledger.scriptTxWitsL)
      datums = Ledger.unTxDats (ws ^. Ledger.datsTxWitsL)
  -- The fixed and reference inputs, parsed as Kuber parses a UTxO.
  fixedUtxos <- forM inputs $ \x -> do
    c <- field x "cbor"
    stageOf "replay parts" (utxoOf c)
  refUtxos <- forM refs $ \x -> do
    c <- field x "cbor"
    stageOf "replay parts" (utxoOf c)
  let utxo = Map.fromList (fixedUtxos ++ refUtxos)
      refScriptAt h = find (\(_, TxOut _ _ _ rs) -> case rs of ReferenceScript _ (ScriptInAnyLang _ s) -> hashScript s == h; _ -> False) (fixedUtxos ++ refUtxos)
      byInput = Map.fromList [(t, r) | r <- redeemers, rdKind r == "input", Just t <- [targetText r "ref"]]
      byPolicy = Map.fromList [(t, r) | r <- redeemers, rdKind r == "policy", Just t <- [targetText r "policy"]]
      byProposal = Map.fromList [(t, r) | r <- redeemers, rdKind r == "proposal", Just t <- [targetInt r "index"]]
  forM_ redeemers $ \r -> case rdKind r of
    "certificate" -> notReplayable "plutus" "a certificate's redeemer: Kuber writes every certificate without a witness (TxFramework.hs:392-415)"
    "withdrawal" -> notReplayable "withdrawals" "a withdrawal's redeemer: Kuber's builder has no withdrawals (TxFramework.hs:439)"
    "voter" -> notReplayable "plutus" "a vote's redeemer: Kuber writes votes without witnesses (TxFramework.hs:453-459)"
    _ -> Right ()
  -- Fixed inputs.
  inputParts <- forM fixedUtxos $ \(tin, tout@(TxOut addr _ datum _)) ->
    case toShelleyAddr addr of
      LA.AddrBootstrap _ -> Right (txConsumeUtxo tin tout)
      LA.Addr _ (LC.KeyHashObj _) _ -> Right (txConsumeUtxo tin tout)
      LA.Addr _ (LC.ScriptHashObj sh) _ -> do
        let h = fromShelleyScriptHash sh
        case Map.lookup (txInText tin) byInput of
          Nothing -> case Map.lookup h scripts of
            Just (Alonzo.NativeScript _) -> notReplayable "native script input" "an input locked by a native script of the witness set: Kuber's inputs carry a key witness or a Plutus script (TxBuilder.hs:53-64, TxFramework.hs:1081-1104)"
            _ -> Right (txConsumeUtxo tin tout)
          Just r -> do
            d <- case datum of
              TxOutDatumHash _ dh -> case find (\(k, _) -> L.hashToBytes (L.extractHash k) == serialiseToRawBytes dh) (Map.toList datums) of
                Just (_, dt) -> Right (Just (fromAlonzoData dt))
                Nothing -> Right Nothing
              _ -> Right Nothing
            case Map.lookup h scripts of
              Just s | TxScriptPlutus p <- txScriptOfLedger s ->
                Right $ case d of
                  Just dt -> txRedeemUtxoWithDatum tin tout p dt (rdData r) (Just (rdUnits r))
                  Nothing -> txRedeemUtxo tin tout p (rdData r) (Just (rdUnits r))
              Just _ -> notReplayable "native script input" "a redeemer for an input locked by a native script"
              Nothing -> case refScriptAt h of
                Just (refIn, _) -> Right $ case d of
                  Just dt -> txRedeemUtxoWithDatumAndReferenceScript refIn tin tout dt (rdData r) (Just (rdUnits r))
                  Nothing -> txRedeemUtxoWithReferenceScript refIn tin tout (rdData r) (Just (rdUnits r))
                Nothing -> Left (Stage "replay parts" ("no script for the input " <> T.unpack (txInText tin)))
  -- Every redeemer serves a part the intent holds.
  let inputRefs = Set.fromList [txInText tin | (tin, _) <- fixedUtxos]
      policies = Set.fromList [hashHex h | L.PolicyID (LH.ScriptHash h) <- Map.keys (let L.MultiAsset m = body ^. Ledger.mintTxBodyL in m)]
      proposalCount = length (toList (body ^. Ledger.proposalProceduresTxBodyL))
  forM_ (Map.keys byInput) $ \k -> unless (Set.member k inputRefs) $ Left (Stage "replay parts" ("a redeemer for " <> T.unpack k <> ", which is not a fixed input"))
  forM_ (Map.keys byPolicy) $ \k -> unless (Set.member k policies) $ Left (Stage "replay parts" ("a redeemer for the policy " <> T.unpack k <> ", which the mint does not hold"))
  forM_ (Map.keys byProposal) $ \k -> unless (k >= 0 && k < proposalCount) $ Left (Stage "replay parts" ("a redeemer for proposal " <> show k <> ", which the intent does not hold"))
  let refParts = [txReferenctUtxo tin tout | (tin, tout) <- refUtxos]
  -- Validity.
  let Ledger.ValidityInterval before after = body ^. Ledger.vldtTxBodyL
      validity = maybe mempty txValidFromSlot (L.strictMaybeToMaybe before) <> maybe mempty txValidUntilSlot (L.strictMaybeToMaybe after)
  -- Certificates.
  certParts <- forM (toList (body ^. Ledger.certsTxBodyL)) $ \c ->
    case Ledger.getScriptWitnessTxCert c of
      Just _ -> notReplayable "script certificate" "a certificate with a script credential: Kuber writes every certificate without a witness (TxFramework.hs:392-415)"
      Nothing -> Right (txCertificate (ConwayCertificate ConwayEraOnwardsConway c))
  -- Withdrawals, treasury value, donation.
  unless (Map.null (Ledger.unWithdrawals (body ^. Ledger.withdrawalsTxBodyL))) $ notReplayable "withdrawals" "Kuber's builder has no withdrawals (TxBuilder.hs:169-186) and its balancer writes none (TxFramework.hs:439)"
  when (isJust (L.strictMaybeToMaybe (body ^. Ledger.currentTreasuryValueTxBodyL))) $ notReplayable "treasury value" "the current treasury value: Kuber's balancer writes none (TxFramework.hs:447)"
  when (body ^. Ledger.treasuryDonationTxBodyL /= mempty) $ notReplayable "donation" "a treasury donation: Kuber's balancer writes none (TxFramework.hs:449)"
  -- Required signers.
  let signers = [A.String (hashHex (L.unKeyHash kh)) | kh <- Set.toList (body ^. Ledger.reqSignerHashesTxBodyL)]
  -- Mint.
  let L.MultiAsset mint = body ^. Ledger.mintTxBodyL
  mintParts <- forM (Map.toList mint) $ \(L.PolicyID sh@(LH.ScriptHash shHash), assets) -> do
    let h = fromShelleyScriptHash sh
        amount = object [AK.fromText (hexText (SBS.fromShort (Mary.assetNameBytes n))) .= q | (n, q) <- Map.toList assets]
        policyHex = hashHex shHash
        withRedeemer r base = base ++ ["redeemer" .= scriptDataToJsonDetailedSchema (rdData r), "executionUnits" .= exUnitsJson (rdUnits r)]
    case (Map.lookup policyHex byPolicy, Map.lookup h scripts, refScriptAt h) of
      (Just r, Just s, _) | TxScriptPlutus p <- txScriptOfLedger s -> Right (Right (object (withRedeemer r ["script" .= plutusJson p, "amount" .= amount])))
      (Just r, Nothing, Just (refIn, _)) -> Right (Right (object (withRedeemer r ["script" .= txInText refIn, "amount" .= amount])))
      (Nothing, Just s, _) | TxScriptSimple ss <- txScriptOfLedger s -> do
        names <- forM (Map.toList assets) $ \(n, q) -> either (Left . Stage "replay parts" . show) (\a -> Right (a, Quantity q)) (deserialiseFromRawBytes AsAssetName (SBS.fromShort (Mary.assetNameBytes n)))
        Right (Left (txMintSimpleScript ss names))
      (Nothing, Nothing, Just (refIn, _)) -> Right (Right (object ["script" .= txInText refIn, "amount" .= amount]))
      _ -> Left (Stage "replay parts" ("no script or redeemer for the policy " <> T.unpack policyHex))
  -- Votes.
  let L.VotingProcedures votes = body ^. Ledger.votingProceduresTxBodyL
  voteJson <- fmap concat . forM (Map.toList votes) $ \(voter, byAction) -> do
    (voterHex, role) <- case voter of
      L.DRepVoter c -> Right (credHex c, "drep" :: Text)
      L.CommitteeVoter c -> Right (credHex c, "committee")
      L.StakePoolVoter kh -> Right (hashHex (L.unKeyHash kh), "pool")
    Right
      [ object $
          [ "proposal" .= govIdText gid
          , "vote" .= (case vote of L.VoteYes -> "yes"; L.VoteNo -> "no"; L.Abstain -> "abstain" :: Text)
          , "voter" .= voterHex
          , "role" .= role
          ]
            ++ maybe [] (\a -> ["anchor" .= anchorJson a]) (L.strictMaybeToMaybe anchor)
      | (gid, L.VotingProcedure vote anchor) <- Map.toList byAction
      ]
  -- Proposals.
  proposalJson <- forM (zip [0 ..] (toList (body ^. Ledger.proposalProceduresTxBodyL))) $ \(i, pp) -> do
    forM_ (Map.lookup i byProposal) $ \r ->
      unless (isUnitRedeemer (rdData r)) $ notReplayable "plutus" "a proposal's redeemer other than the unit: Kuber's proposal witness always carries the unit redeemer (TxFramework.hs:1187, :1223, :1246)"
    base <- proposalBase pp
    case Map.lookup i byProposal of
      Nothing -> Right (object base)
      Just r -> do
        script <- case proposalScript pp of
          Nothing -> Left (Stage "replay parts" "a redeemer for a proposal with no guardrail script")
          Just h -> case (Map.lookup h scripts, refScriptAt h) of
            (Just s, _) | TxScriptPlutus p <- txScriptOfLedger s -> Right (plutusJson p)
            (_, Just (refIn, _)) -> Right (A.String (txInText refIn))
            _ -> Left (Stage "replay parts" "no script for a proposal's redeemer")
        Right (object (base ++ ["script" .= script, "executionUnits" .= exUnitsJson (rdUnits r)]))
  -- Auxiliary data.
  auxParts <- case L.strictMaybeToMaybe (tx ^. Ledger.auxDataTxL) of
    Nothing -> Right mempty
    Just ad -> do
      let md = ad ^. Ledger.metadataTxAuxDataL
          natives = [TxScriptSimple s | ScriptInEra _ (SimpleScript s) <- map (fromShelleyBasedScript ShelleyBasedEraConway . Alonzo.NativeScript) (toList (ad ^. Ledger.nativeScriptsTxAuxDataL))]
      plutus <- auxPlutus ad
      json <- case metadataToJson TxMetadataJsonNoSchema (TxMetadata (fromShelleyMetadata md)) of
        A.Object o -> forM (AKM.toList o) $ \(k, v) -> case reads (T.unpack (AK.toText k)) of
          [(n, "")] -> Right (n :: Word64, v)
          _ -> Left (Stage "replay parts" "a metadata label")
        _ -> Left (Stage "replay parts" "metadata")
      Right (mempty {txMetadata' = Map.fromList json, txAuxScripts = natives ++ plutus})
  let builder =
        mconcat inputParts
          <> mconcat refParts
          <> validity
          <> mconcat certParts
          <> mconcat [b | Left b <- mintParts]
          <> auxParts
      json =
        [("signatures", signers) | not (null signers)]
          ++ [("mint", [v | Right v <- mintParts]) | not (null [() | Right _ <- mintParts])]
          ++ [("votes", voteJson) | not (null voteJson)]
          ++ [("proposals", proposalJson) | not (null proposalJson)]
  Right (Fixed builder json (Just tx) utxo (Map.fromList [(L.hashToBytes (L.extractHash k), fromAlonzoData d) | (k, d) <- Map.toList datums]))
  where
    credHex :: LC.Credential kr -> Text
    credHex (LC.KeyHashObj kh) = hashHex (L.unKeyHash kh)
    credHex (LC.ScriptHashObj (LH.ScriptHash h)) = "10" <> hashHex h

anchorJson :: L.Anchor -> A.Value
anchorJson (L.Anchor url h) = object ["url" .= L.urlToText url, "dataHash" .= hashHex (L.extractHash h)]

proposalScript :: L.ProposalProcedure Ledger.ConwayEra -> Maybe ScriptHash
proposalScript (L.ProposalProcedure _ _ ga _) = case ga of
  L.ParameterChange _ _ (L.SJust sh) -> Just (fromShelleyScriptHash sh)
  L.TreasuryWithdrawals _ (L.SJust sh) -> Just (fromShelleyScriptHash sh)
  _ -> Nothing

-- | A proposal in Kuber's JSON form (Data/Models.hs:819-907), for the kinds
-- this helper writes in it: an info action, no confidence, a hard fork, a
-- treasury withdrawal, a parameter change, a committee update and a new
-- constitution.
proposalBase :: L.ProposalProcedure Ledger.ConwayEra -> Build [Pair]
proposalBase pp@(L.ProposalProcedure (L.Coin dep) acct ga anchor) = do
  let common = ["deposit" .= dep, "refundAccount" .= hexText (LA.serialiseAccountAddress acct), "anchor" .= anchorJson anchor]
      prev :: L.StrictMaybe (L.GovPurposeId p) -> [Pair]
      prev = \case
        L.SJust (L.GovPurposeId gid) -> ["prevGovAction" .= govIdText gid]
        L.SNothing -> []
  case ga of
    L.InfoAction -> Right (common ++ ["info" .= True])
    L.NoConfidence p -> Right (common ++ prev p ++ ["noconfidence" .= object []])
    L.HardForkInitiation p pv -> Right (common ++ prev p ++ ["hardfork" .= object ["protocolVersion" .= pv]])
    L.TreasuryWithdrawals m guard ->
      Right (common ++ ["withdraw" .= Map.fromList [(hexText (LA.serialiseAccountAddress a), c) | (a, L.Coin c) <- Map.toList m]] ++ maybe [] (\(LH.ScriptHash h) -> ["guardrailscript" .= hashHex h]) (L.strictMaybeToMaybe guard))
    L.ParameterChange p ppu guard -> do
      -- Kuber's parameter update reads named fields only (Data/Models.hs:920-949),
      -- and has none for the fee's constant or the reference-script fee.
      when (isJust (L.strictMaybeToMaybe (ppu ^. Ledger.ppuMinFeeBL))) $ notReplayable "proposal" "a parameter change naming minFeeB: Kuber's parameter update has no such field (Data/Models.hs:920-949)"
      when (isJust (L.strictMaybeToMaybe (ppu ^. ConwayPP.ppuMinFeeRefScriptCostPerByteL))) $ notReplayable "proposal" "a parameter change naming minFeeRefScriptCostPerByte: Kuber's parameter update has no such field (Data/Models.hs:920-949)"
      -- The fields Kuber's parser reads, each as the ledger's JSON of its
      -- type (Data/Models.hs:920-949, the same names as its encoder at :974-1006).
      let g :: A.ToJSON v => A.Key -> L.StrictMaybe v -> [Pair]
          g k = maybe [] (\v -> [k .= v]) . L.strictMaybeToMaybe
          upd =
            concat
              [ g "MaxBBSize" (ppu ^. Ledger.ppuMaxBBSizeL), g "MinFeeA" (ppu ^. Ledger.ppuMinFeeAL), g "MaxTxSize" (ppu ^. Ledger.ppuMaxTxSizeL)
              , g "MaxBHSize" (ppu ^. Ledger.ppuMaxBHSizeL), g "KeyDeposit" (ppu ^. Ledger.ppuKeyDepositL), g "PoolDeposit" (ppu ^. Ledger.ppuPoolDepositL)
              , g "EMax" (ppu ^. Ledger.ppuEMaxL), g "NOpt" (ppu ^. Ledger.ppuNOptL), g "A0" (ppu ^. Ledger.ppuA0L), g "Rho" (ppu ^. Ledger.ppuRhoL)
              , g "Tau" (ppu ^. Ledger.ppuTauL), g "MinPoolCost" (ppu ^. Ledger.ppuMinPoolCostL), g "CoinsPerUTxOByte" (ppu ^. Ledger.ppuCoinsPerUTxOByteL)
              , g "CostModels" (ppu ^. Ledger.ppuCostModelsL), g "Prices" (ppu ^. Ledger.ppuPricesL), g "MaxTxExUnits" (ppu ^. Ledger.ppuMaxTxExUnitsL)
              , g "MaxBlockExUnits" (ppu ^. Ledger.ppuMaxBlockExUnitsL), g "MaxValSize" (ppu ^. Ledger.ppuMaxValSizeL)
              , g "CollateralPercentage" (ppu ^. Ledger.ppuCollateralPercentageL), g "MaxCollateralInputs" (ppu ^. Ledger.ppuMaxCollateralInputsL)
              , g "PoolVotingThresholds" (ppu ^. ConwayPP.ppuPoolVotingThresholdsL), g "DRepVotingThresholds" (ppu ^. ConwayPP.ppuDRepVotingThresholdsL)
              , g "CommitteeMinSize" (ppu ^. ConwayPP.ppuCommitteeMinSizeL), g "CommitteeMaxTermLength" (ppu ^. ConwayPP.ppuCommitteeMaxTermLengthL)
              , g "GovActionLifetime" (ppu ^. ConwayPP.ppuGovActionLifetimeL), g "GovActionDeposit" (ppu ^. ConwayPP.ppuGovActionDepositL)
              , g "DRepDeposit" (ppu ^. ConwayPP.ppuDRepDepositL), g "DRepActivity" (ppu ^. ConwayPP.ppuDRepActivityL)
              ]
      Right (common ++ prev p ++ ["parameterupdate" .= object upd] ++ guardrail guard)
    L.UpdateCommittee p remove add q ->
      -- Kuber's parser reads the quorum as "qourum" (Data/Models.hs:861), the
      -- members to add as a map from credential to epoch and the members to
      -- remove as a set of credentials.
      Right (common ++ prev p ++ ["updatecommittee" .= object (["qourum" .= L.unboundRational q] ++ ["remove" .= map credText (toList remove) | not (Set.null remove)] ++ ["add" .= Map.fromList [(credText c, e) | (c, e) <- Map.toList add] | not (Map.null add)])])
    L.NewConstitution p (L.Constitution (L.Anchor url h) sh) ->
      Right (common ++ prev p ++ ["newconstitution" .= object (["url" .= L.urlToText url, "dataHash" .= hashHex (L.extractHash h)] ++ [("scriptHash" .= hashHex sh') | LH.ScriptHash sh' <- maybe [] pure (L.strictMaybeToMaybe sh)])])
  where
    credText :: LC.Credential kr -> Text
    credText (LC.KeyHashObj kh) = hashHex (L.unKeyHash kh)
    credText (LC.ScriptHashObj (LH.ScriptHash h)) = "10" <> hashHex h
    guardrail = maybe [] (\(LH.ScriptHash h) -> ["guardrailscript" .= hashHex h]) . L.strictMaybeToMaybe

auxPlutus :: Ledger.TxAuxData Ledger.ConwayEra -> Build [TxScript]
auxPlutus ad =
  fmap concat . forM (Map.toList (ad ^. Ledger.plutusScriptsTxAuxDataL)) $ \(lang, bins) ->
    forM (toList bins) $ \(Alonzo.PlutusBinary sbs) -> do
      let bytes = SBS.fromShort sbs
      case lang of
        Ledger.PlutusV1 -> TxScriptPlutus . TxPlutusScriptV1 <$> deser (AsPlutusScript AsPlutusScriptV1) bytes
        Ledger.PlutusV2 -> TxScriptPlutus . TxPlutusScriptV2 <$> deser (AsPlutusScript AsPlutusScriptV2) bytes
        Ledger.PlutusV3 -> TxScriptPlutus . TxPlutusScriptV3 <$> deser (AsPlutusScript AsPlutusScriptV3) bytes
        _ -> notReplayable "auxiliary data" "a Plutus script of a language Conway does not have"
  where
    deser :: SerialiseAsRawBytes a => AsType a -> BS.ByteString -> Build a
    deser t b = either (Left . Stage "replay parts" . show) Right (deserialiseFromRawBytes t b)

-- ---- What the built transaction must carry of the fixed parts.

-- | A fixed part that Kuber's operations took but wrote other than observed
-- is not replayable, but for votes, which Kuber's balancer itself rewrites
-- (TxFramework.hs:453-459): those differences are the library's failure.
checkBuilt :: Fixed -> Ledger.Tx TopTx Ledger.ConwayEra -> Build ()
checkBuilt fx built = case fxObserved fx of
  Nothing -> Right ()
  Just obs -> do
    let ob = obs ^. Ledger.bodyTxL
        bb = built ^. Ledger.bodyTxL
        ow = obs ^. Ledger.witsTxL
        bw = built ^. Ledger.witsTxL
        builtScripts = Map.keysSet (bw ^. Ledger.scriptTxWitsL)
        builtDats = Map.keysSet (Ledger.unTxDats (bw ^. Ledger.datsTxWitsL))
    forM_ (Map.toList (ow ^. Ledger.scriptTxWitsL)) $ \(h, s) -> unless (Set.member h builtScripts) $ case s of
      Alonzo.NativeScript _ -> notReplayable "native scripts" "a native script of the witness set that no operation of Kuber writes: Kuber writes a native script for a mint only (TxFramework.hs:749-753)"
      _ -> notReplayable "plutus" "a Plutus script of the witness set that no operation of Kuber writes"
    forM_ (Map.keys (Ledger.unTxDats (ow ^. Ledger.datsTxWitsL))) $ \h -> unless (Set.member h builtDats) $ notReplayable "datums" "a datum of the witness set that no script input carries: Kuber writes such a datum only from its JSON form of an output, which re-encodes it (Data/TxBuilderAeson.hs:669-781)"
    unless (ob ^. Ledger.mintTxBodyL == bb ^. Ledger.mintTxBodyL) $ Left (Stage "replay parts" "the mint Kuber wrote differs from the intent's")
    unless (toList (ob ^. Ledger.proposalProceduresTxBodyL) == toList (bb ^. Ledger.proposalProceduresTxBodyL)) $ notReplayable "proposal" "Kuber's JSON form of the proposals (Data/Models.hs:819-907) does not write them as observed"
    unless (ob ^. Ledger.votingProceduresTxBodyL == bb ^. Ledger.votingProceduresTxBodyL) $ Left (Classified "other" "build" "Kuber wrote voting procedures that differ from the intent's: its balancer gives every voter every vote of the transaction (TxFramework.hs:453-459)")
    let auxWhy = "Kuber takes metadata as no-schema JSON and splits its strings (TxBuilder.hs:184, TxFramework.hs:370-375, Utility/Misc.hs:206-230), which does not write this auxiliary data as observed: "
    case (L.strictMaybeToMaybe (obs ^. Ledger.auxDataTxL), L.strictMaybeToMaybe (built ^. Ledger.auxDataTxL)) of
      (Nothing, Nothing) -> Right ()
      (Just oa, Just ba) -> do
        let om = Map.map unordered (oa ^. Ledger.metadataTxAuxDataL)
            bm = Map.map unordered (ba ^. Ledger.metadataTxAuxDataL)
            labels = [k | k <- Set.toList (Map.keysSet om <> Map.keysSet bm), Map.lookup k om /= Map.lookup k bm]
        unless (null labels) $ notReplayable "auxiliary data" (auxWhy <> "metadata label " <> show (head labels) <> ", observed " <> take 160 (show (Map.lookup (head labels) om)) <> ", written " <> take 160 (show (Map.lookup (head labels) bm)))
        unless (toList (oa ^. Ledger.nativeScriptsTxAuxDataL) == toList (ba ^. Ledger.nativeScriptsTxAuxDataL) && oa ^. Ledger.plutusScriptsTxAuxDataL == ba ^. Ledger.plutusScriptsTxAuxDataL) $
          notReplayable "auxiliary data" (auxWhy <> "its scripts")
      (o, _) -> notReplayable "auxiliary data" (auxWhy <> (if isJust o then "none written" else "written where none was observed"))

-- | A metadatum with every map's entries in one order: Kuber's metadata form
-- is JSON, whose objects keep no entry order (TxBuilder.hs:184), so it writes
-- a map's entries in an order of its own; the bytes differ, the size does not.
unordered :: Ledger.Metadatum -> Ledger.Metadatum
unordered = \case
  Ledger.Map kvs -> Ledger.Map (sortOn (show . fst) [(unordered k, unordered v) | (k, v) <- kvs])
  Ledger.List xs -> Ledger.List (map unordered xs)
  m -> m

-- ---- Requested outputs.

-- | A requested output through Kuber's operation for its kind: 'txPayTo' for
-- a plain output, 'txPayToScriptWithData' for an inline datum,
-- 'txPayToScript' for a datum hash, 'txPayToWithReferenceScript' for a
-- script reference, and Kuber's JSON form of an output for a datum hash with
-- a script reference, for an inline datum with a script reference, and for a
-- datum hash whose datum the witness set carries (a supplemental datum)
-- (Data/TxBuilderAeson.hs:669-781). That form takes a datum as JSON and
-- writes it in cardano-api's encoding of its value, so the helper uses it for
-- a datum only when that encoding is the datum's own bytes.
requestedOutput :: Map BS.ByteString HashableScriptData -> Text -> Build (TxOut CtxTx ConwayEra, Either TxBuilder A.Value)
requestedOutput datums h = do
  out@(TxOut addr v datum rs) <- stageOf "requested output" (parseTxOut h)
  let value = txOutValueToValue v
      base = ["address" .= serialiseAddress addr, "value" .= value]
      script = case rs of
        ReferenceScript _ s -> ["inlineScript" .= scriptJson (scriptOfAny s)]
        _ -> []
      canonical d = serialiseToCBOR (unsafeHashableScriptData (getScriptData d)) == serialiseToCBOR d
  fmap ((,) out) $ case (datum, rs) of
    (TxOutDatumNone, ReferenceScriptNone) -> Right (Left (txPayTo addr value))
    (TxOutDatumInline _ d, ReferenceScriptNone) -> Right (Left (txPayToScriptWithData addr value d))
    (TxOutDatumHash _ dh, _) | Just d <- Map.lookup (serialiseToRawBytes dh) datums, canonical d ->
      Right (Right (object (base ++ ["datum" .= scriptDataToJsonDetailedSchema d, "inlineDatum" .= False] ++ script)))
    (TxOutDatumHash _ dh, ReferenceScriptNone) -> Right (Left (txPayToScript addr value dh))
    (TxOutDatumHash _ dh, ReferenceScript _ _) -> Right (Right (object (base ++ ["datumHash" .= serialiseToRawBytesHexText dh] ++ script)))
    (TxOutDatumNone, ReferenceScript _ s) -> Right (Left (txPayToWithReferenceScript addr value (scriptOfAny s)))
    (TxOutDatumInline _ d, ReferenceScript _ _)
      | canonical d -> Right (Right (object (base ++ ["datum" .= scriptDataToJsonDetailedSchema d] ++ script)))
      | otherwise -> notReplayable "output data" "an inline datum with a script reference: Kuber writes that pair only through its JSON form of an output, which writes the datum in cardano-api's encoding of its value, and this datum's bytes are another encoding (Data/TxBuilderAeson.hs:669-781, Data/Parsers.hs:229-238)"
    _ -> Left (Stage "requested output" "an output datum the parser does not give")

-- | Every requested output among the outputs Kuber wrote, a supplemental
-- datum read as its hash.
checkOutputs :: [TxOut CtxTx ConwayEra] -> TxBody ConwayEra -> Build ()
checkOutputs requested body = go (map plain (txOuts (getTxBodyContent body))) requested
  where
    plain (TxOut a v (TxOutSupplementalDatum w d) rs) = TxOut a v (TxOutDatumHash w (hashScriptDataBytes d)) rs
    plain o = o
    go _ [] = Right ()
    go outs (o : os) = case break (== plain o) outs of
      (pre, _ : post) -> go (pre ++ post) os
      _ -> Left (Stage "build" "Kuber wrote a requested output other than requested")

-- ---- The build.

data Last = Last
  { lastBody :: TxBody ConwayEra
  , lastReplay :: Replay
  , lastFee :: L.Coin
  }

data State = State
  { stCache :: IORef (Map Text (TxIn, TxOut CtxUTxO ConwayEra))
  , stLast :: IORef (Maybe Last)
  }

-- | Kuber's JSON form of a builder, decoded by Kuber's own instance.
fromKuberJson :: [(Text, [A.Value])] -> Build TxBuilder
fromKuberJson [] = Right mempty
fromKuberJson kvs = case A.fromJSON (object [AK.fromText k .= vs | (k, vs) <- kvs]) of
  A.Success b -> Right b
  A.Error e -> Left (Stage "replay parts" ("Kuber's JSON form: " <> e))

-- | The wallet's UTxOs of the request: each one sent with its bytes is kept
-- for the helper's later requests before anything else is read, as the bridge
-- expects (it sends a reference's bytes once per process).
poolOf :: State -> A.Object -> IO (Build [(Text, (TxIn, TxOut CtxUTxO ConwayEra))])
poolOf st q = case field q "utxos" :: Build [A.Object] of
  Left e -> pure (Left e)
  Right utxos -> do
    parsed <- forM utxos $ \x -> do
      let ref = field x "ref" :: Build Text
          cbor = optField x "cbor" :: Build (Maybe Text)
      case (ref, cbor) of
        (Right r, Right (Just c)) -> case utxoOf c of
          Left e -> pure (Left (Stage "replay parts" (T.unpack r <> ": " <> e)))
          Right u -> do
            modifyIORef' (stCache st) (Map.insert r u)
            pure (Right (r, Just u))
        (Right r, Right Nothing) -> pure (Right (r, Nothing))
        (Left e, _) -> pure (Left e)
        (_, Left e) -> pure (Left e)
    cache <- readIORef (stCache st)
    pure $ forM parsed $ \p -> case p of
      Left e -> Left e
      Right (r, Nothing) -> maybe (Left (Stage "replay parts" ("no bytes for " <> T.unpack r))) (Right . (,) r) (Map.lookup r cache)
      Right (r, Just u) -> Right (r, u)

build :: State -> A.Object -> IO (Build Text)
build st q = do
  mpool <- poolOf st q
  let prepared = do
        pool <- mpool
        params <- field q "params" >>= protocolParams
        network <- field q "network" :: Build Text
        networkId <- field q "networkId" :: Build Int
        changeText <- field q "changeAddress" :: Build Text
        change <- stageOf "replay parts" (parseAddress changeText :: Either String (AddressInEra ConwayEra))
        intent <- fromMaybe AKM.empty <$> optField q "intent"
        mfixed <- optField intent "fixed" :: Build (Maybe A.Object)
        fx <- maybe (Right noFixed) withFixedParts mfixed
        outs <- field q "outputs" :: Build [Text]
        outParts <- mapM (requestedOutput (fxDatums fx)) outs
        outBuilders <- forM outParts $ \(_, p) -> either Right (\v -> fromKuberJson [("outputs", [v])]) p
        refBytes <- maybe (Right Nothing) (`optField` "refScriptBytes") mfixed :: Build (Maybe A.Value)
        rawParams <- field q "params" :: Build A.Object
        refCost <- paramRat rawParams "minFeeRefScriptCostPerByte"
        when (maybe False ((> 0) . fromMaybe 0 . intOf) refBytes && refCost == Nothing) $
          Left (Stage "replay parts" "protocol parameter minFeeRefScriptCostPerByte is not stated for this run")
        mcoll <- optField q "collateral" :: Build (Maybe A.Object)
        collJson <- case mcoll of
          Nothing -> Right []
          Just c -> do
            cb <- field c "cbor" :: Build Text
            Right [("collaterals", [A.String cb])]
        collUtxo <- case mcoll of
          Nothing -> Right []
          Just c -> field c "cbor" >>= fmap (: []) . stageOf "replay parts" . utxoOf
        jsonPart <- fromKuberJson (fxJson fx ++ collJson)
        let poolMap = Map.fromList (map snd pool)
            (start, hist) = networkTime network
            replay =
              Replay
                { rpParams = params
                , rpNetwork = if networkId == 1 then Api.Mainnet else Api.Testnet (NetworkMagic 1)
                , rpStart = start
                , rpHistory = hist
                , rpUtxo = poolMap <> fxUtxo fx <> Map.fromList collUtxo
                , rpKeyDeposit = unLedgerProtocolParameters params ^. Ledger.ppKeyDepositL
                }
            builder =
              mconcat outBuilders
                <> txWalletUtxos (UTxO poolMap)
                <> txChangeAddress change
                <> fxBuilder fx
                <> jsonPart
        Right (map fst outParts, replay, builder, fx)
  case prepared of
    Left e -> pure (Left e)
    Right (requested, replay, builder, fx) -> do
      r <- evaluateKontract replay (executeTxBuilder builder)
      case r of
        Left (FrameworkError t msg) -> pure (Left (Stage "build" (show t <> ": " <> msg)))
        Left e -> pure (Left (Stage "build" (show e)))
        Right (body, tx@(ShelleyTx _ ltx)) -> case checkBuilt fx ltx >> checkOutputs requested body of
          Left e -> pure (Left e)
          Right () -> do
            writeIORef (stLast st) (Just (Last body replay (ltx ^. Ledger.bodyTxL . Ledger.feeTxBodyL)))
            pure (Right (hexText (serialiseToCBOR tx)))

-- | The vkey witnesses the bridge sends, written into the transaction last
-- built with cardano-api's 'makeSignedTransaction', as Kuber writes its own
-- signatures (TxFramework.hs:522-527), with ['observed vkey witnesses']
-- unpriced when they outnumber the key witnesses Kuber's fee counted. That
-- count is the one for which cardano-api's fee of the body equals the fee
-- Kuber's balancer settled on (TxFramework.hs:1379-1382, :507-521).
witness :: State -> A.Object -> IO (Build (Text, Bool))
witness st q = do
  ml <- readIORef (stLast st)
  pure $ case ml of
    Nothing -> Left (Stage "witness" "no transaction built")
    Just l -> do
      vkeys <- field q "vkeys" :: Build [Text]
      observed <- fromMaybe 0 <$> optField q "observed" :: Build Int
      wits <- forM vkeys $ \h -> do
        bs <- stageOf "witness" (unhex h)
        either (Left . Stage "witness" . show) Right (deserialiseFromCBOR (AsKeyWitness AsConwayEra) bs)
      let tx = makeSignedTransaction wits (lastBody l)
          r = lastReplay l
          pp = unLedgerProtocolParameters (rpParams r)
          feeFor n = calculateMinTxFee ShelleyBasedEraConway pp (UTxO (rpUtxo r)) (lastBody l) n
          priced = find (\n -> feeFor n == lastFee l) [0 .. fromIntegral (length vkeys) + 64]
          unpriced = observed > 0 && maybe True (\n -> fromIntegral (length vkeys) > n) priced
      Right (hexText (serialiseToCBOR tx), unpriced)

-- ---- The loop.

failureJson :: Failure -> [Pair]
failureJson = \case
  NotReplayable p why -> ["notReplayable" .= p, "error" .= why]
  Stage s e -> ["stage" .= s, "error" .= e]
  Classified c s e -> ["class" .= c, "stage" .= s, "error" .= e]

answer :: State -> Request -> IO A.Value
answer st q = do
  let respond kvs = object (("id" .= qId q) : kvs)
  case (qSchema q, qOp q) of
    (Just s, _) | s /= helperSchema -> pure (respond ["ok" .= False, "error" .= ("schema " <> show s <> ", the helper's " <> show helperSchema)])
    (_, Just "build") -> do
      r <- try (build st (qBody q) >>= \b -> evaluate (forceBuild b))
      pure $ case r of
        Left (e :: SomeException) -> respond ["ok" .= False, "stage" .= ("build" :: Text), "error" .= ("exception: " <> show e)]
        Right (Left f) -> respond (("ok" .= False) : failureJson f)
        Right (Right tx) -> respond ["ok" .= True, "tx" .= tx]
    (_, Just "witness") -> do
      r <- try (witness st (qBody q) >>= \b -> evaluate (forceWitness b))
      pure $ case r of
        Left (e :: SomeException) -> respond ["ok" .= False, "error" .= ("exception: " <> show e)]
        Right (Left f) -> respond (("ok" .= False) : failureJson f)
        Right (Right (tx, unpriced)) -> respond (["ok" .= True, "tx" .= tx] ++ ["unpriced" .= (["observed vkey witnesses"] :: [Text]) | unpriced])
    (_, op) -> pure (respond ["ok" .= False, "error" .= ("unknown op " <> show op)])
  where
    forceBuild b@(Right t) = T.length t `seq` b
    forceBuild b = b
    forceWitness b@(Right (t, u)) = T.length t `seq` u `seq` b
    forceWitness b = b

main :: IO ()
main = do
  hSetBuffering stdout LineBuffering
  st <- State <$> newIORef Map.empty <*> newIORef Nothing
  let loop = do
        eof <- hIsEOF stdin
        unless eof $ do
          line <- B8.hGetLine stdin
          if B8.null line
            then loop
            else case A.eitherDecodeStrict line >>= parseEither parseRequest of
              Left e -> do
                hPutStrLn stderr (helperName <> " helper: a request that is not JSON: " <> e)
                exitWith (ExitFailure 2)
              Right q -> do
                v <- answer st q
                BL8.putStrLn (A.encode v)
                hFlush stdout
                loop
  loop
