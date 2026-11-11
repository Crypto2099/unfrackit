-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- The credential universe.
--
-- Every stake credential db-sync has seen is a row of stake_address. hash_raw
-- is the 29-byte reward address: a header byte, then the 28-byte credential.
-- CIP-19 ("Stake Addresses", cardano-foundation/CIPs@befcdb75) gives header
-- type 14 (1110) for a stake key hash and 15 (1111) for a script hash; the low
-- nibble is the network tag, 0 for testnets and 1 for mainnet ("Network Tag").
-- db-sync sets script_hash for script credentials. Script stake credentials
-- are removed from every frame; the checks below confirm that the header type
-- and script_hash agree on every row before anything relies on either.
--
-- @step cred
-- @outputs study.cred
DROP TABLE IF EXISTS study.cred;
CREATE TABLE study.cred AS
SELECT sa.id AS sa_id,
       sa.hash_raw,
       substring(sa.hash_raw FROM 2 FOR 28) AS cred_hash,
       get_byte(sa.hash_raw, 0) >> 4 AS header_type,
       get_byte(sa.hash_raw, 0) & 15 AS network_tag,
       sa.script_hash IS NOT NULL AS is_script,
       sa.script_hash,
       sa.view::text AS view
  FROM public.stake_address sa;
ALTER TABLE study.cred ADD PRIMARY KEY (sa_id);
ANALYZE study.cred;

-- @query cred_checks
SELECT count(*) AS n,
       count(*) FILTER (WHERE length(hash_raw) <> 29) AS bad_length,
       count(*) FILTER (WHERE header_type NOT IN (14, 15)) AS bad_header,
       count(*) FILTER (WHERE (header_type = 15) <> is_script) AS bad_script_flag,
       count(*) FILTER (WHERE is_script AND script_hash <> cred_hash) AS bad_script_hash,
       count(*) FILTER (WHERE network_tag <> {{network_tag}}) AS bad_network,
       count(*) FILTER (WHERE is_script) AS n_script
  FROM study.cred;
