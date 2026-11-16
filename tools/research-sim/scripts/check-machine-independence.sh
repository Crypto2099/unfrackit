#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam K. Dean
#
# One leg of the machine-independence proof. It runs the probe file's stages
# from the package this script sits in, in the leg's configuration, then
# compares each stage's records with the reference's (compare-records.mjs) and
# checks that the leg's condition happened (leg-conditions.mjs).
#
#   scripts/check-machine-independence.sh <leg> --probe <probe.json> --home <dir>
#       [--reference <L1 home | digest directory>] [--stages a,b] [--workers <n>]
#       [--digests-out <dir>] [--label <suffix>]
#
# Legs (README, "Checking that no record depends on the machine"):
#   L1       2 workers, the reference
#   L2       12 workers
#   L3       6 workers and 6 busy-loop processes, all pinned to CPUs 0-5
#   L4       12 workers, --max-jobs 1, --memory-budget 4
#   L5       two shards side by side (0/2 at 6 workers, 1/2 at 4); in a stage the
#            probe marks `kill`, shard 1/2 is killed with SIGKILL once one of its
#            wallets is done and resumed under a new label; each stage is merged
#   L6       4 workers; run it on the other machine
#   qualify  the stages named by --stages (default shapes,shapes-practice) at
#            --workers (default: this machine's CPU count), compared with the
#            reference digests <reference>/<stage>.digest.json
#
# --home is RESEARCH_SIM_HOME for the run; a stage's run ID is mi7-<leg>-<stage>.
# --reference is the home that holds L1's stages (found at
# <home>/<network>/mi7-L1-<stage>); not needed for L1. --digests-out writes
# each stage's digest (compare-records.mjs --digest-out) to <dir>/<stage>.digest.json.
# --label appends a suffix to the machine labels and run IDs (a rerun in
# the same home). The environment names the treatment: RESEARCH_SIM_TREATMENT_DIR
# (required) and RESEARCH_SIM_TREATMENT_PINS (default: the package's data/treatment-pins.txt).
#
# Output goes to the terminal and to <home>/legs/<leg>/driver.log; each stage's
# driver record is <home>/legs/<leg>/<stage>.leg.json. The last line is
# "RESULT: <leg> passed" (exit 0) or "RESULT: <leg> FAILED: ..." (exit 1). A
# leg whose condition did not happen fails with "condition not met".
set -euo pipefail

PKG=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
NODE=${NODE:-node}
CLK=$(getconf CLK_TCK)
KILL_DEADLINE_S=${KILL_DEADLINE_S:-1800}
EXIT_WAIT_S=120

die() { echo "check-machine-independence: $*" >&2; exit 2; }

leg=${1:-}; [ -n "$leg" ] || die "usage: check-machine-independence.sh <leg> --probe <probe.json> --home <dir> [--reference <dir>] [--stages a,b] [--workers n] [--digests-out <dir>] [--label <suffix>]"
shift
case "$leg" in L1|L2|L3|L4|L5|L6|qualify) ;; *) die "unknown leg $leg (L1 to L6, qualify)";; esac
probe=""; home=""; reference=""; stages=""; qworkers=""; digests_out=""; suffix=""
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || die "$1 takes a value"
  case "$1" in
    --probe) probe=$2;; --home) home=$2;; --reference) reference=$2;; --stages) stages=$2;;
    --workers) qworkers=$2;; --digests-out) digests_out=$2;; --label) suffix=$2;;
    *) die "unknown option $1";;
  esac
  shift 2
done
[ -n "$probe" ] && [ -n "$home" ] || die "--probe and --home are required"
[ -f "$probe" ] || die "no probe file $probe"
[ -n "${RESEARCH_SIM_TREATMENT_DIR:-}" ] || die "RESEARCH_SIM_TREATMENT_DIR names the treatment directory"
pins=${RESEARCH_SIM_TREATMENT_PINS:-$PKG/data/treatment-pins.txt}
[ "$leg" = L1 ] || [ "$leg" = qualify ] || [ -n "$reference" ] || die "$leg needs --reference <L1 home>"
[ "$leg" != qualify ] || [ -n "$reference" ] || die "qualify needs --reference <digest directory>"
[ -z "$qworkers" ] || [ "$leg" = qualify ] || die "--workers is for qualify; the other legs set their own"
P() { "$NODE" "$PKG/scripts/probe-file.mjs" "$@"; }
P check "$probe" > /dev/null || die "the probe file is not usable"
if [ -z "$stages" ]; then
  if [ "$leg" = qualify ]; then stages=shapes,shapes-practice; else stages=$(P stages "$probe" | paste -sd, -); fi
fi
IFS=, read -r -a STAGE_LIST <<< "$stages"
for s in "${STAGE_LIST[@]}"; do P reps "$probe" "$s" "$leg" > /dev/null || die "the probe file has no stage $s"; done

