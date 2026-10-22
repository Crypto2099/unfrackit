-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- Sections 5.4 and 5.5 of the pre-registration: the two frames, their screens
-- and exclusions, and the flow table.
--
-- Frames are exact: every stake credential with a key hash, less Adam K.
-- Dean's keys, screened in SQL as of the snapshot block.
--   recent  at least one transaction (spend or receipt) in the recent window,
--           at least one UTxO at the snapshot, and the exclusions at the
--           snapshot
--   peak    at least one spend between the peak window's first and last block,
--           no condition on the state today, and the exclusions as of the
--           window's end
-- Stages, each counted in study.flow, applied in this order:
--   1 activity in the window     2 script credentials     3 consented keys
--   4 at least one UTxO at the snapshot (recent only; the removed count is the
--     number emptied during the window)
--   5 more than 20,000 UTxOs at the reference block
--   6 more than 200 distinct key payment credentials (counted as x12_history
--     says; script payment credentials are contracts the wallet used, decided
--     2026-10-21)
--   7 more than half of the lovelace at script payment credentials
-- Eligible wallets with more than 5,000 transactions in the window are counted,
-- not removed. Beside stage 6, the report counts the wallets the cap would
-- have removed had it counted script payment credentials too (n_pay), which
-- it keeps: heavy users of per-user script addresses.
--
-- Token-holding: at least one native asset at the snapshot (recent) or at the
-- peak window's start or end (peak); held UTxOs count (x9_count_held). The
-- draw's conditions: (b) at least 5 spends in the window; (c) 100 or more
-- tokens, read as distinct assets at the reference block, for the peak frame
-- at its start or end (x8_measure selects distinct, units or nft).
--
-- The draw and split keys: SHA-256 of the ASCII bytes of "draw" (or "split"),
-- then the 32 raw bytes of h, then the 28 raw bytes of the stake credential's
-- hash (x5_reward29 uses the 29-byte reward address instead). bytea compares
-- bytewise, which orders the digests as big-endian numbers. Keys are computed
-- for every key credential of the frame, so the consented keys' positions can
-- be counted although they are never drawn.

-- @step frame
-- @outputs study.frame
DROP TABLE IF EXISTS study.frame;
CREATE TABLE study.frame AS
WITH rec AS (
  SELECT 'recent'::text AS frame, a.sa_id, a.n_tx, a.n_spends, a.n_spends_key, a.n_spends_any,
         coalesce(s.n_utxo, 0) AS n_utxo,
         coalesce(s.lovelace, 0) AS lovelace,
         coalesce(s.lovelace_all, 0) AS lovelace_all,
         coalesce(s.lovelace_script_pay, 0) AS lovelace_script_pay,
         coalesce(p.n_pay, 0) AS n_pay, coalesce(p.n_pay_key, 0) AS n_pay_key,
         coalesce(s.n_assets, 0) AS n_assets_a, coalesce(s.n_assets, 0) AS n_assets_b,
         coalesce(s.n_nft, 0) AS n_nft_a, coalesce(s.n_nft, 0) AS n_nft_b,
         coalesce(s.n_units, 0) AS n_units_a, coalesce(s.n_units, 0) AS n_units_b
    FROM study.activity a
    LEFT JOIN study.state s ON s.point = 'snap' AND s.sa_id = a.sa_id
    LEFT JOIN study.paycount p ON p.point = 'snap' AND p.sa_id = a.sa_id
   WHERE a.win = 'recent' AND a.n_tx >= 1
),
pk AS (
  SELECT 'peak'::text AS frame, a.sa_id, a.n_tx, a.n_spends, a.n_spends_key, a.n_spends_any,
         coalesce(e.n_utxo, 0), coalesce(e.lovelace, 0), coalesce(e.lovelace_all, 0), coalesce(e.lovelace_script_pay, 0),
         coalesce(p.n_pay, 0), coalesce(p.n_pay_key, 0),
         coalesce(b.n_assets, 0), coalesce(e.n_assets, 0),
         coalesce(b.n_nft, 0), coalesce(e.n_nft, 0),
         coalesce(b.n_units, 0), coalesce(e.n_units, 0)
    FROM study.activity a
    LEFT JOIN study.state b ON b.point = 'peak_start' AND b.sa_id = a.sa_id
    LEFT JOIN study.state e ON e.point = 'peak_end' AND e.sa_id = a.sa_id
    LEFT JOIN study.paycount p ON p.point = 'peak_end' AND p.sa_id = a.sa_id
   WHERE a.win = 'peak' AND a.n_spends >= 1
),
f AS (SELECT * FROM rec UNION ALL SELECT * FROM pk),
g AS (
  SELECT f.*, c.is_script, c.cred_hash, c.hash_raw,
         EXISTS (SELECT 1 FROM study.consented k WHERE k.sa_id = f.sa_id) AS consented,
         (f.frame <> 'recent' OR f.n_utxo >= 1) AS s4,
         (f.n_utxo <= {{utxo_cap}}) AS s5,
         (f.n_pay_key <= {{pay_cred_cap}}) AS s6,
         NOT (f.lovelace_script_pay > {{script_share}} * f.lovelace_all) AS s7,
         (f.n_assets_a >= 1 OR f.n_assets_b >= 1) AS tok,
         (f.n_spends >= {{spends_b_min}}) AS ge5,
         (CASE {{x8_measure}} WHEN 'units' THEN greatest(f.n_units_a, f.n_units_b)
                              WHEN 'nft' THEN greatest(f.n_nft_a, f.n_nft_b)
                              ELSE greatest(f.n_assets_a, f.n_assets_b) END) >= {{assets_c_min}} AS ge100,
         (f.n_tx > {{heavy_tx}}) AS heavy
    FROM f JOIN study.cred c ON c.sa_id = f.sa_id
)
SELECT g.*,
       (NOT g.is_script AND NOT g.consented AND g.s4 AND g.s5 AND g.s6 AND g.s7) AS eligible,
       (NOT g.is_script AND g.s4 AND g.s5 AND g.s6 AND g.s7) AS eligible_unless_consented,
       CASE WHEN NOT g.is_script THEN
         sha256(convert_to('draw', 'UTF8') || {{h}} || CASE WHEN {{x5_reward29}} THEN g.hash_raw ELSE g.cred_hash END)
       END AS draw_key,
       CASE WHEN NOT g.is_script THEN
         sha256(convert_to('split', 'UTF8') || {{h}} || CASE WHEN {{x5_reward29}} THEN g.hash_raw ELSE g.cred_hash END)
       END AS split_key
  FROM g;
