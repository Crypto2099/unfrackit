-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- Sections 5.1 and 5.3 of the pre-registration: the snapshot block and its
-- parameters, the freeze record, the draw key, and the order rule that makes
-- the study's data postdate the freeze (section 10.1): the snapshot block's
-- height must be greater than the height of the block that contains the final
-- freeze transaction.
--
-- The draw key h is the epoch nonce of epoch N (decided 2026-10-21): E is the
-- epoch of the block containing the final freeze transaction; N = E + 1 if
-- that block's slot is earlier than E's first slot plus the epoch length less
-- the randomness stabilisation window, and N = E + 2 otherwise. The nonce is
-- read from epoch_param.nonce and cross-checked with Koios by the driver
-- (src/freeze.mjs), which also reads the freeze record below.
--
-- The snapshot of the study's run is fixed by rule (decided 2026-10-21,
-- refined 2026-10-22): the last block of epoch N - 1 before N - 1's
-- randomness stabilisation cutoff, N being the draw epoch, so the frames are
-- fixed no later than epoch N's nonce. The first block of epoch N must be at
-- least `security_k` (2,160) blocks deep in the database and in Koios before
-- the run reads anything, so whoever starts the run has no choice of block.
-- Wallet state is read as of the snapshot, whatever the database tip. On a
-- test network a run may instead take the tip or a given block.
--
-- Before anything reads the database, the driver checks db-sync's own
-- bookkeeping: the network name, the schema version and the extra migrations.
-- A database with `prune` or `bootstrap` has deleted history and is refused;
-- every database must have tx_in rows (a `consumed` configuration without
-- force_tx_in leaves tx_in empty, and every output would read as unspent), and
-- the probes below must find what this code reads: multi-asset outputs and
-- mints, label-674 metadata, Plutus redeemers, inline datums in recent
-- transactions, and epoch nonces. bytea literals are written with decode(), so
-- they do not depend on standard_conforming_strings, and the driver checks
-- that setting as well.

-- @query db_meta
SELECT m.network_name, m.version, m.start_time::text AS start_time,
       (SELECT row_to_json(s)::text FROM public.schema_version s ORDER BY s.id DESC LIMIT 1) AS schema_version,
       (SELECT coalesce(json_agg(e.token ORDER BY e.id), '[]'::json)::text FROM public.extra_migrations e) AS extra_migrations
  FROM public.meta m;

-- @query tx_in_nonempty
SELECT EXISTS (SELECT 1 FROM public.tx_in) AS nonempty;

-- What the SQL reads, each as true when present. Recent transactions only
-- for the inline-datum and label-674 probes, through tx_out(tx_id) and
-- tx_metadata(tx_id).
-- @query db_probes
WITH last AS (SELECT max(id) AS t FROM public.tx)
SELECT EXISTS (SELECT 1 FROM public.tx_in) AS tx_in,
       EXISTS (SELECT 1 FROM public.multi_asset) AS multi_asset,
       EXISTS (SELECT 1 FROM public.ma_tx_out) AS ma_tx_out,
       EXISTS (SELECT 1 FROM public.ma_tx_mint) AS ma_tx_mint,
       EXISTS (SELECT 1 FROM public.tx_metadata m WHERE m.tx_id > (SELECT t FROM last) - 1000000 AND m.key = 674) AS metadata_674,
       EXISTS (SELECT 1 FROM public.redeemer) AS redeemer,
       EXISTS (SELECT 1 FROM public.tx_out o WHERE o.tx_id > (SELECT t FROM last) - 1000000 AND o.inline_datum_id IS NOT NULL) AS inline_datum,
       EXISTS (SELECT 1 FROM public.epoch_param WHERE nonce IS NOT NULL) AS epoch_nonce;

-- @query tip_block
SELECT id, block_no, slot_no, epoch_no, time::text AS time, encode(hash, 'hex') AS hash
  FROM public.block ORDER BY id DESC LIMIT 1;

