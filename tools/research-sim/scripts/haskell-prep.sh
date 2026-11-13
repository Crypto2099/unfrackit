#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam K. Dean
#
# Haskell prep: the slow, one-time steps the three Haskell helpers of the
# bridge (src/methods/helper.mjs) need before their adapters can be built with
# plain incremental cabal builds. For each helper project under helpers/
# (cwallet, atlas, kuber) it
#
#   1. copies the helper project (cabal.project, the .cabal file, Main.hs) to
#      <home>/<name>/project, so the run does not depend on the checkout it was
#      started from after its first seconds;
#   2. realizes the upstream project's development shell at its pinned commit
#      and writes its environment with `nix print-dev-env` to
#      <home>/<name>/env.sh, keeping the shell's store paths alive with a
#      profile at <home>/<name>/shell-profile (a garbage-collector root);
#   3. with env.sh sourced, runs `cabal update` for the helper project's
#      repositories (Hackage and CHaP);
#   4. runs `cabal build --only-dependencies` for the helper's executable, which
#      builds every package the helper links (the library under study at its
#      pinned commit, and everything below it) into the cabal store under
#      <home>/<name>/cabal/store;
#   5. checks the resolved plan (<home>/<name>/plan.json): the GHC version, the
#      pinned library's commit, and the versions the upstream pins.
#
#   tools/research-sim/scripts/haskell-prep.sh [cwallet] [atlas] [kuber]
#
# Run it from any directory; it works from its own location. With no names it
# prepares all three, in that order. <home> is RESEARCH_SIM_HASKELL_HOME, or
# ~/.local/share/unfrackit-research-sim/haskell. Everything the script writes
# is under <home> and the Nix store; it writes nothing into the repository.
#
# The development shells (step 2):
#   cwallet  cardano-foundation/cardano-balance-transaction at
#            897577325745729552495a9add56c713630c497e, devShells.default
#            (haskell.nix, GHC 9.12.3), the library's own repository at the
#            commit cardano-wallet pins.
#   atlas    geniusyield/atlas at 62e37abda859cdd7e8814e7d07f963c29e4f2833
#            (v0.14.1), devShells.default (haskell.nix, GHC 9.6.6).
#   kuber    IntersectMBO/cardano-node at
#            97036a66bcf8c89f687ae57a048eecc0389977ef (11.0.1),
#            devShells.default (haskell.nix, GHC 9.6.7). Kuber has no Nix
#            shell of its own; it builds with cabal in a Docker image with GHC
#            9.6.7 and pins cardano-node 11.0.1's package set
#            (helpers/kuber/cabal.project says where).
#
# Roughly how long and how much disk, on a 24-thread machine with 23 GB of
# memory and cache.iog.io as a substituter (estimates; the log records the
# real figures, per step):
#   shell    downloads GHC and whatever cache.iog.io holds, and builds the
#            rest. cardano-node's development shells are among its CI jobs
#            (flake.nix at 11.0.1, ciJobs.native.shells), so the kuber shell
#            should be mostly downloads: 30 to 90 minutes, 15 to 30 GB. For
#            the cwallet and atlas shells no cache this machine uses is known
#            to hold their Haskell packages, so expect Nix to compile those,
#            their Haddock documentation (both shells build a Hoogle index)
#            and haskell-language-server from source: 2 to 6 hours and 15 to
#            30 GB for cwallet, 3 to 8 hours and 20 to 40 GB for atlas (its
#            closure includes cardano-node's libraries through
#            cardano-testnet).
#   update   a few minutes and about 1 GB per project (the Hackage and CHaP
#            indexes).
#   deps     minutes when cabal can reuse the packages the shell's GHC
#            already holds (its solver prefers installed versions), up to 1 to
#            3 hours and 5 to 10 GB per project where it builds them again in
#            its own store.
#   check    seconds.
# All three together: about 6 to 16 hours and 60 to 120 GB. The script warns
# when less than 150 GB is free. Keep the machine awake and Windows Update
# paused for the length of the run (WSL stops when an update is installed).
#
# Resuming: each step that finishes writes a marker under <home>/<name>/steps/
# naming what it was done for (the shell's flake reference, the hash of the
# helper project's cabal.project and .cabal file). Rerun the same command after
# an interruption or a failure: finished steps whose inputs are unchanged are
# skipped, and a failed project does not stop the next one.
#
# Load: Nix builds at most HASKELL_PREP_NIX_JOBS derivations at once (default
# 4), each with HASKELL_PREP_NIX_CORES cores (default 6); cabal builds at most
# HASKELL_PREP_CABAL_JOBS packages at once (default 4). Lower them if the
# machine runs out of memory. The script stops before any step when Nix lacks
# flakes or cache.iog.io as a substituter (HASKELL_PREP_WITHOUT_IOG_CACHE=1
# runs it anyway, building GHC and every IOG package from source).
#
# Output: everything this script and its commands print goes to the terminal
# and to <home>/prep-<UTC>.log. Per project, under <home>/<name>/: env.sh,
# shell-profile, toolchain.txt (GHC and cabal versions), plan.json (cabal's
# resolved plan) and plan-summary.txt (the checked pins and how many packages
# came from the shell's GHC and how many cabal built). The last lines printed
# are a legend and one line per project: `<name>: ok`, or
# `<name>: FAILED at <step>`. Exit status: 0 every project ok, 1 a project
# failed (the others still ran), 2 a usage or preflight error.
#
# After the run, a helper's adapter is built with nothing but cabal, from the
# same environment:
#   cd <home>/<name>/work && set +eu && . <home>/<name>/env.sh && set -eu
#   export CABAL_DIR=<home>/<name>/cabal; unset CABAL_CONFIG
#   cabal build --builddir <any dir> exe:<name>-helper   (in helpers/<name>)
# The dependencies come from the store, so only the helper itself compiles.
set -euo pipefail

