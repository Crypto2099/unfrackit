-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- Sections 5.4 and 5.5 of the pre-registration: the measures the exclusions
-- and the token-holding test read, as state aggregates per credential at a
-- reference block.
--
-- Points: snap (the snapshot, the recent frame's reference block), peak_start
-- (the state at the peak window's start) and peak_end (its last block, the peak
-- frame's reference block). "At the window start" is read as the state as of
-- the last block before the window's first block (setting x3_after_first).
--
--   n_utxo, lovelace, n_assets, n_nft, n_units   at the point; held UTxOs count
--                                                by default (x9_count_held)
--   lovelace_all, lovelace_script_pay           every UTxO at the point, for the
--                                                script-value exclusion
--   n_pay                                        distinct payment credentials
--                                                that ever received an output
--                                                with the stake credential up to
--                                                the point, by default, or only
--                                                those present at the point
--                                                (x12_history false)
--
-- n_assets counts distinct assets (policy and name). n_nft counts the assets
-- held as non-fungible by the classification rule of section 6.2 over the
-- wallet's total quantity (study.is_fungible_l). n_units sums quantities.
-- Aggregation runs in two levels, (credential, asset) then credential, so each
-- level is a hash aggregate.

-- @step state
-- @outputs study.state
DROP TABLE IF EXISTS study.state;
CREATE TABLE study.state AS
WITH u AS (
  SELECT 'snap'::text AS point, t.* FROM study.txo t
   WHERE t.created_tx <= {{snap_tx}} AND (t.consumed_tx IS NULL OR t.consumed_tx > {{snap_tx}})
  UNION ALL
  SELECT 'peak_start', t.* FROM study.txo t
   WHERE t.created_tx <= {{peak_t_start}} AND (t.consumed_tx IS NULL OR t.consumed_tx > {{peak_t_start}})
  UNION ALL
  SELECT 'peak_end', t.* FROM study.txo t
   WHERE t.created_tx <= {{peak_t_end}} AND (t.consumed_tx IS NULL OR t.consumed_tx > {{peak_t_end}})
),
v AS (
  SELECT point, sa_id,
         count(*) FILTER (WHERE {{x9_count_held}} OR NOT (has_datum OR has_ref_script OR script_pay)) AS n_utxo,
         coalesce(sum(value) FILTER (WHERE {{x9_count_held}} OR NOT (has_datum OR has_ref_script OR script_pay)), 0) AS lovelace,
         sum(value) AS lovelace_all,
         coalesce(sum(value) FILTER (WHERE script_pay), 0) AS lovelace_script_pay
    FROM u GROUP BY point, sa_id
),
h AS (
  SELECT u.point, u.sa_id, a.ident, sum(a.quantity) AS qty
    FROM u JOIN study.txo_asset a ON a.tx_out_id = u.tx_out_id
   WHERE {{x9_count_held}} OR NOT (u.has_datum OR u.has_ref_script OR u.script_pay)
   GROUP BY u.point, u.sa_id, a.ident
),
k AS (
  SELECT h.point, h.sa_id, count(*) AS n_assets,
         count(*) FILTER (WHERE NOT study.is_fungible_l(s.label, h.qty)) AS n_nft,
         sum(h.qty) AS n_units
    FROM h JOIN study.asset s ON s.ident = h.ident
   GROUP BY h.point, h.sa_id
)
SELECT v.point, v.sa_id, v.n_utxo, v.lovelace, v.lovelace_all, v.lovelace_script_pay,
       coalesce(k.n_assets, 0) AS n_assets, coalesce(k.n_nft, 0) AS n_nft, coalesce(k.n_units, 0) AS n_units
  FROM v LEFT JOIN k ON k.point = v.point AND k.sa_id = v.sa_id;
CREATE INDEX state_point_sa ON study.state (point, sa_id);
ANALYZE study.state;

-- @step paycount
-- @outputs study.paycount
DROP TABLE IF EXISTS study.paycount;
CREATE TABLE study.paycount AS
WITH p AS (
  SELECT 'snap'::text AS point, sa_id, payment_cred FROM study.txo
   WHERE created_tx <= {{snap_tx}}
     AND ({{x12_history}} OR consumed_tx IS NULL OR consumed_tx > {{snap_tx}})
   GROUP BY sa_id, payment_cred
  UNION ALL
  SELECT 'peak_end', sa_id, payment_cred FROM study.txo
   WHERE created_tx <= {{peak_t_end}}
     AND ({{x12_history}} OR consumed_tx IS NULL OR consumed_tx > {{peak_t_end}})
   GROUP BY sa_id, payment_cred
)
SELECT point, sa_id, count(*) AS n_pay FROM p GROUP BY point, sa_id;
CREATE INDEX paycount_point_sa ON study.paycount (point, sa_id);
ANALYZE study.paycount;
