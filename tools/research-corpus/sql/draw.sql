-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- The draw and the sample.
--
-- Within each frame, eligible keys are ordered by draw_key (study.frame) and
-- taken in that order. The guard is read as counting eligible keys taken in
-- draw order: 200,000 per frame.
--
-- One sample per frame: the eligible token-holding wallets with at least 5
-- spends in the window (study.frame.ge5, spends_min), taken in draw order
-- until 1,000 (sample_n) are taken. These are the draw's candidates. The
-- frame's other eligible keys (ADA-only wallets, wallets with fewer spends)
-- are passed over; they count toward the guard only.
--
-- Size groups. Each candidate is placed in a size group by two counts:
--   U  the larger of its UTxO counts at the window's start and at the frame's
--      reference block (the snapshot for the recent frame, the window's end
--      for the peak frame), held UTxOs counted as the frame counts them
--      (x9_count_held). The state at the window's start is the state as of
--      the last block before the window's first block (t_start of the
--      windows; x3_after_first);
--   T  the window's transactions that create or consume an output carrying
--      its stake credential, at any payment credential (n_tx_any of
--      study.activity).
-- B0 is U and T both under 250 (group_edge_b1); B1 is either reaching 250,
-- B2 either reaching 1,000 (group_edge_b2), B3 either reaching 4,000
-- (group_edge_b3); a wallet is in the highest group it reaches. B1, B2 and
-- B3 have quotas inside the sample: 100, 10 and 2 at scale s = 1 (quota_b1
-- to quota_b3, quota_scale), each its value times s rounded to a whole
-- number, halves up. B0 has no quota and takes the rest. A group fills in
-- draw order: a candidate is taken while its group has room, and a later
-- candidate of a full group is skipped and counted. The draw stops at the
-- candidate that makes the sample full, or at the guard, or at the frame's
-- last eligible key; a sample short of 1,000 is recorded as it is.
--
-- The pilot. After a frame's sample fills, its draw continues in the same
-- order for a pilot of 100 wallets (pilot_n), the exploration set (5.8; the
-- pilot never enters a result). The pilot's candidates are the frame's
-- candidates after the sample's stopping point (draw_summary.k_stop of kind
-- 'random') that are in neither frame's sample; a wallet in the other frame's
-- sample is not a pilot candidate and is not counted in the pilot's D_k. Each
-- group with a sample quota takes max(1, round(quota * s * pilot_n /
-- sample_n)) in the pilot, halves up as the sample's are: at the defaults B1
-- 10, B2 1 and B3 1, the at-least-one rule binding for B3 (0.2 rounds to 0).
-- B0 takes the rest. A group fills in draw order, a later candidate of a full
-- group is skipped and counted, and the pilot stops at the candidate that
-- makes it full (pilot_n), or at the guard, or at the frame's last eligible
-- key; a short pilot is recorded as it is. The pilot's D_k and A_k are its
-- own: its candidates of group k from the sample's stopping point to the
-- pilot's, and those taken; a pilot wallet's weight is D_k / A_k from these.
-- A wallet in both frames' pilots is one wallet with one label, and a wallet
-- is never in a pilot and a sample. study.draw_group has one row per frame,
-- kind and group, study.draw_summary one per frame and kind (the pilot's with
-- sample_n = pilot_n), and study.sample rows of kind 'pilot' carry every
-- column a sample row does.
--
-- Per frame, kind and group, study.draw_group holds the quota, the candidates drawn
-- up to the stopping point (n_drawn, D_k: taken and skipped) and those taken
-- (n_taken, A_k); a taken wallet of group k carries weight D_k / A_k. The
-- quotas are fixed settings: nothing here reads how many wallets of a group
-- the frame holds before the draw.
--
-- The history cap. A taken wallet's history is its window's first 1,000
-- (history_cap) transactions: T's transactions in transaction-id order, which
-- the order check (00-study-schema.sql) shows is chain order. Each sample row
-- records T in full (n_window_tx), whether T exceeds the cap (capped), and
-- history_hi, the transaction id the wallet's history ends at: its 1,000th
-- window transaction when capped, the window's last transaction id (hi)
-- otherwise. Measures taken at the end of a capped wallet's history are
-- flagged by capped.
--
-- study.draw_order holds every eligible key of each frame with its draw rank
-- k and, for candidates, the two counts, the group, the place in the group
-- (group_rank), whether it is taken, and the running count of wallets taken.
-- study.sample(frame, kind, sa_id, draw_rank, size_group, n_utxo_start,
-- n_utxo_ref, n_window_tx, capped, history_hi, split,
-- reconstruction_excluded, fragmented, franken_any, franken_no_cospend,
-- unfrackit_user, evolution_tidied, prior_treated): kind is 'random' (the sample) or 'pilot';
-- draw_rank is the 1-based position in the frame's draw order; split (by
-- kind) and fragmented are set by the split step (split.sql), reconstruction_excluded
-- by the reconstruction check (reconstruction-check.sql), franken_any and
-- franken_no_cospend by the franken step (franken.sql), unfrackit_user,
-- evolution_tidied and prior_treated by the prior_flags step
-- (prior-treated.sql). The last five are per-wallet booleans, the same on every
-- row of a wallet, false when the wallet has no row in the flag's source.

