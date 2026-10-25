-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- Section 5.9 of the pre-registration: the per-wallet inputs of the profiles,
-- per sampled wallet and its frame's window. Profiles decide nothing; they are
-- inputs to later artifacts.
--
-- The profiles are found by a clustering procedure fitted after the final
-- freeze on the exploration split, which this code does not run. It computes
-- the procedure's eight features, per sampled wallet over its frame's window
-- (the recent window for the recent frame, the peak window for the peak
-- frame):
--
--   f1  n_spends              spend events in the window (05-04-activity.sql)
--   f2  n_dex                 DEX interactions in the window
--   f3  n_marketplace         marketplace interactions in the window
--   f4  n_market_other        other market interactions in the window
--   f5  n_receipts_no_input   receipts in the window that consume none of the
--                             wallet's outputs (study.activity)
--   f6  hold_nft              distinct NFTs held, the larger of the counts at
--                             the window's start and end
--   f7  hold_ft               distinct fungible assets held, the larger of
--                             those two counts
--   f8  n_utxo_end            UTxOs held at the window's end, held UTxOs
--                             included
--
-- A market interaction is a spend that executes a script or sends value to a
-- script address; it is a DEX interaction if the wallet's net movement in the
-- transaction includes a fungible asset, otherwise a marketplace interaction
-- if it includes an NFT, otherwise other. Holdings at the window's start and
-- end are classed by the rule of section 6.2 at that block.
--
-- The fixed cut points below (spends and market interactions per month) and
-- the profile column they give are a descriptive field kept beside the
-- clusters, not the profile definition; the three flags are descriptive too.
--
-- Read as: "executes a script" is a Plutus redeemer for the transaction, or a
-- phase-2-invalid transaction (x17_invalid_is_script; db-sync stores no
-- redeemers for those, Era/Universal/Insert/Tx.hs); native-script evaluation
-- does not count. The split takes DEX first. An asset's class for the split is
-- the rule of section 6.2 applied to the largest of the wallet's holdings at
-- the window's start, at its end, and the units it moved in the transaction:
-- label 333 or 444, or more than one unit, makes it fungible. study.script_tx
-- is materialized once, since redeemer.tx_id has no index.
--
-- Net movement: outputs of the transaction at the wallet minus the wallet's
-- outputs the transaction consumed, per asset, from study.txo and
-- study.txo_asset.
--
-- Profiles, first match: power user (at least 30 spends and at least 10
-- market interactions per month), active (at least 8 spends, or at least 2
-- market interactions), typical holder (at least 1 spend), dormant. Flags:
-- NFT-heavy (100 or more NFTs held), fungible-heavy (10 or
-- more distinct fungible assets held), DEX-active (at least 3 DEX interactions
-- in the window).

-- @step script_tx
-- @outputs study.script_tx
DROP TABLE IF EXISTS study.script_tx;
CREATE TABLE study.script_tx AS SELECT DISTINCT r.tx_id FROM public.redeemer r WHERE r.tx_id <= {{snap_tx}};
ALTER TABLE study.script_tx ADD PRIMARY KEY (tx_id);
ANALYZE study.script_tx;

-- @step profile
-- @outputs study.prof_hold study.prof_spend study.prof_net study.profile
DROP TABLE IF EXISTS study.prof_hold;
CREATE TABLE study.prof_hold AS
WITH pts AS (
  SELECT frame, sa_id, 'start'::text AS point, t_start AS t FROM study.sample_frame
  UNION ALL
  SELECT frame, sa_id, 'end', t_end FROM study.sample_frame
)
SELECT p.frame, p.sa_id, p.point, a.ident, sum(a.quantity) AS qty
  FROM pts p
  JOIN study.txo t ON t.sa_id = p.sa_id AND t.created_tx <= p.t AND (t.consumed_tx IS NULL OR t.consumed_tx > p.t)
  JOIN study.txo_asset a ON a.tx_out_id = t.tx_out_id
 GROUP BY p.frame, p.sa_id, p.point, a.ident;
