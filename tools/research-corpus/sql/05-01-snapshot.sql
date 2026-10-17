-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- Sections 5.1 and 5.3 of the pre-registration: the snapshot block and its
-- parameters, and the order rule that makes the study's data postdate the
-- freeze (section 10.1): the snapshot block's height must be greater than the
-- height of the block that contains the freeze transaction. h for the draw is
-- the 32-byte hash of that block (section 5.4).
--
-- The snapshot is the database tip when artifact A2 starts, with db-sync
-- stopped there so the database is that block's state. A tip block can still
-- be rolled back after it is recorded, so `confirm-snapshot` checks, once
-- `security_k` (2,160, mainnet's security parameter) more blocks exist, that
-- the snapshot hash is still on chain; if it is not, A2 restarts from the
-- then-tip.
--
-- Before anything reads the database, the driver checks db-sync's own
-- bookkeeping: the network name, the schema version and the extra migrations.
-- A database with `prune` or `bootstrap` has deleted history and is refused;
-- with `consumed`, tx_in must still be populated.

-- @query db_meta
SELECT m.network_name, m.version, m.start_time::text AS start_time,
       (SELECT row_to_json(s)::text FROM public.schema_version s ORDER BY s.id DESC LIMIT 1) AS schema_version,
       (SELECT coalesce(json_agg(e.token ORDER BY e.id), '[]'::json)::text FROM public.extra_migrations e) AS extra_migrations
  FROM public.meta m;

-- @query tx_in_nonempty
SELECT EXISTS (SELECT 1 FROM public.tx_in) AS nonempty;

-- @query tip_block
SELECT id, block_no, slot_no, epoch_no, time::text AS time, encode(hash, 'hex') AS hash
  FROM public.block ORDER BY id DESC LIMIT 1;

-- @query block_by_hash
SELECT id, block_no, slot_no, epoch_no, time::text AS time, encode(hash, 'hex') AS hash
  FROM public.block WHERE hash = {{block_hash}};

-- @query block_by_id
SELECT id, block_no, slot_no, epoch_no, time::text AS time, encode(hash, 'hex') AS hash
  FROM public.block WHERE id = {{block_id}};

-- The block of a transaction: the freeze transaction on mainnet, the stand-in
-- (S1's seeding transaction) on preprod.
-- @query block_of_tx
SELECT b.id, b.block_no, b.slot_no, b.epoch_no, b.time::text AS time, encode(b.hash, 'hex') AS hash
  FROM public.tx t JOIN public.block b ON b.id = t.block_id
 WHERE t.hash = {{tx_hash}};

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