-- @step draw
-- @outputs study.draw_order study.draw_group study.draw_summary study.sample
DROP TABLE IF EXISTS study.sample;
DROP TABLE IF EXISTS study.draw_summary;
DROP TABLE IF EXISTS study.draw_order;
DROP TABLE IF EXISTS study.draw_group;
-- One row per frame, kind and group, with the group's quota (none for B0).
-- The pilot's quota is the sample's scaled to the pilot's size, at least one.
CREATE TABLE study.draw_group AS
SELECT fr.frame, kd.kind, g.size_group,
       CASE WHEN g.base IS NULL THEN NULL::bigint
            WHEN kd.kind = 'random' THEN round(g.base * {{quota_scale}})::bigint
            ELSE greatest(1, round(g.base * {{quota_scale}} * {{pilot_n}} / {{sample_n}}))::bigint END AS quota,
       NULL::bigint AS n_drawn, NULL::bigint AS n_taken, NULL::bigint AS n_skipped
  FROM (VALUES ('recent'::text), ('peak'::text)) fr(frame)
 CROSS JOIN (VALUES ('random'::text), ('pilot'::text)) kd(kind)
 CROSS JOIN (VALUES ('B0'::text, NULL::numeric),
                    ('B1', {{quota_b1}}::numeric),
                    ('B2', {{quota_b2}}::numeric),
                    ('B3', {{quota_b3}}::numeric)) g(size_group, base);