home=$(mkdir -p "$home" && cd "$home" && pwd)
export RESEARCH_SIM_HOME=$home
legdir=$home/legs/$leg$suffix
mkdir -p "$legdir"
exec > >(tee -a "$legdir/driver.log") 2>&1
echo "== $leg start $(date -u +%FT%TZ) in $PKG, home $home, stages ${STAGE_LIST[*]}"

fails=()
fail() { fails+=("$1"); echo "FAIL: $1"; }

BURNERS=()
stop_burners() {
  local p
  for p in "${BURNERS[@]:-}"; do [ -n "$p" ] && kill -KILL "$p" 2>/dev/null || true; done
  BURNERS=()
}
trap stop_burners EXIT

cpu_seconds() { # the CPU time (user + system) a process has used, in seconds
  local f
  f=$(sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null) || { echo 0; return; }
  awk -v clk="$CLK" '{printf "%.2f", ($12 + $13) / clk}' <<< "$f"
}

# replay_cmd <run id> <label> <workers> [extra flags...]: the replay command line
# of the stage under $STAGE_ARGS, one word per line.
replay_words() {
  local runid=$1 label=$2 workers=$3; shift 3
  printf '%s\n' "$NODE" "$PKG/src/cli.mjs" replay --treatment "$RESEARCH_SIM_TREATMENT_DIR" --treatment-pins "$pins" "${STAGE_ARGS[@]}" --run-id "$runid" --machine "$label" --workers "$workers" "$@"
}

# run_replay <out file> <prefix words...> -- <run id> <label> <workers> [extra...]
# runs the replay (in the foreground) with its printout in <out file>.
run_replay() {
  local out=$1; shift
  local prefix=()
  while [ "$1" != "--" ]; do prefix+=("$1"); shift; done
  shift
  local words
  mapfile -t words < <(replay_words "$@")
  "${prefix[@]}" "${words[@]}" > "$out"
}

compare_stage() { # compare_stage <stage> <dir>: the records against the reference
  local stage=$1 dir=$2 ref refdir m cmp
  if [ -n "$digests_out" ]; then
    mkdir -p "$digests_out"
    "$NODE" "$PKG/scripts/compare-records.mjs" "$dir" --digest-out "$digests_out/$stage.digest.json" > "$legdir/$stage.digest.out" || fail "$stage: the digest could not be written"
  fi
  if [ "$leg" = qualify ]; then
    [ -f "$reference/$stage.digest.json" ] || { fail "$stage: no reference digest $reference/$stage.digest.json"; return; }
    set +e; cmp=$("$NODE" "$PKG/scripts/compare-records.mjs" "$dir" --digest "$reference/$stage.digest.json"); rc=$?; set -e
  elif [ "$leg" = L1 ]; then
    return 0
  else
    refdir=$(ls -d "$reference"/*/mi7-L1-"$stage" 2>/dev/null | head -1 || true)
    [ -n "$refdir" ] || { fail "$stage: no L1 stage under $reference"; return; }
    ref=$(P reps "$probe" "$stage" L1); m=$(P reps "$probe" "$stage" "$leg")
    local filt=()
    if [ "$ref" != "$m" ]; then filt=(--max-repetition "$(( ref < m ? ref : m ))"); fi
    set +e; cmp=$("$NODE" "$PKG/scripts/compare-records.mjs" "$refdir" "$dir" "${filt[@]}"); rc=$?; set -e
  fi
  echo "$cmp" > "$legdir/$stage.compare.json"
  echo "compare $stage: $(echo "$cmp" | head -c 400)"
  [ "$rc" -eq 0 ] || fail "$stage: records are not equal to the reference (compare-records exit $rc, $legdir/$stage.compare.json)"
}

conditions_stage() { # conditions_stage <stage> <dir> [record]
  local stage=$1 dir=$2 rec=${3:-} args=() refdir rc
  if [ "$leg" != L1 ] && [ "$leg" != qualify ]; then
    refdir=$(ls -d "$reference"/*/mi7-L1-"$stage" 2>/dev/null | head -1 || true)
    [ -z "$refdir" ] || args+=(--reference "$refdir")
  fi
  [ -z "$rec" ] || args+=(--record "$rec")
  set +e; "$NODE" "$PKG/scripts/leg-conditions.mjs" "$leg" "$dir" "${args[@]}" > "$legdir/$stage.conditions.json"; rc=$?; set -e
  echo "conditions $stage: $(head -c 600 "$legdir/$stage.conditions.json")"
  [ "$rc" -eq 0 ] || fail "$stage: condition not met ($legdir/$stage.conditions.json)"
}

