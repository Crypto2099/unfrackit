-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- Section 6.1 of the pre-registration: each wallet's UTxO set at any block,
-- built once per run as a life table of every output that carries a stake
-- credential, and used for everything in bulk.
--
-- A wallet is a key-hash stake credential, and its outputs are read as the
-- tx_out rows with its stake_address_id. With the setting x1_enterprise on,
-- outputs at enterprise addresses whose key payment credential belongs to
-- exactly one stake credential are added to that wallet.
--
-- What this relies on, in IntersectMBO/cardano-db-sync at tag 13.7.2.1:
-- tx_in.tx_out_id is the id of the transaction holding the spent output, which
-- is identified by (tx_out_id, tx_out_index) (doc/schema.md, tx_in); for a
-- phase-2-invalid transaction db-sync stores the collateral inputs as its
-- tx_in rows and the collateral return as its tx_out, at the index equal to
-- the number of body outputs (Era/Shelley/Generic/Tx/Babbage.hs and Conway.hs),
-- so tx_out minus tx_in is the ledger's UTxO set without special cases. Base
-- addresses get stake_address_id; pointer addresses get it before Conway and
-- NULL from Conway on; enterprise and Byron addresses get NULL
-- (Era/Universal/Insert/Other.hs). So Byron outputs never enter this table.
--
-- Held UTxOs are flagged, never removed (section 5.5): has_datum,
-- has_ref_script, script_pay.
--
-- consumed_tx is the transaction that spends the output, if it is at or before
-- the snapshot; an output spent after the snapshot is unspent here. A wallet's
-- UTxO set at block B is then: created_tx <= T(B) AND (consumed_tx IS NULL OR
-- consumed_tx > T(B)), for any B up to the snapshot. Transaction-id ranges are
-- used, never block.time joins; the order check in 00-study-schema.sql, run
-- before every run, is what justifies them.
--
-- The unique index on tx_out_id asserts that an output is consumed at most
-- once; the step fails if it is not.

-- @step txo
-- @outputs study.txo
DROP TABLE IF EXISTS study.txo;
CREATE TABLE study.txo AS
SELECT o.id AS tx_out_id,
       o.tx_id AS created_tx,
       i.tx_in_id AS consumed_tx,
       o.stake_address_id AS sa_id,
       o.index AS out_index,
       o.value,
       o.payment_cred,
       o.address_has_script AS script_pay,
       (o.data_hash IS NOT NULL OR o.inline_datum_id IS NOT NULL) AS has_datum,
       (o.reference_script_id IS NOT NULL) AS has_ref_script,
       false AS via_payment
  FROM public.tx_out o
  LEFT JOIN public.tx_in i
         ON i.tx_out_id = o.tx_id AND i.tx_out_index = o.index AND i.tx_in_id <= {{snap_tx}}
 WHERE o.stake_address_id IS NOT NULL
   AND o.tx_id <= {{snap_tx}};
-- Only with x1_enterprise on; with it off the filter is constant false and
-- nothing is scanned.
INSERT INTO study.txo
SELECT o.id, o.tx_id, i.tx_in_id, po.sa_id, o.index, o.value, o.payment_cred, o.address_has_script,
       (o.data_hash IS NOT NULL OR o.inline_datum_id IS NOT NULL), (o.reference_script_id IS NOT NULL), true
  FROM public.tx_out o
  JOIN (SELECT payment_cred, min(sa_id) AS sa_id
          FROM study.txo
         WHERE NOT script_pay
         GROUP BY payment_cred
        HAVING count(DISTINCT sa_id) = 1) po ON po.payment_cred = o.payment_cred
  LEFT JOIN public.tx_in i
         ON i.tx_out_id = o.tx_id AND i.tx_out_index = o.index AND i.tx_in_id <= {{snap_tx}}
 WHERE {{x1_enterprise}}
   AND o.stake_address_id IS NULL
   AND NOT o.address_has_script
   AND o.tx_id <= {{snap_tx}};
CREATE UNIQUE INDEX txo_tx_out_id ON study.txo (tx_out_id);
CREATE INDEX txo_sa_created ON study.txo (sa_id, created_tx);
CREATE INDEX txo_created ON study.txo (created_tx);
CREATE INDEX txo_consumed ON study.txo (consumed_tx);
ANALYZE study.txo;

-- @step txo_asset
-- @outputs study.txo_asset
DROP TABLE IF EXISTS study.txo_asset;
CREATE TABLE study.txo_asset AS
SELECT m.tx_out_id, m.ident, m.quantity
  FROM public.ma_tx_out m
  JOIN study.txo t ON t.tx_out_id = m.tx_out_id;
CREATE INDEX txo_asset_tx_out_id ON study.txo_asset (tx_out_id);
CREATE INDEX txo_asset_ident ON study.txo_asset (ident);
ANALYZE study.txo_asset;

-- Every asset with its policy, name and CIP-67 label, computed once.
-- @step asset
-- @outputs study.asset
DROP TABLE IF EXISTS study.asset;
CREATE TABLE study.asset AS
SELECT ma.id AS ident, ma.policy, ma.name, study.cip67_label(ma.name) AS label
  FROM public.multi_asset ma;
ALTER TABLE study.asset ADD PRIMARY KEY (ident);
CREATE INDEX asset_policy_name ON study.asset (policy, name);
ANALYZE study.asset;

-- @query txo_counts
SELECT (SELECT count(*) FROM study.txo) AS n_txo,
       (SELECT count(*) FROM study.txo WHERE via_payment) AS n_txo_via_payment,
       (SELECT count(*) FROM study.txo WHERE consumed_tx IS NULL) AS n_unspent,
       (SELECT count(*) FROM study.txo_asset) AS n_txo_asset,
       (SELECT count(*) FROM study.asset) AS n_asset,
       (SELECT count(*) FROM study.asset WHERE label IS NOT NULL) AS n_asset_labeled;
