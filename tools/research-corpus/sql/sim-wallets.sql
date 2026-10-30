-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- The wallets the simulator's live-fire checks run on, picked mechanically by
-- one live-fire extraction run (run --live-fire --sim-wallets) with its stated
-- test value of h, never the study's draw key, so no one picks them and the
-- number of wallets ever seen is bounded. In each frame's draw order under
-- that h (study.draw_order, eligible keys only), the first wallet meeting each
-- condition is taken, a wallet meeting several counting once:
--    1  recent frame, token-holding
--    2  recent frame, token-holding with at least 5 spend events in the window
--    3  recent frame, holding 100 or more distinct assets at the snapshot
--    4  recent frame, fragmented (requirement (d) of the draw)
--    5  recent frame, ADA-only
--    6  recent frame, a script-executing spend in the window
--    7  recent frame, more than 1,000 UTxOs at the snapshot
--    8  peak frame, at least 5 spend events in the window
--    9  peak frame, a spend in the window's Mary-era epochs
--   10  peak frame, a script-executing spend in the window
-- At most ten wallets result. A spend is a spend event as the activity step
-- counts it (x2_any); "script-executing" is the profile step's reading: a
-- Plutus redeemer, or a phase-2-invalid transaction (x17_invalid_is_script).
-- The Mary-era epochs are the window's epochs whose protocol_major is 4, read
-- from epoch_param as the peak search reads it, never an epoch number; they
-- are the first epochs of the window when it begins before Alonzo, so one
-- transaction-id range covers them. A frame with no such epoch gives no
-- wallet for condition 9.

-- @step sim_wallets
-- @outputs study.sim_wallet
DROP TABLE IF EXISTS study.sim_wallet;
CREATE TABLE study.sim_wallet AS
WITH d AS (
  SELECT d.frame, d.k, d.sa_id, d.tok, d.ge5, d.frag,
         greatest(f.n_assets_a, f.n_assets_b) AS n_assets, f.n_utxo
    FROM study.draw_order d
    JOIN study.frame f ON f.frame = d.frame AND f.sa_id = d.sa_id
),
firsts AS (
  SELECT frame,
         min(k) FILTER (WHERE tok) AS c1,
         min(k) FILTER (WHERE tok AND ge5) AS c2,
         min(k) FILTER (WHERE n_assets >= {{assets_c_min}}) AS c3,
         min(k) FILTER (WHERE frag) AS c4,
         min(k) FILTER (WHERE NOT tok) AS c5,
         min(k) FILTER (WHERE n_utxo > {{sim_utxo_over}}) AS c7,
         min(k) FILTER (WHERE ge5) AS c8
    FROM d GROUP BY frame
),
mary AS (
  SELECT study.first_tx_from_block(min(b.id)) AS lo, study.t_of_block(max(b.id)) AS hi
    FROM public.block b
   WHERE b.epoch_no BETWEEN {{peak_first_epoch}} AND {{peak_last_epoch}}
     AND b.epoch_no IN (SELECT ep.epoch_no FROM public.epoch_param ep WHERE ep.protocol_major = 4)
),
spend_firsts AS (
  SELECT 6 AS cond, 'recent'::text AS frame,
         (SELECT min(d.k) FROM study.draw_order d
           WHERE d.frame = 'recent'
             AND EXISTS (SELECT 1 FROM study.txo t
                          WHERE t.sa_id = d.sa_id AND t.consumed_tx BETWEEN {{recent_lo}} AND {{recent_hi}}
                            AND ({{x2_any}} OR NOT t.script_pay)
                            AND (EXISTS (SELECT 1 FROM study.script_tx x WHERE x.tx_id = t.consumed_tx)
                                 OR ({{x17_invalid_is_script}} AND EXISTS (SELECT 1 FROM public.tx v WHERE v.id = t.consumed_tx AND NOT v.valid_contract))))) AS k
  UNION ALL
  SELECT 9, 'peak',
         (SELECT min(d.k) FROM study.draw_order d, mary
           WHERE d.frame = 'peak'
             AND EXISTS (SELECT 1 FROM study.txo t
                          WHERE t.sa_id = d.sa_id AND t.consumed_tx BETWEEN mary.lo AND mary.hi
                            AND ({{x2_any}} OR NOT t.script_pay)))
  UNION ALL
  SELECT 10, 'peak',
         (SELECT min(d.k) FROM study.draw_order d
           WHERE d.frame = 'peak'
             AND EXISTS (SELECT 1 FROM study.txo t
                          WHERE t.sa_id = d.sa_id AND t.consumed_tx BETWEEN {{peak_lo}} AND {{peak_hi}}
                            AND ({{x2_any}} OR NOT t.script_pay)
                            AND (EXISTS (SELECT 1 FROM study.script_tx x WHERE x.tx_id = t.consumed_tx)
                                 OR ({{x17_invalid_is_script}} AND EXISTS (SELECT 1 FROM public.tx v WHERE v.id = t.consumed_tx AND NOT v.valid_contract)))))
),
c AS (
  SELECT 1 AS cond, frame, c1 AS k FROM firsts WHERE frame = 'recent'
  UNION ALL SELECT 2, frame, c2 FROM firsts WHERE frame = 'recent'
  UNION ALL SELECT 3, frame, c3 FROM firsts WHERE frame = 'recent'
  UNION ALL SELECT 4, frame, c4 FROM firsts WHERE frame = 'recent'
  UNION ALL SELECT 5, frame, c5 FROM firsts WHERE frame = 'recent'
  UNION ALL SELECT 7, frame, c7 FROM firsts WHERE frame = 'recent'
  UNION ALL SELECT 8, frame, c8 FROM firsts WHERE frame = 'peak'
  UNION ALL SELECT cond, frame, k FROM spend_firsts
)
SELECT o.sa_id,
       array_agg(c.cond ORDER BY c.cond) AS conditions,
       array_agg(DISTINCT c.frame) AS frames
  FROM c JOIN study.draw_order o ON o.frame = c.frame AND o.k = c.k
 GROUP BY o.sa_id;

-- The selection with each wallet's stake address, for the private file the
-- simulator's checks read.
-- @query sim_wallet_rows
SELECT c.view AS stake_address, s.conditions, s.frames
  FROM study.sim_wallet s JOIN study.cred c ON c.sa_id = s.sa_id
 ORDER BY s.conditions[1];
