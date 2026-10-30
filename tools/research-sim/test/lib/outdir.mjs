// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Where the oracle's checks write their records, and the settings they run
// under. Records go to RESEARCH_SIM_ORACLE_OUT, or else to the simulator's
// private run directory, <home>/synthetic/oracle-checks-<time>/ with <home>
// as src/history/paths.mjs homeDir gives it (RESEARCH_SIM_HOME, or
// ${XDG_DATA_HOME:-$HOME/.local/share}/unfrackit-research/sim), directories
// 0700 and files 0600, never the repository.

import { mkdirSync } from 'node:fs';
import { runDir } from '../../src/history/paths.mjs';
import { MAX_BUSY_THREADS } from '../../src/replay/pool.mjs';

export function oracleOutDir() {
  if (process.env.RESEARCH_SIM_ORACLE_OUT) {
    mkdirSync(process.env.RESEARCH_SIM_ORACLE_OUT, { recursive: true, mode: 0o700 });
    return process.env.RESEARCH_SIM_ORACLE_OUT;
  }
  const d = runDir('synthetic', `oracle-checks-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export const envNumber = (name, dflt) => (process.env[name] ? Number(process.env[name]) : dflt);

// The oracle checks' worker count, RESEARCH_SIM_ORACLE_WORKERS (4 by
// default): a check run is not a study run, but it is held to the same cap
// of busy threads (replay/pool.mjs MAX_BUSY_THREADS).
export function envOracleWorkers(dflt = 4) {
  const n = envNumber('RESEARCH_SIM_ORACLE_WORKERS', dflt);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('RESEARCH_SIM_ORACLE_WORKERS: a positive whole number');
  if (n > MAX_BUSY_THREADS) throw new Error(`RESEARCH_SIM_ORACLE_WORKERS: at most ${MAX_BUSY_THREADS} threads busy (${n} asked)`);
  return n;
}

// The wall-clock limit of each oracle call in a check: under the oracle
// setting limit=wall-clock, RESEARCH_SIM_ORACLE_LIMIT_MS or 60,000; under the
// work budget there is none, and the variable is refused rather than
// ignored.
export function envOracleLimitMs(settings) {
  if (settings.limit === 'wall-clock') return envNumber('RESEARCH_SIM_ORACLE_LIMIT_MS', 60000);
  if (process.env.RESEARCH_SIM_ORACLE_LIMIT_MS) throw new Error('RESEARCH_SIM_ORACLE_LIMIT_MS applies only with RESEARCH_SIM_ORACLE_SETTINGS limit=wall-clock; under the work budget the oracle has no time limit');
  return null;
}

// Oracle setting overrides for a check run: RESEARCH_SIM_ORACLE_SETTINGS as
// key=value pairs separated by commas (afterExhaustive=report, for example),
// checked by oracleSettings; none by default.
export function envOracleOverrides() {
  const v = process.env.RESEARCH_SIM_ORACLE_SETTINGS;
  if (!v) return {};
  return Object.fromEntries(
    v.split(',').map((kv) => {
      const i = kv.indexOf('=');
      if (i < 1) throw new Error(`RESEARCH_SIM_ORACLE_SETTINGS: ${kv} is not key=value`);
      return [kv.slice(0, i), kv.slice(i + 1)];
    })
  );
}