-- @query block_by_hash
SELECT id, block_no, slot_no, epoch_no, time::text AS time, encode(hash, 'hex') AS hash
  FROM public.block WHERE hash = {{block_hash}};

-- @query block_by_id
SELECT id, block_no, slot_no, epoch_no, time::text AS time, encode(hash, 'hex') AS hash
  FROM public.block WHERE id = {{block_id}};

-- The block of a transaction: the freeze transactions on mainnet, the stand-in
-- (S1's seeding transaction) on preprod.
-- @query block_of_tx
SELECT t.id AS tx_id, b.id, b.block_no, b.slot_no, b.epoch_no, b.epoch_slot_no, b.time::text AS time, encode(b.hash, 'hex') AS hash
  FROM public.tx t JOIN public.block b ON b.id = t.block_id
 WHERE t.hash = {{tx_hash}};

-- A transaction's metadata under labels 309 and 674: the bytes db-sync stores
-- (the CBOR of the single-label map, re-encoded by db-sync; the byte strings
-- inside it are as published) and the JSON view.
-- @query tx_metadata_of_tx
SELECT m.key, encode(m.bytes, 'hex') AS bytes, m.json::text AS json
  FROM public.tx_metadata m JOIN public.tx t ON t.id = m.tx_id
 WHERE t.hash = {{tx_hash}} AND m.key IN (309, 674)
 ORDER BY m.key;

-- The snapshot by rule is the last block of epoch N - 1 before N - 1's
-- stabilisation cutoff; the first block of epoch N shows that N - 1 is
-- complete in the database, and its depth is the rule's depth.
-- @query last_block_before_slot
SELECT id, block_no, slot_no, epoch_no, time::text AS time, encode(hash, 'hex') AS hash
  FROM public.block WHERE epoch_no = {{epoch_no}} AND slot_no < {{slot_no}} ORDER BY id DESC LIMIT 1;

-- @query first_block_of_epoch
SELECT id, block_no, slot_no, epoch_slot_no, encode(hash, 'hex') AS hash FROM public.block WHERE epoch_no = {{epoch_no}} ORDER BY id LIMIT 1;

-- Every label-309 value from a transaction id on, in transaction order, for
-- the chain's order of the study's records.
-- @query label_309_from
SELECT encode(t.hash, 'hex') AS tx, m.tx_id, encode(m.bytes, 'hex') AS bytes
  FROM public.tx_metadata m JOIN public.tx t ON t.id = m.tx_id
 WHERE m.key = 309 AND m.tx_id >= {{lo}}
 ORDER BY m.tx_id;

-- The first transaction id at or after a block height (test networks: the
-- start of the scan).
-- @query first_tx_from_block_no
SELECT min(t.id) AS tx_id FROM public.tx t
 WHERE t.block_id >= (SELECT min(id) FROM public.block WHERE block_no >= {{block_no}});

-- @query epoch_nonce
SELECT epoch_no, encode(nonce, 'hex') AS nonce, protocol_major FROM public.epoch_param WHERE epoch_no = {{epoch_no}};

-- Whether a stated test value of h is an epoch nonce or a block hash on this
-- chain; a live-fire run refuses one that is, so no check run can draw with a
-- real key.
-- @query test_h_in_use
SELECT EXISTS (SELECT 1 FROM public.epoch_param WHERE nonce = {{h}}) AS nonce,
       EXISTS (SELECT 1 FROM public.block WHERE hash = {{h}}) AS block_hash;

-- @query t_of_block
SELECT study.t_of_block({{block_id}}) AS t;

-- @query first_tx_from_block
SELECT study.first_tx_from_block({{block_id}}) AS t;

-- @query prev_block
SELECT study.prev_block({{block_id}}) AS b;

-- How far the database tip is past the snapshot block, for confirm-snapshot
-- (the snapshot hash must still be in the block table).
-- @query confirm_snapshot
SELECT (SELECT block_no FROM public.block WHERE hash = {{snap_hash}}) AS snap_block_no,
       (SELECT max(block_no) FROM public.block) AS tip_block_no;
