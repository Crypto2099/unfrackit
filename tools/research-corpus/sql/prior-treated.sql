-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- The two classifiers of prior-treated wallets, over each wallet's whole
-- history up to the snapshot. Both are flags on sampled wallets, counted per
-- classifier and window for the descriptive report; prior-treated wallets stay
-- in the primary analyses.
--
-- UnFrack.It users: a transaction spending the wallet's UTxOs
-- whose label-674 message contains "unfrack.it". The app writes
-- {"msg": ["https://unfrack.it"]} (Crypto2099/unfrackit@74fc486:src/App.vue,
-- the metadata built before signing), first written in v0.0.3 (2023-05-04).
-- CIP-20 (cardano-foundation/CIPs@befcdb75, CIP-0020/README.md,
-- "Specification"): label 674 holds {"msg": [strings]}, each string at most 64
-- bytes. Read as: any string element of the msg array containing
-- "unfrack.it", case-insensitive; payloads db-sync could not decode as JSON
-- (json NULL) are searched in their bytes and counted separately
-- (x14_search_bytes). A string split across two elements would be missed; the
-- app writes one element. db-sync stores no metadata for phase-2-invalid
-- transactions (Era/Universal/Insert/Tx.hs), so none can match. There is no
-- index on tx_metadata.key; this is one pass over the table.
--
-- Evolution-tidied wallets: a transaction with exactly seven pure-ADA outputs
-- to the wallet's own addresses whose coins, sorted in descending order, are
-- each within 0.2 percentage points of 50, 15, 10, 10, 5, 5 and 5% of their
-- sum. Read as: the seven are the transaction's only pure-ADA outputs at the
-- wallet (no tokens, datum or reference script), other outputs allowed
-- (x21_others_allowed), and the transaction spends the wallet's UTxOs.

