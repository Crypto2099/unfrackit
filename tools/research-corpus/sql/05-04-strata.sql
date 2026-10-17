-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- Section 5.4 of the pre-registration: the purposive strata, including the
-- frozen NFT query.
--
-- The list is the section's draft table as frozen (loaded by the driver from a
-- data file into study.strata_list, rows in table order), plus the ten NFT
-- policies of the list's rule 3, computed once on the recent frame at the
-- snapshot and used for both frames.
--
-- Read as: fungible rows match policy and asset name, NFT rows the policy; the
-- two SpaceBudz policies are two strata of 50 (x10_spacebudz_one merges them);
-- rows are processed in table order, each taking 50 eligible holders of the
-- frame in draw order and skipping wallets already in that frame's random,
-- ADA-only and earlier strata samples (x10_skip_random_only skips only the
-- random sample). Holders are taken at the snapshot (recent) or at the peak
-- window's start or end (peak). A policy with no holders gives no stratum.
--
-- The NFT query: per eligible recent-frame wallet and asset, the total
-- quantity held at the snapshot including held UTxOs; class by the rule of
-- section 6.2 (study.is_fungible_l, so a fungible held as one unit counts as an
-- NFT); count the distinct wallets per policy holding at least one
-- non-fungible asset of it; drop the policies the list marks nft_top_exclude
-- (the named NFT policies: Clay Nation and both SpaceBudz policies); order by
-- count descending, then policy bytes ascending; take ten. With x11_supply on,
-- policies with an asset whose minted supply up to the snapshot is above 1 are
-- dropped as well.

-- @step strata_list_table
-- @outputs study.strata_list
DROP TABLE IF EXISTS study.strata_list;
CREATE TABLE study.strata_list (
  ord integer PRIMARY KEY,
  stratum text NOT NULL,
  project text NOT NULL,
  class text NOT NULL CHECK (class IN ('NFT', 'FT')),
  policy bytea NOT NULL CHECK (length(policy) = 28),
  asset_name bytea CHECK (asset_name IS NULL OR length(asset_name) <= 32),
  nft_top_exclude boolean NOT NULL,
  CHECK ((class = 'NFT') = (asset_name IS NULL))
);

-- The driver binds the list as JSON.
-- @query strata_list_load
INSERT INTO study.strata_list (ord, stratum, project, class, policy, asset_name, nft_top_exclude)
SELECT x.ord, x.stratum, x.project, x.class, decode(x.policy, 'hex'),
       CASE WHEN x.asset_name IS NULL THEN NULL ELSE decode(x.asset_name, 'hex') END, x.nft_top_exclude
  FROM json_to_recordset($1::json) AS x(ord integer, stratum text, project text, class text, policy text, asset_name text, nft_top_exclude boolean);

-- @step nft_top
-- @outputs study.nft_top
DROP TABLE IF EXISTS study.nft_top;
CREATE TABLE study.nft_top AS
WITH h AS (
  SELECT t.sa_id, a.ident, sum(a.quantity) AS qty
    FROM study.frame f
    JOIN study.txo t ON t.sa_id = f.sa_id
    JOIN study.txo_asset a ON a.tx_out_id = t.tx_out_id
   WHERE f.frame = 'recent' AND f.eligible
     AND t.created_tx <= {{snap_tx}} AND (t.consumed_tx IS NULL OR t.consumed_tx > {{snap_tx}})
   GROUP BY t.sa_id, a.ident
),
supply_over_one AS (
  SELECT DISTINCT s.policy
    FROM (SELECT mm.ident FROM public.ma_tx_mint mm
           WHERE {{x11_supply}} AND mm.tx_id <= {{snap_tx}}
           GROUP BY mm.ident HAVING sum(mm.quantity) > 1) m
    JOIN study.asset s ON s.ident = m.ident
),
n AS (
  SELECT s.policy, count(DISTINCT h.sa_id) AS n_holders
    FROM h JOIN study.asset s ON s.ident = h.ident
   WHERE NOT study.is_fungible_l(s.label, h.qty)
   GROUP BY s.policy
)
SELECT n.policy, n.n_holders, row_number() OVER (ORDER BY n.n_holders DESC, n.policy ASC) AS rank
  FROM n
 WHERE n.policy NOT IN (SELECT policy FROM study.strata_list WHERE nft_top_exclude)
   AND n.policy NOT IN (SELECT policy FROM supply_over_one);