# Every name this script uses after it sources a shell's env.sh starts with
# HP_ or hp_, because env.sh assigns the shell derivation's own variables
# (name, src, out, system and many more) and defines its functions.
HP_TOOL=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HP_HOME=${RESEARCH_SIM_HASKELL_HOME:-$HOME/.local/share/unfrackit-research-sim/haskell}
HP_NIX_JOBS=${HASKELL_PREP_NIX_JOBS:-4}
HP_NIX_CORES=${HASKELL_PREP_NIX_CORES:-6}
HP_CABAL_JOBS=${HASKELL_PREP_CABAL_JOBS:-4}
HP_SYSTEM=x86_64-linux
HP_PROJECTS=(cwallet atlas kuber)
HP_MIN_FREE_GB=150

# The development shell of each project (a flake reference at a full commit).
hp_shell_ref() {
  case $1 in
    cwallet) echo "github:cardano-foundation/cardano-balance-transaction/897577325745729552495a9add56c713630c497e#devShells.$HP_SYSTEM.default" ;;
    atlas) echo "github:geniusyield/atlas/62e37abda859cdd7e8814e7d07f963c29e4f2833#devShells.$HP_SYSTEM.default" ;;
    kuber) echo "github:IntersectMBO/cardano-node/97036a66bcf8c89f687ae57a048eecc0389977ef#devShells.$HP_SYSTEM.default" ;;
  esac
}

# The GHC version each shell must provide.
hp_ghc_expected() {
  case $1 in
    cwallet) echo 9.12.3 ;;
    atlas) echo 9.6.6 ;;
    kuber) echo 9.6.7 ;;
  esac
}

# The library under study as the plan must show it: <package> <commit>.
hp_plan_tags() {
  case $1 in
    cwallet)
      echo "cardano-balance-tx 897577325745729552495a9add56c713630c497e"
      echo "cardano-coin-selection 176611048d5b9f33df19d106cd925d63a7858bb2"
      ;;
    atlas) echo "atlas-cardano 62e37abda859cdd7e8814e7d07f963c29e4f2833" ;;
    kuber) echo "kuber 2c559089e394ea7bc8a9bbde968bcdfb2ef7fac5" ;;
  esac
}

