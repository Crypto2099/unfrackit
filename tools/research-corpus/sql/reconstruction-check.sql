-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- The reconstruction check: for every sampled wallet at the snapshot, the set
-- from the reference query, the set from the life table and the set read
-- directly are compared as sets of (transaction hash, index, lovelace, sorted
-- assets). A wallet whose sets differ is excluded and counted:
-- study.sample.reconstruction_excluded is set for every sample row, and every
-- count over the sample after this step leaves excluded wallets out.
--
-- The driver runs the three digest queries of utxo-at-block.sql over the
-- sampled wallets in batches and loads the results here, so the check uses the
-- same SQL the integration tests compare. "Read directly" is only meaningful
-- when the database tip is the snapshot block, which holds when db-sync is
-- stopped there for the run; direct_valid records whether it was.

-- @step reconstruction_check_table
-- @outputs study.reconstruction_check
DROP TABLE IF EXISTS study.reconstruction_check;
CREATE TABLE study.reconstruction_check (
  sa_id bigint PRIMARY KEY,
  n_ref bigint NOT NULL,
  d_ref text NOT NULL,
  n_life bigint NOT NULL,
  d_life text NOT NULL,
  n_direct bigint,
  d_direct text,
  direct_valid boolean NOT NULL,
  agree boolean NOT NULL
);

-- @query reconstruction_check_load
INSERT INTO study.reconstruction_check (sa_id, n_ref, d_ref, n_life, d_life, n_direct, d_direct, direct_valid, agree)
SELECT x.sa_id, x.n_ref, x.d_ref, x.n_life, x.d_life, x.n_direct, x.d_direct, x.direct_valid, x.agree
  FROM json_to_recordset($1::json) AS x(sa_id bigint, n_ref bigint, d_ref text, n_life bigint, d_life text,
                                        n_direct bigint, d_direct text, direct_valid boolean, agree boolean);

-- @query reconstruction_check_mark
UPDATE study.sample s SET reconstruction_excluded = NOT k.agree FROM study.reconstruction_check k WHERE k.sa_id = s.sa_id;

-- Sampled wallets with any output at a pointer address (CIP-19 header types 4
-- and 5, which bech32-encode as addr1g / addr12, or addr_test1g /
-- addr_test12: the first five data bits are the header's type and the high
-- bit of the network tag, 0 on both networks). db-sync gives pointer outputs
-- a stake_address_id before Conway and none from Conway on, so such a wallet
-- keeps its pointer outputs from before Conway and loses later ones.
-- @query pointer_wallets
SELECT count(DISTINCT t.sa_id) AS n_wallets_with_pointer_outputs
  FROM study.txo t
  JOIN study.sample_wallet w ON w.sa_id = t.sa_id AND w.in_sample
  JOIN public.tx_out o ON o.id = t.tx_out_id
 WHERE o.address ~ '^addr(_test)?1[g2]';

-- @query reconstruction_check_counts
SELECT count(*) FILTER (WHERE w.in_sample) AS n_wallets,
       count(*) FILTER (WHERE w.in_sample AND k.agree) AS n_agree,
       count(*) FILTER (WHERE w.in_sample AND NOT k.agree) AS n_excluded,
       count(*) FILTER (WHERE w.in_sample AND k.d_ref <> k.d_life) AS n_ref_life_differ,
       count(*) FILTER (WHERE w.in_sample AND k.direct_valid AND k.d_life <> k.d_direct) AS n_life_direct_differ,
       bool_and(k.direct_valid) AS direct_valid,
       sum(k.n_life) FILTER (WHERE w.in_sample) AS n_utxo_total,
       count(*) FILTER (WHERE NOT w.in_sample) AS n_case_wallets,
       count(*) FILTER (WHERE NOT w.in_sample AND NOT k.agree) AS n_case_disagree
  FROM study.reconstruction_check k JOIN study.sample_wallet w ON w.sa_id = k.sa_id;

-- @query sample_wallet_ids
SELECT sa_id FROM study.sample_wallet ORDER BY sa_id;
