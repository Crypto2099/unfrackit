-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- Sections 5.4 and 6.2 of the pre-registration: activity in each window,
-- receipts and spend events.
--
-- A receipt is a transaction that creates an output of the wallet. A spend
-- event is a transaction with at least one wallet input (section 6.2). Read
-- as: a wallet input is an input consuming a wallet output at a key payment
-- credential; a DEX order or similar output at a script address that carries
-- the wallet's stake key is consumed by a third party's transaction, which
-- would otherwise count as the wallet's spend. Both counts are kept:
--   n_spends_key  transactions consuming a wallet output at a key payment credential
--   n_spends_any  transactions consuming any wallet output
--   n_tx_key      transactions that are a receipt or a key spend (the default)
--   n_tx_any      transactions that are a receipt or any spend
-- and n_tx and n_spends are the pair the setting x2_any selects.
--
-- Window bounds are transaction ids: [first id with block_id >= B1, T(B2)].
-- Events are first reduced to one row per (window, wallet, transaction) by a
-- hash aggregate, then counted.

-- @step activity
-- @outputs study.activity
DROP TABLE IF EXISTS study.activity;
CREATE TABLE study.activity AS
WITH ev AS (
  SELECT 'recent'::text AS win, sa_id, created_tx AS tx, 1 AS r, 0 AS s, 0 AS x
    FROM study.txo WHERE created_tx BETWEEN {{recent_lo}} AND {{recent_hi}}
  UNION ALL
  SELECT 'recent', sa_id, consumed_tx, 0, CASE WHEN script_pay THEN 0 ELSE 1 END, CASE WHEN script_pay THEN 1 ELSE 0 END
    FROM study.txo WHERE consumed_tx BETWEEN {{recent_lo}} AND {{recent_hi}}
  UNION ALL
  SELECT 'peak', sa_id, created_tx, 1, 0, 0
    FROM study.txo WHERE created_tx BETWEEN {{peak_lo}} AND {{peak_hi}}
  UNION ALL
  SELECT 'peak', sa_id, consumed_tx, 0, CASE WHEN script_pay THEN 0 ELSE 1 END, CASE WHEN script_pay THEN 1 ELSE 0 END
    FROM study.txo WHERE consumed_tx BETWEEN {{peak_lo}} AND {{peak_hi}}
),
per_tx AS (
  SELECT win, sa_id, tx, max(r) AS r, max(s) AS s, max(x) AS x
    FROM ev GROUP BY win, sa_id, tx
),
agg AS (
  SELECT win, sa_id,
         count(*) FILTER (WHERE r = 1 OR s = 1) AS n_tx_key,
         count(*) AS n_tx_any,
         count(*) FILTER (WHERE s = 1) AS n_spends_key,
         count(*) FILTER (WHERE s = 1 OR x = 1) AS n_spends_any,
         count(*) FILTER (WHERE r = 1) AS n_receipts
    FROM per_tx GROUP BY win, sa_id
)
SELECT agg.*,
       CASE WHEN {{x2_any}} THEN n_tx_any ELSE n_tx_key END AS n_tx,
       CASE WHEN {{x2_any}} THEN n_spends_any ELSE n_spends_key END AS n_spends
  FROM agg;
CREATE INDEX activity_win_sa ON study.activity (win, sa_id);
ANALYZE study.activity;