CREATE UNIQUE INDEX frame_frame_sa ON study.frame (frame, sa_id);
CREATE INDEX frame_frame_draw ON study.frame (frame, draw_key);
ANALYZE study.frame;

-- @step flow
-- @outputs study.flow
DROP TABLE IF EXISTS study.flow;
CREATE TABLE study.flow AS
WITH n0 AS (SELECT count(*) AS n FROM study.cred),
st AS (
  SELECT fr.frame,
         (SELECT n FROM n0) AS n0,
         count(*) AS n1,
         count(*) FILTER (WHERE NOT is_script) AS n2,
         count(*) FILTER (WHERE NOT is_script AND NOT consented) AS n3,
         count(*) FILTER (WHERE NOT is_script AND NOT consented AND s4) AS n4,
         count(*) FILTER (WHERE NOT is_script AND NOT consented AND s4 AND s5) AS n5,
         count(*) FILTER (WHERE NOT is_script AND NOT consented AND s4 AND s5 AND s6) AS n6,
         count(*) FILTER (WHERE NOT is_script AND NOT consented AND s4 AND s5 AND s6 AND s7) AS n7
    FROM (VALUES ('recent'::text), ('peak'::text)) fr(frame)
    LEFT JOIN study.frame f ON f.frame = fr.frame
   GROUP BY fr.frame
)
SELECT st.frame, v.stage_no, v.stage, v.n_in, v.n_in - v.n_out AS n_removed, v.n_out
  FROM st
 CROSS JOIN LATERAL (VALUES
   (1, 'activity in the window', st.n0, st.n1),
   (2, 'script stake credentials removed', st.n1, st.n2),
   (3, 'consented keys removed', st.n2, st.n3),
   (4, 'no UTxO at the snapshot (recent frame only)', st.n3, st.n4),
   (5, 'more than 20,000 UTxOs at the reference block', st.n4, st.n5),
   (6, 'more than 200 distinct key payment credentials', st.n5, st.n6),
   (7, 'more than half of the lovelace at script payment credentials', st.n6, st.n7),
   (8, 'eligible', st.n7, st.n7)
 ) v(stage_no, stage, n_in, n_out)
 ORDER BY st.frame, v.stage_no;

-- @query flow_rows
SELECT frame, stage_no, stage, n_in, n_removed, n_out FROM study.flow ORDER BY frame DESC, stage_no;

-- Counts reported beside the flow table.
-- @query frame_report
SELECT frame,
       count(*) FILTER (WHERE eligible) AS eligible,
       count(*) FILTER (WHERE eligible AND tok) AS eligible_token_holding,
       count(*) FILTER (WHERE eligible AND NOT tok) AS eligible_ada_only,
       count(*) FILTER (WHERE eligible AND tok AND ge5) AS eligible_tok_ge5,
       count(*) FILTER (WHERE eligible AND tok AND ge100) AS eligible_tok_ge100,
       count(*) FILTER (WHERE eligible AND heavy) AS eligible_over_5000_tx,
       count(*) FILTER (WHERE consented) AS consented_in_stage1,
       count(*) FILTER (WHERE consented AND eligible_unless_consented) AS consented_otherwise_eligible,
       count(*) FILTER (WHERE eligible AND n_spends_key <> n_spends_any) AS eligible_x2_differs,
       count(*) FILTER (WHERE NOT is_script AND NOT consented AND frame = 'recent' AND NOT s4) AS emptied_during_window,
       count(*) FILTER (WHERE NOT is_script AND NOT consented AND s4 AND s5 AND s6
                          AND n_pay > {{pay_cred_cap}}) AS s6_kept_by_key_count
  FROM study.frame GROUP BY frame ORDER BY frame DESC;
