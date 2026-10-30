-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- Bookkeeping for runs, and the block and transaction-id helpers every other
-- file uses. Conventions: block ids identify blocks; T(B) is the largest
-- transaction id at or before block B; a window [B1, B2] is the
-- transaction-id range [first id with block_id >= B1, T(B2)]; every run
-- stores its parameters; steps are resumable and idempotent.
--
-- These helpers rely on block ids increasing along the chain and on
-- transaction ids increasing in (block, index) order. The order check at the
-- end of this file tests both before any run uses tx-id ranges.

-- @lib schema
CREATE TABLE IF NOT EXISTS study.run (
  run_id   text PRIMARY KEY,
  network  text NOT NULL,
  created  timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- One row per parameter of a run (network, snapshot block, freeze block hash,
-- window blocks and tx-id bounds, guard and target sizes, the reading
-- settings, the code version).
CREATE TABLE IF NOT EXISTS study.param (
  run_id  text NOT NULL REFERENCES study.run ON DELETE CASCADE,
  key     text NOT NULL,
  value   jsonb NOT NULL,
  PRIMARY KEY (run_id, key)
);

-- study.step(name, run_id, started, finished, rows): a rerun skips a finished
-- step unless told otherwise.
CREATE TABLE IF NOT EXISTS study.step (
  run_id    text NOT NULL REFERENCES study.run ON DELETE CASCADE,
  name      text NOT NULL,
  started   timestamptz,
  finished  timestamptz,
  rows      bigint,
  PRIMARY KEY (run_id, name)
);

-- T(B): the largest transaction id at or before block B, 0 if there is none.
-- Two index probes on tx(block_id); max(id) with a filter can scan far on old
-- blocks.
CREATE OR REPLACE FUNCTION study.t_of_block(b bigint) RETURNS bigint
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(
    (SELECT max(t.id) FROM public.tx t
      WHERE t.block_id = (SELECT max(t2.block_id) FROM public.tx t2 WHERE t2.block_id <= b)),
    0)
$$;

-- The first transaction id in block B or after it; NULL if none.
CREATE OR REPLACE FUNCTION study.first_tx_from_block(b bigint) RETURNS bigint
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT min(t.id) FROM public.tx t
   WHERE t.block_id = (SELECT min(t2.block_id) FROM public.tx t2 WHERE t2.block_id >= b)
$$;

-- The block before B on the chain: the largest block id below B, which the
-- order check below shows is B's predecessor.
CREATE OR REPLACE FUNCTION study.prev_block(b bigint) RETURNS bigint
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT max(id) FROM public.block WHERE id < b
$$;

-- The order check (a precondition of every run, and integration test T1):
-- no block has previous_id >= id, every block's previous_id is the largest
-- block id below it, and ordering transactions by (block_id, block_index)
-- equals ordering them by id. db-sync stores the genesis distribution as
-- transactions of the first block (block_no NULL) that all carry block_index
-- 0; ties are broken by id and those rows are counted separately. The counts
-- named *_out_of_order, *_not_after_previous and tx_index_repeated must be 0.
-- @query order_check
SELECT
  (SELECT count(*) FROM public.block WHERE previous_id IS NOT NULL AND previous_id >= id) AS blocks_out_of_order,
  (SELECT count(*) FROM public.block b WHERE b.previous_id IS NOT NULL
      AND b.previous_id <> (SELECT max(p.id) FROM public.block p WHERE p.id < b.id)) AS blocks_not_after_previous,
  (SELECT count(*) FROM (SELECT id, lag(id) OVER (ORDER BY block_id, block_index, id) AS prev FROM public.tx) s
    WHERE s.prev >= s.id) AS tx_out_of_order,
  (SELECT count(*) FROM (SELECT t.block_id, t.block_index FROM public.tx t JOIN public.block b ON b.id = t.block_id
                          WHERE b.block_no IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1) d) AS tx_index_repeated,
  (SELECT count(*) FROM public.tx t JOIN public.block b ON b.id = t.block_id WHERE b.block_no IS NULL) AS tx_in_blocks_without_number,
  (SELECT count(*) FROM public.block) AS n_blocks,
  (SELECT count(*) FROM public.tx) AS n_tx;
