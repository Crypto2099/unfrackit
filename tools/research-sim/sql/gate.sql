-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- The mainnet gate's reads (src/history/db.mjs): the extraction tool's record
-- of its study run on the final freeze, as its driver writes it
-- (tools/research-corpus, sql/00-study-schema.sql: study.run, and
-- study.param's rows `mode`, `freeze`, `snapshot`, `windows` and `finished`),
-- and the run mark on each study table this code reads. The live-fire path
-- reads the first two only, to refuse once a run of the final freeze is
-- recorded. Nothing here reads a wallet, and none of it creates anything.

-- Whether this role can read the extraction's run records. to_regclass itself
-- needs USAGE on the schema, so it runs only when the role has it.
-- @query gate_runs_readable
WITH u AS (
  SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'study')
              THEN has_schema_privilege(current_user, 'study', 'USAGE') ELSE false END AS usage
)
SELECT CASE WHEN NOT u.usage THEN false
            WHEN to_regclass('study.run') IS NULL OR to_regclass('study.param') IS NULL THEN false
            ELSE has_table_privilege(current_user, 'study.run', 'SELECT')
                 AND has_table_privilege(current_user, 'study.param', 'SELECT') END AS readable
  FROM u;

-- Every run whose recorded freeze is the final freeze, with the rows the gate
-- reads. The extraction refuses a second such run, so there is at most one.
-- @query gate_final_freeze_runs
SELECT r.run_id, r.network,
       (SELECT p.value FROM study.param p WHERE p.run_id = r.run_id AND p.key = 'mode') AS mode,
       f.value AS freeze,
       (SELECT p.value FROM study.param p WHERE p.run_id = r.run_id AND p.key = 'snapshot') AS snapshot,
       (SELECT p.value FROM study.param p WHERE p.run_id = r.run_id AND p.key = 'windows') AS windows,
       (SELECT p.value FROM study.param p WHERE p.run_id = r.run_id AND p.key = 'finished') AS finished
  FROM study.run r
  JOIN study.param f ON f.run_id = r.run_id AND f.key = 'freeze' AND f.value->>'role' = 'final-freeze'
 ORDER BY r.run_id;

-- The comment the extraction's runner writes on every table a step builds,
-- `research-corpus run <run id>`, for each study table this code reads (NULL
-- for a table that does not exist).
-- @query gate_table_marks
SELECT t.name, obj_description(to_regclass('study.' || t.name), 'pg_class') AS mark
  FROM unnest(ARRAY['frame', 'sample', 'franken', 'txo', 'txo_asset', 'asset']) WITH ORDINALITY AS t(name, n)
 ORDER BY t.n;
