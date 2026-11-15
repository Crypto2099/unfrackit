-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- The exploration and confirmation split.
--
-- Labels follow the kind of the row, set once the draw has filled each frame's
-- sample and then its pilot: a pilot row (kind 'pilot') is exploration, a
-- sample row (kind 'random') is confirmation, so every sampled wallet is
-- confirmation and the pilot, drawn after the sample outside it, is the
-- exploration set. A wallet is never in a pilot and a sample (the pilot's
-- candidates leave out both samples' wallets), so a wallet in both frames'
-- pilots, or in both frames' samples, carries one label in both.
--
-- study.sample_wallet lists every sampled and pilot credential once, for the
-- per-wallet steps that follow (the reconstruction check, prior-treated flags, franken
-- flags), and study.sample_frame each (frame, wallet) once, for the profile
-- inputs.

-- @step split
-- @outputs study.sample
UPDATE study.sample SET split = CASE kind WHEN 'pilot' THEN 'exploration' ELSE 'confirmation' END;
-- Every sampled and pilot wallet carries its frame's fragmentation flag
-- (frames.sql), a descriptive field, so outcomes can be reported by it.
UPDATE study.sample x
   SET fragmented = f.frag
  FROM study.frame f
 WHERE f.frame = x.frame AND f.sa_id = x.sa_id;

-- @step sample_wallets
-- @outputs study.sample_wallet study.sample_frame
DROP TABLE IF EXISTS study.sample_wallet;
CREATE TABLE study.sample_wallet AS
SELECT DISTINCT sa_id FROM study.sample;
ALTER TABLE study.sample_wallet ADD PRIMARY KEY (sa_id);
DROP TABLE IF EXISTS study.sample_frame;
CREATE TABLE study.sample_frame AS
SELECT m.frame, m.sa_id,
       CASE m.frame WHEN 'recent' THEN {{recent_lo}}::bigint ELSE {{peak_lo}}::bigint END AS lo,
       CASE m.frame WHEN 'recent' THEN {{recent_hi}}::bigint ELSE {{peak_hi}}::bigint END AS hi,
       CASE m.frame WHEN 'recent' THEN {{recent_t_start}}::bigint ELSE {{peak_t_start}}::bigint END AS t_start,
       CASE m.frame WHEN 'recent' THEN {{snap_tx}}::bigint ELSE {{peak_t_end}}::bigint END AS t_end
  FROM (SELECT DISTINCT frame, sa_id FROM study.sample) m;
ALTER TABLE study.sample_frame ADD PRIMARY KEY (frame, sa_id);
ANALYZE study.sample_wallet;
ANALYZE study.sample_frame;

-- Per frame and size group.
-- @query split_counts
SELECT frame, kind, size_group, count(*) AS n,
       count(*) FILTER (WHERE split = 'exploration') AS n_exploration,
       count(*) FILTER (WHERE split = 'confirmation') AS n_confirmation,
       count(*) FILTER (WHERE split IS NULL) AS n_unassigned,
       count(*) FILTER (WHERE reconstruction_excluded) AS n_reconstruction_excluded,
       count(*) FILTER (WHERE fragmented) AS n_fragmented,
       count(*) FILTER (WHERE capped) AS n_capped
  FROM study.sample GROUP BY frame, kind, size_group ORDER BY frame DESC, kind, size_group;

-- The split over the credentials of each kind, each counted once.
-- @query split_overall
SELECT kind, count(DISTINCT sa_id) AS n_credentials,
       count(DISTINCT sa_id) FILTER (WHERE split = 'exploration') AS n_exploration,
       count(DISTINCT sa_id) FILTER (WHERE split = 'confirmation') AS n_confirmation
  FROM study.sample GROUP BY kind ORDER BY kind;
