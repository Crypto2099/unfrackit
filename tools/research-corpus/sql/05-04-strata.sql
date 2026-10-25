-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- Section 5.4 of the pre-registration: the purposive strata, including the
-- frozen NFT query and the frozen holder floor of the fungible part.
--
-- The list has four parts, processed in this order:
--   1. the named projects (Clay Nation and SpaceBudz, NFT; NIGHT, IAG, HOSKY
--      and SNEK, fungible), always included and exempt from the floor, unless
--      the scam screen lists an asset of their policy;
--   2. ten fungible tokens taken from the CoinGecko candidates captured on the
--      date of the hypotheses record (data/strata-mainnet.json, in
--      market-capitalization order, after ADA, bridged or wrapped assets and
--      stablecoins and tokenized commodities were excluded): candidates are
--      taken in order, skipping any held by fewer than 1,000 stake credentials
--      (ft_floor) of the recent frame at the snapshot, until ten (ft_n)
--      qualify; a candidate that is also a named token is skipped;
--   3. the ten NFT policies of rule 3, computed once on the recent frame at
--      the snapshot and used for both frames;
--   4. the stablecoins and tokenized commodities of the same capture (the
--      strata file's part4 list, in market-capitalization order), every one
--      held by at least 1,000 stake credentials (sc_floor) of the recent frame
--      at the snapshot, counted as in part 2, one stratum each. Part 4 is
--      filled after part 3, so adding it leaves the strata of parts 1 to 3 as
--      they would otherwise be.
-- The computed parts are frozen for both frames. The scam screen
-- (05-04-scam-screen.sql) keeps every policy in study.scam_policy out of every
-- part: a screened named row gives no stratum, a screened candidate of part 2
-- or 4 is skipped so the next one is taken, and the NFT ranking of part 3
-- leaves screened policies out before ranking.
--
-- Read as: "held by a stake credential in the frame" counts the eligible
-- wallets of the recent frame at the snapshot, held UTxOs included (x9), as
-- the NFT part does. Fungible rows match policy and asset name, NFT rows the
-- policy (x10); the two SpaceBudz policies are two strata of 50
-- (x10_spacebudz_one merges them); rows are processed in list order, each
-- taking 50 eligible holders of the frame in draw order and skipping wallets
-- already in that frame's random, ADA-only and earlier strata samples
-- (x10_skip_random_only skips only the random sample). Holders are taken at
-- the snapshot (recent) or at the peak window's start or end (peak). A policy
-- with no holders gives no stratum.
--
-- The NFT query: a policy counts only if no asset of it ever had a running
-- supply above one (X11 as decided on 2026-10-21): mints minus burns of each
-- asset, summed in chain order (ma_tx_mint by transaction id, which the order
-- check shows is chain order), must never exceed 1. A CIP-25 re-mint after a
-- burn stays an NFT (CIP-25, "Update metadata link for a specific token");
-- an asset ever outstanding in two or more units does not. db-sync inserts no
-- ma_tx_mint rows for phase-2-invalid transactions, so no validity filter is
-- needed. Inside the surviving policies the per-wallet class of section 6.2
-- applies (study.is_fungible_l): per eligible recent-frame wallet and asset,
-- the total quantity held at the snapshot including held UTxOs. Count the
-- distinct wallets per policy holding at least one non-fungible asset of it;
-- drop the policies the list marks nft_top_exclude (the named NFT policies);
-- order by count descending, then policy bytes ascending; take ten. An
-- nft-top stratum takes holders of the assets the ranking counted: assets of
-- the policy without a CIP-67 label 333 or 444 (every holding of such a
-- policy is one unit, so the per-wallet class reduces to the label).

-- @step strata_list_table
-- @outputs study.strata_list study.strata_candidate study.strata_sc
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
DROP TABLE IF EXISTS study.strata_candidate;
CREATE TABLE study.strata_candidate (
  rank integer PRIMARY KEY CHECK (rank BETWEEN 1 AND 899),
  stratum text NOT NULL,
  project text NOT NULL,
  policy bytea NOT NULL CHECK (length(policy) = 28),
  asset_name bytea NOT NULL CHECK (length(asset_name) <= 32)
);
DROP TABLE IF EXISTS study.strata_sc;
CREATE TABLE study.strata_sc (
  rank integer PRIMARY KEY CHECK (rank BETWEEN 1 AND 899),
  stratum text NOT NULL,
  project text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('stablecoin', 'tokenized commodity')),
  policy bytea NOT NULL CHECK (length(policy) = 28),
  asset_name bytea NOT NULL CHECK (length(asset_name) <= 32)
);

