-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- Section 5.3 of the pre-registration: the two windows and the era report.
--
-- Peak window: over runs of 73 consecutive epochs beginning no earlier than
-- the Alonzo hard-fork epoch, the run with the largest total transaction
-- count, computed by the rule before any wallet is read. Read as: every tx row
-- counts, phase-2-invalid included, as the epoch view and Koios count
-- (x19_count_invalid); only completed epochs before the snapshot's epoch; the
-- Alonzo epoch is the first with epoch_param.protocol_major of 5 or more
-- (alonzo_protocol_major). Ties go to the earlier run. The window's blocks are
-- the first block of the first epoch and the last block of the last epoch. The
-- counts with and without phase-2-invalid transactions and the epoch view's
-- tx_count (which counts every tx row) are kept beside the rule's count for
-- the report.
--
-- Recent window: from the first block whose time is at or after the
-- snapshot's time minus 365 days, through the snapshot block, both ends
-- inclusive. block.time is UTC without a time zone, so 365 days is 31,536,000
-- seconds.
--
-- Era report: epoch_param for every epoch of each window, with
-- every epoch where min_fee_a, min_fee_b, coins_per_utxo_size, max_val_size or
-- max_tx_size differs from the previous epoch, labeled with protocol_major
-- (coins_per_utxo_size is per UTxO word in Alonzo, protocol_major 5 and 6, and
-- per byte from Babbage). The snapshot epoch's row is stored too: every replay
-- runs under it.

-- @step epoch_counts
-- @outputs study.epoch_counts
DROP TABLE IF EXISTS study.epoch_counts;
CREATE TABLE study.epoch_counts AS
SELECT b.epoch_no,
       count(t.id) AS n_tx,
       count(t.id) FILTER (WHERE t.valid_contract) AS n_tx_valid,
       min(b.id) AS first_block,
       max(b.id) AS last_block
  FROM public.block b
  LEFT JOIN public.tx t ON t.block_id = b.id
 WHERE b.epoch_no IS NOT NULL AND b.id <= {{snap_block}}
 GROUP BY b.epoch_no;
ALTER TABLE study.epoch_counts ADD COLUMN view_tx_count bigint;
UPDATE study.epoch_counts c SET view_tx_count = e.tx_count FROM public.epoch e WHERE e.no = c.epoch_no;
ALTER TABLE study.epoch_counts ADD PRIMARY KEY (epoch_no);

-- @step peak_runs
-- @outputs study.peak_runs
DROP TABLE IF EXISTS study.peak_runs;
CREATE TABLE study.peak_runs AS
WITH alonzo AS (
  SELECT min(epoch_no) AS e FROM public.epoch_param WHERE protocol_major >= {{alonzo_protocol_major}}
),
snap AS (SELECT epoch_no FROM public.block WHERE id = {{snap_block}}),
runs AS (
  SELECT epoch_no AS first_epoch,
         max(epoch_no) OVER w AS last_epoch,
         count(*) OVER w AS n_epochs,
         sum(CASE WHEN {{x19_count_invalid}} THEN n_tx ELSE n_tx_valid END) OVER w AS n_tx_rule,
         sum(n_tx) OVER w AS n_tx_all,
         sum(n_tx_valid) OVER w AS n_tx_valid,
         sum(view_tx_count) OVER w AS n_tx_view
    FROM study.epoch_counts
   WHERE epoch_no >= (SELECT e FROM alonzo)
  WINDOW w AS (ORDER BY epoch_no ROWS BETWEEN CURRENT ROW AND {{peak_epochs_less_one}} FOLLOWING)
)
SELECT r.*, row_number() OVER (ORDER BY r.n_tx_rule DESC, r.first_epoch ASC) AS rank
  FROM runs r
 WHERE r.n_epochs = {{peak_epochs}}
   AND r.last_epoch = r.first_epoch + {{peak_epochs_less_one}}
   AND r.last_epoch < (SELECT epoch_no FROM snap);