ALTER TABLE study.draw_group ADD PRIMARY KEY (frame, kind, size_group);
CREATE TABLE study.draw_order AS
WITH o AS (
  SELECT frame, sa_id, tok, ge5, frag, n_utxo, draw_key,
         row_number() OVER (PARTITION BY frame ORDER BY draw_key) AS k
    FROM study.frame WHERE eligible
),
c AS (
  SELECT o.*, (o.tok AND o.ge5 AND o.k <= {{guard}}) AS candidate,
         CASE o.frame WHEN 'recent' THEN {{recent_t_start}}::bigint ELSE {{peak_t_start}}::bigint END AS t_start
    FROM o
),
u AS (
  -- The UTxO count at the window's start, for candidates only.
  SELECT c.frame, c.sa_id, count(t.tx_out_id) AS n_utxo_start
    FROM c
    LEFT JOIN study.txo t
           ON t.sa_id = c.sa_id
          AND t.created_tx <= c.t_start AND (t.consumed_tx IS NULL OR t.consumed_tx > c.t_start)
          AND ({{x9_count_held}} OR NOT (t.has_datum OR t.has_ref_script OR t.script_pay))
   WHERE c.candidate
   GROUP BY c.frame, c.sa_id
),
m AS (
  SELECT c.frame, c.sa_id, c.k, c.tok, c.ge5, c.frag, c.draw_key, c.candidate,
         u.n_utxo_start,
         CASE WHEN c.candidate THEN c.n_utxo END AS n_utxo_ref,
         CASE WHEN c.candidate THEN coalesce(a.n_tx_any, 0) END AS n_window_tx
    FROM c
    LEFT JOIN u ON u.frame = c.frame AND u.sa_id = c.sa_id
    LEFT JOIN study.activity a ON c.candidate AND a.win = c.frame AND a.sa_id = c.sa_id
),
g AS (
  SELECT m.*,
         CASE WHEN NOT m.candidate THEN NULL
              WHEN greatest(m.n_utxo_start, m.n_utxo_ref) >= {{group_edge_b3}} OR m.n_window_tx >= {{group_edge_b3}} THEN 'B3'
              WHEN greatest(m.n_utxo_start, m.n_utxo_ref) >= {{group_edge_b2}} OR m.n_window_tx >= {{group_edge_b2}} THEN 'B2'
              WHEN greatest(m.n_utxo_start, m.n_utxo_ref) >= {{group_edge_b1}} OR m.n_window_tx >= {{group_edge_b1}} THEN 'B1'
              ELSE 'B0' END AS size_group
    FROM m
),
r AS (
  SELECT g.*,
         CASE WHEN g.candidate THEN row_number() OVER (PARTITION BY g.frame, g.candidate, g.size_group ORDER BY g.k) END AS group_rank
    FROM g
),
t AS (
  SELECT r.*,
         coalesce(r.candidate AND (q.quota IS NULL OR r.group_rank <= q.quota), false) AS taken
    FROM r
    LEFT JOIN study.draw_group q ON q.frame = r.frame AND q.kind = 'random' AND q.size_group = r.size_group
)
SELECT t.*,
       sum(t.taken::int) OVER (PARTITION BY t.frame ORDER BY t.k ROWS UNBOUNDED PRECEDING) AS n_taken
  FROM t;
CREATE UNIQUE INDEX draw_order_frame_k ON study.draw_order (frame, k);
CREATE UNIQUE INDEX draw_order_frame_sa ON study.draw_order (frame, sa_id);
ANALYZE study.draw_order;
-- The stopping point: the candidate that makes the sample full; if none
-- does, the guard or the frame's last eligible key.
CREATE TABLE study.draw_summary AS
WITH s AS (
  SELECT fr.frame,
         min(d.k) FILTER (WHERE d.n_taken >= {{sample_n}}) AS k_full,
         coalesce(max(d.k), 0) AS k_max,
         count(d.k) AS n_eligible
    FROM (VALUES ('recent'::text), ('peak'::text)) fr(frame)
    LEFT JOIN study.draw_order d ON d.frame = fr.frame
   GROUP BY fr.frame
)
SELECT s.frame, 'random'::text AS kind, s.k_full, s.k_max, s.n_eligible,
       coalesce(s.k_full, least({{guard}}, s.k_max)) AS k_stop,
       (s.k_full IS NULL AND s.n_eligible >= {{guard}}) AS guard_reached,
       {{sample_n}}::bigint AS sample_n,
       {{quota_scale}} AS quota_scale,
       {{history_cap}}::bigint AS history_cap
  FROM s;
ALTER TABLE study.draw_summary ADD PRIMARY KEY (frame, kind);
-- D_k and A_k: the candidates of each group drawn up to the stopping point,
-- and those of them taken. The pilot's are filled in below.
ALTER TABLE study.draw_summary ADD COLUMN n_drawn bigint, ADD COLUMN n_taken bigint;
UPDATE study.draw_group g
   SET n_drawn = x.n_drawn, n_taken = x.n_taken, n_skipped = x.n_drawn - x.n_taken
  FROM (SELECT q.frame, q.size_group,
               count(d.k) AS n_drawn,
               count(d.k) FILTER (WHERE d.taken) AS n_taken
          FROM study.draw_group q
          JOIN study.draw_summary s ON s.frame = q.frame AND s.kind = 'random'
          LEFT JOIN study.draw_order d
                 ON d.frame = q.frame AND d.candidate AND d.size_group = q.size_group AND d.k <= s.k_stop
         WHERE q.kind = 'random'
         GROUP BY q.frame, q.size_group) x
 WHERE x.frame = g.frame AND g.kind = 'random' AND x.size_group = g.size_group;