-- The driver binds the named rows and the candidates as JSON.
-- @query strata_list_load
INSERT INTO study.strata_list (ord, stratum, project, class, policy, asset_name, nft_top_exclude)
SELECT x.ord, x.stratum, x.project, x.class, decode(x.policy, 'hex'),
       CASE WHEN x.asset_name IS NULL THEN NULL ELSE decode(x.asset_name, 'hex') END, x.nft_top_exclude
  FROM json_to_recordset($1::json) AS x(ord integer, stratum text, project text, class text, policy text, asset_name text, nft_top_exclude boolean);

-- @query strata_candidate_load
INSERT INTO study.strata_candidate (rank, stratum, project, policy, asset_name)
SELECT x.rank, x.stratum, x.project, decode(x.policy, 'hex'), decode(x.asset_name, 'hex')
  FROM json_to_recordset($1::json) AS x(rank integer, stratum text, project text, policy text, asset_name text);

-- @query strata_sc_load
INSERT INTO study.strata_sc (rank, stratum, project, kind, policy, asset_name)
SELECT x.rank, x.stratum, x.project, x.kind, decode(x.policy, 'hex'), decode(x.asset_name, 'hex')
  FROM json_to_recordset($1::json) AS x(rank integer, stratum text, project text, kind text, policy text, asset_name text);

-- @step ft_floor
-- @outputs study.ft_floor
DROP TABLE IF EXISTS study.ft_floor;
CREATE TABLE study.ft_floor AS
WITH c AS (
  SELECT c.*,
         EXISTS (SELECT 1 FROM study.strata_list n
                  WHERE n.class = 'FT' AND n.policy = c.policy AND n.asset_name = c.asset_name) AS named,
         c.policy IN (SELECT policy FROM study.scam_policy) AS screened
    FROM study.strata_candidate c
),
h AS (
  SELECT c.rank, count(DISTINCT t.sa_id) AS n_holders
    FROM c
    JOIN study.asset s ON s.policy = c.policy AND s.name = c.asset_name
    JOIN study.txo_asset a ON a.ident = s.ident
    JOIN study.txo t ON t.tx_out_id = a.tx_out_id
    JOIN study.frame f ON f.frame = 'recent' AND f.sa_id = t.sa_id AND f.eligible
   WHERE NOT c.named
     AND t.created_tx <= {{snap_tx}} AND (t.consumed_tx IS NULL OR t.consumed_tx > {{snap_tx}})
   GROUP BY c.rank
),
q AS (
  SELECT c.rank, c.stratum, c.project, c.policy, c.asset_name, c.named, c.screened,
         coalesce(h.n_holders, 0) AS n_holders,
         (NOT c.named AND NOT c.screened AND coalesce(h.n_holders, 0) >= {{ft_floor}}) AS qualifies
    FROM c LEFT JOIN h ON h.rank = c.rank
)
SELECT q.*,
       (q.qualifies AND count(*) FILTER (WHERE q.qualifies) OVER (ORDER BY q.rank ROWS UNBOUNDED PRECEDING) <= {{ft_n}}) AS taken
  FROM q;