# done_count <stage dir>: wallets with a done segment
done_count() { ls "$1/segments" 2>/dev/null | grep -c 'done\.json$' || true; }

run_simple() { # one invocation per stage: L1, L2, L3, L4, L6, qualify
  local stage=$1 runid=$2 workers=$3; shift 3
  local out=$legdir/$stage.out rc=0 prefix=() pid t0 t1 affinity="" c0=() c1=() i
  if [ "$leg" = L3 ]; then
    prefix=(taskset -c 0-5)
    for i in "${!BURNERS[@]}"; do c0[i]=$(cpu_seconds "${BURNERS[i]}"); done
  fi
  t0=$(date +%s)
  mapfile -t words < <(replay_words "$runid" "$leg$suffix" "$workers" "$@")
  "${prefix[@]}" "$NODE" "${words[@]:1}" > "$out" &
  pid=$!
  if [ "$leg" = L3 ]; then
    # the replay's affinity, read while it runs
    for _ in $(seq 1 50); do
      affinity=$(awk '/^Cpus_allowed_list:/ {print $2}' "/proc/$pid/status" 2>/dev/null || true)
      [ -n "$affinity" ] && break; sleep 0.1
    done
  fi
  wait "$pid" || rc=$?
  t1=$(date +%s)
  if [ "$leg" = L3 ]; then
    local list="" w=$((t1 - t0))
    for i in "${!BURNERS[@]}"; do
      c1[i]=$(cpu_seconds "${BURNERS[i]}")
      list+="${list:+,}{\"pid\":${BURNERS[i]},\"cpuSeconds\":$(awk -v a="${c0[i]}" -v b="${c1[i]}" 'BEGIN{printf "%.2f", b-a}')}"
    done
    P record "$legdir/$stage.leg.json" leg=L3 stage="$stage" "affinity=\"$affinity\"" "wallSeconds=$w" "burners=[$list]"
  else
    P record "$legdir/$stage.leg.json" leg="$leg" stage="$stage" "wallSeconds=$((t1 - t0))"
  fi
  [ "$rc" -eq 0 ] || { fail "$stage: the replay exited $rc"; return 0; }
  dir=$(P get "$out" dir)
  compare_stage "$stage" "$dir"
  conditions_stage "$stage" "$dir" "$legdir/$stage.leg.json"
}

# Kills a background replay with SIGKILL once its stage has $2 done wallets;
# waits for its worker processes to exit. Sets KILLED, KIDS, EXIT_WAITED, KIDS_GONE.
kill_at() {
  local pid=$1 at=$2 dir=$3 deadline=$(( $(date +%s) + KILL_DEADLINE_S ))
  KILLED=0 KIDS=0 EXIT_WAITED=0 KIDS_GONE=true
  while [ "$(done_count "$dir")" -lt "$at" ]; do
    kill -0 "$pid" 2>/dev/null || return 0
    if [ "$(date +%s)" -gt "$deadline" ]; then echo "the replay passed ${KILL_DEADLINE_S} s without $at wallets done"; break; fi
    sleep 0.2
  done
  local kids left k
  kids=$(pgrep -P "$pid" | tr '\n' ' ' || true)
  kill -KILL "$pid" 2>/dev/null || return 0
  wait "$pid" 2>/dev/null || true
  KILLED=1
  KIDS=$(echo $kids | wc -w)
  while :; do
    left=""
    for k in $kids; do kill -0 "$k" 2>/dev/null && left="$left $k"; done
    [ -z "$left" ] && break
    if [ "$EXIT_WAITED" -ge "$EXIT_WAIT_S" ]; then KIDS_GONE=false; break; fi
    sleep 1; EXIT_WAITED=$((EXIT_WAITED + 1))
  done
}