DELETE FROM study.nft_top WHERE rank > {{nft_top_n}};

-- @lib strata_fn
-- Fills one frame's strata in order. Returns the number of wallets taken.
CREATE OR REPLACE FUNCTION study.fill_strata(p_frame text, p_t1 bigint, p_t2 bigint, p_n integer, p_skip_random_only boolean)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  r record;
  k integer;
  total integer := 0;
BEGIN
  FOR r IN SELECT stratum, min(ord) AS ord FROM study.strata_all GROUP BY stratum ORDER BY min(ord) LOOP
    INSERT INTO study.sample (frame, kind, stratum, sa_id, draw_rank, prevalence_member)
    SELECT p_frame, 'stratum', r.stratum, d.sa_id, d.k, false
      FROM (SELECT DISTINCT t.sa_id
              FROM study.strata_all l
              JOIN study.asset s ON s.policy = l.policy AND (l.asset_name IS NULL OR s.name = l.asset_name)
              JOIN study.txo_asset a ON a.ident = s.ident
              JOIN study.txo t ON t.tx_out_id = a.tx_out_id
             WHERE l.stratum = r.stratum
               AND ((t.created_tx <= p_t1 AND (t.consumed_tx IS NULL OR t.consumed_tx > p_t1))
                 OR (t.created_tx <= p_t2 AND (t.consumed_tx IS NULL OR t.consumed_tx > p_t2)))) h
      JOIN study.draw_order d ON d.frame = p_frame AND d.sa_id = h.sa_id
     WHERE NOT EXISTS (SELECT 1 FROM study.sample x
                        WHERE x.frame = p_frame AND x.sa_id = d.sa_id
                          AND (NOT p_skip_random_only OR x.kind = 'random'))
     ORDER BY d.k
     LIMIT p_n;
    GET DIAGNOSTICS k = ROW_COUNT;
    total := total + k;
  END LOOP;
  RETURN total;
END
$$;

-- @step strata
-- @outputs study.strata_all
DROP TABLE IF EXISTS study.strata_all;
CREATE TABLE study.strata_all AS
SELECT ord, stratum, class, policy, asset_name FROM study.strata_list
UNION ALL
SELECT 1000 + rank::integer, 'nft-top-' || lpad(rank::text, 2, '0'), 'NFT', policy, NULL::bytea FROM study.nft_top;
DELETE FROM study.sample WHERE kind = 'stratum';
SELECT study.fill_strata('recent', {{snap_tx}}, {{snap_tx}}, {{strata_n}}, {{x10_skip_random_only}});
SELECT study.fill_strata('peak', {{peak_t_start}}, {{peak_t_end}}, {{strata_n}}, {{x10_skip_random_only}});

-- @query strata_report
SELECT a.ord, a.stratum, a.class, encode(a.policy, 'hex') AS policy, encode(a.asset_name, 'hex') AS asset_name,
       (SELECT n_holders FROM study.nft_top n WHERE n.policy = a.policy AND a.ord >= 1000) AS nft_top_holders,
       (SELECT count(*) FROM study.sample x WHERE x.kind = 'stratum' AND x.stratum = a.stratum AND x.frame = 'recent') AS n_recent,
       (SELECT count(*) FROM study.sample x WHERE x.kind = 'stratum' AND x.stratum = a.stratum AND x.frame = 'peak') AS n_peak
  FROM study.strata_all a ORDER BY a.ord;
