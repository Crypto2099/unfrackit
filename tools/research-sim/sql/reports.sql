-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- The reads behind the descriptive commands: the H-8 census at the snapshot,
-- near-cap prevalence at every epoch boundary, and the chain-wide collateral
-- measurement over the recent window. Each is the plain query that cannot
-- miss a row; none creates anything. db-sync facts are those of history.sql.

-- Every UTxO of the given wallets at block B, by the reference pattern
-- (history.sql, ref_digests), with the columns an output is re-encoded from.
-- @query utxos_at_block
SELECT o.stake_address_id AS sa_id, o.id AS tx_out_id, o.tx_id, encode(ct.hash, 'hex') AS tx_hash, o.index,
       o.value::text AS value, o.address, o.address_has_script AS script_pay, encode(o.payment_cred, 'hex') AS payment_cred,
       encode(o.data_hash, 'hex') AS data_hash, o.inline_datum_id, o.reference_script_id
  FROM public.tx_out o
  JOIN public.tx ct ON ct.id = o.tx_id
 WHERE o.stake_address_id = ANY({{sa_ids}})
   AND ct.block_id <= {{block_id}}
   AND NOT EXISTS (SELECT 1 FROM public.tx_in i JOIN public.tx st ON st.id = i.tx_in_id
                    WHERE i.tx_out_id = o.tx_id AND i.tx_out_index = o.index AND st.block_id <= {{block_id}});

-- Every key stake credential with at least one output created at or before
-- transaction {{t}}: the wallet set of a census run over the whole chain on a
-- test network, where the extraction's frame is not readable.
-- @query key_wallets_with_outputs
SELECT sa.id
  FROM public.stake_address sa
 WHERE sa.script_hash IS NULL
   AND EXISTS (SELECT 1 FROM public.tx_out o WHERE o.stake_address_id = sa.id AND o.tx_id <= {{t}})
 ORDER BY sa.id;

-- The extraction's eligible recent-frame wallets, when its study tables are
-- readable (tools/research-corpus, sql/05-04-frames.sql).
-- @query study_recent_eligible
SELECT f.sa_id AS id FROM study.frame f WHERE f.frame = 'recent' AND f.eligible ORDER BY f.sa_id;

-- The union of both frames' random samples.
-- @query study_random_samples
SELECT DISTINCT s.sa_id AS id FROM study.sample s WHERE s.kind = 'random' ORDER BY s.sa_id;

-- The last block of every epoch from {{from_epoch}} to {{to_epoch}}.
-- @query epoch_last_blocks
SELECT b.epoch_no, max(b.id) AS last_block
  FROM public.block b
 WHERE b.epoch_no BETWEEN {{from_epoch}} AND {{to_epoch}}
 GROUP BY b.epoch_no
 ORDER BY b.epoch_no;

-- @query first_mary_epoch
SELECT min(epoch_no) AS e FROM public.epoch_param WHERE protocol_major >= 4;

-- @query epoch_limits
SELECT ep.epoch_no, ep.protocol_major, ep.max_val_size::text AS max_val_size
  FROM public.epoch_param ep
 WHERE ep.epoch_no BETWEEN {{from_epoch}} AND {{to_epoch}};