CREATE INDEX prof_hold_key ON study.prof_hold (frame, sa_id, ident);
ANALYZE study.prof_hold;
DROP TABLE IF EXISTS study.prof_spend;
CREATE TABLE study.prof_spend AS
SELECT DISTINCT f.frame, f.sa_id, t.consumed_tx AS tx
  FROM study.sample_frame f
  JOIN study.txo t ON t.sa_id = f.sa_id
 WHERE t.consumed_tx BETWEEN f.lo AND f.hi
   AND ({{x2_any}} OR NOT t.script_pay);
ALTER TABLE study.prof_spend
  ADD COLUMN executes_script boolean,
  ADD COLUMN sends_to_script boolean;
UPDATE study.prof_spend s
   SET executes_script = EXISTS (SELECT 1 FROM study.script_tx x WHERE x.tx_id = s.tx)
                         OR ({{x17_invalid_is_script}} AND NOT tx.valid_contract),
       sends_to_script = EXISTS (SELECT 1 FROM public.tx_out o WHERE o.tx_id = s.tx AND o.address_has_script)
  FROM public.tx tx WHERE tx.id = s.tx;
CREATE INDEX prof_spend_key ON study.prof_spend (frame, sa_id, tx);
ANALYZE study.prof_spend;
DROP TABLE IF EXISTS study.prof_net;
CREATE TABLE study.prof_net AS
WITH mv AS (
  SELECT s.frame, s.sa_id, s.tx, a.ident, a.quantity AS q
    FROM study.prof_spend s
    JOIN study.txo t ON t.sa_id = s.sa_id AND t.created_tx = s.tx
    JOIN study.txo_asset a ON a.tx_out_id = t.tx_out_id
  UNION ALL
  SELECT s.frame, s.sa_id, s.tx, a.ident, -a.quantity
    FROM study.prof_spend s
    JOIN study.txo t ON t.consumed_tx = s.tx AND t.sa_id = s.sa_id
    JOIN study.txo_asset a ON a.tx_out_id = t.tx_out_id
)
SELECT frame, sa_id, tx, ident, sum(q) AS net FROM mv GROUP BY frame, sa_id, tx, ident HAVING sum(q) <> 0;
ANALYZE study.prof_net;
DROP TABLE IF EXISTS study.profile;
CREATE TABLE study.profile AS
WITH cls AS (
  SELECT n.frame, n.sa_id, n.tx,
         bool_or(study.is_fungible_l(s.label, greatest(abs(n.net), coalesce(hs.qty, 0), coalesce(he.qty, 0)))) AS has_ft,
         true AS has_any
    FROM study.prof_net n
    JOIN study.asset s ON s.ident = n.ident
    LEFT JOIN study.prof_hold hs ON hs.frame = n.frame AND hs.sa_id = n.sa_id AND hs.ident = n.ident AND hs.point = 'start'
    LEFT JOIN study.prof_hold he ON he.frame = n.frame AND he.sa_id = n.sa_id AND he.ident = n.ident AND he.point = 'end'
   GROUP BY n.frame, n.sa_id, n.tx
),
sp AS (
  SELECT s.frame, s.sa_id, s.tx,
         (s.executes_script OR s.sends_to_script) AS market,
         coalesce(c.has_ft, false) AS has_ft,
         coalesce(c.has_any, false) AS has_any
    FROM study.prof_spend s
    LEFT JOIN cls c ON c.frame = s.frame AND c.sa_id = s.sa_id AND c.tx = s.tx
),
spa AS (
  SELECT frame, sa_id,
         count(*) AS n_spends,
         count(*) FILTER (WHERE market) AS n_market,
         count(*) FILTER (WHERE market AND has_ft) AS n_dex,
         count(*) FILTER (WHERE market AND NOT has_ft AND has_any) AS n_marketplace,
         count(*) FILTER (WHERE market AND NOT has_any) AS n_market_other
    FROM sp GROUP BY frame, sa_id
),
hold AS (
  SELECT h.frame, h.sa_id,
         count(*) FILTER (WHERE h.point = 'start' AND NOT study.is_fungible_l(s.label, h.qty)) AS nft_start,
         count(*) FILTER (WHERE h.point = 'end' AND NOT study.is_fungible_l(s.label, h.qty)) AS nft_end,
         count(*) FILTER (WHERE h.point = 'start' AND study.is_fungible_l(s.label, h.qty)) AS ft_start,
         count(*) FILTER (WHERE h.point = 'end' AND study.is_fungible_l(s.label, h.qty)) AS ft_end
    FROM study.prof_hold h JOIN study.asset s ON s.ident = h.ident
   GROUP BY h.frame, h.sa_id
),
utxo_end AS (
  SELECT f.frame, f.sa_id, count(*) AS n_utxo_end
    FROM study.sample_frame f
    JOIN study.txo t ON t.sa_id = f.sa_id AND t.created_tx <= f.t_end AND (t.consumed_tx IS NULL OR t.consumed_tx > f.t_end)
   GROUP BY f.frame, f.sa_id
),
base AS (
  SELECT f.frame, f.sa_id,
         coalesce(spa.n_spends, 0) AS n_spends,
         coalesce(spa.n_market, 0) AS n_market,
         coalesce(spa.n_dex, 0) AS n_dex,
         coalesce(spa.n_marketplace, 0) AS n_marketplace,
         coalesce(spa.n_market_other, 0) AS n_market_other,
         coalesce(a.n_receipts_no_input, 0) AS n_receipts_no_input,
         greatest(coalesce(hold.nft_start, 0), coalesce(hold.nft_end, 0)) AS hold_nft,
         greatest(coalesce(hold.ft_start, 0), coalesce(hold.ft_end, 0)) AS hold_ft,
         coalesce(ue.n_utxo_end, 0) AS n_utxo_end
    FROM study.sample_frame f
    LEFT JOIN spa ON spa.frame = f.frame AND spa.sa_id = f.sa_id
    LEFT JOIN hold ON hold.frame = f.frame AND hold.sa_id = f.sa_id
    LEFT JOIN study.activity a ON a.win = f.frame AND a.sa_id = f.sa_id
    LEFT JOIN utxo_end ue ON ue.frame = f.frame AND ue.sa_id = f.sa_id
)
SELECT b.*,
       b.n_spends / {{months}}::numeric AS spends_pm,
       b.n_market / {{months}}::numeric AS market_pm,
       CASE
         WHEN b.n_spends >= {{power_spends_pm}} * {{months}} AND b.n_market >= {{power_market_pm}} * {{months}} THEN 'power'
         WHEN b.n_spends >= {{active_spends_pm}} * {{months}} OR b.n_market >= {{active_market_pm}} * {{months}} THEN 'active'
         WHEN b.n_spends >= {{typical_spends_pm}} * {{months}} THEN 'typical'
         ELSE 'dormant'
       END AS profile,
       b.hold_nft >= {{nft_heavy}} AS nft_heavy,
       b.hold_ft >= {{ft_heavy}} AS ft_heavy,
       b.n_dex >= {{dex_active}} AS dex_active
  FROM base b;