# Versions the upstream pins, as the plan must show them:
# <package> <version as a regular expression>.
hp_plan_versions() {
  case $1 in
    cwallet)
      echo 'cardano-balance-tx ^0\.1\.0$'
      echo 'cardano-ledger-api ^1\.14\.0\.0$'
      echo 'cardano-ledger-conway ^1\.23\.0\.0$'
      echo 'cardano-ledger-core ^1\.21\.0\.0$'
      echo 'ouroboros-consensus ^4\.2\.1\.0$'
      echo 'plutus-core ^1\.70\.0\.0$'
      ;;
    atlas)
      echo 'atlas-cardano ^0\.14\.1$'
      echo 'cardano-api ^10\.13\.'
      ;;
    kuber)
      echo 'kuber ^4\.2\.0$'
      echo 'cardano-api ^11\.0\.0\.0$'
      echo 'cardano-ledger-binary ^1\.8\.1\.0$'
      echo 'cardano-ledger-core ^1\.20\.0\.0$'
      echo 'ouroboros-consensus ^3\.0\.1\.0$'
      ;;
  esac
}

hp_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
hp_say() { printf '[%s] %s\n' "$(hp_now)" "$*"; }
hp_die() {
  printf '[%s] haskell-prep: %s\n' "$(hp_now)" "$*" >&2
  exit 2
}

hp_usage() {
  echo "usage: tools/research-sim/scripts/haskell-prep.sh [cwallet] [atlas] [kuber]"
}

# The value of a Nix setting, or nothing.
hp_nix_setting() {
  nix config show "$1" 2>/dev/null || nix show-config 2>/dev/null | sed -n "s/^$1 = //p"
}

hp_preflight() {
  local hp_cmd hp_features hp_subst hp_free hp_d hp_dirty
  for hp_cmd in nix git jq sha256sum df du flock tee; do
    command -v "$hp_cmd" >/dev/null || hp_die "$hp_cmd is not on the PATH"
  done
  hp_say "nix: $(nix --version)"
  hp_features=$(hp_nix_setting experimental-features)
  case " $hp_features " in
    *" flakes "*) ;;
    *) hp_die "Nix's experimental features ($hp_features) do not include flakes" ;;
  esac
  case " $hp_features " in
    *" nix-command "*) ;;
    *) hp_die "Nix's experimental features ($hp_features) do not include nix-command" ;;
  esac
  hp_subst=$(hp_nix_setting substituters)
  hp_say "substituters: $hp_subst"
  case " $hp_subst " in
    *"https://cache.iog.io"*) ;;
    *)
      if [ "${HASKELL_PREP_WITHOUT_IOG_CACHE:-}" = 1 ]; then
        hp_say "WARNING: cache.iog.io is not a substituter; GHC and every IOG package will be built from source"
      else
        hp_die "cache.iog.io is not among Nix's substituters, so GHC and every IOG package would be built from source; add it (key hydra.iohk.io:f/Ea+s+dFdN+3Y/G+FDgSq+a5NEWhJGzdjvKNGv0/EQ=) or set HASKELL_PREP_WITHOUT_IOG_CACHE=1"
      fi
      ;;
  esac
  for hp_d in "$HP_HOME" /nix/store; do
    hp_free=$(df -BG --output=avail "$hp_d" | tail -n 1 | tr -dc 0-9)
    hp_say "free space on the file system of $hp_d: ${hp_free} GB"
    if [ "$hp_free" -lt "$HP_MIN_FREE_GB" ]; then
      hp_say "WARNING: less than $HP_MIN_FREE_GB GB free under $hp_d; the run may need 60 to 120 GB"
    fi
  done
  hp_say "repository: $(git -C "$HP_TOOL" rev-parse HEAD 2>/dev/null || echo 'not a git checkout')"
  hp_dirty=$(git -C "$HP_TOOL" status --porcelain -- helpers/cwallet helpers/atlas helpers/kuber 2>/dev/null || true)
  if [ -n "$hp_dirty" ]; then
    hp_say "WARNING: the helper projects differ from the commit; the run copies them as they are:"
    printf '%s\n' "$hp_dirty"
  fi
}

