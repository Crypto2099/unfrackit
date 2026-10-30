#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam K. Dean
#
# Runs the preprod integration tests. Stop the dev db-sync instance first so
# the database tip is the snapshot, and start it again after.
# Usage: test/integration/run-preprod.sh <tag> [test files...]
set -eu
cd "$(dirname "$0")/../.."
: "${PGHOST:=127.0.0.1}" "${PGPORT:=5433}" "${PGDATABASE:=dbsync_preprod_r}" "${PGUSER:=study}"
: "${PGPASSFILE:?set PGPASSFILE to the study role password file}"
: "${RESEARCH_CORPUS_SEEDER_DIR:?set RESEARCH_CORPUS_SEEDER_DIR to tools/preprod-seeder}"
: "${RESEARCH_CORPUS_TEST_HMAC_KEY:?set RESEARCH_CORPUS_TEST_HMAC_KEY to a 32-byte test key}"
: "${RESEARCH_CORPUS_NODE_CONTAINER:=dbsync-preprod-node}"
: "${RESEARCH_CORPUS_DBTOOL_IMAGE:=ghcr.io/intersectmbo/cardano-db-sync:13.7.2.1@sha256:1421fc5a2e80a093ccf64e4f4f704beb8ad43cb934915cd65136fbfd3d167e00}"
RESEARCH_CORPUS_TEST_TAG="$1"
shift
: "${RESEARCH_CORPUS_REHEARSAL_DIR:=}"
export PGHOST PGPORT PGDATABASE PGUSER PGPASSFILE RESEARCH_CORPUS_SEEDER_DIR RESEARCH_CORPUS_TEST_HMAC_KEY RESEARCH_CORPUS_NODE_CONTAINER RESEARCH_CORPUS_DBTOOL_IMAGE RESEARCH_CORPUS_TEST_TAG RESEARCH_CORPUS_REHEARSAL_DIR
if [ "$#" -eq 0 ]; then set -- test/integration/*.test.mjs; fi
exec node --test --test-concurrency=1 --test-timeout=14400000 "$@"
