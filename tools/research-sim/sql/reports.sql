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

-- The collateral measurement reads the recent window [lo, hi] in a few
-- plain statements and joins them in the command, so that no statement runs
-- long: the transactions that execute a script (a Plutus redeemer, or
-- phase-2-invalid; native-script evaluation never counts), their collateral
-- inputs, the transactions with a collateral return, and then each
-- collateral input's coin, address kind and tokens by its reference.
-- db-sync keeps a valid transaction's collateral in collateral_tx_in and its
-- return in collateral_tx_out; for a phase-2-invalid one, the collateral is
-- its tx_in rows and the return its one tx_out row. redeemer.tx_id,
-- collateral_tx_in.tx_in_id and collateral_tx_out.tx_id have no index, so
-- each of those tables is read in one pass over the window.
-- @query collateral_redeemer_txs
SELECT DISTINCT r.tx_id FROM public.redeemer r WHERE r.tx_id BETWEEN {{lo}} AND {{hi}};

-- @query collateral_invalid_txs
SELECT t.id AS tx_id FROM public.tx t WHERE t.id BETWEEN {{lo}} AND {{hi}} AND NOT t.valid_contract;

-- @query collateral_inputs_valid
SELECT c.tx_in_id AS tx_id, c.tx_out_id, c.tx_out_index
  FROM public.collateral_tx_in c
 WHERE c.tx_in_id BETWEEN {{lo}} AND {{hi}};

-- @query collateral_inputs_invalid
SELECT i.tx_in_id AS tx_id, i.tx_out_id, i.tx_out_index FROM public.tx_in i WHERE i.tx_in_id = ANY({{ids}});

-- @query collateral_return_txs
SELECT DISTINCT co.tx_id FROM public.collateral_tx_out co WHERE co.tx_id BETWEEN {{lo}} AND {{hi}};

-- @query collateral_invalid_returns
SELECT DISTINCT o.tx_id FROM public.tx_out o WHERE o.tx_id = ANY({{ids}});

-- Outputs by (creating transaction id, index): coin, whether at a script
-- payment credential, whether carrying tokens.
-- @query collateral_outputs
WITH r AS (SELECT * FROM unnest({{tx_ids}}, {{indexes}}) AS r(t, i))
SELECT o.tx_id, o.index, o.value::text AS value, o.address_has_script AS script_pay,
       EXISTS (SELECT 1 FROM public.ma_tx_out m WHERE m.tx_out_id = o.id) AS has_tokens
  FROM r
  JOIN public.tx_out o ON o.tx_id = r.t AND o.index = r.i;