UPDATE study.draw_summary s
   SET n_drawn = x.n_drawn, n_taken = x.n_taken
  FROM (SELECT frame, sum(n_drawn)::bigint AS n_drawn, sum(n_taken)::bigint AS n_taken FROM study.draw_group WHERE kind = 'random' GROUP BY frame) x
 WHERE x.frame = s.frame AND s.kind = 'random';
CREATE TABLE study.sample (
  frame text NOT NULL CHECK (frame IN ('recent', 'peak')),
  kind text NOT NULL CHECK (kind IN ('random', 'pilot')),
  sa_id bigint NOT NULL,
  draw_rank bigint NOT NULL,
  size_group text NOT NULL CHECK (size_group IN ('B0', 'B1', 'B2', 'B3')),
  n_utxo_start bigint NOT NULL,
  n_utxo_ref bigint NOT NULL,
  n_window_tx bigint NOT NULL,
  capped boolean NOT NULL,
  history_hi bigint,
  split text,
  reconstruction_excluded boolean,
  fragmented boolean,
  franken_any boolean NOT NULL DEFAULT false,
  franken_no_cospend boolean NOT NULL DEFAULT false,
  unfrackit_user boolean NOT NULL DEFAULT false,
  evolution_tidied boolean NOT NULL DEFAULT false,
  prior_treated boolean NOT NULL DEFAULT false,
  PRIMARY KEY (frame, kind, sa_id)
);
INSERT INTO study.sample (frame, kind, sa_id, draw_rank, size_group, n_utxo_start, n_utxo_ref, n_window_tx, capped)
SELECT d.frame, 'random', d.sa_id, d.k, d.size_group, d.n_utxo_start, d.n_utxo_ref, d.n_window_tx, d.n_window_tx > {{history_cap}}
  FROM study.draw_order d JOIN study.draw_summary s ON s.frame = d.frame AND s.kind = 'random'
 WHERE d.taken AND d.k <= s.k_stop;
-- The pilot: the same draw order continued after the sample's stopping point,
-- over the frame's candidates that are in neither frame's sample, under the
-- pilot's quotas. Rank within group and the running count of wallets taken
-- are the sample's, restricted to the pilot's candidates.
ALTER TABLE study.draw_order ADD COLUMN pilot_candidate boolean, ADD COLUMN pilot_group_rank bigint,
                             ADD COLUMN pilot_taken boolean, ADD COLUMN pilot_n_taken bigint;
UPDATE study.draw_order d
   SET pilot_candidate = x.pc, pilot_group_rank = x.gr, pilot_taken = x.pt, pilot_n_taken = x.nt
  FROM (WITH p AS (
          SELECT o.frame, o.k, o.size_group,
                 (o.candidate AND o.k > s.k_stop
                  AND NOT EXISTS (SELECT 1 FROM study.sample x WHERE x.sa_id = o.sa_id)) AS pc
            FROM study.draw_order o JOIN study.draw_summary s ON s.frame = o.frame AND s.kind = 'random'
        ),
        r AS (
          SELECT p.*, CASE WHEN p.pc THEN row_number() OVER (PARTITION BY p.frame, p.pc, p.size_group ORDER BY p.k) END AS gr
            FROM p
        ),
        t AS (
          SELECT r.*, coalesce(r.pc AND (q.quota IS NULL OR r.gr <= q.quota), false) AS pt
            FROM r LEFT JOIN study.draw_group q ON q.frame = r.frame AND q.kind = 'pilot' AND q.size_group = r.size_group
        )
        SELECT t.frame, t.k, t.pc, t.gr, t.pt,
               sum(t.pt::int) OVER (PARTITION BY t.frame ORDER BY t.k ROWS UNBOUNDED PRECEDING) AS nt
          FROM t) x
 WHERE x.frame = d.frame AND x.k = d.k;
