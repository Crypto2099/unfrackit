-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- Sections 5.2, 5.4 and 5.5 of the pre-registration: the credential universe
-- and the consented cases.
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
-- Adam K. Dean's own stake keys are removed from every frame (section 5.2). The
-- driver loads them from a private file given at run time, matched to
-- stake_address.view, into study.consented; the file is never committed and
-- the keys are never written to the run's parameters, only their count. The
-- count removed and how many fell inside each sample's drawn prefix are
-- published, so an outsider's reproduction can differ only by those keys.

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

-- The driver runs this with a bound array of bech32 stake addresses, so the
-- keys never appear in statement text, logs or plans.
-- @step consented_table
-- @outputs study.consented
DROP TABLE IF EXISTS study.consented;
CREATE TABLE study.consented (sa_id bigint PRIMARY KEY);

-- @query consented_load
INSERT INTO study.consented (sa_id)
SELECT c.sa_id FROM study.cred c WHERE c.view = ANY ($1::text[])
ON CONFLICT DO NOTHING;

-- @query consented_count
SELECT count(*) AS n FROM study.consented;
