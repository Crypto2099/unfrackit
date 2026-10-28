-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- The reads behind a wallet's history: blocks and transaction-id bounds, a
-- wallet's outputs over its whole history, the transactions that touch it,
-- and everything those transactions consume, reference and create. Every
-- query reads db-sync's public schema only and filters on an indexed column
-- (doc/schema.md and schema/migration-4-*.sql of IntersectMBO/cardano-db-sync
-- at tag 13.7.3.0, commit 8a2cd5f360523afc3567a0e4774ac269cd1b5516); none
-- creates anything.
--
-- What this relies on in db-sync:
-- - tx_in.tx_out_id is the id of the transaction holding the spent output,
--   which is (tx_out_id, tx_out_index); ma_tx_out.tx_out_id is a tx_out.id.
-- - A phase-2-invalid transaction's tx_in rows are its collateral inputs and
--   its one tx_out row, if any, is its collateral return, at the index equal
--   to the number of body outputs (cardano-db-sync/src/Cardano/DbSync/Era/
--   Shelley/Generic/Tx/Conway.hs:30-109, fromConwayTx); db-sync inserts no
--   redeemer, datum, collateral or reference input of such a transaction
--   (Era/Universal/Insert/Tx.hs:143-166). So tx_out less tx_in is the UTxO
--   set, and everything else about such a transaction is read from its bytes.
-- - Base addresses carry stake_address_id; pointer addresses carry it before
--   Conway and not from Conway on; enterprise and Byron addresses never.
-- - Block ids increase along the chain and transaction ids in (block, index)
--   order; the extraction tool's order check establishes both.
--
-- Conventions, as in the extraction tool: T(B) is the largest transaction id
-- at or before block B; a window [B1, B2] is the transaction-id range [first
-- id with block_id >= B1, T(B2)]; the state at a window's start is the state
-- as of the last block before B1, which is T(B1's predecessor) = lo - 1.

-- @query tip_block
SELECT b.id, b.block_no, b.slot_no, b.epoch_no, extract(epoch FROM b.time)::bigint AS time, encode(b.hash, 'hex') AS hash
  FROM public.block b
 WHERE b.id = (SELECT max(id) FROM public.block);

-- @query block_by_hash
SELECT b.id, b.block_no, b.slot_no, b.epoch_no, extract(epoch FROM b.time)::bigint AS time, encode(b.hash, 'hex') AS hash
  FROM public.block b
 WHERE b.hash = {{hash}};

-- @query block_by_id
SELECT b.id, b.block_no, b.slot_no, b.epoch_no, extract(epoch FROM b.time)::bigint AS time, encode(b.hash, 'hex') AS hash
  FROM public.block b
 WHERE b.id = {{block_id}};

-- T(B): two index probes on tx(block_id).
-- @query t_of_block
SELECT coalesce(
  (SELECT max(t.id) FROM public.tx t
    WHERE t.block_id = (SELECT max(t2.block_id) FROM public.tx t2 WHERE t2.block_id <= {{block_id}})),
  0) AS t;

-- @query first_tx_from_block
SELECT min(t.id) AS t FROM public.tx t
 WHERE t.block_id = (SELECT min(t2.block_id) FROM public.tx t2 WHERE t2.block_id >= {{block_id}});

-- The block before B on the chain: the largest block id below B.
-- @query prev_block
SELECT max(id) AS b FROM public.block WHERE id < {{block_id}};

-- The recent window's first block: the first block whose time is at or after
-- the snapshot's time less 365 days (31,536,000 seconds; block.time is UTC).
-- @query recent_first_block
SELECT b.id
  FROM public.block b
 WHERE b.time >= (SELECT s.time FROM public.block s WHERE s.id = {{snap_block}}) - make_interval(secs => {{seconds}})
 ORDER BY b.time, b.id
 LIMIT 1;

-- The peak window: over runs of 73 consecutive completed epochs from the
-- first epoch whose protocol_major is 4 or more (the Mary hard fork), each
-- ending before the snapshot's epoch, the run with the largest transaction
-- count, every transaction counted, ties to the earlier run. The extraction
-- tool's rule (sql/windows.sql, steps epoch_counts and peak_runs) as
-- one statement; the extraction run's params.json, when given, is used
-- instead.
-- @query peak_window
WITH counts AS (
  SELECT b.epoch_no, count(t.id) AS n_tx, min(b.id) AS first_block, max(b.id) AS last_block
    FROM public.block b
    LEFT JOIN public.tx t ON t.block_id = b.id
   WHERE b.epoch_no IS NOT NULL AND b.id <= {{snap_block}}
   GROUP BY b.epoch_no
),
first_eligible AS (SELECT min(epoch_no) AS e FROM public.epoch_param WHERE protocol_major >= 4),
snap AS (SELECT epoch_no FROM public.block WHERE id = {{snap_block}}),
runs AS (
  SELECT epoch_no AS first_epoch,
         max(epoch_no) OVER w AS last_epoch,
         count(*) OVER w AS n_epochs,
         sum(n_tx) OVER w AS n_tx
    FROM counts
   WHERE epoch_no >= (SELECT e FROM first_eligible)
  WINDOW w AS (ORDER BY epoch_no ROWS BETWEEN CURRENT ROW AND 72 FOLLOWING)
)
SELECT r.first_epoch, r.last_epoch, r.n_tx::text AS n_tx, f.first_block, l.last_block
  FROM runs r
  JOIN counts f ON f.epoch_no = r.first_epoch
  JOIN counts l ON l.epoch_no = r.last_epoch
 WHERE r.n_epochs = 73 AND r.last_epoch = r.first_epoch + 72
   AND r.last_epoch < (SELECT epoch_no FROM snap)
 ORDER BY r.n_tx DESC, r.first_epoch ASC
 LIMIT 1;

-- @query epoch_params
SELECT ep.epoch_no, ep.protocol_major, ep.protocol_minor, ep.min_fee_a, ep.min_fee_b, ep.max_tx_size,
       ep.key_deposit::text AS key_deposit, ep.pool_deposit::text AS pool_deposit,
       ep.min_utxo_value::text AS min_utxo_value, ep.coins_per_utxo_size::text AS coins_per_utxo_size,
       ep.max_val_size::text AS max_val_size, ep.collateral_percent, ep.max_collateral_inputs,
       ep.price_mem, ep.price_step, ep.min_fee_ref_script_cost_per_byte,
       ep.drep_deposit::text AS drep_deposit, ep.gov_action_deposit::text AS gov_action_deposit
  FROM public.epoch_param ep
 WHERE ep.epoch_no = ANY({{epochs}});

-- @query wallet_by_view
SELECT sa.id, sa.view, encode(sa.hash_raw, 'hex') AS hash_raw, sa.script_hash IS NOT NULL AS is_script
  FROM public.stake_address sa
 WHERE sa.view = {{view}};

-- @query wallets_by_id
SELECT sa.id, sa.view, encode(sa.hash_raw, 'hex') AS hash_raw, sa.script_hash IS NOT NULL AS is_script
  FROM public.stake_address sa
 WHERE sa.id = ANY({{ids}});

-- Every output of the wallet created at or before transaction {{hi}}, with
-- the transaction that consumed it at or before {{hi}}, if any. An output
-- consumed twice would appear twice; the reader refuses that.
-- @query wallet_outputs
SELECT o.id AS tx_out_id, o.tx_id AS created_tx, encode(ct.hash, 'hex') AS tx_hash, o.index,
       o.value::text AS value, o.address, o.address_has_script AS script_pay,
       encode(o.payment_cred, 'hex') AS payment_cred, encode(o.data_hash, 'hex') AS data_hash,
       o.inline_datum_id, o.reference_script_id, i.tx_in_id AS consumed_tx
  FROM public.tx_out o
  JOIN public.tx ct ON ct.id = o.tx_id
  LEFT JOIN public.tx_in i ON i.tx_out_id = o.tx_id AND i.tx_out_index = o.index AND i.tx_in_id <= {{hi}}
 WHERE o.stake_address_id = {{sa_id}}
   AND o.tx_id <= {{hi}}
 ORDER BY o.tx_id, o.index;

-- @query wallet_output_assets
SELECT m.tx_out_id, encode(ma.policy, 'hex') AS policy, encode(ma.name, 'hex') AS name, m.quantity::text AS qty
  FROM public.tx_out o
  JOIN public.ma_tx_out m ON m.tx_out_id = o.id
  JOIN public.multi_asset ma ON ma.id = m.ident
 WHERE o.stake_address_id = {{sa_id}}
   AND o.tx_id <= {{hi}};

-- The reference query: the pattern of db-sync's own UTxO-at-block query
-- (cardano-db/src/Cardano/Db/Statement/DbTool.hs, queryUtxoAtBlockIdCoreStmt;
-- the extraction tool's sql/utxo-at-block.sql, digest_ref), restricted
-- to the wallets: outputs whose transaction is in a block with id <= B, less
-- those consumed by an input whose transaction is in such a block. Each UTxO
-- is one canonical line; a wallet's set is the count and the MD5 of its lines
-- in byte order.
-- @query ref_digests
WITH w AS (SELECT unnest({{sa_ids}}) AS sa_id),
u AS (
  SELECT o.stake_address_id AS sa_id, o.id AS tx_out_id, ct.hash AS tx_hash, o.index, o.value
    FROM public.tx_out o
    JOIN public.tx ct ON ct.id = o.tx_id
   WHERE o.stake_address_id IN (SELECT sa_id FROM w)
     AND ct.block_id <= {{block_id}}
     AND NOT EXISTS (SELECT 1 FROM public.tx_in i JOIN public.tx st ON st.id = i.tx_in_id
                      WHERE i.tx_out_id = o.tx_id AND i.tx_out_index = o.index AND st.block_id <= {{block_id}})
),
c AS (
  SELECT u.sa_id,
         encode(u.tx_hash, 'hex') || '#' || u.index || ':' || u.value || ':' ||
         coalesce((SELECT string_agg(encode(ma.policy, 'hex') || '.' || encode(ma.name, 'hex') || '=' || m.quantity, ','
                                     ORDER BY ma.policy, ma.name)
                     FROM public.ma_tx_out m JOIN public.multi_asset ma ON ma.id = m.ident
                    WHERE m.tx_out_id = u.tx_out_id), '') AS line
    FROM u
)
SELECT w.sa_id, count(c.line) AS n, md5(coalesce(string_agg(c.line, E'\n' ORDER BY c.line COLLATE "C"), '')) AS digest
  FROM w LEFT JOIN c ON c.sa_id = w.sa_id
 GROUP BY w.sa_id;

-- The same reference query's lines for one wallet, to name a difference.
-- @query ref_lines
SELECT x.line FROM (
SELECT encode(ct.hash, 'hex') || '#' || o.index || ':' || o.value || ':' ||
       coalesce((SELECT string_agg(encode(ma.policy, 'hex') || '.' || encode(ma.name, 'hex') || '=' || m.quantity, ','
                                   ORDER BY ma.policy, ma.name)
                   FROM public.ma_tx_out m JOIN public.multi_asset ma ON ma.id = m.ident
                  WHERE m.tx_out_id = o.id), '') AS line
  FROM public.tx_out o
  JOIN public.tx ct ON ct.id = o.tx_id
 WHERE o.stake_address_id = {{sa_id}}
   AND ct.block_id <= {{block_id}}
   AND NOT EXISTS (SELECT 1 FROM public.tx_in i JOIN public.tx st ON st.id = i.tx_in_id
                    WHERE i.tx_out_id = o.tx_id AND i.tx_out_index = o.index AND st.block_id <= {{block_id}})
) x ORDER BY x.line COLLATE "C";

-- @query txs
SELECT t.id, encode(t.hash, 'hex') AS hash, t.block_id, t.block_index, t.fee::text AS fee, t.deposit::text AS deposit,
       t.size, t.valid_contract, t.treasury_donation::text AS treasury_donation, t.out_sum::text AS out_sum,
       b.block_no, b.slot_no, b.epoch_no, extract(epoch FROM b.time)::bigint AS time, encode(b.hash, 'hex') AS block_hash
  FROM public.tx t
  JOIN public.block b ON b.id = t.block_id
 WHERE t.id = ANY({{ids}})
 ORDER BY t.id;

-- @query tx_by_hash
SELECT t.id FROM public.tx t WHERE t.hash = {{hash}};

-- @query tx_cbor
SELECT c.tx_id, c.bytes FROM public.tx_cbor c WHERE c.tx_id = ANY({{ids}});

-- What each transaction consumed, as db-sync records it.
-- @query tx_consumed
SELECT i.tx_in_id, encode(ct.hash, 'hex') AS src_hash, i.tx_out_index AS src_index
  FROM public.tx_in i
  JOIN public.tx ct ON ct.id = i.tx_out_id
 WHERE i.tx_in_id = ANY({{ids}});

-- @query tx_outputs
SELECT o.id AS tx_out_id, o.tx_id, o.index, o.value::text AS value, o.address, o.address_has_script AS script_pay,
       encode(o.payment_cred, 'hex') AS payment_cred, o.stake_address_id, encode(o.data_hash, 'hex') AS data_hash,
       o.inline_datum_id, o.reference_script_id
  FROM public.tx_out o
 WHERE o.tx_id = ANY({{ids}});

-- Outputs by reference: (transaction hash, index) pairs.
-- @query resolve_outputs
WITH r AS (SELECT * FROM unnest({{hashes}}, {{indexes}}) AS r(h, i))
SELECT encode(t.hash, 'hex') AS tx_hash, o.index, o.id AS tx_out_id, o.tx_id, o.value::text AS value, o.address,
       o.address_has_script AS script_pay, encode(o.payment_cred, 'hex') AS payment_cred, o.stake_address_id,
       encode(o.data_hash, 'hex') AS data_hash, o.inline_datum_id, o.reference_script_id
  FROM r
  JOIN public.tx t ON t.hash = r.h
  JOIN public.tx_out o ON o.tx_id = t.id AND o.index = r.i;

-- @query output_assets
SELECT m.tx_out_id, encode(ma.policy, 'hex') AS policy, encode(ma.name, 'hex') AS name, m.quantity::text AS qty
  FROM public.ma_tx_out m
  JOIN public.multi_asset ma ON ma.id = m.ident
 WHERE m.tx_out_id = ANY({{ids}});

-- @query datums
SELECT d.id, encode(d.hash, 'hex') AS hash, d.bytes FROM public.datum d WHERE d.id = ANY({{ids}});

-- @query scripts
SELECT s.id, encode(s.hash, 'hex') AS hash, s.type::text AS type, s.bytes, s.serialised_size, s.tx_id
  FROM public.script s
 WHERE s.id = ANY({{ids}});

-- @query withdrawals
SELECT w.tx_id, encode(sa.hash_raw, 'hex') AS account, w.amount::text AS amount
  FROM public.withdrawal w
  JOIN public.stake_address sa ON sa.id = w.addr_id
 WHERE w.tx_id = ANY({{ids}});

-- @query mints
SELECT m.tx_id, encode(ma.policy, 'hex') AS policy, encode(ma.name, 'hex') AS name, m.quantity::text AS qty
  FROM public.ma_tx_mint m
  JOIN public.multi_asset ma ON ma.id = m.ident
 WHERE m.tx_id = ANY({{ids}});

-- Whether the study schema's tables are readable by this role. to_regclass
-- itself needs USAGE on the schema, so it runs only when the role has it.
-- @query study_readable
WITH u AS (
  SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'study')
              THEN has_schema_privilege(current_user, 'study', 'USAGE') ELSE false END AS usage
)
SELECT u.usage,
       CASE WHEN NOT u.usage THEN false
            WHEN to_regclass('study.frame') IS NULL OR to_regclass('study.sample') IS NULL THEN false
            ELSE has_table_privilege(current_user, 'study.sample', 'SELECT') END AS has_frame
  FROM u;

-- The extraction's study tables (tools/research-corpus, sql/draw.sql,
-- franken.sql, txo.sql), read when this role can read them: the
-- sampled wallets with their split and the reconstruction check's exclusion,
-- the franken flags, and the life table's UTxO set at T.
-- @query study_samples
SELECT s.sa_id, bool_or(s.kind = 'random') AS random, max(s.split) AS split, bool_or(coalesce(s.reconstruction_excluded, false)) AS excluded
  FROM study.sample s
 GROUP BY s.sa_id
 ORDER BY s.sa_id;

