-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- Section 5.4 of the pre-registration: the draw and the samples.
--
-- Within each frame, eligible keys are ordered by draw_key (study.frame) and
-- taken in that order. The guard is read as counting eligible keys taken in
-- draw order: 200,000 per frame.
--
-- Random sample, per frame: keys are taken until all four hold: (a) 2,400
-- eligible token-holding wallets; (b) at least 1,000 of them with at least 5
-- spends in the window; (c) at least 600 of them holding 100 or more tokens;
-- (d) at least 600 of them fragmented (study.frame.frag: some fungible asset
-- on 10 or more of the wallet's UTxOs). Read as: every token-holding wallet
-- taken before that point joins the sample, so the sample is a prefix of draw
-- order (x7_prefix; with it false, after (a) only wallets meeting (b), (c) or
-- (d) join). prevalence_member marks the wallets taken before (a) was
-- reached. If the guard is reached first, every token-holding wallet within
-- it joins and the achieved counts are recorded. Every sample row carries the
-- wallet's fragmentation flag in its frame (set by the split step).
--
-- ADA-only sample: the first 1,200 eligible ADA-only wallets in draw order,
-- within the guard.
--
-- study.sample(frame, kind, stratum, sa_id, draw_rank, prevalence_member,
-- split, excluded_6_1, fragmented); draw_rank is the 1-based position in the
-- frame's draw order; excluded_6_1 is set by the section 6.1 check.

-- @step draw
-- @outputs study.draw_order study.draw_summary study.sample
DROP TABLE IF EXISTS study.sample;
DROP TABLE IF EXISTS study.draw_summary;
DROP TABLE IF EXISTS study.draw_order;
CREATE TABLE study.draw_order AS
WITH o AS (
  SELECT frame, sa_id, tok, ge5, ge100, frag, draw_key,
         row_number() OVER (PARTITION BY frame ORDER BY draw_key) AS k
    FROM study.frame WHERE eligible
)
SELECT o.*,
       sum(tok::int) OVER w AS n_a,
       sum((tok AND ge5)::int) OVER w AS n_b,
       sum((tok AND ge100)::int) OVER w AS n_c,
       sum((tok AND frag)::int) OVER w AS n_d,
       sum((NOT tok)::int) OVER w AS n_ada
  FROM o
WINDOW w AS (PARTITION BY frame ORDER BY k ROWS UNBOUNDED PRECEDING);
CREATE UNIQUE INDEX draw_order_frame_k ON study.draw_order (frame, k);
CREATE UNIQUE INDEX draw_order_frame_sa ON study.draw_order (frame, sa_id);
ANALYZE study.draw_order;
CREATE TABLE study.draw_summary AS
WITH s AS (
  SELECT fr.frame,
         min(d.k) FILTER (WHERE d.n_a >= {{target_a}} AND d.n_b >= {{target_b}} AND d.n_c >= {{target_c}} AND d.n_d >= {{target_d}}) AS k_all,
         min(d.k) FILTER (WHERE d.n_a >= {{target_a}}) AS k_a,
         min(d.k) FILTER (WHERE d.n_ada >= {{ada_only_n}}) AS k_ada,
         coalesce(max(d.k), 0) AS k_max
    FROM (VALUES ('recent'::text), ('peak'::text)) fr(frame)
    LEFT JOIN study.draw_order d ON d.frame = fr.frame AND d.k <= {{guard}}
   GROUP BY fr.frame
)
SELECT s.*,
       coalesce(s.k_all, least({{guard}}, s.k_max)) AS k_stop,
       coalesce(s.k_a, least({{guard}}, s.k_max)) AS k_prevalence,
       (SELECT count(*) FROM study.draw_order d WHERE d.frame = s.frame) AS n_eligible,
       (s.k_all IS NULL AND (SELECT count(*) FROM study.draw_order d WHERE d.frame = s.frame) >= {{guard}}) AS guard_reached
  FROM s;
ALTER TABLE study.draw_summary ADD COLUMN n_a bigint, ADD COLUMN n_b bigint, ADD COLUMN n_c bigint, ADD COLUMN n_d bigint;
UPDATE study.draw_summary s
   SET n_a = d.n_a, n_b = d.n_b, n_c = d.n_c, n_d = d.n_d
  FROM study.draw_order d WHERE d.frame = s.frame AND d.k = s.k_stop;
CREATE TABLE study.sample (
  frame text NOT NULL,
  kind text NOT NULL,
  stratum text NOT NULL,
  sa_id bigint NOT NULL,
  draw_rank bigint NOT NULL,
  prevalence_member boolean NOT NULL,
  split text,
  excluded_6_1 boolean,
  fragmented boolean,
  PRIMARY KEY (frame, kind, stratum, sa_id)
);
INSERT INTO study.sample (frame, kind, stratum, sa_id, draw_rank, prevalence_member)
SELECT d.frame, 'random', '', d.sa_id, d.k, d.k <= s.k_prevalence
  FROM study.draw_order d JOIN study.draw_summary s ON s.frame = d.frame
 WHERE d.tok AND d.k <= s.k_stop
   AND ({{x7_prefix}} OR d.k <= s.k_prevalence OR d.ge5 OR d.ge100 OR d.frag);
INSERT INTO study.sample (frame, kind, stratum, sa_id, draw_rank, prevalence_member)
SELECT d.frame, 'ada_only', '', d.sa_id, d.k, false
  FROM study.draw_order d
 WHERE NOT d.tok AND d.n_ada <= {{ada_only_n}} AND d.k <= {{guard}};

-- @query draw_summary_rows
SELECT frame, k_all, k_a, k_ada, k_max, k_stop, k_prevalence, n_eligible, guard_reached, n_a, n_b, n_c, n_d,
       (SELECT count(*) FROM study.sample x WHERE x.frame = s.frame AND x.kind = 'random') AS n_random,
       (SELECT count(*) FROM study.sample x WHERE x.frame = s.frame AND x.kind = 'random' AND x.prevalence_member) AS n_prevalence,
       (SELECT count(*) FROM study.sample x WHERE x.frame = s.frame AND x.kind = 'ada_only') AS n_ada_only
  FROM study.draw_summary s ORDER BY frame DESC;

-- The bound of every sample, for an outsider's reproduction: the draw key of
-- the last wallet taken. A reproduction takes every eligible key of the
-- sample's kind up to the bound, in draw order and with the same skipping.
-- @query sample_bounds
WITH g AS (
  SELECT frame, kind, stratum, count(*) AS n, max(draw_rank) AS last_k
    FROM study.sample GROUP BY frame, kind, stratum
)
SELECT g.frame, g.kind, g.stratum, g.n, encode(d.draw_key, 'hex') AS bound
  FROM g JOIN study.draw_order d ON d.frame = g.frame AND d.k = g.last_k
 ORDER BY g.frame DESC, g.kind, g.stratum;