-- @step unfrackit_tx
-- @outputs study.unfrackit_tx
DROP TABLE IF EXISTS study.unfrackit_tx;
CREATE TABLE study.unfrackit_tx AS
SELECT m.tx_id, 'json'::text AS source
  FROM public.tx_metadata m
 WHERE m.key = 674 AND m.tx_id <= {{snap_tx}}
   AND jsonb_typeof(m.json -> 'msg') = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.json -> 'msg') e(v)
                WHERE jsonb_typeof(e.v) = 'string' AND (e.v #>> '{}') ILIKE '%unfrack.it%')
UNION
SELECT m.tx_id, 'bytes'::text
  FROM public.tx_metadata m
 WHERE {{x14_search_bytes}} AND m.key = 674 AND m.tx_id <= {{snap_tx}} AND m.json IS NULL
   AND position('unfrack.it' IN lower(encode(m.bytes, 'escape'))) > 0;
CREATE INDEX unfrackit_tx_tx_id ON study.unfrackit_tx (tx_id);

-- @query unfrackit_report
WITH k AS (
  SELECT count(*) AS n_674, count(*) FILTER (WHERE json IS NULL) AS n_674_json_null,
         count(*) FILTER (WHERE jsonb_typeof(json -> 'msg') = 'array') AS n_674_msg_array
    FROM public.tx_metadata WHERE key = 674 AND tx_id <= {{snap_tx}}
)
SELECT k.n_674, k.n_674_json_null, k.n_674_msg_array,
       (SELECT count(*) FROM study.unfrackit_tx WHERE source = 'json') AS n_match_json,
       (SELECT count(*) FROM study.unfrackit_tx WHERE source = 'bytes') AS n_match_bytes,
       (SELECT min(b.time)::text FROM study.unfrackit_tx u JOIN public.tx t ON t.id = u.tx_id
          JOIN public.block b ON b.id = t.block_id) AS earliest_match_time,
       (SELECT max(b.time)::text FROM study.unfrackit_tx u JOIN public.tx t ON t.id = u.tx_id
          JOIN public.block b ON b.id = t.block_id) AS latest_match_time
  FROM k;

-- @query unfrackit_matches
SELECT encode(t.hash, 'hex') AS tx_hash, b.block_no, b.time::text AS time, u.source,
       (SELECT m.json::text FROM public.tx_metadata m WHERE m.tx_id = u.tx_id AND m.key = 674 LIMIT 1) AS json
  FROM study.unfrackit_tx u JOIN public.tx t ON t.id = u.tx_id JOIN public.block b ON b.id = t.block_id
 ORDER BY b.block_no;

-- @step prior_flags
-- @outputs study.prior_unfrackit study.prior_evolution
DROP TABLE IF EXISTS study.prior_unfrackit;
CREATE TABLE study.prior_unfrackit AS
SELECT t.sa_id, t.consumed_tx AS tx, bool_or(NOT t.script_pay) AS key_spend
  FROM study.txo t
  JOIN study.sample_wallet w ON w.sa_id = t.sa_id
  JOIN study.unfrackit_tx u ON u.tx_id = t.consumed_tx
 GROUP BY t.sa_id, t.consumed_tx;
DROP TABLE IF EXISTS study.prior_evolution;
CREATE TABLE study.prior_evolution AS
WITH sp AS (
  SELECT DISTINCT t.sa_id, t.consumed_tx AS tx
    FROM study.txo t JOIN study.sample_wallet w ON w.sa_id = t.sa_id
   WHERE t.consumed_tx IS NOT NULL
),
outs AS (
  SELECT t.sa_id, t.created_tx AS tx, t.value,
         (NOT t.has_datum AND NOT t.has_ref_script
          AND NOT EXISTS (SELECT 1 FROM study.txo_asset a WHERE a.tx_out_id = t.tx_out_id)) AS pure
    FROM sp JOIN study.txo t ON t.sa_id = sp.sa_id AND t.created_tx = sp.tx
),
g AS (
  SELECT sa_id, tx,
         array_agg(value ORDER BY value DESC) FILTER (WHERE pure) AS v,
         sum(value) FILTER (WHERE pure) AS s,
         count(*) FILTER (WHERE pure) AS n,
         count(*) AS n_all
    FROM outs GROUP BY sa_id, tx
)
SELECT sa_id, tx
  FROM g
 WHERE n = 7 AND s > 0
   AND ({{x21_others_allowed}} OR n_all = 7)
   AND abs(v[1] / s - 0.50) <= 0.002
   AND abs(v[2] / s - 0.15) <= 0.002
   AND abs(v[3] / s - 0.10) <= 0.002
   AND abs(v[4] / s - 0.10) <= 0.002
   AND abs(v[5] / s - 0.05) <= 0.002
   AND abs(v[6] / s - 0.05) <= 0.002
   AND abs(v[7] / s - 0.05) <= 0.002;

-- Per frame of the sample, less the wallets the reconstruction check excluded:
-- wallets flagged by each classifier over their whole history, and those with
-- a flagged transaction inside the frame's window.
-- @query prior_counts
SELECT f.frame,
       count(*) AS n_wallets,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM study.prior_unfrackit p WHERE p.sa_id = f.sa_id AND p.key_spend)) AS unfrackit_any,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM study.prior_unfrackit p WHERE p.sa_id = f.sa_id AND p.key_spend
                                       AND p.tx BETWEEN f.lo AND f.hi)) AS unfrackit_in_window,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM study.prior_unfrackit p WHERE p.sa_id = f.sa_id)) AS unfrackit_any_incl_script_inputs,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM study.prior_evolution p WHERE p.sa_id = f.sa_id)) AS evolution_any,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM study.prior_evolution p WHERE p.sa_id = f.sa_id
                                       AND p.tx BETWEEN f.lo AND f.hi)) AS evolution_in_window
  FROM study.sample_frame f
 WHERE NOT EXISTS (SELECT 1 FROM study.reconstruction_check k WHERE k.sa_id = f.sa_id AND NOT k.agree)
 GROUP BY f.frame ORDER BY f.frame DESC;
