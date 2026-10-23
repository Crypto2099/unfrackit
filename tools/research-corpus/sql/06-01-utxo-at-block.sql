-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- Section 6.1 of the pre-registration: a wallet's UTxO set at a block, three
-- ways, compared as sets of (transaction hash, index, lovelace, sorted
-- assets).
--
-- 1. The reference query, the pattern of db-sync's own UTxO-at-block query
--    (cardano-db/src/Cardano/Db/Statement/DbTool.hs, queryUtxoAtBlockIdCoreStmt,
--    at tag 13.7.2.1): outputs whose transaction is in a block with id <= B,
--    less those consumed by an input whose transaction is in a block with
--    id <= B; restricted to the wallets' credentials. It reads db-sync's tables
--    only.
-- 2. The life table (06-01-txo.sql) at T(B).
-- 3. "Read directly", read as the wallet's outputs with no consuming input at
--    all, in a database stopped at the snapshot block. It is defined at the
--    database tip only.
--
-- Each UTxO is written as one canonical line,
--   <tx hash hex>#<index>:<lovelace>:<policy hex>.<name hex>=<qty>,...
-- with assets sorted by (policy, name) bytes, and a wallet's set as the count
-- and the MD5 of its lines sorted in byte order (COLLATE "C"). The same line is
-- built in Node from Koios and from the node's query (src/canon.mjs).
--
-- With x1_enterprise on, the reference and direct queries add enterprise
-- outputs at payment credentials the life table assigned to the wallet.

-- @query digest_ref
WITH w AS (SELECT unnest({{sa_ids}}) AS sa_id),
u AS (
  SELECT o.stake_address_id AS sa_id, o.id AS tx_out_id, ct.hash AS tx_hash, o.index, o.value
    FROM public.tx_out o
    JOIN public.tx ct ON ct.id = o.tx_id
   WHERE o.stake_address_id IN (SELECT sa_id FROM w)
     AND ct.block_id <= {{block_id}}
     AND NOT EXISTS (SELECT 1 FROM public.tx_in i JOIN public.tx st ON st.id = i.tx_in_id
                      WHERE i.tx_out_id = o.tx_id AND i.tx_out_index = o.index AND st.block_id <= {{block_id}})
  UNION ALL
  SELECT p.sa_id, o.id, ct.hash, o.index, o.value
    FROM (SELECT DISTINCT t.sa_id, t.payment_cred FROM study.txo t
           WHERE {{x1_enterprise}} AND t.via_payment AND t.sa_id IN (SELECT sa_id FROM w)) p
    JOIN public.tx_out o ON o.payment_cred = p.payment_cred AND o.stake_address_id IS NULL AND NOT o.address_has_script
    JOIN public.tx ct ON ct.id = o.tx_id
   WHERE ct.block_id <= {{block_id}}
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

-- @query digest_life
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

-- @query digest_direct
WITH w AS (SELECT unnest({{sa_ids}}) AS sa_id),
u AS (
  SELECT o.stake_address_id AS sa_id, o.id AS tx_out_id, ct.hash AS tx_hash, o.index, o.value
    FROM public.tx_out o
    JOIN public.tx ct ON ct.id = o.tx_id
   WHERE o.stake_address_id IN (SELECT sa_id FROM w)
     AND NOT EXISTS (SELECT 1 FROM public.tx_in i WHERE i.tx_out_id = o.tx_id AND i.tx_out_index = o.index)
  UNION ALL
  SELECT p.sa_id, o.id, ct.hash, o.index, o.value
    FROM (SELECT DISTINCT t.sa_id, t.payment_cred FROM study.txo t
           WHERE {{x1_enterprise}} AND t.via_payment AND t.sa_id IN (SELECT sa_id FROM w)) p
    JOIN public.tx_out o ON o.payment_cred = p.payment_cred AND o.stake_address_id IS NULL AND NOT o.address_has_script
    JOIN public.tx ct ON ct.id = o.tx_id
   WHERE NOT EXISTS (SELECT 1 FROM public.tx_in i WHERE i.tx_out_id = o.tx_id AND i.tx_out_index = o.index)
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

-- The life table's lines for one wallet at T, with the address of each
-- output, for comparison with Koios and the node in Node.
-- @query lines_life
SELECT x.* FROM (
SELECT encode(ct.hash, 'hex') || '#' || t.out_index || ':' || t.value || ':' ||
       coalesce((SELECT string_agg(encode(s.policy, 'hex') || '.' || encode(s.name, 'hex') || '=' || a.quantity, ','
                                   ORDER BY s.policy, s.name)
                   FROM study.txo_asset a JOIN study.asset s ON s.ident = a.ident
                  WHERE a.tx_out_id = t.tx_out_id), '') AS line,
       o.address, t.has_datum, t.has_ref_script, t.script_pay, encode(t.payment_cred, 'hex') AS payment_cred
  FROM study.txo t
  JOIN public.tx ct ON ct.id = t.created_tx
  JOIN public.tx_out o ON o.id = t.tx_out_id
 WHERE t.sa_id = {{sa_id}}
   AND t.created_tx <= {{t}}
   AND (t.consumed_tx IS NULL OR t.consumed_tx > {{t}})
) x ORDER BY x.line COLLATE "C";

-- The reference query's lines for one wallet at block B, from db-sync's tables
-- alone, for the A1 comparisons (which run before any study table exists).
-- @query lines_ref
SELECT x.* FROM (
SELECT encode(ct.hash, 'hex') || '#' || o.index || ':' || o.value || ':' ||
       coalesce((SELECT string_agg(encode(ma.policy, 'hex') || '.' || encode(ma.name, 'hex') || '=' || m.quantity, ','
                                   ORDER BY ma.policy, ma.name)
                   FROM public.ma_tx_out m JOIN public.multi_asset ma ON ma.id = m.ident
                  WHERE m.tx_out_id = o.id), '') AS line,
       o.address
  FROM public.tx_out o
  JOIN public.tx ct ON ct.id = o.tx_id
 WHERE o.stake_address_id = {{sa_id}}
   AND ct.block_id <= {{block_id}}
   AND NOT EXISTS (SELECT 1 FROM public.tx_in i JOIN public.tx st ON st.id = i.tx_in_id
                    WHERE i.tx_out_id = o.tx_id AND i.tx_out_index = o.index AND st.block_id <= {{block_id}})
) x ORDER BY x.line COLLATE "C";

-- @query stake_by_view
SELECT id AS sa_id, view::text AS view, encode(hash_raw, 'hex') AS hash_raw FROM public.stake_address WHERE view = {{view}};

-- Every address that ever received an output of the wallet, for the node's
-- query by address.
-- @query wallet_addresses
SELECT DISTINCT o.address FROM public.tx_out o WHERE o.stake_address_id = {{sa_id}} ORDER BY 1;