-- Part 4: every listed stablecoin and tokenized commodity held by at least
-- sc_floor eligible wallets of the recent frame at the snapshot, held UTxOs
-- included, as part 2 counts them; no count limit.
-- @step sc_floor
-- @outputs study.sc_floor
DROP TABLE IF EXISTS study.sc_floor;
CREATE TABLE study.sc_floor AS
WITH h AS (
  SELECT c.rank, count(DISTINCT t.sa_id) AS n_holders
    FROM study.strata_sc c
    JOIN study.asset s ON s.policy = c.policy AND s.name = c.asset_name
    JOIN study.txo_asset a ON a.ident = s.ident
    JOIN study.txo t ON t.tx_out_id = a.tx_out_id
    JOIN study.frame f ON f.frame = 'recent' AND f.sa_id = t.sa_id AND f.eligible
   WHERE t.created_tx <= {{snap_tx}} AND (t.consumed_tx IS NULL OR t.consumed_tx > {{snap_tx}})
   GROUP BY c.rank
)
SELECT c.rank, c.stratum, c.project, c.kind, c.policy, c.asset_name,
       c.policy IN (SELECT policy FROM study.scam_policy) AS screened,
       coalesce(h.n_holders, 0) AS n_holders,
       (c.policy NOT IN (SELECT policy FROM study.scam_policy) AND coalesce(h.n_holders, 0) >= {{sc_floor}}) AS qualifies,
       (c.policy NOT IN (SELECT policy FROM study.scam_policy) AND coalesce(h.n_holders, 0) >= {{sc_floor}}) AS taken
  FROM study.strata_sc c LEFT JOIN h ON h.rank = c.rank;

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
n AS (
  SELECT s.policy, count(DISTINCT h.sa_id) AS n_holders
    FROM h JOIN study.asset s ON s.ident = h.ident
   WHERE NOT study.is_fungible_l(s.label, h.qty)
   GROUP BY s.policy
),
candidate_ident AS (
  SELECT s.ident FROM study.asset s JOIN n ON n.policy = s.policy
),
running AS (
  SELECT mm.ident,
         sum(mm.quantity) OVER (PARTITION BY mm.ident ORDER BY mm.tx_id ROWS UNBOUNDED PRECEDING) AS supply
    FROM public.ma_tx_mint mm
   WHERE mm.tx_id <= {{snap_tx}} AND mm.ident IN (SELECT ident FROM candidate_ident)
),
supply_over_one AS (
  SELECT DISTINCT s.policy FROM running r JOIN study.asset s ON s.ident = r.ident WHERE r.supply > 1
)
SELECT n.policy, n.n_holders, row_number() OVER (ORDER BY n.n_holders DESC, n.policy ASC) AS rank
  FROM n
 WHERE n.policy NOT IN (SELECT policy FROM study.strata_list WHERE nft_top_exclude)
   AND n.policy NOT IN (SELECT policy FROM supply_over_one)
   AND n.policy NOT IN (SELECT policy FROM study.scam_policy);
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
                                AND (NOT l.nft_only OR coalesce(s.label NOT IN (333, 444), true))
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
SELECT ord, stratum, class, policy, asset_name, false AS nft_only, 'named'::text AS part FROM study.strata_list
 WHERE policy NOT IN (SELECT policy FROM study.scam_policy)
UNION ALL
SELECT 100 + rank, stratum, 'FT', policy, asset_name, false, 'coingecko' FROM study.ft_floor WHERE taken
UNION ALL
SELECT 1000 + rank::integer, 'nft-top-' || lpad(rank::text, 2, '0'), 'NFT', policy, NULL::bytea, true, 'nft-top' FROM study.nft_top
UNION ALL
SELECT 2000 + rank, stratum, 'FT', policy, asset_name, false, 'stable-commodity' FROM study.sc_floor WHERE taken;
DELETE FROM study.sample WHERE kind = 'stratum';
SELECT study.fill_strata('recent', {{snap_tx}}, {{snap_tx}}, {{strata_n}}, {{x10_skip_random_only}});
SELECT study.fill_strata('peak', {{peak_t_start}}, {{peak_t_end}}, {{strata_n}}, {{x10_skip_random_only}});

-- @query strata_report
SELECT a.ord, a.stratum, a.part, a.class, encode(a.policy, 'hex') AS policy, encode(a.asset_name, 'hex') AS asset_name,
       (SELECT n_holders FROM study.nft_top n WHERE n.policy = a.policy AND a.part = 'nft-top') AS nft_top_holders,
       (SELECT count(*) FROM study.sample x WHERE x.kind = 'stratum' AND x.stratum = a.stratum AND x.frame = 'recent') AS n_recent,
       (SELECT count(*) FROM study.sample x WHERE x.kind = 'stratum' AND x.stratum = a.stratum AND x.frame = 'peak') AS n_peak
  FROM study.strata_all a ORDER BY a.ord;

-- @query sc_floor_report
SELECT rank, stratum, project, kind, encode(policy, 'hex') AS policy, encode(asset_name, 'hex') AS asset_name,
       screened, n_holders, qualifies, taken
  FROM study.sc_floor ORDER BY rank;

-- @query ft_floor_report
SELECT rank, stratum, project, encode(policy, 'hex') AS policy, encode(asset_name, 'hex') AS asset_name,
       named, screened, n_holders, qualifies, taken
  FROM study.ft_floor ORDER BY rank;