-- The pilot's stopping point, as the sample's: the candidate that makes it
-- full, else the guard or the frame's last eligible key.
INSERT INTO study.draw_summary (frame, kind, k_full, k_max, n_eligible, k_stop, guard_reached, sample_n, quota_scale, history_cap, n_drawn, n_taken)
SELECT s.frame, 'pilot', f.k_full, s.k_max, s.n_eligible,
       coalesce(f.k_full, least({{guard}}, s.k_max)),
       (f.k_full IS NULL AND s.n_eligible >= {{guard}}),
       {{pilot_n}}::bigint, s.quota_scale, s.history_cap, NULL, NULL
  FROM study.draw_summary s
  JOIN (SELECT fr.frame, min(d.k) FILTER (WHERE d.pilot_n_taken >= {{pilot_n}}) AS k_full
          FROM (VALUES ('recent'::text), ('peak'::text)) fr(frame)
          LEFT JOIN study.draw_order d ON d.frame = fr.frame
         GROUP BY fr.frame) f ON f.frame = s.frame
 WHERE s.kind = 'random';
UPDATE study.draw_group g
   SET n_drawn = x.n_drawn, n_taken = x.n_taken, n_skipped = x.n_drawn - x.n_taken
  FROM (SELECT q.frame, q.size_group,
               count(d.k) AS n_drawn,
               count(d.k) FILTER (WHERE d.pilot_taken) AS n_taken
          FROM study.draw_group q
          JOIN study.draw_summary s ON s.frame = q.frame AND s.kind = 'pilot'
          LEFT JOIN study.draw_order d
                 ON d.frame = q.frame AND d.pilot_candidate AND d.size_group = q.size_group AND d.k <= s.k_stop
         WHERE q.kind = 'pilot'
         GROUP BY q.frame, q.size_group) x
 WHERE x.frame = g.frame AND g.kind = 'pilot' AND x.size_group = g.size_group;
UPDATE study.draw_summary s
   SET n_drawn = x.n_drawn, n_taken = x.n_taken
  FROM (SELECT frame, sum(n_drawn)::bigint AS n_drawn, sum(n_taken)::bigint AS n_taken FROM study.draw_group WHERE kind = 'pilot' GROUP BY frame) x
 WHERE x.frame = s.frame AND s.kind = 'pilot';
INSERT INTO study.sample (frame, kind, sa_id, draw_rank, size_group, n_utxo_start, n_utxo_ref, n_window_tx, capped)
SELECT d.frame, 'pilot', d.sa_id, d.k, d.size_group, d.n_utxo_start, d.n_utxo_ref, d.n_window_tx, d.n_window_tx > {{history_cap}}
  FROM study.draw_order d JOIN study.draw_summary s ON s.frame = d.frame AND s.kind = 'pilot'
 WHERE d.pilot_taken AND d.k <= s.k_stop;
-- Where each wallet's history ends: the window's last transaction id, or for
-- a capped wallet the id of its history_cap-th window transaction.
UPDATE study.sample x
   SET history_hi = CASE
         WHEN NOT x.capped THEN CASE x.frame WHEN 'recent' THEN {{recent_hi}}::bigint ELSE {{peak_hi}}::bigint END
         ELSE (SELECT e.tx
                 FROM (SELECT t.created_tx AS tx FROM study.txo t
                        WHERE t.sa_id = x.sa_id
                          AND t.created_tx BETWEEN CASE x.frame WHEN 'recent' THEN {{recent_lo}}::bigint ELSE {{peak_lo}}::bigint END
                                               AND CASE x.frame WHEN 'recent' THEN {{recent_hi}}::bigint ELSE {{peak_hi}}::bigint END
                       UNION
                       SELECT t.consumed_tx FROM study.txo t
                        WHERE t.sa_id = x.sa_id
                          AND t.consumed_tx BETWEEN CASE x.frame WHEN 'recent' THEN {{recent_lo}}::bigint ELSE {{peak_lo}}::bigint END
                                                AND CASE x.frame WHEN 'recent' THEN {{recent_hi}}::bigint ELSE {{peak_hi}}::bigint END) e
                ORDER BY e.tx
               OFFSET ({{history_cap}} - 1) LIMIT 1)
       END;
-- A capped wallet always has a history_cap-th transaction: T counts the same
-- transactions (activity.sql).
ALTER TABLE study.sample ALTER COLUMN history_hi SET NOT NULL;
ANALYZE study.sample;

