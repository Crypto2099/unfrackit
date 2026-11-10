#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam K. Dean
#
# The heavy probe: twelve replay jobs, one process each, on three heavy
# synthetic wallets (H20E01: 20,000 UTxOs and 100 events; H20E05: 20,000 and
# 500; H3E6: 3,000 and 6,000) under the four heaviest job kinds (csl-lf
# observed, cjs-rrri maintained-tidy, cjs-rrri tidy-once byte-optimal, evo-lf
# observed). Together they separate the memory and time a UTxO costs from
# what an event costs.
#
#   scripts/heavy-probe.sh <queue dir> [--resume]
#
# The queue dir holds queue.json (written by `node scripts/heavy-probe.mjs
# queue`). Run this script from the snapshot it belongs to; it works from its
# own location. Keep the machine otherwise idle.
#
# Output, under <queue dir>/out:
#   terminal-<UTC>.log       this script's output
#   load-<UTC>.log           every minute: load average, available memory, swap in use
#   time/<job>.txt           /usr/bin/time -v of each job
#   queue/<job>/attempt-<n>/stdout.log   the job's samples, one JSON line per
#                            intent (resident size, CSL memory, V8 heap), and
#                            its RESULT line
#   summary-<UTC>.txt        one row per job, written at the end
# The last line printed is RESULT: ... . Rerun after an interruption with
# --resume. Exit status: 0 every job done, 1 a job failed or passed its cap
# (the others still ran), 4 interrupted, 2 the queue is invalid or locked.
set -euo pipefail
Q=${1:?usage: heavy-probe.sh <queue dir> [--resume]}
Q=$(cd "$Q" && pwd)
SIM=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RESUME=0
[ "${2:-}" = "--resume" ] && RESUME=1
[ -f "$Q/queue.json" ] || { echo "no $Q/queue.json: run node scripts/heavy-probe.mjs queue first"; exit 2; }
[ -d "$SIM/node_modules" ] || { echo "the snapshot $SIM has no node_modules"; exit 1; }
[ -x /usr/bin/time ] || { echo "needs /usr/bin/time (GNU time)"; exit 1; }
if [ "$RESUME" -eq 0 ]; then
  [ ! -e "$Q/out/queue/state.json" ] || { echo "$Q/out/queue/state.json exists: move $Q/out aside first (or pass --resume)"; exit 1; }
fi
mkdir -p "$Q/out/time"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$Q/out/terminal-$STAMP.log"
LOADLOG="$Q/out/load-$STAMP.log"
SUMMARY="$Q/out/summary-$STAMP.txt"

say() { echo "$*" | tee -a "$LOG"; }

# The queue sets every variable it needs; nothing inherited from this shell
# may change the run.
for v in $(compgen -e | grep -E '^(RESEARCH_SIM_|PG)' || true); do unset "$v"; done

( trap 'kill "$s" 2>/dev/null; exit 0' TERM; trap '' INT
  while :; do echo "$(date -u +%FT%TZ) $(cut -d' ' -f1-3 /proc/loadavg) $(awk '/^MemAvailable:/{a=$2} /^SwapTotal:/{t=$2} /^SwapFree:/{f=$2} END{printf "mem-available-mb %d swap-used-mb %d", a/1024, (t-f)/1024}' /proc/meminfo)"; sleep 60 & s=$!; wait "$s"; done ) >> "$LOADLOG" 2>/dev/null &
LOADPID=$!
RUNNER_PID=""
trap 'kill "$LOADPID" 2>/dev/null || true' EXIT
# Ctrl-C or a TERM to this script stops the run: the runner is told to stop
# and records its job interrupted.
on_signal() { [ -n "$RUNNER_PID" ] && kill -TERM "$RUNNER_PID" 2>/dev/null || true; }
trap on_signal INT TERM

echo "log: $LOG" | tee "$LOG"
say "load average and memory every minute: $LOADLOG"
say "snapshot: $SIM"
say "== heavy probe: start $(date -u +%FT%TZ)"
set +e
( cd "$SIM" && exec node scripts/run-queue.mjs run "$Q/queue.json" --continue-on-failure --rerun-interrupted ) > >(trap '' INT TERM; exec tee -a "$LOG") 2>&1 &
RUNNER_PID=$!
wait "$RUNNER_PID"
rc=$?
while kill -0 "$RUNNER_PID" 2>/dev/null; do
  wait "$RUNNER_PID"
  rc=$?
done
RUNNER_PID=""
set -e
say "== heavy probe: runner exit $rc at $(date -u +%FT%TZ)"
( cd "$SIM" && node scripts/heavy-probe.mjs summary --dir "$Q" ) | tee "$SUMMARY" | tee -a "$LOG"
say "summary: $SUMMARY"
# The runner's exit codes (scripts/run-queue.mjs): 0 every job done, 1 a job
# failed or timed out, 2 the queue is invalid or locked, 4 interrupted.
case "$rc" in
  0) say "RESULT: heavy probe done, all 12 jobs finished"; exit 0 ;;
  1) say "RESULT: heavy probe finished with failed or capped jobs; see the exit and wall columns of $SUMMARY"; exit 1 ;;
  4) say "RESULT: heavy probe interrupted; rerun with --resume"; exit 4 ;;
  *) say "RESULT: heavy probe did not run (runner exit $rc: the queue is invalid or another runner holds its lock)"; exit "$rc" ;;
esac
