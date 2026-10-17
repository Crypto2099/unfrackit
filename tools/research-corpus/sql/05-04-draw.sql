-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- Section 5.4 of the pre-registration: the draw and the samples.
--
-- Within each frame, eligible keys are ordered by draw_key (study.frame) and
-- taken in that order. The guard is read as counting eligible keys taken in
-- draw order: 200,000 per frame.
--
-- Random sample, per frame: keys are taken until all three hold: (a) 2,400
-- eligible token-holding wallets; (b) at least 1,000 of them with at least 5
-- spends in the window; (c) at least 600 eligible wallets holding 100 or more
-- tokens. Read as: every token-holding wallet taken before that point joins
-- the sample, so the sample is a prefix of draw order (x7_prefix; with it
-- false, after (a) only wallets meeting (b) or (c) join). prevalence_member
-- marks the wallets taken before (a) was reached. If the guard is reached
-- first, every token-holding wallet within it joins and the achieved counts
-- are recorded.
--
-- ADA-only sample: the first 1,200 eligible ADA-only wallets in draw order,
-- within the guard.
--
-- study.sample(frame, kind, stratum, sa_id, draw_rank, prevalence_member,
-- split); draw_rank is the 1-based position in the frame's draw order.

-- @step draw
-- @outputs study.draw_order study.draw_summary study.sample
DROP TABLE IF EXISTS study.sample;
DROP TABLE IF EXISTS study.draw_summary;
DROP TABLE IF EXISTS study.draw_order;
CREATE TABLE study.draw_order AS
WITH o AS (
  SELECT frame, sa_id, tok, ge5, ge100, draw_key,
         row_number() OVER (PARTITION BY frame ORDER BY draw_key) AS k
    FROM study.frame WHERE eligible
)
SELECT o.*,
       sum(tok::int) OVER w AS n_a,
       sum((tok AND ge5)::int) OVER w AS n_b,
       sum((tok AND ge100)::int) OVER w AS n_c,
       sum((NOT tok)::int) OVER w AS n_ada
  FROM o
WINDOW w AS (PARTITION BY frame ORDER BY k ROWS UNBOUNDED PRECEDING);
CREATE UNIQUE INDEX draw_order_frame_k ON study.draw_order (frame, k);
CREATE UNIQUE INDEX draw_order_frame_sa ON study.draw_order (frame, sa_id);
ANALYZE study.draw_order;
CREATE TABLE study.draw_summary AS
WITH s AS (
  SELECT fr.frame,
         min(d.k) FILTER (WHERE d.n_a >= {{target_a}} AND d.n_b >= {{target_b}} AND d.n_c >= {{target_c}}) AS k_all,
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
ALTER TABLE study.draw_summary ADD COLUMN n_a bigint, ADD COLUMN n_b bigint, ADD COLUMN n_c bigint;
UPDATE study.draw_summary s
   SET n_a = d.n_a, n_b = d.n_b, n_c = d.n_c
  FROM study.draw_order d WHERE d.frame = s.frame AND d.k = s.k_stop;
CREATE TABLE study.sample (
  frame text NOT NULL,
  kind text NOT NULL,
  stratum text NOT NULL,
  sa_id bigint NOT NULL,
  draw_rank bigint NOT NULL,
  prevalence_member boolean NOT NULL,
  split text,
  PRIMARY KEY (frame, kind, stratum, sa_id)
);
INSERT INTO study.sample (frame, kind, stratum, sa_id, draw_rank, prevalence_member)
SELECT d.frame, 'random', '', d.sa_id, d.k, d.k <= s.k_prevalence
  FROM study.draw_order d JOIN study.draw_summary s ON s.frame = d.frame
 WHERE d.tok AND d.k <= s.k_stop
   AND ({{x7_prefix}} OR d.k <= s.k_prevalence OR d.ge5 OR d.ge100);
INSERT INTO study.sample (frame, kind, stratum, sa_id, draw_rank, prevalence_member)
SELECT d.frame, 'ada_only', '', d.sa_id, d.k, false
  FROM study.draw_order d
 WHERE NOT d.tok AND d.n_ada <= {{ada_only_n}} AND d.k <= {{guard}};

-- @query draw_summary_rows
SELECT frame, k_all, k_a, k_ada, k_max, k_stop, k_prevalence, n_eligible, guard_reached, n_a, n_b, n_c,
       (SELECT count(*) FROM study.sample x WHERE x.frame = s.frame AND x.kind = 'random') AS n_random,
       (SELECT count(*) FROM study.sample x WHERE x.frame = s.frame AND x.kind = 'random' AND x.prevalence_member) AS n_prevalence,
       (SELECT count(*) FROM study.sample x WHERE x.frame = s.frame AND x.kind = 'ada_only') AS n_ada_only
  FROM study.draw_summary s ORDER BY frame DESC;

-- The consented keys stay private, so an outsider's reproduction of the draw
-- includes them where they would have been eligible. Published beside the
-- count removed: how many of them, had they not been removed, would sit inside
-- each sample's drawn prefix (draw_key at or below the key of the last
-- position taken), so a reproduction can differ only by those keys.
-- @query consented_in_prefix
WITH b AS (
  SELECT s.frame,
         (SELECT d.draw_key FROM study.draw_order d WHERE d.frame = s.frame AND d.k = s.k_stop) AS random_bound,
         (SELECT d.draw_key FROM study.draw_order d JOIN study.sample x ON x.frame = d.frame AND x.sa_id = d.sa_id AND x.kind = 'ada_only'
           WHERE d.frame = s.frame ORDER BY d.k DESC LIMIT 1) AS ada_bound
    FROM study.draw_summary s
)
SELECT b.frame,
       count(f.sa_id) FILTER (WHERE f.tok AND f.draw_key <= b.random_bound) AS random_prefix,
       count(f.sa_id) FILTER (WHERE NOT f.tok AND f.draw_key <= b.ada_bound) AS ada_only_prefix
  FROM b LEFT JOIN study.frame f ON f.frame = b.frame AND f.consented AND f.eligible_unless_consented
 GROUP BY b.frame ORDER BY b.frame DESC;