-- @query draw_summary_rows
SELECT s.frame, s.kind, s.k_full, s.k_max, s.k_stop, s.n_eligible, s.guard_reached, s.sample_n, s.quota_scale::text AS quota_scale, s.history_cap,
       s.n_drawn, s.n_taken,
       (SELECT count(*) FROM study.sample x WHERE x.frame = s.frame AND x.kind = s.kind) AS n_sample,
       (SELECT count(*) FROM study.sample x WHERE x.frame = s.frame AND x.kind = s.kind AND x.capped) AS n_capped
  FROM study.draw_summary s ORDER BY s.frame DESC, s.kind;

-- D_k and A_k per frame, kind and group, with the group's quota.
-- @query draw_group_rows
SELECT frame, kind, size_group, quota, n_drawn, n_taken, n_skipped
  FROM study.draw_group ORDER BY frame DESC, kind, size_group;

-- The draw's own consistency, as true or false, for the sample and the pilot
-- alike: the groups' counts add up to the drawn candidates and to the rows of
-- the kind; no group takes more than its quota, and one skips only when full;
-- the sample (the pilot) is full unless the draw stopped short of it; the cap
-- fields agree with T and the window. And the pilot comes after the sample's
-- stopping point and holds no wallet of either sample.
-- @query draw_check
SELECT
  (SELECT bool_and(s.n_taken = (SELECT count(*) FROM study.sample x WHERE x.frame = s.frame AND x.kind = s.kind)
               AND s.n_drawn = (SELECT count(*) FROM study.draw_order d
                                 WHERE d.frame = s.frame AND d.k <= s.k_stop
                                   AND CASE s.kind WHEN 'random' THEN d.candidate ELSE d.pilot_candidate END))
     FROM study.draw_summary s) AS groups_add_up,
  (SELECT coalesce(bool_and(g.quota IS NULL OR (g.n_taken <= g.quota AND (g.n_skipped = 0 OR g.n_taken = g.quota))), true)
     FROM study.draw_group g) AS quotas_hold,
  (SELECT bool_and(CASE WHEN s.k_full IS NULL THEN s.n_taken < s.sample_n ELSE s.n_taken = s.sample_n END)
     FROM study.draw_summary s) AS sample_size_holds,
  (SELECT coalesce(bool_and(x.capped = (x.n_window_tx > {{history_cap}})
                        AND CASE WHEN x.capped
                                 THEN x.history_hi BETWEEN CASE x.frame WHEN 'recent' THEN {{recent_lo}}::bigint ELSE {{peak_lo}}::bigint END
                                                       AND CASE x.frame WHEN 'recent' THEN {{recent_hi}}::bigint ELSE {{peak_hi}}::bigint END
                                 ELSE x.history_hi = CASE x.frame WHEN 'recent' THEN {{recent_hi}}::bigint ELSE {{peak_hi}}::bigint END END), true)
     FROM study.sample x) AS caps_hold,
  (SELECT NOT EXISTS (SELECT 1 FROM study.sample p JOIN study.sample s ON s.sa_id = p.sa_id AND s.kind = 'random'
                       WHERE p.kind = 'pilot')) AS pilot_outside_samples,
  (SELECT coalesce(bool_and(p.draw_rank > s.k_stop), true)
     FROM study.sample p JOIN study.draw_summary s ON s.frame = p.frame AND s.kind = 'random'
    WHERE p.kind = 'pilot') AS pilot_after_sample;

-- The bound of every sample and pilot, for an outsider's reproduction: the
-- draw key of the last wallet taken. A reproduction takes the frame's
-- candidates in draw order up to the bound, with the same groups and quotas
-- (a pilot's candidates also leave out both samples' wallets).
-- @query sample_bounds
WITH g AS (
  SELECT frame, kind, count(*) AS n, max(draw_rank) AS last_k
    FROM study.sample GROUP BY frame, kind
)
SELECT g.frame, g.kind, g.n, encode(d.draw_key, 'hex') AS bound
  FROM g JOIN study.draw_order d ON d.frame = g.frame AND d.k = g.last_k
 ORDER BY g.frame DESC, g.kind;