# Step bookkeeping for the project in hand (HP_NAME, HP_DIR).
hp_begin() {
  HP_STEP=$1
  echo "running $HP_STEP" > "$HP_DIR/status"
  HP_STEP_START=$(date +%s)
  hp_say "$HP_NAME: $HP_STEP: start"
}
hp_finish() {
  hp_say "$HP_NAME: $HP_STEP: done in $(( ($(date +%s) - HP_STEP_START) / 60 )) min"
}
hp_skip() { hp_say "$HP_NAME: $1: already done for these inputs, skipped"; }
hp_marker_ok() { [ -f "$HP_DIR/steps/$1.done" ] && [ "$(cat "$HP_DIR/steps/$1.done")" = "$2" ]; }
hp_mark() { printf '%s\n' "$2" > "$HP_DIR/steps/$1.done"; }
hp_fail() {
  echo "$*"
  false
}

# One project. Run in a subshell with errexit on; it leaves `ok`, or
# `failed <step>` (or `running <step>` when it stopped without the trap), in
# <home>/<name>/status.
hp_prep_project() {
  HP_NAME=$1
  HP_DIR="${HP_HOME:?}/${HP_NAME:?}"
  HP_REF=$(hp_shell_ref "$HP_NAME")
  HP_GHC=$(hp_ghc_expected "$HP_NAME")
  HP_STEP=copy
  mkdir -p "$HP_DIR/steps" "$HP_DIR/work"
  trap 'echo "failed $HP_STEP" > "$HP_DIR/status"' ERR

  # 1. Copy the helper project.
  hp_begin copy
  HP_SRC="$HP_TOOL/helpers/$HP_NAME"
  [ -f "$HP_SRC/cabal.project" ] || hp_fail "there is no helper project at $HP_SRC"
  rm -rf "${HP_DIR:?}/project.new"
  mkdir -p "$HP_DIR/project.new"
  cp -a "$HP_SRC/." "$HP_DIR/project.new/"
  rm -rf "${HP_DIR:?}/project"
  mv "$HP_DIR/project.new" "$HP_DIR/project"
  HP_PROJECT_HASH=$(cd "$HP_DIR/project" && sha256sum cabal.project ./*.cabal | sha256sum | cut -d ' ' -f 1)
  hp_say "$HP_NAME: helper project copied from $HP_SRC (cabal.project and .cabal sha256 $HP_PROJECT_HASH)"
  hp_finish

  # 2. The development shell. The profile is a garbage-collector root, so a
  # Nix garbage collection keeps the shell (and the libraries the helper links
  # at run time) until the profile is deleted.
  if hp_marker_ok shell "$HP_REF" && [ -s "$HP_DIR/env.sh" ] && [ -e "$HP_DIR/shell-profile" ]; then
    hp_skip shell
  else
    hp_begin shell
    hp_say "$HP_NAME: realizing $HP_REF"
    (cd "$HP_DIR/work" && nix print-dev-env --option max-jobs "$HP_NIX_JOBS" --option cores "$HP_NIX_CORES" --profile "$HP_DIR/shell-profile" "$HP_REF" > "$HP_DIR/env.sh.new")
    mv "$HP_DIR/env.sh.new" "$HP_DIR/env.sh"
    hp_say "$HP_NAME: shell closure: $(nix path-info --closure-size --human-readable "$HP_DIR/shell-profile" 2>/dev/null | tr -s ' ' || echo 'size unknown')"
    hp_mark shell "$HP_REF"
    hp_finish
  fi

  # Enter the shell's environment. Its shell hook runs in the scratch
  # directory <home>/<name>/work, so anything it writes lands there.
  hp_begin enter
  cd "$HP_DIR/work"
  set +eu
  # shellcheck disable=SC1091
  . "$HP_DIR/env.sh"
  set -euo pipefail
  IFS=$' \t\n'
  trap 'echo "failed $HP_STEP" > "$HP_DIR/status"' ERR
  if [ -n "${CABAL_CONFIG:-}" ]; then
    hp_say "$HP_NAME: the shell sets CABAL_CONFIG=$CABAL_CONFIG; unset, so cabal uses the prep's own directory"
    unset CABAL_CONFIG
  fi
  export CABAL_DIR="$HP_DIR/cabal"
  export LANG=C.UTF-8 LC_ALL=C.UTF-8
  if [ -z "${SSL_CERT_FILE:-}" ] && [ -f /etc/ssl/certs/ca-certificates.crt ]; then
    export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
  fi
  HP_HAVE_GHC=$(ghc --numeric-version)
  HP_HAVE_CABAL=$(cabal --numeric-version)
  printf 'ghc %s (%s)\ncabal %s (%s)\nshell %s\n' "$HP_HAVE_GHC" "$(command -v ghc)" "$HP_HAVE_CABAL" "$(command -v cabal)" "$HP_REF" > "$HP_DIR/toolchain.txt"
  hp_say "$HP_NAME: ghc $HP_HAVE_GHC, cabal $HP_HAVE_CABAL"
  [ "$HP_HAVE_GHC" = "$HP_GHC" ] || hp_fail "the shell provides GHC $HP_HAVE_GHC, not $HP_GHC"
  hp_finish

  # 3. cabal update, for the repositories the helper project names.
  if hp_marker_ok update "$HP_PROJECT_HASH $HP_REF"; then
    hp_skip update
  else
    hp_begin update
    (cd "$HP_DIR/project" && cabal update)
    hp_mark update "$HP_PROJECT_HASH $HP_REF"
    hp_finish
  fi

  # 4. The helper's dependencies, into the store under CABAL_DIR.
  if hp_marker_ok deps "$HP_PROJECT_HASH $HP_REF" && [ -s "$HP_DIR/plan.json" ]; then
    hp_skip deps
  else
    hp_begin deps
    (cd "$HP_DIR/project" && cabal build --builddir="$HP_DIR/dist-newstyle" --jobs="$HP_CABAL_JOBS" --only-dependencies "exe:$HP_NAME-helper")
    cp "$HP_DIR/dist-newstyle/cache/plan.json" "$HP_DIR/plan.json"
    hp_mark deps "$HP_PROJECT_HASH $HP_REF"
    hp_finish
  fi

  # 5. The resolved plan.
  hp_begin check
  HP_BAD=0
  {
    echo "plan: $HP_DIR/plan.json"
    echo "ghc: $HP_HAVE_GHC"
    while read -r HP_PKG HP_WANT; do
      HP_GOT=$(jq -r --arg p "$HP_PKG" '[."install-plan"[] | select(."pkg-name" == $p) | ."pkg-src"."source-repo".tag // empty] | unique | join(",")' "$HP_DIR/plan.json")
      if [ "$HP_GOT" = "$HP_WANT" ]; then
        echo "ok   $HP_PKG at commit $HP_GOT"
      else
        echo "BAD  $HP_PKG at commit '$HP_GOT', want $HP_WANT"
        HP_BAD=1
      fi
    done < <(hp_plan_tags "$HP_NAME")
    while read -r HP_PKG HP_WANT; do
      HP_GOT=$(jq -r --arg p "$HP_PKG" '[."install-plan"[] | select(."pkg-name" == $p) | ."pkg-version"] | unique | join(",")' "$HP_DIR/plan.json")
      if [ -n "$HP_GOT" ] && [[ $HP_GOT =~ $HP_WANT ]]; then
        echo "ok   $HP_PKG $HP_GOT"
      else
        echo "BAD  $HP_PKG '$HP_GOT', want $HP_WANT"
        HP_BAD=1
      fi
    done < <(hp_plan_versions "$HP_NAME")
    echo "source-repository packages:"
    jq -r '[."install-plan"[] | select(."pkg-src".type? == "source-repo") | "  \(."pkg-name") \(."pkg-version") \(."pkg-src"."source-repo".location) \(."pkg-src"."source-repo".tag)"] | unique | .[]' "$HP_DIR/plan.json"
    echo "packages from the shell's GHC: $(jq '[."install-plan"[] | select(.type == "pre-existing")] | length' "$HP_DIR/plan.json")"
    echo "package components cabal built in its store: $(jq '[."install-plan"[] | select(.type == "configured" and .style == "global")] | length' "$HP_DIR/plan.json")"
    echo "cabal store: $(du -sh "$CABAL_DIR/store" 2>/dev/null | cut -f 1)"
  } > "$HP_DIR/plan-summary.txt"
  cat "$HP_DIR/plan-summary.txt"
  [ "$HP_BAD" = 0 ] || hp_fail "the plan does not show every pin"
  hp_finish

  echo ok > "$HP_DIR/status"
}

hp_legend() {
  cat <<'EOF'

Legend
  ok                  every step finished and the plan shows every pin.
  FAILED at shell     nix could not realize the development shell. The output
                      above names the derivation; `nix log <drv>` prints its
                      build log. "HTTP error 403" or "rate limit" from
                      api.github.com: add a GitHub token to Nix's
                      access-tokens. Killed or out of memory: lower
                      HASKELL_PREP_NIX_JOBS or HASKELL_PREP_NIX_CORES.
  FAILED at enter     env.sh did not give the GHC the project needs, or ghc or
                      cabal is missing from it; the line above says which.
  FAILED at update    cabal could not fetch the Hackage or CHaP index (network).
  FAILED at deps      "Could not resolve dependencies": the pins do not solve
                      with this GHC and cabal. A package that fails to compile
                      is named above with its error. Out of memory: lower
                      HASKELL_PREP_CABAL_JOBS.
  FAILED at check     the build finished but the plan lacks a pin; the BAD
                      lines above and plan-summary.txt say which.
  FAILED at copy      the helper project is missing from the checkout.
Rerun the same command after a failure: steps already done are skipped.
Bring back the log path and the exit status.
EOF
}

hp_main() {
  local hp_names=() hp_n hp_rc=0 hp_status
  for hp_n in "$@"; do
    case $hp_n in
      -h | --help)
        hp_usage
        return 0
        ;;
      cwallet | atlas | kuber) hp_names+=("$hp_n") ;;
      *)
        hp_usage >&2
        return 2
        ;;
    esac
  done
  [ ${#hp_names[@]} -gt 0 ] || hp_names=("${HP_PROJECTS[@]}")

  exec 9> "$HP_HOME/.lock"
  flock -n 9 || hp_die "another haskell-prep run holds $HP_HOME/.lock"

  hp_say "haskell-prep: projects ${hp_names[*]}; home $HP_HOME; log $HP_LOG"
  hp_preflight

  for hp_n in "${hp_names[@]}"; do
    hp_say "==== $hp_n ===="
    mkdir -p "$HP_HOME/$hp_n"
    echo "running copy" > "$HP_HOME/$hp_n/status"
    set +e
    (
      set -euo pipefail
      hp_prep_project "$hp_n"
    )
    set -e
    hp_status=$(cat "$HP_HOME/$hp_n/status" 2>/dev/null || echo 'failed copy')
    case $hp_status in
      ok) ;;
      "running "*)
        echo "failed ${hp_status#running }" > "$HP_HOME/$hp_n/status"
        hp_rc=1
        ;;
      *) hp_rc=1 ;;
    esac
  done

  hp_legend
  echo
  for hp_n in "${hp_names[@]}"; do
    hp_status=$(cat "$HP_HOME/$hp_n/status" 2>/dev/null || echo 'failed copy')
    if [ "$hp_status" = ok ]; then
      echo "$hp_n: ok"
    else
      echo "$hp_n: FAILED at ${hp_status#failed }"
    fi
  done
  echo "log: $HP_LOG"
  return "$hp_rc"
}

mkdir -p "$HP_HOME"
HP_LOG="$HP_HOME/prep-$(date -u +%Y%m%dT%H%M%SZ).log"
set +e
hp_main "$@" 2>&1 | tee -a "$HP_LOG"
hp_rc=${PIPESTATUS[0]}
exit "$hp_rc"