run_l5() {
  local stage=$1 kill=$2 n=$3
  local out0=$legdir/$stage.s0.out out1=$legdir/$stage.s1.out out1b=$legdir/$stage.s1b.out
  local pid0="" pid1="" rc0=0 shards=() dir0="" dir1="" merged merge_out
  local l0="L5$suffix" l1="L5$suffix-a" l1b="L5$suffix-b"
  local rec=$legdir/$stage.leg.json
  # shard 0/2 at 6 workers, shard 1/2 at 4 workers, side by side; a shard with no wallet is not run
  mapfile -t words0 < <(replay_words "mi7-L5$suffix-$stage-s0" "$l0" 6 --shard 0/2)
  "$NODE" "${words0[@]:1}" > "$out0" & pid0=$!
  local s1=false killed=false kids=0 waited=0 gone=true note=""
  if [ "$n" -ge 2 ]; then
    s1=true
    mapfile -t words1 < <(replay_words "mi7-L5$suffix-$stage-s1" "$l1" 4 --shard 1/2)
    "$NODE" "${words1[@]:1}" > "$out1" & pid1=$!
    if [ "$kill" = 1 ]; then
      # the shard's directory appears once the replay has opened it; wait for it
      local tries=0
      while [ ! -d "$(stage_dir_of "mi7-L5$suffix-$stage-s1")" ] && [ "$tries" -lt 600 ]; do kill -0 "$pid1" 2>/dev/null || break; sleep 0.2; tries=$((tries + 1)); done
      dir1=$(stage_dir_of "mi7-L5$suffix-$stage-s1")
      if [ $(( n / 2 )) -ge 2 ]; then
        kill_at "$pid1" 1 "$dir1"
        killed=$([ "$KILLED" = 1 ] && echo true || echo false); kids=$KIDS; waited=$EXIT_WAITED; gone=$KIDS_GONE
        if [ "$killed" = true ]; then
          # resume under a new label, 4 workers, to the shard's end
          run_replay "$out1b" -- "mi7-L5$suffix-$stage-s1" "$l1b" 4 --shard 1/2 || fail "$stage: the resumed shard exited non-zero"
        else
          wait "$pid1" || fail "$stage: shard 1/2 exited non-zero"
          note="the shard ended before it could be killed"
        fi
      else
        wait "$pid1" || fail "$stage: shard 1/2 exited non-zero"
        note="not killed: the shard holds fewer than two wallets"; kill=0
      fi
    else
      wait "$pid1" || fail "$stage: shard 1/2 exited non-zero"
    fi
  fi
  [ "$s1" = false ] || dir1=$(stage_dir_of "mi7-L5$suffix-$stage-s1")
  wait "$pid0" || { rc0=$?; fail "$stage: shard 0/2 exited $rc0"; }
  dir0=$(P get "$out0" dir)
  merged=$(dirname "$dir0")/mi7-L5$suffix-$stage
  local srcs=("$dir0"); [ "$s1" = false ] || srcs+=("$dir1")
  merge_out=$legdir/$stage.merge.out
  if ! "$NODE" "$PKG/src/cli.mjs" merge-stage --into "$merged" --machine "L5$suffix-merge" "${srcs[@]}" > "$merge_out"; then fail "$stage: merge-stage failed"; return 0; fi
  # the driver's record of the stage
  local sh0 sh1
  sh0="{\"shard\":\"0/2\",\"dir\":\"$dir0\",\"label\":\"$l0\",\"kill\":false}"
  sh1=""
  if [ "$s1" = true ]; then
    local kflag=false; [ "$kill" = 1 ] && kflag=true
    sh1=",{\"shard\":\"1/2\",\"dir\":\"$dir1\",\"label\":\"$l1\",\"resumeLabel\":\"$l1b\",\"kill\":$kflag,\"killed\":$killed,\"workers\":$kids,\"workersExited\":$gone,\"workerExitSeconds\":$waited,\"note\":\"$note\"}"
  fi
  P record "$rec" leg=L5 stage="$stage" "shards=[$sh0$sh1]" "merge=$("$NODE" -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify({kept:p.kept,copied:p.copied,wallets:p.wallets,duplicates:p.duplicates}))' "$merge_out")"
  compare_stage "$stage" "$merged"
  conditions_stage "$stage" "$merged" "$rec"
}

# the directory a run ID's stage has (the replay's network directory under the home)
stage_dir_of() { ls -d "$RESEARCH_SIM_HOME"/*/"$1" 2>/dev/null | head -1 || true; }

case "$leg" in
  L1) workers=2;; L2) workers=12;; L3) workers=6;; L4) workers=12;; L6) workers=4;;
  qualify) workers=${qworkers:-$(nproc)};; L5) workers=0;;
esac

if [ "$leg" = L3 ]; then
  for _ in 1 2 3 4 5 6; do taskset -c 0-5 bash -c 'while :; do :; done' & BURNERS+=($!); done
  echo "burners: ${BURNERS[*]}"
fi

for stage in "${STAGE_LIST[@]}"; do
  echo "== stage $stage $(date -u +%FT%TZ)"
  mapfile -t STAGE_ARGS < <(P args "$probe" "$stage" "$leg")
  if [ "$leg" = L5 ]; then
    run_l5 "$stage" "$(P kill "$probe" "$stage")" "$(P wallets "$probe" "$stage")"
  else
    extra=()
    [ "$leg" != L4 ] || extra=(--max-jobs 1 --memory-budget 4)
    run_simple "$stage" "mi7-$leg$suffix-$stage" "$workers" "${extra[@]}"
  fi
done

stop_burners
echo "== $leg end $(date -u +%FT%TZ)"
if [ "${#fails[@]}" -gt 0 ]; then
  echo "RESULT: $leg FAILED: $(printf '%s; ' "${fails[@]}")"
  exit 1
fi
echo "RESULT: $leg passed"