-- @query study_franken
SELECT encode(f.payment_cred, 'hex') AS payment_cred FROM study.franken f WHERE f.sa_id = {{sa_id}} AND f.flagged;

-- @query life_digests
WITH w AS (SELECT unnest({{sa_ids}}) AS sa_id),
u AS (
  SELECT t.sa_id, t.tx_out_id, ct.hash AS tx_hash, t.out_index, t.value
    FROM study.txo t
    JOIN public.tx ct ON ct.id = t.created_tx
   WHERE t.sa_id IN (SELECT sa_id FROM w)
     AND t.created_tx <= {{t}}
     AND (t.consumed_tx IS NULL OR t.consumed_tx > {{t}})
),
c AS (
  SELECT u.sa_id,
         encode(u.tx_hash, 'hex') || '#' || u.out_index || ':' || u.value || ':' ||
         coalesce((SELECT string_agg(encode(s.policy, 'hex') || '.' || encode(s.name, 'hex') || '=' || a.quantity, ','
                                     ORDER BY s.policy, s.name)
                     FROM study.txo_asset a JOIN study.asset s ON s.ident = a.ident
                    WHERE a.tx_out_id = u.tx_out_id), '') AS line
    FROM u
)
SELECT w.sa_id, count(c.line) AS n, md5(coalesce(string_agg(c.line, E'\n' ORDER BY c.line COLLATE "C"), '')) AS digest
  FROM w LEFT JOIN c ON c.sa_id = w.sa_id
 GROUP BY w.sa_id;
