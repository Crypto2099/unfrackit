-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- Section 5.5 of the pre-registration: franken addresses, per sampled wallet
-- over its whole history up to the snapshot.
--
-- In a wallet with two or more payment credentials, a payment credential is
-- flagged if it never appears as an input in a transaction that also spends
-- another of the wallet's credentials, in a wallet where at least one pair of
-- its credentials does co-spend. A wallet with one payment credential is never
-- flagged. Flagged credentials' UTxOs are held, not planned; a sensitivity
-- analysis drops wallets with any flag. Read as: key payment credentials only,
-- whole history up to the snapshot; script payment credentials are held anyway
-- (x13_all includes them).
--
-- Inputs are reduced to distinct (wallet, transaction, credential) first; a
-- credential co-spends when its transaction holds two or more of the wallet's
-- credentials. This is the pairwise definition without the pairwise join.

-- @step franken
-- @outputs study.franken
DROP TABLE IF EXISTS study.franken;
CREATE TABLE study.franken AS
WITH creds AS (
  SELECT DISTINCT t.sa_id, t.payment_cred
    FROM study.txo t JOIN study.sample_wallet w ON w.sa_id = t.sa_id
   WHERE ({{x13_all}} OR NOT t.script_pay) AND t.created_tx <= {{snap_tx}}
),
ins AS (
  SELECT DISTINCT t.sa_id, t.consumed_tx AS tx, t.payment_cred
    FROM study.txo t JOIN study.sample_wallet w ON w.sa_id = t.sa_id
   WHERE ({{x13_all}} OR NOT t.script_pay) AND t.consumed_tx <= {{snap_tx}}
),
multi AS (SELECT sa_id, tx FROM ins GROUP BY sa_id, tx HAVING count(*) >= 2),
co AS (SELECT DISTINCT i.sa_id, i.payment_cred FROM ins i JOIN multi m ON m.sa_id = i.sa_id AND m.tx = i.tx),
nc AS (SELECT sa_id, count(*) AS n_creds FROM creds GROUP BY sa_id),
anyco AS (SELECT DISTINCT sa_id FROM co)
SELECT c.sa_id, c.payment_cred, nc.n_creds,
       (nc.n_creds >= 2 AND a.sa_id IS NOT NULL AND co.payment_cred IS NULL) AS flagged
  FROM creds c
  JOIN nc ON nc.sa_id = c.sa_id
  LEFT JOIN anyco a ON a.sa_id = c.sa_id
  LEFT JOIN co ON co.sa_id = c.sa_id AND co.payment_cred = c.payment_cred;
CREATE INDEX franken_sa ON study.franken (sa_id);

-- Over the sampled wallets only (case wallets are reported per wallet).
-- @query franken_counts
SELECT count(DISTINCT f.sa_id) AS n_wallets,
       count(DISTINCT f.sa_id) FILTER (WHERE f.n_creds >= 2) AS n_multi_cred,
       count(DISTINCT f.sa_id) FILTER (WHERE f.flagged) AS n_wallets_flagged,
       count(*) FILTER (WHERE f.flagged) AS n_creds_flagged
  FROM study.franken f JOIN study.sample_wallet w ON w.sa_id = f.sa_id AND w.in_sample;