-- The collateral measurement: every transaction of the window [lo, hi] that
-- executes a script (a Plutus redeemer, or phase-2-invalid; native-script
-- evaluation never counts) and whose collateral inputs all sit at key
-- addresses. db-sync keeps a valid transaction's collateral in
-- collateral_tx_in and its return in collateral_tx_out; for a
-- phase-2-invalid one, the collateral is its tx_in rows and the return its
-- one tx_out row. redeemer.tx_id, collateral_tx_in.tx_in_id and
-- collateral_tx_out.tx_id have no index, so each is read in one pass over the
-- window. One row: the transaction and input counts, the counts under 20 ADA,
-- with a return and with tokens, and the distributions of collateral coin per
-- transaction and per input over fixed bins of ADA.
-- @query collateral_summary
WITH red AS (
  SELECT DISTINCT r.tx_id FROM public.redeemer r WHERE r.tx_id BETWEEN {{lo}} AND {{hi}}
),
inv AS (
  SELECT t.id AS tx_id FROM public.tx t WHERE t.id BETWEEN {{lo}} AND {{hi}} AND NOT t.valid_contract
),
cin AS (
  SELECT c.tx_in_id AS tx_id, c.tx_out_id, c.tx_out_index
    FROM public.collateral_tx_in c
   WHERE c.tx_in_id BETWEEN {{lo}} AND {{hi}}
     AND c.tx_in_id IN (SELECT tx_id FROM red)
  UNION ALL
  SELECT i.tx_in_id, i.tx_out_id, i.tx_out_index
    FROM public.tx_in i
   WHERE i.tx_in_id IN (SELECT tx_id FROM inv)
),
ret AS (
  SELECT DISTINCT co.tx_id FROM public.collateral_tx_out co WHERE co.tx_id BETWEEN {{lo}} AND {{hi}}
  UNION
  SELECT o.tx_id FROM public.tx_out o WHERE o.tx_id IN (SELECT tx_id FROM inv)
),
inp AS (
  SELECT cin.tx_id, o.value, o.address_has_script AS script_pay,
         EXISTS (SELECT 1 FROM public.ma_tx_out m WHERE m.tx_out_id = o.id) AS has_tokens
    FROM cin
    JOIN public.tx_out o ON o.tx_id = cin.tx_out_id AND o.index = cin.tx_out_index
),
per_tx AS (
  SELECT x.tx_id, sum(inp.value) AS coin, count(inp.tx_id) AS n_inputs,
         count(*) FILTER (WHERE inp.has_tokens) AS n_token_inputs,
         bool_or(inp.script_pay) AS any_script,
         (x.tx_id IN (SELECT tx_id FROM ret)) AS has_return,
         (x.tx_id IN (SELECT tx_id FROM inv)) AS invalid
    FROM (SELECT tx_id FROM red UNION SELECT tx_id FROM inv) x
    LEFT JOIN inp ON inp.tx_id = x.tx_id
   GROUP BY x.tx_id
),
kept AS (SELECT * FROM per_tx WHERE n_inputs > 0 AND NOT any_script),
bins(i, lo_ada) AS (VALUES (0, 0), (1, 1), (2, 2), (3, 5), (4, 10), (5, 20), (6, 50), (7, 100), (8, 1000))
SELECT
  (SELECT count(*) FROM per_tx) AS n_script_tx,
  (SELECT count(*) FROM per_tx WHERE n_inputs = 0) AS n_no_collateral_read,
  (SELECT count(*) FROM per_tx WHERE any_script) AS n_script_collateral,
  (SELECT count(*) FROM kept) AS n_tx,
  (SELECT count(*) FROM kept WHERE invalid) AS n_invalid,
  (SELECT count(*) FROM kept WHERE coin < 20000000) AS n_under_20_ada,
  (SELECT count(*) FROM kept WHERE has_return) AS n_with_return,
  (SELECT sum(n_inputs) FROM kept)::bigint AS n_inputs,
  (SELECT sum(n_token_inputs) FROM kept)::bigint AS n_token_inputs,
  (SELECT json_agg(json_build_object('from_ada', b.lo_ada, 'n', (SELECT count(*) FROM kept k
      WHERE k.coin >= b.lo_ada * 1000000::numeric
        AND (b.i = 8 OR k.coin < (SELECT b2.lo_ada FROM bins b2 WHERE b2.i = b.i + 1) * 1000000::numeric))) ORDER BY b.i)
     FROM bins b) AS per_tx_bins,
  (SELECT json_agg(json_build_object('from_ada', b.lo_ada, 'n', (SELECT count(*) FROM inp p JOIN kept k ON k.tx_id = p.tx_id
      WHERE p.value >= b.lo_ada * 1000000::numeric
        AND (b.i = 8 OR p.value < (SELECT b2.lo_ada FROM bins b2 WHERE b2.i = b.i + 1) * 1000000::numeric))) ORDER BY b.i)
     FROM bins b) AS per_input_bins,
  (SELECT percentile_disc(ARRAY[0.05, 0.25, 0.5, 0.75, 0.95]) WITHIN GROUP (ORDER BY coin) FROM kept)::text AS per_tx_quantiles;