ALTER TABLE study.profile ADD PRIMARY KEY (frame, sa_id);

-- The spend count here and the frame's n_spends must agree; f5 counts a
-- subset of the window's receipts; with held UTxOs counted (x9_count_held),
-- f8 is the frame's UTxO count at its reference block, which is the window's
-- end.
-- @query profile_check
SELECT count(*) AS n,
       count(*) FILTER (WHERE p.n_spends <> f.n_spends) AS spend_count_mismatch,
       count(*) FILTER (WHERE p.n_receipts_no_input > coalesce(a.n_receipts, 0)) AS receipt_count_mismatch,
       count(*) FILTER (WHERE {{x9_count_held}} AND p.n_utxo_end <> f.n_utxo) AS utxo_count_mismatch
  FROM study.profile p
  JOIN study.frame f ON f.frame = p.frame AND f.sa_id = p.sa_id
  LEFT JOIN study.activity a ON a.win = p.frame AND a.sa_id = p.sa_id;

-- @query profile_counts
SELECT p.frame, p.profile, count(*) AS n,
       count(*) FILTER (WHERE p.nft_heavy) AS nft_heavy,
       count(*) FILTER (WHERE p.ft_heavy) AS ft_heavy,
       count(*) FILTER (WHERE p.dex_active) AS dex_active
  FROM study.profile p JOIN study.sample_frame f ON f.frame = p.frame AND f.sa_id = p.sa_id AND f.in_sample
 WHERE NOT EXISTS (SELECT 1 FROM study.check_61 k WHERE k.sa_id = p.sa_id AND NOT k.agree)
 GROUP BY p.frame, p.profile ORDER BY p.frame DESC, p.profile;
