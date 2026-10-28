-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- The scam screen of the strata: no policy that the scam list names an asset
-- of becomes a stratum in any part, the named projects included. Wallets that
-- received such tokens stay in every sample with their full UTxO sets.
--
-- The list (src/scam-list.mjs) names assets by CIP-14 fingerprint. A
-- fingerprint is a one-way digest of policy id || asset name, so it is
-- resolved through db-sync's own column, multi_asset.fingerprint, which has
-- no index: the resolution is one sequential pass over multi_asset. Any
-- listed asset then excludes its whole policy, which covers a CIP-68 token's
-- reference twin and the sibling mints under the same policy (the
-- fingerprint covers the whole asset name, label prefix included, so the two
-- CIP-68 tokens have different fingerprints). The driver recomputes the
-- fingerprint of every resolved asset from its policy and name and refuses a
-- run in which db-sync's column disagrees.
--
-- With no list given (test networks only), study.scam_fp is empty and the
-- screen excludes nothing.

-- @step scam_list_table
-- @outputs study.scam_fp
DROP TABLE IF EXISTS study.scam_fp;
CREATE TABLE study.scam_fp (fingerprint text PRIMARY KEY CHECK (fingerprint ~ '^asset1[02-9ac-hj-np-z]{38}$'));

-- The driver binds the fingerprints as a JSON array of strings.
-- @query scam_fp_load
INSERT INTO study.scam_fp (fingerprint)
SELECT x FROM json_array_elements_text($1::json) AS e(x);

-- @step scam_policy
-- @outputs study.scam_asset study.scam_policy
DROP TABLE IF EXISTS study.scam_policy;
DROP TABLE IF EXISTS study.scam_asset;
CREATE TABLE study.scam_asset AS
SELECT f.fingerprint, ma.id AS ident, ma.policy, ma.name
  FROM study.scam_fp f
  JOIN public.multi_asset ma ON ma.fingerprint = f.fingerprint;
CREATE TABLE study.scam_policy AS
SELECT DISTINCT policy FROM study.scam_asset;
ALTER TABLE study.scam_policy ADD PRIMARY KEY (policy);
ANALYZE study.scam_policy;

-- The resolved assets, for the driver's recomputation of each fingerprint.
-- @query scam_asset_rows
SELECT fingerprint, encode(policy, 'hex') AS policy, encode(name, 'hex') AS name FROM study.scam_asset ORDER BY fingerprint, ident;

-- @query scam_counts
SELECT (SELECT count(*) FROM study.scam_fp) AS n_fingerprints,
       (SELECT count(DISTINCT fingerprint) FROM study.scam_asset) AS n_resolved,
       (SELECT count(*) FROM study.scam_fp f WHERE NOT EXISTS (SELECT 1 FROM study.scam_asset a WHERE a.fingerprint = f.fingerprint)) AS n_unresolved,
       (SELECT count(*) FROM study.scam_policy) AS n_policies;

-- Descriptive only, to catch a list error: every excluded policy that also
-- holds assets the list does not name, with the number of such assets and
-- the eligible wallets of the recent frame holding any of them at the
-- snapshot, held UTxOs included (the count the floors use). The assets of a
-- policy are read from multi_asset by policy, on its (policy, name) index.
-- @query scam_policy_report
WITH a AS (
  SELECT p.policy, ma.id AS ident,
         EXISTS (SELECT 1 FROM study.scam_fp f WHERE f.fingerprint = ma.fingerprint) AS listed
    FROM study.scam_policy p
    JOIN public.multi_asset ma ON ma.policy = p.policy
),
u AS (
  SELECT policy, count(*) FILTER (WHERE listed) AS n_listed, count(*) FILTER (WHERE NOT listed) AS n_unlisted
    FROM a GROUP BY policy
),
h AS (
  SELECT a.policy, count(DISTINCT t.sa_id) AS n_unlisted_holders
    FROM a
    JOIN study.txo_asset x ON x.ident = a.ident
    JOIN study.txo t ON t.tx_out_id = x.tx_out_id
    JOIN study.frame f ON f.frame = 'recent' AND f.sa_id = t.sa_id AND f.eligible
   WHERE NOT a.listed
     AND t.created_tx <= {{snap_tx}} AND (t.consumed_tx IS NULL OR t.consumed_tx > {{snap_tx}})
   GROUP BY a.policy
)
SELECT encode(u.policy, 'hex') AS policy, u.n_listed, u.n_unlisted, coalesce(h.n_unlisted_holders, 0) AS n_unlisted_holders
  FROM u LEFT JOIN h ON h.policy = u.policy
 WHERE u.n_unlisted > 0
 ORDER BY u.policy;

-- The strata rows the screen kept out, in list order: named rows, part 2
-- candidates and part 4 coins (the NFT ranking of part 3 skips a screened
-- policy before ranking, so the next policy takes its place).
-- @query scam_screened_rows
SELECT 'named' AS part, l.ord AS rank, l.stratum FROM study.strata_list l WHERE l.policy IN (SELECT policy FROM study.scam_policy)
UNION ALL
SELECT 'coingecko', c.rank, c.stratum FROM study.strata_candidate c WHERE c.policy IN (SELECT policy FROM study.scam_policy)
UNION ALL
SELECT 'stable-commodity', c.rank, c.stratum FROM study.strata_sc c WHERE c.policy IN (SELECT policy FROM study.scam_policy)
ORDER BY 1, 2;

-- A later version of the list, for the sensitivity analysis on a finished
-- run: the policies its fingerprints resolve to, read like the screen's.
-- @query scam_recheck_policies
SELECT DISTINCT encode(ma.policy, 'hex') AS policy
  FROM public.multi_asset ma
 WHERE ma.fingerprint = ANY ($1::text[]);

-- The finished run's strata, each with its policies.
-- @query scam_recheck_strata
SELECT a.stratum, a.part, min(a.ord) AS ord, array_agg(DISTINCT encode(a.policy, 'hex')) AS policies
  FROM study.strata_all a
 GROUP BY a.stratum, a.part
 ORDER BY min(a.ord);