-- @query peak_choice
SELECT r.first_epoch, r.last_epoch, r.n_tx_rule, r.n_tx_all, r.n_tx_valid, r.n_tx_view,
       f.first_block AS first_block, l.last_block AS last_block,
       (SELECT count(*) FROM study.peak_runs) AS n_runs,
       (SELECT min(first_epoch) FROM study.peak_runs) AS alonzo_epoch
  FROM study.peak_runs r
  JOIN study.epoch_counts f ON f.epoch_no = r.first_epoch
  JOIN study.epoch_counts l ON l.epoch_no = r.last_epoch
 WHERE r.rank = 1;

-- The most recent complete run of the same length, for the report (section 5.3
-- compares the peak with the most recent 73 epochs).
-- @query latest_run
SELECT first_epoch, last_epoch, n_tx_rule, n_tx_all, n_tx_valid, n_tx_view
  FROM study.peak_runs ORDER BY first_epoch DESC LIMIT 1;

-- @query recent_first_block
SELECT b.id
  FROM public.block b
 WHERE b.time >= (SELECT s.time FROM public.block s WHERE s.id = {{snap_block}}) - make_interval(days => {{recent_days}})
 ORDER BY b.time, b.id
 LIMIT 1;

-- @step era_report
-- @outputs study.era_report
DROP TABLE IF EXISTS study.era_report;
CREATE TABLE study.era_report AS
WITH ep AS (
  SELECT epoch_no, protocol_major, protocol_minor, min_fee_a, min_fee_b, coins_per_utxo_size, max_val_size, max_tx_size,
         lag(min_fee_a) OVER o AS p_min_fee_a, lag(min_fee_b) OVER o AS p_min_fee_b,
         lag(coins_per_utxo_size) OVER o AS p_coins_per_utxo_size, lag(max_val_size) OVER o AS p_max_val_size,
         lag(max_tx_size) OVER o AS p_max_tx_size
    FROM public.epoch_param
  WINDOW o AS (ORDER BY epoch_no)
),
win(win, first_epoch, last_epoch) AS (
  VALUES ('recent'::text, {{recent_first_epoch}}::integer, {{recent_last_epoch}}::integer),
         ('peak'::text, {{peak_first_epoch}}::integer, {{peak_last_epoch}}::integer)
)
SELECT w.win, ep.epoch_no, ep.protocol_major, ep.protocol_minor,
       ep.min_fee_a, ep.min_fee_b, ep.coins_per_utxo_size,
       CASE WHEN ep.protocol_major IN (5, 6) THEN 'per word' ELSE 'per byte' END AS coins_per_utxo_unit,
       ep.max_val_size, ep.max_tx_size,
       ep.epoch_no = w.first_epoch AS is_first,
       (ep.min_fee_a IS DISTINCT FROM ep.p_min_fee_a) AS ch_min_fee_a,
       (ep.min_fee_b IS DISTINCT FROM ep.p_min_fee_b) AS ch_min_fee_b,
       (ep.coins_per_utxo_size IS DISTINCT FROM ep.p_coins_per_utxo_size) AS ch_coins_per_utxo_size,
       (ep.max_val_size IS DISTINCT FROM ep.p_max_val_size) AS ch_max_val_size,
       (ep.max_tx_size IS DISTINCT FROM ep.p_max_tx_size) AS ch_max_tx_size
  FROM win w JOIN ep ON ep.epoch_no BETWEEN w.first_epoch AND w.last_epoch;

-- Epochs inside each window (after its first) where any of the five
-- parameters changed, and the window's first epoch as its baseline.
-- @query era_changes
SELECT win, epoch_no, protocol_major, min_fee_a, min_fee_b, coins_per_utxo_size::text AS coins_per_utxo_size,
       coins_per_utxo_unit, max_val_size::text AS max_val_size, max_tx_size, is_first,
       ch_min_fee_a, ch_min_fee_b, ch_coins_per_utxo_size, ch_max_val_size, ch_max_tx_size
  FROM study.era_report
 WHERE is_first OR ch_min_fee_a OR ch_min_fee_b OR ch_coins_per_utxo_size OR ch_max_val_size OR ch_max_tx_size
 ORDER BY win, epoch_no;

-- @query snapshot_epoch_param
SELECT row_to_json(ep)::text AS row
  FROM public.epoch_param ep
 WHERE ep.epoch_no = (SELECT epoch_no FROM public.block WHERE id = {{snap_block}});
