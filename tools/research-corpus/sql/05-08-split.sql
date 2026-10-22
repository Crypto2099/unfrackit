-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- Section 5.8 of the pre-registration: the exploration and confirmation split.
--
-- Wallets are split 20% exploration and 80% confirmation by the "split" order
-- of section 5.4 (split_key in study.frame), before any outcome is computed.
-- One label per stake credential (X16 as decided on 2026-10-21): every
-- credential sampled in any frame and sample is ranked once by its split key,
-- and the first floor(N / 5) of the N distinct credentials (split_den) are
-- exploration, the rest confirmation. The split key depends only on h and the
-- credential, so a wallet drawn in both frames has the same key and the same
-- label in both; each sample is then about, not exactly, 20% exploration.
--
-- study.sample_wallet lists every sampled credential once, for the per-wallet
-- steps that follow (the section 6.1 check, prior-treated flags, franken
-- flags), and study.sample_frame each (frame, wallet) once, for the profile
-- inputs. Case wallets ride along: the wallets Adam K. Dean names as case
-- studies (pre-registration section 5.2). A case wallet that was also drawn
-- is in the sample like any other; one that was not rides along with
-- in_sample false, and every count over the sample leaves it out.

-- @step split
-- @outputs study.case_wallet
DROP TABLE IF EXISTS study.case_wallet;
CREATE TABLE study.case_wallet (sa_id bigint PRIMARY KEY);
UPDATE study.sample x
   SET split = CASE WHEN r.rn <= r.n / {{split_den}} THEN 'exploration' ELSE 'confirmation' END
  FROM (SELECT u.sa_id,
               row_number() OVER (ORDER BY u.split_key, u.sa_id) AS rn,
               count(*) OVER () AS n
          FROM (SELECT DISTINCT s.sa_id, f.split_key
                  FROM study.sample s JOIN study.frame f ON f.frame = s.frame AND f.sa_id = s.sa_id) u) r
 WHERE x.sa_id = r.sa_id;

-- The driver binds the case wallets (bech32 stake addresses).
-- @query case_wallet_load
INSERT INTO study.case_wallet (sa_id)
SELECT c.sa_id FROM study.cred c WHERE c.view = ANY ($1::text[])
ON CONFLICT DO NOTHING;

-- @step sample_wallets
-- @outputs study.sample_wallet study.sample_frame
DROP TABLE IF EXISTS study.sample_wallet;
CREATE TABLE study.sample_wallet AS
SELECT sa_id, bool_or(in_sample) AS in_sample
  FROM (SELECT sa_id, true AS in_sample FROM study.sample
        UNION ALL SELECT sa_id, false FROM study.case_wallet) x
 GROUP BY sa_id;
ALTER TABLE study.sample_wallet ADD PRIMARY KEY (sa_id);
DROP TABLE IF EXISTS study.sample_frame;
CREATE TABLE study.sample_frame AS
WITH m AS (
  SELECT DISTINCT frame, sa_id, true AS in_sample FROM study.sample
  UNION ALL
  SELECT fr.frame, c.sa_id, false FROM study.case_wallet c CROSS JOIN (VALUES ('recent'::text), ('peak'::text)) fr(frame)
   WHERE NOT EXISTS (SELECT 1 FROM study.sample s WHERE s.frame = fr.frame AND s.sa_id = c.sa_id)
)
SELECT m.frame, m.sa_id, m.in_sample,
       CASE m.frame WHEN 'recent' THEN {{recent_lo}}::bigint ELSE {{peak_lo}}::bigint END AS lo,
       CASE m.frame WHEN 'recent' THEN {{recent_hi}}::bigint ELSE {{peak_hi}}::bigint END AS hi,
       CASE m.frame WHEN 'recent' THEN {{recent_t_start}}::bigint ELSE {{peak_t_start}}::bigint END AS t_start,
       CASE m.frame WHEN 'recent' THEN {{snap_tx}}::bigint ELSE {{peak_t_end}}::bigint END AS t_end
  FROM m;
ALTER TABLE study.sample_frame ADD PRIMARY KEY (frame, sa_id);
ANALYZE study.sample_wallet;
ANALYZE study.sample_frame;

-- @query split_counts
SELECT frame, kind, stratum, count(*) AS n,
       count(*) FILTER (WHERE split = 'exploration') AS n_exploration,
       count(*) FILTER (WHERE split = 'confirmation') AS n_confirmation,
       count(*) FILTER (WHERE split IS NULL) AS n_unassigned,
       count(*) FILTER (WHERE excluded_6_1) AS n_excluded_6_1
  FROM study.sample GROUP BY frame, kind, stratum ORDER BY frame DESC, kind, stratum;

-- The split over all sampled credentials, each counted once.
-- @query split_overall
SELECT count(DISTINCT sa_id) AS n_credentials,
       count(DISTINCT sa_id) FILTER (WHERE split = 'exploration') AS n_exploration,
       count(DISTINCT sa_id) FILTER (WHERE split = 'confirmation') AS n_confirmation
  FROM study.sample;
